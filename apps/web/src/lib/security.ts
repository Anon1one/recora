import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { Agent, request } from "undici";
import { required } from "./env";

export const token = () => randomBytes(32).toString("hex");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function signature(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}
function encryptionKey() {
  const value = required("WEBHOOK_ENCRYPTION_KEY");
  if (!/^[a-f0-9]{64}$/i.test(value))
    throw new Error("WEBHOOK_ENCRYPTION_KEY must contain 64 hex characters");
  return Buffer.from(value, "hex");
}
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decrypt(value: string) {
  const [iv, tag, ciphertext] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

const blocked = new BlockList();
for (const [ip, mask] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, mask, "ipv4");
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !blocked.check(ip, "ipv4");
  // Only native global unicast IPv6; excludes loopback, mapped IPv4, ULA,
  // link-local, NAT64, multicast and transition ranges.
  if (isIP(ip) !== 6) return false;
  const global = new BlockList();
  global.addSubnet("2000::", 3, "ipv6");
  const reserved = new BlockList();
  reserved.addSubnet("2001::", 23, "ipv6");
  reserved.addSubnet("2001:db8::", 32, "ipv6");
  reserved.addSubnet("2002::", 16, "ipv6");
  reserved.addSubnet("3fff::", 20, "ipv6");
  return global.check(ip, "ipv6") && !reserved.check(ip, "ipv6");
}
export async function destination(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Use a public HTTPS URL on port 443 without credentials or fragments",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error(
      "Webhook destination must resolve exclusively to public addresses",
    );
  return { url, address: addresses[0] };
}
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const target = await destination(url);
  const agent = new Agent({
    connect: {
      autoSelectFamily: false,
      lookup: (_host, _options, callback) =>
        callback(null, target.address.address, target.address.family),
      timeout: 10_000,
    },
  });
  try {
    // undici.request does not follow redirects unless a redirect interceptor is installed.
    const response = await request(target.url, {
      dispatcher: agent,
      method: "POST",
      body,
      headers,
      signal: AbortSignal.timeout(10_000),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    response.body.destroy();
    return response.statusCode;
  } finally {
    await agent.close();
  }
}
