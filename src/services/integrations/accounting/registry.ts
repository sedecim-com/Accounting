import { ContalinkAdapter } from './contalink-adapter.js';
import type { IExternalAccountingAdapter } from './accounting-adapter.interface.js';

// ============================================================
// Registry of external accounting systems. Credentials via
// environment variables (consistent with the CLI profiles):
//   contalink → CONTALINK_API_KEY (+ optional CONTALINK_BASE_URL)
// ============================================================

const FACTORIES: Record<string, () => IExternalAccountingAdapter> = {
  contalink: () => {
    const apiKey = process.env.CONTALINK_API_KEY;
    if (!apiKey) {
      throw new Error(
        'The "contalink" provider requires the CONTALINK_API_KEY environment variable (add it to your .env)'
      );
    }
    return new ContalinkAdapter(apiKey, process.env.CONTALINK_BASE_URL || undefined);
  },
};

export function listExternalSystems(): string[] {
  return Object.keys(FACTORIES);
}

export function getExternalAdapter(name: string): IExternalAccountingAdapter {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown external accounting system: "${name}". Available: ${listExternalSystems().join(', ')}`
    );
  }
  return factory();
}
