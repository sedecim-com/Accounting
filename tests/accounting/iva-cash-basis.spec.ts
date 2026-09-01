import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  parseMetodoPago,
  metodoPagoFromText,
  decideMetodoPago,
  describeMetodo,
  ivaTreatmentNote,
  ivaRoleFor,
  reclassRoles,
  ivaToReclassify,
  CONSERVATIVE_METODO,
  ivaStillParked,
} from '../../src/services/accounting/iva-cash-basis.js';

// ============================================================
// READING THE METODO DE PAGO
// ============================================================

describe('parseMetodoPago', () => {
  it('accepts the two SAT codes in any casing or padding', () => {
    expect(parseMetodoPago('PUE')).toBe('PUE');
    expect(parseMetodoPago('ppd')).toBe('PPD');
    expect(parseMetodoPago('  PPD  ')).toBe('PPD');
  });

  it('refuses anything that is not one of them, rather than guessing', () => {
    expect(parseMetodoPago('Net 30')).toBeNull();
    expect(parseMetodoPago('')).toBeNull();
    expect(parseMetodoPago(undefined)).toBeNull();
    expect(parseMetodoPago(null)).toBeNull();
    expect(parseMetodoPago(99)).toBeNull();
  });
});

describe('metodoPagoFromText', () => {
  it('finds an explicit code written into free text', () => {
    expect(metodoPagoFromText('MetodoPago: PPD')).toBe('PPD');
    expect(metodoPagoFromText('pago en una exhibicion (pue)')).toBe('PUE');
  });

  it('ignores ordinary payment terms', () => {
    expect(metodoPagoFromText('Net 30')).toBeNull();
    expect(metodoPagoFromText('2/10 net 30')).toBeNull();
    expect(metodoPagoFromText(null)).toBeNull();
  });

  it('does not match a code glued to other characters', () => {
    expect(metodoPagoFromText('PPDX-0091')).toBeNull();
    expect(metodoPagoFromText('SUPUESTO')).toBeNull();
  });

  /**
   * A word boundary alone is not enough. `Pue.` is how a Mexican address
   * abbreviates the state of Puebla, and `PPD-2026-04` is a folio; both are
   * word-bounded, and reading either as a fiscal fact decides the IVA
   * treatment of the document with no warning and no note in the entry.
   * Falling through to the conservative default is the honest answer.
   */
  it('does not read a place name or a folio as a declaration', () => {
    expect(metodoPagoFromText('Entrega en Cholula, Pue.')).toBeNull();
    expect(metodoPagoFromText('Ref PPD-2026-04')).toBeNull();
    expect(metodoPagoFromText('Serie PUE/2026/118')).toBeNull();
    expect(metodoPagoFromText('Remision PPD3')).toBeNull();
  });

  it('still reads a code that stands on its own, however it is punctuated', () => {
    expect(metodoPagoFromText('PPD')).toBe('PPD');
    expect(metodoPagoFromText('PUE - pagado al contado')).toBe('PUE');
    expect(metodoPagoFromText('pago en una exhibicion (pue)')).toBe('PUE');
    expect(metodoPagoFromText('MetodoPago: PPD')).toBe('PPD');
    expect(metodoPagoFromText('CFDI PPD, 30 dias')).toBe('PPD');
  });

  it('returns nothing when the text names both: two answers is not an answer', () => {
    expect(metodoPagoFromText('originally PUE, corrected to PPD')).toBeNull();
  });
});

