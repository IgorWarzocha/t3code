import type { ProviderStartOptions } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  providerModels: (providerOptions?: ProviderStartOptions) =>
    ["server", "provider-models", providerOptions ?? null] as const,
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

export function serverProviderModelsQueryOptions(providerOptions?: ProviderStartOptions) {
  return queryOptions({
    queryKey: serverQueryKeys.providerModels(providerOptions),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getProviderModels(
        providerOptions ? { providerOptions } : undefined,
      );
    },
    staleTime: 60_000,
  });
}
