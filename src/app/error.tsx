"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Without one, an unhandled render error shows
 * Next's default page — which is not something a security tool should ever
 * hand a user in place of its own UI.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[detector] render error:", error);
  }, [error]);

  return (
    <main className="gate">
      <section className="gate-card">
        <div className="gate-brand">
          <span className="block" aria-hidden />
          <h1>Detector</h1>
        </div>
        <p className="lede">Something broke while rendering this page.</p>

        <div className="banner banner--err">
          <span className="mark">✕</span>
          <span>
            {error.message || "Unknown error."}
            {error.digest ? (
              <>
                {" "}
                <span className="mono" style={{ color: "var(--faint)" }}>
                  ({error.digest})
                </span>
              </>
            ) : null}
          </span>
        </div>

        <div className="fixbar">
          <button className="btn btn--solid" onClick={reset}>
            Try again
          </button>
          <a className="btn" href="/">
            Back to repositories
          </a>
        </div>

        <p className="gate-foot">
          Nothing was written to any repository — Detector only writes when you
          click a remediation button.
        </p>
      </section>
    </main>
  );
}
