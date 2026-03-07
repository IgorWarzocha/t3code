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
          ...(input.model ? { modelProvider: "openai-codex", modelId: "gpt-5.4" } : {}),
          ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
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

layer("PiAdapterLive Pi-specific behavior", (it) => {
  it.effect("forwards Pi thinking level through session start and turn dispatch", () =>
    Effect.gen(function* () {
      fakeManager.startSessionImpl.mockClear();
      fakeManager.sendTurnImpl.mockClear();
      const adapter = yield* PiAdapter;

      yield* adapter.startSession({
        provider: "pi",
        threadId: asThreadId("thread-pi-options"),
        model: "openai-codex/gpt-5.4",
        modelOptions: {
          pi: {
            thinkingLevel: "xhigh",
          },
        },
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-pi-options"),
        input: "hello",
        modelOptions: {
          pi: {
            thinkingLevel: "minimal",
          },
        },
      });

      assert.equal(fakeManager.startSessionImpl.mock.calls.length, 1);
      assert.equal(fakeManager.sendTurnImpl.mock.calls.length, 1);
      assert.equal(fakeManager.startSessionImpl.mock.calls[0]?.[0]?.thinkingLevel, "xhigh");
      assert.equal(fakeManager.sendTurnImpl.mock.calls[0]?.[0]?.thinkingLevel, "minimal");
    }),
  );

  it.effect("extracts visible assistant text from structured Pi message completion", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;

      yield* adapter.startSession({
        provider: "pi",
        threadId: asThreadId("thread-pi-structured"),
        model: "openai-codex/gpt-5.4",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-pi-structured"),
        input: "hello",
      });

      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-structured"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "turn_start",
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-structured"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                text: "hidden reasoning",
              },
              {
                type: "text",
                text: "hello from pi",
              },
            ],
          },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-structured"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "hello from pi",
              },
            ],
          },
          toolResults: [],
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-structured"),
        turnId: asTurnId("turn-1"),
        payload: {
          type: "agent_end",
          messages: [],
        },
      });

      const events = Array.from(
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect),
      );

      assert.deepStrictEqual(events.map((event) => event.type), [
        "turn.started",
        "item.completed",
        "turn.completed",
      ]);
      const completionEvent = events[1];
      assert.equal(completionEvent?.type, "item.completed");
      if (completionEvent?.type !== "item.completed") {
        return;
      }
      assert.equal(completionEvent.payload.detail, "hello from pi");
    }),
  );
});
