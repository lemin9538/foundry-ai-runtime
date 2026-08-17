import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asSchema,
  generateObject as sdkGenerateObject,
  jsonSchema,
  NoObjectGeneratedError,
  type FlexibleSchema,
  type LanguageModelUsage,
} from "ai";
import { createTimedAbortSignal } from "./abort.js";
import {
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_HTTP_MAX_OUTPUT_TOKENS,
  MAX_AI_TIMEOUT_MS,
} from "./constants.js";
import { AIRuntimeError } from "./errors.js";
import { classifyError, providerSecrets } from "./error-utils.js";
import { createProviderModel, validateProviderConfig } from "./provider.js";
import { resolveRetryOptions, retryDelayMs, waitBeforeRetry } from "./retry.js";
import type {
  AIProviderConfig,
  AIUsage,
  GenerateObjectRequest,
  GenerateObjectResult,
} from "./types.js";

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
  let repair: { readonly text: string; readonly issues: string } | undefined;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const attemptAbort = createTimedAbortSignal(request.signal, timeoutMs);
    let cliDirectory: string | undefined;

    try {
      if (provider.kind !== "openai-compatible") {
        cliDirectory = await mkdtemp(
          join(tmpdir(), `foundry-ai-runtime-${provider.kind}-`),
        );
      }
      const model = await createProviderModel(provider, cliDirectory);
      const schema =
        provider.kind === "codex-cli"
          ? await codexCompatibleSchema(request.schema)
          : request.schema;
      const maxOutputTokens = resolveMaxOutputTokens(request, provider);
      const result = await sdkGenerateObject({
        model,
        schema,
        prompt: repairPrompt(request.prompt, repair),
        system: systemPromptForProvider(provider, request.system),
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription,
        maxRetries: 0,
        abortSignal: attemptAbort.signal,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      });
      const accepted = acceptSchemaValue(
        request.schema,
        result.object,
        result.object,
        request.schemaName,
      );
      if (accepted.ok) {
        return {
          value: accepted.value,
          provider: provider.kind,
          model: typeof model === "string" ? model : model.modelId,
          usage: normalizeUsage(result.usage),
          finishReason: result.finishReason,
          attempts: attempt,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
      repair = accepted.repair;
      throw invalidOutputError(provider.kind, attempt);
    } catch (source) {
      const recovered = recoverGeneratedObject(
        source,
        request.schema,
        request.schemaName,
      );
      if (recovered.ok) {
        return {
          value: recovered.value,
          provider: provider.kind,
          model:
            provider.kind === "openai-compatible"
              ? provider.model
              : provider.kind,
          usage: recovered.usage,
          finishReason: recovered.finishReason,
          attempts: attempt,
          durationMs: Math.round(performance.now() - startedAt),
        };
      }
      if (recovered.repair !== undefined) repair = recovered.repair;
      const classified = classifyError(source, provider.kind, {
        attempts: attempt,
        timedOut: attemptAbort.didTimeout(),
        externallyAborted:
          attemptAbort.wasExternallyAborted() || request.signal?.aborted,
        secrets,
      });
      lastError = classified.error;
      if (!lastError.retryable || attempt >= retry.maxAttempts) throw lastError;

      try {
        await waitBeforeRetry(
          retryDelayMs(attempt, retry, classified.retryAfterMs),
          request.signal,
        );
      } catch (delayError) {
        throw classifyError(delayError, provider.kind, {
          attempts: attempt,
          externallyAborted: request.signal?.aborted,
          secrets,
        }).error;
      }
    } finally {
      attemptAbort.dispose();
      if (cliDirectory !== undefined)
        await rm(cliDirectory, { recursive: true, force: true });
    }
  }

  throw (
    lastError ??
    new AIRuntimeError("The AI provider request failed.", {
      code: "REQUEST_FAILED",
      provider: provider.kind,
      retryable: false,
    })
  );
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
  "When a required JSON field is semantically optional or not applicable, set it to null instead of inventing placeholder values.",
  "Return only data that satisfies the requested schema.",
].join("\n");

export const HTTP_JSON_MODE_GUARD =
  "Return only json that satisfies the requested schema.";

function invalidOutputError(
  provider: AIProviderConfig["kind"],
  attempts: number,
): AIRuntimeError {
  return new AIRuntimeError(
    "The model output did not match the requested schema.",
    {
      code: "INVALID_OUTPUT",
      provider,
      retryable: true,
      attempts,
    },
  );
}