describe('decideMetodoPago', () => {
  it('prefers the document column over everything else', () => {
    const d = decideMetodoPago('issued', {
      documentMetodoPago: 'PPD',
      cfdiMetodoPago: 'PUE',
      terms: 'PUE',
    });
    expect(d).toEqual({ metodo: 'PPD', origin: 'document', assumed: false });
  });

  it('falls to the stamped CFDI when the document says nothing', () => {
    const d = decideMetodoPago('issued', { cfdiMetodoPago: 'PPD', terms: 'PUE' });
    expect(d).toEqual({ metodo: 'PPD', origin: 'cfdi', assumed: false });
  });

  it('reads free-text terms, then memo, as the last real signal', () => {
    expect(decideMetodoPago('received', { terms: 'PPD net 30' }).origin).toBe('terms');
    expect(decideMetodoPago('received', { terms: 'Net 30', memo: 'CFDI PPD' })).toEqual({
      metodo: 'PPD',
      origin: 'terms',
      assumed: false,
    });
  });

  it('assumes PUE on an issued document with no signal — never defers the remittance', () => {
    expect(decideMetodoPago('issued', {})).toEqual({
      metodo: 'PUE',
      origin: 'default',
      assumed: true,
    });
  });

  it('assumes PPD on a received document with no signal — never brings a credit forward', () => {
    expect(decideMetodoPago('received', { terms: 'Net 30' })).toEqual({
      metodo: 'PPD',
      origin: 'default',
      assumed: true,
    });
  });

  it('is the conservative table, not a coin flip', () => {
    expect(CONSERVATIVE_METODO).toEqual({ issued: 'PUE', received: 'PPD' });
  });
});

describe('the assumption is legible', () => {
  it('tags an assumed method so a reader of the ledger can see it', () => {
    expect(describeMetodo({ metodo: 'PPD', origin: 'default', assumed: true })).toBe('PPD (assumed)');
    expect(describeMetodo({ metodo: 'PPD', origin: 'cfdi', assumed: false })).toBe('PPD');
  });

  it('says what the treatment means on each side', () => {
    expect(ivaTreatmentNote('issued', { metodo: 'PPD', origin: 'cfdi', assumed: false }))
      .toMatch(/moves to IVA trasladado on collection/);
    expect(ivaTreatmentNote('received', { metodo: 'PPD', origin: 'cfdi', assumed: false }))
      .toMatch(/moves to IVA acreditable on payment/);
    expect(ivaTreatmentNote('received', { metodo: 'PPD', origin: 'default', assumed: true }))
      .toMatch(/conservative PPD assumed/);
  });
});

// ============================================================
// WHICH ROLE — THE TAXONOMY ANSWERS
// ============================================================

describe('ivaRoleFor', () => {
  it('routes the four cases exactly as cfdi-taxonomy.ts declares them', () => {
    expect(ivaRoleFor('issued', 'PUE')).toBe('iva_trasladado');
    expect(ivaRoleFor('issued', 'PPD')).toBe('iva_trasladado_no_cobrado');
    expect(ivaRoleFor('received', 'PUE')).toBe('iva_acreditable');
    expect(ivaRoleFor('received', 'PPD')).toBe('iva_pendiente_acreditar');
  });

  it('names the pair a payment moves between', () => {
    expect(reclassRoles('issued')).toEqual({
      from: 'iva_trasladado_no_cobrado',
      to: 'iva_trasladado',
    });
    expect(reclassRoles('received')).toEqual({
      from: 'iva_pendiente_acreditar',
      to: 'iva_acreditable',
    });
  });
});

// ============================================================
// HOW MUCH A PAYMENT RELEASES
// ============================================================

