import { APICallError, LoadAPIKeyError, NoObjectGeneratedError } from "ai";
import { AIRuntimeError } from "./errors.js";
import type { AIErrorCode } from "./errors.js";
import type { AIProviderConfig, AIProviderKind } from "./types.js";

export interface ErrorClassificationContext {
  attempts: number;
  timedOut?: boolean;
  externallyAborted?: boolean;
  secrets?: readonly string[];
}

export interface ClassifiedError {
  error: AIRuntimeError;
  retryAfterMs?: number;
}

export function classifyError(
  source: unknown,
  provider: AIProviderKind,
  context: ErrorClassificationContext,
): ClassifiedError {
  if (context.externallyAborted) {
    return classified("ABORTED", "AI generation was aborted.", provider, false, context.attempts);
  }
  if (context.timedOut) {
    return classified("TIMEOUT", "AI generation timed out.", provider, true, context.attempts);
  }

  if (source instanceof AIRuntimeError) {
    return {
      error: new AIRuntimeError(sanitizeMessage(source.message, context.secrets), {
        code: source.code,
        provider: source.provider,
        retryable: source.retryable,
        attempts: context.attempts || source.attempts,
        statusCode: source.statusCode,
      }),
      retryAfterMs: retryAfterFrom(source),
    };
  }

  if (NoObjectGeneratedError.isInstance(source)) {
    return classified(
      "INVALID_OUTPUT",
      "The model output did not match the requested schema.",
      provider,
      true,
      context.attempts,
    );
  }

  if (LoadAPIKeyError.isInstance(source)) {
    return classified(
      "AUTHENTICATION_FAILED",
      "The AI provider rejected or could not load its credentials.",
      provider,
      false,
      context.attempts,
    );
  }

  const statusCode = statusCodeFrom(source);
  const code = errorCodeFrom(source);
  const rawMessage = errorMessageFrom(source);
  const normalized = rawMessage.toLowerCase();
  const retryAfterMs = retryAfterFrom(source);

  if (statusCode === 401 || statusCode === 403 || isAuthenticationCode(code) || isAuthenticationMessage(normalized)) {
    return classifiedWithRetryAfter(
      "AUTHENTICATION_FAILED",
      messageWithStatus("The AI provider rejected its credentials.", statusCode),
      provider,
      false,
      context.attempts,
      statusCode,
      retryAfterMs,
    );
  }

  if (statusCode === 429 || isRateLimitCode(code) || isRateLimitMessage(normalized)) {
    return classifiedWithRetryAfter(
      "RATE_LIMITED",
      messageWithStatus("The AI provider rate limit was reached.", statusCode),
      provider,
      true,
      context.attempts,
      statusCode,
      retryAfterMs,
    );
  }

  if (statusCode === 408 || isTimeoutCode(code) || isTimeoutMessage(normalized)) {
    return classifiedWithRetryAfter(
      "TIMEOUT",
      messageWithStatus("The AI provider request timed out.", statusCode),
      provider,
      true,
      context.attempts,
      statusCode,
      retryAfterMs,
    );
  }

  if (statusCode === 503 || isOverloadCode(code) || isOverloadMessage(normalized)) {
    return classifiedWithRetryAfter(
      "OVERLOADED",
      messageWithStatus("The AI provider is temporarily overloaded.", statusCode),
      provider,
      true,
      context.attempts,
      statusCode,
      retryAfterMs,
    );
  }

  if (isAbortError(source)) {
    return classified("ABORTED", "AI generation was aborted.", provider, false, context.attempts);
  }

  if (isMissingExecutableCode(code) || isMissingExecutableMessage(normalized)) {
    return classified(
      "PROVIDER_UNAVAILABLE",
      `The ${provider} executable was not found.`,
      provider,
      false,
      context.attempts,
    );
  }

  if (isNetworkCode(code) || isNetworkMessage(normalized)) {
    return classified(
      "PROVIDER_UNAVAILABLE",
      "The AI provider could not be reached.",
      provider,
      true,
      context.attempts,
    );
  }

  const apiRetryable = APICallError.isInstance(source) && source.isRetryable;
  const retryable = apiRetryable || (statusCode !== undefined && statusCode >= 500);
  const fallback = messageWithStatus("The AI provider request failed.", statusCode);
  const safeDetail = sanitizeMessage(rawMessage, context.secrets, fallback);
  return classifiedWithRetryAfter(
    "REQUEST_FAILED",
    safeDetail === "Unknown error" ? fallback : safeDetail,
    provider,
    retryable,
    context.attempts,
    statusCode,
    retryAfterMs,
  );
}

