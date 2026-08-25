import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clienteFalso, type ClienteFalso, type ReglaConsulta, type RegistroConsulta } from '../helpers/fake-pg.js';
import { asientoFalso, lineaFalsa, ID } from '../helpers/entidades.js';
import { JournalEntryType, type JournalEntry } from '../../src/types/index.js';

/**
 * EL RASTRO DE AUDITORÍA DEL MOTOR DE POSTEO.
 *
 * Todo asiento pasa por posting.ts, venga de la API, de la CLI o del
 * agente. Hasta ahora ninguno de esos caminos dejaba constancia de quién
 * lo hizo: cuatro servicios de dominio escribían en audit_log y el motor,
 * que es el punto por el que pasa el libro entero, no.
 *
 * Lo que se fija aquí no es solo que se escriba, sino DÓNDE: en el mismo
 * cliente —y por tanto en la misma transacción— que el asiento. Un rastro
 * confirmado aparte sobrevive a un ROLLBACK del hecho que dice describir.
 */

const { arnes, validateJournalEntry, attest, inquilino } = vi.hoisted(() => ({
  arnes: { actual: null } as { actual: ClienteFalso | null },
  validateJournalEntry: vi.fn(),
  attest: vi.fn(),
  inquilino: { actual: 'tenant-1' as string | undefined },
}));

vi.mock('../../src/database/connection.js', () => ({
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(arnes.actual!.client)),
  query: vi.fn(),
  currentTenant: vi.fn(() => inquilino.actual),
}));

vi.mock('../../src/services/accounting/validation.js', () => ({
  validateJournalEntry: (...a: unknown[]) => validateJournalEntry(...a),
}));

vi.mock('../../src/services/blockchain/orchestrator.js', () => ({
  blockchainOrchestrator: { attestJournalEntry: (...a: unknown[]) => attest(...a) },
}));

import {
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  voidJournalEntry,
} from '../../src/services/accounting/posting.js';

const AUDITORIA: ReglaConsulta = { cuando: /INSERT INTO audit_log/, responde: {} };

const LINEAS = [
  { account_id: ID.cuentaA, debit_amount: '1000.0000', credit_amount: null, description: 'cargo' },
  { account_id: ID.cuentaB, debit_amount: null, credit_amount: '1000.0000', description: 'abono' },
];
const LINEAS_BD = [
  lineaFalsa({ line_number: 1, account_id: ID.cuentaA, debit_amount: '1000.0000' }),
  lineaFalsa({ line_number: 2, account_id: ID.cuentaB, credit_amount: '1000.0000' }),
];

/** Los renglones de auditoría, ya desempaquetados. */
interface Rastro {
  userId: string; tenantId: string; action: string;
  entityType: string; entityId: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  reason: string | null;
}
function rastros(cf: ClienteFalso): Rastro[] {
  return cf.coincidencias(/INSERT INTO audit_log/).map((c: RegistroConsulta) => ({
    userId: c.params[1] as string,
    tenantId: c.params[2] as string,
    action: c.params[3] as string,
    entityType: c.params[4] as string,
    entityId: c.params[5] as string,
    oldValues: c.params[6] ? JSON.parse(c.params[6] as string) : null,
    newValues: c.params[7] ? JSON.parse(c.params[7] as string) : null,
    reason: (c.params[8] as string) ?? null,
  }));
}

