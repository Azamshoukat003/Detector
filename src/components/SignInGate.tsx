"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

const CAPABILITIES = [
  {
    title: "On-demand repo scan",
    body: "Seven regex rules over the default branch, plus build-config files that malware rewrites to survive a reinstall.",
  },
  {
    title: "Branch protection audit",
    body: "Whether the default branch requires reviews and blocks force-pushes — the controls that actually stop this attack.",
  },
  {
    title: "Real-time force-push alert",
    body: "A signed webhook fires to Discord or Slack the moment a push arrives with forced = true.",
  },
];

export default function SignInGate() {
  const [pending, setPending] = useState(false);

  return (
    <main className="gate">
      <section>
        <div className="gate-brand">
          <span className="block" aria-hidden />
          <h1>repo-guard</h1>
        </div>

        <p className="lede">
          Force-push and obfuscated-payload monitoring for the GitHub
          repositories your account can reach.
        </p>

        <ul className="caps">
          {CAPABILITIES.map((cap, i) => (
            <li key={cap.title}>
              <span className="idx">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <b>{cap.title}</b> — {cap.body}
              </span>
            </li>
          ))}
        </ul>

        <div className="warnbox">
          <div className="sect-title">Before you sign in</div>
          <p>
            This app requests the <code>repo</code> OAuth scope, which grants read
            access to the contents of your <b>private</b> repositories, and to
            private repos of any organisation that has approved it. GitHub offers
            no narrower scope that can read private file contents. Only sign in
            with an account you are comfortable granting that to — and if the
            account you suspect is compromised, sign in as yourself instead and
            scan the shared repos from there.
          </p>
        </div>

        <button
          className="btn btn--solid"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void signIn("github");
          }}
        >
          {pending ? "redirecting to GitHub…" : "Sign in with GitHub"}
        </button>

        <p className="gate-foot">
          Revoke any time under GitHub → Settings → Applications → Authorized
          OAuth Apps. No database: nothing you scan is stored anywhere.
        </p>
      </section>

      <section aria-hidden>
        <div className="preview">
          <div className="preview-bar">
            <span className="lamp" />
            <span className="lamp" />
            <span className="lamp" />
            <span className="title">acme/storefront — scan</span>
          </div>
          <div className="preview-body">
            <div className="preview-line">
              <span className="prompt">&gt;</span>
              <span style={{ color: "var(--dim)" }}>
                scanned 184 files on <b style={{ color: "var(--text)" }}>main</b>
              </span>
            </div>

            <div className="finding finding--ERROR" style={{ marginTop: 10 }}>
              <div className="finding-top">
                <span className="sev sev--ERROR">ERROR</span>
                <span className="rule-id">obfuscator-string-array-rotator</span>
                <span className="loc">
                  postcss.config.js<span className="ln">:1</span>
                </span>
              </div>
              <div className="finding-body">
                <p className="finding-msg">
                  javascript-obfuscator string-array rotation idiom detected.
                </p>
                <div className="hunk">
                  <div className="gutter">1</div>
                  <pre className="code">
                    {"(function(_0x3a1f,_0x4b2c){while(!![]){try{"}
                  </pre>
                </div>
              </div>
            </div>

            <div className="finding finding--WARNING">
              <div className="finding-top">
                <span className="sev sev--WARNING">WARNING</span>
                <span className="rule-id">forced-git-push</span>
                <span className="loc">
                  scripts/deploy.sh<span className="ln">:42</span>
                </span>
              </div>
              <div className="finding-body">
                <p className="finding-msg">
                  Script contains a forced git push command.
                </p>
              </div>
            </div>

            <div className="preview-line" style={{ marginTop: 6 }}>
              <span className="prompt">&gt;</span>
              <span className="cursor" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
