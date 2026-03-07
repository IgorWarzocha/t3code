import { randomUUID } from "node:crypto";
import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import readline from "node:readline";

import {
  type ProviderSession,
  RuntimeMode,
  type ServerProviderModelCatalogEntry,
  ThreadId,
  TurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";

import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "./provider/Services/ProviderAdapter.ts";

type PiRpcCommand =
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "prompt"; message: string; images?: ReadonlyArray<{
      type: "image";
      data: string;
      mimeType: string;
    }> }
  | { id?: string; type: "abort" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "set_model"; provider: string; modelId: string };

type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PiRpcEventPayload = Record<string, unknown> & { type: string };

export type PiRpcManagerEvent =
  | {
      kind: "rpc-event";
      threadId: ThreadId;
      turnId?: TurnId;
      model?: string;
      payload: PiRpcEventPayload;
    }
  | {
      kind: "stderr";
      threadId: ThreadId;
      turnId?: TurnId;
      line: string;
    }
  | {
      kind: "stdout-parse-error";
      threadId: ThreadId;
      line: string;
    }
  | {
      kind: "exit";
      threadId: ThreadId;
      turnId?: TurnId;
      code: number | null;
      signal: NodeJS.Signals | null;
      expected: boolean;
    };

export interface PiRpcManagerStartSessionInput {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: {
    readonly pi?: {
      readonly binaryPath?: string;
      readonly agentDir?: string;
    };
  };
}

export interface PiRpcManagerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly model?: string;
  readonly images?: ReadonlyArray<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
}

interface PiRpcSessionState {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutRl: readline.Interface;
  readonly stderrRl: readline.Interface;
  readonly pending: Map<
    string,
    {
      readonly command: string;
      readonly resolve: (response: PiRpcResponse) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >;
  readonly turns: ProviderThreadTurnSnapshot[];
  readonly createdAt: string;
  threadId: ThreadId;
  cwd: string | undefined;
  runtimeMode: RuntimeMode;
  model: string | undefined;
  resumeCursor: unknown;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  currentTurnId: TurnId | undefined;
  status: ProviderSession["status"];
  updatedAt: string;
  abortRequested: boolean;
  stopping: boolean;
}

type PiRpcStateResponse = {
  readonly model?: Record<string, unknown> | null;
  readonly isStreaming?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
};

type PiRpcAvailableModelsResponse = {
  readonly models?: ReadonlyArray<unknown>;
};

interface PiRpcCatalogModel {
  readonly slug: string;
  readonly name: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePiModelSlug(
  value: string | null | undefined,
): { provider: string; modelId: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIndex),
    modelId: trimmed.slice(slashIndex + 1),
  };
}

function buildResumeCursor(input: {
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly state: PiRpcStateResponse | undefined;
}) {
  const parsedModel = parsePiModelSlug(input.model);
  return {
    ...(input.state?.sessionFile ? { sessionFile: input.state.sessionFile } : {}),
    ...(input.state?.sessionId ? { sessionId: input.state.sessionId } : {}),
    ...(parsedModel ? { modelProvider: parsedModel.provider, modelId: parsedModel.modelId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}

function modelFromState(
  state: PiRpcStateResponse | undefined,
  fallback: string | undefined,
): string | undefined {
  const model = asRecord(state?.model);
  const provider = asString(model?.provider);
  const modelId =
    asString(model?.modelId) ??
    asString(model?.id) ??
    asString(model?.name);
  if (provider && modelId) {
    return `${provider}/${modelId}`;
  }
  return fallback;
}

function parseCatalogModel(value: unknown): PiRpcCatalogModel | null {
  const record = asRecord(value);
  const provider = asString(record?.provider);
  const modelId =
    asString(record?.modelId) ??
    asString(record?.id) ??
    asString(record?.name);
  if (!provider || !modelId) {
    return null;
  }

  const slug = `${provider}/${modelId}`;
  const name = asString(record?.name) ?? modelId;
  return { slug, name };
}

function toModelCatalogEntry(input: {
  readonly state: PiRpcStateResponse | undefined;
  readonly data: unknown;
}): ServerProviderModelCatalogEntry {
  const response = asRecord(input.data) as PiRpcAvailableModelsResponse | undefined;
  const models = Array.isArray(response?.models)
    ? response.models
        .map(parseCatalogModel)
        .filter((model): model is PiRpcCatalogModel => model !== null)
    : [];

  const dedupedModels: PiRpcCatalogModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.slug)) {
      continue;
    }
    seen.add(model.slug);
    dedupedModels.push(model);
  }

  return {
    defaultModel: modelFromState(input.state, undefined) ?? null,
    models: dedupedModels,
  };
}

