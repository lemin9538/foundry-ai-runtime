import { abortableDelay } from "./abort.js";
import {
  DEFAULT_AI_MAX_ATTEMPTS,
  DEFAULT_AI_RETRY_BASE_DELAY_MS,
  DEFAULT_AI_RETRY_MAX_DELAY_MS,
  MAX_AI_MAX_ATTEMPTS,
  MAX_AI_TIMEOUT_MS,
} from "./constants.js";
import { AIRuntimeError } from "./errors.js";
import type { AIProviderKind, RetryOptions } from "./types.js";

export interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function resolveRetryOptions(
  options: RetryOptions | undefined,
  provider: AIProviderKind,
): ResolvedRetryOptions {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_AI_MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_AI_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_AI_RETRY_MAX_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_AI_MAX_ATTEMPTS) {
    throw invalidRetryOption(`retry.maxAttempts must be an integer between 1 and ${MAX_AI_MAX_ATTEMPTS}.`, provider);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > MAX_AI_TIMEOUT_MS) {
    throw invalidRetryOption(`retry.baseDelayMs must be between 0 and ${MAX_AI_TIMEOUT_MS}.`, provider);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > MAX_AI_TIMEOUT_MS) {
    throw invalidRetryOption(
      `retry.maxDelayMs must be between retry.baseDelayMs and ${MAX_AI_TIMEOUT_MS}.`,
      provider,
    );
  }

  return { maxAttempts, baseDelayMs, maxDelayMs };
}

export function retryDelayMs(
  failedAttempt: number,
  options: ResolvedRetryOptions,
  retryAfterMs?: number,
): number {
  const exponential = options.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
  const requested = retryAfterMs === undefined ? exponential : retryAfterMs;
  return Math.min(options.maxDelayMs, Math.max(0, requested));
}

export async function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  await abortableDelay(delayMs, signal);
}

function invalidRetryOption(message: string, provider: AIProviderKind): AIRuntimeError {
  return new AIRuntimeError(message, {
    code: "INVALID_CONFIG",
    provider,
    retryable: false,
  });
}
