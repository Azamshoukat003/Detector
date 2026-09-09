"use client";

import { useMemo, useState } from "react";
import type { Finding } from "@/lib/rules";
import type { ProtectionStatus } from "@/lib/github";
import type { RepoListItem, ScanResult } from "@/lib/scan-types";
import { isConfigFile, isKnownDroppedFile } from "@/lib/scan-policy";

interface StripOutcome {
  path: string;
  ok: boolean;
  reason?: string;
  removedLines: number[];
  truncatedLines: number[];
  rulesHit: string[];
}

interface RemediateResponse {
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  results?: StripOutcome[];
  error?: string;
}

function Remediation({
  repo,
  result,
}: {
  repo: RepoListItem;
  result: ScanResult;
}) {
  // One entry per distinct flagged file, config files first.
  const files = useMemo(() => {
    const byPath = new Map<string, number>();
    for (const f of result.findings) {
      byPath.set(f.path, (byPath.get(f.path) ?? 0) + 1);
    }
    return [...byPath.entries()]
      .map(([path, count]) => {
        const dropper = isKnownDroppedFile(path);
        return {
          path,
          count,
          dropper,
          // Dropper files are deleted whole; everything else has lines stripped.
          config: !dropper && isConfigFile(path),
          action: dropper ? ("delete" as const) : ("strip" as const),
        };
      })
      .sort(
        (a, b) =>
          Number(b.dropper) - Number(a.dropper) ||
          Number(b.config) - Number(a.config) ||
          a.path.localeCompare(b.path),
      );
  }, [result.findings]);

  // Config files are pre-selected; ordinary source files are not, because
  // deleting lines out of application code is a much bigger claim.
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(files.filter((f) => f.config || f.dropper).map((f) => f.path)),
  );
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<RemediateResponse | null>(null);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setResponse(null);
    try {
      const res = await fetch("/api/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
          branch: result.branch,
          paths: [...selected],
        }),
      });
      setResponse((await res.json()) as RemediateResponse);
    } catch (err) {
      setResponse({
        error: err instanceof Error ? err.message : "Request failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (files.length === 0) return null;

  return (
    <div className="sect">
      <div className="sect-head">
        <span className="sect-title">Remediation</span>
        <span className="sect-rule" />
      </div>

      <p className="hint" style={{ marginTop: 0, marginBottom: 11 }}>
        Opens a pull request on a new branch — nothing is written to{" "}
        <b>{result.branch}</b>. Known dropper artifacts are <b>deleted whole</b>;
        every other file has <b>only</b> the lines a rule matched removed. Where
        the payload was appended to a line that also holds real code, the line is
        cut at the boundary rather than deleted, and the result is checked for
        balanced brackets before any PR is opened.
        Droppers and config files are pre-selected; ordinary source files are
        not, because removing lines from application code is a much bigger claim
        than removing them from a config.
      </p>

      <div className="fixlist">
        {files.map((f) => (
          <label className="fixrow" key={f.path}>
            <input
              type="checkbox"
              checked={selected.has(f.path)}
              onChange={() => toggle(f.path)}
              disabled={busy}
            />
            <span className="p">{f.path}</span>
            {f.dropper ? (
              <span className="chip" style={{ color: "var(--err)" }}>
                delete file
              </span>
            ) : null}
            {f.config ? <span className="chip">config</span> : null}
            <span className="why">
              {f.dropper
                ? "dropper artifact"
                : `${f.count} finding${f.count === 1 ? "" : "s"}`}
            </span>
          </label>
        ))}
      </div>

      <div className="fixbar">
        <button
          className="btn btn--solid"
          disabled={busy || selected.size === 0}
          onClick={() => void submit()}
        >
          {busy
            ? "opening pull request…"
            : `Open cleanup PR (${selected.size} file${selected.size === 1 ? "" : "s"})`}
        </button>
        <span className="why">requires write access to {repo.fullName}</span>
      </div>

      {response?.pullRequestUrl ? (
        <div className="banner" style={{ borderLeftColor: "var(--ok)" }}>
          <span className="mark" style={{ color: "var(--ok)" }}>
            ✓
          </span>
          <span>
            Opened{" "}
            <a href={response.pullRequestUrl} target="_blank" rel="noreferrer noopener">
              pull request #{response.pullRequestNumber}
            </a>
            . Read the diff before merging — this removes matched lines only, and
            proves nothing about what the rules did not catch.
          </span>
        </div>
      ) : null}

      {response?.error ? (
        <div className="banner banner--err">
          <span className="mark">✕</span>
          <span>{response.error}</span>
        </div>
      ) : null}

      {response?.results?.some((r) => !r.ok) ? (
        <div className="fixlist" style={{ marginTop: 10 }}>
          {response.results
            .filter((r) => !r.ok)
            .map((r) => (
              <div className="fixrow" key={r.path}>
                <span className="mark" style={{ color: "var(--warn)" }}>
                  !
                </span>
                <span className="p">{r.path}</span>
                <span className="why">{r.reason}</span>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function Check({ state, label }: { state: boolean | null; label: string }) {
  const kind = state === null ? "unknown" : state ? "yes" : "no";
  const mark = state === null ? "?" : state ? "✓" : "✕";
  return (
    <span className={`check check--${kind}`}>
      <span className="mark">{mark}</span>
      {label}
    </span>
  );
}

function Protection({ protection }: { protection: ProtectionStatus }) {
  const reviewLabel = protection.requiredApprovingReviewCount
    ? `PR reviews required (${protection.requiredApprovingReviewCount})`
    : "PR reviews required";

  return (
    <div className="sect">
      <div className="sect-head">
        <span className="sect-title">Default branch protection</span>
        <span className="sect-rule" />
      </div>
      <div className="checks">
        <Check
          state={
            protection.state === "unknown" ? null : protection.state === "protected"
          }
          label="protection rule"
        />
        <Check state={protection.requiresPullRequestReviews} label={reviewLabel} />
        <Check state={protection.forcePushBlocked} label="force-push blocked" />
      </div>
      {protection.detail ? <p className="hint">{protection.detail}</p> : null}
    </div>
  );
}

function FindingCard({
  finding,
  blobUrl,
}: {
  finding: Finding;
  blobUrl: string | null;
}) {
  const loc = (
    <>
      {finding.path}
      <span className="ln">:{finding.line}</span>
    </>
  );

  return (
    <div className={`finding finding--${finding.severity}`}>
      <div className="finding-top">
        <span className={`sev sev--${finding.severity}`}>{finding.severity}</span>
        <span className="rule-id">{finding.ruleId}</span>
        {blobUrl ? (
          <a
            className="loc"
            href={blobUrl}
            target="_blank"
            rel="noreferrer noopener"
            title="Open this line on GitHub"
          >
            {loc}
          </a>
        ) : (
          <span className="loc">{loc}</span>
        )}
      </div>
      <div className="finding-body">
        <p className="finding-msg">{finding.message}</p>
        {finding.note ? <p className="finding-note">{finding.note}</p> : null}
        <div className="hunk">
          <div className="gutter">{finding.line}</div>
          <pre className="code">{finding.excerpt}</pre>
        </div>
      </div>
    </div>
  );
}

export default function ScanDetail({
  repo,
  result,
}: {
  repo: RepoListItem;
  result: ScanResult;
}) {
  const { stats, findings, protection } = result;
  const errors = findings.filter((f) => f.severity === "ERROR").length;
  const warnings = findings.length - errors;
  const partial = stats.skippedOverCap > 0 || stats.treeTruncated;
  const suppressionActive =
    stats.ignoredByFile > 0 ||
    stats.ignoredByMarker > 0 ||
    stats.suppressedFindings > 0;

  const blobUrl = (f: Finding) =>
    `${repo.htmlUrl}/blob/${encodeURIComponent(result.branch)}/${f.path}#L${f.line}`;

  return (
    <div className="detail">
      <div className="sect sect--tight">
        <div className="facts">
          <span>
            branch <b>{result.branch}</b>
          </span>
          <span>
            scanned <b>{stats.scanned}</b> of <b>{stats.eligible}</b> eligible
            <span style={{ color: "var(--edge)" }}> / </span>
            {stats.treeEntries} tracked
          </span>
          <span>
            findings <b>{errors}</b>E <b>{warnings}</b>W
          </span>
          <span>
            took <b>{(stats.durationMs / 1000).toFixed(1)}s</b>
          </span>
          <span>
            at <b>{new Date(result.scannedAt).toLocaleTimeString()}</b>
          </span>
        </div>
      </div>

      {partial ? (
        <div className="sect sect--tight">
          <div className="banner" style={{ margin: 0 }}>
            <span className="mark">!</span>
            <span>
              {stats.treeTruncated
                ? "GitHub truncated this repo's file tree, so some files were never considered. "
                : ""}
              {stats.skippedOverCap > 0
                ? `${stats.skippedOverCap} eligible file${stats.skippedOverCap === 1 ? "" : "s"} skipped by the 200-file per-run cap. `
                : ""}
              This scan is not exhaustive — &ldquo;clean&rdquo; here means clean in
              what it looked at.
            </span>
          </div>
        </div>
      ) : null}

      {stats.skippedTooLarge > 0 || stats.skippedBinary > 0 || stats.fetchErrors > 0 ? (
        <div className="sect sect--tight">
          <div className="facts">
            <span style={{ color: "var(--faint)" }}>skipped:</span>
            <span>
              over 500KB <b>{stats.skippedTooLarge}</b>
            </span>
            <span>
              binary <b>{stats.skippedBinary}</b>
            </span>
            <span>
              fetch errors <b>{stats.fetchErrors}</b>
            </span>
          </div>
        </div>
      ) : null}

      {suppressionActive ? (
        <div className="sect sect--tight">
          <div className="facts">
            <span style={{ color: "var(--warn)" }}>suppressed:</span>
            <span>
              by .repoguardignore <b>{stats.ignoredByFile}</b> file
              {stats.ignoredByFile === 1 ? "" : "s"}
              {stats.ignorePatterns > 0 ? ` (${stats.ignorePatterns} patterns)` : ""}
            </span>
            <span>
              by ignore-file marker <b>{stats.ignoredByMarker}</b>
            </span>
            <span>
              by ignore-next-line <b>{stats.suppressedFindings}</b> finding
              {stats.suppressedFindings === 1 ? "" : "s"}
            </span>
          </div>
          <p className="hint">
            Suppression is honoured but never hidden — anyone who can write to
            this repo can also write these markers, so the counts stay on the
            report. A change to <b>.repoguardignore</b> raises a push alert like
            any other sensitive config file.
          </p>
        </div>
      ) : null}

      <Protection protection={protection} />

      <div className="sect">
        <div className="sect-head">
          <span className="sect-title">
            Findings{findings.length > 0 ? ` · ${findings.length}` : ""}
          </span>
          <span className="sect-rule" />
          {findings.length > 0 ? (
            <span className="chip">
              {errors} error · {warnings} warning
            </span>
          ) : null}
        </div>

        {findings.length === 0 ? (
          <p className="hint" style={{ marginTop: 0 }}>
            No rule matched any scanned file on <b>{result.branch}</b>. The rules
            are regex-based and evadable — treat this as &ldquo;nothing known
            matched&rdquo;, not a clean bill of health.
          </p>
        ) : (
          findings.map((f, i) => (
            <FindingCard
              key={`${f.ruleId}:${f.path}:${f.line}:${i}`}
              finding={f}
              blobUrl={blobUrl(f)}
            />
          ))
        )}
      </div>

      <Remediation repo={repo} result={result} />
    </div>
  );
}
