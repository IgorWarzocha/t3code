import path from "node:path";

import type {
  ProjectAddInput,
  ProjectAddResult,
  ProjectListResult,
  ProjectRemoveInput,
  ProjectUpdateScriptsInput,
  ProjectUpdateScriptsResult,
} from "@t3tools/contracts";

import { PersistenceService } from "./persistenceService";

/**
 * Backward-compatible wrapper retained for tests and legacy callsites.
 * Core storage now lives in SQLite through PersistenceService.
 */
export class ProjectRegistry {
  private readonly persistenceService: PersistenceService;

  constructor(stateDir: string) {
    this.persistenceService = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
      legacyProjectsJsonPath: path.join(stateDir, "projects.json"),
    });
  }

  list(): ProjectListResult {
    return this.persistenceService.listProjects();
  }

  add(raw: ProjectAddInput): ProjectAddResult {
    return this.persistenceService.addProject(raw);
  }

  remove(raw: ProjectRemoveInput): void {
    this.persistenceService.removeProject(raw);
  }

  updateScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    return this.persistenceService.updateProjectScripts(raw);
  }

  close(): void {
    this.persistenceService.close();
  }
}
