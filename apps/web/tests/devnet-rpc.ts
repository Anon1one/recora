import { setTimeout as sleep } from "node:timers/promises";

// Share a single paced request stream across builders, SPL helpers and the
// indexer. Retries resend the same signed bytes rather than creating a new tx.
export function paceDevnetRpc(endpoint: string) {
  const original = globalThis.fetch;
  let tail: Promise<unknown> = Promise.resolve(), last = 0, requests = 0, retries = 0;
  globalThis.fetch = (input, init) => {
    if (String(input) !== endpoint) return original(input, init);
    const run = tail.then(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(Math.max(0, 750 - (Date.now() - last)));
        last = Date.now(); requests++;
        const response = await original(input, { ...init, signal: AbortSignal.timeout(15_000) });
        const body = response.ok ? await response.clone().json() : null;
        if (response.status !== 429 && response.status !== 503 && body?.error?.code !== -32005) return response;
        if (attempt === 5) throw new Error("Devnet RPC rate limit persisted after six paced attempts");
        retries++;
        const retryAfter = Number(response.headers.get("retry-after")) || 0;
        await sleep(Math.min(30_000, Math.max(retryAfter * 1000, 2000 * 2 ** attempt)));
      }
      throw new Error("Devnet RPC unavailable");
    });
    tail = run.catch(() => {});
    return run;
  };
  return { restore() { globalThis.fetch = original; }, stats() { return { requests, retries }; } };
}