function repairPrompt(
  prompt: string,
  repair: { readonly text: string; readonly issues: string } | undefined,
): string {
  if (repair === undefined) return prompt;
  return [
    prompt,
    "",
    "The previous json was invalid. Return corrected json only.",
    "Previous json:",
    repair.text.slice(0, 12_000),
    "Validation issues:",
    repair.issues,
  ].join("\n");
}

function formatZodIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .slice(0, 16)
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("\n");
}

function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    if (fenced?.[1] !== undefined) {
      try {
        return JSON.parse(fenced[1].trim()) as unknown;
      } catch {
        return undefined;
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function acceptSchemaValue<T>(
  schema: GenerateObjectRequest<T>["schema"],
  value: unknown,
  rawText: unknown,
  schemaName?: string,
):
  | { ok: true; value: T }
  | { ok: false; repair: { readonly text: string; readonly issues: string } } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  for (const candidate of schemaValueCandidates(value, schemaName)) {
    const candidateParsed = schema.safeParse(candidate);
    if (candidateParsed.success) return { ok: true, value: candidateParsed.data };
  }
  const text =
    typeof rawText === "string"
      ? rawText
      : rawText === undefined
        ? ""
        : JSON.stringify(rawText);
  return {
    ok: false,
    repair: {
      text,
      issues: formatZodIssues(parsed.error),
    },
  };
}

function recoverGeneratedObject<T>(
  source: unknown,
  schema: GenerateObjectRequest<T>["schema"],
  schemaName?: string,
):
  | {
      ok: true;
      value: T;
      usage?: AIUsage;
      finishReason?: string;
    }
  | {
      ok: false;
      repair?: { readonly text: string; readonly issues: string };
    } {
  if (
    !NoObjectGeneratedError.isInstance(source) ||
    typeof source.text !== "string"
  ) {
    return { ok: false };
  }
  const extracted = extractJsonValue(source.text);
  if (extracted === undefined) return { ok: false };
  const accepted = acceptSchemaValue(schema, extracted, source.text, schemaName);
  if (accepted.ok) {
    return {
      ok: true,
      value: accepted.value,
      usage:
        source.usage === undefined ? undefined : normalizeUsage(source.usage),
      finishReason: source.finishReason,
    };
  }
  return { ok: false, repair: accepted.repair };
}

export function systemPromptForProvider(
  provider: AIProviderConfig | AIProviderConfig["kind"],
  system: string | undefined,
): string | undefined {
  const kind = typeof provider === "string" ? provider : provider.kind;
  if (kind === "openai-compatible") {
    const usesJsonMode =
      typeof provider === "string" ||
      (provider.kind === "openai-compatible" &&
        provider.structuredOutputs !== true);
    if (!usesJsonMode) return system;
    const trimmed = system?.trim();
    return trimmed
      ? `${HTTP_JSON_MODE_GUARD}\n\n${trimmed}`
      : HTTP_JSON_MODE_GUARD;
  }
  const trimmed = system?.trim();
  return trimmed
    ? `${CLI_STRUCTURED_GENERATION_GUARD}\n\n${trimmed}`
    : CLI_STRUCTURED_GENERATION_GUARD;
}

async function codexCompatibleSchema<T>(
  schema: GenerateObjectRequest<T>["schema"],
): Promise<FlexibleSchema<T>> {
  const original = asSchema(schema);
  const originalJsonSchema = await original.jsonSchema;
  const compatible = codexCompatibleJsonSchema(originalJsonSchema);
  return jsonSchema<T>(compatible, {
    validate: (value) => {
      const parsed = schema.safeParse(
        normalizeCodexOutput(value, originalJsonSchema),
      );
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  });
}

export function codexCompatibleJsonSchema(input: unknown): JsonValue {
  if (Array.isArray(input))
    return input.map((item) => codexCompatibleJsonSchema(item));
  if (input === null || typeof input !== "object") return input as JsonValue;

  const record = input as Record<string, unknown>;
  const alternatives = objectSchemaAlternatives(
    record["oneOf"] ?? record["anyOf"],
  );
  if (alternatives !== undefined)
    return mergeObjectSchemaAlternatives(record, alternatives);

  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CODEX_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && isUnknownRecord(value)) {
      const required = new Set(
        Array.isArray(record.required)
          ? record.required.filter((item) => typeof item === "string")
          : [],
      );
      output.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          required.has(propertyName)
            ? codexCompatibleJsonSchema(propertySchema)
            : nullableCodexSchema(codexCompatibleJsonSchema(propertySchema)),
        ]),
      );
      continue;
    }
    output[key] = codexCompatibleJsonSchema(value);
  }

  if (isJsonObject(output.properties)) {
    output.required = Object.keys(output.properties).sort();
    if (output.additionalProperties === undefined)
      output.additionalProperties = false;
  }

  return output;
}

