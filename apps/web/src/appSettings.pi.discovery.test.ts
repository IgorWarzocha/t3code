import { describe, expect, it } from "vitest";

import { getAppModelOptions, resolveAppModelSelection } from "./appSettings";

describe("Pi discovered model helpers", () => {
  it("prefers discovered Pi models over the static fallback list", () => {
    const options = getAppModelOptions(
      "pi",
      [],
      undefined,
      [
        {
          slug: "openai-codex/gpt-5.3-codex",
          name: "GPT-5.3 Codex",
        },
        {
          slug: "anthropic/claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
        },
      ],
    );

    expect(options).toEqual([
      {
        slug: "openai-codex/gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
      },
      {
        slug: "anthropic/claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        isCustom: false,
      },
    ]);
  });

  it("uses the discovered default model when no Pi model is selected", () => {
    expect(
      resolveAppModelSelection(
        "pi",
        [],
        "",
        [
          {
            slug: "openai-codex/gpt-5.3-codex",
            name: "GPT-5.3 Codex",
          },
        ],
        "openai-codex/gpt-5.3-codex",
      ),
    ).toBe("openai-codex/gpt-5.3-codex");
  });

  it("merges discovered and custom Pi models without duplicating the discovery result", () => {
    const options = getAppModelOptions(
      "pi",
      [
        "anthropic/claude-sonnet-4-20250514",
        "google/gemini-2.5-pro",
      ],
      undefined,
      [
        {
          slug: "anthropic/claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
        },
      ],
    );

    expect(options).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        isCustom: false,
      },
      {
        slug: "google/gemini-2.5-pro",
        name: "google/gemini-2.5-pro",
        isCustom: true,
      },
    ]);
  });
});
