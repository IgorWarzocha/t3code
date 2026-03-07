import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJSONStorage } from "zustand/middleware";

import { useComposerDraftStore } from "./composerDraftStore";

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key) {
      return storage.get(key) ?? null;
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key) {
      storage.delete(key);
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };
}

describe("composerDraftStore Pi thinking level", () => {
  const threadId = ThreadId.makeUnsafe("thread-pi-thinking");
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    const localStorage = createMemoryStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorage,
      configurable: true,
    });
    useComposerDraftStore.persist.setOptions({
      storage: createJSONStorage(() => localStorage),
    });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  afterEach(() => {
    useComposerDraftStore.persist.setOptions({
      storage: createJSONStorage(() => originalLocalStorage),
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  it("stores a Pi thinking level on the thread draft", () => {
    const store = useComposerDraftStore.getState();

    store.setPiThinkingLevel(threadId, "minimal");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.piThinkingLevel).toBe(
      "minimal",
    );
  });

  it("removes Pi thinking level state when reset to default", () => {
    const store = useComposerDraftStore.getState();

    store.setPiThinkingLevel(threadId, "high");
    store.setPiThinkingLevel(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});
