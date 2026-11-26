import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the close family speaks by key (MNE-001-805, #150). Under es-MX every refusal, question, verdict
// and label of `closing`, `close`, `closing fx` and the period resolver they share is Spanish from the
// catalogue, written here by hand before the code; periods, steps, statuses and commands stay as they are.
// The English was compared by a dump.

const W = vi.hoisted(() => ({ periods: [] as unknown[], readiness: undefined as unknown, open: null as unknown, verdict: undefined as unknown, pack: undefined as unknown }));
const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN', accountingStandard: 'mx_nif' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1', email: 'contador@example.test' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })), requireExplicitEntity: vi.fn(async () => CTX) }));
vi.mock('../../src/ai/close-service.js', () => ({ listClosablePeriods: async () => W.periods, nextPeriodToClose: async () => W.periods[0], getCloseReadiness: async () => W.readiness }));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', async (o) => {
  const { NotFoundError } = await import('../../src/utils/errors.js');
  return { ...(await o<Record<string, unknown>>()), resolvePeriod: async (_e: string, ref: string) => {
    const hit = (W.periods as Array<{ id: string; start_date: string }>).find((p) => p.start_date.startsWith(`${ref}-`));
    if (!hit) throw new NotFoundError('Fiscal period', ref);
    return hit;
  } };
});
vi.mock('../../src/services/accounting/closing-conductor.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  openRunOf: async () => W.open, liveRunOf: async () => null, latestRunOf: async () => null }));
vi.mock('../../src/services/accounting/closing-pack.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  latestClosedPeriodOf: async () => null, parseClosingPack: () => W.pack, verifyClosingPack: async () => W.verdict }));
vi.mock('../../src/services/accounting/period-close.js', async (o) => ({ ...(await o<Record<string, unknown>>()), softClosePeriod: async () => ({ status: 'soft_close' }) }));

import { registerClosingCommand, renderCasillas, renderSteps, runClosingLine, verdictRows } from '../../src/cli/closing-command.js';
import { registerCloseCommand, renderReadiness, renderCarryForward, confirmarCierre } from '../../src/cli/close-command.js';
import { resolveClosablePeriod } from '../../src/cli/kernel/closable-period.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import type { CliError } from '../../src/cli/kernel/cli-error.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import type { ClosingRunOutcome } from '../../src/services/accounting/closing-conductor.js';
import type { PackVerdict } from '../../src/services/accounting/closing-pack.js';
import type { CloseReadiness } from '../../src/ai/close-service.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
const flat = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').trim();
const P = (name: string, status = 'open') => ({ id: `p-${name}`, period_name: name, period_number: 8, start_date: `${name}-01`, end_date: `${name}-31`, status, year_number: 2026, overdue: true });
const READY = (canClose: boolean): CloseReadiness => ({ period: P('2026-08'), canClose, blockingIssues: canClose ? [] : ['b1'], warnings: ['w1'],
  checklist: [], ai: { pendingDrafts: 2, pendingQuestions: 1, pendingExternalOps: 1 } });
const OUT = (status: ClosingRunOutcome['status'], haltedAtStep: ClosingRunOutcome['haltedAtStep']): ClosingRunOutcome => ({ runId: null, entityId: 'e1', periodId: 'p8',
  periodName: '2026-08', status, haltedAtStep, steps: [{ step: 'accrue-benefits', ordinal: 1, status: 'done', processed: 0, amount: null, journalEntryIds: [], detail: 'd', priorAttempt: true }] });
const VERDICT = (ok: boolean): PackVerdict => ({ sealIntact: ok, issued: ok, issuedAt: null, envelopeMatches: false, figuresReproduce: ok, identityUnchanged: ok,
  expectedSeal: 'aa', recomputedSeal: 'aa', differences: [] });
const PACK = { sealed: { as_of: '2026-09-01', entity: { id: 'e1', name: 'Entidad Sintetica SA' }, period: { name: '2026-08' } } };
afterEach(() => { vi.restoreAllMocks(); resetLanguage(); });

async function es(argv: string[], confirm?: boolean): Promise<string> {
  let out = '';
  setLanguage('es');
  resetDeclarations();
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += `${a.join(' ')}\n`; });
  const STOP = new Error('stop');
  const deps = { palette, home: '/tmp/mnemosine-tests-no-home', shutdown: () => { if (argv[0] === 'close') throw STOP; },
    reportError: (e: unknown) => { if (e !== STOP) out += (e as { localized: () => string }).localized(); },
    ...(confirm !== undefined ? { confirm: async (q: string) => { out += q; return confirm; } } : {}) };
  const cli = new Command('mnemosine').exitOverride();
  registerClosingCommand(cli, deps);
  registerCloseCommand(cli, deps as never);
  await cli.parseAsync(['node', 'mnemosine', ...argv, '-e', 'e1']).catch((e: unknown) => { if (e !== STOP) throw e; });
  return out.replace(/\s+/g, ' ').trim();
}

