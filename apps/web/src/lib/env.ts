export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Configure ${name} in apps/web/.env.local`);
  return value;
}
export const cluster = () => process.env.SOLANA_CLUSTER || "devnet";
export const programId = () =>
  process.env.RECORA_PROGRAM_ID ||
  "ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu";
export const origin = () => new URL(required("APP_ORIGIN")).origin;
