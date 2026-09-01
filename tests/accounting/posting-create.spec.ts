import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { clienteFalso, type ClienteFalso } from '../helpers/fake-pg.js';
import { asientoFalso, lineaFalsa, ID } from '../helpers/entidades.js';
import type { JournalEntry } from '../../src/types/index.js';

// El motor corre sobre el PoolClient que le entrega withTransaction: se
// sustituye para que el callback reciba el cliente del arnés.
// vi.hoisted eleva estas referencias junto con los vi.mock que las capturan:
// sin esto haría falta un import dinámico (await de nivel superior), que bajo
// CommonJS es un error de compilación aunque el runtime lo soporte.
const { arnes, validateJournalEntry, attest } = vi.hoisted(() => ({
  arnes: { actual: null as ClienteFalso | null },
  validateJournalEntry: vi.fn(),
  attest: vi.fn(),
}));

vi.mock('../../src/database/connection.js', () => ({
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(arnes.actual!.client)),
  query: vi.fn(),
  currentTenant: vi.fn(() => 'tenant-1'),
}));

vi.mock('../../src/services/accounting/validation.js', () => ({
  validateJournalEntry: (...a: unknown[]) => validateJournalEntry(...a),
}));

vi.mock('../../src/services/blockchain/orchestrator.js', () => ({
  blockchainOrchestrator: { attestJournalEntry: (...a: unknown[]) => attest(...a) },
}));

import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';

const LINEAS = [
  { account_id: ID.cuentaA, debit_amount: '1000.0000', credit_amount: null, description: 'cargo' },
  { account_id: ID.cuentaB, debit_amount: null, credit_amount: '1000.0000', description: 'abono' },
];

/** Reglas mínimas para un alta completa. `postead` decide qué devuelve la
 *  relectura del asiento tras el UPDATE a 'posted'. */
function reglasAlta(opts: { periodo?: boolean; siguienteFolio?: string } = {}) {
  const draft = asientoFalso({ entry_number: 'JE-2026-00007' });
  const posted = asientoFalso({ entry_number: 'JE-2026-00007', status: 'posted' } as Partial<JournalEntry>);
  const lineas = [
    lineaFalsa({ line_number: 1, account_id: ID.cuentaA, debit_amount: '1000.0000' }),
    lineaFalsa({ line_number: 2, account_id: ID.cuentaB, credit_amount: '1000.0000' }),
  ];
  return clienteFalso([
    {
      cuando: /FROM fiscal_periods/,
      responde: opts.periodo === false ? { rows: [] } : { rows: [{ id: ID.periodo }] },
    },
    { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: opts.siguienteFolio ?? '7' }] } },
    { cuando: /INSERT INTO journal_entries/, responde: {} },
    { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
    { cuando: /SELECT \* FROM journal_entries WHERE id/, responde: { rows: [draft] }, unaVez: true },
    { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: lineas } },
    { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
    { cuando: /INSERT INTO account_balances/, responde: {} },
    { cuando: /SELECT \* FROM journal_entries WHERE id/, responde: { rows: [posted] } },
    { cuando: /SELECT tenant_id FROM legal_entities/, responde: { rows: [{ tenant_id: 'tenant-1' }] } },
    { cuando: /INSERT INTO audit_log/, responde: {} },
  ]);
}

beforeEach(() => {
  validateJournalEntry.mockReset();
  validateJournalEntry.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  attest.mockReset();
  attest.mockResolvedValue(undefined);
});

