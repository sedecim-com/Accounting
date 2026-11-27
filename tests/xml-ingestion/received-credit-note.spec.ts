import { describe, it, expect } from 'vitest';
import {
  VENDOR_CREDIT_NOTE_SOURCE,
  refusalOf,
  splitNoteVat,
  spreadCost,
  type RelatedBill,
} from '../../src/services/xml-ingestion/received-credit-note.js';
import type { CfdiFacts } from '../../src/services/xml-ingestion/cfdi-facts.js';
import { ORIGENES_CXP } from '../../src/services/ap/ap-controls.js';
import { t } from '../../src/i18n/index.js';

// MNE-001-489 (#692, part 1/3): the rule of a received credit note as pure
// functions. The issue's case: a PPD bill of 9,280.00 (VAT 1,280.00) and a
// note of 2,320.00 (VAT 320.00) from the same vendor.

const VENDOR = 'SIN060101AB1';
const NOTE_UUID = 'A1B2C3D4-0000-4000-8000-000000000489';

/** One CfdiRelacionados node per type given, each naming the bill's CFDI. */
const related = (...types: string[]): Pick<CfdiFacts, 'relations'> =>
  ({ relations: types.map((type) => ({ tipoRelacion: type, uuids: ['F7C0E1A3'] })) });

function note(over: Partial<CfdiFacts> = {}): CfdiFacts {
  return {
    uuid: NOTE_UUID, tipo: 'E', direction: 'recibido', emisorRfc: VENDOR, receptorRfc: 'EKU9003173C9',
    emisorNombre: 'Servicios Integrales', fecha: new Date('2026-09-10T12:00:00Z'),
    pagadoEnEfectivo: false, moneda: 'MXN', tipoCambio: 1, esMonedaExtranjera: false,
    subtotal: 2000, descuento: 0, total: 2320,
    ivaTrasladado16: 320, ivaTrasladado8: 0, ivaTasaCero: 0, importeExento: 0, iepsTrasladado: 0,
    isrRetenido: 0, ivaRetenido: 0, impuestosLocalesTrasladados: 0, impuestosLocalesRetenidos: 0,
    complementos: [], docsRelacionados: [], ...related('01'),
    esAnticipo: false, clavesProdServ: [], conceptosDescripcion: '',
    ...over,
  };
}

function bill(over: Partial<RelatedBill> = {}): RelatedBill {
  return {
    billNumber: 'A-2001', vendorRfc: VENDOR, status: 'approved', currency: 'MXN', foreignCurrency: false,
    amountDue: '9280.0000', taxAmount: '1280.0000', totalAmount: '9280.0000',
    hasApplicationWithoutRelease: false,
    lines: [{ accountId: 'acc-6100', amount: '8000.0000', roles: ['gasto'] }],
    ...over,
  };
}

describe('splitNoteVat: 1135 up to what the bill still has parked, the rest out of 1130 (U1)', () => {
  it.each([
    ['1280.0000', '320.0000', '0.0000'],
    ['100.0000', '100.0000', '220.0000'],
    ['0.0000', '0.0000', '320.0000'],
  ])('320.00 with %s parked', (parked, fromPending, fromCreditable) => {
    expect(splitNoteVat('320.00', parked)).toEqual({ fromPending, fromCreditable });
  });
});

