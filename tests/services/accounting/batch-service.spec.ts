import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/accounting/journal-entry-service.js', () => ({
  checkDraftDocument: vi.fn(),
  resolveDraftLines: vi.fn(),
}));
vi.mock('../../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(),
  reverseWithinTransaction: vi.fn(),
  // G3: la puerta del lote llama al candado compartido. Devuelve null —sin
  // nota— porque estas pruebas son de la aplicación del lote, no de la
  // política; el candado tiene sus propias pruebas de conducta.
  exigirSegregacion: vi.fn(async () => null),
}));
vi.mock('../../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(),
}));

import { query, withTransaction } from '../../../src/database/connection.js';
import { checkDraftDocument, resolveDraftLines } from '../../../src/services/accounting/journal-entry-service.js';
import { createJournalEntry, reverseWithinTransaction } from '../../../src/services/accounting/posting.js';
import {
  ORIGEN_LOTE_IMPORTADO,
  checkBatch,
  listBatches,
  normalizarPayload,
  postBatch,
  reverseBatch,
  showBatch,
} from '../../../src/services/accounting/batch-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const mockCheckDraft = checkDraftDocument as unknown as Mock;
const mockResolveLines = resolveDraftLines as unknown as Mock;
const mockCreate = createJournalEntry as unknown as Mock;
const mockReverse = reverseWithinTransaction as unknown as Mock;

const CTX = { tenantId: 'ten-1', entityId: 'ent-1' };

interface ClienteFalso {
  query: Mock;
}
const cliente: ClienteFalso = { query: vi.fn() };

function lote(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lote-1',
    tenant_id: 'ten-1',
    entity_id: 'ent-1',
    layout: 'ndjson',
    file_name: 'agosto.ndjson',
    file_hash: 'a'.repeat(64),
    rows_total: 2,
    rows_invalid: 0,
    status,
    created_by: 'u1',
    created_at: new Date('2026-08-30T12:00:00'),
    ...extra,
  };
}

function payloadValido(monto = '100'): Record<string, unknown> {
  return {
    date: '2026-08-20',
    description: 'ok',
    lines: [
      { account: '6100', debit: monto },
      { account: '1110', credit: monto },
    ],
  };
}

function fila(rowNumber: number, payload: unknown, parseError: string | null = null): Record<string, unknown> {
  return { id: `fila-${rowNumber}`, row_number: rowNumber, payload, parse_error: parseError };
}

const veredictoLimpio = { isValid: true, errors: [] as string[], warnings: [] as string[] };
const lineasResueltas = [
  { account_id: 'acc-6100', debit_amount: '100', credit_amount: null, description: '' },
  { account_id: 'acc-1110', debit_amount: null, credit_amount: '100', description: '' },
];

beforeEach(() => {
  mockQuery.mockReset();
  cliente.query.mockReset();
  mockCheckDraft.mockReset();
  mockResolveLines.mockReset();
  mockCreate.mockReset();
  mockReverse.mockReset();
  mockTx.mockReset();
  mockTx.mockImplementation((fn: (c: ClienteFalso) => Promise<unknown>) => fn(cliente));
});

// ============================================================
// El payload JSONB es input NO confiable: la aduana de tipos
// ============================================================

