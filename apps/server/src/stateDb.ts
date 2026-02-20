import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runStateMigrations } from "./stateMigrations";

export interface StateDbOptions {
  dbPath: string;
}

export class StateDb {
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(options: StateDbOptions) {
    this.dbPath = path.resolve(options.dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    runStateMigrations(this.db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}
