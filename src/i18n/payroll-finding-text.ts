import { t, type Language } from './index.js';
import type { HallazgoNomina } from '../services/payroll/mx/isn-calculator.js';

// MNE-001-815 · A payroll finding (`HallazgoNomina`, isn-calculator.ts) carries
// its message as a key; the surface renders it here, at the edge, because a
// service cannot know its reader's language. The caller names the language,
// with no default on purpose, as in cash-finding-text.ts.

/** The finding's message in `language`; each list param in that language too, joined with '; '. */
export function findingText(h: Pick<HallazgoNomina, 'mensaje' | 'lists'>, language: Language): string {
  if (typeof h.mensaje === 'string') return h.mensaje;
  const params: Record<string, string | number> = { ...h.mensaje.params };
  for (const [name, items] of Object.entries(h.lists ?? {})) {
    params[name] = items.map((i) => t(i.key, i.params ?? {}, language)).join('; ');
  }
  return t(h.mensaje.key, params, language);
}
