export default function Loading() {
  return (
    <main id="main-content" tabIndex={-1} className="page-loading" aria-busy="true">
      <span className="brand">
        recora<span>®</span>
      </span>
      <p>Opening your ledger…</p>
    </main>
  );
}
