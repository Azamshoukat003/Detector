"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The pre-auth showcase: a carousel of the three injection shapes this tool was
 * built against, plus a console you can actually type into.
 *
 * The console is deliberately NOT a shell. It runs entirely in the browser over
 * a fixed command table and never contacts the server — see the note in
 * SignInGate. A pre-authentication page on a security tool is the last place
 * that should be able to execute anything.
 */

type Severity = "ERROR" | "WARNING";

interface DemoFinding {
  severity: Severity;
  rule: string;
  loc: string;
  message: string;
  /** Optional code/hex excerpt shown in a gutter block. */
  gutter?: string;
  code?: string;
}

interface Slide {
  id: string;
  tab: string;
  title: string;
  /** One-line explanation of the technique. */
  caption: string;
  /**
   * Exactly one detailed finding per slide. Keeping the shape identical across
   * slides is what lets the panel hold a fixed height without either jumping
   * or hiding content behind a scrollbar.
   */
  finding: DemoFinding;
  /** Other rules the same file trips, shown as a single compact row. */
  also?: { severity: Severity; rule: string }[];
}

const OBFUSCATED =
  'global.i="A10-*870";const _0x499797=_0x1574;(function(_0x50cf58,_0x4b5935){while(!![]){try{';

export const SLIDES: Slide[] = [
  {
    id: "global",
    tab: "global",
    title: "acme/storefront — postcss.config.js",
    caption:
      "Appended to the same line as the closing }; so the diff reads as one changed line.",
    finding: {
      severity: "ERROR",
      rule: "obfuscator-string-array-rotator",
      loc: "postcss.config.js:10",
      message:
        "javascript-obfuscator string-array rotation idiom — deliberately obfuscated code.",
      gutter: "10",
      code: "};" + OBFUSCATED,
    },
    also: [{ severity: "WARNING", rule: "hex-identifier-obfuscation-density" }],
  },
  {
    id: "gitignore",
    tab: ".gitignore",
    title: "acme/storefront — .gitignore",
    caption:
      "The dropped files are added to .gitignore so they never appear in git status or a review.",
    finding: {
      severity: "ERROR",
      rule: "gitignore-hides-dropped-payload",
      loc: ".gitignore:3-5",
      message:
        "These entries name known dropper artifacts. Hiding them from git status is how the payload survives.",
      gutter: "3\n4\n5",
      code: "branch_structure.json\ntemp_auto_push.bat\ntemp_interactive_push.bat",
    },
  },
  {
    id: "fonts",
    tab: "fonts",
    title: "acme/storefront — public/fonts/",
    caption:
      "A payload renamed to .woff2 and parked beside real webfonts. Nobody reviews a font in a diff.",
    finding: {
      severity: "ERROR",
      rule: "asset-extension-content-mismatch",
      loc: "public/fonts/fa-solid-400.woff2",
      message:
        "Claims a WOFF2 font, but the bytes are JavaScript. A real WOFF2 starts with wOF2.",
      gutter: "hex",
      code: '63 6f 6e 73 74 20 5f 30 78 34 39 39   "const _0x499"',
    },
    also: [{ severity: "ERROR", rule: "known-dropper-file-present" }],
  },
];

const ROTATE_MS = 7000;

/**
 * Slide transition. Change this one value to try another:
 *
 *   "scan"      CRT repaint — the panel redraws top-to-bottom behind a
 *               scanline and the findings print in sequence. The default,
 *               because it reads as the tool *printing a result* rather than
 *               a slideshow advancing, which is the whole aesthetic.
 *   "dissolve"  true cross-dissolve; both slides are on screen at once.
 *   "black"     fade down to the panel ground, then back up.
 *   "glitch"    channel-split and slice jitter. On-theme, but it is the one
 *               that will look dated first.
 */
const TRANSITION: "scan" | "dissolve" | "black" | "glitch" = "scan";

/**
 * How long the outgoing slide stays mounted. Must be >= the longest exit
 * animation in the stylesheet across every mode ("black" is the longest at
 * 460ms, since it fades down and back up in sequence).
 */
