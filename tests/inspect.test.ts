import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProvider } from "../src/index.js";

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanupCallbacks.splice(0).map((cleanup) => cleanup()));
});

describe("inspectProvider", () => {
  it("checks Codex installation, version, and login without exposing auth output", async () => {
    const executable = await fakeCLI(`
if (process.argv[2] === "--version") console.log("codex-cli 9.8.7");
else if (process.argv.slice(2).join(" ") === "login status") console.log("Logged in as private@example.com with secret-token");
else process.exitCode = 2;
`);

    const status = await inspectProvider({ kind: "codex-cli", executable, model: "gpt-test" });

    expect(status).toMatchObject({
      provider: "codex-cli",
      configured: true,
      available: true,
      installed: true,
      authenticated: true,
      version: "9.8.7",
    });
    expect(JSON.stringify(status)).not.toContain("private@example.com");
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("parses Claude JSON auth status", async () => {
    const executable = await fakeCLI(`
if (process.argv[2] === "--version") console.log("2.3.4 (Claude Code)");
else if (process.argv.slice(2).join(" ") === "auth status --json") console.log(JSON.stringify({ loggedIn: true, email: "private@example.com" }));
else process.exitCode = 2;
`);

    const status = await inspectProvider({ kind: "claude-cli", executable, model: "sonnet" });
    expect(status).toMatchObject({
      available: true,
      installed: true,
      authenticated: true,
      version: "2.3.4",
    });
    expect(JSON.stringify(status)).not.toContain("private@example.com");
  });

  it("reports a missing CLI without throwing", async () => {
    const status = await inspectProvider({
      kind: "codex-cli",
      executable: "/definitely/missing/foundry-codex",
      model: "gpt-test",
    });

    expect(status).toMatchObject({
      configured: true,
      available: false,
      installed: false,
      authenticated: false,
    });
  });

  it("probes the OpenAI-compatible models endpoint only when requested", async () => {
    let path: string | undefined;
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      path = request.url;
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanupCallbacks.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server failed to bind.");

    const provider = {
      kind: "openai-compatible" as const,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: "mock-model",
      apiKey: "probe-secret",
    };
    expect(await inspectProvider(provider)).toEqual({
      provider: "openai-compatible",
      transport: "http",
      model: "mock-model",
      configured: true,
    });
    expect(path).toBeUndefined();

    const status = await inspectProvider(provider, { probeHTTP: true });
    expect(status).toMatchObject({ available: true, authenticated: true, reachable: true });
    expect(path).toBe("/v1/models");
    expect(authorization).toBe("Bearer probe-secret");
  });
});

async function fakeCLI(body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "foundry-ai-inspect-test-"));
  const executable = join(directory, "fake-cli");
  await writeFile(executable, `#!/usr/bin/env node\n${body}`, "utf8");
  await chmod(executable, 0o755);
  cleanupCallbacks.push(() => rm(directory, { recursive: true, force: true }));
  return executable;
}