describe('createJournalEntry · rama borrador', () => {
  it('inserta encabezado y una línea por cada renglón, y NO toca saldos', async () => {
    const cf = (arnes.actual = reglasAlta());
    const entry = await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'Venta', LINEAS, ID.usuario
    );

    expect(cf.coincidencias(/INSERT INTO journal_entries/)).toHaveLength(1);
    expect(cf.coincidencias(/INSERT INTO journal_entry_lines/)).toHaveLength(2);
    // Sin autoPost no hay posteo ni saldos: es la garantía de la rama borrador.
    expect(cf.coincidencias(/UPDATE journal_entries SET status = 'posted'/)).toHaveLength(0);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
    expect(entry.lines).toHaveLength(2);
  });

  it('numera las líneas 1..n en el orden recibido', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario);

    const inserts = cf.coincidencias(/INSERT INTO journal_entry_lines/);
    expect(inserts.map((c) => c.params[2])).toEqual([1, 2]);
    expect(inserts.map((c) => c.params[3])).toEqual([ID.cuentaA, ID.cuentaB]);
  });

  it('toma el folio del contador atómico, no de un COUNT(*)', async () => {
    const cf = (arnes.actual = reglasAlta({ siguienteFolio: '42' }));
    await createJournalEntry(ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario);

    expect(cf.coincidencias(/SELECT COUNT\(\*\) as count FROM journal_entries/)).toHaveLength(0);
    const seq = cf.coincidencias(/INSERT INTO entity_sequences/);
    expect(seq).toHaveLength(1);
    // R3: la llave del contador y el año impreso salen de la FECHA DEL
    // DOCUMENTO (2026-08-15 arriba), no del reloj de la corrida.
    expect(seq[0].params).toEqual([ID.entidad, 'journal_entry_2026']);
    const cabecera = cf.coincidencias(/INSERT INTO journal_entries/)[0];
    expect(cabecera.params[1]).toBe('JE-2026-00042');
  });

  it('propaga is_reversal y reverses_entry_id al encabezado', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'reversing' as never, 'reversa', LINEAS, ID.usuario,
      { isReversal: true, reversesEntryId: ID.asiento }
    );
    const p = cf.coincidencias(/INSERT INTO journal_entries/)[0].params;
    // status va literal en el SQL, no como parámetro: is_reversal es $12 → índice 11
    expect(p[11]).toBe(true);
    expect(p[12]).toBe(ID.asiento);
  });

  it('rechaza con PERIOD_CLOSED si no hay periodo abierto para la fecha', async () => {
    arnes.actual = reglasAlta({ periodo: false });
    await expect(
      createJournalEntry(ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario)
    ).rejects.toThrow(/No open fiscal period/);
  });
});

describe('createJournalEntry · rama autoPost', () => {
  it('valida ANTES de postear y aplica un upsert de saldos por línea', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'Venta', LINEAS, ID.usuario,
      { autoPost: true }
    );

    expect(validateJournalEntry).toHaveBeenCalledTimes(1);
    expect(cf.coincidencias(/UPDATE journal_entries SET status = 'posted'/)).toHaveLength(1);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
  });

  it('si la validación falla, NO postea ni toca saldos', async () => {
    validateJournalEntry.mockResolvedValue({
      isValid: false, errors: ['Debits must equal credits'], warnings: [],
    });
    const cf = (arnes.actual = reglasAlta());

    await expect(
      createJournalEntry(ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario,
        { autoPost: true })
    ).rejects.toThrow(/Validation failed/);

    expect(cf.coincidencias(/UPDATE journal_entries SET status = 'posted'/)).toHaveLength(0);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it('el upsert de saldos lleva cuenta, periodo y entidad del asiento', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario, { autoPost: true }
    );
    const saldos = cf.coincidencias(/INSERT INTO account_balances/);
    expect(saldos[0].params.slice(0, 3)).toEqual([ID.cuentaA, ID.periodo, ID.entidad]);
    expect(saldos[1].params.slice(0, 3)).toEqual([ID.cuentaB, ID.periodo, ID.entidad]);
  });
});

describe('createJournalEntry · transacción del llamador', () => {
  it('con options.client corre sobre ese cliente y no abre transacción propia', async () => {
    const cf = (arnes.actual = reglasAlta());
    const conexion = await import('../../src/database/connection.js');
    (conexion.withTransaction as unknown as Mock).mockClear();

    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario,
      { autoPost: true, client: cf.client }
    );

    expect(conexion.withTransaction).not.toHaveBeenCalled();
    expect(cf.coincidencias(/INSERT INTO journal_entries/)).toHaveLength(1);
  });

  it('con transacción propia la atestación se lanza DESPUÉS del commit', async () => {
    arnes.actual = reglasAlta();
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario, { autoPost: true }
    );
    await drainAttestations(500);
    expect(attest).toHaveBeenCalledTimes(1);
  });

  it('si la atestación falla el alta NO se rompe: el fallo se registra y se descarta', async () => {
    arnes.actual = reglasAlta();
    attest.mockRejectedValueOnce(new Error('cadena caída'));
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // El alta ya está comprometida cuando arranca la atestación: si el sello
    // en cadena revienta, el asiento sigue en pie y el rechazo no queda suelto.
    await expect(createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario, { autoPost: true }
    )).resolves.toBeDefined();
    await expect(drainAttestations(500)).resolves.toBeUndefined();

    expect(avisos).toHaveBeenCalledWith('Blockchain attestation skipped:', 'cadena caída');
    avisos.mockRestore();
  });

  it('con cliente del llamador la atestación NO se dispara: es del llamador', async () => {
    const cf = (arnes.actual = reglasAlta());
    await createJournalEntry(
      ID.entidad, new Date('2026-08-15'), 'standard' as never, 'x', LINEAS, ID.usuario,
      { autoPost: true, client: cf.client }
    );
    await drainAttestations(200);
    expect(attest).not.toHaveBeenCalled();
  });
});