describe('normalizarPayload — la aduana del JSONB', () => {
  it('rechaza un payload que no es objeto de póliza', () => {
    expect(() => normalizarPayload('ent-1', 'u1', 'hola')).toThrow(/objeto de póliza/);
    expect(() => normalizarPayload('ent-1', 'u1', null)).toThrow(/objeto de póliza/);
    expect(() => normalizarPayload('ent-1', 'u1', [1, 2])).toThrow(/objeto de póliza/);
  });

  it('la fecha debe ser texto: un número JSON no pasa', () => {
    expect(() => normalizarPayload('ent-1', 'u1', { date: 20260820, lines: [] })).toThrow(/fecha.*texto/);
  });

  it('lines debe ser una lista; una línea que no es objeto se rechaza con su número', () => {
    expect(() => normalizarPayload('ent-1', 'u1', { date: '2026-08-20', lines: 'x' })).toThrow(/lista/);
    expect(() =>
      normalizarPayload('ent-1', 'u1', { date: '2026-08-20', lines: [{ account: '6100', debit: '1' }, 'pum'] })
    ).toThrow(/línea 2: no es un objeto/);
  });

  it('un importe numérico JSON se NORMALIZA a cadena sin aritmética flotante', () => {
    const borrador = normalizarPayload('ent-1', 'u1', {
      date: '2026-08-20',
      lines: [
        { account: '6100', debit: 100.5 },
        { account: '1110', credit: '100.50' },
      ],
    });
    expect(borrador.lines[0].debit).toBe('100.5');
    expect(typeof borrador.lines[0].debit).toBe('string');
    expect(borrador.lines[1].credit).toBe('100.50');
  });

  it('un importe booleano u objeto se rechaza nombrando el lado y la línea', () => {
    expect(() =>
      normalizarPayload('ent-1', 'u1', { date: '2026-08-20', lines: [{ account: '6100', debit: true }] })
    ).toThrow(/línea 1: el debit debe ser una cadena decimal/);
    expect(() =>
      normalizarPayload('ent-1', 'u1', { date: '2026-08-20', lines: [{ account: '6100', credit: {} }] })
    ).toThrow(/línea 1: el credit/);
  });

  it('el lado vacío queda null; un código de cuenta numérico se acepta como texto', () => {
    const borrador = normalizarPayload('ent-1', 'u1', {
      date: '2026-08-20',
      lines: [
        { account: 6100, debit: '10', credit: '' },
        { account: '1110', credit: '10' },
      ],
    });
    expect(borrador.lines[0].account).toBe('6100');
    expect(borrador.lines[0].credit).toBeNull();
  });

  it('description y reference deben ser texto si vienen', () => {
    expect(() =>
      normalizarPayload('ent-1', 'u1', { date: '2026-08-20', description: 7, lines: [] })
    ).toThrow(/description debe ser texto/);
    const borrador = normalizarPayload('ent-1', 'u1', {
      date: '2026-08-20',
      reference: 'FAC-9',
      lines: [{ account: '6100', debit: '1' }],
    });
    expect(borrador.reference).toBe('FAC-9');
  });
});

// ============================================================
// batch check — la máquina de estados y el veredicto por fila
// ============================================================

describe('checkBatch — sólo desde staged, error por fila con su número', () => {
  it('un lote checked no se verifica dos veces: ConflictError sin validar nada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('checked')] });
    await expect(checkBatch(CTX, 'lote-1', 'u1')).rejects.toThrow(ConflictError);
    expect(mockCheckDraft).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('un lote posted tampoco: el flujo es staged → checked → posted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('posted')] });
    await expect(checkBatch(CTX, 'lote-1', 'u1')).rejects.toThrow(/staged → checked → posted/);
  });

  it('el lote de otra entidad no existe: NotFoundError, jamás 403', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(checkBatch(CTX, 'lote-ajeno', 'u1')).rejects.toThrow(NotFoundError);
  });

  it('todas válidas: mueve staged→checked y deja rows_invalid en 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido('50'))] });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] }); // FOR UPDATE
    cliente.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

    const r = await checkBatch(CTX, 'lote-1', 'u1');

    expect(r.status).toBe('checked');
    expect(r.validas).toBe(2);
    expect(r.invalidas).toBe(0);
    expect(cliente.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE journal_entry_import_batches'),
      [0, 'checked', 'lote-1', 'ten-1', 'ent-1']
    );
  });

  it('una fila con parse_error no tumba a las demás: sale con categoría parse y el lote se queda staged', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    mockQuery.mockResolvedValueOnce({
      rows: [fila(1, payloadValido()), fila(2, null, 'JSON ilegible: pum')],
    });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    const r = await checkBatch(CTX, 'lote-1', 'u1');

    expect(r.status).toBe('staged');
    expect(r.invalidas).toBe(1);
    expect(r.filas[1]).toMatchObject({ row_number: 2, ok: false, categoria: 'parse' });
    expect(r.filas[1].errores[0]).toMatch(/JSON ilegible/);
    // La fila ilegible no se revalida: sólo la sana pasó por las siete reglas.
    expect(mockCheckDraft).toHaveBeenCalledTimes(1);
    expect(cliente.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE journal_entry_import_batches'),
      [1, 'staged', 'lote-1', 'ten-1', 'ent-1']
    );
  });

  it('los errores de validación llegan con el número de SU fila', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido())] });
    mockCheckDraft.mockResolvedValueOnce(veredictoLimpio);
    mockCheckDraft.mockResolvedValueOnce({
      isValid: false,
      errors: ['Debits (100.0000) must equal credits (90.0000)'],
      warnings: [],
    });
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    const r = await checkBatch(CTX, 'lote-1', 'u1');

    expect(r.filas[0].ok).toBe(true);
    expect(r.filas[1]).toMatchObject({ row_number: 2, categoria: 'validacion' });
    expect(r.filas[1].errores[0]).toMatch(/must equal credits/);
  });

  it('la cuenta ajena o inexistente cae en categoría cuenta; el periodo sin abrir, en periodo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido())] });
    mockCheckDraft.mockRejectedValueOnce(new NotFoundError('Account', '9999'));
    mockCheckDraft.mockRejectedValueOnce(
      new ValidationError('No open fiscal period covers 2026-08-20. Open it with `mnemosine period open`.')
    );
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    const r = await checkBatch(CTX, 'lote-1', 'u1');

    expect(r.filas[0].categoria).toBe('cuenta');
    expect(r.filas[1].categoria).toBe('periodo');
    expect(r.invalidas).toBe(2);
  });

  it('--strict vuelve bloqueantes las advertencias; sin strict no frenan', async () => {
    const conAviso = { isValid: true, errors: [], warnings: ['manual posting to equity account'] };
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged', { rows_total: 1 })] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido())] });
    mockCheckDraft.mockResolvedValue(conAviso);
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    const estricto = await checkBatch(CTX, 'lote-1', 'u1', { strict: true });
    expect(estricto.status).toBe('staged');
    expect(estricto.filas[0].ok).toBe(false);
    expect(estricto.filas[0].errores[0]).toMatch(/^estricto:/);

    mockQuery.mockResolvedValueOnce({ rows: [lote('staged', { rows_total: 1 })] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido())] });
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    const laxo = await checkBatch(CTX, 'lote-1', 'u1');
    expect(laxo.status).toBe('checked');
    expect(laxo.filas[0].advertencias).toHaveLength(1);
  });
});

