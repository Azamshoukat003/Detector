import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  GitHubError,
  gh,
  getBlobBytes,
  getTree,
  ghPatch,
  ghPost,
  type TreeEntry,
} from "@/lib/github";
import { verifyAsset, assetExtension } from "@/lib/magic";
import {
  MAX_DIR_FILES,
  cleanupBranchName,
  composePullRequestBody,
  normaliseDir,
  planDeletion,
  pullRequestBody,
  stripFindingLines,
  type DirPlan,
  type StripResult,
} from "@/lib/remediate";
import { isKnownDroppedFile } from "@/lib/scan-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cap files per run so one click cannot rewrite half a repository. */
const MAX_FILES_PER_RUN = 25;
/** Cap separate PRs per run — one PR per file gets noisy fast. */
const MAX_PRS_PER_RUN = 10;

/** "pr" opens a pull request; "direct" commits straight to the base branch. */
type Mode = "pr" | "direct";

interface RemediateRequest {
  owner?: string;
  repo?: string;
  branch?: string;
  paths?: string[];
  /** Whole directories to remove, each justified server-side. */
  dirs?: string[];
  mode?: Mode;
  /** PR mode only: one PR per file instead of one PR for everything. */
  perFile?: boolean;
}

interface RefResponse {
  object: { sha: string };
}
interface CommitResponse {
  sha: string;
  tree: { sha: string };
}
interface BlobCreated {
  sha: string;
}
interface TreeCreated {
  sha: string;
}
interface PullCreated {
  html_url: string;
  number: number;
}
interface ContentsResponse {
  sha: string;
  encoding: string;
  content: string;
}

/** One entry in a git tree edit. A null sha removes the path. */
interface TreeEdit {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
}

interface CommitOutcome {
  mode: Mode;
  commitSha: string;
  branch: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  files: string[];
}

