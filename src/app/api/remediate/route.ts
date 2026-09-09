import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GitHubError, gh, ghPost, getBlobText } from "@/lib/github";
import {
  cleanupBranchName,
  planDeletion,
  pullRequestBody,
  stripFindingLines,
  type StripResult,
} from "@/lib/remediate";
import { isKnownDroppedFile } from "@/lib/scan-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cap files per PR so one click cannot rewrite half a repository. */
const MAX_FILES_PER_PR = 25;

interface RemediateRequest {
  owner?: string;
  repo?: string;
  branch?: string;
  paths?: string[];
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
  const paths = [...new Set(body.paths ?? [])].filter((p) => p.trim().length > 0);

  if (!owner || !repo || !branch) {
    return NextResponse.json(
      { error: "owner, repo and branch are all required." },
      { status: 400 },
    );
  }
  if (paths.length === 0) {
    return NextResponse.json({ error: "Select at least one file." }, { status: 400 });
  }
  if (paths.length > MAX_FILES_PER_PR) {
    return NextResponse.json(
      { error: `At most ${MAX_FILES_PER_PR} files per cleanup PR.` },
      { status: 400 },
    );
  }

  try {
    // 1. Re-read each file from the branch and recompute what to strip.
    //    Line numbers are never taken from the client.
    const results: StripResult[] = [];
    for (const path of paths) {
      const contentsUrl = `/repos/${owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(branch)}`;

      // A dropper artifact is deleted outright — there is no legitimate content
      // in it to preserve. Only names on the known-dropper list get here, so
      // this can never be talked into deleting something else. Existence is
      // confirmed first so the tree edit cannot fail halfway through.
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
    if (applied.length === 0) {
      return NextResponse.json(
        {
          error: "Nothing could be safely changed — see the per-file reasons.",
          results,
        },
        { status: 422 },
      );
    }

    // 2. Git plumbing: blobs -> tree -> commit -> branch -> PR.
    const ref = await gh<RefResponse>(
      token,
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const baseSha = ref.object.sha;
    const baseCommit = await gh<CommitResponse>(
      token,
      `/repos/${owner}/${repo}/git/commits/${baseSha}`,
    );

    const treeEntries: Array<{
      path: string;
      mode: string;
      type: string;
      sha: string | null;
    }> = [];
    for (const file of applied) {
      if (file.action === "delete") {
        // A null sha in a tree edit removes the path.
        treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await ghPost<BlobCreated>(
        token,
        `/repos/${owner}/${repo}/git/blobs`,
        {
          content: Buffer.from(file.content as string, "utf8").toString("base64"),
          encoding: "base64",
        },
      );
      treeEntries.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    const tree = await ghPost<TreeCreated>(
      token,
      `/repos/${owner}/${repo}/git/trees`,
      { base_tree: baseCommit.tree.sha, tree: treeEntries },
    );

    const deletions = applied.filter((r) => r.action === "delete").length;
    const edits = applied.length - deletions;
    const headline = [
      deletions > 0 ? `delete ${deletions} dropper file(s)` : null,
      edits > 0 ? `strip flagged lines from ${edits} file(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const summary = applied
      .map((r) =>
        r.action === "delete"
          ? `${r.path} (deleted)`
          : `${r.path} (${r.removedLines.length} removed, ${r.truncatedLines.length} truncated)`,
      )
      .join(", ");
    const commit = await ghPost<CommitResponse>(
      token,
      `/repos/${owner}/${repo}/git/commits`,
      {
        message: `repo-guard: ${headline}\n\n${summary}`,
        tree: tree.sha,
        parents: [baseSha],
      },
    );

    const head = cleanupBranchName(new Date());
    await ghPost(token, `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${head}`,
      sha: commit.sha,
    });

    const pull = await ghPost<PullCreated>(token, `/repos/${owner}/${repo}/pulls`, {
      title: `repo-guard: ${headline}`,
      head,
      base: branch,
      body: pullRequestBody(results, branch),
      maintainer_can_modify: true,
    });

    return NextResponse.json({
      pullRequestUrl: pull.html_url,
      pullRequestNumber: pull.number,
      branch: head,
      results,
    });
  } catch (err) {
    if (err instanceof GitHubError) {
      const hint =
        err.status === 403
          ? "The token lacks write access to this repo (or a ruleset blocks branch creation)."
          : err.status === 422
            ? "GitHub rejected the branch or PR — one may already exist."
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
