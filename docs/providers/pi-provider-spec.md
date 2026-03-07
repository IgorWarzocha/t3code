# Pi Provider Spec

Status: draft handoff spec

Owner area:
- `apps/server`
- `apps/web`
- `packages/contracts`

Related context:
- T3 currently has a generic provider adapter layer, but `main` is still effectively Codex-only.
- Pi is a coding harness, not a raw LLM provider. The clean integration surface is Pi RPC mode, not Pi's in-process SDK.

## 1. Objective

Add **Pi** as a second harness provider in T3 Code.

This means:
- users can select `pi` as the thread provider
- the server can start and manage a Pi-backed session
- Pi events are translated into T3 canonical provider runtime events
- the web app can render Pi-backed turns through the existing orchestration/event pipeline

This does **not** mean:
- reworking T3 to use Pi as its primary runtime
- supporting every Pi feature on day one
- faking Codex-native semantics that Pi does not actually provide

## 2. Chosen approach

### 2.1 Integration boundary

Use **Pi RPC mode** via a spawned subprocess:

- spawn `pi --mode rpc`
- communicate over stdin/stdout JSON lines
- map RPC commands/events into T3's provider adapter contract

Do **not** use the Pi SDK for v1.

Reasoning:
- keeps the same process-boundary pattern as Codex
- avoids pulling Pi's package graph and runtime assumptions into `apps/server`
- isolates crashes, hangs, and dependency churn to a child process
- matches Pi's documented host integration surface

### 2.2 Product scope for v1

Ship a narrow, honest v1:

- supported: starting Pi sessions, sending prompts, streaming assistant/tool activity, aborting a run, resuming a session via persisted Pi session metadata, selecting Pi as the harness provider
- supported: selecting a Pi model through the existing T3 model-selection UX
- supported: Pi in `runtimeMode = "full-access"` only
- unsupported in v1:
  - `runtimeMode = "approval-required"`
  - provider-native approval request flows
  - Pi checkpoint rollback/read parity with Codex
  - dynamic Pi model discovery UX
  - Pi-specific settings beyond binary/config/session location

When unsupported behavior is requested, fail fast with explicit user-visible errors.

## 3. Constraints and design rules

### 3.1 Hard constraints

- No console errors.
- No silent capability downgrades.
- No pretending Pi supports provider approval flows.
- No backward-compatibility preservation work beyond what is needed for the new provider kind.
- Prefer a simple UI stub over partial dynamic model-management UI.

### 3.2 Architectural rules

- Keep Pi logic in a dedicated manager + adapter, not spread across orchestration.
- Keep orchestration provider-agnostic; only widen contracts where required.
- Preserve the current direction of travel: `wsServer -> orchestration -> provider service -> adapter`.
- Avoid coupling the web UI directly to Pi RPC details.
- Extend the existing composer `/model` and provider/model picker flow instead of inventing a new Pi-only slash-command system.
- Keep model selection provider-extensible so future providers can plug into the same UX and contracts.

## 4. Current-state summary

### 4.1 T3 today

Current T3 provider flow:

- transport/API calls go through orchestration
- provider lifecycle is routed through `ProviderService`
- provider implementations are hidden behind `ProviderAdapter`
- only `codex` is wired on `main`

Main current blockers:

- `ProviderKind` is still Codex-only
- provider session persistence only decodes `codex`
- model settings/options are Codex-shaped
- the web store coerces unknown providers back to Codex

### 4.2 Pi today

Pi provides:

- RPC mode with structured commands like `prompt`, `abort`, `set_model`, `get_state`, `switch_session`, `get_messages`, `get_available_models`
- streaming events such as `agent_start`, `turn_start`, `message_update`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `turn_end`, `agent_end`
- session persistence via session files / session IDs

Pi does **not** provide:

- Codex-style provider-native approval requests
- provider thread ids with the same semantics as Codex app-server
- a native T3-compatible checkpoint rollback API

## 5. Target behavior

### 5.1 Thread/session behavior

When a thread uses provider `pi`:

