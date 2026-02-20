import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ProviderEvent } from "@t3tools/contracts";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { useStore } from "../store";
import { onServerWelcome } from "../wsNativeApi";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
});

function RootRouteView() {
  const api = useNativeApi();

  if (!api) {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <StateSyncRouter />
        <BrowserDefaultProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function readProviderSeq(event: ProviderEvent): number | null {
  const seq = event.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) {
    return null;
  }
  return seq;
}

function StateSyncRouter() {
  const api = useNativeApi();
  const { dispatch } = useStore();
  const queryClient = useQueryClient();
  const activeAssistantItemRef = useRef<string | null>(null);
  const activeThreadId = useParams({
    strict: false,
    select: (params) => params.threadId,
  });
  const lastStateSeqRef = useRef(0);
  const stateQueueRef = useRef(Promise.resolve());
  const lastProviderSeqRef = useRef(0);
  const providerQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let retryDelayMs = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const bootstrap = async () => {
      try {
        const snapshot = await api.state.bootstrap();
        if (disposed) return;
        dispatch({
          type: "HYDRATE_FROM_SERVER",
          snapshot,
        });
        lastStateSeqRef.current = snapshot.lastStateSeq;
      } catch {
        if (disposed) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void bootstrap();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [api, dispatch]);

  useEffect(() => {
    if (!api) return;
    return api.state.onEvent((event) => {
      stateQueueRef.current = stateQueueRef.current
        .then(async () => {
          if (event.seq <= lastStateSeqRef.current) {
            return;
          }

          if (event.seq > lastStateSeqRef.current + 1) {
            const catchUp = await api.state.catchUp({ afterSeq: lastStateSeqRef.current });
            for (const missingEvent of catchUp.events) {
              if (missingEvent.seq <= lastStateSeqRef.current) continue;
              dispatch({
                type: "APPLY_STATE_EVENT",
                event: missingEvent,
              });
              lastStateSeqRef.current = missingEvent.seq;
            }
          }

          if (event.seq > lastStateSeqRef.current) {
            dispatch({
              type: "APPLY_STATE_EVENT",
              event,
            });
            lastStateSeqRef.current = event.seq;
          }
        })
        .catch(() => undefined);
    });
  }, [api, dispatch]);

  useEffect(() => {
    if (!api) return;
    const applyProviderEvent = (event: ProviderEvent) => {
      if (event.method === "turn/completed") {
        void invalidateGitQueries(queryClient);
      }
      if (event.method === "checkpoint/captured") {
        const payload = event.payload as { turnCount?: number } | undefined;
        const turnCount = payload?.turnCount;
        void queryClient.invalidateQueries({
          queryKey: ["providers", "checkpointDiff"] as const,
          predicate: (query) => {
            if (typeof turnCount !== "number") return true;
            return query.queryKey[5] === turnCount;
          },
        });
      }
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
        activeThreadId,
      });
    };

    const replayProviderCatchUp = async (): Promise<void> => {
      const catchUp = await api.providers.catchUp({
        afterSeq: lastProviderSeqRef.current,
      });
      if (catchUp.events.length === 0) {
        lastProviderSeqRef.current = Math.max(lastProviderSeqRef.current, catchUp.lastProviderSeq);
        return;
      }

      for (const missingEvent of catchUp.events) {
        const missingSeq = readProviderSeq(missingEvent);
        if (!missingSeq || missingSeq <= lastProviderSeqRef.current) continue;
        applyProviderEvent(missingEvent);
        lastProviderSeqRef.current = missingSeq;
      }

      if (lastProviderSeqRef.current < catchUp.lastProviderSeq) {
        await replayProviderCatchUp();
      }
    };

    const enqueueProviderWork = (work: () => Promise<void>) => {
      providerQueueRef.current = providerQueueRef.current.then(work).catch(() => undefined);
    };

    const unsubscribeWelcome = onServerWelcome(() => {
      if (lastProviderSeqRef.current <= 0) {
        return;
      }
      enqueueProviderWork(async () => {
        await replayProviderCatchUp();
      });
    });

    const unsubscribeProvider = api.providers.onEvent((event) => {
      enqueueProviderWork(async () => {
        const eventSeq = readProviderSeq(event);
        if (!eventSeq) {
          applyProviderEvent(event);
          return;
        }
        if (eventSeq <= lastProviderSeqRef.current) {
          return;
        }
        if (lastProviderSeqRef.current > 0 && eventSeq > lastProviderSeqRef.current + 1) {
          await replayProviderCatchUp();
        }
        if (eventSeq <= lastProviderSeqRef.current) {
          return;
        }
        applyProviderEvent(event);
        lastProviderSeqRef.current = eventSeq;
      });
    });

    return () => {
      unsubscribeWelcome();
      unsubscribeProvider();
    };
  }, [activeThreadId, api, dispatch, queryClient]);

  useEffect(() => {
    if (!api || !activeThreadId) return;
    const visitedAt = new Date().toISOString();
    dispatch({
      type: "MARK_THREAD_VISITED",
      threadId: activeThreadId,
      visitedAt,
    });
    void api.threads
      .markVisited({
        threadId: activeThreadId,
        visitedAt,
      })
      .catch(() => undefined);
  }, [activeThreadId, api, dispatch]);

  useEffect(() => {
    if (!api) return;
    return api.terminal.onEvent((event) => {
      dispatch({
        type: "APPLY_TERMINAL_EVENT",
        event,
      });
    });
  }, [api, dispatch]);

  return null;
}

function BrowserDefaultProjectBootstrap() {
  const api = useNativeApi();
  const { state } = useStore();
  const createdRef = useRef(false);

  useEffect(() => {
    if (isElectron || !api || !state.threadsHydrated) {
      return;
    }

    return onServerWelcome((payload) => {
      if (createdRef.current) {
        return;
      }

      const existing = state.projects.find((project) => project.cwd === payload.cwd);
      if (existing) {
        createdRef.current = true;
        return;
      }

      createdRef.current = true;
      void api.projects.add({ cwd: payload.cwd }).catch(() => {
        createdRef.current = false;
      });
    });
  }, [api, state.projects, state.threadsHydrated]);

  return null;
}
