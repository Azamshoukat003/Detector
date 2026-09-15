/**
 * Detection rules for the "compromised collaborator" threat model:
 * malware that amends commits, force-pushes obfuscated JS, and rewrites
 * build/config files to hide dropped payloads and re-run on every build.
 *
 * Every rule is a plain regex. That is deliberate: it makes each finding
 * auditable ("here is the exact pattern that matched, on this line") and
 * keeps the scanner fast enough to run inside a serverless request.
 * The trade-off is stated honestly in the README: regexes produce false
 * positives and are trivially evadable by an attacker who knows them.
 */

import {
  DROPPED_FILE_GITIGNORE_PATTERN,
  KNOWN_DROPPED_FILES,
  basename,
} from "@/lib/scan-policy";

export type Severity = "ERROR" | "WARNING";

export interface Rule {
  id: string;
  severity: Severity;
  /** Must carry the `g` flag so every occurrence is reported. */
  pattern: RegExp;
  message: string;
  /**
   * Restrict the rule to certain files. Without this a rule runs everywhere,
   * which is wrong for patterns that are only meaningful in one kind of file —
   * a `.gitignore` entry is evidence; the same string in a README is not.
   */
  appliesTo?: (path: string) => boolean;
  /**
   * Optional second signal used only to annotate the finding. It never
   * gates the match — it just tells you whether the corroborating
   * evidence named in `message` is actually present in the same file.
   */
  corroborate?: {
    pattern: RegExp;
    present: string;
    absent: string;
  };
}