function normalizeCodexOutput(value: unknown, schema: unknown): unknown {
  if (!isUnknownRecord(schema)) return value;

  const alternatives = objectSchemaAlternatives(
    schema["oneOf"] ?? schema["anyOf"],
  );
  if (alternatives !== undefined) {
    const selected = selectMatchingObjectAlternative(value, alternatives);
    return selected === undefined
      ? value
      : normalizeCodexOutput(value, selected);
  }

  const schemaType = schema["type"];
  if (schemaType === "array" && Array.isArray(value)) {
    const itemSchema = schema["items"];
    return value.map((item) => normalizeCodexOutput(item, itemSchema));
  }

  if (
    schemaType !== "object" ||
    !isUnknownRecord(schema["properties"]) ||
    !isUnknownRecord(value)
  ) {
    return value;
  }

  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((item) => typeof item === "string")
      : [],
  );
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null && !required.has(key)) continue;
    const propertySchema = schema["properties"][key];
    output[key] = normalizeCodexOutput(raw, propertySchema);
  }
  return output;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectSchemaAlternatives(
  value: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const alternatives = value.filter(isUnknownRecord);
  if (alternatives.length !== value.length) return undefined;
  if (
    !alternatives.every(
      (item) =>
        item["type"] === "object" && isUnknownRecord(item["properties"]),
    )
  ) {
    return undefined;
  }
  return alternatives;
}

function mergeObjectSchemaAlternatives(
  record: Record<string, unknown>,
  alternatives: readonly Record<string, unknown>[],
): JsonValue {
  const properties = new Map<string, unknown[]>();
  const requiredSets = alternatives.map(
    (item) =>
      new Set(
        Array.isArray(item["required"])
          ? item["required"].filter((value) => typeof value === "string")
          : [],
      ),
  );
  for (const alternative of alternatives) {
    const alternativeProperties = alternative["properties"];
    if (!isUnknownRecord(alternativeProperties)) continue;
    for (const [propertyName, propertySchema] of Object.entries(
      alternativeProperties,
    )) {
      const schemas = properties.get(propertyName) ?? [];
      schemas.push(propertySchema);
      properties.set(propertyName, schemas);
    }
  }

  const mergedProperties: Record<string, JsonValue> = {};
  for (const [propertyName, schemas] of properties) {
    const requiredByAnyAlternative = requiredSets.some((set) =>
      set.has(propertyName),
    );
    const merged = mergePropertySchemas(schemas);
    mergedProperties[propertyName] = requiredByAnyAlternative
      ? merged
      : nullableCodexSchema(merged);
  }

  const output: Record<string, JsonValue> = {
    type: "object",
    properties: mergedProperties,
    required: [...properties.keys()].sort(),
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
  const unique = uniqueJsonValues(
    schemas.map((schema) => codexCompatibleJsonSchema(schema)),
  );
  if (unique.length === 1) return unique[0] as JsonValue;

  const constValues = unique
    .map((schema) => (isJsonObject(schema) ? schema.const : undefined))
    .filter((value): value is JsonValue => value !== undefined);
  if (
    constValues.length === unique.length &&
    constValues.every((value) => typeof value === "string")
  ) {
    return { type: "string", enum: uniqueJsonValues(constValues).sort() };
  }

  const stringEnums = unique.map((schema) =>
    isJsonObject(schema) &&
    schema.type === "string" &&
    Array.isArray(schema.enum)
      ? schema.enum
      : undefined,
  );
  if (stringEnums.every((value) => value !== undefined)) {
    return {
      type: "string",
      enum: uniqueJsonValues(
        stringEnums
          .flat()
          .filter((value): value is JsonValue => typeof value === "string"),
      ).sort(),
    };
  }

  return {};
}

function nullableCodexSchema(schema: JsonValue): JsonValue {
  if (!isJsonObject(schema)) return schema;
  const output: Record<string, JsonValue> = { ...schema };
  const type = output.type;
  if (typeof type === "string") {
    output.type = type === "null" ? type : [type, "null"];
  } else if (Array.isArray(type)) {
    output.type = type.includes("null") ? type : [...type, "null"];
  }
  if (Array.isArray(output.enum) && !output.enum.includes(null)) {
    output.enum = [...output.enum, null];
  }
  return output;
}

function selectMatchingObjectAlternative(
  value: unknown,
  alternatives: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (!isUnknownRecord(value)) return alternatives[0];
  for (const alternative of alternatives) {
    const properties = alternative["properties"];
    if (!isUnknownRecord(properties)) continue;
    const discriminators = Object.entries(properties).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        isUnknownRecord(entry[1]) && entry[1]["const"] !== undefined,
    );
    if (
      discriminators.length > 0 &&
      discriminators.every(([key, schema]) => value[key] === schema["const"])
    ) {
      return alternative;
    }
  }
  return alternatives[0];
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

function validateRequest<T>(
  request: GenerateObjectRequest<T>,
  provider: AIProviderConfig,
): void {
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw invalidRequest("prompt must be a non-empty string.", provider);
  }
  if (request.system !== undefined && typeof request.system !== "string") {
    throw invalidRequest("system must be a string when provided.", provider);
  }
  if (
    request.schemaName !== undefined &&
    (typeof request.schemaName !== "string" || request.schemaName.trim() === "")
  ) {
    throw invalidRequest(
      "schemaName must be a non-empty string when provided.",
      provider,
    );
  }
  if (
    request.schemaDescription !== undefined &&
    typeof request.schemaDescription !== "string"
  ) {
    throw invalidRequest(
      "schemaDescription must be a string when provided.",
      provider,
    );
  }
  if (
    request.schema === null ||
    typeof request.schema !== "object" ||
    typeof request.schema.safeParse !== "function"
  ) {
    throw invalidRequest("schema must be a Zod schema.", provider);
  }
}

