import type { Finding } from "@/lib/rules";
import type { ProtectionStatus } from "@/lib/github";

export interface ScanStats {
  /** Blobs in the recursive tree response. */
  treeEntries: number;
  /** Blobs matching the selection policy before the per-run cap. */
  eligible: number;
  /** Blobs actually fetched and run through the rules. */
  scanned: number;
  /** Eligible files dropped because of MAX_FILES_PER_SCAN. */
  skippedOverCap: number;
  /** Eligible-by-name files dropped because they exceeded MAX_FILE_BYTES. */
  skippedTooLarge: number;
  /** Files skipped because the blob decoded to binary. */
  skippedBinary: number;
  /** Patterns loaded from the repo's .repoguardignore, if it has one. */
  ignorePatterns: number;
  /** Files skipped by a .repoguardignore pattern. */
  ignoredByFile: number;
  /** Files skipped by an in-file repo-guard:ignore-file marker. */
  ignoredByMarker: number;
  /** Findings dropped by repo-guard:ignore-next-line markers. */
  suppressedFindings: number;
  /** Known dropper artifacts found tracked in the tree. */
  droppersPresent: number;
  /** Binary assets whose header was verified against their extension. */
  assetsChecked: number;
  /** Assets whose bytes did not match their extension (or SVGs with script). */
  assetMismatches: number;
  /** Assets left unchecked by the per-run asset cap. */
  assetsSkipped: number;
  /** Files whose blob fetch failed. */
  fetchErrors: number;
  /** GitHub truncated the recursive tree — the scan did not see everything. */
  treeTruncated: boolean;
  durationMs: number;
}

export interface ScanResult {
  fullName: string;
  branch: string;
  scannedAt: string;
  stats: ScanStats;
  findings: Finding[];
  protection: ProtectionStatus;
}

export interface RepoListItem {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
  admin: boolean;
}

/** One branch's result in a branch sweep. */
export interface BranchReport {
  name: string;
  isDefault: boolean;
  protectedBranch: boolean;
  status: "infected" | "clean" | "error" | "skipped" | "default";
  /** Files on this branch that a rule matched. */
  files: string[];
  /** Known dropper artifacts present on this branch. */
  droppers: string[];
  errors: number;
  warnings: number;
  /** Files compared, and how many of those were actually fetched. */
  changedFiles: number;
  scannedFiles: number;
  /** How far ahead of the default branch it is, when known. */
  aheadBy: number | null;
  reason?: string;
}

export interface BranchSweepResult {
  fullName: string;
  defaultBranch: string;
  branches: BranchReport[];
  stats: {
    total: number;
    swept: number;
    infected: number;
    durationMs: number;
    /** True when the time or branch cap stopped the sweep early. */
    truncated: boolean;
  };
}
