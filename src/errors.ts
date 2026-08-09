import type { AIProviderKind } from "./types.js";

export const AI_ERROR_CODES = [
  "INVALID_CONFIG",
  "ADAPTER_NOT_INSTALLED",
  "PROVIDER_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "RATE_LIMITED",
  "OVERLOADED",
  "TIMEOUT",
  "ABORTED",
  "INVALID_OUTPUT",
  "REQUEST_FAILED",
] as const;

export type AIErrorCode = (typeof AI_ERROR_CODES)[number];

export interface AIRuntimeErrorOptions {
  code: AIErrorCode;
  provider: AIProviderKind;
  retryable: boolean;
  attempts?: number;
  statusCode?: number;
  cause?: unknown;
}

export class AIRuntimeError extends Error {
  readonly code: AIErrorCode;
  readonly provider: AIProviderKind;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly statusCode?: number;

  constructor(message: string, options: AIRuntimeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AIRuntimeError";
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable;
    this.attempts = options.attempts ?? 0;
    this.statusCode = options.statusCode;
  }
}

export function isAIRuntimeError(error: unknown): error is AIRuntimeError {
  return error instanceof AIRuntimeError;
}
