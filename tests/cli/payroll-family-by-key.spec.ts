import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// I8b · the payroll family speaks by key (MNE-001-804, #150). Under es-MX every refusal, question, receipt
// and notice of `isn`, `tax-deposit`, `employee`, `garnishment` and `pay-run` is Spanish from the catalogue,
// written here by hand before the code; panel keys, commands, amounts and dates pass through untranslated.
// The English was compared by a dump.

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN', accountingStandard: 'mx_nif' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })), requireExplicitEntity: vi.fn(async () => CTX) }));
vi.mock('../../src/database/connection.js', async (o) => ({ ...(await o<Record<string, unknown>>()), query: vi.fn(), withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})) }));
vi.mock('../../src/services/policy/policy-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), getPolicy: vi.fn(async () => ({ value: 'devengo', defined: false })) }));
vi.mock('../../src/services/payroll/mx/isn-calculator.js', async (o) => ({ ...(await o<Record<string, unknown>>()), basesIsnDeCorrida: vi.fn(), calcularIsn: vi.fn() }));
vi.mock('../../src/services/payroll/common/employee-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), createEmployee: vi.fn(async () => 'emp-1'), listEmployees: vi.fn(async () => []) }));
vi.mock('../../src/services/payroll/common/garnishment-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  recordGarnishment: vi.fn(), listGarnishments: vi.fn(async () => []), archiveGarnishment: vi.fn() }));

import * as isn from '../../src/cli/payroll-isn-command.js';
import { registerEmployeeCommand } from '../../src/cli/employee-command.js';
import { registerGarnishmentCommand } from '../../src/cli/garnishment-command.js';
import { registerPayRunCommand } from '../../src/cli/pay-run-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { query } from '../../src/database/connection.js';
import { basesIsnDeCorrida, calcularIsn } from '../../src/services/payroll/mx/isn-calculator.js';
import { recordGarnishment, archiveGarnishment } from '../../src/services/payroll/common/garnishment-service.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: (s: string) => `<y>${s}</y>` };
const mock = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
const said = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as { localized: () => string }).localized(); } };
const CITA = 'Ley de Hacienda del Estado de Jalisco art. 41';
const VIG = { estado: 'JAL', vigencia_desde: '2025-01-01', vigencia_hasta: null, tasa: '0.030000', regimen: 'tasa_plana', exencion_mensual: null, fundamento: CITA };
const LIABILITY = { id: 'l1', entidad: 'Entidad Sintetica SA', pay_run_id: 'r1', tax_type: 'isn', jurisdiction: 'JAL', period_start: '2020-07-01', period_end: '2020-07-31',
  amount: '1234.50', due_date: '2020-08-17', deposit_frequency: 'monthly', status: 'pending', deposited_at: null, deposit_reference: null };
let db: { coverage?: unknown[]; rates?: unknown[]; insert?: unknown; run?: unknown[]; total?: string; rows?: unknown[] } = {};
mock(query).mockImplementation(async (sql: unknown) => {
  const s = String(sql), rows = (r: unknown[] = []) => ({ rows: r, rowCount: r.length });
  if (s.includes('INSERT INTO mx_isn')) return rows([db.insert]);
  if (s.includes('FROM mx_isn_tasas_estatales')) return rows(db.rates);
  if (s.includes('FROM pay_runs')) return rows(db.run);
  if (s.includes('COUNT(*)::text AS total')) return rows([{ total: db.total ?? '0' }]);
  if (s.includes('FROM employer_tax_liabilities')) return rows(db.rows);
  return rows(db.coverage);
});
afterEach(() => { resetLanguage(); });

async function es(argv: string[], answer?: boolean): Promise<string> {
  let out = '';
  setLanguage('es');
  resetDeclarations();
  const spies = [process.stdout, process.stderr].map((st) => vi.spyOn(st, 'write').mockImplementation((c: unknown) => { out += String(c); return true; }));
  const program = new Command('mnemosine').exitOverride();
  const deps = { palette, home: '/tmp/mnemosine-tests-no-home', shutdown: () => undefined,
    reportError: (e: unknown) => { out += (e as { localized: () => string }).localized(); },
    ...(answer === undefined ? {} : { confirm: async (q: string) => { out += q; return answer; } }) };
  isn.registerPayrollIsnCommands(program, deps);
  registerEmployeeCommand(program, deps);
  registerGarnishmentCommand(program, deps);
  registerPayRunCommand(program, deps as unknown as Parameters<typeof registerPayRunCommand>[1]);
  await program.parseAsync(['node', 'mnemosine', ...argv]).catch(() => undefined);
  for (const s of spies) s.mockRestore();
  return out.replace(/\s+/g, ' ');
}

