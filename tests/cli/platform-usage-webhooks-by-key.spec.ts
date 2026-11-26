import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the platform speaks by key, part 13 (MNE-001-809, #150). Under es-MX the refusals, headings, columns, notes
// and verdicts of `usage`, `webhooks` and `compact` are Spanish from the catalogue, written here by hand before the
// code (the sweep's are in webhook-sweep-command.spec.ts); commands, flags, option values, paths, ids and amounts
// pass through untranslated, and --json keeps its bytes. The English was compared by a dump, before and after.

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', taxId: 'ESI010101AA1', country: 'MX', currency: 'MXN' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn(), resolveEntity: vi.fn(async () => CTX) }));
vi.mock('../../src/services/policy/today.js', async (o) => ({ ...(await o<Record<string, unknown>>()), zoneFor: vi.fn(async () => 'America/Mexico_City') }));
vi.mock('../../src/ai/usage-ledger.js', () => ({ summarizeUsage: vi.fn() }));
vi.mock('../../src/ai/webhooks/intake.js', async (o) => ({ ...(await o<Record<string, unknown>>()), issueWebhookToken: vi.fn(), listWebhookTokens: vi.fn(), disableWebhookToken: vi.fn(), listDeliveries: vi.fn() }));
vi.mock('../../src/ai/session-store.js', () => ({ getSession: vi.fn(async () => null), getSessionMessages: vi.fn(async () => []), latestSession: vi.fn(async () => null) }));

import { formatUsageTable, parseGroupBy, parseSince, registerUsageCommand } from '../../src/cli/usage-command.js';
import { registerWebhooksCommand } from '../../src/cli/webhooks-command.js';
import { formatCompactReport, registerCompactCommand } from '../../src/cli/compact-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';
import * as intake from '../../src/ai/webhooks/intake.js';

const m = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, yellow: pass };
afterEach(() => { resetLanguage(); });

async function es(...argv: string[]): Promise<string> {
  setLanguage('es');
  resetDeclarations();
  const program = new Command('mnemosine').exitOverride();
  let out = '';
  const deps = { palette, shutdown: async () => undefined as never,
    reportError: (e: unknown) => { const l = (e as { localized?: () => string }).localized; out += l ? l.call(e) : String(e); } };
  registerUsageCommand(program, deps);
  registerWebhooksCommand(program, deps);
  registerCompactCommand(program, deps);
  const w = (c: unknown) => { out += String(c); return true; };
  const spies = [vi.spyOn(process.stdout, 'write').mockImplementation(w), vi.spyOn(process.stderr, 'write').mockImplementation(w),
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += `${a.join(' ')}\n`; })];
  await program.parseAsync(['node', 'mnemosine', ...argv]).catch(() => undefined);
  for (const s of spies) s.mockRestore();
  return out;
}
const refusal = (f: () => unknown) => { try { f(); return ''; } catch (e) { return (e as { localized: () => string }).localized(); } };

describe('under es-MX, usage speaks Spanish', () => {
  it('the refusals of --since and --by, the heading, the columns and the unpriced note', () => {
    setLanguage('es');
    expect(refusal(() => parseSince('99999d'))).toBe('Valor de --since "99999d" no válido: las ventanas relativas llegan hasta 3650d.');
    expect(refusal(() => parseSince('ayer'))).toBe('Valor de --since "ayer" no válido. Usa Nd (p. ej. 7d, 30d) o AAAA-MM-DD.');
    expect(refusal(() => parseGroupBy('week'))).toBe('Valor de --by "week" no válido. Usa uno de: model, provider, day, session.');
    const row = { key: 'm-b', provider: 'anthropic', turns: 1, inputTokens: 1234, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedTurns: 1 };
    const totals = { ...row, costUsd: 0.5, unpricedTurns: 1 };
    const empty = formatUsageTable({ rows: [], totals } as never, 'day', palette).join('\n');
    expect(empty).toContain('Uso por day (los costos son estimaciones locales, no facturación)');
    expect(empty).toMatch(/ {2}tabla de precios al \d{4}-\d{2}-\d{2}: los proveedores cambian precios sin aviso/);
    expect(empty).toContain('No hay uso registrado para esta entidad en la ventana elegida.');
    const table = formatUsageTable({ rows: [row], totals } as never, 'model', palette).join('\n');
    expect(table).toContain(`  ${'MODEL'.padEnd(30)}     TURNOS    ENTRADA     SALIDA  CACHÉ LEC  CACHÉ ESC   USD EST.`);
    expect(table).toContain('sin precio');
    expect(table).toContain('1 turno en modelos que no están en la tabla local de precios: se cuentan los tokens y el costo queda fuera del total.');
  });
});

