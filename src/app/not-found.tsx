import Link from "next/link";

export default function NotFound() {
  return (
    <main className="gate">
      <section className="gate-card">
        <div className="gate-brand">
          <span className="block" aria-hidden />
          <h1>Detector</h1>
        </div>
        <p className="lede">
          That page does not exist. Detector has a single screen — the repository
          ledger.
        </p>
        <Link className="btn btn--solid" href="/">
          Back to repositories
        </Link>
      </section>
    </main>
  );
}
