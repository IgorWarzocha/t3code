import { describe, expect, it, vi } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { PiRpcManager } from "../../piRpcManager.ts";
import { ProviderModelCatalog } from "../Services/ProviderModelCatalog.ts";
import { ProviderModelCatalogLive } from "./ProviderModelCatalog.ts";

const testLayer = ProviderModelCatalogLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

describe("ProviderModelCatalogLive", () => {
  it("returns Pi models from the discovery service", async () => {
    vi.spyOn(PiRpcManager.prototype, "discoverModels").mockResolvedValueOnce({
      defaultModel: "openai-codex/gpt-5.3-codex",
      models: [
        {
          slug: "openai-codex/gpt-5.3-codex",
          name: "GPT-5.3 Codex",
        },
      ],
    });

    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Effect.service(ProviderModelCatalog);
        return yield* service.getCatalog();
      }).pipe(Effect.provide(testLayer)),
    );

    expect(catalog).toEqual({
      pi: {
        defaultModel: "openai-codex/gpt-5.3-codex",
        models: [
          {
            slug: "openai-codex/gpt-5.3-codex",
            name: "GPT-5.3 Codex",
          },
        ],
      },
    });
  });

  it("falls back to an empty catalog when Pi discovery fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(PiRpcManager.prototype, "discoverModels").mockRejectedValueOnce(
      new Error("pi rpc unavailable"),
    );

    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Effect.service(ProviderModelCatalog);
        return yield* service.getCatalog();
      }).pipe(Effect.provide(testLayer)),
    );

    expect(catalog).toEqual({});
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