describe('under es-MX, webhooks speaks Spanish', () => {
  it('create, list, disable and deliveries, with --json unchanged', async () => {
    expect(await es('webhooks', 'create', 'w1', '--source', 'fax')).toContain('--source "fax" no válido. Usa uno de: bank_notification, sat_mailbox, generic.');
    m(intake.issueWebhookToken).mockResolvedValue({ token: { name: 'w1' }, rawToken: 'raw-token' });
    const created = await es('webhooks', 'create', 'w1');
    expect(created).toContain('Token de webhook "w1" creado (generic).');
    // The label column is as wide as its longest Spanish label (Encabezado:) plus two.
    expect(created).toContain('  Destino:     POST /v1/ai/webhooks/w1\n  Encabezado:  Authorization: Bearer raw-token');
    expect(created).toContain('GUARDA EL TOKEN AHORA. Se muestra sólo esta vez: la base de datos guarda sólo su hash y no se puede recuperar.');
    m(intake.listWebhookTokens).mockResolvedValue([]);
    expect(await es('webhooks', 'list')).toContain('No hay tokens de webhook. Crea uno con `mnemosine webhooks create <name>`.');
    m(intake.listWebhookTokens).mockResolvedValue([{ name: 'w2', source_kind: 'generic', enabled: false, last_used_at: null }]);
    const list = await es('webhooks', 'list');
    expect(list).toContain(`  ${'NOMBRE'.padEnd(24)}${'ORIGEN'.padEnd(20)}${'ESTADO'.padEnd(10)}ÚLTIMO USO`);
    expect(list).toContain(`  ${'w2'.padEnd(24)}${'generic'.padEnd(20)}${'inactivo'.padEnd(10)}nunca`);
    expect(await es('webhooks', 'list', '--json')).toContain('"enabled": false');
    m(intake.disableWebhookToken).mockResolvedValue(true);
    expect(await es('webhooks', 'disable', 'w1')).toContain('Token de webhook "w1" desactivado.');
    m(intake.disableWebhookToken).mockResolvedValue(false);
    expect(await es('webhooks', 'disable', 'w9')).toContain('No hay en esta entidad un token de webhook activo llamado "w9".');
    expect(await es('webhooks', 'deliveries', '--limit', 'x')).toContain('--limit "x" no válido: usa un número positivo.');
    m(intake.listDeliveries).mockResolvedValue([]);
    expect(await es('webhooks', 'deliveries')).toContain('No hay entregas de webhook registradas para esta entidad.');
    m(intake.listDeliveries).mockResolvedValue([{ received_at: new Date('2026-07-01T18:00:00Z'), token_name: 'w1', status: 'processed', drafts_created: 2, document_key: 'doc', suspicion: ['x'] }]);
    const deliveries = await es('webhooks', 'deliveries');
    // BORRADORES is wider than the English column of 8, so that column widens to fit it plus two.
    expect(deliveries).toContain(`  ${'RECIBIDA'.padEnd(18)}${'TOKEN'.padEnd(20)}${'ESTADO'.padEnd(11)}${'BORRADORES'.padEnd(12)}DOCUMENTO`);
    expect(deliveries).toContain(`${'processed'.padEnd(11)}${'2'.padEnd(12)}doc [contenido sospechoso]`);
  });
});

describe('under es-MX, compact speaks Spanish', () => {
  it('the missing session, the report and the note', async () => {
    expect(await es('compact')).toContain('Esta entidad todavía no tiene sesiones.');
    expect(await es('compact', '--session', 's9')).toContain('No se encontró la sesión en esta entidad.');
    setLanguage('es');
    const rep = { sessionId: 's1', title: null, messages: 1, totalTokens: 12345, keepRecentTokens: 8000 };
    const none = formatCompactReport({ ...rep, plan: null } as never, palette).join('\n');
    expect(none).toContain('Ensayo de compactación (estimación sin conexión, ~4 caracteres/token)');
    expect(none).toContain('  sesión        s1\n  transcripción 1 mensaje, ~12,345 tokens\n  cola reciente ~8,000 tokens (intactos)');
    expect(none).toContain('Nada que compactar: la transcripción cabe en el presupuesto de la cola reciente.');
    expect(none).toContain('Sólo ensayo: la compactación reescribe la vista en curso del MODELO, así que corre dentro del chat (/compact). La transcripción de Postgres nunca se modifica.');
    const plan = formatCompactReport({ ...rep, messages: 40, plan: { cutIndex: 39, dropTokens: 9000, keepTokens: 3345 } } as never, palette).join('\n');
    expect(plan).toContain('Un /compact real haría esto:');
    expect(plan).toContain('resumiría 39 mensajes antiguos (~9,000 tokens)');
    expect(plan).toContain('conservaría 1 mensaje reciente (~3,345 tokens)');
  });
});

describe('the lane', () => {
  it('counts no English string without a key in usage, webhooks and compact, and only the risk declaration in the sweep', () => {
    const lane = (f: string) => { const rel = `src/cli/${f}-command.ts`; return englishUserStrings(fs.readFileSync(path.resolve(rel), 'utf8'), rel).map((s) => s.text); };
    for (const f of ['usage', 'webhooks', 'compact']) expect(lane(f), f).toEqual([]);
    // `declareRisk({ llave: { innecesaria } })`: no screen prints it, like `writes` (riesgos-retrofit.ts). Part 14 rules on it.
    expect(lane('webhook-sweep')).toEqual([expect.stringContaining('each delivery already carries its own stable key')]);
  });
});
