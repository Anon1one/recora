import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { address, createNoopSigner } from "@solana/kit";
import nacl from "tweetnacl";
import { recora } from "../src/lib/generated";
import {
  decodeEvents,
  eventName,
  jsonSafe,
  program,
  pda,
} from "../src/lib/codec";
import { analytics, project, type StoredEvent } from "../src/lib/projector";
import {
  validWalletSignature,
  sameOrigin,
  merchantAccess,
} from "../src/lib/auth";
import {
  encrypt,
  decrypt,
  publicAddress,
  signature,
  equal,
  destination,
} from "../src/lib/security";
import { actionSchemas, legacyInstruction } from "../src/lib/transactions";
import { retryDelays } from "../src/lib/jobs";
import { clientIp } from "../src/lib/rate-limit";
import { origin } from "../src/lib/env";

const wallet = Keypair.generate(),
  other = Keypair.generate(),
  sub = Keypair.generate().publicKey.toBase58(),
  plan = Keypair.generate().publicKey.toBase58(),
  charge = Keypair.generate().publicKey.toBase58();
function event(
  type: string,
  data: Record<string, any>,
  slot: number,
  time = "2026-01-01T00:00:00Z",
): StoredEvent {
  return {
    id: `${slot}`,
    type,
    data,
    slot,
    tx_index: 0,
    log_index: 0,
    occurred_at: time,
  };
}
const subscribed = event(
  "Subscribed",
  {
    subscription: sub,
    plan,
    subscriber: wallet.publicKey.toBase58(),
    nCycles: "3",
    context: {
      merchant: other.publicKey.toBase58(),
      resolver: other.publicKey.toBase58(),
      intervalSecs: "60",
      reviewSecs: "20",
      disputeSecs: "30",
      price: "9007199254740993",
    },
  },
  1,
);
const pulled = event(
  "ChargePulled",
  { subscription: sub, charge, amount: "9007199254740993", cycle: "0" },
  2,
);

