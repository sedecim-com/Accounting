import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../src/services/sat/cfdi-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/sat/cfdi-status.js')>()),
  consultaCfdi: vi.fn(),
  markInvoiceCfdiCancelled: vi.fn(async () => 1),
}));

import { query } from '../../src/database/connection.js';
import { consultaCfdi, markInvoiceCfdiCancelled } from '../../src/services/sat/cfdi-status.js';
import { SATValidationService } from '../../src/services/xml-ingestion/sat-validation.js';

// MNE-001-076 (#313): the single-document path (`cfdi status <uuid>` and the
// check after ingestion) writes `sat_estado` too, so it must carry the SAT's
// «Cancelado» to the invoice through the same bridge as the sweep.

const mockQuery = query as unknown as Mock;
const mockCfdiQuery = consultaCfdi as unknown as Mock;
const mockBridge = markInvoiceCfdiCancelled as unknown as Mock;

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
  mockQuery.mockResolvedValueOnce({ rows: [DOC] });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('SATValidationService.validateAndUpdate and the cancellation bridge', () => {
  it('marks the invoice of the document entity when the SAT says Cancelado', async () => {
    satSays('Cancelado');
    const r = await new SATValidationService().validateAndUpdate('doc-1');
    expect(r?.status).toBe('cancelled');
    expect(mockBridge).toHaveBeenCalledWith('entity-1', DOC.cfdi_uuid);
  });

  it('leaves the invoice alone when the SAT says Vigente', async () => {
    satSays('Vigente');
    await new SATValidationService().validateAndUpdate('doc-1');
    expect(mockBridge).not.toHaveBeenCalled();
  });
});
