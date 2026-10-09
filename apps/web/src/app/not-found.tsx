import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="page-loading">
      <h1>This page isn’t in the ledger.</h1>
      <Link href="/">Return to overview →</Link>
    </main>
  );
}