const FX_MS = 460;

interface Line {
  kind: "in" | "out" | "err";
  text: string;
}

const BANNER: Line[] = [
  { kind: "out", text: "Detector demo console — type `help` for commands." },
];

/** One slide's contents. Split out so both layers can render it during a swap. */
function SlideBody({ slide }: { slide: Slide }) {
  const f = slide.finding;
  return (
    <>
      <p className="console-caption">{slide.caption}</p>

      <div className={`finding finding--${f.severity}`}>
        <div className="finding-top">
          <span className={`sev sev--${f.severity}`}>{f.severity}</span>
          <span className="rule-id">{f.rule}</span>
          <span className="loc">{f.loc}</span>
        </div>
        <div className="finding-body">
          <p className="finding-msg">{f.message}</p>
          {f.code ? (
            <div className="hunk">
              <div className="gutter">{f.gutter}</div>
              <pre className="code">{f.code}</pre>
            </div>
          ) : null}
        </div>
      </div>

      {/* Secondary rules as one compact line, so every slide is the same
          height whatever it matched. */}
      <div className="console-also">
        {slide.also?.length ? (
          <>
            <span className="label">also matched</span>
            {slide.also.map((a) => (
              <span className="pair" key={a.rule}>
                <span className={`dotsev dotsev--${a.severity}`} aria-hidden />
                {a.rule}
              </span>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

export default function DemoConsole() {
  const [active, setActive] = useState(0);
  // The outgoing slide stays mounted for the length of the transition, which
  // is what makes a real cross-dissolve possible rather than a fade-through.
  const [prev, setPrev] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState<Line[]>(BANNER);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [focused, setFocused] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const slide = SLIDES[active];

  /** Switch slides, keeping the old one mounted so it can animate out. */
  const go = useCallback((next: number) => {
    setActive((current) => {
      if (next === current) return current;
      setPrev(current);
      return next;
    });
  }, []);

  // Retire the outgoing slide once its exit animation has finished.
  useEffect(() => {
    if (prev === null) return;
    const t = setTimeout(() => setPrev(null), FX_MS);
    return () => clearTimeout(t);
  }, [prev, active]);

  // Keep the current index in a ref so the interval below never restarts on
  // every slide change — restarting it would reset the dwell time.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Auto-advance, unless the visitor is interacting or has asked for less
  // motion.
  useEffect(() => {
    if (paused) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => {
      go((activeRef.current + 1) % SLIDES.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [paused, go]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const say = useCallback((out: Line[]) => setLines((prev) => [...prev, ...out]), []);

  const run = useCallback(
    (raw: string) => {
      const cmd = raw.trim();
      if (cmd === "") return;
      setLines((prev) => [...prev, { kind: "in", text: cmd }]);
      setHistory((h) => [cmd, ...h].slice(0, 30));
      setHistIdx(-1);

      const [verb] = cmd.toLowerCase().split(/\s+/);

      switch (verb) {
        case "help":
          say([
            { kind: "out", text: "commands" },
            { kind: "out", text: "  help        this list" },
            { kind: "out", text: "  rules       the detection rules that ship today" },
            { kind: "out", text: "  global      show the postcss injection" },
            { kind: "out", text: "  gitignore   show the .gitignore entries" },
            { kind: "out", text: "  fonts       show the disguised webfont" },
            { kind: "out", text: "  scan        replay a sample scan" },
            { kind: "out", text: "  about       what this tool does" },
            { kind: "out", text: "  clear       clear the console" },
          ]);
          break;
        case "rules":
          say([
            { kind: "out", text: "obfuscator-string-array-rotator      ERROR" },
            { kind: "out", text: "hex-identifier-obfuscation-density   WARNING" },
            { kind: "out", text: "spawn-interpreter-inline-code        ERROR" },
            { kind: "out", text: "eval-of-dynamic-string               ERROR" },
            { kind: "out", text: "blockchain-rpc-plus-exec             ERROR" },
            { kind: "out", text: "forced-git-push                      WARNING" },
            { kind: "out", text: "pipe-download-to-shell               ERROR" },
            { kind: "out", text: "gitignore-hides-dropped-payload      ERROR" },
            { kind: "out", text: "known-dropper-file-present           ERROR" },
            { kind: "out", text: "asset-extension-content-mismatch     ERROR" },
            { kind: "out", text: "svg-embedded-script                  ERROR" },
          ]);
          break;
        case "global":
        case "gitignore":
        case "fonts": {
          const i = SLIDES.findIndex((s) => s.id === verb);
          go(i);
          setPaused(true);
          say([{ kind: "out", text: `showing: ${SLIDES[i].title}` }]);
          break;
        }
        case "scan":
          say([
            { kind: "out", text: "scanning acme/storefront on main…" },
            { kind: "out", text: "  184 files scanned · 41 assets header-checked" },
            { kind: "out", text: "  3 ERROR · 1 WARNING across 3 files" },
            { kind: "out", text: "  force-push blocked: no   PR reviews required: no" },
            { kind: "out", text: "sign in to run this against your own repositories." },
          ]);
          break;
        case "about":
          say([
            {
              kind: "out",
              text: "Detector watches your GitHub repos for force-pushes and for",
            },
            {
              kind: "out",
              text: "obfuscated payloads hidden in build config, .gitignore and assets.",
            },
            { kind: "out", text: "No database. Nothing is stored between page loads." },
          ]);
          break;
        case "clear":
          setLines(BANNER);
          break;
        default:
          say([
            { kind: "err", text: `unknown command: ${verb}` },
            { kind: "out", text: "try `help`" },
          ]);
      }
    },
    [say],
  );

  return (
    <div
      className="console"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
    >
      <div className="console-bar">
        {/* Three lamps, three slides — they double as the position indicator. */}
        {SLIDES.map((s, i) => (
          <span
            key={s.id}
            className={`lamp${i === active ? " lamp--on" : ""}`}
            aria-hidden
          />
        ))}
        <span className="console-title">{slide.title}</span>
      </div>

      <div className="console-tabs" role="tablist" aria-label="Attack examples">
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={i === active}
            onClick={() => {
              go(i);
              setPaused(true);
            }}
          >
            <span className="idx">{String(i + 1).padStart(2, "0")}</span>
            {s.tab}
          </button>
        ))}
        <span className="grow" />
        {!paused ? <span className="rotating">auto</span> : null}
      </div>

      <div className={`console-stage fx-${TRANSITION}`}>
        {/* Outgoing slide, kept mounted only while it animates out. */}
        {prev !== null ? (
          <div className="console-slide is-leaving" key={`out-${prev}`} aria-hidden>
            <SlideBody slide={SLIDES[prev]} />
          </div>
        ) : null}

        <div
          className={`console-slide${prev !== null ? " is-entering" : ""}`}
          key={`in-${active}`}
          role="tabpanel"
          aria-live="polite"
        >
          <SlideBody slide={slide} />
        </div>
      </div>

      <div className="console-log" ref={logRef}>
        {lines.map((l, i) => (
          <div className={`cline cline--${l.kind}`} key={i}>
            {l.kind === "in" ? <span className="prompt">&gt;</span> : null}
            <span>{l.text}</span>
          </div>
        ))}
      </div>

      <form
        className="console-input"
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
          setInput("");
        }}
      >
        <span className="prompt">&gt;</span>
        {/* Idle block cursor. Hidden on focus so it never sits alongside the
            browser's own caret. */}
        {!focused ? <span className="caret" aria-hidden /> : null}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="type help"
          spellCheck={false}
          autoComplete="off"
          aria-label="Demo console input"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.min(histIdx + 1, history.length - 1);
              if (next >= 0) {
                setHistIdx(next);
                setInput(history[next]);
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = histIdx - 1;
              setHistIdx(next);
              setInput(next >= 0 ? history[next] : "");
            }
          }}
        />
      </form>
    </div>
  );
}
