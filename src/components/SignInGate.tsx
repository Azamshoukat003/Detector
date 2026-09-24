"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import DemoConsole from "@/components/DemoConsole";

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
          <h1>Detector</h1>
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

      <section>
        <DemoConsole />
        <p className="gate-foot" style={{ marginTop: 12 }}>
          A demo. The console runs in your browser over a fixed command list —
          it reaches no server and touches no repository.
        </p>
      </section>

    </main>
  );
}
