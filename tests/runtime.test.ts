import { describe, expect, it } from "vitest";

import {
  CLI_STRUCTURED_GENERATION_GUARD,
  HTTP_JSON_MODE_GUARD,
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
            title: { type: "string", title: "Human title" },
            items: {
              default: [],
              type: "array",
              items: {
                type: "object",
                properties: {
                  statement: { type: "string", default: "x" },
                  refs: {
                    type: "array",
                    items: { type: "string" },
                    default: [],
                  },
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
            title: { type: ["string", "null"] },
            items: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: {
                  statement: { type: "string" },
                  refs: { type: ["array", "null"], items: { type: "string" } },
                },
                required: ["refs", "statement"],
                additionalProperties: false,
              },
            },
          },
          required: ["background", "items", "title"],
          additionalProperties: false,
        },
      },
      required: ["notes"],
      additionalProperties: false,
    });
  });

  it("downgrades object oneOf alternatives without deleting discriminator fields", () => {
    const converted = codexCompatibleJsonSchema({
      type: "object",
      properties: {
        units: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "narration" },
                  text: { type: "string" },
                  speaker_ref: { type: "string" },
                },
                required: ["kind", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "pause" },
                  duration_hint_ms: { type: "number" },
                },
                required: ["kind"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["units"],
      additionalProperties: false,
    });

    expect(converted).toEqual({
      type: "object",
      properties: {
        units: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["narration", "pause"] },
              text: { type: "string" },
              speaker_ref: { type: ["string", "null"] },
              duration_hint_ms: { type: ["number", "null"] },
            },
            required: ["duration_hint_ms", "kind", "speaker_ref", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["units"],
      additionalProperties: false,
    });
  });
});

describe("CLI structured generation guard", () => {
  it("adds a JSON instruction for OpenAI-compatible JSON mode", () => {
    expect(
      systemPromptForProvider("openai-compatible", "Follow the schema."),
    ).toBe(`${HTTP_JSON_MODE_GUARD}\n\nFollow the schema.`);
    expect(HTTP_JSON_MODE_GUARD.toLowerCase()).toContain("json");
    expect(
      systemPromptForProvider(
        {
          kind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
          model: "native-json-schema",
          structuredOutputs: true,
        },
        "Follow the schema.",
      ),
    ).toBe("Follow the schema.");
  });

  it("adds a domain-neutral guard for CLI-backed providers", () => {
    expect(systemPromptForProvider("codex-cli", "Follow the schema.")).toBe(
      `${CLI_STRUCTURED_GENERATION_GUARD}\n\nFollow the schema.`,
    );
    expect(systemPromptForProvider("claude-cli", undefined)).toBe(
      CLI_STRUCTURED_GENERATION_GUARD,
    );
  });
});
