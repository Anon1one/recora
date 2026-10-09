import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const base = new URL(process.env.APP_ORIGIN || "http://localhost:3000").origin;
assert(
  ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
  "API smoke tests are local-only",
);
const wallet = Keypair.generate();
let cookie = "";
async function call(
  path: string,
  method = "GET",
  data?: unknown,
  requestOrigin = base,
) {
  const result = await fetch(`${base}/api/${path}`, {
    method,
    headers: {
      origin: requestOrigin,
      ...(data ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: result.status,
    data: await result.json(),
    cookie: result.headers.get("set-cookie"),
  };
}
try {
  assert.equal((await call("session")).status, 401);
  assert.equal(
    (
      await call(
        "auth/challenge",
        "POST",
        { wallet: wallet.publicKey.toBase58() },
        "https://foreign.example",
      )
    ).status,
    403,
  );
  const challenge = await call("auth/challenge", "POST", {
    wallet: wallet.publicKey.toBase58(),
  });
  assert.equal(challenge.status, 200);
  assert.equal(
    (
      await call("auth/verify", "POST", {
        id: challenge.data.id,
        signature: Buffer.alloc(64).toString("base64"),
      })
    ).status,
    401,
  );
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(challenge.data.message), wallet.secretKey),
  ).toString("base64");
  const verified = await call("auth/verify", "POST", {
    id: challenge.data.id,
    signature,
  });
  assert.equal(verified.status, 200);
  assert(verified.cookie?.includes("HttpOnly"));
  assert(verified.cookie?.includes("SameSite=strict"));
  cookie = verified.cookie!.split(";")[0];
  assert.equal(
    (await call("auth/verify", "POST", { id: challenge.data.id, signature }))
      .status,
    401,
  );
  assert.equal(
    (await call("session")).data.wallet,
    wallet.publicKey.toBase58(),
  );
  assert.deepEqual((await call("subscriptions")).data.items, []);
  assert.equal(
    (
      await call("tx/subscribe", "POST", {
        plan: wallet.publicKey.toBase58(),
        nCycles: "0",
      })
    ).status,
    400,
  );
  const network = await call("network");
  assert.equal(network.status, 200);
  assert(
    !JSON.stringify(network.data).includes(
      process.env.HELIUS_API_KEY || "unlikely-key-value",
    ),
  );
  assert.equal((await call("auth/logout", "POST", {})).status, 200);
  assert.equal((await call("session")).status, 401);
  console.log(
    "Live API smoke test passed: origin protection, signature verification, challenge replay rejection, secure sessions, authorized reads, builder validation, server-only RPC key, and logout.",
  );
} finally {
  if (cookie) await call("auth/logout", "POST", {}).catch(() => {});
}
