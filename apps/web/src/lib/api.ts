import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { z } from "zod";
import { pool } from "./db";
import {
  account,
  entityId,
  jsonSafe,
  pda,
  program,
  rpc,
  eventName,
  ChainAccountError,
} from "./codec";
import {
  challenge,
  HttpError,
  identity,
  merchantAccess,
  sameOrigin,
  secretAuth,
  verifyChallenge,
  walletOnly,
  type Identity,
} from "./auth";
import { cluster, origin, programId, required } from "./env";
import { destination, encrypt, hash, token } from "./security";
import { receive } from "./indexer";
import { runJobs } from "./jobs";
import { buildTransaction } from "./transactions";
import { analytics } from "./projector";
import { eventCodecs } from "./generated";
const supportedWebhookEvents = new Set(Object.keys(eventCodecs).map(eventName));

function response(data: unknown, status = 200) {
  return NextResponse.json(jsonSafe(data), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
async function body(request: Request, max = 65_536) {
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError(413, "Request body too large");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
function publicKey(value: string) {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new HttpError(400, "Invalid Solana address");
  }
}
function item(row: any) {
  return {
    ...row.data,
    address: row.address,
    kind: row.kind,
    state: row.state,
    updatedAt: row.updated_at,
  };
}
function page(url: URL) {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(url.searchParams.get("limit") || "25");
  const cursor = url.searchParams.get("cursor") || "";
  if (cursor) publicKey(cursor);
  return { limit, cursor };
}
async function list(
  url: URL,
  kind: string,
  field: "merchant" | "wallet" | "resolver",
  value: string,
) {
  const { limit, cursor } = page(url),
    state = url.searchParams.get("state");
  const { rows } = await pool().query(
    `SELECT * FROM entities WHERE cluster=$1 AND kind=$2 AND ${field}=$3 AND address>$4
    AND ($5::text IS NULL OR state=$5) ORDER BY address LIMIT $6`,
    [cluster(), kind, value, cursor, state, limit + 1],
  );
  return {
    items: rows.slice(0, limit).map(item),
    nextCursor: rows.length > limit ? rows[limit - 1].address : null,
  };
}
async function visibleEntity(who: Identity, address: string) {
  const row = (
    await pool().query("SELECT * FROM entities WHERE id=$1", [
      entityId(publicKey(address)),
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, "Not indexed yet");
  if (!who.apiKey && (row.wallet === who.wallet || row.resolver === who.wallet))
    return row;
  await merchantAccess(who, row.merchant);
  return row;
}
async function sessionIdentity(request: Request) {
  const who = await identity(request);
  walletOnly(who);
  return who;
}

async function handler(request: Request, path: string[]) {
  const method = request.method,
    url = new URL(request.url),
    route = path.join("/");
  if (route === "webhooks/helius" && method === "POST") {
    // Helius sends the exact Authorization value configured during registration.
    const expected = required("HELIUS_WEBHOOK_SECRET");
    secretAuth(request, expected);
    const payload = z
      .array(
        z
          .object({
            transaction: z
              .object({
                signatures: z
                  .array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/))
                  .min(1),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(100)
      .parse(await body(request, 1_048_576));
    await receive(
      payload.map((tx) => tx.transaction.signatures[0]),
      payload,
    );
    return response({ received: payload.length });
  }
  if (route === "jobs" && (method === "POST" || method === "GET")) {
    secretAuth(request, required("JOB_SECRET"));
    return response(await runJobs());
  }
  if (route === "network" && method === "GET") {
    let config = null,
      mint = null;
    const deployed = !!(await rpc().getAccountInfo(program()))?.executable;
    if (deployed) {
      try {
        config = await account("Config", pda("config"));
        mint = await getMint(rpc(), new PublicKey(config.mint));
      } catch (e) {
        if (!(e instanceof ChainAccountError && e.status === 404)) throw e;
      }
    }
    const treasury = config
      ? (await rpc().getTokenAccountBalance(pda("treasury"))).value.amount
      : null;
    return response({
      cluster: cluster(),
      programId: programId(),
      deployed,
      config,
      treasury,
      mint: mint ? { address: config!.mint, decimals: mint.decimals } : null,
    });
  }
  if (!["GET", "HEAD"].includes(method)) sameOrigin(request);
  if (route === "auth/challenge" && method === "POST") {
    const input = z.object({ wallet: z.string() }).parse(await body(request));
    publicKey(input.wallet);
    const count = (
      await pool().query(
        "SELECT count(*)::int AS n FROM auth_challenges WHERE wallet=$1 AND expires_at>now()",
        [input.wallet],
      )
    ).rows[0].n;
    if (count >= 5)
      throw new HttpError(
        429,
        "Wait for your current sign-in challenges to expire",
      );
    return response(await challenge(input.wallet));
  }
  if (route === "auth/verify" && method === "POST") {
    const input = z
      .object({ id: z.string().length(64), signature: z.string().max(128) })
      .parse(await body(request));
    const result = await verifyChallenge(input.id, input.signature);
    const res = response({ wallet: result.wallet });
    res.cookies.set("recora_session", result.session, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin().startsWith("https:"),
      path: "/",
      maxAge: 86_400,
    });
    return res;
  }
  if (route === "auth/logout" && method === "POST") {
    const session = request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("recora_session="))
      ?.slice(15);
    if (session)
      await pool().query("DELETE FROM sessions WHERE hash=$1", [hash(session)]);
    const res = response({ ok: true });
    res.cookies.delete("recora_session");
    return res;
  }
  const who = await identity(request);
  if (route === "session" && method === "GET") return response(who);
  if (path[0] === "tx" && path.length === 2 && method === "POST") {
    walletOnly(who);
    return response(
      await buildTransaction(path[1], await body(request), who.wallet),
    );
  }
  if (route === "rpc" && method === "POST") {
    walletOnly(who);
    const input = z
      .object({
        method: z.enum([
          "sendTransaction",
          "getSignatureStatuses",
          "getBlockHeight",
          "getLatestBlockhash",
          "getBalance",
        ]),
        params: z.array(z.unknown()).max(3).default([]),
      })
      .parse(await body(request));
    if (input.method === "sendTransaction") {
      const [encoded] = input.params;
      if (typeof encoded !== "string" || encoded.length > 2200)
        throw new HttpError(400, "Invalid transaction");
      const { Transaction } = await import("@solana/web3.js");
      const tx = Transaction.from(Buffer.from(encoded, "base64"));
      if (tx.feePayer?.toBase58() !== who.wallet || !tx.verifySignatures())
        throw new HttpError(
          403,
          "A fully signed transaction from your wallet is required",
        );
      const signature = await rpc().sendRawTransaction(
        Buffer.from(encoded, "base64"),
        { skipPreflight: false, maxRetries: 2 },
      );
      // Sending has already succeeded; Helius/catch-up can recover if the
      // durable hint cannot be stored. Never report a successful send as failed.
      await receive([signature]).catch(() => {});
      return response({ result: signature });
    }
    if (input.method === "getSignatureStatuses") {
      const signatures = z
        .array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/))
        .max(10)
        .parse(input.params[0]);
      return response({
        result: await rpc().getSignatureStatuses(signatures, {
          searchTransactionHistory: true,
        }),
      });
    }
    if (input.method === "getBlockHeight")
      return response({ result: await rpc().getBlockHeight("finalized") });
    if (input.method === "getBalance")
      return response({
        result: await rpc().getBalance(new PublicKey(who.wallet)),
      });
    return response({ result: await rpc().getLatestBlockhash("finalized") });
  }
  if (route === "me" && method === "GET") {
    walletOnly(who);
    const merchant = pda("merchant", new PublicKey(who.wallet)).toBase58();
    let merchantData = null;
    try {
      merchantData = await account("Merchant", merchant);
    } catch {
      /* Merchant registration is optional. */
    }
    return response({
      wallet: who.wallet,
      merchant: merchantData ? { address: merchant, ...merchantData } : null,
    });
  }
  if (path[0] === "transactions" && path.length === 2 && method === "GET") {
    const input = z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/)
      .parse(path[1]);
    const row = (
      await pool().query(
        "SELECT status,error FROM chain_transactions WHERE cluster=$1 AND signature=$2",
        [cluster(), input],
      )
    ).rows[0];
    return response(row || { status: "awaiting_notification" });
  }
  if (route === "subscriptions" && method === "GET") {
    walletOnly(who);
    return response(await list(url, "subscription", "wallet", who.wallet));
  }
  if (route === "disputes" && method === "GET") {
    walletOnly(who);
    return response(await list(url, "charge", "resolver", who.wallet));
  }
  if (route === "charges" && method === "GET") {
    const merchant = url.searchParams.get("merchant") || who.merchant;
    if (merchant) {
      await merchantAccess(who, merchant);
      return response(await list(url, "charge", "merchant", merchant));
    }
    walletOnly(who);
    return response(await list(url, "charge", "wallet", who.wallet));
  }
  if (path[0] === "subscriptions" && path[1] && method === "GET") {
    const row = await visibleEntity(who, path[1]);
    if (path[2] === "history") {
      const { rows } = await pool().query(
        "SELECT id,type,signature,occurred_at,data FROM chain_events WHERE cluster=$1 AND subject=$2 ORDER BY slot,tx_index,log_index",
        [cluster(), row.address],
      );
      return response({ items: rows });
    }
    return response(item(row));
  }
  if (path[0] === "merchants" && path[1]) {
    const merchant = publicKey(path[1]);
    await merchantAccess(who, merchant);
    if (
      ["plans", "subscriptions", "charges"].includes(path[2]) &&
      method === "GET"
    )
      return response(
        await list(
          url,
          (
            {
              plans: "plan",
              subscriptions: "subscription",
              charges: "charge",
            } as Record<string, string>
          )[path[2]],
          "merchant",
          merchant,
        ),
      );
    if (path[2] === "analytics" && method === "GET") {
      const from = new Date(
          url.searchParams.get("from") || Date.now() - 30 * 86_400_000,
        ),
        to = new Date(url.searchParams.get("to") || Date.now());
      if (!Number.isFinite(+from) || !Number.isFinite(+to) || from >= to)
        throw new HttpError(400, "Use an increasing UTC date range");
      const { rows } = await pool().query(
        "SELECT * FROM chain_events WHERE cluster=$1 AND merchant=$2 ORDER BY slot,tx_index,log_index",
        [cluster(), merchant],
      );
      const held = (
        await pool().query(
          "SELECT COALESCE(sum((data->>'amount')::numeric),0)::text AS amount FROM entities WHERE cluster=$1 AND merchant=$2 AND kind='charge' AND state IN ('held','disputed','contested')",
          [cluster(), merchant],
        )
      ).rows[0].amount;
      return response({ ...analytics(rows, from, to), held, from, to });
    }
    if (path[2] === "keys") {
      walletOnly(who);
      if (method === "GET")
        return response({
          items: (
            await pool().query(
              "SELECT id,name,created_at,revoked FROM api_keys WHERE merchant=$1 AND cluster=$2 ORDER BY created_at DESC",
              [merchant, cluster()],
            )
          ).rows,
        });
      if (method === "POST") {
        const input = z
            .object({ name: z.string().trim().min(1).max(80) })
            .parse(await body(request)),
          secret = `recora_${token()}`,
          id = randomUUID();
        await pool().query(
          "INSERT INTO api_keys (id,merchant,cluster,name,hash) VALUES ($1,$2,$3,$4,$5)",
          [id, merchant, cluster(), input.name, hash(secret)],
        );
        return response({ id, key: secret }, 201);
      }
      if (method === "DELETE" && path[3]) {
        await pool().query(
          "UPDATE api_keys SET revoked=true WHERE id=$1 AND merchant=$2 AND cluster=$3",
          [path[3], merchant, cluster()],
        );
        return response({ ok: true });
      }
    }
    if (path[2] === "webhooks") {
      walletOnly(who);
      if (method === "GET")
        return response({
          items: (
            await pool().query(
              "SELECT id,url,filters,enabled,created_at FROM webhook_endpoints WHERE merchant=$1 AND cluster=$2 ORDER BY created_at DESC",
              [merchant, cluster()],
            )
          ).rows,
        });
      if (method === "POST") {
        const input = z
          .object({
            url: z.string().url().max(2048),
            filters: z
              .array(
                z
                  .string()
                  .refine(
                    (value) => supportedWebhookEvents.has(value),
                    "Unknown Recora event name",
                  ),
              )
              .max(20)
              .default([]),
          })
          .parse(await body(request));
        await destination(input.url);
        const secret = token(),
          id = randomUUID();
        await pool().query(
          "INSERT INTO webhook_endpoints (id,cluster,merchant,url,secret,filters) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            cluster(),
            merchant,
            input.url,
            encrypt(secret),
            JSON.stringify(input.filters),
          ],
        );
        return response({ id, secret }, 201);
      }
      if (method === "PATCH" && path[3]) {
        const input = z
          .object({
            enabled: z.boolean().optional(),
            rotate: z.boolean().optional(),
          })
          .parse(await body(request));
        const secret = input.rotate ? token() : null;
        const changed = await pool().query(
          "UPDATE webhook_endpoints SET enabled=COALESCE($4,enabled),secret=COALESCE($5,secret) WHERE id=$1 AND merchant=$2 AND cluster=$3 RETURNING id",
          [
            path[3],
            merchant,
            cluster(),
            input.enabled ?? null,
            secret ? encrypt(secret) : null,
          ],
        );
        if (!changed.rowCount)
          throw new HttpError(404, "Webhook endpoint not found");
        return response({ ok: true, ...(secret ? { secret } : {}) });
      }
    }
    if (path[2] === "deliveries") {
      walletOnly(who);
      if (method === "GET" && path[3]) {
        const attempts = (
          await pool().query(
            `SELECT a.id,a.status_code,a.error,a.attempted_at FROM webhook_attempts a
          JOIN webhook_deliveries d ON d.id=a.delivery JOIN webhook_endpoints e ON e.id=d.endpoint
          WHERE d.id=$1 AND e.merchant=$2 AND e.cluster=$3 ORDER BY a.attempted_at`,
            [path[3], merchant, cluster()],
          )
        ).rows;
        return response({ items: attempts });
      }
      if (method === "GET") {
        const rows = (
          await pool().query(
            `SELECT d.*,e.url FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint
          WHERE e.merchant=$1 AND e.cluster=$2 ORDER BY d.next_attempt DESC LIMIT 100`,
            [merchant, cluster()],
          )
        ).rows;
        return response({ items: rows });
      }
      if (method === "POST" && path[3] && path[4] === "replay") {
        const result = await pool().query(
          `UPDATE webhook_deliveries d SET status='pending',attempts=0,next_attempt=now(),error=NULL
          FROM webhook_endpoints e WHERE d.endpoint=e.id AND d.id=$1 AND e.merchant=$2 AND e.cluster=$3 AND e.enabled AND d.status IN ('failed','disabled') RETURNING d.id`,
          [path[3], merchant, cluster()],
        );
        if (!result.rowCount)
          throw new HttpError(
            409,
            "Only failed deliveries to an enabled endpoint can be replayed",
          );
        return response({ ok: true });
      }
    }
  }
  if (route === "health" && method === "GET") {
    walletOnly(who);
    const queue = (
      await pool().query(
        "SELECT status,count(*)::int AS count,max(received_at) AS last_received FROM chain_transactions WHERE cluster=$1 GROUP BY status",
        [cluster()],
      )
    ).rows;
    const errors = (
      await pool().query(
        "SELECT signature,error,attempts FROM chain_transactions WHERE cluster=$1 AND error IS NOT NULL ORDER BY received_at DESC LIMIT 10",
        [cluster()],
      )
    ).rows;
    const checkpoint =
      (
        await pool().query(
          "SELECT data,updated_at FROM checkpoints WHERE id=$1",
          [`${cluster()}:history`],
        )
      ).rows[0] || null;
    return response({ queue, errors, checkpoint });
  }
  throw new HttpError(404, "Endpoint not found");
}

export async function handle(request: Request, path: string[]) {
  try {
    // Public plan checkout is intentionally available before wallet login.
    if (request.method === "GET" && path[0] === "plans" && path.length === 2) {
      const plan = await account("Plan", publicKey(path[1]));
      const mint = await getMint(rpc(), new PublicKey(plan.mint));
      return response({ address: path[1], ...plan, decimals: mint.decimals });
    }
    return await handler(request, path);
  } catch (error) {
    if (error instanceof HttpError)
      return response({ error: error.message }, error.status);
    if (error instanceof ChainAccountError)
      return response({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return response(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    console.error(
      "Recora request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return response(
      {
        error:
          "Service unavailable. Check RPC, Neon configuration, and migrations.",
      },
      503,
    );
  }
}
