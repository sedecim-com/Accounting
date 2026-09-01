import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clienteFalso, type ClienteFalso, type ReglaConsulta } from '../helpers/fake-pg.js';
import { asientoFalso, lineaFalsa, ID } from '../helpers/entidades.js';
import type { JournalEntry } from '../../src/types/index.js';

// vi.hoisted eleva estas referencias junto con los vi.mock que las capturan:
// sin esto haría falta un import dinámico (await de nivel superior), que bajo
// CommonJS es un error de compilación aunque el runtime lo soporte.
const { arnes, validateJournalEntry, attest } = vi.hoisted(() => ({
  arnes: { actual: null } as { actual: ClienteFalso | null },
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

import { postJournalEntry, reverseJournalEntry, voidJournalEntry, voidJournalEntryInTx, drainAttestations } from '../../src/services/accounting/posting.js';

/** El motor escribe el rastro de auditoría en TODA ruta de escritura del
 *  libro; el arnés es estricto y lo desconocería. Ver src/services/audit. */
const AUDITORIA: ReglaConsulta = { cuando: /INSERT INTO audit_log/, responde: {} };

const LINEAS_BD = [
  lineaFalsa({ line_number: 1, account_id: ID.cuentaA, debit_amount: '1000.0000' }),
  lineaFalsa({ line_number: 2, account_id: ID.cuentaB, credit_amount: '1000.0000' }),
];

/** El asiento que devuelve el SELECT ... FOR UPDATE. */
function reglas(entry: JournalEntry, extra: ReglaConsulta[] = []) {
  return clienteFalso([
      AUDITORIA,
    // R1: el posteo toma el candado compartido del periodo dentro de su transacción.
    { cuando: /SELECT status, period_name FROM fiscal_periods WHERE id = \$1 FOR SHARE/, responde: { rows: [{ status: 'open', period_name: 'Periodo de prueba' }] } },
    { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [entry] } },
    { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
    { cuando: /UPDATE journal_entries SET status = 'posted'|UPDATE journal_entries SET status = 'posted', posted_date/, responde: {} },
    { cuando: /UPDATE journal_entries\s+SET status = 'posted'/, responde: {} },
    { cuando: /INSERT INTO account_balances/, responde: {} },
    ...extra,
    { cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/, responde: { rows: [entry] } },
  ]);
}

beforeEach(() => {
  validateJournalEntry.mockReset();
  validateJournalEntry.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  attest.mockReset();
  attest.mockResolvedValue(undefined);
});

describe('postJournalEntry · candados', () => {
  it('toma el asiento con FOR UPDATE: serializa posteos concurrentes del mismo id', async () => {
    const cf = (arnes.actual = reglas(asientoFalso()));
    await postJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/FOR UPDATE/)).toHaveLength(1);
  });

  it('rechaza ALREADY_POSTED si ya estaba posteado, sin tocar saldos', async () => {
    const cf = (arnes.actual = reglas(asientoFalso({ status: 'posted' } as Partial<JournalEntry>)));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/already posted/i);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it('rechaza ENTRY_VOID si el asiento está anulado', async () => {
    arnes.actual = reglas(asientoFalso({ status: 'void' } as Partial<JournalEntry>));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/voided/i);
  });

  it('rechaza ENTRY_NOT_FOUND si no existe', async () => {
    arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FOR UPDATE/, responde: { rows: [] } },
    ]);
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/not found/i);
  });

  it('valida antes de postear: si falla, ni UPDATE ni saldos', async () => {
    validateJournalEntry.mockResolvedValue({ isValid: false, errors: ['desbalanceado'], warnings: [] });
    const cf = (arnes.actual = reglas(asientoFalso()));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/Validation failed/);
    expect(cf.coincidencias(/UPDATE journal_entries/)).toHaveLength(0);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it('al postear aplica un upsert de saldos por línea', async () => {
    const cf = (arnes.actual = reglas(asientoFalso()));
    await postJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
  });

  /**
   * EL AGUJERO EN LA CADENA DE INTEGRIDAD.
   *
   * `attestEntryAsync` se disparaba al crear con autoPost, al revertir y al
   * anular — nunca aquí. Y postear un borrador es el camino normal: lo usan
   * `entry post`, REST, GraphQL y el posteo de nómina, que crea sin autoPost
   * y postea aparte. Todo asiento nacido borrador quedaba sin `entry_hash` y,
   * por tanto, fuera del sello del periodo.
   */
  it('postear un borrador lo mete en la cadena de atestación', async () => {
    arnes.actual = reglas(asientoFalso());
    await postJournalEntry(ID.asiento, ID.usuario);
    await drainAttestations(200);
    expect(attest, 'un asiento posteado desde borrador nunca entraba a la cadena').toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ journalEntryId: ID.asiento, entityId: ID.entidad })
    );
  });

  it('atesta DESPUÉS del commit, no dentro de la transacción', async () => {
    // El orquestador vuelve a leer el asiento de la base; dispararlo dentro de
    // la transacción es una carrera contra su propio commit. Se comprueba por
    // el orden observable: cuando se llama al espía, el trabajo de la
    // transacción ya está hecho.
    const cf = (arnes.actual = reglas(asientoFalso()));
    let consultasAlAtestar = -1;
    attest.mockImplementation(() => {
      consultasAlAtestar = cf.coincidencias(/INSERT INTO account_balances/).length;
      return Promise.resolve(undefined);
    });
    await postJournalEntry(ID.asiento, ID.usuario);
    await drainAttestations(200);
    expect(consultasAlAtestar, 'se atestó antes de terminar los saldos').toBe(2);
  });

  it('si la validación falla no se atesta nada', async () => {
    validateJournalEntry.mockResolvedValue({ isValid: false, errors: ['desbalanceado'], warnings: [] });
    arnes.actual = reglas(asientoFalso());
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/Validation failed/);
    await drainAttestations(200);
    expect(attest).not.toHaveBeenCalled();
  });

  it('un asiento ya posteado no se vuelve a atestar', async () => {
    arnes.actual = reglas(asientoFalso({ status: 'posted' } as Partial<JournalEntry>));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/already posted/i);
    await drainAttestations(200);
    expect(attest).not.toHaveBeenCalled();
  });
});

