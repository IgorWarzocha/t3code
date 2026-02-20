import { describe, expect, it } from "vitest";

import { WS_METHODS } from "./ws";

describe("WS thread methods", () => {
  it("exposes only canonical terminal state update method", () => {
    expect(WS_METHODS.threadsUpdateTerminalState).toBe("threads.updateTerminalState");
    expect("threadsUpdate" in WS_METHODS).toBe(false);
  });

  it("includes provider catch-up method for durable stream resume", () => {
    expect(WS_METHODS.providersCatchUp).toBe("providers.catchUp");
  });
});
