import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// MNE-001-619: what an issued invoice's collections and notes took from 2125 is
// read through report-service. The real helper runs (its SQL reaches the fake
// client below), wrapped in a spy so a test can say which layer was asked,
// with what, and on which client.
vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/reporting/report-service.js')>();
  return { ...real, queryIssuedInvoiceVatTaken: vi.fn(real.queryIssuedInvoiceVatTaken) };
});

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
  receivedVatStillParked,
  issuedVatStillParked,
  entityUsesCashBasisIva,
  discountVatShare,
} from '../../src/services/accounting/iva-cash-basis.js';
import { queryIssuedInvoiceVatTaken } from '../../src/services/reporting/report-service.js';

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
    expect(ivaTreatmentNote('received', { metodo: 'PUE', origin: 'cfdi', assumed: false }))
      .toBe('IVA not yet creditable — moves to IVA acreditable on payment');
  });
});

// ============================================================
// WHICH ROLE — THE TAXONOMY ANSWERS
// ============================================================

describe('ivaRoleFor', () => {
  it('routes the four cases exactly as cfdi-taxonomy.ts declares them', () => {
    expect(ivaRoleFor('issued', 'PUE')).toBe('iva_trasladado');
    expect(ivaRoleFor('issued', 'PPD')).toBe('iva_trasladado_no_cobrado');
    // MNE-001-492: a received PUE parks too; its payment releases it.
    expect(ivaRoleFor('received', 'PUE')).toBe('iva_pendiente_acreditar');
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

  it('a bill migrated with the opening counts its tax_amount as parked, only while that opening stands', async () => {
    // MNE-001-023: the opening entry carries the pending IVA of every migrated
    // bill as ONE line, so the bill's share is its own tax_amount.
    const c = client('1241.3800');
    await ivaStillParked(c as never, 'received', ENTITY, DOC);
    const sql = String(c.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain("SELECT SUM(b.tax_amount) FROM bills b");
    expect(sql).toContain("WHERE b.id = $3 AND b.entity_id = $1 AND jo.source_type = 'opening_balance'");
    expect(sql).toContain("jo.status = 'posted' AND jo.reversed_by_entry_id IS NULL");
    // An issued document is never a bill.
    const c2 = client('0');
    await ivaStillParked(c2 as never, 'issued', ENTITY, DOC);
    expect(String(c2.query.mock.calls[0][0])).not.toContain('FROM bills');
  });

  it('scopes every leg to the entity', async () => {
    const c = client('0');
    await ivaStillParked(c as never, 'received', ENTITY, DOC);
    const [sql, params] = c.query.mock.calls[0];
    expect(sql).toMatch(/je\.entity_id = \$1/);
    expect(sql).toMatch(/ar\.entity_id = \$1/);
    expect(params?.[0]).toBe(ENTITY);
  });

  it('counts a received credit note among the entries of a bill, and only on the received side', async () => {
    // MNE-001-489: the note's entry carries the bill as source_id, so the cap nets what it took out of 1135.
    const c = client('0');
    await ivaStillParked(c as never, 'received', ENTITY, DOC);
    expect(c.query.mock.calls[0][1]?.[3]).toContain('vendor_credit_note');
    const c2 = client('0');
    await ivaStillParked(c2 as never, 'issued', ENTITY, DOC);
    expect(c2.query.mock.calls[0][1]?.[3]).not.toContain('vendor_credit_note');
  });
});

// MNE-001-489: the cap does not reach a payment's entry, whose source is the
// payment, so what a bill still has parked is the cap minus the releases its
// live applications stored.
describe('receivedVatStillParked: the cap minus what the live applications released', () => {
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const BILL = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  function client(parked: string, released: string) {
    return {
      query: vi.fn(async (sql: string, _params?: unknown[]) => ({
        rows: /FROM payment_applications/.test(sql) ? [{ released }] : [{ parked }],
      })),
    };
  }

  it('subtracts the stored releases from the cap', async () => {
    expect(await receivedVatStillParked(client('1280.0000', '640.0000') as never, ENTITY, BILL)).toBe('640.0000');
    expect(await receivedVatStillParked(client('1280.0000', '0') as never, ENTITY, BILL)).toBe('1280.0000');
  });

  it('never goes below zero', async () => {
    expect(await receivedVatStillParked(client('100.0000', '160.0000') as never, ENTITY, BILL)).toBe('0.0000');
  });

  it('sums only live applications of that bill, inside the entity', async () => {
    const c = client('1280.0000', '0');
    await receivedVatStillParked(c as never, ENTITY, BILL);
    const call = c.query.mock.calls.find(([sql]) => /FROM payment_applications/.test(sql));
    const sql = String(call?.[0]).replace(/\s+/g, ' ');
    expect(sql).toContain('SUM(pa.iva_reclass_amount)');
    expect(sql).toContain('pa.unapplied_at IS NULL');
    expect(sql).toContain('b.entity_id = $1');
    expect(call?.[1]).toEqual([ENTITY, BILL]);
  });

  it('MNE-001-597: also nets the VAT the live applications\' discounts took out of 1135', async () => {
    const c = client('160.0000', '0');
    await receivedVatStillParked(c as never, ENTITY, BILL);
    const call = c.query.mock.calls.find(([sql]) => /FROM payment_applications/.test(sql));
    expect(String(call?.[0]).replace(/\s+/g, ' ')).toContain('SUM(pa.discount_iva_amount)');
  });
});

// ============================================================
// MNE-001-619 · WHAT AN ISSUED INVOICE STILL HAS IN 2125
//
// A PPD invoice of 1,000.00 + 160.00 IVA = 1,160.00 parked 160.0000. A
// collection of 580.00 released 80.0000 and a credit note took 20.0000 back
// from 2125: 160 − 80 − 20 = 60.0000 left. One more live allocation of 290.00
// that stored no release counts at its pro rata, 160 × 290 / 1,160 = 40.0000:
// 160 − 80 − 40 − 20 = 20.0000 left, estimated.
// ============================================================

describe('issuedVatStillParked reads what its collections and notes took through report-service (MNE-001-619)', () => {
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const INVOICE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const taken = vi.mocked(queryIssuedInvoiceVatTaken);

  /** A transaction client that answers each statement by its text, and refuses any other. */
  function client(world: { taken: Array<Record<string, string>> }) {
    const query = vi.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('AS collected')) {
        // The open balance: 1,160.00 − 145.00 of note (125.00 + 20.00 IVA) − 580.00
        // collected. No allocation ended, so it caps nothing (MNE-001-581).
        return { rows: [{ collected: '580.0000', notes: '145.0000', note_count: 1, note_numbers: 'NC-1', ended: false, tax: '160.0000', total: '1160.0000' }] };
      }
      if (s.includes('AS released')) return { rows: world.taken };
      if (s.includes('AS parked')) return { rows: [{ parked: '160.0000' }] };
      throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
    });
    return { query } as unknown as import('pg').PoolClient & { query: typeof query };
  }

  it('asks queryIssuedInvoiceVatTaken once, on the caller\'s client, and nets what it says: 60.0000 left', async () => {
    taken.mockClear();
    const c = client({ taken: [{ released: '80.0000', unknown: '0', notes: '20.0000', tax: '160.0000', total: '1160.0000' }] });
    expect(await issuedVatStillParked(c, ENTITY, INVOICE)).toEqual({ parked: '60.0000', estimated: false });
    expect(taken.mock.calls).toEqual([[ENTITY, INVOICE, 'iva_trasladado_no_cobrado', c]]);
    expect(c.query.mock.calls.filter(([sql]) => String(sql).includes('AS released'))).toHaveLength(1);
  });

  it('a live allocation that stored no release counts at its pro rata: 20.0000 left, estimated', async () => {
    taken.mockClear();
    const c = client({ taken: [{ released: '80.0000', unknown: '290.0000', notes: '20.0000', tax: '160.0000', total: '1160.0000' }] });
    expect(await issuedVatStillParked(c, ENTITY, INVOICE)).toEqual({ parked: '20.0000', estimated: true });
    expect(taken).toHaveBeenCalledTimes(1);
  });

  it('an invoice the entity does not have: nothing parked, and the open balance is never read', async () => {
    taken.mockClear();
    const c = client({ taken: [] });
    expect(await issuedVatStillParked(c, ENTITY, INVOICE)).toEqual({ parked: '0.0000', estimated: false });
    expect(taken.mock.calls).toEqual([[ENTITY, INVOICE, 'iva_trasladado_no_cobrado', c]]);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes('AS collected'))).toBe(false);
  });
});

