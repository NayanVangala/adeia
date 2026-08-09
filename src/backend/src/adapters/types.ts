/**
 * The seam between Adeia and a third-party API. Adapters are the *only* place
 * in the codebase that talks to an outside service.
 *
 * An adapter is reached exclusively through the `approved → executing`
 * transition. There is no path from `pending_approval` to an adapter, which is
 * what makes "the agent cannot spend money while a human is still deciding" a
 * structural property rather than a promise.
 */

export interface AdapterContext {
  actionId: string;
  /**
   * The caller's idempotency key, passed through to the third party so their
   * own deduplication can catch a retry that got past our unique index.
   */
  idempotencyKey: string;
}

export interface Adapter {
  /** Which action type this adapter handles, e.g. "payment". */
  type: string;
  /**
   * Implementation name, e.g. "ledger" or "fake". Distinct from `type` so the
   * audit trail can record *which* integration ran, not just what kind of
   * action it was — swapping one processor for another has to be visible, and
   * so does running with none.
   */
  name: string;
  execute(params: unknown, ctx: AdapterContext): Promise<Record<string, unknown>>;
}

/** Keyed by action type. One adapter per type. */
export type AdapterRegistry = Map<string, Adapter>;

export function createRegistry(adapters: Adapter[]): AdapterRegistry {
  const registry: AdapterRegistry = new Map();
  for (const adapter of adapters) {
    if (registry.has(adapter.type)) {
      throw new Error(`two adapters registered for action type "${adapter.type}"`);
    }
    registry.set(adapter.type, adapter);
  }
  return registry;
}
