import type { z } from "zod";

export type AIProviderKind = "openai-compatible" | "codex-cli" | "claude-cli";
export type AITransport = "http" | "cli";

export interface OpenAICompatibleProviderConfig {
  kind: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  providerName?: string;
  structuredOutputs?: boolean;
}

interface CLIProviderConfig {
  executable?: string;
  model: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface CodexCLIProviderConfig extends CLIProviderConfig {
  kind: "codex-cli";
}

export interface ClaudeCLIProviderConfig extends CLIProviderConfig {
  kind: "claude-cli";
}

export type AIProviderConfig =
  | OpenAICompatibleProviderConfig
  | CodexCLIProviderConfig
  | ClaudeCLIProviderConfig;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface GenerateObjectRequest<T> {
  provider: AIProviderConfig;
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  schemaName?: string;
  schemaDescription?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: RetryOptions;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface GenerateObjectResult<T> {
  value: T;
  provider: AIProviderKind;
  model: string;
  usage?: AIUsage;
  finishReason?: string;
  attempts: number;
  durationMs: number;
}

export interface InspectProviderOptions {
  probeHTTP?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AIProviderStatus {
  provider: AIProviderKind;
  transport: AITransport;
  model: string;
  configured: boolean;
  available?: boolean;
  installed?: boolean;
  authenticated?: boolean;
  reachable?: boolean;
  executable?: string;
  version?: string;
  message?: string;
}
