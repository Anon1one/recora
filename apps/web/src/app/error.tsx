"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" tabIndex={-1} className="page-loading">
      <h1>Let’s try that again.</h1>
      <p>The page couldn’t load.</p>
      <button onClick={reset}>Reload</button>
    </main>
  );
}
