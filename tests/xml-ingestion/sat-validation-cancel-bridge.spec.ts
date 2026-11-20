import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../src/services/sat/cfdi-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/sat/cfdi-status.js')>()),
  consultaCfdi: vi.fn(),
  markInvoiceCfdiCancelled: vi.fn(async () => 1),
}));
vi.mock('../../src/services/ap/bill-cfdi-cancellation.js', () => ({ markBillCfdiCancelled: vi.fn(async () => 1) }));

import { query } from '../../src/database/connection.js';
import { consultaCfdi, markInvoiceCfdiCancelled } from '../../src/services/sat/cfdi-status.js';
import { SATValidationService } from '../../src/services/xml-ingestion/sat-validation.js';
import { markBillCfdiCancelled } from '../../src/services/ap/bill-cfdi-cancellation.js';

// MNE-001-076 (#313): the single-document path (`cfdi status show <uuid> --refresh` and the
// check after ingestion) writes `sat_estado` too, so it must carry the SAT's
// «Cancelado» to the invoice through the same bridge as the sweep.

const mockQuery = query as unknown as Mock;
const mockCfdiQuery = consultaCfdi as unknown as Mock;
const mockBridge = markInvoiceCfdiCancelled as unknown as Mock;
const mockBillBridge = markBillCfdiCancelled as unknown as Mock;

const DOC = {
  entity_id: 'entity-1',
  cfdi_uuid: 'D5A8C9E1-4B2F-4A6D-9E3C-1F2A3B4C5D6E',
  emisor_rfc: 'XAXX010101000',
  receptor_rfc: 'SIN060101AB1',
  total: '1160.00',
};

function satSays(satState: string) {
  mockCfdiQuery.mockResolvedValueOnce({
    uuid: DOC.cfdi_uuid, codigoEstatus: 'S', estado: satState, esCancelable: '',
    estatusCancelacion: null, validacionEFOS: null, consultedAt: new Date(),
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockBridge.mockClear();
  mockBillBridge.mockClear();
  mockQuery.mockResolvedValueOnce({ rows: [DOC] });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('SATValidationService.validateAndUpdate and the cancellation bridge', () => {
  it('marks the invoice of the document entity when the SAT says Cancelado', async () => {
    satSays('Cancelado');
    const r = await new SATValidationService().validateAndUpdate('doc-1');
    expect(r?.status).toBe('cancelled');
    expect(mockBridge).toHaveBeenCalledWith('entity-1', DOC.cfdi_uuid);
    // MNE-001-431 (#643): the bill that carries the UUID gets its mark too,
    // after the invoice bridge, and the count comes back with the result.
    expect(mockBillBridge).toHaveBeenCalledWith('entity-1', DOC.cfdi_uuid);
    expect(mockBridge.mock.invocationCallOrder[0]).toBeLessThan(mockBillBridge.mock.invocationCallOrder[0]);
    expect(r?.billsMarked).toBe(1);
  });

  it('leaves the invoice alone when the SAT says Vigente', async () => {
    satSays('Vigente');
    const r = await new SATValidationService().validateAndUpdate('doc-1');
    expect(mockBridge).not.toHaveBeenCalled();
    expect(mockBillBridge).not.toHaveBeenCalled();
    expect(r?.billsMarked).toBeUndefined();
  });
});
