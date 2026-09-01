import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { clienteFalso, type ClienteFalso, type ReglaConsulta } from '../helpers/fake-pg.js';
import { asientoFalso, lineaFalsa, ID } from '../helpers/entidades.js';
import type { JournalEntry } from '../../src/types/index.js';

// ============================================================
// F01 · MAKER-CHECKER HUMANO en postJournalEntry
//
// La política del panel (segregacion_de_funciones) decide si quien creó un
// borrador MANUAL puede postearlo. Aquí se prueba la compuerta en sus dos
// direcciones y sus dos exenciones: 'exigir' bloquea al mismo usuario en
// póliza manual, deja pasar a un usuario distinto, deja pasar las pólizas
// DEL SISTEMA (source_type no nulo — nómina, ai_draft, reversas), y
// 'alertar' postea con la coincidencia anotada en la fila de auditoría.
// ============================================================

const { arnes, validateJournalEntry, attest, politicaValor } = vi.hoisted(() => ({
  arnes: { actual: null } as { actual: ClienteFalso | null },
  validateJournalEntry: vi.fn(),
  attest: vi.fn(),
  politicaValor: { actual: 'off' },
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

vi.mock('../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(async (_ctx: unknown, key: string) => ({
    key, value: politicaValor.actual, defined: true, question: '', rationale: '',
  })),
}));

import { postJournalEntry } from '../../src/services/accounting/posting.js';
import { getPolicy } from '../../src/services/policy/policy-service.js';

const mockGetPolicy = getPolicy as unknown as Mock;

const LINEAS_BD = [
  lineaFalsa({ line_number: 1, account_id: ID.cuentaA, debit_amount: '1000.0000' }),
  lineaFalsa({ line_number: 2, account_id: ID.cuentaB, credit_amount: '1000.0000' }),
];

function reglas(entry: JournalEntry, extra: ReglaConsulta[] = []) {
  return clienteFalso([
    { cuando: /INSERT INTO audit_log/, responde: {} },
    { cuando: /SELECT status, period_name FROM fiscal_periods WHERE id = \$1 FOR SHARE/, responde: { rows: [{ status: 'open', period_name: 'Periodo de prueba' }] } },
    { cuando: /SELECT \* FROM journal_entries WHERE id = \$1 FOR UPDATE/, responde: { rows: [entry] } },
    { cuando: /SELECT \* FROM journal_entry_lines WHERE journal_entry_id/, responde: { rows: LINEAS_BD } },
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
  mockGetPolicy.mockClear();
  politicaValor.actual = 'off';
});

describe('segregación de funciones en el posteo', () => {
  it("con 'exigir', el mismo usuario NO postea su borrador manual — y nada se escribe", async () => {
    politicaValor.actual = 'exigir';
    const cf = (arnes.actual = reglas(asientoFalso({ created_by: ID.usuario } as Partial<JournalEntry>)));
    await expect(postJournalEntry(ID.asiento, ID.usuario)).rejects.toThrow(/segregación de funciones/);
    expect(cf.coincidencias(/UPDATE journal_entries/)).toHaveLength(0);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(0);
  });

  it("con 'exigir', OTRO usuario sí postea (cuatro ojos satisfechos)", async () => {
    politicaValor.actual = 'exigir';
    const cf = (arnes.actual = reglas(asientoFalso({ created_by: 'otro-usuario' } as Partial<JournalEntry>)));
    await postJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
    // Creador distinto: la política NI SE CONSULTA — la compuerta es para la
    // coincidencia, no un peaje de cada posteo.
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });

  it("con 'exigir', una póliza DEL SISTEMA postea aunque creador=posteador (exención por source_type)", async () => {
    politicaValor.actual = 'exigir';
    const cf = (arnes.actual = reglas(
      asientoFalso({ created_by: ID.usuario, source_type: 'pay_run' } as Partial<JournalEntry>)
    ));
    await postJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });

  it("con 'alertar', postea y la fila de auditoría dice la coincidencia", async () => {
    politicaValor.actual = 'alertar';
    const cf = (arnes.actual = reglas(asientoFalso({ created_by: ID.usuario } as Partial<JournalEntry>)));
    await postJournalEntry(ID.asiento, ID.usuario);
    const auditorias = cf.coincidencias(/INSERT INTO audit_log/);
    expect(auditorias).toHaveLength(1);
    expect(JSON.stringify(auditorias[0].params)).toMatch(/quien postea es quien creó/);
  });

  it("con 'off' (o un valor desconocido) no estorba: cerrado al declarar, abierto al escribir", async () => {
    politicaValor.actual = 'lo-que-sea';
    const cf = (arnes.actual = reglas(asientoFalso({ created_by: ID.usuario } as Partial<JournalEntry>)));
    await postJournalEntry(ID.asiento, ID.usuario);
    expect(cf.coincidencias(/INSERT INTO account_balances/)).toHaveLength(2);
  });
});
