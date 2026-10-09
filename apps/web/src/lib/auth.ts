import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { pool, transaction } from "./db";
import { equal, hash, token } from "./security";
import { account } from "./codec";
import { cluster, origin } from "./env";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Identity = { wallet: string; merchant?: string; apiKey?: boolean };
export function validWalletSignature(
  wallet: string,
  message: string,
  signed: string,
) {
  const bytes = Buffer.from(signed, "base64");
  return (
    bytes.length === 64 &&
    nacl.sign.detached.verify(
      Buffer.from(message),
      bytes,
      new PublicKey(wallet).toBytes(),
    )
  );
}
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== origin())
    throw new HttpError(403, "Invalid request origin");
}
export async function challenge(wallet: string) {
  new PublicKey(wallet);
  const id = token();
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  const message = `Recora wallet sign-in\nOrigin: ${origin()}\nWallet: ${wallet}\nCluster: ${cluster()}\nNonce: ${id}\nExpires: ${expiresAt.toISOString()}\nThis signature authorizes a session, not a transaction.`;
  await pool().query(
    "INSERT INTO auth_challenges (id,wallet,message,expires_at) VALUES ($1,$2,$3,$4)",
    [id, wallet, message, expiresAt],
  );
  return { id, message, expiresAt };
}
export async function verifyChallenge(id: string, signed: string) {
  return transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM auth_challenges WHERE id=$1 AND expires_at>now() FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw new HttpError(401, "Challenge expired or already used");
    const row = rows[0];
    if (!validWalletSignature(row.wallet, row.message, signed))
      throw new HttpError(401, "Invalid wallet signature");
    await c.query("DELETE FROM auth_challenges WHERE id=$1", [id]);
    const session = token();
    await c.query(
      "INSERT INTO sessions (hash,wallet,expires_at) VALUES ($1,$2,now()+interval '24 hours')",
      [hash(session), row.wallet],
    );
    return { session, wallet: row.wallet };
  });
}
export async function identity(request: Request): Promise<Identity> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const { rows } = await pool().query(
      "SELECT merchant FROM api_keys WHERE hash=$1 AND cluster=$2 AND NOT revoked",
      [hash(authorization.slice(7)), cluster()],
    );
    if (!rows[0]) throw new HttpError(401, "Invalid API key");
    return { wallet: "", merchant: rows[0].merchant, apiKey: true };
  }
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("recora_session="))
    ?.slice(15);
  if (!cookie) throw new HttpError(401, "Connect and sign in with your wallet");
  const { rows } = await pool().query(
    "SELECT wallet FROM sessions WHERE hash=$1 AND expires_at>now()",
    [hash(cookie)],
  );
  if (!rows[0]) throw new HttpError(401, "Session expired");
  return { wallet: rows[0].wallet };
}
export async function merchantAccess(who: Identity, merchant: string) {
  new PublicKey(merchant);
  if (who.apiKey) {
    if (who.merchant !== merchant)
      throw new HttpError(403, "This API key belongs to another merchant");
    return;
  }
  const data = await account("Merchant", merchant);
  if (data.authority !== who.wallet)
    throw new HttpError(403, "Merchant authority required");
}
export function walletOnly(who: Identity) {
  if (who.apiKey) throw new HttpError(403, "Wallet session required");
}
export function secretAuth(request: Request, expected: string) {
  if (!equal(request.headers.get("authorization") || "", `Bearer ${expected}`))
    throw new HttpError(401, "Invalid service authorization");
}