describe('under es-MX, the ISN guards and the capture preview speak Spanish', () => {
  it('the pure guards', () => {
    setLanguage('es');
    expect(said(() => isn.exigirClaveDeEstado(''))).toContain('Nombra el estado: el ISN es un impuesto estatal');
    expect(said(() => isn.exigirClaveDeEstado('J1'))).toContain('"J1" no es una clave de estado.');
    expect(said(() => isn.exigirTasaIsn('3'))).toBe('3 rebasa el tope de 0.15 que impone la tabla (migración 067). El impuesto estatal sobre nóminas ronda del 1% al 4%. Si quisiste decir tres por ciento, escribe 0.03 o 3%: un 3 a secas es trescientos por ciento.');
    expect(said(() => isn.exigirTasaIsn('0.0000001'))).toContain('1e-7 tiene más de 6 decimales y la columna guarda 6.');
    expect(said(() => isn.exigirFechaIsn('--as-of', 'x'))).toBe('--as-of tiene que ser una fecha AAAA-MM-DD; llegó "x".');
    expect(said(() => isn.exigirFechaIsn('--as-of', '2026-02-30'))).toBe('--as-of "2026-02-30" no es una fecha que exista.');
    expect(said(() => isn.exigirRegimen('x'))).toBe('--regime "x" desconocido. La tabla sólo conoce: tasa_plana, escalonado, con_exencion (la migración 067 los pone en un CHECK).');
    expect(said(() => isn.exigirFundamento(''))).toContain('--legal-basis es obligatorio: una tasa sin la ley que la sostiene no se puede auditar.');
    expect(said(() => isn.exigirExencion('tasa_plana', '5'))).toContain('--exemption sólo va con --regime con_exencion; éste es "tasa_plana".');
    expect(said(() => isn.exigirMesDeNomina('2026-13'))).toBe('--period "2026-13": el mes va de 01 a 12.');
    expect(said(() => isn.exigirEstadosDePasivo([' ']))).toBe('--status no nombró nada. Disponibles: pending, deposited, late, waived.');
    expect((isn.traducirErrorDeCaptura({ code: '23505' }, 'JAL', '2026-01-01') as { localized: () => string }).localized())
      .toContain('JAL ya tiene una tasa capturada con vigencia desde 2026-01-01. Una tasa no se edita a ciegas: mírala primero con `mnemosine isn rate list --state JAL -a`');
  });
  it('the preview: who it reaches, the keys in use, and the overlap, at the same column', () => {
    setLanguage('es');
    const rate = { estado: 'JAL', vigenciaDesde: '2025-01-01', vigenciaHasta: null, tasa: '0.030000', regimen: 'tasa_plana' as const, exencionMensual: null, fundamento: CITA };
    const lines = isn.lineasDeLaCaptura({ estado: 'JAL', tasa: '0.030000', regimen: 'tasa_plana', exencion: null, desde: '2026-01-01', hasta: null, fundamento: CITA,
      cobertura: { criterio: 'centro_de_trabajo', criterioDefinido: false, alcanzados: 0, otras: [{ clave: 'JA', trabajadores: 4 }, { clave: '', trabajadores: 1 }] }, choques: [rate] });
    expect(lines.slice(-4)).toEqual([
      '  alcanza            NADIE: ningún trabajador vivo de esta entidad lleva "JAL" en employees.work_state',
      '                     claves que sí se usan: JA=4, (vacía)=1',
      '                     employees.work_state es VARCHAR(2) y esta clave tiene 3 letras: nunca puede coincidir. Captura la clave de 2 letras que llevan tus trabajadores, o corrige a los trabajadores.',
      '  SOLAPE             JAL 2025-01-01 -> (abierta) a 0.030000: el disparador trg_isn_sin_solape va a rechazar esta escritura.',
    ]);
  });
});

