import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  listPagosSinRep,
  reprocesarREPsAparcados,
} from '../../src/services/xml-ingestion/rep-pendientes.js';
import { query } from '../../src/database/connection.js';
import type { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('listPagosSinRep', () => {
  it('received: pagos a proveedor sin REP, con el método del espejo y los PUE excluidos', async () => {
    await listPagosSinRep('ent-1', { direction: 'received' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM vendor_payments/);
    expect(sql).toMatch(/vp\.cfdi_uuid IS NULL/);
    // El método sale del ESPEJO (join a xml_documents por el CFDI del bill)…
    expect(sql).toMatch(/LEFT JOIN xml_documents/);
    // …y un PUE confirmado no exige REP: se excluye en el HAVING.
    expect(sql).toMatch(/<> 'PUE'/);
    expect(params[0]).toBe('ent-1');
  });

  it('issued: cobros propios sin REP emitido — la obligación es NUESTRA', async () => {
    await listPagosSinRep('ent-1', { direction: 'issued', minAmount: 100 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM customer_payments/);
    expect(sql).toMatch(/cp\.cfdi_uuid IS NULL/);
    expect(params[1]).toBe(100);
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
