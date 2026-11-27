import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the platform speaks by key, part 13, second half (MNE-001-855, #150). Under es-MX `status` and
// `prompt-size` print Spanish from the catalogue, written here by hand before the code; the details and section
// labels their --json carries stay English, and the human table reads them back. The English was compared by a dump.

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn() }));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn(), resolveEntity: vi.fn(), inquilinoDeLaSesion: vi.fn(() => ({ origen: 'ninguno' })) }));

import { formatStatus, type StatusReport } from '../../src/cli/status-command.js';
import { computePromptBudget, formatPromptBudget } from '../../src/cli/prompt-size-command.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass };
afterEach(() => { resetLanguage(); });

describe('under es-MX, status speaks Spanish', () => {
  it('the sections, the computed label column, the probes and the details it reads back', () => {
    const report: StatusReport = {
      config: { source: null, provider: 'primary', model: 'm1', language: 'es', thresholds: { autoPost: true, minConfidence: 0.9, maxAmount: 5000, floorCap: 50000 } },
      database: { ok: false, detail: 'skipped: database unreachable' },
      rls: { active: false, detail: 'no tenant context (set --tenant or MNEMOSINE_TENANT to scope by RLS)' },
      providers: [
        { name: 'primary', type: 'openai-compatible', model: 'm1', keyEnv: 'K', keySet: false, credential: 'K', skipped: 'api_key_cmd failed to produce a credential' },
        { name: 'third', type: 'openai-compatible', model: 'm3', keyEnv: 'K', keySet: true, credential: 'K', probe: { name: 'third', ok: false, category: 'auth', detail: 'HTTP 401' } as never },
        { name: 'fourth', type: 'openai-compatible', model: 'm4', keyEnv: null, keySet: false, credential: 'local' },
      ],
    };
    setLanguage('es');
    const out = formatStatus(report, palette).join('\n');
    expect(out).toContain('Configuración\n');
    // The label column is as wide as its longest Spanish label («archivo de configuración», 24) plus three.
    expect(out).toContain(`  ${'archivo de configuración'.padEnd(27)}(ninguno: valores integrados)`);
    expect(out).toContain(`  ${'registro automático'.padEnd(27)}sí  confianza mínima 0.9  monto máximo 5000 (tope del piso 50000)`);
    expect(out).toContain(`  ${'conexión'.padEnd(27)}FALLA  omitido: base de datos inaccesible`);
    expect(out).toContain(`  ${'alcance RLS del despacho'.padEnd(27)}inactivo  sin contexto de despacho (define --tenant o MNEMOSINE_TENANT para acotar por RLS)`);
    expect(out).toContain('Proveedores\n');
    expect(out).toContain('prueba omitida (api_key_cmd no produjo una credencial)');
    expect(out).toContain('prueba FALLÓ [auth] HTTP 401');
    expect(out).toContain('sin probar');
    expect(out).toContain('Salida depurada: sin llaves, tokens ni rutas del directorio personal. Se puede compartir en tickets de soporte.');
    // A detail written with a parameter is data, and passes through.
    expect(formatStatus({ ...report, database: { ok: true, detail: 'unreachable (ECONNREFUSED)' } }, palette).join('\n')).toContain('ok  unreachable (ECONNREFUSED)');
  });
});

describe('under es-MX, prompt-size speaks Spanish', () => {
  it('the headings, the section labels read back, the marks and the totals, with --json English', () => {
    const tools = Array.from({ length: 11 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(i), input_schema: {} }));
    setLanguage('es');
    const budget = computePromptBudget({ role: 'r', docsIndex: 'd', chartOfAccounts: 'c', volatile: 'v' }, tools);
    expect(budget.sections.map((s) => s.label)).toEqual(['role instructions (stable)', 'docs index (stable)', 'chart of accounts (stable)', 'volatile block (entity + date)']);
    const out = formatPromptBudget(budget, palette).join('\n');
    expect(out).toContain('Presupuesto del prompt (estimación sin conexión, ~4 caracteres/token)');
    expect(out).toContain('Bloques del sistema');
    expect(out).toMatch(/ {2}instrucciones del rol \(estables\) +1 ch {2}~ +1 tok {2}\[en caché\]/);
    expect(out).toMatch(/ {2}bloque volátil \(entidad \+ fecha\) +1 ch {2}~ +1 tok {2}\[sin caché\]/);
    expect(out).toContain('Esquemas de herramientas (10 más grandes de 11, de mayor a menor)');
    expect(out).toContain('… 1 herramienta más');
    expect(out).toContain(`  ${'todas las herramientas (11)'.padEnd(34)} `);
    expect(out).toContain(`  ${'en caché (herramientas + estable)'.padEnd(34)} `);
    expect(out).toContain(`  ${'sin caché (volátil)'.padEnd(34)} `);
  });
});

describe('the lane', () => {
  it('counts no English string without a key in status and prompt-size, and only the risk declaration in anexo24', () => {
    const lane = (f: string) => { const rel = `src/cli/${f}-command.ts`; return englishUserStrings(fs.readFileSync(path.resolve(rel), 'utf8'), rel).map((s) => s.text); };
    for (const f of ['status', 'prompt-size']) expect(lane(f), f).toEqual([]);
    // `declareRisk({ llave: { innecesaria } })`: no screen prints it, like `writes` (riesgos-retrofit.ts). Part 14 rules on it.
    expect(lane('anexo24-migration')).toEqual([expect.stringContaining('the ledger refuses a second live opening')]);
  });
});