describe('under es-MX, the isn and tax-deposit leaves speak Spanish', () => {
  const set = ['isn', 'rate', 'set', 'JAL', '3%', '--legal-basis', CITA];
  it('rate set: the refusals, the preview painted by its marks, the dry run, the question, the abort and the receipt', async () => {
    expect(await es(set)).toContain('--effective-from es obligatorio: una tasa sin vigencia no es una tasa, es un recuerdo.');
    db = { coverage: [{ clave: 'JA', trabajadores: 2 }], rates: [] };
    const dry = await es([...set, '--effective-from', '2026-01-01', '--regime', 'escalonado', '--dry-run']);
    for (const s of ['Por capturar una tasa de ISN', '<y> alcanza NADIE: ningún trabajador vivo', 'isn_estado_que_causa=centro_de_trabajo (',
      '<y> NOTA: el motor sólo calcula tasa_plana. Capturada como "escalonado", se negará a calcular', 'Ensayo: no se escribió nada.']) expect(dry).toContain(s);
    db = { coverage: [{ clave: 'JAL', trabajadores: 2 }], rates: [VIG, { ...VIG, vigencia_desde: '2024-01-01', vigencia_hasta: '2025-06-01' }] };
    const overlap = await es([...set, '--effective-from', '2024-06-01']);
    expect(overlap).toContain('<y> SOLAPE JAL 2025-01-01 -> (abierta) a 0.030000');
    expect(overlap).toContain('JAL ya tiene 2 vigencias que se solapan con 2024-06-01 en adelante: 2025-01-01->(abierta) a 0.030000, 2024-01-01->2025-06-01 a 0.030000. Dos vigencias solapadas');
    db = { coverage: [{ clave: 'JAL', trabajadores: 1 }], rates: [], insert: { ...VIG, vigencia_desde: '2026-01-01' } };
    const no = await es([...set, '--effective-from', '2026-01-01'], false);
    expect(no).toContain('alcanza 1 trabajador lleva "JAL"');
    expect(no).toContain('¿Capturar JAL a 0.030000 desde 2026-01-01? Toda corrida de nómina MX de ese estado');
    expect(no).toContain('No se capturó nada: no hay terminal donde confirmar.');
    expect(await es([...set, '--effective-from', '2026-01-01', '-y'])).toContain('Capturada. JAL calcula ahora a 0.030000 desde 2026-01-01 en adelante. No se acumuló nada');
  });
  it('rate list and calculate', async () => {
    db = { rates: [] };
    expect(await es(['isn', 'rate', 'list'])).toContain('No hay ninguna tasa de ISN capturada. La tabla nace vacía a propósito (migración 067)');
    db = { rates: [{ ...VIG, vigencia_desde: '2030-01-01' }] };
    expect(await es(['isn', 'rate', 'list', '--as-of', '2026-01-01', '--state', 'JAL'])).toContain('<y> Nada rige el 2026-01-01 para JAL, aunque hay 1 vigencia capturada. Usa -a para verlas. </y> Captura una con: mnemosine isn rate set <STATE>');
    expect(await es(['isn', 'rate', 'list', '--limit', 'x'])).toContain('--limit tiene que ser un entero no negativo; llegó "x".');
    expect(await es(['isn', 'calculate'])).toContain('--run <payRunId> es obligatorio');
    db = { run: [] };
    expect(await es(['isn', 'calculate', '--run', 'r9'])).toContain('No hay corrida de nómina r9 en esta entidad.');
    db = { run: [{ status: 'approved', period_start: '2026-07-01', period_end: '2026-07-15', pay_date: '2026-07-16' }] };
    mock(basesIsnDeCorrida).mockResolvedValue({ criterio: 'centro_de_trabajo', criterioDefinido: false, bases: [] });
    mock(calcularIsn).mockResolvedValue({ porEstado: [{ estado: 'JAL', base: '10000.0000', tasa: '0.030000', importe: '300.0000', trabajadores: 2, vigenciaDesde: '2025-01-01', fundamento: CITA }],
      hallazgos: [{ codigo: 'isn_x', severidad: 'aviso', estado: null, mensaje: 'y' }], total: '300.0000' });
    const calc = await es(['isn', 'calculate', '--run', 'r1']);
    for (const s of ['ISN — corrida de nómina r1 2026-07-01 -> 2026-07-15 (approved) · fecha de causación 2026-07-15',
      'Contéstalos con `mnemosine pending define isn_estado_que_causa` / `mnemosine pending define isn_momento_de_causacion`.',
      'ISN calculado: 300.00 MXN en 1 estado 0 bloqueantes, 1 aviso. Un hallazgo bloqueante', 'Aquí no se acumuló nada.']) expect(calc).toContain(s);
  });
  it('tax-deposit list', async () => {
    expect(await es(['tax-deposit', 'list', '--status', 'nope'])).toContain('--status desconocido: nope. La tabla sólo tiene: pending, deposited, late, waived (migración 008).');
    db = { total: '0', rows: [] };
    expect(await es(['tax-deposit', 'list'])).toContain('No hay nada acumulado que coincida.');
    db = { total: '1', rows: [LIABILITY] };
    const rows = await es(['tax-deposit', 'list', '--all-entities']);
    for (const s of ['1 de 1 renglón · 1,234.50 MXN a la vista · estado pending,late · todas las entidades', '1 renglón ya pasó su fecha límite y sigue abierto.',
      'NO se recorren al día hábil: el artículo 12 del CFF']) expect(rows).toContain(s);
  });
});

