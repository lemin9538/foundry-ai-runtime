import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { AIRuntimeError } from "./errors.js";
import type {
  AIProviderConfig,
  AIProviderKind,
  ClaudeCLIProviderConfig,
  CodexCLIProviderConfig,
  OpenAICompatibleProviderConfig,
} from "./types.js";

export const CLI_ADAPTER_PACKAGES = {
  "codex-cli": "ai-sdk-provider-codex-cli",
  "claude-cli": "ai-sdk-provider-claude-code",
} as const;

export function validateProviderConfig(config: AIProviderConfig): AIProviderConfig {
  if (!isRecord(config)) {
    throw invalidConfig("Provider configuration must be an object.", "openai-compatible");
  }

  const kind = providerKindFrom(config);
  if (!kind) {
    throw invalidConfig(
      "Provider kind must be openai-compatible, codex-cli, or claude-cli.",
      "openai-compatible",
    );
  }

  const model = requiredString(config.model, "model", kind);
  if (kind === "openai-compatible") {
    const baseURL = validateBaseURL(config.baseURL, kind);
    const apiKey = optionalString(config.apiKey, "apiKey", kind);
    const providerName = optionalString(config.providerName, "providerName", kind);
    if (config.structuredOutputs !== undefined && typeof config.structuredOutputs !== "boolean") {
      throw invalidConfig("structuredOutputs must be a boolean.", kind);
    }

    return {
      kind,
      baseURL,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(config.headers !== undefined ? { headers: validateHeaders(config.headers, kind) } : {}),
      ...(providerName !== undefined ? { providerName } : {}),
      ...(config.structuredOutputs !== undefined
        ? { structuredOutputs: config.structuredOutputs }
        : {}),
    };
  }

  const executable = optionalString(config.executable, "executable", kind);
  const env = config.env === undefined ? undefined : validateEnvironment(config.env, kind);
  return {
    kind,
    model,
    ...(executable !== undefined ? { executable } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

export async function createProviderModel(
  config: AIProviderConfig,
  cliWorkingDirectory?: string,
): Promise<LanguageModel> {
  const validated = validateProviderConfig(config);
  switch (validated.kind) {
    case "openai-compatible":
      return createHTTPModel(validated);
    case "codex-cli":
      return createCodexModel(validated, requiredWorkingDirectory(cliWorkingDirectory, validated.kind));
    case "claude-cli":
      return createClaudeModel(validated, requiredWorkingDirectory(cliWorkingDirectory, validated.kind));
  }
}

export async function assertCLIAdapterInstalled(kind: "codex-cli" | "claude-cli"): Promise<void> {
  if (kind === "codex-cli") {
    await loadCodexAdapter();
  } else {
    await loadClaudeAdapter();
  }
}

function createHTTPModel(config: OpenAICompatibleProviderConfig): LanguageModel {
  const supportsNativeSchema = config.structuredOutputs === true;
  const provider = createOpenAICompatible({
    name: config.providerName ?? "foundry-openai-compatible",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    headers: config.headers === undefined ? undefined : { ...config.headers },
    // Claim schema support so AI SDK does not warn; downgrade at the wire boundary
    // when the target only implements OpenAI JSON mode.
    supportsStructuredOutputs: true,
    transformRequestBody: supportsNativeSchema ? undefined : downgradeSchemaToJSONMode,
  });
  return provider.chatModel(config.model);
}

async function createCodexModel(
  config: CodexCLIProviderConfig,
  workingDirectory: string,
): Promise<LanguageModel> {
  const { codexExec } = await loadCodexAdapter();
  return codexExec(config.model, {
    codexPath: config.executable ?? "codex",
    cwd: workingDirectory,
    approvalMode: "never",
    sandboxMode: "read-only",
    skipGitRepoCheck: true,
    color: "never",
    logger: false,
    configOverrides: {
      "history.persistence": "none",
      mcp_servers: {},
      web_search: "disabled",
    },
    env: config.env === undefined ? undefined : ({ ...config.env } as Record<string, string>),
  });
}

async function createClaudeModel(
  config: ClaudeCLIProviderConfig,
  workingDirectory: string,
): Promise<LanguageModel> {
  const { claudeCode } = await loadClaudeAdapter();
  return claudeCode(config.model, {
    pathToClaudeCodeExecutable: config.executable ?? "claude",
    cwd: workingDirectory,
    maxTurns: 1,
    permissionMode: "dontAsk",
    tools: [],
    settingSources: [],
    persistSession: false,
    logger: false,
    env: config.env === undefined ? undefined : { ...config.env },
  });
}

function downgradeSchemaToJSONMode(body: Record<string, unknown>): Record<string, unknown> {
  const responseFormat = body.response_format;
  if (
    isRecord(responseFormat) &&
    responseFormat.type === "json_schema"
  ) {
    return { ...body, response_format: { type: "json_object" } };
  }
  return body;
}

async function loadCodexAdapter(): Promise<typeof import("ai-sdk-provider-codex-cli")> {
  try {
    return await import("ai-sdk-provider-codex-cli");
  } catch (error) {
    throw adapterLoadError("codex-cli", CLI_ADAPTER_PACKAGES["codex-cli"], error);
  }
}

async function loadClaudeAdapter(): Promise<typeof import("ai-sdk-provider-claude-code")> {
  try {
    return await import("ai-sdk-provider-claude-code");
  } catch (error) {
    throw adapterLoadError("claude-cli", CLI_ADAPTER_PACKAGES["claude-cli"], error);
  }
}

function adapterLoadError(
  provider: "codex-cli" | "claude-cli",
  packageName: string,
  cause: unknown,
): AIRuntimeError {
  const missing = isMissingModuleError(cause, packageName);
  return new AIRuntimeError(
    missing
      ? `Optional adapter ${packageName} is not installed.`
      : `Failed to load optional adapter ${packageName}.`,
    {
      code: missing ? "ADAPTER_NOT_INSTALLED" : "PROVIDER_UNAVAILABLE",
      provider,
      retryable: false,
      cause,
    },
  );
}

function isMissingModuleError(error: unknown, packageName: string): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes(packageName);
}

function requiredWorkingDirectory(value: string | undefined, provider: AIProviderKind): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfig("A CLI working directory is required.", provider);
  }
  return value;
}

