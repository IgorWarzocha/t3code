import type { ProviderKind, ProviderStartOptions } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: (providerOptions?: ProviderStartOptions) =>
    ["server", "config", providerOptions ?? null] as const,
  providerModels: (provider?: ProviderKind, providerOptions?: ProviderStartOptions) =>
    ["server", "provider-models", provider ?? null, providerOptions ?? null] as const,
};

export function serverConfigQueryOptions(providerOptions?: ProviderStartOptions) {
  return queryOptions({
    queryKey: serverQueryKeys.config(providerOptions),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig(
        providerOptions ? { providerOptions } : undefined,
      );
    },
    staleTime: Infinity,
  });
}

export function serverProviderModelsQueryOptions(
  provider?: ProviderKind,
  providerOptions?: ProviderStartOptions,
) {
  return queryOptions({
    queryKey: serverQueryKeys.providerModels(provider, providerOptions),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getProviderModels({
        ...(provider ? { provider } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      });
    },
    staleTime: 60_000,
  });
}
