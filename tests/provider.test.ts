import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderModel, validateProviderConfig } from "../src/provider.js";

const adapters = vi.hoisted(() => ({
  codexExec: vi.fn(() => ({ provider: "mock-codex" })),
  claudeCode: vi.fn(() => ({ provider: "mock-claude" })),
}));

vi.mock("ai-sdk-provider-codex-cli", () => ({ codexExec: adapters.codexExec }));
vi.mock("ai-sdk-provider-claude-code", () => ({ claudeCode: adapters.claudeCode }));

beforeEach(() => {
  adapters.codexExec.mockClear();
  adapters.claudeCode.mockClear();
});

describe("CLI provider construction", () => {
  it("pins Codex to the system executable and a read-only isolated invocation", async () => {
    await createProviderModel({
      kind: "codex-cli",
      model: "gpt-test",
      env: { FOUNDRY_TEST: "1", REMOVE_ME: undefined },
    }, "/tmp/foundry-isolated-codex");

    expect(adapters.codexExec).toHaveBeenCalledWith("gpt-test", {
      codexPath: "codex",
      cwd: "/tmp/foundry-isolated-codex",
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
      env: { FOUNDRY_TEST: "1", REMOVE_ME: undefined },
    });
  });

  it("disables Claude tools, settings sources, prompts, and session persistence", async () => {
    await createProviderModel({
      kind: "claude-cli",
      executable: "/opt/bin/claude",
      model: "sonnet",
    }, "/tmp/foundry-isolated-claude");

    expect(adapters.claudeCode).toHaveBeenCalledWith("sonnet", {
      pathToClaudeCodeExecutable: "/opt/bin/claude",
      cwd: "/tmp/foundry-isolated-claude",
      maxTurns: 1,
      permissionMode: "dontAsk",
      tools: [],
      settingSources: [],
      persistSession: false,
      logger: false,
      env: undefined,
    });
  });

  it("validates runtime configuration and strips trailing base URL slashes", () => {
    expect(validateProviderConfig({
      kind: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1///",
      model: "local-model",
    })).toMatchObject({ baseURL: "http://127.0.0.1:11434/v1" });

    expect(() => validateProviderConfig({
      kind: "openai-compatible",
      baseURL: "not-a-url",
      model: "local-model",
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});