- starting the first turn starts a Pi RPC child process if none exists
- the adapter persists enough resume metadata to rebind the thread after server restart
- turns stream through the existing orchestration event pipeline
- abort requests stop the in-flight Pi agent run
- subsequent turns can reuse the same Pi session when possible

### 5.2 UX behavior

The web app must allow:

- selecting `pi` as a provider
- selecting a Pi model before sending a turn
- showing Pi thread activity in the existing chat/work log UI
- surfacing unsupported capability errors clearly

The web app does not need a complete Pi-native model-management UX in v1, but Pi model selection is required.

### 5.3 Failure behavior

Fail explicitly when:

- `pi` binary is missing
- Pi session startup fails
- Pi is selected in `approval-required` mode
- rollback/checkpoint actions are requested for Pi where unsupported
- persisted Pi resume data is invalid or stale

## 6. Public contract changes

## 6.1 Provider kind

Widen `ProviderKind` from:

- `codex`

To:

- `codex`
- `pi`

Files likely affected:
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/model.ts`

## 6.2 Provider settings

Add Pi provider settings for new sessions:

- `piBinaryPath?: string`
- `piAgentDir?: string`

These belong with server-side provider bootstrap settings, not ad hoc web-only state.

## 6.3 Model semantics

For v1, Pi model values are **opaque strings** persisted in `thread.model`.

Expected format:
- `provider/modelId`

Examples:
- `anthropic/claude-sonnet-4-20250514`
- `openai/gpt-5`

Rules:
- do not try to normalize Pi models through Codex-specific slug logic
- do not invent a Pi-only model-selection flow outside the existing provider/model picker architecture
- Pi must still be selectable through the existing `/model` composer command and provider/model picker
- allow Pi custom model entries in settings if needed for the existing picker flow

### 6.3.1 Model-selection architecture requirement

Pi model selection is a required part of this feature.

Implementation requirements:

- reuse the existing web composer `/model` flow and provider/model picker
- do not add provider-specific slash parsing in `wsServer`, orchestration, or the Pi adapter
- keep slash-command interception in the web layer
- make provider/model option sourcing extensible so future providers can register model options without reworking composer command behavior
- a Pi model selection may imply `provider = "pi"` plus `model = "<opaque-pi-model>"`

For v1, the acceptable UX is:

- Pi appears in provider selection
- `/model` suggestions can surface Pi models
- selecting a Pi model updates thread draft/provider state cleanly
- `thread.turn.start` carries normal `provider` and `model` fields to the server

Nice-to-have but not required in v1:

- a dedicated `/models` command
- dynamic Pi model refresh controls
- rich Pi-specific model capability badges

## 6.4 Runtime mode semantics

Pi supports only:

- `runtimeMode = "full-access"`

If `approval-required` is requested:

- session start must fail with a clear error
- error must be visible in orchestration/session state and the UI

## 7. Server design

### 7.1 New manager

Add a dedicated Pi RPC manager, for example:

- `apps/server/src/piRpcManager.ts`

Responsibilities:

- spawn and stop Pi child processes
- write RPC commands to stdin
- parse JSON lines from stdout
- correlate request/response ids
- track Pi session state per T3 thread
- expose a high-level API suitable for the provider adapter

Required manager operations:

- `startSession(...)`
- `sendTurn(...)`
- `interruptTurn(...)`
- `stopSession(...)`
- `listSessions()`
- `hasSession(threadId)`
- `readThread(threadId)` or equivalent synthesized snapshot
- `rollbackThread(threadId, numTurns)` returning unsupported for v1

### 7.2 New adapter

Add a Pi adapter, for example:

- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Services/PiAdapter.ts`

Responsibilities:

- implement `ProviderAdapter`
- translate Pi manager events into canonical `ProviderRuntimeEvent`s
- map Pi process/request failures into T3 `ProviderAdapterError`s

Suggested capabilities:

- `sessionModelSwitch: "in-session"`

Because Pi RPC exposes `set_model`.

### 7.2.1 Model-source integration

The Pi implementation must expose model options through the same provider-aware model-selection path used by the web app.

