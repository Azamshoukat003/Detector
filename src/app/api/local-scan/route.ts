import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { authOptions } from "@/lib/auth";
import {
  DROPPED_FILE_GITIGNORE_PATTERN,
  KNOWN_DROPPED_FILES,
  isKnownDroppedFile,
} from "@/lib/scan-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".cache",
  ".turbo",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
]);

const MAX_DEPTH = 12;
const MAX_ENTRIES = 60_000;
const TIME_BUDGET_MS = 25_000;
/** Never read a .gitignore larger than this into memory. */
const MAX_GITIGNORE_BYTES = 256 * 1024;

/**
 * Same pattern as the repo rule, but without the g/m flags so `^` and `$`
 * anchor a single line and there is no stateful lastIndex to reset.
 */
const LINE_MATCHER = new RegExp(DROPPED_FILE_GITIGNORE_PATTERN.source);

/**
 * This endpoint reads the filesystem of whatever machine the server runs on.
 * That is exactly what you want when running repo-guard locally, and exactly
 * what you do not want on a deployment other people can sign into — so it is
 * off by default anywhere that looks like production, and hard-off on Vercel.
 */
function localScanEnabled(): boolean {
  if (process.env.VERCEL) return false;
  if (process.env.ENABLE_LOCAL_SCAN === "0") return false;
  if (process.env.ENABLE_LOCAL_SCAN === "1") return true;
  return process.env.NODE_ENV !== "production";
}

const DISABLED_MESSAGE =
  "Local filesystem scanning is disabled here. It runs only on a local dev server, or when ENABLE_LOCAL_SCAN=1 is set — never on Vercel, because it would expose the server's filesystem to anyone who can sign in.";

/**
 * Editor config that executes on folder open. Checked on disk as well as in
 * the repo, because this is the one finding you want *before* you open the
 * folder in an editor — by the time it is in your working tree, opening it is
 * all it takes.
 */
