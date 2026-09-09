import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  GitHubError,
  getBlobText,
  getBranchProtection,
  getTree,
  type TreeEntry,
} from "@/lib/github";
import { droppedFilePresentFinding, runRules, type Finding } from "@/lib/rules";
import {
  IGNORE_FILE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SCAN,
  buildIgnoreMatcher,
  isKnownDroppedFile,
  selectionReason,
} from "@/lib/scan-policy";
import type { ScanResult } from "@/lib/scan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby caps serverless functions at 60s; the 200-file cap and the
// concurrency pool below are sized to fit comfortably inside that.
export const maxDuration = 60;

const BLOB_CONCURRENCY = 8;
const SEVERITY_ORDER = { ERROR: 0, WARNING: 1 } as const;

interface ScanRequest {
  owner?: string;
  repo?: string;
  branch?: string;
}

/** Run `worker` over `items` with a fixed number of in-flight requests. */
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

export async function POST(request: Request) {
  const started = Date.now();

  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const token = session.accessToken;

  let body: ScanRequest;
  try {
    body = (await request.json()) as ScanRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const repo = body.repo?.trim();
  const branch = body.branch?.trim();
  if (!owner || !repo || !branch) {
    return NextResponse.json(
      { error: "owner, repo and branch are all required." },
      { status: 400 },
    );
  }

  try {
    // Protection status is independent of the file scan — start it early.
    const protectionPromise = getBranchProtection(token, owner, repo, branch);

    const tree = await getTree(token, owner, repo, branch);
    const blobs = tree.tree.filter((e): e is TreeEntry => e.type === "blob");

    // Load the repo's own suppression list, if it has one, before selecting.
    const ignoreEntry = blobs.find((e) => e.path === IGNORE_FILE);
    const ignore = buildIgnoreMatcher(
      ignoreEntry
        ? await getBlobText(token, owner, repo, ignoreEntry.sha).catch(() => null)
        : null,
    );

    let skippedTooLarge = 0;
    let ignoredByFile = 0;
    const eligible = blobs.filter((entry) => {
      if (selectionReason(entry.path) === null) return false;
      if (ignore.matches(entry.path)) {
        ignoredByFile++;
        return false;
      }
      if ((entry.size ?? 0) > MAX_FILE_BYTES) {
        skippedTooLarge++;
        return false;
      }
      return true;
    });

    const selected = eligible.slice(0, MAX_FILES_PER_SCAN);

    // Dropper artifacts are evidence by existence, so this runs over the whole
    // tree — independent of the extension filter, the size limit and the
    // 200-file cap, none of which should be able to hide one.
    const findings: Finding[] = blobs
      .filter((e) => isKnownDroppedFile(e.path) && !ignore.matches(e.path))
      .map((e) => droppedFilePresentFinding(e.path));
    const droppersPresent = findings.length;

    let scanned = 0;
    let skippedBinary = 0;
    let fetchErrors = 0;
    let ignoredByMarker = 0;
    let suppressedFindings = 0;

    await pool(selected, BLOB_CONCURRENCY, async (entry) => {
      try {
        const content = await getBlobText(token, owner, repo, entry.sha);
        if (content === null) {
          skippedBinary++;
          return;
        }
        scanned++;
        const run = runRules(entry.path, content);
        if (run.fileIgnored) ignoredByMarker++;
        suppressedFindings += run.suppressed;
        findings.push(...run.findings);
      } catch {
        fetchErrors++;
      }
    });

    findings.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    );

    const result: ScanResult = {
      fullName: `${owner}/${repo}`,
      branch,
      scannedAt: new Date().toISOString(),
      stats: {
        treeEntries: blobs.length,
        eligible: eligible.length,
        scanned,
        skippedOverCap: Math.max(0, eligible.length - selected.length),
        skippedTooLarge,
        skippedBinary,
        fetchErrors,
        ignorePatterns: ignore.patternCount,
        ignoredByFile,
        ignoredByMarker,
        suppressedFindings,
        droppersPresent,
        treeTruncated: tree.truncated,
        durationMs: Date.now() - started,
      },
      findings,
      protection: await protectionPromise,
    };

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GitHubError) {
      const hint =
        err.status === 409
          ? "Repository is empty — nothing to scan."
          : err.status === 404
            ? "Repo or default branch not found, or the token lacks access to it."
            : undefined;
      return NextResponse.json(
        { error: hint ? `${hint} (${err.message})` : err.message },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error during scan.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
