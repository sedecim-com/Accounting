import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  listPagosSinRep,
  reprocesarREPsAparcados,
} from '../../src/services/xml-ingestion/rep-pendientes.js';
import { query } from '../../src/database/connection.js';
import type { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';

const mockQuery = query as unknown as Mock;

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('listPagosSinRep', () => {
  // MNE-001-125: the list reads accounting/rep-expected.ts, the same one the
  // close counts: first the entity's jurisdiction, then received, then issued.
  const MEXICAN = { rows: [{ incorporation_country: 'MX', accounting_standard: 'mx_nif' }] };
  const row = (payment_id: string, over: Record<string, unknown> = {}) => ({
    payment_id, payment_number: payment_id.toUpperCase(), payment_date: '2026-08-10', counterparty: 'X',
    amount: '100.0000', currency_code: 'MXN', age_days: 3,
    cfdi_metodo: null, terms: null, memo: null, stamped: true, ...over,
  });

  it('received: supplier payments on PPD bills, PUE excluded, with the method the ledger used', async () => {
    mockQuery
      .mockResolvedValueOnce(MEXICAN)
      .mockResolvedValueOnce({ rows: [row('vp-1', { cfdi_metodo: 'PUE' }), row('vp-2', { cfdi_metodo: 'PPD' }), row('vp-3')] })
      .mockResolvedValueOnce({ rows: [row('cp-1', { cfdi_metodo: 'PPD' })] });
    const rows = await listPagosSinRep('ent-1', { direction: 'received' });
    expect(rows.map((r) => [r.payment_number, r.metodo])).toEqual([['VP-2', 'PPD'], ['VP-3', 'desconocido']]);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/FROM vendor_payments/);
    expect(sql).toMatch(/status = 'completed'/);
    expect(sql).toMatch(/unapplied_at IS NULL/);
    expect(params).toEqual(['ent-1']);
  });

  it('issued: our collections without a REP, plus the stamped ones whose method is unknown, above the minimum', async () => {
    mockQuery
      .mockResolvedValueOnce(MEXICAN)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          row('cp-1', { cfdi_metodo: 'PPD', amount: '50.0000' }),
          row('cp-2', { cfdi_metodo: 'PPD', payment_date: '2026-08-12' }),
          row('cp-3'),
          row('cp-4', { cfdi_metodo: 'PUE' }),
        ],
      });
    const rows = await listPagosSinRep('ent-1', { direction: 'issued', minAmount: 100 });
    expect(rows.map((r) => [r.payment_number, r.metodo])).toEqual([['CP-3', 'desconocido'], ['CP-2', 'PPD']]);
  });

  it('una dirección inventada es error de uso, no una lista vacía silenciosa', async () => {
    await expect(
      listPagosSinRep('ent-1', { direction: 'diagonal' as never })
    ).rejects.toThrow(/received o issued/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('reprocesarREPsAparcados', () => {
  const aparcados = [
    { id: 'rep-1', external_reference: 'A', document_date: '2026-08-01', total_amount: '100', error_message: null },
    { id: 'rep-2', external_reference: 'B', document_date: '2026-08-02', total_amount: '200', error_message: null },
    { id: 'rep-3', external_reference: 'C', document_date: '2026-08-03', total_amount: '300', error_message: null },
  ];

  it('clasifica cada reintento: ligado, sigue aparcado (decisión) o error real', async () => {
    mockQuery.mockResolvedValueOnce({ rows: aparcados }); // listRepAparcados
    // Un SELECT * por cada reintento:
    mockQuery.mockResolvedValue({ rows: [{ id: 'x', document_type: 'payment' }] });

    const processToAccounting = vi
      .fn()
      .mockResolvedValueOnce({ paymentId: 'p1' })
      .mockRejectedValueOnce(Object.assign(new Error('falta la factura'), { code: 'CFDI_REQUIERE_DECISION' }))
      .mockRejectedValueOnce(new Error('se cayó la base'));

    const r = await reprocesarREPsAparcados('ent-1', 'user-1', {
      service: { processToAccounting } as unknown as PreRegistrationService,
    });

    expect(r.reprocesados).toBe(3);
    expect(r.ligados).toBe(1);
    expect(r.siguen_aparcados).toBe(1);
    expect(r.errores).toBe(1);
    expect(r.detalles.map((d) => d.resultado)).toEqual(['ligado', 'aparcado', 'error']);
    // Un REP que sigue pidiendo decisión NO es un error: es la política hablando.
    expect(r.detalles[1].motivo).toMatch(/falta la factura/);
  });

  it('la consulta de aparcados pide exactamente los needs_review de tipo payment', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await reprocesarREPsAparcados('ent-1', 'user-1', {
      service: { processToAccounting: vi.fn() } as unknown as PreRegistrationService,
    });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/document_type = 'payment'/);
    expect(sql).toMatch(/validation_status = 'needs_review'/);
    expect(sql).toMatch(/NOT IN \('completed', 'rejected', 'duplicate'\)/);
  });
});
