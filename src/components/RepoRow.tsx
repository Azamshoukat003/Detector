"use client";

import type { RepoListItem, ScanResult } from "@/lib/scan-types";
import { useState } from "react";
import ScanDetail from "@/components/ScanDetail";
import BranchSweep from "@/components/BranchSweep";

export type ScanStatus = "idle" | "scanning" | "clean" | "flagged" | "error";

export interface RepoScanState {
  status: ScanStatus;
  result?: ScanResult;
  error?: string;
  expanded: boolean;
}

const PILL: Record<ScanStatus, { cls: string; text: string }> = {
  idle: { cls: "pill--idle", text: "unscanned" },
  scanning: { cls: "pill--warn", text: "scanning" },
  clean: { cls: "pill--ok", text: "clean" },
  flagged: { cls: "pill--err", text: "flagged" },
  error: { cls: "pill--err", text: "scan failed" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d ago`;
  return `${Math.round(days / 365)}y ago`;
}

export default function RepoRow({
  repo,
  state,
  onScan,
  onToggle,
}: {
  repo: RepoListItem;
  state: RepoScanState;
  onScan: () => void;
  onToggle: () => void;
}) {
  const { status, result, error, expanded } = state;
  const pill = PILL[status];
  // Branch sweeping is independent of the file scan — you can check branches
  // without scanning the default branch first.
  const [branchesOpen, setBranchesOpen] = useState(false);

  const errors = result?.findings.filter((f) => f.severity === "ERROR").length ?? 0;
  const warnings = (result?.findings.length ?? 0) - errors;

  return (
    <div className="node">
      <div className="spine">
        <span
          className={`dot${status === "idle" ? "" : ` dot--${status}`}`}
          aria-hidden
        />
      </div>

      <div className={`row${expanded ? " row--open" : ""}`}>
        <div className="row-main">
          <a
            className="repo"
            href={repo.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            <span className="owner">{repo.owner}/</span>
            {repo.name}
          </a>

          {repo.private ? <span className="chip">private</span> : null}
          {repo.fork ? <span className="chip">fork</span> : null}
          {repo.archived ? <span className="chip">archived</span> : null}

          <div className="row-actions">
            <span className={`pill ${pill.cls}`}>
              {status === "flagged"
                ? `${errors}E · ${warnings}W`
                : pill.text}
            </span>

            <button
              className="btn btn--quiet"
              aria-pressed={branchesOpen}
              onClick={() => setBranchesOpen((v) => !v)}
            >
              {branchesOpen ? "hide branches" : "branches"}
            </button>

            {result || error ? (
              <button className="btn btn--quiet" onClick={onToggle}>
                {expanded ? "hide" : "details"}
              </button>
            ) : null}

            <button
              className={`btn${result || error ? "" : " btn--solid"}`}
              onClick={onScan}
              disabled={status === "scanning"}
            >
              {status === "scanning" ? "scanning…" : result ? "rescan" : "scan"}
            </button>
          </div>
        </div>

        <div className="row-meta">
          <span>{repo.defaultBranch}</span>
          <span className="sep">|</span>
          <span>pushed {relativeTime(repo.pushedAt)}</span>
          {result ? (
            <>
              <span className="sep">|</span>
              <span>
                scanned {new Date(result.scannedAt).toLocaleTimeString()} ·{" "}
                {result.stats.scanned} files
              </span>
            </>
          ) : null}
          {result && result.protection.forcePushBlocked === false ? (
            <>
              <span className="sep">|</span>
              <span className="warm">force-push not blocked</span>
            </>
          ) : null}
          {status === "error" && error ? (
            <>
              <span className="sep">|</span>
              <span className="hot">{error}</span>
            </>
          ) : null}
        </div>

        {status === "scanning" ? <span className="scanbar" aria-hidden /> : null}

        {branchesOpen ? <BranchSweep repo={repo} /> : null}

        {expanded && result ? <ScanDetail repo={repo} result={result} /> : null}
      </div>
    </div>
  );
}
