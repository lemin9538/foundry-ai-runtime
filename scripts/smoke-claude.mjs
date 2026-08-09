import { generateObject, inspectProvider } from "../dist/index.js";
import { z } from "zod";

const model = requiredEnvironment("FOUNDRY_AI_MODEL");
const executable = optionalEnvironment("FOUNDRY_AI_EXECUTABLE");
const timeoutMs = numericEnvironment("FOUNDRY_AI_TIMEOUT_MS", 300_000);
const provider = {
  kind: "claude-cli",
  model,
  ...(executable === undefined ? {} : { executable }),
};

const status = await inspectProvider(provider, { timeoutMs: Math.min(timeoutMs, 10_000) });
if (!status.available) {
  throw new Error(`Claude Code CLI is not available: ${status.message ?? "unknown reason"}`);
}

const result = await generateObject({
  provider,
  schema: z.object({
    transport: z.literal("claude-cli"),
    ok: z.literal(true),
    summary: z.string().min(1),
  }),
  schemaName: "foundry_ai_runtime_smoke",
  system: "Do not inspect files or use tools. Return only the requested structured data.",
  prompt: "Confirm that this structured-output smoke test succeeded. Use transport claude-cli and ok true.",
  timeoutMs,
  retry: { maxAttempts: 1 },
});

console.log(JSON.stringify({ status, result }, null, 2));

function requiredEnvironment(name) {
  const value = optionalEnvironment(name);
  if (value === undefined) throw new Error(`Set ${name} before running this smoke test.`);
  return value;
}

function optionalEnvironment(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function numericEnvironment(name, fallback) {
  const value = optionalEnvironment(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number.`);
  return parsed;
}