function reglasAlta() {
  const draft = asientoFalso({ entry_number: 'JE-2026-00007' });
  const posted = asientoFalso({ entry_number: 'JE-2026-00007', status: 'posted' } as Partial<JournalEntry>);
  return clienteFalso([
    AUDITORIA,
    { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
    { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '7' }] } },
    { cuando: /INSERT INTO journal_entries/, responde: {} },
    { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
    { cuando: /SELECT \* FROM journal_entries WHERE id/, responde: { rows: [draft] }, unaVez: true },
    { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
    { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
    { cuando: /INSERT INTO account_balances/, responde: {} },
    { cuando: /SELECT \* FROM journal_entries WHERE id/, responde: { rows: [posted] } },
    { cuando: /SELECT tenant_id FROM legal_entities/, responde: { rows: [{ tenant_id: 'tenant-1' }] } },
  ]);
}

beforeEach(() => {
  inquilino.actual = 'tenant-1';
  validateJournalEntry.mockReset();
  validateJournalEntry.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  attest.mockReset();
  attest.mockResolvedValue(undefined);
});

describe('alta de asiento', () => {
  it('un borrador deja un rastro «create» con quién, qué y cuánto', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), JournalEntryType.STANDARD, 'Póliza de prueba', LINEAS, ID.usuario
    );

    // El id del rastro es el que se insertó, no el que devuelve la
    // relectura (que en el arnés es un asiento de utilería).
    const idInsertado = cf.coincidencias(/INSERT INTO journal_entries/)[0].params[0];
    const r = rastros(cf);
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('create');
    expect(r[0].entityType).toBe('journal_entries');
    expect(r[0].entityId).toBe(idInsertado);
    expect(r[0].userId).toBe(ID.usuario);
    expect(r[0].tenantId).toBe('tenant-1');
    // El renglón es un extracto, no una copia de la tabla.
    expect(r[0].newValues).toMatchObject({
      entry_number: 'JE-2026-00007',
      line_count: 2,
      total_debit: '1000.00',
      total_credit: '1000.00',
    });
  });

  it('el rastro va en la MISMA transacción que el asiento', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), JournalEntryType.STANDARD, 'Póliza', LINEAS, ID.usuario
    );
    // Ambas sentencias están en la lista del mismo cliente, y la auditoría
    // va después del asiento: si la transacción se revierte, se van las dos.
    const orden = cf.consultas.map((c) => c.sql);
    const iAsiento = orden.findIndex((s) => /INSERT INTO journal_entries/.test(s));
    const iRastro = orden.findIndex((s) => /INSERT INTO audit_log/.test(s));
    expect(iAsiento).toBeGreaterThanOrEqual(0);
    expect(iRastro).toBeGreaterThan(iAsiento);
  });

  it('crear y contabilizar son dos hechos: autoPost deja «create» y «post»', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), JournalEntryType.STANDARD, 'Póliza', LINEAS, ID.usuario,
      { autoPost: true }
    );
    expect(rastros(cf).map((x) => x.action)).toEqual(['create', 'post']);
  });

  it('una reversión dice de qué asiento lo es', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), JournalEntryType.REVERSING, 'Espejo', LINEAS, ID.usuario,
      { isReversal: true, reference: 'JE-2026-00003' }
    );
    expect(rastros(cf)[0].reason).toMatch(/Reversión de JE-2026-00003/);
  });

  it('sin inquilino resoluble el asiento NO se escribe', async () => {
    inquilino.actual = undefined;
    arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '7' }] } },
      { cuando: /INSERT INTO journal_entries/, responde: {} },
      { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
      { cuando: /SELECT \* FROM journal_entries WHERE id/, responde: { rows: [asientoFalso()] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      // La entidad no resuelve inquilino: contexto ausente.
      { cuando: /SELECT tenant_id FROM legal_entities/, responde: { rows: [] } },
    ]);
    // La transacción entera se revierte: un movimiento del libro mayor sin
    // rastro no debe llegar a existir.
    await expect(
      createJournalEntry(ID.entidad, new Date('2026-08-15'), JournalEntryType.STANDARD, 'Póliza', LINEAS, ID.usuario)
    ).rejects.toThrow(/inquilino/i);
  });
});

describe('contabilización, reversión y anulación', () => {
  function reglas(entry: JournalEntry, extra: ReglaConsulta[] = []) {
    return clienteFalso([
      AUDITORIA,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [entry] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /UPDATE journal_entries\s+SET status = 'posted'/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /UPDATE journal_entries SET status = 'void'/, responde: {} },
      ...extra,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/, responde: { rows: [entry] } },
    ]);
  }

  it('postear un borrador deja «post» con el estado anterior', async () => {
    const cf = (arnes.actual = reglas(asientoFalso()));
    await postJournalEntry(ID.asiento, ID.usuario);

    const r = rastros(cf);
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('post');
    expect(r[0].oldValues).toEqual({ status: 'draft' });
    expect(r[0].newValues).toMatchObject({ status: 'posted', posted_by: ID.usuario });
  });

  it('revertir marca el original como «update», no como anulado', async () => {
    const original = asientoFalso({ status: 'posted' } as Partial<JournalEntry>);
    arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [original] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '8' }] } },
      { cuando: /INSERT INTO journal_entries/, responde: {} },
      { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
      { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /UPDATE journal_entries SET reversed_by_entry_id/, responde: {} },
      {
        cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/,
        responde: { rows: [asientoFalso({ id: 'espejo', entry_number: 'JE-2026-00008', status: 'posted' } as Partial<JournalEntry>)] },
      },
    ]);
    const cf = arnes.actual;
    await reverseJournalEntry(ID.asiento, ID.usuario, { reason: 'importe equivocado' });

    const r = rastros(cf);
    // El espejo deja create+post; el original, un update que apunta a él.
    expect(r.map((x) => x.action)).toEqual(['create', 'post', 'update']);
    const delOriginal = r[2];
    expect(delOriginal.entityId).toBe(original.id);
    expect(delOriginal.newValues).toMatchObject({ reversal_entry_number: 'JE-2026-00008' });
    expect(delOriginal.reason).toMatch(/importe equivocado/);
    // NIF B-1: el original no se anula, se corrige por reversión.
    expect(r.some((x) => x.entityId === original.id && x.action === 'void')).toBe(false);
  });

  it('anular un borrador deja «void» con el motivo', async () => {
    const cf = (arnes.actual = reglas(asientoFalso({ status: 'draft' } as Partial<JournalEntry>)));
    await voidJournalEntry(ID.asiento, ID.usuario, 'capturado por error');

    const r = rastros(cf);
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('void');
    expect(r[0].oldValues).toEqual({ status: 'draft' });
    expect(r[0].newValues).toEqual({ status: 'void' });
    expect(r[0].reason).toBe('capturado por error');
  });
});
