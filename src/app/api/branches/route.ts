import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  GitHubError,
  compareBranches,
  getBlobText,
  ghDelete,
  listBranches,
  type CompareFile,
} from "@/lib/github";
import { runRules } from "@/lib/rules";
import {
  MAX_FILE_BYTES,
  isConfigFile,
  isKnownDroppedFile,
  selectionReason,
} from "@/lib/scan-policy";
import type { BranchReport, BranchSweepResult } from "@/lib/scan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BRANCHES = 60;
const MAX_FILES_PER_BRANCH = 20;
const BRANCH_CONCURRENCY = 4;
const TIME_BUDGET_MS = 45_000;

interface SweepRequest {
  owner?: string;
  repo?: string;
  defaultBranch?: string;
}

interface DeleteRequest extends SweepRequest {
  branch?: string;
}

async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Config files and dropper artifacts first — that is where this payload lives. */
function priority(file: CompareFile): number {
  if (isKnownDroppedFile(file.filename)) return 0;
  if (isConfigFile(file.filename)) return 1;
  return 2;
}

export async function POST(request: Request) {
  const started = Date.now();

  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const token = session.accessToken;

  let body: SweepRequest;
  try {
    body = (await request.json()) as SweepRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const repo = body.repo?.trim();
  const defaultBranch = body.defaultBranch?.trim();
  if (!owner || !repo || !defaultBranch) {
    return NextResponse.json(
      { error: "owner, repo and defaultBranch are all required." },
      { status: 400 },
    );
  }

  try {
    const all = await listBranches(token, owner, repo);
    const branches = all.slice(0, MAX_BRANCHES);
    const reports: BranchReport[] = [];

    await pool(branches, BRANCH_CONCURRENCY, async (branch) => {
      const base: BranchReport = {
        name: branch.name,
        isDefault: branch.name === defaultBranch,
        protectedBranch: branch.protected,
        status: "clean",
        files: [],
        droppers: [],
        errors: 0,
        warnings: 0,
        changedFiles: 0,
        scannedFiles: 0,
        aheadBy: null,
      };

      // The default branch has nothing to compare against — the ordinary Scan
      // button covers it, and reporting it "clean" here would be misleading.
      if (base.isDefault) {
        reports.push({
          ...base,
          status: "default",
          reason: "Default branch — use Scan for a full sweep of it.",
        });
        return;
      }

      if (Date.now() - started > TIME_BUDGET_MS) {
        reports.push({ ...base, status: "skipped", reason: "Time budget reached." });
        return;
      }

      try {
        const cmp = await compareBranches(token, owner, repo, defaultBranch, branch.name);
        base.aheadBy = cmp.ahead_by;

        // Only what merging this branch would actually bring in.
        const candidates = (cmp.files ?? [])
          .filter((f) => f.status !== "removed" && selectionReason(f.filename) !== null)
          .sort((a, b) => priority(a) - priority(b) || a.filename.localeCompare(b.filename));

        base.changedFiles = candidates.length;
        base.droppers = candidates
          .filter((f) => isKnownDroppedFile(f.filename))
          .map((f) => f.filename);

        const fetchable = candidates
          .filter((f) => !isKnownDroppedFile(f.filename))
          .slice(0, MAX_FILES_PER_BRANCH);

        const hit = new Set<string>(base.droppers);
        let errors = base.droppers.length; // a dropper present is itself an ERROR
        let warnings = 0;
        let scanned = 0;

        for (const file of fetchable) {
          if (Date.now() - started > TIME_BUDGET_MS) break;
          try {
            const content = await getBlobText(token, owner, repo, file.sha);
            if (content === null) continue;
            scanned++;
            const run = runRules(file.filename, content);
            for (const f of run.findings) {
              hit.add(f.path);
              if (f.severity === "ERROR") errors++;
              else warnings++;
            }
          } catch {
            /* one unreadable blob should not fail the whole branch */
          }
        }

        base.scannedFiles = scanned;
        base.files = [...hit].sort();
        base.errors = errors;
        base.warnings = warnings;
        base.status = hit.size > 0 ? "infected" : "clean";
        if (base.status === "clean" && candidates.length > fetchable.length) {
          base.reason = `Only the first ${MAX_FILES_PER_BRANCH} changed files were scanned.`;
        }
        reports.push(base);
      } catch (err) {
        reports.push({
          ...base,
          status: "error",
          reason:
            err instanceof GitHubError && err.status === 404
              ? "No common history with the default branch."
              : err instanceof Error
                ? err.message
                : "Compare failed.",
        });
      }
    });

    const rank = { infected: 0, error: 1, skipped: 2, clean: 3, default: 4 } as const;
    reports.sort(
      (a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name),
    );

    const result: BranchSweepResult = {
      fullName: `${owner}/${repo}`,
      defaultBranch,
      branches: reports,
      stats: {
        total: all.length,
        swept: reports.filter((r) => r.status !== "skipped" && r.status !== "default")
          .length,
        infected: reports.filter((r) => r.status === "infected").length,
        durationMs: Date.now() - started,
        truncated:
          all.length > branches.length || reports.some((r) => r.status === "skipped"),
      },
    };

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GitHubError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Branch sweep failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const token = session.accessToken;

  let body: DeleteRequest;
  try {
    body = (await request.json()) as DeleteRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const repo = body.repo?.trim();
  const branch = body.branch?.trim();
  const defaultBranch = body.defaultBranch?.trim();

  if (!owner || !repo || !branch || !defaultBranch) {
    return NextResponse.json(
      { error: "owner, repo, branch and defaultBranch are all required." },
      { status: 400 },
    );
  }

  // Deleting the default branch would break the repository. Refuse here as well
  // as in the UI — a client should never be the only thing standing in the way.
  if (branch === defaultBranch) {
    return NextResponse.json(
      { error: `Refusing to delete the default branch (${defaultBranch}).` },
      { status: 400 },
    );
  }

  try {
    // Re-check protection server-side rather than trusting the sweep result the
    // browser is holding, which may be stale.
    const branches = await listBranches(token, owner, repo);
    const target = branches.find((b) => b.name === branch);
    if (!target) {
      return NextResponse.json(
        { error: `Branch "${branch}" no longer exists.` },
        { status: 404 },
      );
    }
    if (target.protected) {
      return NextResponse.json(
        { error: `"${branch}" is protected — unprotect it on GitHub first.` },
        { status: 400 },
      );
    }

    await ghDelete(
      token,
      `/repos/${owner}/${repo}/git/refs/heads/${branch
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );

    return NextResponse.json({ deleted: branch });
  } catch (err) {
    if (err instanceof GitHubError) {
      const hint =
        err.status === 403
          ? "The token lacks write access, or a ruleset blocks branch deletion."
          : undefined;
      return NextResponse.json(
        { error: hint ? `${hint} ${err.message}` : err.message },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Branch deletion failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
