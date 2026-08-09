import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AIRuntimeError, generateObject } from "../src/index.js";

interface MockServer {
  baseURL: string;
  close(): Promise<void>;
}

const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("openai-compatible generation", () => {
  it("uses Chat Completions JSON mode and normalizes metadata", async () => {
    let receivedBody: Record<string, unknown> | undefined;
    let receivedAuthorization: string | undefined;
    const server = await startMockServer(async (request, response) => {
      receivedAuthorization = request.headers.authorization;
      receivedBody = await readJSONBody(request);
      sendCompletion(response, { title: "ready" });
    });

    const result = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
        apiKey: "test-secret",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      retry: { maxAttempts: 1 },
    });

    expect(receivedAuthorization).toBe("Bearer test-secret");
    expect(receivedBody).toMatchObject({
      model: "mock-model",
      response_format: { type: "json_object" },
    });
    expect(result).toMatchObject({
      value: { title: "ready" },
      provider: "openai-compatible",
      model: "mock-model",
      finishReason: "stop",
      attempts: 1,
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        cacheReadTokens: 1,
        reasoningTokens: 2,
      },
    });
  });

  it("preserves native json_schema when explicitly enabled", async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const server = await startMockServer(async (request, response) => {
      receivedBody = await readJSONBody(request);
      sendCompletion(response, { title: "native" });
    });

    await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
        structuredOutputs: true,
      },
      schema: z.object({ title: z.string() }),
      schemaName: "title_response",
      prompt: "Return a title.",
      retry: { maxAttempts: 1 },
    });

    expect(receivedBody?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "title_response",
        strict: true,
      },
    });
  });

  it("retries a retryable 503 and respects the facade attempt count", async () => {
    let requests = 0;
    const server = await startMockServer(async (_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after-ms": "1",
        });
        response.end(JSON.stringify({
          error: { message: "server overloaded", type: "server_error", code: "overloaded" },
        }));
        return;
      }
      sendCompletion(response, { title: "recovered" });
    });

    const result = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
    });

    expect(requests).toBe(2);
    expect(result.value).toEqual({ title: "recovered" });
    expect(result.attempts).toBe(2);
  });

  it("classifies HTTP 429 as a retryable rate-limit error", async () => {
    const server = await startMockServer(async (_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify({ error: { message: "Too many requests" } }));
    });

    const error = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      retry: { maxAttempts: 1 },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      retryable: true,
      attempts: 1,
    });
  });

  it("classifies an attempt timeout without retrying when maxAttempts is one", async () => {
    const server = await startMockServer(async () => {
      await new Promise(() => undefined);
    });

    const error = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      timeoutMs: 25,
      retry: { maxAttempts: 1 },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AIRuntimeError);
    expect(error).toMatchObject({ code: "TIMEOUT", retryable: true, attempts: 1 });
  });

  it("does not retry an external abort", async () => {
    let requests = 0;
    const server = await startMockServer(async () => {
      requests += 1;
      await new Promise(() => undefined);
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const error = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      timeoutMs: 1_000,
      signal: controller.signal,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "ABORTED", retryable: false, attempts: 1 });
    expect(requests).toBe(1);
  });

  it("retries malformed model output and returns INVALID_OUTPUT", async () => {
    let requests = 0;
    const server = await startMockServer(async (_request, response) => {
      requests += 1;
      sendRawCompletion(response, "not-json");
    });

    const error = await generateObject({
      provider: {
        kind: "openai-compatible",
        baseURL: `${server.baseURL}/v1`,
        model: "mock-model",
      },
      schema: z.object({ title: z.string() }),
      prompt: "Return a title.",
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    }).catch((caught: unknown) => caught);

    expect(requests).toBe(2);
    expect(error).toMatchObject({ code: "INVALID_OUTPUT", retryable: true, attempts: 2 });
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").not.toContain("not-json");
  });
});

async function startMockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<MockServer> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Mock server did not bind to TCP.");
  const mock: MockServer = {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  servers.push(mock);
  return mock;
}

async function readJSONBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendCompletion(response: ServerResponse, value: unknown): void {
  sendRawCompletion(response, JSON.stringify(value));
}

function sendRawCompletion(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "mock-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }));
}
