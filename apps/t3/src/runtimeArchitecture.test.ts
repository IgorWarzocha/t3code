import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime architecture boundaries", () => {
  it("keeps runtime API server wired through runtime-core services", () => {
    const sourcePath = path.resolve(import.meta.dirname, "runtimeApiServer.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain("from \"@acme/runtime-core\"");
    expect(source).toContain("ProcessManager");
    expect(source).toContain("ProviderManager");
    expect(source).toContain("TodoStore");
  });

  it("avoids direct desktop service imports in runtime API server", () => {
    const sourcePath = path.resolve(import.meta.dirname, "runtimeApiServer.ts");
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("../../desktop/src/processManager");
    expect(source).not.toContain("../../desktop/src/providerManager");
    expect(source).not.toContain("../../desktop/src/todoStore");
  });
});