export function providerSecrets(config: AIProviderConfig, prompt?: string, system?: string): string[] {
  const secrets = [prompt, system].filter((value): value is string => Boolean(value));
  if (config.kind !== "openai-compatible") return secrets;
  if (config.apiKey) secrets.push(config.apiKey);
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (/(?:authorization|api[-_]?key|token|secret)/iu.test(name) && value) secrets.push(value);
  }
  return secrets;
}

export function sanitizeMessage(
  value: string,
  secrets: readonly string[] | undefined,
  fallback = "Unknown error",
): string {
  let sanitized = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
  for (const secret of secrets ?? []) {
    if (secret.length > 0) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (sanitized === "") return fallback;
  return Array.from(sanitized).slice(0, 400).join("");
}

function classified(
  code: AIErrorCode,
  message: string,
  provider: AIProviderKind,
  retryable: boolean,
  attempts: number,
  statusCode?: number,
): ClassifiedError {
  return {
    error: new AIRuntimeError(message, { code, provider, retryable, attempts, statusCode }),
  };
}

function classifiedWithRetryAfter(
  code: AIErrorCode,
  message: string,
  provider: AIProviderKind,
  retryable: boolean,
  attempts: number,
  statusCode: number | undefined,
  retryAfterMs: number | undefined,
): ClassifiedError {
  return {
    ...classified(code, message, provider, retryable, attempts, statusCode),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function statusCodeFrom(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  const record = asRecord(error);
  return typeof record?.statusCode === "number"
    ? record.statusCode
    : typeof record?.status === "number"
      ? record.status
      : undefined;
}

function errorCodeFrom(error: unknown): string | number | undefined {
  const record = asRecord(error);
  if (typeof record?.code === "string" || typeof record?.code === "number") return record.code;
  const data = asRecord(record?.data);
  if (typeof data?.code === "string" || typeof data?.code === "number") return data.code;
  const cause = asRecord(record?.cause);
  return typeof cause?.code === "string" || typeof cause?.code === "number" ? cause.code : undefined;
}

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  return typeof record?.message === "string" ? record.message : String(error ?? "Unknown error");
}

function retryAfterFrom(error: unknown): number | undefined {
  const headers = APICallError.isInstance(error)
    ? error.responseHeaders
    : asStringRecord(asRecord(error)?.responseHeaders);
  if (!headers) return undefined;

  const retryAfterMs = headerValue(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function headerValue(headers: Record<string, string>, wanted: string): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function isAuthenticationMessage(message: string): boolean {
  return /(?:unauthori[sz]ed|authentication failed|invalid api key|not logged in|login required)/u.test(message);
}

function isAuthenticationCode(code: string | number | undefined): boolean {
  return typeof code === "string" && /^(?:401|unauthorized|auth|authentication_failed)$/iu.test(code);
}

function isRateLimitMessage(message: string): boolean {
  return /(?:rate.?limit|too many requests|quota exceeded)/u.test(message);
}

function isRateLimitCode(code: string | number | undefined): boolean {
  return typeof code === "string" && /^(?:429|rate_limit|rate_limited)$/iu.test(code);
}

function isOverloadMessage(message: string): boolean {
  return /(?:overload|over capacity|capacity limit|server busy|temporarily unavailable)/u.test(message);
}

function isOverloadCode(code: string | number | undefined): boolean {
  return typeof code === "string" && /(?:overload|capacity|server_busy)/iu.test(code);
}

function isTimeoutMessage(message: string): boolean {
  return /(?:timed?\s*out|timeout)/u.test(message);
}

function isNetworkMessage(message: string): boolean {
  return /(?:fetch failed|failed to fetch|cannot connect|connection refused|socket hang up|network error)/u.test(message);
}

function isMissingExecutableMessage(message: string): boolean {
  return /(?:spawn .* enoent|command not found|executable .* not found)/u.test(message);
}

function isTimeoutCode(code: string | number | undefined): boolean {
  return typeof code === "string" && ["ETIMEDOUT", "TIMEOUT"].includes(code.toUpperCase());
}

function isMissingExecutableCode(code: string | number | undefined): boolean {
  return typeof code === "string" && code.toUpperCase() === "ENOENT";
}

function isNetworkCode(code: string | number | undefined): boolean {
  return typeof code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EAI_AGAIN"].includes(code.toUpperCase());
}

function isAbortError(error: unknown): boolean {
  const record = asRecord(error);
  return record?.name === "AbortError" || record?.code === "ABORT_ERR";
}

function messageWithStatus(message: string, statusCode?: number): string {
  return statusCode === undefined ? message : `${message} HTTP ${statusCode}.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
