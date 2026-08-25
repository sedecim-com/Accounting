import { describe, it, expect } from 'vitest';
import client from 'prom-client';
import { cfdiStampOutcomes } from '../../../src/api/rest/middleware/metrics.js';

describe('cfdiStampOutcomes counter', () => {
  it('records success outcome with provider label', async () => {
    cfdiStampOutcomes.inc({ provider: 'finkok', outcome: 'success' });
    const metrics = await client.register.getSingleMetricAsString('accounting_cfdi_stamp_total');
    expect(metrics).toMatch(/provider="finkok",outcome="success"/);
  });

  it('records fallback outcome (primary failed → secondary succeeded)', async () => {
    cfdiStampOutcomes.inc({ provider: 'sw_sapien', outcome: 'fallback' });
    const metrics = await client.register.getSingleMetricAsString('accounting_cfdi_stamp_total');
    expect(metrics).toMatch(/provider="sw_sapien",outcome="fallback"/);
  });

  it('records failure + circuit_open outcomes distinctly', async () => {
    cfdiStampOutcomes.inc({ provider: 'edicom', outcome: 'failure' });
    cfdiStampOutcomes.inc({ provider: 'finkok', outcome: 'circuit_open' });
    const metrics = await client.register.getSingleMetricAsString('accounting_cfdi_stamp_total');
    expect(metrics).toMatch(/provider="edicom",outcome="failure"/);
    expect(metrics).toMatch(/provider="finkok",outcome="circuit_open"/);
  });
});
