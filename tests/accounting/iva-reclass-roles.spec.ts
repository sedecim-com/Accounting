import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CfdiCase } from '../../src/services/xml-ingestion/cfdi-taxonomy.js';
import type { CfdiFacts } from '../../src/services/xml-ingestion/cfdi-facts.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// MNE-001-492: the taxonomy as it will read once a received PUE parks its VAT
// too. The release's target must not follow it there.
const received = { PUE: 'iva_pendiente_acreditar', PPD: 'iva_pendiente_acreditar' };
vi.mock('../../src/services/xml-ingestion/cfdi-taxonomy.js', async (original) => {
  const real = await original<typeof import('../../src/services/xml-ingestion/cfdi-taxonomy.js')>();
  return {
    ...real,
    matchCase: (facts: CfdiFacts): CfdiCase | undefined =>
      facts.direction === 'recibido'
        ? ({ posting: [{ role: received[facts.metodoPago as 'PUE' | 'PPD'] }] } as unknown as CfdiCase)
        : real.matchCase(facts),
  };
});

const load = () => import('../../src/services/accounting/iva-cash-basis.js');

describe('reclassRoles when a received PUE parks its VAT', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(received, { PUE: 'iva_pendiente_acreditar', PPD: 'iva_pendiente_acreditar' });
  });

  it('a payment still moves the VAT out of the pending role into the creditable one', async () => {
    const { reclassRoles } = await load();
    expect(reclassRoles('received')).toEqual({ from: 'iva_pendiente_acreditar', to: 'iva_acreditable' });
    expect(reclassRoles('issued')).toEqual({ from: 'iva_trasladado_no_cobrado', to: 'iva_trasladado' });
  });

  it('refuses a taxonomy that parks a PPD in the creditable role: a release would move nothing', async () => {
    received.PPD = 'iva_acreditable';
    const { reclassRoles } = await load();
    expect(() => reclassRoles('received')).toThrow(expect.objectContaining({ code: 'IVA_ROLE_UNRESOLVED' }));
  });
});
