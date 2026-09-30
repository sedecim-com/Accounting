import { ContalinkAdapter } from './contalink-adapter.js';
import {
  assertExternalCredentialUsable,
  withExternalCredential,
  type EntityRef,
} from './entity-credentials.js';
import type { IExternalAccountingAdapter } from './accounting-adapter.interface.js';

// ============================================================
// Registry of external accounting systems. Each adapter is built
// with the key of the entity it acts for (external_system_credentials
// + vault, #357): there is no process-wide key, so an entity's read
// or write can only reach its own company (ADR-0004: one writer per
// Contalink company, identified by RFC).
//   contalink → the entity's key (+ optional CONTALINK_BASE_URL)
// ============================================================

const FACTORIES: Record<string, (apiKey: string) => IExternalAccountingAdapter> = {
  contalink: (apiKey) => new ContalinkAdapter(apiKey, process.env.CONTALINK_BASE_URL || undefined),
};

export function listExternalSystems(): string[] {
  return Object.keys(FACTORIES);
}

function factoryFor(name: string): (apiKey: string) => IExternalAccountingAdapter {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown external accounting system: "${name}". Available: ${listExternalSystems().join(', ')}`
    );
  }
  return factory;
}

/**
 * The adapter could be built for this entity: the system exists and the
 * entity holds an active key for its own RFC. Reads metadata only, never
 * the vault — for callers that validate now and call out later.
 */
export async function assertExternalAdapterUsable(entity: EntityRef, name: string): Promise<void> {
  factoryFor(name);
  await assertExternalCredentialUsable(entity, name);
}

export async function getExternalAdapter(
  entity: EntityRef,
  name: string
): Promise<IExternalAccountingAdapter> {
  return withExternalCredential(entity, name, factoryFor(name));
}
