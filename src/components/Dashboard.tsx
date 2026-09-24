"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import RepoRow, { type RepoScanState, type ScanStatus } from "@/components/RepoRow";
import LocalCheck from "@/components/LocalCheck";
import type { RepoListItem, ScanResult } from "@/lib/scan-types";

type ScanStates = Record<string, RepoScanState>;
type Lens = "all" | "flagged" | "clean" | "unscanned";
type Sort = "pushed" | "name" | "risk";

const IDLE: RepoScanState = { status: "idle", expanded: false };

const RISK_RANK: Record<ScanStatus, number> = {
  flagged: 0,
  error: 1,
  scanning: 2,
  clean: 3,
  idle: 4,
};

export default function Dashboard({
  login,
  avatarUrl,
}: {
  login: string;
  avatarUrl: string | null;
}) {
  const [repos, setRepos] = useState<RepoListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [states, setStates] = useState<ScanStates>({});
  const [query, setQuery] = useState("");
  const [lens, setLens] = useState<Lens>("all");
  const [sort, setSort] = useState<Sort>("pushed");
  const [sweeping, setSweeping] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const abortSweep = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/repos");
        const data = (await res.json()) as { repos?: RepoListItem[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setListError(data.error ?? `Failed to list repositories (${res.status}).`);
          return;
        }
        setRepos(data.repos ?? []);
      } catch (err) {
        if (!cancelled) {
          setListError(
            err instanceof Error ? err.message : "Failed to list repositories.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "/" focuses the filter, the way a pager would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && typing) {
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const patch = useCallback((key: string, next: Partial<RepoScanState>) => {
    setStates((prev) => ({ ...prev, [key]: { ...(prev[key] ?? IDLE), ...next } }));
  }, []);

  const scan = useCallback(
    async (repo: RepoListItem, autoExpand = true) => {
      const key = repo.fullName;
      patch(key, {
        status: "scanning",
        error: undefined,
        ...(autoExpand ? { expanded: true } : {}),
      });
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: repo.owner,
            repo: repo.name,
            branch: repo.defaultBranch,
          }),
        });
        const data = (await res.json()) as ScanResult & { error?: string };
        if (!res.ok) {
          patch(key, {
            status: "error",
            error: data.error ?? `Scan failed (${res.status}).`,
            result: undefined,
          });
          return;
        }
        patch(key, {
          status: data.findings.length > 0 ? "flagged" : "clean",
          result: data,
          error: undefined,
          ...(data.findings.length > 0 ? { expanded: true } : {}),
        });
      } catch (err) {
        patch(key, {
          status: "error",
          error: err instanceof Error ? err.message : "Scan request failed.",
        });
      }
    },
    [patch],
  );

  const visible = useMemo(() => {
    if (!repos) return [];
    const needle = query.trim().toLowerCase();
    const filtered = repos.filter((r) => {
      if (needle && !r.fullName.toLowerCase().includes(needle)) return false;
      const status = states[r.fullName]?.status ?? "idle";
      if (lens === "flagged") return status === "flagged";
      if (lens === "clean") return status === "clean";
      if (lens === "unscanned") return status === "idle";
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.fullName.localeCompare(b.fullName);
      if (sort === "risk") {
        const ra = RISK_RANK[states[a.fullName]?.status ?? "idle"];
        const rb = RISK_RANK[states[b.fullName]?.status ?? "idle"];
        if (ra !== rb) return ra - rb;
      }
      return (
        new Date(b.pushedAt ?? 0).getTime() - new Date(a.pushedAt ?? 0).getTime()
      );
    });
  }, [repos, query, lens, sort, states]);

  const tally = useMemo(() => {
    const counts = { flagged: 0, clean: 0, error: 0, scanning: 0, idle: 0 };
    let errors = 0;
    let warnings = 0;
    for (const repo of repos ?? []) {
      const s = states[repo.fullName];
      counts[s?.status ?? "idle"]++;
      for (const f of s?.result?.findings ?? []) {
        if (f.severity === "ERROR") errors++;
        else warnings++;
      }
    }
    return { ...counts, errors, warnings, total: repos?.length ?? 0 };
  }, [repos, states]);

  const sweep = useCallback(async () => {
    if (sweeping) {
      abortSweep.current = true;
      return;
    }
    abortSweep.current = false;
    setSweeping(true);
    for (const repo of visible) {
      if (abortSweep.current) break;
      if (states[repo.fullName]?.status === "clean") continue;
      await scan(repo, false);
    }
    setSweeping(false);
  }, [sweeping, visible, states, scan]);

  const scanned = tally.clean + tally.flagged + tally.error;

  // Surface the count in the tab title, so a backgrounded sweep still tells
  // you it found something without you switching to it.
  useEffect(() => {
    document.title =
      tally.flagged > 0 ? `(${tally.flagged}) flagged · Detector` : "Detector";
  }, [tally.flagged]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="block" aria-hidden />
          Detector
        </div>
        <span className="divider" />
        <div className="crumbs">
          <span>
            <b>{tally.total}</b> repos
          </span>
          <span>·</span>
          <span>
            <b>{scanned}</b> scanned
          </span>
        </div>

        <span className="grow" />

        <div className="who">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : null}
          <span>{login}</span>
          <button className="btn btn--quiet" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="field" style={{ minWidth: 260 }}>
          <span className="glyph">/</span>
          <input
            ref={searchRef}
            placeholder="filter owner/repo"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter repositories"
          />
          {query ? (
            <button
              className="btn btn--quiet"
              style={{ padding: "2px 6px" }}
              onClick={() => setQuery("")}
            >
              ✕
            </button>
          ) : (
            <span className="kbd">/</span>
          )}
        </div>

        <div className="seg" role="group" aria-label="Status filter">
          {(
            [
              ["all", "all", tally.total],
              ["flagged", "flagged", tally.flagged],
              ["clean", "clean", tally.clean],
              ["unscanned", "unscanned", tally.idle],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              aria-pressed={lens === key}
              onClick={() => setLens(key)}
            >
              {label}
              <span className="count">{count}</span>
            </button>
          ))}
        </div>

        <div className="seg" role="group" aria-label="Sort order">
          {(
            [
              ["pushed", "recent"],
              ["risk", "risk"],
              ["name", "name"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} aria-pressed={sort === key} onClick={() => setSort(key)}>
              {label}
            </button>
          ))}
        </div>

        <span className="grow" />

        <button
          className="btn"
          aria-pressed={localOpen}
          onClick={() => setLocalOpen((v) => !v)}
        >
          {localOpen ? "hide local check" : "local check"}
        </button>

        <button
          className={`btn${sweeping ? " btn--danger" : ""}`}
          onClick={() => void sweep()}
          disabled={!repos || visible.length === 0}
        >
          {sweeping ? "stop sweep" : `scan ${visible.length} visible`}
        </button>
      </div>

      <main className="wrap">
        {/* Screen readers get sweep progress announced; sighted users see the
            dots and the pills. */}
        <div
          aria-live="polite"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          {sweeping
            ? `Sweeping. ${scanned} of ${tally.total} scanned, ${tally.flagged} flagged.`
            : scanned > 0
              ? `${scanned} scanned, ${tally.flagged} flagged.`
              : ""}
        </div>

        {localOpen ? <LocalCheck onClose={() => setLocalOpen(false)} /> : null}

        {tally.flagged > 0 ? (
          <div className="summary">
            <div className="cell">
              <span className="n err">{tally.errors}</span>
              <span className="lbl">errors</span>
            </div>
            <div className="cell">
              <span className="n warn">{tally.warnings}</span>
              <span className="lbl">warnings</span>
            </div>
            <div className="cell">
              <span className="n err">{tally.flagged}</span>
              <span className="lbl">repos flagged</span>
            </div>
            <div className="cell">
              <span className="n ok">{tally.clean}</span>
              <span className="lbl">clean</span>
            </div>
            <div className="cell">
              <span className="n idle">{tally.idle}</span>
              <span className="lbl">unscanned</span>
            </div>
          </div>
        ) : null}

        {listError ? (
          <div className="banner banner--err">
            <span className="mark">✕</span>
            <span>{listError}</span>
          </div>
        ) : null}

        {repos === null && !listError ? (
          <div className="ledger" aria-busy>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div className="skeleton" key={i}>
                <div />
                <div>
                  <div className="bar" style={{ width: `${34 + ((i * 13) % 30)}%` }} />
                  <div className="bar" style={{ width: `${18 + ((i * 7) % 22)}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {repos !== null && visible.length === 0 ? (
          <div className="blank">
            <div className="big">
              {repos.length === 0
                ? "no repositories visible to this token"
                : "no repositories match this view"}
            </div>
            <div className="small">
              {repos.length === 0
                ? "The repo scope grants access to what your account can read — check you signed in with the right account."
                : "Clear the filter or switch back to “all”."}
            </div>
          </div>
        ) : null}

        <div className="ledger">
          {visible.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              state={states[repo.fullName] ?? IDLE}
              onScan={() => void scan(repo)}
              onToggle={() =>
                patch(repo.fullName, {
                  expanded: !(states[repo.fullName]?.expanded ?? false),
                })
              }
            />
          ))}
        </div>
      </main>
    </div>
  );
}
