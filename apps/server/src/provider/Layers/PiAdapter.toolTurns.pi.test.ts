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

function isAssistantCompletion(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return event.type === "item.completed" && event.payload.itemType === "assistant_message";
}

function isToolCompletion(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> {
  return event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call";
}

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
      turnId: asTurnId("turn-tool"),
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

layer("PiAdapterLive tool-turn handling", (it) => {
  it.effect("suppresses empty tool-planning assistant completions and completes on agent_end", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;

      yield* adapter.startSession({
        provider: "pi",
        threadId: asThreadId("thread-pi-tools"),
        model: "openai-codex/gpt-5.4",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-pi-tools"),
        input: "tool turn",
      });

      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: { type: "turn_start" },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash" }],
          },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "pwd" },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: { ok: true },
          isError: false,
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash" }],
          },
          toolResults: [],
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final pi reply" }],
          },
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final pi reply" }],
          },
          toolResults: [],
        },
      });
      fakeManager.emit({
        kind: "rpc-event",
        threadId: asThreadId("thread-pi-tools"),
        turnId: asTurnId("turn-tool"),
        payload: {
          type: "agent_end",
          messages: [],
        },
      });

      const events = Array.from(
        yield* Stream.take(adapter.streamEvents, 6).pipe(Stream.runCollect),
      );

      const assistantCompletions = events.filter(isAssistantCompletion);
      const toolCompletions = events.filter(isToolCompletion);

      assert.equal(toolCompletions.length, 1);
      assert.equal(assistantCompletions.length, 1);
      assert.equal(assistantCompletions[0]?.payload.detail, "final pi reply");
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        true,
      );
    }),
  );
});
