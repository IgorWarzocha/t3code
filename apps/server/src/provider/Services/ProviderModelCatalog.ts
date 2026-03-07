import type {
  ProviderKind,
  ProviderStartOptions,
  ServerProviderModelCatalog,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderModelCatalogShape {
  readonly getCatalog: (input?: {
    readonly provider?: ProviderKind | undefined;
    readonly providerOptions?: ProviderStartOptions | undefined;
  }) => Effect.Effect<ServerProviderModelCatalog>;
}

export class ProviderModelCatalog extends ServiceMap.Service<
  ProviderModelCatalog,
  ProviderModelCatalogShape
>()("t3/provider/Services/ProviderModelCatalog") {}
