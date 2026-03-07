import assert from "node:assert/strict";

import {
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
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
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (input: PiRpcManagerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: input.threadId,
      turnId: asTurnId("turn-1"),
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

function isTurnCompleted(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> {
  return event.type === "turn.completed";
}

layer("PiAdapterLive abort cleanup", (it) => {
  it.effect("clears stale abort markers after exit before the next turn completes", () =>
    Effect.gen(function* () {
      fakeManager.startSessionImpl.mockClear();
      fakeManager.sendTurnImpl.mockClear();
      const adapter = yield* PiAdapter;
      const threadId = asThreadId("thread-pi-abort-exit");

      yield* adapter.startSession({
        provider: "pi",
        threadId,
        model: "openai-codex/gpt-5.4",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);

      yield* adapter.interruptTurn(threadId, undefined);
      fakeManager.emit({
        kind: "exit",
        threadId,
        turnId: asTurnId("turn-1"),
        expected: false,
        code: 1,
        signal: null,
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello again",
      });

      fakeManager.emit({
        kind: "rpc-event",
        threadId,
        turnId: asTurnId("turn-2"),
        payload: { type: "turn_start" },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId,
        turnId: asTurnId("turn-2"),
        payload: {
          type: "agent_end",
          messages: [],
        },
      });

      const events = Array.from(
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect),
      );
      const completion = events.find(isTurnCompleted);

      assert.equal(completion?.payload.state, "completed");
      assert.equal(completion?.payload.stopReason, null);
    }),
  );
});
