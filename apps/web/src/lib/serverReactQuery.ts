import type { ProviderKind, ProviderStartOptions } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  providerModels: (provider?: ProviderKind, providerOptions?: ProviderStartOptions) =>
    ["server", "provider-models", provider ?? null, providerOptions ?? null] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
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
