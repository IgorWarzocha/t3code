import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateDb } from "./stateDb";
import { STATE_DB_SCHEMA_VERSION } from "./stateMigrations";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("StateDb", () => {
  it("creates the SQLite schema and applies migrations", () => {
    const tempDir = makeTempDir("t3code-state-db-");
    const dbPath = path.join(tempDir, "state.sqlite");
    const stateDb = new StateDb({ dbPath });

    const tables = stateDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table';")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((table) => table.name));
    expect(tableNames.has("documents")).toBe(true);
    expect(tableNames.has("provider_events")).toBe(true);
    expect(tableNames.has("state_events")).toBe(true);
    expect(tableNames.has("metadata")).toBe(true);

    const userVersion = stateDb.db
      .prepare("PRAGMA user_version;")
      .get() as { user_version: number } | undefined;
    expect(userVersion?.user_version).toBe(STATE_DB_SCHEMA_VERSION);

    stateDb.close();
  });
});
