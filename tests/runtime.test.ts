import { describe, expect, it } from "vitest";

import {
  CLI_STRUCTURED_GENERATION_GUARD,
  codexCompatibleJsonSchema,
  systemPromptForProvider,
} from "../src/runtime.js";

describe("Codex schema compatibility", () => {
  it("removes unsupported keys and requires every object property recursively", () => {
    const converted = codexCompatibleJsonSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        notes: {
          type: "object",
          properties: {
            background: { type: "string" },
            items: {
              default: [],
              type: "array",
              items: {
                type: "object",
                properties: {
                  statement: { type: "string", default: "x" },
                  refs: { type: "array", items: { type: "string" }, default: [] },
                },
                required: ["statement"],
                additionalProperties: false,
              },
            },
          },
          required: ["background"],
          additionalProperties: false,
        },
      },
      required: ["notes"],
      additionalProperties: false,
    });

    expect(converted).toEqual({
      type: "object",
      properties: {
        notes: {
          type: "object",
          properties: {
            background: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  statement: { type: "string" },
                  refs: { type: "array", items: { type: "string" } },
                },
                required: ["refs", "statement"],
                additionalProperties: false,
              },
            },
          },
          required: ["background", "items"],
          additionalProperties: false,
        },
      },
      required: ["notes"],
      additionalProperties: false,
    });
  });
});

describe("CLI structured generation guard", () => {
  it("leaves OpenAI-compatible system prompts unchanged", () => {
    expect(systemPromptForProvider("openai-compatible", "Follow the schema.")).toBe("Follow the schema.");
    expect(systemPromptForProvider("openai-compatible", undefined)).toBeUndefined();
  });

  it("adds a domain-neutral guard for CLI-backed providers", () => {
    expect(systemPromptForProvider("codex-cli", "Follow the schema.")).toBe(
      `${CLI_STRUCTURED_GENERATION_GUARD}\n\nFollow the schema.`,
    );
    expect(systemPromptForProvider("claude-cli", undefined)).toBe(CLI_STRUCTURED_GENERATION_GUARD);
  });
});