function resolveMaxOutputTokens(
  request: GenerateObjectRequest<unknown>,
  provider: AIProviderConfig,
): number | undefined {
  const configured = maxOutputTokensFromEnv();
  if (provider.kind !== "openai-compatible") {
    return request.maxOutputTokens ?? configured;
  }
  return Math.max(
    request.maxOutputTokens ?? configured ?? DEFAULT_HTTP_MAX_OUTPUT_TOKENS,
    DEFAULT_HTTP_MAX_OUTPUT_TOKENS,
  );
}

function schemaValueCandidates(value: unknown, schemaName: string | undefined): unknown[] {
  if (!isUnknownRecord(value)) return [];
  const keys = [
    schemaName,
    "data",
    "result",
    "response",
    "object",
    "output",
    "value",
  ].filter((key): key is string => typeof key === "string" && key.trim().length > 0);
  const candidates: unknown[] = [];
  for (const key of keys) {
    if (Object.hasOwn(value, key)) candidates.push(value[key]);
  }
  const objectValues = Object.values(value).filter(isUnknownRecord);
  if (objectValues.length === 1) candidates.push(objectValues[0]);
  return candidates;
}

function maxOutputTokensFromEnv(): number | undefined {
  for (const key of [
    "FOUNDRY_AI_MAX_OUTPUT_TOKENS",
    "CONTENT_FOUNDRY_AI_MAX_OUTPUT_TOKENS",
    "CONTENT_FOUNDRY_AI_CONTEXT_TOKENS",
  ]) {
    const raw = process.env[key]?.trim();
    if (raw === undefined || raw.length === 0) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  return undefined;
}

function resolveTimeoutMs(
  value: number | undefined,
  provider: AIProviderConfig["kind"],
): number {
  const timeoutMs = value ?? DEFAULT_AI_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_AI_TIMEOUT_MS
  ) {
    throw new AIRuntimeError(
      `timeoutMs must be between 1 and ${MAX_AI_TIMEOUT_MS}.`,
      {
        code: "INVALID_CONFIG",
        provider,
        retryable: false,
      },
    );
  }
  return timeoutMs;
}

function invalidRequest(
  message: string,
  provider: AIProviderConfig,
): AIRuntimeError {
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