describe('under es-MX, the pure renders of the close speak Spanish', () => {
  it('the checks, the steps and the last line of a run, with the commands as they are', () => {
    setLanguage('es');
    expect(renderCasillas([], palette)).toEqual(['  (no se seleccionó ninguna verificación)']);
    expect(renderSteps(OUT('completed', null), palette)[0]).toContain('d  (también lo registró un intento anterior de esta corrida)');
    expect(runClosingLine(OUT('completed', null))).toBe('El cierre quedó conducido. Sella el expediente con `mnemosine closing pack generate "2026-08"`.');
    expect(runClosingLine(OUT('stopped', 'hard-close'))).toBe('Detenido antes del sello, como se pidió: el periodo tiene cierre suave. Séllalo con `mnemosine close --period "2026-08" --hard`.');
    expect(runClosingLine(OUT('stopped', 'soft-close'))).toBe('Detenido antes de soft-close, como se pidió. El periodo sigue abierto; continúa con --resume.');
    expect(runClosingLine(OUT('blocked', 'verify-checklist'))).toBe('Bloqueado en verify-checklist. Resuelve los bloqueos y luego continúa con --resume.');
    expect(runClosingLine(OUT('failed', 'hard-close'))).toBe('Falló en el sello: el periodo tiene cierre suave. Corrige la causa y luego séllalo con `mnemosine close --period "2026-08" --hard`.');
    expect(runClosingLine(OUT('failed', 'soft-close'))).toBe('Falló en soft-close. Corrige la causa y luego continúa con --resume.');
    expect(runClosingLine(OUT('previewed', 'soft-close'), 'soft-close')).toBe('No se escribió nada. Una corrida de verdad se detendría antes de soft-close; para conducir, córrelo sin --dry-run.');
    expect(runClosingLine(OUT('previewed', 'verify-checklist'), undefined, true)).toBe('No se escribió nada. La lista de verificación bloquearía en verify-checklist: resuélvela y luego córrelo con --resume.');
    expect(runClosingLine(OUT('previewed', null), undefined, true, true)).toBe('No se escribió nada. Para conducir, espera a que se detenga el conductor que actúa sobre su corrida, y luego córrelo con --resume.');
  });
  it('the annex of pack verify keeps its rows in English and labels them in the md table', async () => {
    setLanguage('es');
    expect(verdictRows(VERDICT(false))).toContainEqual({ kind: 'registry', path: 'closing_packs', expected: 'issued by these books', actual: 'not issued' });
    W.pack = PACK;
    W.verdict = VERDICT(true);
    fs.writeFileSync('/tmp/mnemosine-805-spec.json', '{}');
    expect(await es(['closing', 'pack', 'verify', '/tmp/mnemosine-805-spec.json', '--format', 'md'])).toContain('| envelope | envelope | como se registró | difiere |');
    expect(await es(['closing', 'pack', 'verify', '/tmp/mnemosine-805-spec.json', '--format', 'csv'])).toContain('envelope,envelope,as registered,differs');
  });
  it('close: the readiness, the carry-forward and the double gate', async () => {
    setLanguage('es');
    expect(flat(renderReadiness(READY(false), palette))).toContain('2026-08 2026-08-01 → 2026-08-31 · open · vencido Bloqueos: · b1 Avisos: · w1 Todavía no se puede cerrar: resuelve los bloqueos de arriba.');
    expect(flat(renderReadiness(READY(true), palette))).toContain('Listo para cerrar.');
    expect(flat(renderCarryForward({ carried: 1, periods: ['2026-08'], stopped_at_locked: '2026-09' }, palette))).toBe(
      'Saldos iniciales arrastrados a: 2026-08 ✘ 2026-09 está bloqueado: sus saldos iniciales NO se reescribieron. Él y los periodos que le siguen todavía abren con las cifras viejas; registra la corrección en un periodo abierto.');
    const asked: string[] = [];
    const answers = ['s', '2026-07'];
    const r = await confirmarCierre(async (q) => { asked.push(q); return answers.shift() ?? null; }, palette, t('close.kind.hard'), { hard: true, periodName: '2026-08' });
    expect(asked[0]).toContain('¿Proceder con el cierre DURO (irreversible)?');
    expect(asked[1]).toBe('Un cierre duro no se deshace. Escribe el nombre del periodo (2026-08) para confirmar: ');
    expect(r).toEqual({ procede: false, mensaje: 'Eso no coincide con 2026-08: no se cerró nada.' });
    expect((await confirmarCierre(async () => 'n', palette, t('close.kind.soft'), { hard: false, periodName: '2026-08' })).mensaje).toBe('Cancelado.');
  });
});

