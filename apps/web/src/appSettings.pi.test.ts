import { describe, expect, it } from "vitest";

import {
  getAppModelOptions,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  resolveAppModelSelection,
} from "./appSettings";

describe("Pi app settings model helpers", () => {
  it("keeps opaque Pi model ids as custom models", () => {
    expect(
      normalizeCustomModelSlugs(
        [" anthropic/claude-sonnet-4-20250514 ", "openai/gpt-5", ""],
        "pi",
      ),
    ).toEqual(["anthropic/claude-sonnet-4-20250514"]);
  });

  it("exposes Pi custom models through the picker and /model suggestions", () => {
    const options = getAppModelOptions("pi", ["anthropic/claude-sonnet-4-20250514"]);
    const slashOptions = getSlashModelOptions(
      "pi",
      ["anthropic/claude-sonnet-4-20250514"],
      "claude",
      "openai/gpt-5",
    );

    expect(options.some((option) => option.slug === "anthropic/claude-sonnet-4-20250514")).toBe(
      true,
    );
    expect(slashOptions.map((option) => option.slug)).toEqual([
      "anthropic/claude-sonnet-4-20250514",
    ]);
  });

  it("preserves a selected Pi custom model instead of falling back to the default", () => {
    expect(
      resolveAppModelSelection(
        "pi",
        ["anthropic/claude-sonnet-4-20250514"],
        "anthropic/claude-sonnet-4-20250514",
      ),
    ).toBe("anthropic/claude-sonnet-4-20250514");
  });
});
