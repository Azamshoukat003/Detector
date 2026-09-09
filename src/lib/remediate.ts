import { runRules } from "@/lib/rules";
import {
  analyzeSource,
  isBalanced,
  isBraceLanguage,
  splitAtPayload,
} from "@/lib/source-balance";

/**
 * Remediation is deliberately conservative: it deletes only the lines a rule
 * actually matched, and refuses whenever deleting them would be more like
 * rewriting the file than editing it. A tool that mangles a repo while claiming
 * to clean it is worse than no tool.
 */

/** Refuse if stripping would remove more than this share of the file. */
const MAX_REMOVED_SHARE = 0.5;

/** Refuse on files this short — usually a minified single-line payload. */
const MIN_LINES = 3;

export type RemediationAction = "strip" | "delete";

export interface StripResult {
  path: string;
  /** "strip" removes matched lines; "delete" removes the whole file. */
  action: RemediationAction;
  ok: boolean;
  /** Why it was refused, when ok is false. */
  reason?: string;
  /** The cleaned file content, when ok is true. */
  content?: string;
  /** Lines deleted outright. */
  removedLines: number[];
  /**
   * Lines kept but cut short, because the payload was appended to the end of a
   * line that also held legitimate code (the `};` case).
   */
  truncatedLines: number[];
  rulesHit: string[];
}

/**
 * Re-run the rules server-side and delete the matched lines.
 *
 * The findings are recomputed here rather than trusted from the client: line
 * numbers that decide what gets deleted from a repo must not be attacker- or
 * browser-supplied.
 */
export function stripFindingLines(path: string, original: string): StripResult {
  const base: StripResult = {
    path,
    action: "strip",
    ok: false,
    removedLines: [],
    truncatedLines: [],
    rulesHit: [],
  };

  const { findings } = runRules(path, original);
  if (findings.length === 0) {
    return {
      ...base,
      reason: "No rule matches this file any more — nothing to strip.",
    };
  }

  const rulesHit = [...new Set(findings.map((f) => f.ruleId))].sort();

  // Earliest match column per affected line — that is where the appended
  // payload starts, and everything before it may be legitimate code.
  const firstMatchColumn = new Map<number, number>();
  for (const f of findings) {
    const seen = firstMatchColumn.get(f.line);
    if (seen === undefined || f.column < seen) firstMatchColumn.set(f.line, f.column);
  }
  const affected = [...firstMatchColumn.keys()].sort((a, b) => a - b);

  const crlf = /\r\n/.test(original);
  const eol = crlf ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(original);

  const lines = original.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  if (lines.length < MIN_LINES) {
    return {
      ...base,
      rulesHit,
      removedLines: affected,
      reason: `Only ${lines.length} line(s) — almost certainly minified or a single-line payload. Delete or rewrite it by hand.`,
    };
  }

  // The dropper appends its payload to the end of an existing line — very often
  // straight after the `};` that closes a config object. Deleting that whole
  // line would take the `};` with it and leave a file that no longer parses, so
  // wherever the line has a complete, fully-closed prefix before the match, cut
  // there instead of deleting.
  const analysis = analyzeSource(original);
  const removedLines: number[] = [];
  const truncatedLines: number[] = [];
  const rewritten = new Map<number, string>();

  for (const line of affected) {
    const text = lines[line - 1] ?? "";
    const info = analysis.lines[line - 1];
    const prefix = info
      ? splitAtPayload(text, info.safeCuts, firstMatchColumn.get(line) ?? 0)
      : null;

    if (prefix !== null) {
      rewritten.set(line, prefix);
      truncatedLines.push(line);
    } else {
      removedLines.push(line);
    }
  }

  const share = removedLines.length / lines.length;
  if (share > MAX_REMOVED_SHARE) {
    return {
      ...base,
      rulesHit,
      removedLines,
      truncatedLines,
      reason: `Would remove ${removedLines.length} of ${lines.length} lines (${Math.round(share * 100)}%). That is a rewrite, not a cleanup — review this file by hand.`,
    };
  }

  const drop = new Set(removedLines);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    if (drop.has(line)) continue;
    kept.push(rewritten.get(line) ?? lines[i]);
  }

  if (kept.join("").trim() === "") {
    return {
      ...base,
      rulesHit,
      removedLines,
      truncatedLines,
      reason: "Stripping would leave the file empty — delete it by hand instead.",
    };
  }

  const content = kept.join(eol) + (hadTrailingNewline ? eol : "");

  // Last line of defence. If the file parsed as balanced before and does not
  // after, the edit broke it — refuse rather than open a PR that unbuilds the
  // project. This is exactly the failure that deleting a `};` line produced.
  if (isBraceLanguage(path) && isBalanced(original) && !isBalanced(content)) {
    return {
      ...base,
      rulesHit,
      removedLines,
      truncatedLines,
      reason:
        "The edit would leave brackets unbalanced — the payload is tangled into legitimate code on the same line. Clean this file by hand.",
    };
  }

  return {
    path,
    action: "strip",
    ok: true,
    content,
    removedLines,
    truncatedLines,
    rulesHit,
  };
}

