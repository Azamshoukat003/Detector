/**
 * What gets scanned, and what gets skipped. Kept separate from the rules
 * so the selection policy is easy to read and adjust.
 */

/** GitHub tree entries larger than this are skipped outright. */
export const MAX_FILE_BYTES = 500 * 1024;

/** Hard cap per scan run, to stay inside the serverless time budget. */
export const MAX_FILES_PER_SCAN = 200;

/** Path prefixes/segments never worth scanning (vendored or generated). */
export const SKIP_DIRS = ["node_modules/", "dist/", "build/", ".next/"];

export const SCAN_EXTENSIONS = [
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
];

/**
 * Filenames this dropper writes into a repo. Three signals matter: the file
 * being present, the attacker adding it to `.gitignore` so it stops showing up
 * in `git status`, and a push touching it.
 *
 * This is the SINGLE place to add a new artifact — the always-scan set, the
 * push-alert set, the `.gitignore` rule and the local check all derive from it.
 */
export const KNOWN_DROPPED_FILES = [
  "branch_structure.json",
  "temp_auto_push.bat",
  "temp_interactive_push.bat",
  "config.bat",
] as const;

const DROPPED_FILE_SET: ReadonlySet<string> = new Set(KNOWN_DROPPED_FILES);

export function isKnownDroppedFile(path: string): boolean {
  return DROPPED_FILE_SET.has(basename(path));
}

/**
 * Matches a whole `.gitignore` line naming one of the dropped files, allowing
 * the usual leading `/`, `**​/`, `!` and trailing `/` decorations. Derived from
 * the list above so the two can never drift apart.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// String.raw so backslashes reach the RegExp intact — a plain "\t" here would
// be a literal tab and "\*" would collapse to "*", which is a syntax error.
export const DROPPED_FILE_GITIGNORE_PATTERN = new RegExp(
  String.raw`^[ \t]*!?[ \t]*/?(?:\*\*/)?(?:` +
    KNOWN_DROPPED_FILES.map(escapeForRegExp).join("|") +
    String.raw`)[ \t]*/?[ \t]*$`,
  "gm",
);

/**
 * Always scanned regardless of extension. These are the files the observed
 * malware rewrites: .gitignore to hide dropped files, and build-pipeline
 * config to re-establish execution on every install/build.
 */
export const ALWAYS_SCAN_FILENAMES = new Set([
  ".gitignore",
  ".npmrc",
  // Dropper artifacts — scanned for content regardless of extension.
  ...KNOWN_DROPPED_FILES,
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "webpack.config.js",
  "babel.config.js",
  "vite.config.js",
  "next.config.js",
]);

/**
 * Files that, if touched by a push, are worth an alert on their own.
 *
 * `.repoguardignore` is in here deliberately: anyone who can suppress this
 * tool's findings can hide a payload from it, so a change to the ignore list
 * is itself an event worth waking you up for.
 */
export const SENSITIVE_PUSH_PATHS = new Set([
  ".gitignore",
  "postcss.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "eslint.config.js",
  ".eslintrc.js",
  ".npmrc",
  ".repoguardignore",
  ...KNOWN_DROPPED_FILES,
]);

/** Optional repo-root file listing gitignore-style patterns to skip. */
export const IGNORE_FILE = ".repoguardignore";

/**
 * Translate one gitignore-style pattern to an anchored RegExp.
 * Supports `*`, `**`, `?`, a leading `/` to anchor at the repo root, and a
 * trailing `/` to mean "this directory and everything under it". Negation
 * (`!pattern`) is not supported — see the README.
 */
function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);

  let body = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  // A bare name with no slash matches at any depth, the way gitignore does.
  const head = anchored || p.includes("/") ? body : "(?:.*/)?" + body;
  const tail = dirOnly ? "/.*" : "(?:/.*)?";
  return new RegExp(`^${head}${tail}$`);
}

export interface IgnoreMatcher {
  patternCount: number;
  matches: (path: string) => boolean;
}

/** Build a matcher from the raw text of a `.repoguardignore` file. */
export function buildIgnoreMatcher(content: string | null): IgnoreMatcher {
  if (!content) return { patternCount: 0, matches: () => false };

  const patterns = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(globToRegExp);

  return {
    patternCount: patterns.length,
    matches: (path: string) => patterns.some((re) => re.test(path)),
  };
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function isSkippedDir(path: string): boolean {
  return SKIP_DIRS.some(
    (d) => path === d || path.startsWith(d) || path.includes("/" + d),
  );
}

export function hasScannableExtension(path: string): boolean {
  const name = basename(path).toLowerCase();
  return SCAN_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** True for the build-pipeline config files this threat model cares about. */
export function isConfigFile(path: string): boolean {
  return ALWAYS_SCAN_FILENAMES.has(basename(path));
}

export type SelectionReason = "extension" | "always-scan";

/** Decide whether a repo-relative path is in scope for scanning. */
export function selectionReason(path: string): SelectionReason | null {
  if (isSkippedDir(path)) return null;
  if (ALWAYS_SCAN_FILENAMES.has(basename(path))) return "always-scan";
  if (hasScannableExtension(path)) return "extension";
  return null;
}