// ============================================================
// MNE-001-597 · THE VAT OF AN EARLY-PAYMENT DISCOUNT
//
// Bill 1,000.00 + 160.00 = 1,160.00. A discount of 58.00 carries
// 58 × 160 / 1,160 = 8.0000 of VAT; one of 20.00 carries 2.758620… → 2.7586.
// ============================================================

describe('discountVatShare: the discount\'s VAT, never creditable, capped by what is parked', () => {
  const bill = { taxAmount: '160.0000', totalAmount: '1160.0000' };

  it('is the discount times the VAT over the total, at four decimals', () => {
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '8.0000', closes: true })).toBe('8.0000');
    expect(discountVatShare({ ...bill, discount: '20.00', remainder: '160.0000', closes: false })).toBe('2.7586');
  });

  it('never takes more than the bill still has parked', () => {
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '5.0000', closes: false })).toBe('5.0000');
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '-1.0000', closes: false })).toBe('0.0000');
  });

  it('at closing it takes a rounding remainder of a cent or less, and only the share when more is parked', () => {
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '8.0001', closes: true })).toBe('8.0001');
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '7.9950', closes: true })).toBe('7.9950');
    // A held cheque's cash share is still parked: 160 is not a rounding gap.
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '160.0000', closes: true })).toBe('8.0000');
    // Without closing, a remainder close to the share is not swept either.
    expect(discountVatShare({ ...bill, discount: '58.00', remainder: '8.0001', closes: false })).toBe('8.0000');
  });

  it('in another currency the share is converted at the bill\'s rate', () => {
    // USD 5.80 of discount on USD 100 + 16: USD 0.80 of VAT × 20.0000 = 16.0000.
    expect(discountVatShare({
      discount: '5.80', taxAmount: '16.00', totalAmount: '116.00', remainder: '16.0000', closes: true, rate: '20.0000',
    })).toBe('16.0000');
  });

  it('nothing for no discount or a bill with no total', () => {
    expect(discountVatShare({ ...bill, discount: '0', remainder: '160.0000', closes: true })).toBe('0.0000');
    expect(discountVatShare({ discount: '10', taxAmount: '0', totalAmount: '0', remainder: '0', closes: true })).toBe('0.0000');
  });
});