describe('under es-MX, the leaves of the close speak Spanish', () => {
  it('the period resolver refuses in Spanish and keeps its message English', async () => {
    setLanguage('es');
    const periods = [P('2026-08'), P('2026-09', 'soft_close')];
    W.periods = periods;
    const refusal = (ref: string, list = periods, opts = {}) => resolveClosablePeriod(CTX as never, ref, list as never, opts).then(() => { throw new Error('resolved'); }, (e: unknown) => e as CliError);
    const missing = await refusal('2027-01', []);
    expect([missing.localized(), missing.message]).toEqual(['Ningún periodo coincide con "2027-01". Cerrables: ninguno.', 'No period matches "2027-01". Closable: none.']);
    expect((await refusal('2026-09', periods, { openOnly: true })).localized()).toBe('2026-09 ya está en soft_close: no queda nada que conducir. Séllalo con `mnemosine closing pack generate "2026-09"`.');
    expect((await refusal('2026-09', [periods[0]])).localized()).toBe('2026-09 está en soft_close: sólo se cierran periodos abiertos o con cierre suave. Cerrables: 2026-08.');
  });
  it('closing preview, check and run', async () => {
    W.periods = [P('2026-08')];
    W.readiness = READY(false);
    expect(await es(['closing', 'preview'])).toContain('· open · vencido (no se seleccionó ninguna verificación) Bloqueos: · b1 Avisos: · w1 El periodo todavía no puede entrar a cierre: resuelve los bloqueos de arriba.');
    expect(await es(['closing', 'check', '--check', 'nope'])).toContain('Código de verificación desconocido: nope. Disponibles: previous-period-closed,');
    expect(await es(['closing', 'check'])).toContain('· 2 borradores de IA fechados dentro del periodo bloquean este cierre (mnemosine review) · 1 pregunta de IA sin responder (mnemosine questions) · 1 escritura externa en cola (mnemosine outbox)');
    expect(await es(['closing', 'run', '--stop-at', 'nope'])).toContain('Paso "nope" desconocido. Los pasos son: accrue-benefits,');
    W.open = { id: 'r0', status: 'stopped', halted_at_step: null, started_at: '2026-09-01' };
    expect(await es(['closing', 'run'])).toContain('Este periodo ya tiene una corrida de cierre abierta (stopped, started 2026-09-01). Continúala con --resume, o mírala antes con --dry-run.');
    W.open = null;
    expect(await es(['closing', 'run', '--resume'])).toContain('Nada que reanudar: este periodo no tiene una corrida de cierre abierta. Córrelo sin --resume para empezar una.');
    expect(await es(['closing', 'run'], false)).toBe('¿Conducir el cierre de 2026-08? Cuatro de sus pasos contabilizan en el mayor, que no admite deshacer, y el último hace el cierre duro del periodo.'
      + 'No se hizo nada: no hay terminal donde confirmar. Agrega -y para conducir sin preguntar, o --dry-run para ver lo pendiente sin escribir.');
    W.periods = [];
    expect(await es(['closing', 'preview'])).toBe('No hay periodos abiertos: nada que previsualizar ni verificar.');
    expect(await es(['closing', 'run'])).toBe('No hay periodos abiertos: nada que conducir.');
    expect(await es(['closing', 'pack', 'generate'])).toBe('Todavía no hay un periodo cerrado que sellar. Nombra el periodo para sellar uno abierto a propósito, p. ej. `closing pack generate 2026-07`.');
  });
  it('closing pack verify and close', async () => {
    expect(await es(['closing', 'pack', 'verify', '/nonexistent/dossier.json'])).toBe('No se puede leer /nonexistent/dossier.json.');
    W.pack = PACK;
    W.verdict = VERDICT(false);
    expect(await es(['closing', 'pack', 'verify', '/tmp/mnemosine-805-spec.json'])).toContain('2026-08 Entidad Sintetica SA · al 2026-09-01 ✘ el archivo concuerda con su sello ✘ estos libros emitieron un expediente con este sello '
      + '✘ las cifras se reproducen contra los libros aviso: un nombre cambió desde el sellado');
    expect(await es(['close'])).toBe('No hay periodos abiertos: nada que cerrar.');
    W.periods = [P('2026-08')];
    W.readiness = READY(true);
    expect(await es(['close', '--hard', '--dry-run'])).toContain('Listo para cerrar. Haría el cierre duro de 2026-08. (ensayo: no se escribió nada)');
    expect(await es(['close'])).toContain('¿Proceder con el cierre suave (reversible)? — no hay terminal donde preguntar.');
    expect(await es(['close', '--yes'])).toContain('✔ 2026-08 queda en soft_close (por contador@example.test) El cierre suave es reversible. Para sellarlo: mnemosine close --hard');
  });
});

describe('the English keeps its words, and the lane finds no English literal', () => {
  it('an English plural defect stays', () => {
    setLanguage('en');
    expect(t('closing.check.unknown_codes', { count: 1, codes: 'x', available: 'y' })).toBe('Unknown check code(s): x. Available: y.');
    expect(t('closing.check.ai_drafts', { count: 1, command: 'mnemosine review' })).toBe('1 AI draft(s) dated inside the period block this close (mnemosine review)');
  });
  it.each(['src/cli/closing-command.ts', 'src/cli/close-command.ts', 'src/cli/closing-fx-command.ts', 'src/cli/kernel/closable-period.ts'])('%s', (file) => {
    const code = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    expect(englishUserStrings(code, file).map((h) => h.text)).toEqual([]);
  });
});
