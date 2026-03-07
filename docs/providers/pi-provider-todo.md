# Pi Provider Todo

Status: implementation checklist

Linked spec:
- `docs/providers/pi-provider-spec.md`

## Phase 0: Freeze the implementation shape

- [ ] Re-read `docs/providers/pi-provider-spec.md` and keep scope to Pi RPC, not Pi SDK.
- [ ] Confirm v1 exclusions remain explicit:
  - approval-required mode unsupported
  - rollback/checkpoint parity unsupported
  - no dynamic model discovery UI
- [ ] Confirm Pi model selection is in scope and must reuse the existing `/model` and provider/model picker architecture.
- [ ] Audit all current Codex-only assumptions before editing:
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/provider.ts`
  - `packages/contracts/src/providerRuntime.ts`
  - `packages/contracts/src/model.ts`
  - `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
  - `apps/web/src/store.ts`
  - `apps/web/src/session-logic.ts`

## Phase 1: Widen contracts and state

- [ ] Update `packages/contracts/src/orchestration.ts` so `ProviderKind` includes `pi`.
- [ ] Update `packages/contracts/src/provider.ts` for Pi provider settings and any Pi-specific start inputs needed.
- [ ] Update `packages/contracts/src/providerRuntime.ts` only where Pi event translation needs broader provider/runtime support.
- [ ] Update `packages/contracts/src/model.ts` so provider-indexed maps can safely include Pi without Codex-specific fallback behavior.
- [ ] Generalize provider/model helper logic so Pi plugs into the same `/model` and picker flow future providers will use.
- [ ] Add or update contract tests covering `pi`.
- [ ] Update server-side provider-session persistence decoding in `apps/server/src/provider/Layers/ProviderSessionDirectory.ts` so `pi` is accepted.

Notes:
- Keep Pi model strings opaque in v1.
- Do not create a fake Codex-like built-in Pi model catalog unless absolutely necessary for typing.
- Do not reinvent slash-command handling for Pi; extend the existing provider-aware model-selection path.

## Phase 2: Add the Pi server runtime

### New manager

- [ ] Add `apps/server/src/piRpcManager.ts`.
- [ ] Add `apps/server/src/piRpcManager.test.ts`.
- [ ] Implement child-process lifecycle for `pi --mode rpc`.
- [ ] Implement JSON line parsing for mixed responses/events.
- [ ] Implement request-id correlation and timeout handling.
- [ ] Implement high-level manager methods:
  - `startSession`
  - `sendTurn`
  - `interruptTurn`
  - `stopSession`
  - `listSessions`
  - `hasSession`
  - `readThread` or synthesized equivalent
  - `rollbackThread` as explicit unsupported behavior for v1

### New adapter

- [ ] Add `apps/server/src/provider/Services/PiAdapter.ts`.
- [ ] Add `apps/server/src/provider/Layers/PiAdapter.ts`.
- [ ] Add `apps/server/src/provider/Layers/PiAdapter.test.ts`.
- [ ] Implement the `ProviderAdapter` contract for Pi.
- [ ] Map manager/process failures to typed provider adapter errors.
- [ ] Set Pi capabilities intentionally:
  - session model switch behavior
  - unsupported approval behavior

### Wiring

- [ ] Register Pi in `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`.
- [ ] Provide the Pi adapter from `apps/server/src/serverLayers.ts`.
- [ ] Extend provider health in `apps/server/src/provider/Layers/ProviderHealth.ts` with a Pi binary probe.
- [ ] Ensure Pi session startup honors selected `provider` and `model` from the standard turn metadata path, not Pi-specific slash parsing.

Notes:
- Keep Pi runtime code isolated from Codex files.
- Do not fold Pi into Codex manager abstractions.

## Phase 3: Event translation and orchestration integration

- [ ] Translate Pi RPC events into canonical provider runtime events.
- [ ] Ensure Pi assistant text streaming becomes `content.delta`.
- [ ] Ensure Pi tool lifecycle becomes `item.started` / `item.updated` / `item.completed`.
- [ ] Ensure Pi turn lifecycle becomes `turn.started` / `turn.completed` or `turn.aborted`.
- [ ] Ensure Pi session transitions become defensible `session.state.changed` events.
- [ ] Persist Pi `resumeCursor` using Pi session metadata.
- [ ] Recover Pi sessions on demand through `ProviderService` restart/recovery paths.
- [ ] Make `approval-required` mode fail explicitly during session startup or routing.
- [ ] Make unsupported rollback/checkpoint flows fail explicitly for Pi.

Files to verify:
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

## Phase 4: Web/UI support

- [ ] Add Pi as a real selectable provider in `apps/web/src/session-logic.ts`.
- [ ] Remove Codex fallback coercion for Pi in `apps/web/src/store.ts`.
- [ ] Ensure thread/session hydration preserves `pi` as provider identity.
- [ ] Update `apps/web/src/components/ChatView.tsx` so provider selection and provider status work with Pi.
- [ ] Extend the existing `/model` composer flow so Pi models can be selected without creating a separate Pi-only command path.
- [ ] Ensure provider/model draft state can represent Pi cleanly and remains reusable for future providers.
- [ ] Update `apps/web/src/routes/_chat.settings.tsx` with Pi-specific settings stubs:
  - binary path
  - agent/config dir
- [ ] Decide the minimum viable Pi model UX and implement only that:
  - custom/opaque model strings are acceptable
  - `/model` must be able to surface/select Pi models
  - selection must flow through normal provider/model state and `thread.turn.start`
- [ ] Disable or clearly fail unsupported Pi actions in the UI where needed.

Notes:
- Do not block the feature on polished dynamic Pi model discovery.
- Prefer an explicit simple control over an over-abstracted broken picker.
- Build the model-selection path so adding the next provider does not require reworking slash-command behavior again.

## Phase 5: Tests and hardening

- [ ] Add/adjust unit tests for contract widening.
- [ ] Add manager tests for JSON command/event handling, timeout behavior, and process exit handling.
- [ ] Add adapter tests for event translation and error mapping.
- [ ] Add orchestration integration coverage for Pi message/tool streaming.
- [ ] Add store/UI tests proving Pi is not coerced back to Codex.
- [ ] Add web tests proving Pi model selection works through the existing `/model` and provider/model picker flow.
- [ ] Add provider health coverage for Pi binary detection.
- [ ] Verify unsupported-mode tests exist:
  - Pi + approval-required
  - Pi rollback/checkpoint request

## Phase 6: Final verification

- [ ] Run `bun lint`.
- [ ] Run `bun typecheck`.
- [ ] Review changed files for scope creep.
- [ ] Confirm there are no console-error paths introduced for Pi.
- [ ] Confirm unsupported behavior remains explicit, not silently ignored.

## Done definition

- [ ] Pi can be selected as a provider.
- [ ] Pi models can be selected through the existing provider/model selection UX.
- [ ] Pi-backed turns stream through the existing orchestration UI.
- [ ] Pi startup/stop/recovery works for the common path.
- [ ] Unsupported Pi capabilities fail clearly.
- [ ] `bun lint` passes.
- [ ] `bun typecheck` passes.