// ============================================================
// batch post — sólo desde checked; --partial deja lo inválido
// ============================================================

describe('postBatch — postear sin verificar es lo que el flujo impide', () => {
  it('staged sin --partial: ConflictError y ninguna póliza creada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    await expect(postBatch(CTX, 'lote-1', 'u1')).rejects.toThrow(/batch check/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('checked y todo válido: una póliza por fila, con source_type import_batch y source_id = LA FILA', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('checked')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido())] });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('checked')] }); // FOR UPDATE
    cliente.query.mockResolvedValueOnce({ rows: [] }); // ya posteadas
    cliente.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockResolveLines.mockResolvedValue(lineasResueltas);
    mockCreate.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00001' });
    mockCreate.mockResolvedValueOnce({ id: 'je-2', entry_number: 'JE-2026-00002' });

    const r = await postBatch(CTX, 'lote-1', 'u1');

    expect(r.status).toBe('posted');
    expect(r.posteadas).toEqual([
      { row_number: 1, entry_id: 'je-1', entry_number: 'JE-2026-00001' },
      { row_number: 2, entry_id: 'je-2', entry_number: 'JE-2026-00002' },
    ]);
    expect(r.total_debe).toBe('200.0000');
    expect(r.attestations).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledWith(
      'ent-1',
      expect.any(Date),
      'standard',
      'ok',
      lineasResueltas,
      'u1',
      expect.objectContaining({
        client: cliente,
        autoPost: true,
        sourceType: ORIGEN_LOTE_IMPORTADO,
        sourceId: 'fila-1',
      })
    );
    expect(cliente.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE journal_entry_import_batches'),
      [0, 'posted', 'lote-1', 'ten-1', 'ent-1']
    );
  });

  it('checked pero el mundo cambió: sin --partial nada se aplica y se nombran las filas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('checked')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido())] });
    mockCheckDraft.mockResolvedValueOnce(veredictoLimpio);
    mockCheckDraft.mockResolvedValueOnce({ isValid: false, errors: ['Cannot post to hard_close period'], warnings: [] });
    cliente.query.mockResolvedValueOnce({ rows: [lote('checked')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });

    await expect(postBatch(CTX, 'lote-1', 'u1')).rejects.toThrow(/filas 2.*nada se aplicó/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('--partial aplica lo válido, DEJA lo inválido en staging y dice cuánto quedó', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('staged')] });
    mockQuery.mockResolvedValueOnce({
      rows: [fila(1, payloadValido()), fila(2, null, 'fecha ilegible "ayer"')],
    });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('staged')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });
    cliente.query.mockResolvedValueOnce({ rows: [] });
    mockResolveLines.mockResolvedValue(lineasResueltas);
    mockCreate.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00001' });

    const r = await postBatch(CTX, 'lote-1', 'u1', { partial: true });

    expect(r.status).toBe('staged');
    expect(r.posteadas).toHaveLength(1);
    expect(r.invalidas).toEqual([
      expect.objectContaining({ row_number: 2, categoria: 'parse' }),
    ]);
    expect(cliente.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE journal_entry_import_batches'),
      [1, 'staged', 'lote-1', 'ten-1', 'ent-1']
    );
  });

  it('idempotente: la fila que ya tiene póliza se salta — postear dos veces no postea dos veces', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('checked')] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido()), fila(2, payloadValido())] });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('checked')] });
    cliente.query.mockResolvedValueOnce({ rows: [{ row_number: 1 }] }); // la corrida anterior ya la aplicó
    cliente.query.mockResolvedValueOnce({ rows: [] });
    mockResolveLines.mockResolvedValue(lineasResueltas);
    mockCreate.mockResolvedValueOnce({ id: 'je-2', entry_number: 'JE-2026-00002' });

    const r = await postBatch(CTX, 'lote-1', 'u1');

    expect(r.ya_posteadas).toBe(1);
    expect(r.posteadas).toEqual([{ row_number: 2, entry_id: 'je-2', entry_number: 'JE-2026-00002' }]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('--dry-run recorre el camino real, devuelve el resultado y no entrega atestaciones', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('checked', { rows_total: 1 })] });
    mockQuery.mockResolvedValueOnce({ rows: [fila(1, payloadValido())] });
    mockCheckDraft.mockResolvedValue(veredictoLimpio);
    cliente.query.mockResolvedValueOnce({ rows: [lote('checked')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });
    cliente.query.mockResolvedValueOnce({ rows: [] });
    mockResolveLines.mockResolvedValue(lineasResueltas);
    mockCreate.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00001' });

    const r = await postBatch(CTX, 'lote-1', 'u1', { dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.posteadas).toHaveLength(1);
    // La transacción se revierte: atestar una póliza que no existe sería peor.
    expect(r.attestations).toEqual([]);
    // El ensayo NO es una simulación: el UPDATE del encabezado sí corrió
    // dentro de la transacción que withTransaction revertirá.
    expect(cliente.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE journal_entry_import_batches'),
      expect.anything()
    );
  });
});

