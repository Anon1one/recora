import { existsSync } from "node:fs";
import { required, programId, cluster } from "../src/lib/env";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const webhookURL =
  process.env.HELIUS_CALLBACK_URL ||
  `${required("APP_ORIGIN")}/api/webhooks/helius`;
if (!webhookURL.startsWith("https://"))
  throw new Error(
    "Set HELIUS_CALLBACK_URL to the public HTTPS tunnel or deployed receiver",
  );
if (!["devnet", "mainnet-beta"].includes(cluster()))
  throw new Error("Helius supports devnet and mainnet, not a local validator");
const result = await fetch(
  `https://api.helius.xyz/v0/webhooks?api-key=${encodeURIComponent(required("HELIUS_API_KEY"))}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webhookURL,
      transactionTypes: ["ANY"],
      accountAddresses: [programId()],
      webhookType: cluster() === "devnet" ? "rawDevnet" : "raw",
      authHeader: `Bearer ${required("HELIUS_WEBHOOK_SECRET")}`,
      encoding: "json",
      txnStatus: "all",
    }),
  },
);
if (!result.ok)
  throw new Error(`Helius registration failed: HTTP ${result.status}`);
const resultBody = await result.json();
console.log("Webhook registered:", resultBody.webhookID);