describe('ivaToReclassify', () => {
  const invoice = { ivaTotal: '160.0000', documentTotal: '1160.0000' };

  it('releases the whole IVA when the document is settled in one payment', () => {
    expect(ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '1160.0000' }))
      .toBe('160.0000');
  });

  it('releases the collected share on a partial payment', () => {
    expect(ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '580.0000' }))
      .toBe('80.0000');
  });

  it('lets the closing payment take the exact remainder, with no rounding drift', () => {
    const first = ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '333.3300' });
    const second = ivaToReclassify({ ...invoice, priorApplied: '333.3300', appliedNow: '826.6700' });
    expect(first).toBe('45.9766');
    expect(second).toBe('114.0234');
    // The point of the whole exercise: 2125 empties exactly.
    expect(Number(first) + Number(second)).toBeCloseTo(160, 10);
  });

  it('never releases more than the IVA when the document is over-applied', () => {
    expect(ivaToReclassify({ ...invoice, priorApplied: '1160.0000', appliedNow: '50.0000' }))
      .toBe('0.0000');
    expect(ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '5000.0000' }))
      .toBe('160.0000');
  });

  it('releases nothing when there is no IVA, no total, or no money moving', () => {
    expect(ivaToReclassify({ ivaTotal: '0', documentTotal: '1160', priorApplied: '0', appliedNow: '1160' })).toBe('0.0000');
    expect(ivaToReclassify({ ivaTotal: '160', documentTotal: '0', priorApplied: '0', appliedNow: '100' })).toBe('0.0000');
    expect(ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '0' })).toBe('0.0000');
  });

  it('keeps money as a decimal string at the scale the ledger stores', () => {
    const released = ivaToReclassify({ ...invoice, priorApplied: '0', appliedNow: '1160.0000' });
    expect(typeof released).toBe('string');
    expect(released).toMatch(/^\d+\.\d{4}$/);
  });
});

// ============================================================
// The release must compose with history. Every bill posted before cash-basis
// IVA existed sent its tax straight to the due account and parked nothing;
// releasing against one of those would credit the due account a SECOND time
// for tax never deferred, and drive the pending account negative — which is
// the visible tell that a monthly return is about to be wrong.
// ============================================================

describe('ivaStillParked — you cannot release what was never parked', () => {
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const DOC = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  /** The mock's calls are typed as [] without an explicit signature, which is
   *  what made the `as [string, unknown[]]` casts illegal under typecheck:tests. */
  function client(parked: string) {
    return {
      query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ parked }] })),
    };
  }

  it('reports what a PPD bill parked in the pending account', async () => {
    const c = client('160.0000');
    expect(await ivaStillParked(c as never, 'received', ENTITY, DOC)).toBe('160.0000');
  });

  it('reports ZERO for a bill posted before the cutover, which parked nothing', async () => {
    const c = client('0');
    expect(await ivaStillParked(c as never, 'received', ENTITY, DOC)).toBe('0.0000');
  });

  it('never reports a negative cap, however the ledger got that way', async () => {
    // A negative here would mean the pending account is already over-released.
    // Returning it would let the next payment "release" a negative amount and
    // silently reverse a good entry.
    const c = client('-40.0000');
    expect(await ivaStillParked(c as never, 'received', ENTITY, DOC)).toBe('0.0000');
  });

  it('nets prior releases, so a second partial payment cannot double-release', async () => {
    // 160 parked, 100 already released → 60 left.
    const c = client('60.0000');
    expect(await ivaStillParked(c as never, 'received', ENTITY, DOC)).toBe('60.0000');
  });

  it('reads the role, not a hardcoded account code', async () => {
    const c = client('0');
    await ivaStillParked(c as never, 'received', ENTITY, DOC);
    const [sql, params] = c.query.mock.calls[0];
    expect(sql).toMatch(/account_roles/);
    expect(params?.[1]).toBe('iva_pendiente_acreditar');
    // An issued document parks on the other side.
    const c2 = client('0');
    await ivaStillParked(c2 as never, 'issued', ENTITY, DOC);
    expect(c2.query.mock.calls[0][1]?.[1]).toBe('iva_trasladado_no_cobrado');
  });

  it('scopes every leg to the entity', async () => {
    const c = client('0');
    await ivaStillParked(c as never, 'received', ENTITY, DOC);
    const [sql, params] = c.query.mock.calls[0];
    expect(sql).toMatch(/je\.entity_id = \$1/);
    expect(sql).toMatch(/ar\.entity_id = \$1/);
    expect(params?.[0]).toBe(ENTITY);
  });
});