// ============================================================
// batch reverse — todos los espejos en una transacción, o nada
// ============================================================

function poliza(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `je-${n}`,
    entry_number: `JE-2026-0000${n}`,
    entity_id: 'ent-1',
    status: 'posted',
    reversed_by_entry_id: null,
    ...extra,
  };
}

describe('reverseBatch — el lote se reversa como unidad', () => {
  it('sin motivo no hay reversa: ValidationError antes de tocar la base', async () => {
    await expect(reverseBatch(CTX, 'lote-1', 'u1', { reason: '  ' })).rejects.toThrow(/--reason/);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('un as-of malformado se rechaza con el formato esperado', async () => {
    await expect(
      reverseBatch(CTX, 'lote-1', 'u1', { reason: 'error', asOf: '20/08/2026' })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('sólo desde posted: un lote checked no tiene nada en el mayor que reversar', async () => {
    cliente.query.mockResolvedValueOnce({ rows: [lote('checked')] });
    await expect(reverseBatch(CTX, 'lote-1', 'u1', { reason: 'error' })).rejects.toThrow(ConflictError);
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('se niega nombrando la póliza que ya fue reversada a mano', async () => {
    cliente.query.mockResolvedValueOnce({ rows: [lote('posted')] });
    cliente.query.mockResolvedValueOnce({
      rows: [poliza(7, { reversed_by_entry_id: 'je-99' }), poliza(8)],
    });
    await expect(reverseBatch(CTX, 'lote-1', 'u1', { reason: 'error' })).rejects.toThrow(/JE-2026-00007/);
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('si TODAS ya tienen espejo, el lote ya fue reversado: máximo una reversa', async () => {
    cliente.query.mockResolvedValueOnce({ rows: [lote('posted')] });
    cliente.query.mockResolvedValueOnce({
      rows: [poliza(1, { reversed_by_entry_id: 'x' }), poliza(2, { reversed_by_entry_id: 'y' })],
    });
    await expect(reverseBatch(CTX, 'lote-1', 'u1', { reason: 'error' })).rejects.toThrow(/ya fue reversado entero/);
  });

  it('camino feliz: un espejo por póliza, UNA transacción, y el lote sigue posted', async () => {
    cliente.query.mockResolvedValueOnce({ rows: [lote('posted')] });
    cliente.query.mockResolvedValueOnce({ rows: [poliza(1), poliza(2)] });
    mockReverse.mockResolvedValueOnce({ id: 'rev-1', entry_number: 'JE-2026-00011' });
    mockReverse.mockResolvedValueOnce({ id: 'rev-2', entry_number: 'JE-2026-00012' });

    const r = await reverseBatch(CTX, 'lote-1', 'u1', { reason: 'lote duplicado', asOf: '2026-08-31' });

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(mockReverse).toHaveBeenCalledTimes(2);
    expect(mockReverse).toHaveBeenCalledWith(
      cliente,
      expect.objectContaining({ entry_number: 'JE-2026-00001' }),
      'u1',
      'Reversal of JE-2026-00001: lote duplicado',
      expect.any(Date)
    );
    expect(r.status).toBe('posted');
    expect(r.espejos).toEqual([
      { original: 'JE-2026-00001', espejo: 'JE-2026-00011', espejo_id: 'rev-1' },
      { original: 'JE-2026-00002', espejo: 'JE-2026-00012', espejo_id: 'rev-2' },
    ]);
    expect(r.attestations).toHaveLength(2);
    // El SELECT de las pólizas va acotado y bajo candado en el MISMO SQL.
    expect(cliente.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FOR UPDATE OF je'),
      ['ten-1', 'lote-1', 'ent-1', ORIGEN_LOTE_IMPORTADO]
    );
  });

  it('un lote posted sin pólizas en el mayor es una incoherencia, no una reversa vacía', async () => {
    cliente.query.mockResolvedValueOnce({ rows: [lote('posted')] });
    cliente.query.mockResolvedValueOnce({ rows: [] });
    await expect(reverseBatch(CTX, 'lote-1', 'u1', { reason: 'error' })).rejects.toThrow(/nada que reversar/);
  });
});

// ============================================================
// batch list · batch show — lecturas acotadas
// ============================================================

describe('listBatches y showBatch', () => {
  it('rechaza estados y clases fuera del vocabulario de la 045', async () => {
    await expect(listBatches(CTX, { status: 'running' })).rejects.toThrow(/Estado de lote desconocido/);
    await expect(listBatches(CTX, { kind: 'revaluacion' })).rejects.toThrow(/Clase de lote desconocida/);
    await expect(listBatches(CTX, { since: 'ayer' })).rejects.toThrow(/YYYY-MM-DD/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('la lista va acotada por inquilino Y entidad dentro del SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBatches(CTX, { status: 'staged' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('b.tenant_id = $1 AND b.entity_id = $2'),
      ['ten-1', 'ent-1', ORIGEN_LOTE_IMPORTADO, 'staged', 50]
    );
  });

  it('show agrupa los parse_error por categoría y liga cada fila con su póliza', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [lote('posted')] });
    mockQuery.mockResolvedValueOnce({ rows: [{ entries_posted: 1 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          row_number: 1,
          payload: null,
          parse_error: 'JSON ilegible: pum',
          entry_id: null,
          entry_number: null,
          reversed_by_entry_id: null,
        },
        {
          row_number: 2,
          payload: payloadValido(),
          parse_error: null,
          entry_id: 'je-9',
          entry_number: 'JE-2026-00009',
          reversed_by_entry_id: null,
        },
      ],
    });

    const r = await showBatch(CTX, 'lote-1');

    expect(r.errores_por_categoria).toEqual({ json: 1 });
    expect(r.lote.entries_posted).toBe(1);
    expect(r.filas[0]).toMatchObject({ row_number: 1, categoria: 'json', entry_number: null });
    expect(r.filas[1]).toMatchObject({
      row_number: 2,
      entry_number: 'JE-2026-00009',
      total_debe: '100.0000',
      entry_reversed: false,
    });
  });
});