// ============================================================
// QUIÉN ACREDITA SOBRE FLUJO: EL BORDE, DESDE ESTE CONSUMIDOR
//
// El predicado se unificó en `src/services/jurisdiction/jurisdiction.ts`
// (J0.1). Un borde correcto en el conmutador y una comparación superviviente
// aquí es exactamente el defecto que el tramo cierra, así que el borde se
// prueba OTRA VEZ desde el consumidor y no sólo en el módulo.
// ============================================================

describe('entityUsesCashBasisIva — el borde, preguntado desde el consumidor', () => {
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function client(rows: Array<Record<string, string>>) {
    return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows })) };
  }

  async function conEntidad(pais: string, norma: string): Promise<boolean> {
    return entityUsesCashBasisIva(
      client([{ incorporation_country: pais, accounting_standard: norma }]) as never,
      ENTITY
    );
  }

  /**
   * LA FILA AUSENTE NO PASA POR EL CONMUTADOR, Y ESO ES DELIBERADO. «Ante la
   * duda, mexicana» contesta por una entidad que existe y no declaró su país;
   * aquí no hay entidad. La consulta filtra sólo por `id` y se apoya en RLS,
   * así que un id de otro inquilino devuelve cero filas: si el `!row` se
   * enrutara por `jurisdictionOf({})`, un id ajeno o inexistente estrenaría
   * régimen fiscal mexicano.
   */
  it('una entidad que no existe no tiene régimen: cero filas es false, no «mexicana por omisión»', async () => {
    expect(await entityUsesCashBasisIva(client([]) as never, ENTITY)).toBe(false);
  });

  it('el caso normal por los dos caminos: el país mexicano, o los libros en NIF', async () => {
    expect(await conEntidad('MX', 'mx_nif')).toBe(true);
    expect(await conEntidad('MX', 'us_gaap')).toBe(true);
    expect(await conEntidad('US', 'mx_nif')).toBe(true);
  });

  it('la entidad estadounidense sigue fuera: su impuesto sobre una factura no es IVA acreditable', async () => {
    expect(await conEntidad('US', 'us_gaap')).toBe(false);
    expect(await conEntidad('CA', 'us_gaap')).toBe(false);
  });

  /**
   * QUÉ SE MOVIÓ AQUÍ, y por qué se eligió así.
   *
   * Antes de J0.1 estas dos filas daban `false`, porque el predicado
   * comparaba la columna en crudo contra 'MX'. `incorporation_country` es
   * `CHAR(2)` sin CHECK: la cadena vacía se guarda como dos espacios y nada
   * obliga a las mayúsculas. Esas entidades quedaban en la peor postura
   * posible — la semilla del catálogo (que sí usa el conmutador) las trata
   * como mexicanas y les crea las cuatro cuentas de IVA, y el posteo las
   * trataba como extranjeras y acreditaba el IVA al emitir en vez de al
   * pagar. Dos mitades del sistema contestando distinto sobre la misma fila.
   *
   * Se elige el `true` —y no arreglar el conmutador hacia el `false`— porque
   * es lo que la LIVA le exige a esa entidad y lo que su propio catálogo ya
   * suponía; y porque el cambio es un ensanchamiento estricto que no puede
   * acabar en MISSING_ROLE_ACCOUNT: la entidad que ahora entra es exactamente
   * la que fue sembrada como mexicana, así que tiene las cuatro cuentas.
   */
  it('el país en blanco o en minúsculas ya no queda fuera: es el borde que este tramo movió', async () => {
    expect(await conEntidad('  ', 'us_gaap')).toBe(true);
    expect(await conEntidad('mx', 'us_gaap')).toBe(true);
  });

  it('sigue preguntando por las dos columnas y sólo por esta entidad', async () => {
    const c = client([{ incorporation_country: 'MX', accounting_standard: 'mx_nif' }]);
    await entityUsesCashBasisIva(c as never, ENTITY);
    const [sql, params] = c.query.mock.calls[0];
    expect(sql).toMatch(/incorporation_country, accounting_standard/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params?.[0]).toBe(ENTITY);
  });
});
