import { isIP } from "node:net";
import { pool } from "./db";
import { cluster } from "./env";
import { hash } from "./security";
import { HttpError } from "./auth";

export function clientIp(request: Request) {
  // Only Vercel's edge can supply a trusted IP. Never trust client headers
  // when running the application directly, including local development.
  if (process.env.VERCEL !== "1") return "local";
  const value = request.headers.get("x-vercel-forwarded-for")?.trim() || "";
  if (!isIP(value)) return "unknown";
  // Canonicalize IPv6 spelling so equivalent addresses share a bucket.
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname : value;
}

export async function rateLimit(scope: string, subject: string, limit: number) {
  const { rows } = await pool().query(
    `INSERT INTO rate_limits (id,count,expires_at)
     VALUES ($1,1,now()+interval '1 minute')
     ON CONFLICT (id) DO UPDATE SET
       count=CASE WHEN rate_limits.expires_at<=now() THEN 1
         ELSE LEAST(rate_limits.count+1,$2+1) END,
       expires_at=CASE WHEN rate_limits.expires_at<=now() THEN now()+interval '1 minute'
         ELSE rate_limits.expires_at END
     RETURNING count,GREATEST(1,ceil(extract(epoch FROM expires_at-now())))::int AS retry_after`,
    [`${cluster()}:${scope}:${hash(subject)}`, limit],
  );
  if (rows[0].count > limit)
    throw new HttpError(429, "Too many requests; try again shortly", rows[0].retry_after);
}

export async function limitRequest(request: Request, path: string[]) {
  const route = path.join("/");
  if (path[0] === "auth") await rateLimit("auth", clientIp(request), 20);
  else if (route === "rpc") await rateLimit("rpc", clientIp(request), 120);
  else if (request.method === "GET" &&
    (route === "network" || (path[0] === "plans" && path.length === 2)))
    await rateLimit("public", clientIp(request), 60);
}