const AUTORUN_MARKERS: { re: RegExp; note: string }[] = [
  {
    re: /"runOn"\s*:\s*"folderOpen"/,
    note: "task runs automatically when this folder is opened",
  },
  {
    re: /"task\.allowAutomaticTasks"\s*:\s*true/,
    note: "automatic tasks are pre-approved, so VS Code will not prompt",
  },
  {
    re: /\b(?:node|deno|bun|python3?|ruby|perl|osascript)\s+[^\s"'|&;)]*\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|ico|webp|bmp|pdf|zip|bin|dat|wasm)\b/i,
    note: "an interpreter is invoked on a data/asset file — that executes it as code",
  },
];

export interface LocalHit {
  kind: "dropped-file" | "gitignore-entry" | "autorun-task";
  path: string;
  /** Bytes, for a dropped file. */
  size?: number;
  /** Last-modified ISO timestamp, for a dropped file. */
  modified?: string;
  /** Matching lines, for a .gitignore entry. */
  lines?: { line: number; text: string }[];
}

export interface LocalScanResult {
  root: string;
  hits: LocalHit[];
  stats: {
    dirsVisited: number;
    filesVisited: number;
    gitignoresRead: number;
    autorunConfigsRead: number;
    durationMs: number;
    /** True when a limit stopped the walk before it finished. */
    truncated: boolean;
    truncatedBy?: "depth" | "entries" | "time";
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  return NextResponse.json({
    enabled: localScanEnabled(),
    defaultRoot: process.cwd(),
    watching: KNOWN_DROPPED_FILES,
    ...(localScanEnabled() ? {} : { reason: DISABLED_MESSAGE }),
  });
}

export async function POST(request: Request) {
  const started = Date.now();

  const session = await getServerSession(authOptions);
  if (!session?.accessToken) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!localScanEnabled()) {
    return NextResponse.json({ error: DISABLED_MESSAGE }, { status: 403 });
  }

  let body: { root?: string };
  try {
    body = (await request.json()) as { root?: string };
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const root = body.root?.trim();
  if (!root) {
    return NextResponse.json({ error: "A folder path is required." }, { status: 400 });
  }
  if (!isAbsolute(root)) {
    return NextResponse.json(
      { error: "Give an absolute path, e.g. C:\\Users\\you\\projects" },
      { status: 400 },
    );
  }

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return NextResponse.json({ error: "That path is not a folder." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "That folder does not exist." }, { status: 400 });
  }

  const hits: LocalHit[] = [];
  let dirsVisited = 0;
  let filesVisited = 0;
  let gitignoresRead = 0;
  let autorunConfigsRead = 0;
  let truncatedBy: "depth" | "entries" | "time" | undefined;

  const overBudget = () => {
    if (dirsVisited + filesVisited >= MAX_ENTRIES) {
      truncatedBy ??= "entries";
      return true;
    }
    if (Date.now() - started > TIME_BUDGET_MS) {
      truncatedBy ??= "time";
      return true;
    }
    return false;
  };

  async function walk(dir: string, depth: number): Promise<void> {
    if (overBudget()) return;
    if (depth > MAX_DEPTH) {
      truncatedBy ??= "depth";
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — permissions, junction, race
    }
    dirsVisited++;

    for (const entry of entries) {
      if (overBudget()) return;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks: no cycles, no escapes
      filesVisited++;

      if (isKnownDroppedFile(entry.name)) {
        try {
          const info = await stat(full);
          hits.push({
            kind: "dropped-file",
            path: full,
            size: info.size,
            modified: info.mtime.toISOString(),
          });
        } catch {
          hits.push({ kind: "dropped-file", path: full });
        }
        continue;
      }

      // Editor / dev-container config that can execute on folder open.
      const parent = dir.split(/[\\/]/).pop() ?? "";
      if (
        (parent === ".vscode" || parent === ".devcontainer") &&
        entry.name.toLowerCase().endsWith(".json")
      ) {
        try {
          const info = await stat(full);
          if (info.size <= MAX_GITIGNORE_BYTES) {
            const text = await readFile(full, "utf8");
            autorunConfigsRead++;
            const split = text.split(/\r?\n/);
            const lines: { line: number; text: string }[] = [];
            for (let i = 0; i < split.length; i++) {
              for (const m of AUTORUN_MARKERS) {
                if (m.re.test(split[i])) {
                  lines.push({ line: i + 1, text: split[i].trim().slice(0, 200) });
                  break;
                }
              }
            }
            if (lines.length > 0) {
              hits.push({ kind: "autorun-task", path: full, lines });
            }
          }
        } catch {
          /* unreadable config — skip */
        }
        continue;
      }

      if (entry.name === ".gitignore") {
        try {
          const info = await stat(full);
          if (info.size > MAX_GITIGNORE_BYTES) continue;
          const text = await readFile(full, "utf8");
          gitignoresRead++;
          const lines: { line: number; text: string }[] = [];
          const split = text.split(/\r?\n/);
          for (let i = 0; i < split.length; i++) {
            if (LINE_MATCHER.test(split[i])) {
              lines.push({ line: i + 1, text: split[i].trim() });
            }
          }
          if (lines.length > 0) {
            hits.push({ kind: "gitignore-entry", path: full, lines });
          }
        } catch {
          /* unreadable .gitignore — skip */
        }
      }
    }
  }

  await walk(root, 0);

  hits.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));

  const result: LocalScanResult = {
    root: root.endsWith(sep) ? root.slice(0, -1) : root,
    hits,
    stats: {
      dirsVisited,
      filesVisited,
      gitignoresRead,
      autorunConfigsRead,
      durationMs: Date.now() - started,
      truncated: truncatedBy !== undefined,
      ...(truncatedBy ? { truncatedBy } : {}),
    },
  };

  return NextResponse.json(result);
}