/**
 * Dropper artifacts have no legitimate content to preserve — the right action
 * is removing the file. Only filenames on the known-dropper list ever reach
 * this, so the PR can never be talked into deleting something else.
 */
export function planDeletion(path: string): StripResult {
  return {
    path,
    action: "delete",
    ok: true,
    removedLines: [],
    truncatedLines: [],
    rulesHit: ["known-dropper-file-present"],
  };
}

/** Branch name for a cleanup PR. Timestamped so repeat runs never collide. */
export function cleanupBranchName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  return `repo-guard/cleanup-${stamp}`;
}

export function pullRequestBody(results: StripResult[], branch: string): string {
  const applied = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);

  const deleted = applied.filter((r) => r.action === "delete");
  const stripped = applied.filter((r) => r.action === "strip");

  const lines = ["Automated cleanup opened by **repo-guard**.", "", `Base branch: \`${branch}\``, ""];

  if (deleted.length > 0) {
    lines.push(
      "### Files deleted",
      "",
      "Known dropper artifacts. These are written by the malware, not by your build.",
      "",
      ...deleted.map((r) => `- \`${r.path}\``),
      "",
    );
  }

  if (stripped.length > 0) {
    lines.push(
      "### Lines removed",
      "",
      "| File | Lines removed | Lines truncated | Rules matched |",
      "| --- | --- | --- | --- |",
      ...stripped.map(
        (r) =>
          `| \`${r.path}\` | ${r.removedLines.join(", ") || "—"} | ${r.truncatedLines.join(", ") || "—"} | ${r.rulesHit.join(", ")} |`,
      ),
    );
    if (stripped.some((r) => r.truncatedLines.length > 0)) {
      lines.push(
        "",
        "A *truncated* line is one where the payload was appended to the end of a",
        "line that also held real code — typically right after the `};` closing a",
        "config object. Those lines are cut at the payload boundary instead of",
        "being deleted, so the file still parses.",
      );
    }
  }

  if (refused.length > 0) {
    lines.push(
      "",
      "### Not changed — needs manual review",
      "",
      ...refused.map((r) => `- \`${r.path}\` — ${r.reason}`),
    );
  }

  lines.push(
    "",
    "---",
    "",
    "**Read the diff before merging.** Deletions are limited to the known-dropper",
    "filenames; edits remove only the specific lines that matched a detection",
    "rule. This does not prove a file is now safe — anything the rules did not",
    "catch is still in it, and a `.gitignore` may hide files this list does not",
    "name.",
    "",
    "Cleaning files is also not remediation on its own. If the account that pushed",
    "this still has access and the machine is still infected, it comes back on the",
    "next push. Revoke access, rotate credentials, and enable branch protection",
    "with force-pushes blocked first.",
  );

  return lines.join("\n");
}
