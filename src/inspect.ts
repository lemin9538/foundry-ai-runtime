import { spawn } from "node:child_process";
import { createTimedAbortSignal } from "./abort.js";
import { MAX_AI_TIMEOUT_MS } from "./constants.js";
import { AIRuntimeError } from "./errors.js";
import { sanitizeMessage } from "./error-utils.js";
import {
  assertCLIAdapterInstalled,
  CLI_ADAPTER_PACKAGES,
  validateProviderConfig,
} from "./provider.js";
import type {
  AIProviderConfig,
  AIProviderKind,
  AIProviderStatus,
  InspectProviderOptions,
  OpenAICompatibleProviderConfig,
} from "./types.js";

const DEFAULT_INSPECT_TIMEOUT_MS = 8_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024;

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function inspectProvider(
  providerConfig: AIProviderConfig,
  options: InspectProviderOptions = {},
): Promise<AIProviderStatus> {
  let provider: AIProviderConfig;
  try {
    provider = validateProviderConfig(providerConfig);
  } catch (error) {
    const kind = unsafeProviderKind(providerConfig);
    return {
      provider: kind,
      transport: kind === "openai-compatible" ? "http" : "cli",
      model: unsafeModel(providerConfig),
      configured: false,
      available: false,
      message: sanitizeMessage(error instanceof Error ? error.message : String(error), undefined),
    };
  }

  const timeoutMs = resolveInspectTimeout(options.timeoutMs, provider.kind);
  if (options.signal?.aborted) throw inspectionAborted(provider.kind);

  if (provider.kind === "openai-compatible") {
    return inspectHTTPProvider(provider, options, timeoutMs);
  }
  return inspectCLIProvider(provider, options, timeoutMs);
}

async function inspectHTTPProvider(
  provider: OpenAICompatibleProviderConfig,
  options: InspectProviderOptions,
  timeoutMs: number,
): Promise<AIProviderStatus> {
  const baseStatus: AIProviderStatus = {
    provider: provider.kind,
    transport: "http",
    model: provider.model,
    configured: true,
  };
  if (options.probeHTTP !== true) return baseStatus;

  const timedSignal = createTimedAbortSignal(options.signal, timeoutMs);
  try {
    const modelsURL = new URL("models", `${provider.baseURL}/`).toString();
    const response = await fetch(modelsURL, {
      method: "GET",
      headers: {
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        ...provider.headers,
      },
      signal: timedSignal.signal,
    });

    if (response.ok) {
      await response.body?.cancel();
      return {
        ...baseStatus,
        available: true,
        authenticated: true,
        reachable: true,
      };
    }

    await response.body?.cancel();
    const authenticationFailure = response.status === 401 || response.status === 403;
    return {
      ...baseStatus,
      available: false,
      ...(authenticationFailure ? { authenticated: false } : {}),
      reachable: true,
      message: authenticationFailure
        ? `HTTP provider rejected its credentials with status ${response.status}.`
        : `HTTP provider probe returned status ${response.status}.`,
    };
  } catch (error) {
    if (options.signal?.aborted || timedSignal.wasExternallyAborted()) {
      throw inspectionAborted(provider.kind);
    }
    return {
      ...baseStatus,
      available: false,
      reachable: false,
      message: timedSignal.didTimeout()
        ? "HTTP provider probe timed out."
        : "HTTP provider could not be reached.",
    };
  } finally {
    timedSignal.dispose();
  }
}

