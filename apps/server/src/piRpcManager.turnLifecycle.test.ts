import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type FakeChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: [PassThrough, PassThrough, PassThrough];
  killed: boolean;
  kill: ChildProcessWithoutNullStreams["kill"];
};

function createFakeChild(): FakeChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as FakeChildProcess;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdio = [stdin, stdout, stderr];
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    const exitSignal = typeof signal === "string" ? signal : null;
    queueMicrotask(() => {
      child.emit("exit", 0, exitSignal);
    });
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

describe("PiRpcManager turn lifecycle", () => {
  it("keeps the same T3 turnId across Pi internal turns until agent_end", async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();

      child.stdin.on("data", (chunk) => {
        for (const rawLine of chunk.toString("utf8").trim().split("\n")) {
          if (!rawLine) continue;
          const command = JSON.parse(rawLine) as { id: string; type: string };

          if (command.type === "get_state") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "get_state",
                success: true,
                data: {
                  model: {
                    provider: "openai-codex",
                    id: "gpt-5.4",
                    name: "GPT-5.4",
                  },
                  sessionFile: "/tmp/pi-session.json",
                  sessionId: "pi-session-1",
                  thinkingLevel: "low",
                },
              })}\n`,
            );
            continue;
          }

          if (command.type === "set_model" || command.type === "set_thinking_level") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: command.type,
                success: true,
              })}\n`,
            );
            continue;
          }

          if (command.type === "prompt") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "prompt",
                success: true,
              })}\n`,
            );

            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
              child.stdout.write(
                `${JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "toolCall", name: "bash" }],
                  },
                })}\n`,
              );
              child.stdout.write(
                `${JSON.stringify({
                  type: "turn_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "toolCall", name: "bash" }],
                  },
                  toolResults: [],
                })}\n`,
              );
              child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
              child.stdout.write(
                `${JSON.stringify({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "final pi reply" }],
                  },
                })}\n`,
              );
              child.stdout.write(
                `${JSON.stringify({
                  type: "turn_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "final pi reply" }],
                  },
                  toolResults: [],
                })}\n`,
              );
              child.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [] })}\n`);
            });
          }
        }
      });

      return child as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();
    const threadId = ThreadId.makeUnsafe("pi-lifecycle-thread");
    const payloads: Array<{ type: string; turnId: string | undefined }> = [];

    manager.subscribe((event) => {
      if (event.kind !== "rpc-event") return;
      if (event.payload.type === "turn_start" || event.payload.type === "message_end" || event.payload.type === "turn_end" || event.payload.type === "agent_end") {
        payloads.push({
          type: event.payload.type,
          turnId: event.turnId,
        });
      }
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "low",
    });
    const started = await manager.sendTurn({
      threadId,
      input: "tool turn",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(payloads).toEqual([
      { type: "turn_start", turnId: started.turnId },
      { type: "message_end", turnId: started.turnId },
      { type: "turn_end", turnId: started.turnId },
      { type: "message_end", turnId: started.turnId },
      { type: "turn_end", turnId: started.turnId },
      { type: "agent_end", turnId: started.turnId },
    ]);
  });

  it("drops a failed startup session instead of leaving it registered", async () => {
    let child: FakeChildProcess | undefined;
    spawnMock.mockImplementation(() => {
      const childProcess = createFakeChild();
      child = childProcess;

      childProcess.stdin.on("data", (chunk) => {
        for (const rawLine of chunk.toString("utf8").trim().split("\n")) {
          if (!rawLine) continue;
          const command = JSON.parse(rawLine) as { id: string; type: string };

          if (command.type === "get_state") {
            childProcess.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "get_state",
                success: true,
                data: {
                  sessionFile: "/tmp/pi-session.json",
                  sessionId: "pi-session-1",
                },
              })}\n`,
            );
            continue;
          }

          if (command.type === "set_model") {
            childProcess.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "set_model",
                success: false,
                error: "bad model",
              })}\n`,
            );
          }
        }
      });

      return childProcess as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();
    const threadId = ThreadId.makeUnsafe("pi-failed-start");

    await expect(
      manager.startSession({
        threadId,
        runtimeMode: "full-access",
        model: "openai-codex/gpt-5.4",
      }),
    ).rejects.toThrow("bad model");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
    expect(child?.killed).toBe(true);
  });

  it("resets transient turn state after a failed send so the next turn can start cleanly", async () => {
    let getStateCount = 0;
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();

      child.stdin.on("data", (chunk) => {
        for (const rawLine of chunk.toString("utf8").trim().split("\n")) {
          if (!rawLine) continue;
          const command = JSON.parse(rawLine) as { id: string; type: string };

          if (command.type === "get_state") {
            getStateCount += 1;
            const shouldFailFollowUpState = getStateCount === 3;
            child.stdout.write(
              `${JSON.stringify(
                shouldFailFollowUpState
                  ? {
                      id: command.id,
                      type: "response",
                      command: "get_state",
                      success: false,
                      error: "state failed",
                    }
                  : {
                      id: command.id,
                      type: "response",
                      command: "get_state",
                      success: true,
                      data: {
                        model: {
                          provider: "openai-codex",
                          id: "gpt-5.4",
                          name: "GPT-5.4",
                        },
                        sessionFile: "/tmp/pi-session.json",
                        sessionId: "pi-session-1",
                        thinkingLevel: "low",
                      },
                    },
              )}\n`,
            );
            continue;
          }

          if (command.type === "set_model" || command.type === "set_thinking_level") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: command.type,
                success: true,
              })}\n`,
            );
            continue;
          }

          if (command.type === "prompt") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "prompt",
                success: true,
              })}\n`,
            );
          }
        }
      });

      return child as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();
    const threadId = ThreadId.makeUnsafe("pi-failed-send");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      model: "openai-codex/gpt-5.4",
      thinkingLevel: "low",
    });

    await expect(
      manager.sendTurn({
        threadId,
        input: "first turn",
      }),
    ).rejects.toThrow("state failed");

    expect(manager.listSessions()).toEqual([
      expect.objectContaining({
        threadId,
        status: "ready",
      }),
    ]);

    await expect(
      manager.sendTurn({
        threadId,
        input: "second turn",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        threadId,
      }),
    );
  });

  it("cleans up a failed session when the Pi CLI cannot start", async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn pi ENOENT"));
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();
    const threadId = ThreadId.makeUnsafe("pi-spawn-error");

    await expect(
      manager.startSession({
        threadId,
        runtimeMode: "full-access",
      }),
    ).rejects.toThrow("Pi RPC process failed to start (spawn pi ENOENT).");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.hasSession(threadId)).toBe(false);
    expect(manager.listSessions()).toEqual([]);
  });
});
