"use client";

import { useState } from "react";
import type { BranchReport, BranchSweepResult, RepoListItem } from "@/lib/scan-types";

type Pending = Record<string, "idle" | "confirm" | "deleting" | "gone" | "failed">;

const PILL: Record<BranchReport["status"], { cls: string; text: string }> = {
  infected: { cls: "pill--err", text: "infected" },
  clean: { cls: "pill--ok", text: "clean" },
  error: { cls: "pill--warn", text: "error" },
  skipped: { cls: "pill--idle", text: "skipped" },
  default: { cls: "pill--idle", text: "default" },
};

export default function BranchSweep({ repo }: { repo: RepoListItem }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BranchSweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const [bulkArmed, setBulkArmed] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const sweep = async () => {
    setBusy(true);
    setError(null);
    setPending({});
    setBulkArmed(false);
    try {
      const res = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
          defaultBranch: repo.defaultBranch,
        }),
      });
      const data = (await res.json()) as BranchSweepResult & { error?: string };
      if (!res.ok) setError(data.error ?? `Branch sweep failed (${res.status}).`);
      else setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Branch sweep request failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setPending((p) => ({ ...p, [name]: "deleting" }));
    try {
      const res = await fetch("/api/branches", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.name,
          branch: name,
          defaultBranch: repo.defaultBranch,
        }),
      });
      const data = (await res.json()) as { deleted?: string; error?: string };
      if (!res.ok) {
        setPending((p) => ({ ...p, [name]: "failed" }));
        setNotes((n) => ({ ...n, [name]: data.error ?? `Failed (${res.status}).` }));
        return false;
      }
      setPending((p) => ({ ...p, [name]: "gone" }));
      return true;
    } catch (err) {
      setPending((p) => ({ ...p, [name]: "failed" }));
      setNotes((n) => ({
        ...n,
        [name]: err instanceof Error ? err.message : "Request failed.",
      }));
      return false;
    }
  };

  const deletable = (b: BranchReport) =>
    !b.isDefault && !b.protectedBranch && pending[b.name] !== "gone";

  const infected = result?.branches.filter((b) => b.status === "infected") ?? [];
  const bulkTargets = infected.filter(deletable);

  const deleteAllInfected = async () => {
    if (!bulkArmed) {
      setBulkArmed(true);
      return;
    }
    setBulkArmed(false);
    for (const b of bulkTargets) {
      // Sequential: a burst of deletes is the one thing you cannot undo quickly.
      await remove(b.name);
    }
  };

  return (
    <div className="detail" style={{ marginTop: 12 }}>
      <div className="sect">
        <div className="sect-head">
          <span className="sect-title">Branches</span>
          <span className="sect-rule" />
          <button className="btn btn--solid" onClick={() => void sweep()} disabled={busy}>
            {busy ? "sweeping…" : result ? "re-sweep" : "sweep branches"}
          </button>
        </div>

        <p className="hint" style={{ marginTop: 0 }}>
          Compares every branch against <b>{repo.defaultBranch}</b> and scans only
          what merging it would bring in — config files and dropper artifacts
          first. A branch that still carries the payload re-infects the default
          branch the moment its PR is merged, which is why cleaning the default
          branch alone never sticks.
        </p>

        {result ? (
          <div className="facts" style={{ marginTop: 10 }}>
            <span>
              <b>{result.stats.total}</b> branches
            </span>
            <span>
              swept <b>{result.stats.swept}</b>
            </span>
            <span style={{ color: result.stats.infected > 0 ? "var(--err)" : undefined }}>
              infected <b>{result.stats.infected}</b>
            </span>
            <span>
              took <b>{(result.stats.durationMs / 1000).toFixed(1)}s</b>
            </span>
          </div>
        ) : null}

        {result?.stats.truncated ? (
          <p className="hint">
            The sweep hit a cap — some branches were not fully checked. Re-run to
            cover the rest.
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="sect sect--tight">
          <div className="banner banner--err" style={{ margin: 0 }}>
            <span className="mark">✕</span>
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      {result && bulkTargets.length > 0 ? (
        <div className="sect sect--tight">
          <div className="fixbar" style={{ marginTop: 0 }}>
            <button
              className={`btn ${bulkArmed ? "btn--danger" : ""}`}
              onClick={() => void deleteAllInfected()}
            >
              {bulkArmed
                ? `confirm — delete ${bulkTargets.length} branch${bulkTargets.length === 1 ? "" : "es"}`
                : `delete all ${bulkTargets.length} infected branches`}
            </button>
            {bulkArmed ? (
              <button className="btn btn--quiet" onClick={() => setBulkArmed(false)}>
                cancel
              </button>
            ) : null}
            <span className="why">
              deletion is permanent — the default branch and protected branches are
              never touched
            </span>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="sect">
          <div className="fixlist">
            {result.branches.map((b) => {
              const state = pending[b.name] ?? "idle";
              const pill = PILL[b.status];
              return (
                <div
                  className="fixrow"
                  key={b.name}
                  style={{
                    cursor: "default",
                    opacity: state === "gone" ? 0.45 : 1,
                  }}
                >
                  <span className={`pill ${pill.cls}`}>{pill.text}</span>
                  <span className="p">{b.name}</span>
                  {b.protectedBranch ? <span className="chip">protected</span> : null}

                  <span className="why">
                    {state === "gone" ? (
                      <span style={{ color: "var(--ok)" }}>deleted</span>
                    ) : b.status === "infected" ? (
                      <>
                        {b.errors}E {b.warnings}W · {b.files.join(", ")}
                      </>
                    ) : b.reason ? (
                      b.reason
                    ) : b.aheadBy !== null ? (
                      `${b.aheadBy} ahead · ${b.scannedFiles}/${b.changedFiles} files scanned`
                    ) : (
                      ""
                    )}
                  </span>

                  {deletable(b) ? (
                    state === "confirm" ? (
                      <>
                        <button
                          className="btn btn--danger"
                          onClick={() => void remove(b.name)}
                        >
                          confirm delete
                        </button>
                        <button
                          className="btn btn--quiet"
                          onClick={() =>
                            setPending((p) => ({ ...p, [b.name]: "idle" }))
                          }
                        >
                          cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn"
                        disabled={state === "deleting"}
                        onClick={() =>
                          setPending((p) => ({ ...p, [b.name]: "confirm" }))
                        }
                      >
                        {state === "deleting" ? "deleting…" : "delete"}
                      </button>
                    )
                  ) : null}

                  {notes[b.name] ? (
                    <span className="why" style={{ color: "var(--err)" }}>
                      {notes[b.name]}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>

          {infected.length > 0 ? (
            <p className="hint">
              Deleting a branch does not rewrite history that is already merged.
              If the payload reached <b>{repo.defaultBranch}</b> through a merge,
              run a scan and open a cleanup PR for it as well.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
