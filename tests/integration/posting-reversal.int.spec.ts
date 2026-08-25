import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  createJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  voidJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * Porta scripts/e2e-reversal.ts. Diferencia: el inquilino es desechable, la
 * base es efímera y nadie repara saldos a mano al terminar.
 */
let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Reversas');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

function lineas(monto: string) {
  return [
    { account_id: f.roles.banco, debit_amount: monto, credit_amount: null, description: 'cargo' },
    { account_id: f.roles.cxc, debit_amount: null, credit_amount: monto, description: 'abono' },
  ];
}

async function asientoPosteado(monto = '100.00') {
  return createJournalEntry(
    f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Asiento de integración',
    lineas(monto), f.userId, { autoPost: true }
  );
}

describe('reversa y anulación contra Postgres real', () => {
  it('un borrador no se puede reversar: nunca afectó saldos', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Borrador', lineas('50.00'), f.userId
    );
    await expect(reverseJournalEntry(draft.id, f.userId)).rejects.toThrow(/ENTRY_NOT_POSTED|never touched/);
  });

  it('reversar un posteado deja el original posteado y enlaza el espejo', async () => {
    const original = await asientoPosteado('250.00');
    const espejo = await reverseJournalEntry(original.id, f.userId, { reason: 'error de captura' });

    expect(espejo.is_reversal).toBe(true);
    expect(espejo.reverses_entry_id).toBe(original.id);

    const { rows } = await query<{ status: string; reversed_by_entry_id: string }>(
      'SELECT status, reversed_by_entry_id FROM journal_entries WHERE id = $1', [original.id]
    );
    expect(rows[0].status).toBe('posted');
    expect(rows[0].reversed_by_entry_id).toBe(espejo.id);
  });

  it('la segunda reversa se rechaza', async () => {
    const original = await asientoPosteado('300.00');
    await reverseJournalEntry(original.id, f.userId);
    await expect(reverseJournalEntry(original.id, f.userId)).rejects.toThrow(/ALREADY_REVERSED|already has a reversal/);
  });

  it('original + espejo dejan el saldo neto en cero', async () => {
    const antes = await saldoDe(f.roles.banco, f.periodos[8]);
    const original = await asientoPosteado('777.00');
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(antes + 777, 4);

    await reverseJournalEntry(original.id, f.userId);
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(antes, 4);
  });

  it('anular un posteado NO cambia su estado: le enlaza un espejo', async () => {
    const original = await asientoPosteado('120.00');
    const r = await voidJournalEntry(original.id, f.userId, 'anulada');
    expect(r.status).toBe('posted');
    expect(r.reversed_by_entry_id).toBeTruthy();
  });

  it('anular un borrador sí lo pasa a void, sin espejo', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Cancelable', lineas('60.00'), f.userId
    );
    const r = await voidJournalEntry(draft.id, f.userId, 'capturado por error');
    expect(r.status).toBe('void');
    expect(r.reversed_by_entry_id).toBeNull();
  });

  it("la BD acepta el tipo 'payroll': el CHECK se amplió", async () => {
    const je = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.PAYROLL, 'Nómina', lineas('10.00'), f.userId
    );
    expect(je.entry_type).toBe('payroll');
  });

  it('postear dos veces el mismo asiento se rechaza', async () => {
    const draft = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Doble posteo', lineas('15.00'), f.userId
    );
    await postJournalEntry(draft.id, f.userId);
    await expect(postJournalEntry(draft.id, f.userId)).rejects.toThrow(/already posted/i);
  });

  it('un asiento desbalanceado no llega a saldos', async () => {
    await expect(
      createJournalEntry(f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Desbalanceado', [
        { account_id: f.roles.banco, debit_amount: '100.00', credit_amount: null, description: 'x' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '99.99', description: 'y' },
      ], f.userId, { autoPost: true })
    ).rejects.toThrow(/Validation failed/);
  });
});

describe('numeración concurrente', () => {
  it('cinco asientos simultáneos obtienen cinco folios distintos', async () => {
    const asientos = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createJournalEntry(
          f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, `Concurrente ${i}`,
          lineas('10.00'), f.userId
        )
      )
    );
    const folios = new Set(asientos.map((a) => a.entry_number));
    expect(folios.size).toBe(5);
  });
});
