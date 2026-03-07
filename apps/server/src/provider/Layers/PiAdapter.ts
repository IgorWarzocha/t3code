/**
 * PiAdapterLive - Scoped live implementation for the Pi provider adapter.
 *
 * Wraps `PiRpcManager` behind the generic provider adapter contract and maps
 * Pi RPC failures into the shared provider adapter error algebra.
 *
 * @module PiAdapterLive
 */
import { randomUUID } from "node:crypto";

import {
  EventId,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
  type ProviderRuntimeEvent,
  type RuntimeItemStatus,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, ServiceMap, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  PiRpcManager,
  type PiRpcManagerEvent,
  type PiRpcManagerStartSessionInput,
} from "../../piRpcManager.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = "pi" as const;

export interface PiAdapterLiveOptions {
  readonly manager?: PiRpcManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => PiRpcManager;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown pi rpc thread") || normalized.includes("unknown pi thread")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function piModelFromResumeCursor(resumeCursor: unknown): string | undefined {
  const resume = asRecord(resumeCursor);
  const provider = asString(resume?.modelProvider);
  const modelId = asString(resume?.modelId);
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

function piThinkingLevelFromResumeCursor(resumeCursor: unknown): string | undefined {
  return asString(asRecord(resumeCursor)?.thinkingLevel);
}

function makeEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: string;
}) {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
  } as const;
}

function summarizeUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 0 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function collectPiTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPiTextFragments(entry));
  }

  const record = value as Record<string, unknown>;
  if (record.type === "text") {
    const text = asString(record.text);
    return text && text.length > 0 ? [text] : [];
  }
  if (record.type === "thinking" || record.type === "redacted_thinking") {
    return [];
  }

  if ("content" in record) {
    return collectPiTextFragments(record.content);
  }

  return [];
}

function extractPiAssistantText(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) {
    const direct = summarizeUnknown(message);
    return direct === "[]" || direct === "{}" ? undefined : direct;
  }

  const content = collectPiTextFragments(record.content);
  if (content.length > 0) {
    const text = content.join("");
    return text.trim().length > 0 ? text : undefined;
  }

  const directText = asString(record.text);
  if (directText?.trim()) {
    return directText;
  }

  return undefined;
}

function assistantTurnKey(threadId: ThreadId, turnId?: TurnId): string {
  return `${threadId}:${turnId ?? "session"}`;
}

function completeAssistantMessageEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly message: unknown;
}): ProviderRuntimeEvent {
  const assistantText = extractPiAssistantText(input.message);
  return {
    type: "item.completed",
    ...makeEventBase({
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      itemId: assistantItemId(input.threadId, input.turnId),
    }),
    payload: {
      itemType: "assistant_message",
      status: "completed",
      title: "Assistant message",
      ...(assistantText ? { detail: assistantText } : {}),
      data: input.message,
    },
  };
}

function assistantItemId(threadId: ThreadId, turnId?: TurnId): string {
  return `pi-assistant:${threadId}:${turnId ?? "session"}`;
}

function toolItemId(toolCallId: unknown, toolName: unknown): string {
  const suffix = asString(toolCallId) ?? asString(toolName) ?? randomUUID();
  return `pi-tool:${suffix}`;
}