async function inspectCLIProvider(
  provider: Exclude<AIProviderConfig, OpenAICompatibleProviderConfig>,
  options: InspectProviderOptions,
  timeoutMs: number,
): Promise<AIProviderStatus> {
  const executable = provider.executable ?? (provider.kind === "codex-cli" ? "codex" : "claude");
  const baseStatus: AIProviderStatus = {
    provider: provider.kind,
    transport: "cli",
    model: provider.model,
    configured: true,
    executable,
  };

  let versionResult: CommandResult;
  try {
    versionResult = await runCommand(executable, ["--version"], provider.env, timeoutMs, options.signal);
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw inspectionAborted(provider.kind);
    if (errorCode(error) === "ENOENT") {
      return {
        ...baseStatus,
        available: false,
        installed: false,
        authenticated: false,
        message: `${provider.kind === "codex-cli" ? "Codex" : "Claude Code"} CLI was not found.`,
      };
    }
    return {
      ...baseStatus,
      available: false,
      installed: true,
      authenticated: false,
      message: isTimeoutError(error) ? "CLI version check timed out." : "CLI version check failed.",
    };
  }

  const version = extractVersion(versionResult.stdout || versionResult.stderr);
  if (versionResult.exitCode !== 0) {
    return {
      ...baseStatus,
      available: false,
      installed: true,
      authenticated: false,
      ...(version === undefined ? {} : { version }),
      message: "CLI version check failed.",
    };
  }

  let adapterInstalled = true;
  try {
    await assertCLIAdapterInstalled(provider.kind);
  } catch (error) {
    if (error instanceof AIRuntimeError && error.code === "ADAPTER_NOT_INSTALLED") {
      adapterInstalled = false;
    } else {
      return {
        ...baseStatus,
        available: false,
        installed: true,
        authenticated: false,
        ...(version === undefined ? {} : { version }),
        message: `Optional adapter ${CLI_ADAPTER_PACKAGES[provider.kind]} could not be loaded.`,
      };
    }
  }

  const authArguments = provider.kind === "codex-cli"
    ? ["login", "status"]
    : ["auth", "status", "--json"];
  try {
    const authResult = await runCommand(executable, authArguments, provider.env, timeoutMs, options.signal);
    const authenticated = provider.kind === "codex-cli"
      ? authResult.exitCode === 0
      : authResult.exitCode === 0 && claudeAuthenticated(authResult.stdout);
    const available = adapterInstalled && authenticated;
    return {
      ...baseStatus,
      available,
      installed: true,
      authenticated,
      ...(version === undefined ? {} : { version }),
      ...(!adapterInstalled
        ? { message: `Optional adapter ${CLI_ADAPTER_PACKAGES[provider.kind]} is not installed.` }
        : !authenticated
          ? { message: `${provider.kind === "codex-cli" ? "Codex" : "Claude Code"} CLI is not authenticated.` }
          : {}),
    };
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw inspectionAborted(provider.kind);
    return {
      ...baseStatus,
      available: false,
      installed: true,
      authenticated: false,
      ...(version === undefined ? {} : { version }),
      message: isTimeoutError(error) ? "CLI authentication check timed out." : "CLI authentication check failed.",
    };
  }
}

function runCommand(
  executable: string,
  args: string[],
  environment: Readonly<Record<string, string | undefined>> | undefined,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<CommandResult> {
  const timedSignal = createTimedAbortSignal(externalSignal, timeoutMs);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return new Promise((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });

    const cleanup = (): void => {
      timedSignal.signal.removeEventListener("abort", onAbort);
      timedSignal.dispose();
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };

    timedSignal.signal.addEventListener("abort", onAbort, { once: true });
    if (timedSignal.signal.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.once("error", finishReject);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      const didTimeout = timedSignal.didTimeout();
      const externallyAborted = timedSignal.wasExternallyAborted();
      cleanup();
      if (didTimeout || externallyAborted) {
        const error = new Error(didTimeout ? "CLI command timed out." : "CLI command was aborted.");
        error.name = didTimeout ? "TimeoutError" : "AbortError";
        reject(error);
        return;
      }
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function appendLimited(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= MAX_COMMAND_OUTPUT_BYTES
    ? combined
    : combined.subarray(combined.byteLength - MAX_COMMAND_OUTPUT_BYTES);
}

function claudeAuthenticated(output: string): boolean {
  try {
    const value = JSON.parse(output) as unknown;
    if (!isRecord(value)) return false;
    return value.loggedIn === true ||
      value.authenticated === true ||
      value.status === "logged_in" ||
      value.status === "authenticated";
  } catch {
    return false;
  }
}

function extractVersion(output: string): string | undefined {
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u);
  return match?.[1];
}

function resolveInspectTimeout(value: number | undefined, provider: AIProviderKind): number {
  const timeoutMs = value ?? DEFAULT_INSPECT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AI_TIMEOUT_MS) {
    throw new AIRuntimeError(`timeoutMs must be between 1 and ${MAX_AI_TIMEOUT_MS}.`, {
      code: "INVALID_CONFIG",
      provider,
      retryable: false,
    });
  }
  return timeoutMs;
}

function inspectionAborted(provider: AIProviderKind): AIRuntimeError {
  return new AIRuntimeError("Provider inspection was aborted.", {
    code: "ABORTED",
    provider,
    retryable: false,
  });
}

function unsafeProviderKind(value: unknown): AIProviderKind {
  if (isRecord(value) && (value.kind === "codex-cli" || value.kind === "claude-cli")) return value.kind;
  return "openai-compatible";
}

function unsafeModel(value: unknown): string {
  return isRecord(value) && typeof value.model === "string" ? value.model : "";
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && error.name === "TimeoutError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
