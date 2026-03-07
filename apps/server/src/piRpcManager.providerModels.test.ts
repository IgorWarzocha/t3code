import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

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

describe("PiRpcManager model discovery", () => {
  it("normalizes Pi RPC model catalog results and extracts the default model from get_state", async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();

      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            type: "extension_ui_request",
            id: "startup-notify",
            extensionName: "agent-manager",
            method: "notify",
            message: "Agent Manager loaded. Use /agents to configure.",
          })}\n`,
        );
      });

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
                    id: "gpt-5.3-codex",
                    name: "GPT-5.3 Codex",
                  },
                  sessionFile: "/tmp/pi-session.json",
                  sessionId: "pi-session-1",
                },
              })}\n`,
            );
            continue;
          }

          if (command.type === "get_available_models") {
            child.stdout.write(
              `${JSON.stringify({
                id: command.id,
                type: "response",
                command: "get_available_models",
                success: true,
                data: {
                  models: [
                    {
                      provider: "openai-codex",
                      id: "gpt-5.3-codex",
                      name: "GPT-5.3 Codex",
                    },
                    {
                      provider: "anthropic",
                      id: "claude-sonnet-4-20250514",
                      name: "Claude Sonnet 4",
                    },
                    {
                      provider: "anthropic",
                      id: "claude-sonnet-4-20250514",
                      name: "Claude Sonnet 4",
                    },
                  ],
                },
              })}\n`,
            );
          }
        }
      });

      return child as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();

    await expect(manager.discoverModels({ cwd: process.cwd() })).resolves.toEqual({
      defaultModel: "openai-codex/gpt-5.3-codex",
      models: [
        {
          slug: "openai-codex/gpt-5.3-codex",
          name: "GPT-5.3 Codex",
        },
        {
          slug: "anthropic/claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
        },
      ],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "pi",
      ["--mode", "rpc"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
        cwd: process.cwd(),
      }),
    );
  });

  it("surfaces Pi CLI spawn failures during model discovery", async () => {
    spawnMock.mockImplementation(() => {
      const child = createFakeChild();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn pi ENOENT"));
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });

    const { PiRpcManager } = await import("./piRpcManager.ts");
    const manager = new PiRpcManager();

    await expect(manager.discoverModels({ cwd: process.cwd() })).rejects.toThrow(
      "Pi RPC process failed to start (spawn pi ENOENT).",
    );
  });
});