function toolLifecycleEvent<TType extends "item.started" | "item.updated" | "item.completed">(
  input: {
    readonly type: TType;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | undefined;
    readonly toolCallId?: unknown;
    readonly toolName?: unknown;
    readonly detail?: unknown;
    readonly data?: unknown;
    readonly status?: RuntimeItemStatus;
  },
): Extract<ProviderRuntimeEvent, { type: TType }> {
  const title = asString(input.toolName)?.trim() || "Tool call";
  return {
    type: input.type,
    ...makeEventBase({
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      itemId: toolItemId(input.toolCallId, input.toolName),
    }),
    payload: {
      itemType: "dynamic_tool_call",
      ...(input.status ? { status: input.status } : {}),
      title,
      ...(summarizeUnknown(input.detail) ? { detail: summarizeUnknown(input.detail) } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    },
  } as Extract<ProviderRuntimeEvent, { type: TType }>;
}

function mapManagerEventToRuntimeEvents(
  event: PiRpcManagerEvent,
  abortingTurnIds: Map<ThreadId, string>,
  completedAssistantTurns: Set<string>,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.kind) {
    case "stderr":
      return [
        {
          type: "runtime.warning",
          ...makeEventBase({
            threadId: event.threadId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          }),
          payload: {
            message: event.line.trim() || "Pi RPC stderr output",
          },
        },
      ];
    case "stdout-parse-error":
      return [
        {
          type: "runtime.warning",
          ...makeEventBase({ threadId: event.threadId }),
          payload: {
            message: "Pi RPC emitted malformed JSON.",
            detail: { line: event.line },
          },
        },
      ];
    case "exit": {
      if (event.expected) {
        return [
          {
            type: "session.exited",
            ...makeEventBase({
              threadId: event.threadId,
              ...(event.turnId ? { turnId: event.turnId } : {}),
            }),
            payload: {
              reason: "Pi session stopped",
              recoverable: true,
              exitKind: "graceful",
            },
          },
        ];
      }
      return [
        {
          type: "runtime.error",
          ...makeEventBase({
            threadId: event.threadId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          }),
          payload: {
            message: `Pi RPC process exited unexpectedly (${event.code ?? "signal"}${event.signal ? `:${event.signal}` : ""}).`,
            class: "transport_error",
          },
        },
      ];
    }
    case "rpc-event": {
      const payload = event.payload;
      switch (payload.type) {
        case "turn_start":
          completedAssistantTurns.delete(assistantTurnKey(event.threadId, event.turnId));
          return [
            {
              type: "turn.started",
              ...makeEventBase({
                threadId: event.threadId,
                ...(event.turnId ? { turnId: event.turnId } : {}),
              }),
              payload: event.model ? { model: event.model } : {},
            },
          ];
        case "message_update": {
          const assistantMessageEvent = asRecord(payload.assistantMessageEvent);
          const assistantType = asString(assistantMessageEvent?.type);
          const assistantItem = assistantItemId(event.threadId, event.turnId);
          if (assistantType === "text_delta") {
            const delta = asString(assistantMessageEvent?.delta);
            if (!delta) {
              return [];
            }
            return [
              {
                type: "content.delta",
                ...makeEventBase({
                  threadId: event.threadId,
                  ...(event.turnId ? { turnId: event.turnId } : {}),
                  itemId: assistantItem,
                }),
                payload: {
                  streamKind: "assistant_text",
                  delta,
                },
              },
            ];
          }
          if (assistantType === "thinking_delta") {
            const delta = asString(assistantMessageEvent?.delta);
            if (!delta) {
              return [];
            }
            return [
              {
                type: "content.delta",
                ...makeEventBase({
                  threadId: event.threadId,
                  ...(event.turnId ? { turnId: event.turnId } : {}),
                  itemId: assistantItem,
                }),
                payload: {
                  streamKind: "reasoning_text",
                  delta,
                },
              },
            ];
          }
          if (assistantType === "error") {
            return [
              {
                type: "runtime.error",
                ...makeEventBase({
                  threadId: event.threadId,
                  ...(event.turnId ? { turnId: event.turnId } : {}),
                }),
                payload: {
                  message:
                    asString(assistantMessageEvent?.reason) ??
                    asString(assistantMessageEvent?.error) ??
                    "Pi assistant message failed.",
                  class: "provider_error",
                  detail: payload,
                },
              },
            ];
          }
          if (assistantType === "done") {
            const assistantText = extractPiAssistantText(payload.message);
            if (!assistantText) {
              return [];
            }
            return [
              {
                type: "content.delta",
                ...makeEventBase({
                  threadId: event.threadId,
                  ...(event.turnId ? { turnId: event.turnId } : {}),
                  itemId: assistantItem,
                }),
                payload: {
                  streamKind: "assistant_text",
                  delta: assistantText,
                },
              },
            ];
          }
          return [];
        }
        case "message_end": {
          const message = asRecord(payload.message);
          if (asString(message?.role) !== "assistant") {
            return [];
          }
          completedAssistantTurns.add(assistantTurnKey(event.threadId, event.turnId));
          return [
            completeAssistantMessageEvent({
              threadId: event.threadId,
              turnId: event.turnId,
              message: payload.message,
            }),
          ];
        }
        case "tool_execution_start":
          return [
            toolLifecycleEvent({
              type: "item.started",
              threadId: event.threadId,
              turnId: event.turnId,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              detail: payload.args,
              data: payload,
              status: "inProgress",
            }),
          ];
        case "tool_execution_update":
          return [
            toolLifecycleEvent({
              type: "item.updated",
              threadId: event.threadId,
              turnId: event.turnId,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              detail: payload.partialResult,
              data: payload,
              status: "inProgress",
            }),
          ];
        case "tool_execution_end": {
          const isError = payload.isError === true;
          return [
            toolLifecycleEvent({
              type: "item.completed",
              threadId: event.threadId,
              turnId: event.turnId,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              detail: payload.result,
              data: payload,
              status: isError ? "failed" : "completed",
            }),
          ];
        }
        case "turn_end": {
          const completedEvents: ProviderRuntimeEvent[] = [];
          const assistantTurnId = assistantTurnKey(event.threadId, event.turnId);
          if (!completedAssistantTurns.has(assistantTurnId)) {
            completedEvents.push(
              completeAssistantMessageEvent({
                threadId: event.threadId,
                turnId: event.turnId,
                message: payload.message,
              }),
            );
          }
          completedAssistantTurns.delete(assistantTurnId);

          const abortingTurnId = abortingTurnIds.get(event.threadId);
          const interrupted =
            abortingTurnId !== undefined &&
            (abortingTurnId === "*" || abortingTurnId === event.turnId);
          if (interrupted) {
            abortingTurnIds.delete(event.threadId);
          }
          completedEvents.push({
            type: "turn.completed",
            ...makeEventBase({
              threadId: event.threadId,
              ...(event.turnId ? { turnId: event.turnId } : {}),
            }),
            payload: {
              state: interrupted ? "interrupted" : "completed",
              stopReason: interrupted ? "abort" : null,
            },
          });
          return completedEvents;
        }
        case "agent_end": {
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          let assistantMessage: unknown = null;
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (asString(asRecord(message)?.role) === "assistant") {
              assistantMessage = message;
              break;
            }
          }
          const assistantTurnId = assistantTurnKey(event.threadId, event.turnId);
          if (!assistantMessage || completedAssistantTurns.has(assistantTurnId)) {
            return [];
          }
          completedAssistantTurns.add(assistantTurnId);
          return [
            completeAssistantMessageEvent({
              threadId: event.threadId,
              turnId: event.turnId,
              message: assistantMessage,
            }),
          ];
        }
        default:
          return [];
      }
    }
  }
}

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        const services = yield* Effect.services<never>();
        return options?.makeManager?.(services) ?? new PiRpcManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const abortingTurnIds = new Map<ThreadId, string>();
    const completedAssistantTurns = new Set<string>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const services = yield* Effect.services<never>();
        const unsubscribe = manager.subscribe((event) =>
          Queue.offerAll(
            runtimeEventQueue,
            mapManagerEventToRuntimeEvents(event, abortingTurnIds, completedAssistantTurns),
          ).pipe(Effect.asVoid, Effect.runPromiseWith(services)),
        );
        return unsubscribe;
      }),
      (unsubscribe) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            unsubscribe();
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    const startSession: PiAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: PiRpcManagerStartSessionInput = {
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.modelOptions?.pi?.thinkingLevel !== undefined
          ? { thinkingLevel: input.modelOptions.pi.thinkingLevel }
          : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions?.pi !== undefined
          ? {
              providerOptions: {
                pi: {
                  ...(input.providerOptions.pi.binaryPath !== undefined
                    ? { binaryPath: input.providerOptions.pi.binaryPath }
                    : {}),
                  ...(input.providerOptions.pi.agentDir !== undefined
                    ? { agentDir: input.providerOptions.pi.agentDir }
                    : {}),
                },
              },
            }
          : {}),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Pi adapter session."),
            cause,
          }),
      }).pipe(
        Effect.tap((session) => {
          const sessionEvents: ProviderRuntimeEvent[] = [
            {
              type: "session.started",
              ...makeEventBase({ threadId: session.threadId }),
              payload: {
                message: "Pi session started",
                ...(session.resumeCursor !== undefined ? { resume: session.resumeCursor } : {}),
              },
            },
            {
              type: "session.configured",
              ...makeEventBase({ threadId: session.threadId }),
              payload: {
                config: {
                  runtimeMode: session.runtimeMode,
                  ...(session.cwd ? { cwd: session.cwd } : {}),
                  ...(piModelFromResumeCursor(session.resumeCursor) ?? session.model
                    ? { model: piModelFromResumeCursor(session.resumeCursor) ?? session.model }
                    : {}),
                  ...(piThinkingLevelFromResumeCursor(session.resumeCursor)
                    ? { thinkingLevel: piThinkingLevelFromResumeCursor(session.resumeCursor) }
                    : {}),
                },
              },
            },
            {
              type: "thread.started",
              ...makeEventBase({ threadId: session.threadId }),
              payload:
                asString(asRecord(session.resumeCursor)?.sessionId) !== undefined
                  ? {
                      providerThreadId: asString(asRecord(session.resumeCursor)?.sessionId),
                    }
                  : {},
            },
          ];
          return Queue.offerAll(runtimeEventQueue, sessionEvents);
        }),
      );
    };

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError((cause) => toRequestError(input.threadId, "turn/prompt", cause)),
              );
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          { concurrency: 1 },
        );

        const result = yield* Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelOptions?.pi?.thinkingLevel !== undefined
                ? { thinkingLevel: input.modelOptions.pi.thinkingLevel }
                : {}),
              ...(images.length > 0 ? { images } : {}),
            }),
          catch: (cause) => toRequestError(input.threadId, "turn/prompt", cause),
        });

        yield* Queue.offer(
          runtimeEventQueue,
          {
            type: "turn.started",
            ...makeEventBase({
              threadId: input.threadId,
              turnId: result.turnId,
            }),
            payload: input.model ? { model: input.model } : {},
          } satisfies ProviderRuntimeEvent,
        );

        return result;
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise({
        try: async () => {
          abortingTurnIds.set(threadId, turnId ?? "*");
          await manager.interruptTurn(threadId);
        },
        catch: (cause) => {
          abortingTurnIds.delete(threadId);
          return toRequestError(threadId, "turn/abort", cause);
        },
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: `Pi does not support approval requests for thread '${threadId}'.`,
        }),
      );

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: `Pi interactive user input is not wired in this adapter for thread '${threadId}'.`,
        }),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.stopSession(threadId),
        catch: (cause) => toRequestError(threadId, "session/stop", cause),
      });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
