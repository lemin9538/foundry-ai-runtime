import { describe, expect, it } from "vitest";
import { classifyError, sanitizeMessage } from "../src/error-utils.js";

describe("error normalization", () => {
  it("removes secrets, prompts, line breaks, and ANSI control sequences", () => {
    const message = sanitizeMessage(
      "\u001b[31mfailed\u001b[0m\nBearer raw-token\napi-secret\nfull private prompt",
      ["api-secret", "full private prompt"],
    );
    expect(message).toBe("failed Bearer [REDACTED] [REDACTED] [REDACTED]");
  });

  it("classifies generic network failures as retryable provider unavailability", () => {
    const source = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
    expect(classifyError(source, "openai-compatible", { attempts: 1 }).error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      attempts: 1,
    });
  });
});
