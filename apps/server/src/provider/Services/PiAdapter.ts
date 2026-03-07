/**
 * PiAdapter - Pi implementation of the generic provider adapter contract.
 *
 * This service owns Pi RPC process semantics and emits canonical provider
 * runtime events without leaking Pi-specific transport details upstream.
 *
 * @module PiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "pi";
}

export class PiAdapter extends ServiceMap.Service<PiAdapter, PiAdapterShape>()(
  "t3/provider/Services/PiAdapter",
) {}