That means:

- define a clean provider-indexed model option source in shared/contracts code
- avoid Codex-only fallback assumptions in provider/model helpers
- make it possible for future providers to contribute model options without changing slash-command parsing behavior

For v1, either of these is acceptable:

- a static Pi model list sourced from settings or bootstrap configuration
- a provider-aware abstraction that can later be backed by Pi RPC `get_available_models`

The important part is that the abstraction is reusable and does not require redoing `/model` UX when another provider is added.

### 7.3 Event mapping

Map Pi RPC events into T3 canonical runtime events conservatively.

Suggested minimum mapping:

- Pi `agent_start`
  - emit `session.state.changed` -> `running` if needed
- Pi `turn_start`
  - emit `turn.started`
- Pi `message_update` for assistant text deltas
  - emit `content.delta`
- Pi `tool_execution_start`
  - emit `item.started`
- Pi `tool_execution_update`
  - emit `item.updated`
- Pi `tool_execution_end`
  - emit `item.completed`
- Pi `turn_end`
  - emit `turn.completed` or `turn.aborted` based on stop/error state
- Pi `agent_end`
  - emit `session.state.changed` -> `ready`

Rules:
- synthesize only events that T3 can defend semantically
- do not invent approval events
- do not emit fake provider thread ids if none exist

### 7.4 Resume semantics

Persist Pi resume state in `resumeCursor`.

Suggested payload:

```json
{
  "sessionFile": "...",
  "sessionId": "...",
  "modelProvider": "...",
  "modelId": "...",
  "cwd": "..."
}
```

Recovery strategy:

- if the adapter still owns an active in-memory Pi session for the thread, adopt it
- otherwise start a new Pi RPC process and switch/open the persisted session if possible
- if recovery fails, surface an explicit recovery error and require a fresh session

### 7.5 Health checks

Extend provider health to include Pi.

Minimum health probe:

- `pi --version`

Pi health should report:

- binary available / unavailable
- optional version string

Do not attempt to derive a single auth truth for Pi, because Pi can use many underlying providers.

## 8. Web/UI design

### 8.1 Provider selection

Add `pi` as an available provider in the provider picker.

The picker should no longer rely on placeholder-only fake future providers for this case.

### 8.2 Model UX

For v1:

- permit Pi model values as opaque strings
- reuse the existing `/model` composer flow and provider/model picker
- reuse existing custom-model settings patterns if needed
- do not block the feature on dynamic model discovery UI

Acceptable v1 UI:

- Pi appears as a provider
- Pi threads can retain or edit a custom model string
- Pi models can be selected through the same provider/model state flow used by other providers

Not required in v1:

- live Pi `get_available_models` integration in the picker
- a separate Pi-specific slash command parser

### 8.3 Unsupported actions

If a Pi thread triggers unsupported functionality:

- rollback/checkpoint actions should be disabled or fail with a clear message
- approval-required mode should show a precise unsupported message

## 9. Test strategy

Required tests:

### 9.1 Contracts

- `ProviderKind` decodes `pi`
- Pi settings/model fields decode correctly

### 9.2 Server unit tests

- Pi adapter start/send/interrupt/stop flows
- Pi RPC manager request/response correlation
- event translation from Pi RPC events to canonical runtime events
- recovery behavior with persisted `resumeCursor`
- explicit failure for approval-required mode
- explicit failure for unsupported rollback

### 9.3 Orchestration integration tests

- Pi runtime events project into the existing thread/message/activity model
- Pi turn streaming produces assistant text and tool activity
- Pi session failure surfaces thread/session errors cleanly

### 9.4 Web tests

- provider picker shows `pi`
- store no longer coerces `pi` back to `codex`
- `/model` selection can choose a Pi model without bypassing the normal provider/model draft state
- provider/model selection helpers remain reusable for future providers
- unsupported Pi actions surface expected messaging

Validation gate before completion:

- `bun lint`
- `bun typecheck`

## 10. File-level implementation map

Likely touched files:

- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/model.ts`
- `apps/server/src/serverLayers.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/server/src/provider/Layers/ProviderHealth.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/store.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/routes/_chat.settings.tsx`

New files likely needed:

- `apps/server/src/piRpcManager.ts`
- `apps/server/src/piRpcManager.test.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Services/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiAdapter.test.ts`

## 11. Explicit non-goals

Do not do these in the first implementation:

- Pi SDK embedding
- dynamic Pi model-discovery UI
- approval-required emulation through Pi extensions
- Pi checkpoint parity
- generalized multi-harness refactor beyond what is needed for `pi`

## 12. Open risks

- Pi session resume may be weaker than Codex resume semantics.
- Pi event mapping may require synthesis for missing canonical event types.
- Model UX may remain rough until runtime model discovery is added.
- Pi's own underlying provider auth issues may be harder to reduce to a single health status.

## 13. Acceptance criteria

- T3 can create and run a Pi-backed thread in `full-access` mode.
- Pi can be selected as a provider in the web UI.
- Pi assistant/tool streaming reaches the chat timeline through orchestration events.
- Restart recovery works for the common persisted-session path.
- Unsupported Pi capabilities fail explicitly.
- `bun lint` and `bun typecheck` pass.

## 14. Coding-agent execution prompt

Use the prompt below as the implementation handoff.

```text
Implement Pi as a new harness provider in /home/igorw/Frameworks/t3code.

Read these first:
- docs/providers/pi-provider-spec.md
- docs/providers/pi-provider-todo.md
- apps/server/src/provider/Services/ProviderAdapter.ts
- apps/server/src/provider/Layers/ProviderService.ts
- apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
- apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
- apps/server/src/codexAppServerManager.ts
- pi-mono/packages/coding-agent/docs/rpc.md
- pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts

Goal:
- add Pi as provider kind `pi`
- integrate Pi through RPC mode, not the Pi SDK
- support Pi only in `runtimeMode = "full-access"` for v1
- wire Pi through the existing orchestration -> provider service -> adapter architecture

Hard requirements:
- no console errors
- fail fast on unsupported behavior
- do not emulate approval-required mode
- do not add half-built dynamic model discovery UI
- prefer simple, explicit UI behavior for Pi over broad abstraction work
- do not revert unrelated user changes

Required deliverables:
1. Widen contracts and state so `pi` is a real provider kind across server and web.
2. Add a dedicated Pi RPC manager that spawns `pi --mode rpc`, manages request ids, and parses stdout JSON.
3. Add a Pi provider adapter implementing the existing ProviderAdapter contract.
4. Register the Pi adapter in the provider registry/server layers.
5. Persist Pi resume state in `resumeCursor` using Pi session metadata.
6. Map Pi RPC events into canonical provider runtime events conservatively.
7. Update the web app so Pi is selectable and does not get coerced back to Codex.
8. Surface explicit unsupported errors for:
   - `approval-required` runtime mode
   - Pi rollback/checkpoint flows that are not supported in v1
9. Add focused tests for contracts, manager behavior, adapter mapping, orchestration ingestion, and web/store behavior.
10. Run `bun lint` and `bun typecheck`.

Scope decisions already made:
- Use RPC mode, not SDK embedding.
- Pi model values are opaque strings in `provider/modelId` form for v1.
- Pi health check is binary availability (`pi --version`), not unified auth validation.
- Pi rollback/checkpoint parity is out of scope for v1.
- Pi session model switch should be treated as supported in-session if practical through RPC `set_model`.

Implementation notes:
- Keep Pi logic isolated in new Pi-specific files.
- Preserve existing architecture direction.
- Reuse Codex adapter/manager patterns where helpful, but do not force Pi into Codex semantics.
- Synthesize only those runtime events that T3 can defend semantically.
- If a requested Pi capability is unsupported, return a typed failure and make it visible in thread/session state.

Validation:
- add/adjust tests before finalizing
- `bun lint`
- `bun typecheck`

Final output should summarize:
- branch/files changed
- any unsupported behavior left intentionally
- validation results
```