export const RULES: Rule[] = [
  {
    id: "obfuscator-string-array-rotator",
    severity: "ERROR",
    pattern: /while\s*\(\s*!!\[\]\s*\)\s*\{\s*try\s*\{/g,
    message:
      "javascript-obfuscator string-array rotation idiom detected — strong sign of deliberately obfuscated code.",
  },
  {
    id: "hex-identifier-obfuscation-density",
    severity: "WARNING",
    pattern: /(_0x[0-9a-f]{4,8}\s*[,)=\[]){10,}/g,
    message:
      "High density of _0x-prefixed hex identifiers — typical of obfuscation tools, not legitimate minifiers.",
  },
  {
    id: "spawn-interpreter-inline-code",
    severity: "ERROR",
    pattern: /spawn\([^)]*\[\s*['"](-e|-c|\/c)['"]/g,
    message:
      "Spawns an interpreter with inline -e/-c code — common payload-execution technique.",
  },
  {
    id: "eval-of-dynamic-string",
    severity: "ERROR",
    pattern: /eval\s*\(\s*[^)]*[`+]/g,
    message: "eval() called on a dynamically built string rather than a literal.",
  },
  {
    id: "blockchain-rpc-plus-exec",
    severity: "ERROR",
    pattern:
      /eth_(blockNumber|getBlockByNumber|getTransactionByHash|getTransactionCount)/g,
    message:
      "Combines blockchain RPC calls with child_process — a known way to derive a C2 address from on-chain data instead of hardcoding one, evading domain/IP blocklists.",
    corroborate: {
      pattern: /child_process|execSync|spawnSync|\bspawn\s*\(|\bexecFile\s*\(/,
      present: "child_process / process-spawning API also present in this file.",
      absent:
        "No child_process reference found in this file — the RPC calls alone may be a legitimate web3 client.",
    },
  },
  {
    id: "forced-git-push",
    severity: "WARNING",
    pattern: /git\s+push\s+.*--force/g,
    message: "Script contains a forced git push command.",
  },
  {
    id: "pipe-download-to-shell",
    severity: "ERROR",
    pattern: /curl[^\n]*\|\s*(bash|sh|node|python)/g,
    message: "Downloads and pipes content directly into a shell/interpreter.",
  },
  {
    id: "gitignore-hides-dropped-payload",
    severity: "ERROR",
    appliesTo: (path) => basename(path) === ".gitignore",
    pattern: DROPPED_FILE_GITIGNORE_PATTERN,
    message:
      "This .gitignore entry names a known dropper artifact. Adding these files to .gitignore is how the payload is kept out of `git status` and `git diff` so it survives unnoticed. Remove the line, then check whether the file exists in your working tree.",
  },
];

/** Rule id used for dropper files found in the tree rather than in content. */
export const DROPPER_PRESENT_RULE_ID = "known-dropper-file-present";

/**
 * A dropper artifact is evidence by its mere existence — there is no content
 * pattern to match. This synthesises a finding from the tree entry so it lands
 * in the same report as everything else.
 */
export function droppedFilePresentFinding(path: string): Finding {
  return {
    ruleId: DROPPER_PRESENT_RULE_ID,
    severity: "ERROR",
    message: `Known dropper artifact present in the repository. Files named ${KNOWN_DROPPED_FILES.join(", ")} are written by the malware, not by your build — this one is committed and tracked by git.`,
    path,
    line: 1,
    column: 0,
    excerpt: path,
    note: "Deleting this file does not remediate the machine that wrote it.",
  };
}

export const ASSET_MISMATCH_RULE_ID = "asset-extension-content-mismatch";
export const SVG_SCRIPT_RULE_ID = "svg-embedded-script";

/**
 * A binary asset whose bytes are not what its extension promises. Nobody reads
 * a font in a diff, so a payload named `fa-solid-400.woff2` sitting beside real
 * fonts is invisible to every text rule in this file.
 */
export function assetMismatchFinding(
  path: string,
  expected: string,
  actual: string,
  preview: string,
): Finding {
  return {
    ruleId: ASSET_MISMATCH_RULE_ID,
    severity: "ERROR",
    message: `File extension claims ${expected}, but the bytes are ${actual}. A payload renamed to an asset extension is hidden from every content rule, because binary files are never parsed.`,
    path,
    line: 1,
    column: 0,
    excerpt: preview,
    note: "Header bytes shown above. A real file of this type would start with its own signature.",
  };
}

/** SVG is XML and runs in a browser context — script inside one is executable. */
export function svgScriptFinding(path: string, line: number, excerpt: string): Finding {
  return {
    ruleId: SVG_SCRIPT_RULE_ID,
    severity: "ERROR",
    message:
      "SVG contains a <script> element, a javascript: URL or an inline event handler. SVG is XML that executes when rendered, so this is active code shipped as an image.",
    path,
    line,
    column: 0,
    excerpt,
  };
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  path: string;
  line: number;
  /** 0-based column of the match on that line — used to split off an
   *  appended payload without taking the legitimate code with it. */
  column: number;
  /** The matched text, trimmed and truncated for display. */
  excerpt: string;
  /** Result of the rule's corroborating check, when it has one. */
  note?: string;
}

/** Cap per rule per file so one obfuscated blob cannot flood the report. */
const MAX_MATCHES_PER_RULE_PER_FILE = 5;
const EXCERPT_MAX = 160;

/**
 * In-file suppression, for the legitimate case where a file contains these
 * patterns on purpose — a malware scanner of your own, a test fixture, a
 * security write-up.
 *
 *   // repo-guard:ignore-file        skip the whole file
 *   // repo-guard:ignore-next-line   skip findings on the following line
 *
 * Note the obvious limitation: anyone who can write to the repo can also write
 * these markers. That is why the scan report counts what was suppressed rather
 * than hiding it, and why a change to `.repoguardignore` raises a push alert.
 */
const IGNORE_FILE_MARKER = /repo-guard:\s*ignore-file/;
const IGNORE_NEXT_LINE_MARKER = /repo-guard:\s*ignore-next-line/;

export interface RuleRunResult {
  findings: Finding[];
  /** Findings dropped by an `ignore-next-line` marker. */
  suppressed: number;
  /** True when the whole file carried an `ignore-file` marker. */
  fileIgnored: boolean;
}

function positionAt(content: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart };
}

function excerptAt(content: string, index: number, matched: string): string {
  // Prefer the whole source line — more useful than the bare match — but
  // fall back to the match itself when the line is one giant minified row.
  const start = content.lastIndexOf("\n", index) + 1;
  const endNl = content.indexOf("\n", index);
  const end = endNl === -1 ? content.length : endNl;
  const line = content.slice(start, end);
  const text = line.length <= EXCERPT_MAX * 2 ? line : matched;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_MAX ? clean.slice(0, EXCERPT_MAX) + " …" : clean;
}

/** Run the full rule set against one file's text content. */
export function runRules(path: string, content: string): RuleRunResult {
  if (IGNORE_FILE_MARKER.test(content)) {
    return { findings: [], suppressed: 0, fileIgnored: true };
  }

  const findings: Finding[] = [];
  let suppressed = 0;
  // Only materialised if a suppression marker is actually present.
  const lines = IGNORE_NEXT_LINE_MARKER.test(content)
    ? content.split(/\r?\n/)
    : null;

  const isSuppressed = (line: number) =>
    lines !== null &&
    line >= 2 &&
    IGNORE_NEXT_LINE_MARKER.test(lines[line - 2] ?? "");

  for (const rule of RULES) {
    if (rule.appliesTo && !rule.appliesTo(path)) continue;

    // Fresh regex per file: lastIndex on a shared global regex is stateful.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let hits = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(content)) !== null) {
      const { line, column } = positionAt(content, m.index);

      if (isSuppressed(line)) {
        suppressed++;
      } else {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          message: rule.message,
          path,
          line,
          column,
          excerpt: excerptAt(content, m.index, m[0]),
          note: rule.corroborate
            ? rule.corroborate.pattern.test(content)
              ? rule.corroborate.present
              : rule.corroborate.absent
            : undefined,
        });
      }

      if (m[0].length === 0) re.lastIndex++; // defensive: never loop forever
      if (++hits >= MAX_MATCHES_PER_RULE_PER_FILE) break;
    }
  }

  return { findings, suppressed, fileIgnored: false };
}
