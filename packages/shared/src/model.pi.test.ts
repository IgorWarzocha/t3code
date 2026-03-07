import { describe, expect, it } from "vitest";

import { getDefaultReasoningEffort, resolveModelSlug } from "./model";

describe("resolveModelSlug for pi", () => {
  it("preserves opaque provider/model slugs", () => {
    expect(resolveModelSlug("anthropic/claude-sonnet-4-20250514", "pi")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("falls back to the pi default only when the selection is empty", () => {
    expect(resolveModelSlug("", "pi")).toBe("openai/gpt-5");
    expect(resolveModelSlug(undefined, "pi")).toBe("openai/gpt-5");
  });
});

describe("getDefaultReasoningEffort for pi", () => {
  it("does not expose a reasoning-effort default", () => {
    expect(getDefaultReasoningEffort("pi")).toBeNull();
  });
});