describe('refusalOf: each reason waits for a person and says why (U2)', () => {
  const said = (n: CfdiFacts, bills: RelatedBill[]): [string, string] => {
    const r = refusalOf(n, bills);
    if (!r) throw new Error('expected a refusal');
    return [r.key, t(r.key, r.params ?? {}, 'en')];
  };
  const mixedRates = bill({ amountDue: '10280.0000', totalAmount: '10280.0000' });

  it.each<[string, CfdiFacts, RelatedBill[], string, RegExp]>([
    ['issued by the entity', note({ direction: 'emitido' }), [bill()], 'not_received', /the entity is not its receiver/],
    ['not type E', note({ tipo: 'I' }), [bill()], 'not_credit_note', /type I with TipoRelacion 01/],
    ['TipoRelacion 07', note(related('07')), [bill()], 'not_credit_note', /type E with TipoRelacion 07/],
    // MNE-001-895: CFDI 4.0 admits several relation nodes (cfdv40.xsd:39); one that is not 01 or 03 is enough to wait.
    ['two nodes, 01 and 07', note(related('01', '07')), [bill()], 'not_credit_note', /type E with TipoRelacion 01, 07\./],
    ['no relation node', note(related()), [bill()], 'not_credit_note', /type E with TipoRelacion -\./],
    ['the note in dollars', note({ moneda: 'USD', esMonedaExtranjera: true }), [bill()], 'note_foreign_currency', /is in USD/],
    ['the bill in dollars', note(), [bill({ currency: 'USD', foreignCurrency: true })], 'bill_foreign_currency', /Bill A-2001 is in USD/],
    ['IEPS transferred', note({ iepsTrasladado: 50 }), [bill()], 'other_taxes', /other than transferred VAT/],
    ['a local tax transferred', note({ impuestosLocalesTrasladados: 30 }), [bill()], 'other_taxes', /other than transferred VAT/],
    ['VAT withheld', note({ ivaRetenido: 10 }), [bill()], 'other_taxes', /other than transferred VAT/],
    ['ISR withheld', note({ isrRetenido: 10 }), [bill()], 'other_taxes', /other than transferred VAT/],
    ['no related bill of the entity', note(), [], 'related_bills', /it names 0/],
    ['two related bills', note(), [bill(), bill({ billNumber: 'A-2002' })], 'related_bills', /it names 2/],
    ['another vendor', note(), [bill({ vendorRfc: 'OTR010101AAA' })], 'other_vendor', /belongs to vendor OTR010101AAA/],
    ['a paid bill', note(), [bill({ status: 'paid', amountDue: '0.0000' })], 'bill_not_payable', /is "paid"/],
    ['a release never stored', note(), [bill({ hasApplicationWithoutRelease: true })], 'release_not_recorded', /did not record the VAT it released/],
    ['larger than the balance', note(), [bill({ amountDue: '2319.9900' })], 'exceeds_balance', /is for 2320\.00 and bill A-2001 owes 2319\.99/],
    ['the mixed-rate bill, by the ratio', note(), [mixedRates], 'vat_out_of_proportion', /carries 320\.00 of VAT.*288\.87/],
    ['a line in inventory', note(), [bill({ lines: [{ accountId: 'a', amount: '8000', roles: ['inventario'] }] })], 'capitalised_line', /role inventario/],
    ['a line in fixed assets', note(), [bill({ lines: [{ accountId: 'a', amount: '8000', roles: ['activo_fijo'] }] })], 'capitalised_line', /role activo_fijo/],
    ['a prepaid line', note(), [bill({ lines: [{ accountId: 'a', amount: '8000', roles: ['gasto_anticipado'] }] })], 'capitalised_line', /role gasto_anticipado/],
  ])('%s', (_name, n, bills, reason, text) => {
    const [key, message] = said(n, bills);
    expect(key).toBe(`credit_note.received.refusal.${reason}`);
    expect(message).toMatch(text);
    expect(message).toContain(n.uuid);
  });

  it('accepts the note of the issue, a return (03), and a note equal to the balance', () => {
    expect(refusalOf(note(), [bill()])).toBeNull();
    expect(refusalOf(note(related('03')), [bill({ status: 'partially_paid' })])).toBeNull();
    expect(refusalOf(note(related('01', '03')), [bill()])).toBeNull();
    expect(refusalOf(note(), [bill({ amountDue: '2320.0000' })])).toBeNull();
  });

  it('a cent of VAT off the ratio is accepted, two are not', () => {
    expect(refusalOf(note({ ivaTrasladado16: 319.99 }), [bill()])).toBeNull();
    expect(said(note({ ivaTrasladado16: 319.98 }), [bill()])[0]).toMatch(/vat_out_of_proportion$/);
  });

  it('reads the Spanish text from the same key', () => {
    const r = refusalOf(note(), [bill({ status: 'paid' })]);
    expect(t(r!.key, r!.params ?? {}, 'es')).toMatch(/El gasto A-2001 está en "paid"/);
  });
});

describe('spreadCost: where the cost side goes (U3)', () => {
  const lines = [
    { accountId: 'acc-6100', amount: '1000.0000', roles: ['gasto'] },
    { accountId: 'acc-6200', amount: '2000.0000', roles: ['gasto'] },
  ];

  it('bill_accounts prorates over the expense lines and sums exactly', () => {
    expect(spreadCost('2000.00', lines, 'bill_accounts')).toEqual([
      { kind: 'account', accountId: 'acc-6100', amount: '666.6700' },
      { kind: 'account', accountId: 'acc-6200', amount: '1333.3300' },
    ]);
  });

  it('two lines on one account give one credit, and the last one takes the remainder', () => {
    const four = [...lines, { accountId: 'acc-6100', amount: '1000.0000', roles: ['gasto'] },
      { accountId: 'acc-6300', amount: '2000.0000', roles: ['gasto'] }];
    expect(spreadCost('100.00', four, 'bill_accounts')).toEqual([
      { kind: 'account', accountId: 'acc-6100', amount: '33.3300' },
      { kind: 'account', accountId: 'acc-6200', amount: '33.3300' },
      { kind: 'account', accountId: 'acc-6300', amount: '33.3400' },
    ]);
  });

  it('purchase_returns gives one line on the devolucion_compras role', () => {
    expect(spreadCost('2000.00', lines, 'purchase_returns')).toEqual([
      { kind: 'role', role: 'devolucion_compras', amount: '2000.0000' },
    ]);
  });
});

describe('the source type of the entry', () => {
  it('is an origin of the AP subledger, so ap reconcile will not read it as a manual entry', () => {
    expect(VENDOR_CREDIT_NOTE_SOURCE).toBe('vendor_credit_note');
    expect(ORIGENES_CXP).toContain(VENDOR_CREDIT_NOTE_SOURCE);
  });
});
