import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asSchema,
  generateObject as sdkGenerateObject,
  jsonSchema,
  type FlexibleSchema,
  type LanguageModelUsage,
} from "ai";
import { createTimedAbortSignal } from "./abort.js";
import { DEFAULT_AI_TIMEOUT_MS, MAX_AI_TIMEOUT_MS } from "./constants.js";
import { AIRuntimeError } from "./errors.js";
import { classifyError, providerSecrets } from "./error-utils.js";
import { createProviderModel, validateProviderConfig } from "./provider.js";
import { resolveRetryOptions, retryDelayMs, waitBeforeRetry } from "./retry.js";
import type { AIProviderConfig, AIUsage, GenerateObjectRequest, GenerateObjectResult } from "./types.js";

export async function generateObject<T>(
  request: GenerateObjectRequest<T>,
): Promise<GenerateObjectResult<T>> {
  const startedAt = performance.now();
  const provider = validateProviderConfig(request.provider);
  validateRequest(request, provider);
  const timeoutMs = resolveTimeoutMs(request.timeoutMs, provider.kind);
  const retry = resolveRetryOptions(request.retry, provider.kind);
  const secrets = providerSecrets(provider, request.prompt, request.system);

  if (request.signal?.aborted) {
    throw classifyError(request.signal.reason, provider.kind, {
      attempts: 0,
      externallyAborted: true,
      secrets,
    }).error;
  }

  let lastError: AIRuntimeError | undefined;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const attemptAbort = createTimedAbortSignal(request.signal, timeoutMs);
    let cliDirectory: string | undefined;

    try {
      if (provider.kind !== "openai-compatible") {
        cliDirectory = await mkdtemp(join(tmpdir(), `foundry-ai-runtime-${provider.kind}-`));
      }
      const model = await createProviderModel(provider, cliDirectory);
      const schema = provider.kind === "codex-cli"
        ? await codexCompatibleSchema(request.schema)
        : request.schema;
      const result = await sdkGenerateObject({
        model,
        schema,
        prompt: request.prompt,
        system: systemPromptForProvider(provider.kind, request.system),
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription,
        maxRetries: 0,
        abortSignal: attemptAbort.signal,
      });
      const validated = request.schema.safeParse(result.object);
      if (!validated.success) {
        throw new AIRuntimeError("The model output did not match the requested schema.", {
          code: "INVALID_OUTPUT",
          provider: provider.kind,
          retryable: true,
          attempts: attempt,
        });
      }

      return {
        value: validated.data,
        provider: provider.kind,
        model: typeof model === "string" ? model : model.modelId,
        usage: normalizeUsage(result.usage),
        finishReason: result.finishReason,
        attempts: attempt,
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (source) {
      const classified = classifyError(source, provider.kind, {
        attempts: attempt,
        timedOut: attemptAbort.didTimeout(),
        externallyAborted: attemptAbort.wasExternallyAborted() || request.signal?.aborted,
        secrets,
      });
      lastError = classified.error;
      if (!lastError.retryable || attempt >= retry.maxAttempts) throw lastError;

      try {
        await waitBeforeRetry(retryDelayMs(attempt, retry, classified.retryAfterMs), request.signal);
      } catch (delayError) {
        throw classifyError(delayError, provider.kind, {
          attempts: attempt,
          externallyAborted: request.signal?.aborted,
          secrets,
        }).error;
      }
    } finally {
      attemptAbort.dispose();
      if (cliDirectory !== undefined) await rm(cliDirectory, { recursive: true, force: true });
    }
  }

  throw lastError ?? new AIRuntimeError("The AI provider request failed.", {
    code: "REQUEST_FAILED",
    provider: provider.kind,
    retryable: false,
  });
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const CODEX_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "title",
  "examples",
  "default",
  "format",
  "pattern",
]);

export const CLI_STRUCTURED_GENERATION_GUARD = [
  "You are being used as a structured data generation model, not as an autonomous coding agent.",
  "Do not inspect files, run shell commands, edit files, use tools, browse, or read project instructions.",
  "Use only the system and user prompt content supplied in this request.",
  "Return only data that satisfies the requested schema.",
].join("\n");

export function systemPromptForProvider(
  provider: AIProviderConfig["kind"],
  system: string | undefined,
): string | undefined {
  if (provider === "openai-compatible") return system;
  const trimmed = system?.trim();
  return trimmed ? `${CLI_STRUCTURED_GENERATION_GUARD}\n\n${trimmed}` : CLI_STRUCTURED_GENERATION_GUARD;
}

