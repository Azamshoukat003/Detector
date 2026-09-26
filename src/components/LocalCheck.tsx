"use client";

import { useEffect, useState } from "react";

interface LocalHit {
  kind: "dropped-file" | "gitignore-entry" | "autorun-task";
  path: string;
  size?: number;
  modified?: string;
  lines?: { line: number; text: string }[];
}

interface LocalScanResult {
  root: string;
  hits: LocalHit[];
  stats: {
    dirsVisited: number;
    filesVisited: number;
    gitignoresRead: number;
    autorunConfigsRead?: number;
    durationMs: number;
    truncated: boolean;
    truncatedBy?: string;
  };
  error?: string;
}

interface Capability {
  enabled: boolean;
  defaultRoot?: string;
  watching?: readonly string[];
  reason?: string;
}

function humanBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function LocalCheck({ onClose }: { onClose: () => void }) {
  const [cap, setCap] = useState<Capability | null>(null);
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LocalScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/local-scan");
        const data = (await res.json()) as Capability;
        if (cancelled) return;
        setCap(data);
        if (data.defaultRoot) setRoot(data.defaultRoot);
      } catch {
        if (!cancelled) setCap({ enabled: false, reason: "Could not reach the API." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/local-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      const data = (await res.json()) as LocalScanResult;
      if (!res.ok) setError(data.error ?? `Local scan failed (${res.status}).`);
      else setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Local scan request failed.");
    } finally {
      setBusy(false);
    }
  };

  const autorun = result?.hits.filter((h) => h.kind === "autorun-task") ?? [];
  const droppedFiles = result?.hits.filter((h) => h.kind === "dropped-file") ?? [];
  const gitignoreHits = result?.hits.filter((h) => h.kind === "gitignore-entry") ?? [];

  return (
    <div className="detail" style={{ marginTop: 18 }}>
      <div className="sect">
        <div className="sect-head">
          <span className="sect-title">Local check — dropper artifacts on this machine</span>
          <span className="sect-rule" />
          <button className="btn btn--quiet" onClick={onClose}>
            close
          </button>
        </div>

        <p className="hint" style={{ marginTop: 0 }}>
          Walks a folder on the machine running Detector and reports two things:
          .vscode / .devcontainer config that runs a command on folder open,
          files named{" "}
          <b>{(cap?.watching ?? []).join(", ") || "the known dropper artifacts"}</b>,
          and any <b>.gitignore</b> line that names one of them. It reads nothing
          else and sends nothing anywhere.
        </p>

        {cap && !cap.enabled ? (
          <div className="banner">
            <span className="mark">!</span>
            <span>{cap.reason}</span>
          </div>
        ) : null}

        <div className="fixbar">
          <div className="field" style={{ flex: "1 1 380px", minWidth: 260 }}>
            <span className="glyph">/</span>
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="C:\Users\you\projects"
              spellCheck={false}
              disabled={busy || cap?.enabled === false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && root.trim() && !busy) void run();
              }}
            />
          </div>
          <button
            className="btn btn--solid"
            onClick={() => void run()}
            disabled={busy || !root.trim() || cap?.enabled === false}
          >
            {busy ? "walking…" : "Run local check"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="sect sect--tight">
          <div className="banner banner--err" style={{ margin: 0 }}>
            <span className="mark">✕</span>
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      {result ? (
        <>
          <div className="sect sect--tight">
            <div className="facts">
              <span>
                root <b>{result.root}</b>
              </span>
              <span>
                walked <b>{result.stats.dirsVisited}</b> dirs /{" "}
                <b>{result.stats.filesVisited}</b> files
              </span>
              <span>
                .gitignore read <b>{result.stats.gitignoresRead}</b>
              </span>
              <span>
                took <b>{(result.stats.durationMs / 1000).toFixed(1)}s</b>
              </span>
            </div>
            {result.stats.truncated ? (
              <p className="hint">
                Walk stopped early ({result.stats.truncatedBy} limit) — this is a
                partial result. Point it at a narrower folder for full coverage.
              </p>
            ) : null}
          </div>

          <div className="sect">
            <div className="sect-head">
              <span className="sect-title">
                Editor config that executes on folder open
                {autorun.length ? ` · ${autorun.length}` : ""}
              </span>
              <span className="sect-rule" />
            </div>
            {autorun.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No .vscode or .devcontainer config under this folder runs a
                command automatically.
              </p>
            ) : (
              autorun.map((h) => (
                <div className="finding finding--ERROR" key={h.path}>
                  <div className="finding-top">
                    <span className="sev sev--ERROR">ERROR</span>
                    <span className="rule-id">vscode-autorun-task</span>
                    <span className="loc">{h.path}</span>
                  </div>
                  <div className="finding-body">
                    <p className="finding-msg">
                      This runs the moment the folder is opened in an editor.
                      Read the command before opening this project again.
                    </p>
                    {(h.lines ?? []).map((l) => (
                      <div className="hunk" key={l.line}>
                        <div className="gutter">{l.line}</div>
                        <pre className="code">{l.text}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="sect">
            <div className="sect-head">
              <span className="sect-title">
                Dropper files on disk{droppedFiles.length ? ` · ${droppedFiles.length}` : ""}
              </span>
              <span className="sect-rule" />
            </div>
            {droppedFiles.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                None found under this folder.
              </p>
            ) : (
              <div className="fixlist">
                {droppedFiles.map((h) => (
                  <div className="fixrow" key={h.path}>
                    <span className="mark" style={{ color: "var(--err)" }}>
                      ✕
                    </span>
                    <span className="p">{h.path}</span>
                    <span className="why">
                      {humanBytes(h.size)}
                      {h.modified
                        ? ` · ${new Date(h.modified).toLocaleString()}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sect">
            <div className="sect-head">
              <span className="sect-title">
                .gitignore entries hiding them
                {gitignoreHits.length ? ` · ${gitignoreHits.length}` : ""}
              </span>
              <span className="sect-rule" />
            </div>
            {gitignoreHits.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No .gitignore under this folder names one of these files.
              </p>
            ) : (
              gitignoreHits.map((h) => (
                <div className="finding finding--ERROR" key={h.path}>
                  <div className="finding-top">
                    <span className="sev sev--ERROR">ERROR</span>
                    <span className="rule-id">gitignore-hides-dropped-payload</span>
                    <span className="loc">{h.path}</span>
                  </div>
                  <div className="finding-body">
                    <p className="finding-msg">
                      Remove these lines. They exist to keep the dropped files out
                      of <code>git status</code> so nobody notices them.
                    </p>
                    {(h.lines ?? []).map((l) => (
                      <div className="hunk" key={l.line}>
                        <div className="gutter">{l.line}</div>
                        <pre className="code">{l.text}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
