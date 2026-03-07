import assert from "node:assert/strict";

import {
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import { Effect, Layer, Stream } from "effect";

import {
  PiRpcManager,
  type PiRpcManagerEvent,
  type PiRpcManagerSendTurnInput,
  type PiRpcManagerStartSessionInput,
} from "../../piRpcManager.ts";
import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { makePiAdapterLive } from "./PiAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

class FakePiManager {
  private readonly listeners = new Set<(event: PiRpcManagerEvent) => void>();

  public startSessionImpl = vi.fn(
    async (input: PiRpcManagerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "pi",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        resumeCursor: {
          sessionId: "pi-session-1",
          sessionFile: "/tmp/pi-session-1.json",
          ...(input.model ? { modelProvider: "openai", modelId: "gpt-5" } : {}),
        },
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (input: PiRpcManagerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: input.threadId,
      turnId: asTurnId("turn-1"),
      resumeCursor: {
        sessionId: "pi-session-1",
        sessionFile: "/tmp/pi-session-1.json",
      },
    }),
  );

  subscribe(listener: (event: PiRpcManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PiRpcManagerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  startSession(input: PiRpcManagerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  sendTurn(input: PiRpcManagerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  interruptTurn(_threadId: ThreadId): Promise<void> {
    return Promise.resolve();
  }

  listSessions(): ProviderSession[] {
    return [];
  }

  hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  readThread(threadId: ThreadId) {
    return Promise.resolve({ threadId, turns: [] });
  }

  rollbackThread(threadId: ThreadId) {
    return Promise.resolve({ threadId, turns: [] });
  }

  stopSession(_threadId: ThreadId): Promise<void> {
    return Promise.resolve();
  }

  stopAll(): void {}
}

const fakeManager = new FakePiManager();

const layer = it.layer(
  makePiAdapterLive({ manager: fakeManager as unknown as PiRpcManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("PiAdapterLive", (it) => {
  it.effect("emits session lifecycle events when a Pi session starts", () =>
    Effect.gen(function* () {
      fakeManager.startSessionImpl.mockClear();
      const adapter = yield* PiAdapter;

      const session = yield* adapter.startSession({
        provider: "pi",
        threadId: asThreadId("thread-1"),
        model: "openai/gpt-5",
        runtimeMode: "full-access",
      });
      const events = Array.from(
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect),
      );

      assert.equal(session.provider, "pi");
      assert.deepStrictEqual(events.map((event) => event.type), [
        "session.started",
        "session.configured",
        "thread.started",
      ]);
    }),
  );

  it.effect("maps Pi RPC runtime events into canonical provider events", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;

      yield* adapter.startSession({
        provider: "pi",
        threadId: asThreadId("thread-2"),
        model: "openai/gpt-5",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-2"),
        input: "hello",
        attachments: [],
      });

      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "turn_start",
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        model: "openai/gpt-5",
        payload: {
          type: "message_update",
          message: { role: "assistant", content: "hello from pi" },
          assistantMessageEvent: { type: "text_delta", delta: "hello from pi" },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "read_file",
          args: { path: "README.md" },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "read_file",
          result: { ok: true },
          isError: false,
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "turn_end",
          message: { role: "assistant", content: "hello from pi" },
          toolResults: [],
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-2"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "agent_end",
          messages: [],
        },
      });

      const events = Array.from(
        yield* Stream.take(adapter.streamEvents, 6).pipe(Stream.runCollect),
      );

      assert.deepStrictEqual(events.map((event) => event.type), [
        "turn.started",
        "content.delta",
        "item.started",
        "item.completed",
        "item.completed",
        "turn.completed",
      ]);
      const deltaEvent = events.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type !== "content.delta") {
        return;
      }
      assert.equal(deltaEvent.payload.delta, "hello from pi");
      const turnCompletedEvent = events.at(-1);
      assert.equal(turnCompletedEvent?.type, "turn.completed");
      if (turnCompletedEvent?.type !== "turn.completed") {
        return;
      }
      assert.equal(turnCompletedEvent.payload.state, "completed");
    }),
  );
});