function validateBaseURL(value: unknown, provider: AIProviderKind): string {
  const baseURL = requiredString(value, "baseURL", provider).replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw invalidConfig("baseURL must be an absolute HTTP or HTTPS URL.", provider);
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
    throw invalidConfig("baseURL must be an absolute HTTP or HTTPS URL without embedded credentials.", provider);
  }
  if (parsed.search || parsed.hash) {
    throw invalidConfig("baseURL must not include a query string or fragment.", provider);
  }
  return baseURL;
}

function validateHeaders(value: unknown, provider: AIProviderKind): Readonly<Record<string, string>> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw invalidConfig("headers must be a string-to-string record.", provider);
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (key.trim() === "" || typeof headerValue !== "string") {
      throw invalidConfig("headers must contain non-empty names and string values.", provider);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function validateEnvironment(
  value: unknown,
  provider: AIProviderKind,
): Readonly<Record<string, string | undefined>> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw invalidConfig("env must be a string-to-string record.", provider);
  }
  const env: Record<string, string | undefined> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (key.trim() === "" || (typeof envValue !== "string" && envValue !== undefined)) {
      throw invalidConfig("env must contain non-empty names and string or undefined values.", provider);
    }
    env[key] = envValue;
  }
  return env;
}

function requiredString(value: unknown, field: string, provider: AIProviderKind): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfig(`${field} must be a non-empty string.`, provider);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, provider: AIProviderKind): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, provider);
}

function invalidConfig(message: string, provider: AIProviderKind): AIRuntimeError {
  return new AIRuntimeError(message, {
    code: "INVALID_CONFIG",
    provider,
    retryable: false,
  });
}

function providerKindFrom(value: Record<string, unknown>): AIProviderKind | undefined {
  return value.kind === "openai-compatible" || value.kind === "codex-cli" || value.kind === "claude-cli"
    ? value.kind
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