function headlineFor(applied: StripResult[]): string {
  const deletions = applied.filter((r) => r.action === "delete").length;
  const edits = applied.length - deletions;
  return [
    deletions > 0 ? `delete ${deletions} dropper file(s)` : null,
    edits > 0 ? `strip flagged lines from ${edits} file(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Title text covering file edits, file deletions and whole-folder removals. */
function headline(applied: StripResult[], dirPlans: DirPlan[]): string {
  const folders = dirPlans.filter((p) => p.ok);
  const parts = [headlineFor(applied)].filter((x) => x.length > 0);
  if (folders.length > 0) {
    const n = folders.reduce((sum, p) => sum + p.files.length, 0);
    parts.push(
      `remove ${folders.length} folder(s) (${n} file${n === 1 ? "" : "s"})`,
    );
  }
  return parts.join(", ");
}

function summaryFor(applied: StripResult[]): string {
  return applied
    .map((r) =>
      r.action === "delete"
        ? `${r.path} (deleted)`
        : `${r.path} (${r.removedLines.length} removed, ${r.truncatedLines.length} truncated)`,
    )
    .join(", ");
}

/** Blobs -> tree -> commit. Shared by both modes. */
async function buildCommit(
  token: string,
  owner: string,
  repo: string,
  baseSha: string,
  baseTreeSha: string,
  applied: StripResult[],
  extraDeletions: string[] = [],
): Promise<string> {
  const treeEntries: TreeEdit[] = extraDeletions.map((path) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: null,
  }));
  for (const file of applied) {
    if (file.action === "delete") {
      // A null sha in a tree edit removes the path.
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await ghPost<BlobCreated>(token, `/repos/${owner}/${repo}/git/blobs`, {
      content: Buffer.from(file.content as string, "utf8").toString("base64"),
      encoding: "base64",
    });
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await ghPost<TreeCreated>(token, `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  const commit = await ghPost<CommitResponse>(
    token,
    `/repos/${owner}/${repo}/git/commits`,
    {
      message: `repo-guard: ${headlineFor(applied)}\n\n${summaryFor(applied)}`,
      tree: tree.sha,
      parents: [baseSha],
    },
  );
  return commit.sha;
}

/** Assets to header-check per directory while looking for a justification. */
const MAX_DIR_ASSET_PROBES = 12;

/**
 * Decide whether a directory may be deleted, using the repo's own tree rather
 * than anything the browser supplied. A directory qualifies only if it actually
 * contains a flagged file: a known dropper artifact by name, or an asset whose
 * bytes do not match its extension. No justification, no deletion.
 */
async function planDirectory(
  token: string,
  owner: string,
  repo: string,
  blobs: TreeEntry[],
  rawDir: string,
): Promise<DirPlan> {
  const dir = normaliseDir(rawDir);
  if (dir === null) {
    return {
      dir: rawDir,
      ok: false,
      files: [],
      reason: "Refusing to delete the repository root.",
    };
  }

  const prefix = dir + "/";
  const files = blobs.filter((b) => b.path.startsWith(prefix)).map((b) => b.path);

  if (files.length === 0) {
    return { dir, ok: false, files: [], reason: "No files found under this folder." };
  }
  if (files.length > MAX_DIR_FILES) {
    return {
      dir,
      ok: false,
      files,
      reason: `${files.length} files — over the ${MAX_DIR_FILES}-file folder limit. Delete it by hand if you are sure.`,
    };
  }

  // Justification 1: a known dropper artifact sits in here.
  const dropper = files.find((f) => isKnownDroppedFile(f));
  if (dropper) {
    return {
      dir,
      ok: true,
      files,
      justification: `Contains the known dropper artifact \`${dropper}\`.`,
    };
  }

  // Justification 2: an asset in here is not what its extension claims.
  const assets = blobs
    .filter((b) => b.path.startsWith(prefix) && assetExtension(b.path) !== null)
    .slice(0, MAX_DIR_ASSET_PROBES);
  for (const asset of assets) {
    try {
      const bytes = await getBlobBytes(token, owner, repo, asset.sha);
      const verdict = verifyAsset(asset.path, bytes);
      if (verdict && !verdict.ok) {
        return {
          dir,
          ok: true,
          files,
          justification: `\`${asset.path}\` claims to be a ${verdict.label} but the bytes are ${verdict.actual}.`,
        };
      }
    } catch {
      /* an unreadable asset is not a justification */
    }
  }

  return {
    dir,
    ok: false,
    files,
    reason:
      "Nothing in this folder is flagged — no dropper artifact, and every asset matches its extension. Folder deletion needs a confirmed finding inside it.",
  };
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const token = session.accessToken;

  let body: RemediateRequest;
  try {
    body = (await request.json()) as RemediateRequest;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const repo = body.repo?.trim();
  const branch = body.branch?.trim();
  const mode: Mode = body.mode === "direct" ? "direct" : "pr";
  const perFile = mode === "pr" && body.perFile === true;
  const paths = [...new Set(body.paths ?? [])].filter((p) => p.trim().length > 0);
  const dirs = [...new Set(body.dirs ?? [])].filter((d) => d.trim().length > 0);

  if (!owner || !repo || !branch) {
    return NextResponse.json(
      { error: "owner, repo and branch are all required." },
      { status: 400 },
    );
  }
  if (paths.length === 0 && dirs.length === 0) {
    return NextResponse.json(
      { error: "Select at least one file or folder." },
      { status: 400 },
    );
  }
  if (paths.length > MAX_FILES_PER_RUN) {
    return NextResponse.json(
      { error: `At most ${MAX_FILES_PER_RUN} files per run.` },
      { status: 400 },
    );
  }
  if (perFile && paths.length > MAX_PRS_PER_RUN) {
    return NextResponse.json(
      {
        error: `One-PR-per-file is capped at ${MAX_PRS_PER_RUN} files. Select fewer, or use a single PR.`,
      },
      { status: 400 },
    );
  }

  try {
    // 1. Re-read each file from the branch and recompute what to change.
    //    Line numbers are never taken from the client.
    const results: StripResult[] = [];
    for (const path of paths) {
      const contentsUrl = `/repos/${owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(branch)}`;

      // A dropper artifact is deleted outright — there is no legitimate content
      // in it to preserve. Only names on the known-dropper list get here, so
      // this can never be talked into deleting something else.
      if (isKnownDroppedFile(path)) {
        try {
          await gh<ContentsResponse>(token, contentsUrl);
          results.push(planDeletion(path));
        } catch (err) {
          results.push({
            path,
            action: "delete",
            ok: false,
            reason:
              err instanceof Error ? err.message : "File not found on this branch.",
            removedLines: [],
            truncatedLines: [],
            rulesHit: [],
          });
        }
        continue;
      }

      let original: string | null = null;
      try {
        const file = await gh<ContentsResponse>(token, contentsUrl);
        original =
          file.encoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
      } catch (err) {
        results.push({
          path,
          action: "strip",
          ok: false,
          reason: err instanceof Error ? err.message : "Could not read the file.",
          removedLines: [],
          truncatedLines: [],
          rulesHit: [],
        });
        continue;
      }
      results.push(stripFindingLines(path, original));
    }

    const applied = results.filter(
      (r) => r.ok && (r.action === "delete" || r.content !== undefined),
    );

    // Directory deletions are justified against the repo's own tree.
    const dirPlans: DirPlan[] = [];
    if (dirs.length > 0) {
      const tree = await getTree(token, owner, repo, branch);
      const blobs = tree.tree.filter((e): e is TreeEntry => e.type === "blob");
      for (const raw of dirs) {
        dirPlans.push(await planDirectory(token, owner, repo, blobs, raw));
      }
    }
    const dirDeletions = dirPlans.filter((p) => p.ok).flatMap((p) => p.files);

    if (applied.length === 0 && dirDeletions.length === 0) {
      return NextResponse.json(
        {
          error: "Nothing could be safely changed — see the per-item reasons.",
          results,
          dirPlans,
        },
        { status: 422 },
      );
    }

    // 2. Read the tip of the base branch once.
    const ref = await gh<RefResponse>(
      token,
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const baseSha = ref.object.sha;
    const baseCommit = await gh<CommitResponse>(
      token,
      `/repos/${owner}/${repo}/git/commits/${baseSha}`,
    );

    const outcomes: CommitOutcome[] = [];

    if (mode === "direct") {
      // Commit straight onto the base branch. `force` stays false, so if the
      // branch moved since the read above GitHub rejects this as a non-
      // fast-forward rather than clobbering someone else's commit.
      const commitSha = await buildCommit(
        token,
        owner,
        repo,
        baseSha,
        baseCommit.tree.sha,
        applied,
        dirDeletions,
      );
      await ghPatch(
        token,
        `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
        { sha: commitSha, force: false },
      );
      outcomes.push({
        mode: "direct",
        commitSha,
        branch,
        files: [...applied.map((r) => r.path), ...dirDeletions],
      });
    } else if (perFile) {
      // One branch and one PR per file. Each is cut from the same base, so they
      // stay independent and can be merged or closed in any order.
      for (const file of applied) {
        const group = [file];
        const commitSha = await buildCommit(
          token,
          owner,
          repo,
          baseSha,
          baseCommit.tree.sha,
          group,
        );
        const head = `${cleanupBranchName(new Date())}-${file.path
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .slice(-40)
          .replace(/^-+/, "")}`;
        await ghPost(token, `/repos/${owner}/${repo}/git/refs`, {
          ref: `refs/heads/${head}`,
          sha: commitSha,
        });
        const pull = await ghPost<PullCreated>(token, `/repos/${owner}/${repo}/pulls`, {
          title: `repo-guard: ${headlineFor(group)} — ${file.path}`,
          head,
          base: branch,
          body: pullRequestBody(group, branch),
          maintainer_can_modify: true,
        });
        outcomes.push({
          mode: "pr",
          commitSha,
          branch: head,
          pullRequestUrl: pull.html_url,
          pullRequestNumber: pull.number,
          files: [file.path],
        });
      }
    } else {
      const commitSha = await buildCommit(
        token,
        owner,
        repo,
        baseSha,
        baseCommit.tree.sha,
        applied,
        dirDeletions,
      );
      const head = cleanupBranchName(new Date());
      await ghPost(token, `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${head}`,
        sha: commitSha,
      });
      const pull = await ghPost<PullCreated>(token, `/repos/${owner}/${repo}/pulls`, {
        title: `repo-guard: ${headline(applied, dirPlans)}`,
        head,
        base: branch,
        body: composePullRequestBody(results, dirPlans, branch),
        maintainer_can_modify: true,
      });
      outcomes.push({
        mode: "pr",
        commitSha,
        branch: head,
        pullRequestUrl: pull.html_url,
        pullRequestNumber: pull.number,
        files: [...applied.map((r) => r.path), ...dirDeletions],
      });
    }

    return NextResponse.json({
      mode,
      perFile,
      outcomes,
      results,
      dirPlans,
      // Kept for the single-PR case so existing UI paths still work.
      ...(outcomes.length === 1 && outcomes[0].pullRequestUrl
        ? {
            pullRequestUrl: outcomes[0].pullRequestUrl,
            pullRequestNumber: outcomes[0].pullRequestNumber,
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      const hint =
        err.status === 403
          ? "The token lacks write access, or a ruleset/branch protection blocks this."
          : err.status === 422
            ? "GitHub rejected the write — the branch may have moved, or a branch/PR already exists. Re-scan and try again."
            : undefined;
      return NextResponse.json(
        { error: hint ? `${hint} ${err.message}` : err.message },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
