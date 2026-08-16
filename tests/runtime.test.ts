import { describe, expect, it } from "vitest";

import { codexCompatibleJsonSchema } from "../src/runtime.js";

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
