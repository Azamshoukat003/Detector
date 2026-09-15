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

interface CommitOutcome {
  mode: "pr" | "direct";
  commitSha: string;
  branch: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  files: string[];
}

interface DirPlan {
  dir: string;
  ok: boolean;
  reason?: string;
  files: string[];
  justification?: string;
}

interface RemediateResponse {
  mode?: "pr" | "direct";
  perFile?: boolean;
  outcomes?: CommitOutcome[];
  results?: StripOutcome[];
  dirPlans?: DirPlan[];
  error?: string;
}

/** Directory of a repo-relative path, or null for a file at the root. */
function dirOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
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
  // Folders worth offering wholesale removal for: those holding a dropper
  // artifact or an asset whose bytes contradict its extension. The server
  // re-checks this independently before deleting anything.
  const folders = useMemo(() => {
    const byDir = new Map<string, number>();
    for (const f of result.findings) {
      const isPlanted =
        isKnownDroppedFile(f.path) ||
        f.ruleId === "asset-extension-content-mismatch" ||
        f.ruleId === "svg-embedded-script";
      if (!isPlanted) continue;
      const d = dirOf(f.path);
      if (d === null) continue; // never offer the repo root
      byDir.set(d, (byDir.get(d) ?? 0) + 1);
    }
    return [...byDir.entries()]
      .map(([dir, hits]) => ({ dir, hits }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }, [result.findings]);

  const [selectedDirs, setSelectedDirs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<RemediateResponse | null>(null);
  // "pr" opens a pull request; "direct" commits straight to the base branch.
  const [mode, setMode] = useState<"pr" | "direct">("pr");
  const [perFile, setPerFile] = useState(false);
  // Committing straight to the base branch is irreversible from here, so it
  // takes a second, deliberate click.
  const [armed, setArmed] = useState(false);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const submit = async () => {
    // A folder removal is irreversible in effect even inside a PR, so it arms
    // the same confirm step that a direct commit does.
    if ((mode === "direct" || selectedDirs.size > 0) && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
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
          dirs: [...selectedDirs],
          mode,
          perFile,
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
        Known dropper artifacts are <b>deleted whole</b>; every other file has{" "}
        <b>only</b> the lines a rule matched removed. Where the payload was
        appended to a line that also holds real code, the line is cut at the
        boundary rather than deleted, and the result is checked for balanced
        brackets before anything is written. Droppers and config files are
        pre-selected; ordinary source files are not, because removing lines from
        application code is a much bigger claim than removing them from a config.
      </p>

      <div className="fixbar" style={{ marginTop: 0, marginBottom: 11 }}>
        <div className="seg" role="group" aria-label="Write mode">
          <button
            aria-pressed={mode === "pr"}
            disabled={busy}
            onClick={() => {
              setMode("pr");
              setArmed(false);
            }}
          >
            open pull request
          </button>
          <button
            aria-pressed={mode === "direct"}
            disabled={busy}
            onClick={() => {
              setMode("direct");
              setArmed(false);
            }}
          >
            commit to {result.branch}
          </button>
        </div>

        {mode === "pr" ? (
          <div className="seg" role="group" aria-label="Pull request grouping">
            <button
              aria-pressed={!perFile}
              disabled={busy}
              onClick={() => setPerFile(false)}
            >
              one PR for all
            </button>
            <button
              aria-pressed={perFile}
              disabled={busy}
              onClick={() => setPerFile(true)}
            >
              one PR per file
            </button>
          </div>
        ) : null}

        <span className="why">
          {mode === "pr"
            ? `nothing is written to ${result.branch} until you merge`
            : `writes straight to ${result.branch} — no review step`}
        </span>
      </div>

      {folders.length > 0 ? (
        <>
          <div className="sect-head" style={{ marginBottom: 8 }}>
            <span className="sect-title">Delete whole folders</span>
            <span className="sect-rule" />
          </div>
          <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
            Every file under a ticked folder is removed, not just the flagged
            one. Only folders containing a planted file are offered, and the
            server re-confirms that independently before deleting anything —
            but legitimate files in the same folder go too. Leave these unticked
            unless the whole folder arrived with the payload.
          </p>
          <div className="fixlist" style={{ marginBottom: 11 }}>
            {folders.map((d) => (
              <label className="fixrow" key={d.dir}>
                <input
                  type="checkbox"
                  checked={selectedDirs.has(d.dir)}
                  disabled={busy}
                  onChange={() =>
                    setSelectedDirs((prev) => {
                      const next = new Set(prev);
                      if (next.has(d.dir)) next.delete(d.dir);
                      else next.add(d.dir);
                      setArmed(false);
                      return next;
                    })
                  }
                />
                <span className="p">{d.dir}/</span>
                <span className="chip" style={{ color: "var(--err)" }}>
                  whole folder
                </span>
                <span className="why">
                  {d.hits} planted file{d.hits === 1 ? "" : "s"} inside
                </span>
              </label>
            ))}
          </div>
        </>
      ) : null}

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
          className={`btn ${armed ? "btn--danger" : "btn--solid"}`}
          disabled={busy || (selected.size === 0 && selectedDirs.size === 0)}
          onClick={() => void submit()}
        >
          {busy
            ? mode === "direct"
              ? "committing…"
              : "opening pull request…"
            : armed
              ? `confirm — commit ${selected.size} file${selected.size === 1 ? "" : "s"} to ${result.branch}`
              : mode === "direct"
                ? `Commit to ${result.branch} (${selected.size})`
                : perFile
                  ? `Open ${selected.size} PR${selected.size === 1 ? "" : "s"}, one per file`
                  : `Open cleanup PR (${selected.size} file${selected.size === 1 ? "" : "s"})`}
        </button>
        {armed ? (
          <button className="btn btn--quiet" onClick={() => setArmed(false)}>
            cancel
          </button>
        ) : null}
        <span className="why">requires write access to {repo.fullName}</span>
      </div>

      {response?.outcomes?.length ? (
        <div className="banner" style={{ borderLeftColor: "var(--ok)" }}>
          <span className="mark" style={{ color: "var(--ok)" }}>
            ✓
          </span>
          <span>
            {response.mode === "direct" ? (
              <>
                Committed{" "}
                <code>{response.outcomes[0].commitSha.slice(0, 7)}</code> directly
                to <b>{response.outcomes[0].branch}</b> (
                {response.outcomes[0].files.length} file
                {response.outcomes[0].files.length === 1 ? "" : "s"}). There was no
                review step — check the repo now, and revert that commit if it is
                not what you expected.
              </>
            ) : (
              <>
                Opened{" "}
                {response.outcomes.map((o, i) => (
                  <span key={o.branch}>
                    {i > 0 ? ", " : ""}
                    <a
                      href={o.pullRequestUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      #{o.pullRequestNumber}
                    </a>
                    {response.perFile ? ` (${o.files[0]})` : ""}
                  </span>
                ))}
                . Read the diff before merging — this removes matched lines only,
                and proves nothing about what the rules did not catch.
              </>
            )}
          </span>
        </div>
      ) : null}

      {response?.error ? (
        <div className="banner banner--err">
          <span className="mark">✕</span>
          <span>{response.error}</span>
        </div>
      ) : null}

      {response?.dirPlans?.length ? (
        <div className="fixlist" style={{ marginTop: 10 }}>
          {response.dirPlans.map((d) => (
            <div className="fixrow" key={d.dir}>
              <span
                className="mark"
                style={{ color: d.ok ? "var(--ok)" : "var(--warn)" }}
              >
                {d.ok ? "✓" : "!"}
              </span>
              <span className="p">{d.dir}/</span>
              <span className="why">
                {d.ok
                  ? `${d.files.length} file${d.files.length === 1 ? "" : "s"} removed — ${d.justification ?? ""}`
                  : d.reason}
              </span>
            </div>
          ))}
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

      {stats.assetsChecked > 0 ? (
        <div className="sect sect--tight">
          <div className="facts">
            <span style={{ color: "var(--faint)" }}>assets:</span>
            <span>
              header-checked <b>{stats.assetsChecked}</b>
            </span>
            <span style={{ color: stats.assetMismatches > 0 ? "var(--err)" : undefined }}>
              mismatched <b>{stats.assetMismatches}</b>
            </span>
            {stats.assetsSkipped > 0 ? (
              <span>
                over the asset cap <b>{stats.assetsSkipped}</b>
              </span>
            ) : null}
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