function toProviderSession(session: PiRpcSessionState): ProviderSession {
  return {
    provider: "pi",
    status: session.status,
    runtimeMode: session.runtimeMode,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.model ? { model: session.model } : {}),
    threadId: session.threadId,
    ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
    ...(session.currentTurnId ? { activeTurnId: session.currentTurnId } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export class PiRpcManager {
  private readonly sessions = new Map<ThreadId, PiRpcSessionState>();
  private readonly listeners = new Set<(event: PiRpcManagerEvent) => void>();

  subscribe(listener: (event: PiRpcManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PiRpcManagerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private clearPending(session: PiRpcSessionState, error: Error): void {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    session.pending.clear();
  }

  private handleResponse(session: PiRpcSessionState, response: PiRpcResponse): void {
    const id = response.id;
    if (!id) return;
    const pending = session.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    session.pending.delete(id);
    if (!response.success) {
      pending.reject(
        new Error(response.error || `Pi RPC command '${pending.command}' failed.`),
      );
      return;
    }
    pending.resolve(response);
  }

  private handleRpcEvent(session: PiRpcSessionState, payload: PiRpcEventPayload): void {
    const turnId = session.currentTurnId;
    if (payload.type === "turn_start") {
      session.status = "running";
      session.updatedAt = new Date().toISOString();
    }
    if (payload.type === "turn_end") {
      if (turnId) {
        session.turns.push({ id: turnId, items: [] });
      }
      session.status = "ready";
      session.abortRequested = false;
      session.currentTurnId = undefined;
      session.updatedAt = new Date().toISOString();
    }
    this.emit({
      kind: "rpc-event",
      threadId: session.threadId,
      ...(turnId ? { turnId } : {}),
      ...(session.model ? { model: session.model } : {}),
      payload,
    });
  }

  private createSession(input: PiRpcManagerStartSessionInput): PiRpcSessionState {
    const binaryPath = input.providerOptions?.pi?.binaryPath ?? "pi";
    const args = ["--mode", "rpc"];
    if (input.providerOptions?.pi?.agentDir) {
      args.push("--session-dir", input.providerOptions.pi.agentDir);
    }

    const child = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: process.env,
    });

    const stdoutRl = readline.createInterface({ input: child.stdout });
    const stderrRl = readline.createInterface({ input: child.stderr });
    const now = new Date().toISOString();
    const session: PiRpcSessionState = {
      child,
      stdoutRl,
      stderrRl,
      pending: new Map(),
      turns: [],
      createdAt: now,
      threadId: input.threadId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      model: input.model,
      resumeCursor: input.resumeCursor,
      sessionFile: undefined,
      sessionId: undefined,
      currentTurnId: undefined,
      status: "connecting",
      updatedAt: now,
      abortRequested: false,
      stopping: false,
    };

    stdoutRl.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.emit({
          kind: "stdout-parse-error",
          threadId: session.threadId,
          line,
        });
        return;
      }
      const record = asRecord(parsed);
      if (!record || typeof record.type !== "string") {
        return;
      }
      if (record.type === "response") {
        this.handleResponse(session, record as PiRpcResponse);
        return;
      }
      this.handleRpcEvent(session, record as PiRpcEventPayload);
    });

    stderrRl.on("line", (line) => {
      this.emit({
        kind: "stderr",
        threadId: session.threadId,
        ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
        line,
      });
    });

    child.on("exit", (code, signal) => {
      session.status = code === 0 || session.stopping ? "closed" : "error";
      session.updatedAt = new Date().toISOString();
      this.clearPending(
        session,
        new Error(`Pi RPC process exited (${code ?? "signal"}${signal ? `:${signal}` : ""}).`),
      );
      this.emit({
        kind: "exit",
        threadId: session.threadId,
        ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
        code,
        signal,
        expected: session.stopping,
      });
      this.sessions.delete(session.threadId);
    });

    return session;
  }

  private async sendCommand(
    session: PiRpcSessionState,
    command: PiRpcCommand,
    timeoutMs = 10_000,
  ): Promise<PiRpcResponse> {
    if (session.child.stdin.destroyed) {
      throw new Error(`Pi RPC stdin is closed for thread '${session.threadId}'.`);
    }
    const id = command.id ?? randomUUID();
    const payload = JSON.stringify({ ...command, id });
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Pi RPC command '${command.type}' timed out.`));
      }, timeoutMs);
      session.pending.set(id, {
        command: command.type,
        resolve,
        reject,
        timeout,
      });
      session.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        session.pending.delete(id);
        reject(error);
      });
    });
  }

  private async getState(session: PiRpcSessionState): Promise<PiRpcStateResponse> {
    const response = await this.sendCommand(session, { type: "get_state" });
    return (response.data as PiRpcStateResponse | undefined) ?? {};
  }

  private async stopSessionInstance(session: PiRpcSessionState): Promise<void> {
    session.stopping = true;
    session.updatedAt = new Date().toISOString();
    session.stdoutRl.close();
    session.stderrRl.close();
    session.child.stdin.end();
    if (!session.child.killed) {
      session.child.kill("SIGTERM");
    }
  }

  async discoverModels(
    input: Omit<PiRpcManagerStartSessionInput, "threadId" | "runtimeMode" | "resumeCursor" | "model">,
  ): Promise<ServerProviderModelCatalogEntry> {
    const session = this.createSession({
      threadId: ThreadId.makeUnsafe(randomUUID()),
      runtimeMode: "full-access",
      ...input,
    });

    try {
      const state = await this.getState(session);
      const response = await this.sendCommand(session, { type: "get_available_models" });
      return toModelCatalogEntry({
        state,
        data: response.data,
      });
    } finally {
      await this.stopSessionInstance(session);
    }
  }

  async startSession(input: PiRpcManagerStartSessionInput): Promise<ProviderSession> {
    if (input.runtimeMode === "approval-required") {
      throw new Error("Pi only supports runtimeMode 'full-access'.");
    }
    await this.stopSession(input.threadId).catch(() => undefined);
    const session = this.createSession(input);
    this.sessions.set(input.threadId, session);

    await this.getState(session);

    const resume = asRecord(input.resumeCursor);
    const resumeSessionFile = asString(resume?.sessionFile);
    if (resumeSessionFile) {
      const switchResponse = await this.sendCommand(session, {
        type: "switch_session",
        sessionPath: resumeSessionFile,
      });
      const switchData = asRecord(switchResponse.data);
      if (switchData?.cancelled === true) {
        throw new Error("Pi session switch was cancelled.");
      }
    }

    if (input.model) {
      const parsedModel = parsePiModelSlug(input.model);
      if (!parsedModel) {
        throw new Error(
          `Pi models must use 'provider/modelId' format. Received '${input.model}'.`,
        );
      }
      await this.sendCommand(session, {
        type: "set_model",
        provider: parsedModel.provider,
        modelId: parsedModel.modelId,
      });
      session.model = input.model;
    }

    const state = await this.getState(session);
    session.sessionFile = state.sessionFile;
    session.sessionId = state.sessionId;
    session.model = modelFromState(state, session.model);
    session.resumeCursor = buildResumeCursor({
      cwd: session.cwd,
      model: session.model,
      state,
    });
    session.status = state.isStreaming ? "running" : "ready";
    session.updatedAt = new Date().toISOString();
    return toProviderSession(session);
  }

  async sendTurn(input: PiRpcManagerSendTurnInput): Promise<ProviderTurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session) {
      throw new Error(`Unknown Pi RPC thread '${input.threadId}'.`);
    }

    if (input.model && input.model !== session.model) {
      const parsedModel = parsePiModelSlug(input.model);
      if (!parsedModel) {
        throw new Error(
          `Pi models must use 'provider/modelId' format. Received '${input.model}'.`,
        );
      }
      await this.sendCommand(session, {
        type: "set_model",
        provider: parsedModel.provider,
        modelId: parsedModel.modelId,
      });
      session.model = input.model;
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    session.currentTurnId = turnId;
    session.abortRequested = false;
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    await this.sendCommand(session, {
      type: "prompt",
      message: input.input ?? "",
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    });
    const state = await this.getState(session);
    session.resumeCursor = buildResumeCursor({
      cwd: session.cwd,
      model: session.model,
      state,
    });
    session.updatedAt = new Date().toISOString();
    return {
      threadId: input.threadId,
      turnId,
      ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown Pi RPC thread '${threadId}'.`);
    }
    session.abortRequested = true;
    session.updatedAt = new Date().toISOString();
    await this.sendCommand(session, { type: "abort" });
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return Array.from(this.sessions.values()).map(toProviderSession);
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const session = this.sessions.get(threadId);
    if (!session) {
      throw new Error(`Unknown Pi RPC thread '${threadId}'.`);
    }
    return {
      threadId,
      turns: [...session.turns],
    };
  }

  async rollbackThread(threadId: ThreadId, numTurns = 0): Promise<ProviderThreadSnapshot> {
    throw new Error(
      `Pi provider does not support rollback for thread '${threadId}' (${numTurns} turns requested).`,
    );
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    await this.stopSessionInstance(session);
    this.sessions.delete(threadId);
  }

  stopAll(): void {
    for (const threadId of Array.from(this.sessions.keys())) {
      void this.stopSession(threadId);
    }
  }
}
