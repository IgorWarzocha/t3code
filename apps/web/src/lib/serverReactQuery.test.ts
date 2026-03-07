import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";
import { describe, expect, it } from "vitest";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

import { serverQueryKeys } from "./serverReactQuery";

describe("serverQueryKeys", () => {
  it("keeps configAll as the shared prefix for option-scoped config queries", async () => {
    const queryClient = new QueryClient();
    const queryKey = serverQueryKeys.config({
      pi: { binaryPath: "/opt/pi/bin/pi" },
    });

    queryClient.setQueryData(queryKey, { providers: [] });
    await queryClient.invalidateQueries({ queryKey: serverQueryKeys.configAll });

    const queryState = queryClient.getQueryState(queryKey);
    expect(queryState?.isInvalidated).toBe(true);
  });
});