describe('under es-MX, employee, garnishment and pay-run speak Spanish', () => {
  it('employee create and list', async () => {
    const file = (body: unknown) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mne804-')), 'e.json'); fs.writeFileSync(f, JSON.stringify(body)); return f; };
    const ok = { employee_number: 'E-1', first_name: 'Ana', last_name: 'Sintetica', hire_date: '2026-10-01', country_code: 'MX' };
    expect(await es(['employee', 'create', '-e', 'e1'])).toContain('Falta --file: los identificadores se leen de un archivo, nunca de banderas.');
    expect(await es(['employee', 'create', '-e', 'e1', '--file', file([])])).toContain('la carga masiva es `employee import`.');
    expect(await es(['employee', 'create', '-e', 'e1', '--file', file({ ...ok, foo: 1 })])).toContain('--file trae campos desconocidos: foo.');
    expect(await es(['employee', 'create', '-e', 'e1', '--file', file({ first_name: 'Ana' })])).toContain('Falta employee_number, last_name, hire_date, country_code.');
    expect(await es(['employee', 'create', '-e', 'e1', '--file', file({ ...ok, hire_date: '1/10/2026' })])).toContain('hire_date "1/10/2026": usa AAAA-MM-DD.');
    expect(await es(['employee', 'create', '-e', 'e1', '--file', file(ok), '--dry-run'])).toContain('Ensayo: la transacción se deshizo. No se guardó ningún empleado.');
    expect(await es(['employee', 'list', '--status', 'active', '--status', 'on_leave'])).toContain('--status toma un estado a la vez; usa -a/--all para todos.');
    expect(await es(['employee', 'list'])).toContain('Ningún empleado coincide en esta entidad.');
  });
  it('garnishment record, list and archive, and the pay-run type', async () => {
    expect(await es(['garnishment', 'record', 'E-1', '-e', 'e1'])).toContain('Falta --type, --court, --start. Una orden sin tipo no se puede calcular');
    expect(await es(['garnishment', 'record', 'E-1', '--priority', '-1'])).toContain('--priority tiene que ser un número entero de 0 o más; llegó "-1".');
    const row = (type: string, rank: number) => ({ garnishment_type: type, rank, priority: 1, amount_type: 'percent_disposable', amount_value: '15' });
    mock(recordGarnishment).mockResolvedValue({ id: 'g1', order: { ...row('creditor', 4), case_number: 'C-1', issuing_authority: 'Court', start_date: '2026-08-01' }, cascade: [row('child_support', 1), row('creditor', 4)] });
    const rec = await es(['garnishment', 'record', 'E-1', '-e', 'e1', '--type', 'creditor', '--court', 'Court', '--start', '2026-08-01', '--dry-run']);
    for (const s of ['Ensayo: la transacción se deshizo. No se registró ninguna orden.', '⚠ este trabajador tiene ahora 2 órdenes vivas.',
      'child_support · rango 1 · prioridad 1 · percent_disposable 15']) expect(rec).toContain(s);
    expect(await es(['garnishment', 'list', '--status', 'gone'])).toContain('--status gone: una orden está activa o archivada. Usa -a/--all para las dos.');
    expect(await es(['garnishment', 'list'])).toContain('Ninguna orden de embargo coincide. Aquí no se está reteniendo nada.');
    mock(archiveGarnishment).mockResolvedValue({ id: 'g1', employee_id: 'emp-1', garnishment_type: 'creditor', case_number: 'C-1', end_date: null });
    expect(await es(['garnishment', 'archive', 'g1', '-e', 'e1', '--reason', 'r'])).toContain('La orden sigue en el expediente. Lo que se detuvo es la retención');
    expect(await es(['pay-run', 'create', '--period', 'p1', '--type', 'weird'])).toContain('se esperaba uno de regular, bonus, correction, final, off_cycle');
  });
});

describe('the English keeps its words, and the lane finds no English literal', () => {
  it('an English plural defect stays', () => {
    setLanguage('en');
    expect(t('payroll.isn_rate_list.none_in_force', { date: '2026-01-01', state: 'none', count: 1 })).toBe('Nothing is in force on 2026-01-01, though 1 vigencia(s) are captured. Use -a to see them.');
    expect(t('payroll.tax_deposit.overdue', { count: 1 })).toMatch(/^1 row\(s\) are past their due date/);
  });
  it.each(['payroll-isn-command.ts', 'employee-create-command.ts', 'garnishment-command.ts', 'employee-list-command.ts', 'pay-run-command.ts'])('%s', (name) => {
    const file = `src/cli/${name}`;
    expect(englishUserStrings(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), file).map((h) => h.text)).toEqual([]);
  });
});