async function codexCompatibleSchema<T>(schema: GenerateObjectRequest<T>["schema"]): Promise<FlexibleSchema<T>> {
  const original = asSchema(schema);
  const compatible = codexCompatibleJsonSchema(await original.jsonSchema);
  return jsonSchema<T>(compatible, {
    validate: (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
}

export function codexCompatibleJsonSchema(input: unknown): JsonValue {
  if (Array.isArray(input)) return input.map((item) => codexCompatibleJsonSchema(item));
  if (input === null || typeof input !== "object") return input as JsonValue;

  const record = input as Record<string, unknown>;
  const alternatives = objectSchemaAlternatives(record["oneOf"] ?? record["anyOf"]);
  if (alternatives !== undefined) return mergeObjectSchemaAlternatives(record, alternatives);

  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CODEX_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && isUnknownRecord(value)) {
      output.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          codexCompatibleJsonSchema(propertySchema),
        ]),
      );
      continue;
    }
    output[key] = codexCompatibleJsonSchema(value);
  }

  if (isJsonObject(output.properties)) {
    output.required = Object.keys(output.properties).sort();
    if (output.additionalProperties === undefined) output.additionalProperties = false;
  }

  return output;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectSchemaAlternatives(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const alternatives = value.filter(isUnknownRecord);
  if (alternatives.length !== value.length) return undefined;
  if (!alternatives.every((item) => item["type"] === "object" && isUnknownRecord(item["properties"]))) {
    return undefined;
  }
  return alternatives;
}

function mergeObjectSchemaAlternatives(
  record: Record<string, unknown>,
  alternatives: readonly Record<string, unknown>[],
): JsonValue {
  const properties = new Map<string, unknown[]>();
  const requiredSets = alternatives.map((item) =>
    new Set(Array.isArray(item["required"]) ? item["required"].filter((value) => typeof value === "string") : []),
  );

  for (const alternative of alternatives) {
    const alternativeProperties = alternative["properties"];
    if (!isUnknownRecord(alternativeProperties)) continue;
    for (const [propertyName, propertySchema] of Object.entries(alternativeProperties)) {
      const schemas = properties.get(propertyName) ?? [];
      schemas.push(propertySchema);
      properties.set(propertyName, schemas);
    }
  }

  const mergedProperties: Record<string, JsonValue> = {};
  for (const [propertyName, schemas] of properties) {
    mergedProperties[propertyName] = mergePropertySchemas(schemas);
  }

  const required = [...properties.keys()]
    .filter((propertyName) => requiredSets.every((set) => set.has(propertyName)))
    .sort();
  const output: Record<string, JsonValue> = {
    type: "object",
    properties: mergedProperties,
    required,
    additionalProperties: false,
  };

  for (const [key, value] of Object.entries(record)) {
    if (
      key === "oneOf" ||
      key === "anyOf" ||
      key === "properties" ||
      key === "required" ||
      key === "additionalProperties" ||
      CODEX_UNSUPPORTED_SCHEMA_KEYS.has(key)
    ) {
      continue;
    }
    output[key] = codexCompatibleJsonSchema(value);
  }

  return output;
}

function mergePropertySchemas(schemas: readonly unknown[]): JsonValue {
  const unique = uniqueJsonValues(schemas.map((schema) => codexCompatibleJsonSchema(schema)));
  if (unique.length === 1) return unique[0] as JsonValue;

  const constValues = unique
    .map((schema) => (isJsonObject(schema) ? schema.const : undefined))
    .filter((value): value is JsonValue => value !== undefined);
  if (constValues.length === unique.length && constValues.every((value) => typeof value === "string")) {
    return { type: "string", enum: uniqueJsonValues(constValues).sort() };
  }

  const stringEnums = unique
    .map((schema) => (isJsonObject(schema) && schema.type === "string" && Array.isArray(schema.enum) ? schema.enum : undefined));
  if (stringEnums.every((value) => value !== undefined)) {
    return {
      type: "string",
      enum: uniqueJsonValues(stringEnums.flat().filter((value): value is JsonValue => typeof value === "string")).sort(),
    };
  }

  return {};
}

function uniqueJsonValues(values: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const unique: JsonValue[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function validateRequest<T>(request: GenerateObjectRequest<T>, provider: AIProviderConfig): void {
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw invalidRequest("prompt must be a non-empty string.", provider);
  }
  if (request.system !== undefined && typeof request.system !== "string") {
    throw invalidRequest("system must be a string when provided.", provider);
  }
  if (request.schemaName !== undefined && (typeof request.schemaName !== "string" || request.schemaName.trim() === "")) {
    throw invalidRequest("schemaName must be a non-empty string when provided.", provider);
  }
  if (request.schemaDescription !== undefined && typeof request.schemaDescription !== "string") {
    throw invalidRequest("schemaDescription must be a string when provided.", provider);
  }
  if (
    request.schema === null ||
    typeof request.schema !== "object" ||
    typeof request.schema.safeParse !== "function"
  ) {
    throw invalidRequest("schema must be a Zod schema.", provider);
  }
}

function resolveTimeoutMs(value: number | undefined, provider: AIProviderConfig["kind"]): number {
  const timeoutMs = value ?? DEFAULT_AI_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AI_TIMEOUT_MS) {
    throw new AIRuntimeError(`timeoutMs must be between 1 and ${MAX_AI_TIMEOUT_MS}.`, {
      code: "INVALID_CONFIG",
      provider,
      retryable: false,
    });
  }
  return timeoutMs;
}

function invalidRequest(message: string, provider: AIProviderConfig): AIRuntimeError {
  return new AIRuntimeError(message, {
    code: "INVALID_CONFIG",
    provider: provider.kind,
    retryable: false,
  });
}

function normalizeUsage(usage: LanguageModelUsage): AIUsage | undefined {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens = usage.totalTokens;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = outputTokens ?? 0;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: totalTokens ?? normalizedInput + normalizedOutput,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}