describe('reverseJournalEntry · NIF B-1', () => {
  /** El espejo lo crea createJournalEntry, que corre sobre el MISMO cliente. */
  function reglasReversa(original: JournalEntry) {
    return clienteFalso([
      AUDITORIA,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [original] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '8' }] } },
      { cuando: /INSERT INTO journal_entries/, responde: {} },
      { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
      {
        cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/,
        responde: { rows: [asientoFalso({ id: 'espejo', status: 'posted', is_reversal: true } as Partial<JournalEntry>)] },
      },
      { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /UPDATE journal_entries SET reversed_by_entry_id/, responde: {} },
      { cuando: /UPDATE journal_entries SET notes/, responde: {} },
      { cuando: /SELECT tenant_id FROM legal_entities/, responde: { rows: [{ tenant_id: 'tenant-1' }] } },
    ]);
  }

  it('rechaza reversar un borrador: nunca tocó saldos', async () => {
    const cf = (arnes.actual = reglasReversa(asientoFalso({ status: 'draft' } as Partial<JournalEntry>)));
    await expect(reverseJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/never touched the ledger|ENTRY_NOT_POSTED/);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it('rechaza una segunda reversa: duplicaría el efecto en saldos', async () => {
    const cf = (arnes.actual = reglasReversa(
      asientoFalso({ status: 'posted', reversed_by_entry_id: 'espejo-previo' } as Partial<JournalEntry>)
    ));
    await expect(reverseJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/already has a reversal|ALREADY_REVERSED/);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it('crea el espejo con las columnas invertidas y lo marca como reversa', async () => {
    const cf = (arnes.actual = reglasReversa(asientoFalso({ status: 'posted' } as Partial<JournalEntry>)));
    await reverseJournalEntry(ID.asiento, ID.usuario, { reason: 'error de captura' });

    const lineas = cf.coincidencias(/INSERT INTO journal_entry_lines/);
    expect(lineas).toHaveLength(2);
    // La línea 1 del original era cargo 1000 → en el espejo debe ser abono 1000.
    expect(lineas[0].params[4]).toBeNull();
    expect(lineas[0].params[5]).toBe('1000.0000');
    expect(lineas[1].params[4]).toBe('1000.0000');
    expect(lineas[1].params[5]).toBeNull();

    const cab = cf.coincidencias(/INSERT INTO journal_entries/)[0].params;
    expect(cab[11]).toBe(true);            // is_reversal
    expect(cab[12]).toBe(ID.asiento);      // reverses_entry_id
  });

  it('enlaza el original con su espejo en la misma transacción', async () => {
    const cf = (arnes.actual = reglasReversa(asientoFalso({ status: 'posted' } as Partial<JournalEntry>)));
    await reverseJournalEntry(ID.asiento, ID.usuario);
    const enlace = cf.coincidencias(/UPDATE journal_entries SET reversed_by_entry_id/);
    expect(enlace).toHaveLength(1);
    expect(enlace[0].params[1]).toBe(ID.asiento);
  });

  it('el espejo queda posteado y afecta saldos', async () => {
    const cf = (arnes.actual = reglasReversa(asientoFalso({ status: 'posted' } as Partial<JournalEntry>)));
    await reverseJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
  });
});

describe('voidJournalEntry · el estado void es solo para borradores', () => {
  it('un borrador pasa a void y NO genera espejo', async () => {
    const cf = (arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FOR UPDATE/, responde: { rows: [asientoFalso({ status: 'draft' } as Partial<JournalEntry>)] } },
      { cuando: /UPDATE journal_entries SET status = 'void'/, responde: {} },
      {
        cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/,
        responde: { rows: [asientoFalso({ status: 'void' } as Partial<JournalEntry>)] },
      },
    ]));
    const r = await voidJournalEntry(ID.asiento, ID.usuario, 'capturado por error');
    expect(r.status).toBe('void');
    expect(cf.coincidencias(/INSERT INTO journal_entries/)).toHaveLength(0);
  });

  it('un posteado NO cambia de estado: se le enlaza un espejo', async () => {
    const posted = asientoFalso({ status: 'posted' } as Partial<JournalEntry>);
    const cf = (arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FOR UPDATE/, responde: { rows: [posted] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '9' }] } },
      { cuando: /INSERT INTO journal_entries/, responde: {} },
      { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
      { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /UPDATE journal_entries SET reversed_by_entry_id/, responde: {} },
      { cuando: /UPDATE journal_entries SET notes/, responde: {} },
      { cuando: /SELECT tenant_id FROM legal_entities/, responde: { rows: [{ tenant_id: 'tenant-1' }] } },
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/, responde: { rows: [posted] } },
    ]));

    const r = await voidJournalEntry(ID.asiento, ID.usuario, 'anulada');
    // Nunca se emite un UPDATE ... SET status = 'void' sobre un posteado:
    // eso descuadraba las vistas materializadas contra account_balances.
    expect(cf.coincidencias(/SET status = 'void'/)).toHaveLength(0);
    expect(cf.coincidencias(/UPDATE journal_entries SET reversed_by_entry_id/)).toHaveLength(1);
    expect(r.status).toBe('posted');
  });

  it('rechaza anular dos veces', async () => {
    arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FOR UPDATE/, responde: { rows: [asientoFalso({ status: 'void' } as Partial<JournalEntry>)] } },
    ]);
    await expect(voidJournalEntry(ID.asiento, ID.usuario, 'otra vez')).rejects.toThrow(/already voided/i);
  });

  it('voidJournalEntryInTx corre sobre el cliente del llamador y devuelve el espejo', async () => {
    const posted = asientoFalso({ status: 'posted' } as Partial<JournalEntry>);
    const cf = (arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /FOR UPDATE/, responde: { rows: [posted] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /FROM fiscal_periods/, responde: { rows: [{ id: ID.periodo }] } },
      { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '10' }] } },
      { cuando: /INSERT INTO journal_entries/, responde: {} },
      { cuando: /INSERT INTO journal_entry_lines/, responde: {} },
      { cuando: /UPDATE journal_entries SET status = 'posted'/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /UPDATE journal_entries SET reversed_by_entry_id/, responde: {} },
      { cuando: /UPDATE journal_entries SET notes/, responde: {} },
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/, responde: { rows: [posted] } },
    ]));

    const { entry, reversal } = await voidJournalEntryInTx(cf.client, ID.asiento, ID.usuario, 'anulada');
    expect(entry.status).toBe('posted');
    expect(reversal).not.toBeNull();
    // La atestación es responsabilidad del llamador, no de esta función.
    await drainAttestations(200);
    expect(attest).not.toHaveBeenCalled();
  });
});

