import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("Pi provider model options", () => {
  it("accepts Pi thinking level when starting a session", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-pi-start",
      provider: "pi",
      model: "openai-codex/gpt-5.4",
      modelOptions: {
        pi: {
          thinkingLevel: "xhigh",
        },
      },
      runtimeMode: "full-access",
    });

    expect(parsed.modelOptions?.pi?.thinkingLevel).toBe("xhigh");
  });

  it("accepts Pi thinking level on turn dispatch", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-pi-turn",
      model: "openai-codex/gpt-5.4",
      modelOptions: {
        pi: {
          thinkingLevel: "minimal",
        },
      },
    });

    expect(parsed.modelOptions?.pi?.thinkingLevel).toBe("minimal");
  });
});
