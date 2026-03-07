import type { ServerProviderModelCatalog } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config";
import { PiRpcManager } from "../../piRpcManager";
import {
  ProviderModelCatalog,
  type ProviderModelCatalogShape,
} from "../Services/ProviderModelCatalog";

export const ProviderModelCatalogLive = Layer.effect(
  ProviderModelCatalog,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;

    const getCatalog: ProviderModelCatalogShape["getCatalog"] = (input) =>
      Effect.tryPromise(async (): Promise<ServerProviderModelCatalog> => {
        if (input?.provider !== "pi") {
          return {};
        }

        const piManager = new PiRpcManager();
        const piOptions = input?.providerOptions?.pi;
        const normalizedPiOptions =
          piOptions && (piOptions.binaryPath || piOptions.agentDir)
            ? {
                ...(piOptions.binaryPath ? { binaryPath: piOptions.binaryPath } : {}),
                ...(piOptions.agentDir ? { agentDir: piOptions.agentDir } : {}),
              }
            : undefined;
        const pi = await piManager.discoverModels({
          cwd: serverConfig.cwd,
          ...(normalizedPiOptions
            ? {
                providerOptions: {
                  pi: normalizedPiOptions,
                },
              }
            : {}),
        });

        return pi.models.length > 0 || pi.defaultModel ? { pi } : {};
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("provider model discovery failed", {
            cause: error,
          }),
        ),
        Effect.orElseSucceed(() => ({} satisfies ServerProviderModelCatalog)),
      );

    return {
      getCatalog,
    } satisfies ProviderModelCatalogShape;
  }),
);
