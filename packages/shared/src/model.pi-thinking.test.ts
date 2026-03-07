import { describe, expect, it } from "vitest";

import { getPiThinkingLevelOptions, normalizePiThinkingLevel } from "./model";

describe("Pi thinking level helpers", () => {
  it("exposes all supported Pi thinking levels", () => {
    expect(getPiThinkingLevelOptions()).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("normalizes known Pi thinking levels and rejects unknown values", () => {
    expect(normalizePiThinkingLevel("minimal")).toBe("minimal");
    expect(normalizePiThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizePiThinkingLevel("")).toBeNull();
    expect(normalizePiThinkingLevel("turbo")).toBeNull();
  });
});