// ============================================================
// LAS GUARDAS QUE NADIE EJERCITABA.
//
// Son las tres rutas de error que la cobertura de posting.ts señalaba sin
// tocar. No son ramas decorativas: la del periodo es una carrera —el cierre
// pudo ganarle al posteo mientras el asiento estaba en vuelo— y las dos de
// asiento inexistente son la última línea entre una reversa y un NULL.
// ============================================================
describe('las guardas de posting.ts', () => {
  /** Igual que reglas(), pero con el candado del periodo bajo control. */
  function reglasConPeriodo(periodo: { rows: Array<{ status: string; period_name: string }> }) {
    return clienteFalso([
      AUDITORIA,
      { cuando: /SELECT status, period_name FROM fiscal_periods WHERE id = \$1 FOR SHARE/, responde: periodo },
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [asientoFalso()] } },
      { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
      { cuando: /UPDATE journal_entries/, responde: {} },
      { cuando: /INSERT INTO account_balances/, responde: {} },
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1$/, responde: { rows: [asientoFalso()] } },
    ]);
  }

  it('si el periodo desapareció entre la lectura y el candado, no postea', async () => {
    const cf = (arnes.actual = reglasConPeriodo({ rows: [] }));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/Fiscal period not found/i);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it.each(['hard_close', 'locked'])(
    'si el periodo cerró (%s) mientras el asiento estaba en vuelo, no postea y lo dice',
    async (estado) => {
      const cf = (arnes.actual = reglasConPeriodo({ rows: [{ status: estado, period_name: 'Agosto 2026' }] }));
      // El mensaje nombra el periodo y el estado: quien lo lee sabe que perdió
      // una carrera, no que su asiento estaba mal.
      await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(
        new RegExp(`Agosto 2026.*${estado}.*nothing was posted`, 'i')
      );
      expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
    }
  );

  it('reverseJournalEntry rechaza un asiento inexistente', async () => {
    arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [] } },
    ]);
    await expect(reverseJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/not found/i);
  });

  it('voidJournalEntryInTx rechaza un asiento inexistente', async () => {
    const cf = (arnes.actual = clienteFalso([
      AUDITORIA,
      { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [] } },
    ]));
    await expect(
      voidJournalEntryInTx(cf.client as never, ID.asiento, ID.usuario, 'motivo')
    ).rejects.toThrow(/not found/i);
  });
});