test("generated event decoders preserve u64 and ignore foreign invocation data", () => {
  const bytes = recora.getChargePulledEventEncoder().encode({
    subscription: address(sub),
    charge: address(charge),
    amount: 9007199254740993n,
    cycle: 0n,
  });
  const payload = `Program data: ${Buffer.from(bytes).toString("base64")}`;
  const logs = [
    `Program ${program()} invoke [1]`,
    payload,
    `Program ${other.publicKey} invoke [2]`,
    payload,
    `Program ${other.publicKey} success`,
    `Program ${program()} success`,
  ];
  const decoded = decodeEvents(logs);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].data.amount, "9007199254740993");
  assert.equal(decoded[0].logIndex, 1);
  assert.throws(
    () => decodeEvents([`Program ${program()} invoke [1]`, "Log truncated"]),
    /truncated/,
  );
  assert.throws(
    () => decodeEvents([`Program ${program()} invoke [1]`, payload]),
    /Incomplete/,
  );
});
test("projection rebuild handles late history, bonds, terminal charges and closed subscriptions", () => {
  const disputed = event(
    "ChargeDisputed",
    { subscription: sub, charge, bond: "10", evidenceRef: [1, 2, 3] },
    3,
  );
  const contested = event(
    "DisputeContested",
    { subscription: sub, charge, bond: "10" },
    4,
  );
  const holding = project([contested, subscribed, pulled, disputed]);
  assert.equal(
    holding.find((p) => p.kind === "subscription")?.data.heldTotal,
    "9007199254741013",
  );
  assert.equal(holding.find((p) => p.kind === "charge")?.state, "contested");
  const settled = event(
    "DisputeResolved",
    {
      subscription: sub,
      charge,
      merchantNet: "4503599627370496",
      protocolFee: "0",
      subscriberShare: "4503599627370497",
    },
    5,
  );
  const closed = event("SubscriptionClosed", { subscription: sub }, 6);
  const result = project([
    closed,
    settled,
    ...[disputed, pulled, subscribed, contested],
  ]);
  assert.equal(result.find((p) => p.kind === "subscription")?.state, "closed");
  assert.equal(
    result.find((p) => p.kind === "subscription")?.data.openCharges,
    "0",
  );
  assert.equal(result.find((p) => p.kind === "charge")?.state, "resolved");
  assert.throws(() => project([pulled]), /incomplete/);
});
test("canonical ordering distinguishes multiple transactions and logs in one slot", () => {
  const cancel = {
    ...event("SubscriptionCancelled", { subscription: sub }, 2),
    tx_index: 2,
  };
  const lapse = {
    ...event("SubscriptionLapsed", { subscription: sub }, 2),
    tx_index: 1,
  };
  assert.equal(project([cancel, lapse, subscribed])[0].state, "cancelled");
});
test("revenue excludes held amounts and refunds; churn counts each subscription once", () => {
  const records = [
    subscribed,
    pulled,
    event(
      "ChargeSettled",
      { subscription: sub, charge, merchantNet: "9007199254740990" },
      3,
      "2026-01-02T00:00:00Z",
    ),
    event(
      "SubscriptionLapsed",
      { subscription: sub },
      4,
      "2026-01-03T00:00:00Z",
    ),
    event(
      "SubscriptionCancelled",
      { subscription: sub },
      5,
      "2026-01-04T00:00:00Z",
    ),
  ];
  const stats = analytics(
    records,
    new Date("2026-01-02"),
    new Date("2026-02-01"),
  );
  assert.equal(stats.revenue, "9007199254740990");
  assert.equal(stats.startingActive, 1);
  assert.equal(stats.churned, 1);
  assert.equal(stats.churn, 1);
  assert.equal(
    analytics([pulled], new Date("2026-01-01"), new Date("2026-02-01")).revenue,
    "0",
  );
});
test("wallet signatures bind the wallet, origin and exact challenge", () => {
  const message = "Recora sign-in\nOrigin: https://recora.example\nNonce: one";
  const signed = Buffer.from(
    nacl.sign.detached(Buffer.from(message), wallet.secretKey),
  ).toString("base64");
  assert(validWalletSignature(wallet.publicKey.toBase58(), message, signed));
  assert(!validWalletSignature(other.publicKey.toBase58(), message, signed));
  assert(
    !validWalletSignature(wallet.publicKey.toBase58(), `${message}!`, signed),
  );
  assert(!validWalletSignature(wallet.publicKey.toBase58(), message, ""));
  process.env.APP_ORIGIN = "https://recora.example";
  assert.throws(
    () =>
      sameOrigin(
        new Request("https://recora.example", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    /origin/,
  );
});
test("origin normalization accepts a trailing slash without accepting another origin", () => {
  process.env.APP_ORIGIN = "http://localhost:3000/";
  assert.equal(origin(), "http://localhost:3000");
  sameOrigin(new Request("http://localhost:3000/api/auth/challenge", {
    headers: { origin: "http://localhost:3000" },
  }));
  assert.throws(() => sameOrigin(new Request("http://localhost:3000", {
    headers: { origin: "http://localhost:3001" },
  })), /origin/);
});
test("client IP buckets trust Vercel only and canonicalize IPv6", () => {
  const previous = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.equal(clientIp(new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "8.8.8.8" },
    })), "local");
    process.env.VERCEL = "1";
    assert.equal(clientIp(new Request("http://localhost", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    })), "unknown");
    assert.equal(clientIp(new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "2001:4860:0000::8888" },
    })), clientIp(new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "2001:4860::8888" },
    })));
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});
test("merchant-scoped credentials cannot read another tenant", async () => {
  await assert.rejects(
    merchantAccess(
      { wallet: "", merchant: wallet.publicKey.toBase58(), apiKey: true },
      other.publicKey.toBase58(),
    ),
    /another merchant/,
  );
});
test("webhook signatures cover timestamp and exact bytes; encryption is authenticated", () => {
  process.env.WEBHOOK_ENCRYPTION_KEY = "11".repeat(32);
  const encrypted = encrypt("signing-secret");
  assert.equal(decrypt(encrypted), "signing-secret");
  const parts = encrypted.split(".");
  parts[2] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join(".")));
  assert.equal(signature("secret", "123", '{"a":1}').length, 64);
  assert.notEqual(
    signature("secret", "123", '{"a":1}'),
    signature("secret", "124", '{"a":1}'),
  );
  assert.notEqual(
    signature("secret", "123", '{"a":1}'),
    signature("secret", "123", '{ "a":1}'),
  );
  assert(equal("same", "same"));
  assert(!equal("same", "different"));
  assert.deepEqual(retryDelays, [60, 300, 1800, 7200, 43200]);
});
test("webhook destinations reject private, mapped, transition and reserved addresses", async () => {
  for (const value of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    assert(!publicAddress(value), value);
  assert(publicAddress("8.8.8.8"));
  assert(publicAddress("2606:4700:4700::1111"));
  await assert.rejects(destination("http://8.8.8.8"), /HTTPS/);
  await assert.rejects(destination("https://127.0.0.1"), /public/);
});
test("generated instruction adapter preserves signer roles, account order and unsigned messages", () => {
  const signer = createNoopSigner(address(wallet.publicKey.toBase58()));
  const ix = legacyInstruction("Subscribe", {
    sub: address(sub),
    vault: address(pda("vault", new PublicKey(sub)).toBase58()),
    plan: address(plan),
    config: address(pda("config").toBase58()),
    subscriberAta: address(other.publicKey.toBase58()),
    subscriber: signer,
    merchantAuthority: address(other.publicKey.toBase58()),
    delegate: address(pda("delegate").toBase58()),
    mint: address(other.publicKey.toBase58()),
    nCycles: 3n,
  });
  assert(ix.keys[5].isSigner);
  assert(ix.keys[5].isWritable);
  assert(!ix.keys[6].isSigner);
  assert.equal(
    recora.getSubscribeInstructionDataDecoder().decode(ix.data).nCycles,
    3n,
  );
  const tx = new Transaction({
    feePayer: wallet.publicKey,
    recentBlockhash: other.publicKey.toBase58(),
  }).add(ix);
  const encoded = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  assert(
    Transaction.from(encoded).signatures.every((s) => s.signature === null),
  );
});
test("builders reject overflow, invalid evidence, and zero cycles before RPC", () => {
  assert.equal(eventName("Subscribed"), "subscription.subscribed");
  assert.equal(
    eventName("ChargeRefundedAfterTimeout"),
    "charge.refunded_after_timeout",
  );
  assert(!actionSchemas.subscribe.safeParse({ plan, nCycles: "0" }).success);
  assert(
    !actionSchemas.subscribe.safeParse({
      plan,
      nCycles: "18446744073709551616",
    }).success,
  );
  assert(
    !actionSchemas["dispute-charge"].safeParse({
      charge,
      evidenceRef: "not-a-hash",
    }).success,
  );
  assert(
    !actionSchemas["resolve-dispute"].safeParse({ charge, merchantBps: 10001 })
      .success,
  );
  assert.deepEqual(
    jsonSafe({ amount: 9_007_199_254_740_993n, bytes: new Uint8Array([1, 2]) }),
    { amount: "9007199254740993", bytes: [1, 2] },
  );
});
