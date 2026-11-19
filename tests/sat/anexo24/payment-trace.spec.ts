import { describe, it, expect } from 'vitest';
import { rastroDePago } from '../../../src/services/sat/anexo24/polizas-service.js';
import { polizaConDineroSinRastro } from '../../../src/services/sat/anexo24/polizas-invariantes.js';
import { encrypt } from '../../../src/utils/encryption.js';

// ============================================================
// The payment node of one voucher, without a database: what `rastroDePago`
// leaves out when a c_Banco code is missing, and the remedy the accountant
// reads for each cause. Every row is synthetic.
// ============================================================

type Payment = Parameters<typeof rastroDePago>[0];
type BankAccount = NonNullable<Parameters<typeof rastroDePago>[2]>;

const CLABE = '012180001234567895';
const ENTRY = 'JE-2026-0042';
const OURS = { nombre: 'Entidad de Prueba SA', rfc: 'EPR010101AB1' };
const passThrough = (raw: string): string => raw;

const payment = (over: Partial<Payment> = {}): Payment => ({
  payment_number: 'VPMT-2026-00007',
  payment_amount: '116.0000',
  payment_date: '2026-10-15',
  payment_method: 'spei',
  currency_code: 'MXN',
  exchange_rate: '1',
  bank_account_id: 'ba-1',
  check_number: null,
  cuenta_destino: '002180009876543210',
  banco_destino_sat: '002',
  banco_destino_extranjero: null,
  cuenta_origen: null,
  banco_origen_sat: null,
  banco_origen_extranjero: null,
  cfdi_uuid: null,
  contraparte: 'Fletes del Norte SA',
  contraparte_id: 'v-1',
  contraparte_rfc: 'FNO010101AB1',
  ...over,
});

const account = (over: Partial<BankAccount> = {}): BankAccount => ({
  id: 'ba-1',
  account_name: 'Operativa BBVA',
  gl_account_id: 'gl-1',
  sat_bank_code: '012',
  bank_name: 'BBVA México',
  clabe_encrypted: encrypt(CLABE),
  clabe_last4: CLABE.slice(-4),
  account_number_encrypted: null,
  account_number_last4: null,
  ...over,
});

/** What the accountant reads: the motive from the service, the remedy from the invariant. */
function finding(
  p: Payment,
  direction: 'sale' | 'entra',
  bank: BankAccount | undefined
): { node: boolean; text: string } {
  const r = rastroDePago(p, direction, bank, OURS, passThrough, ENTRY);
  if (r.pago !== undefined) return { node: true, text: '' };
  const [h] = polizaConDineroSinRastro([
    {
      numUnIdenPol: ENTRY,
      motivo: r.motivo ?? '',
      ...(r.missingOnRecord !== undefined ? { missingOnRecord: r.missingOnRecord } : {}),
      ...(r.missingOnBankAccount !== undefined ? { missingOnBankAccount: r.missingOnBankAccount } : {}),
      ...(r.bankAccountFlag !== undefined ? { bankAccountFlag: r.bankAccountFlag } : {}),
      ...(r.noCommandFixes !== undefined ? { noCommandFixes: r.noCommandFixes } : {}),
    },
  ]);
  return { node: false, text: h!.detalle };
}

const PAYMENT_REMEDY = 'payment create --check-number/--to-account/--to-bank';
const ACCOUNT_REMEDY = 'bank account edit';

describe('a payment node without its c_Banco code: the remedy follows the cause', () => {
  it('complete, the node goes out with the three codes', () => {
    const check = rastroDePago(
      payment({ payment_method: 'check', check_number: '30001' }), 'sale', account(), OURS, passThrough, ENTRY
    );
    expect(check.pago).toMatchObject({ clase: 'cheque', banEmisNal: '012' });
    const transfer = rastroDePago(payment(), 'sale', account(), OURS, passThrough, ENTRY);
    expect(transfer.pago).toMatchObject({ clase: 'transferencia', bancoOriNal: '012', bancoDestNal: '002' });
  });

  it.each([
    ['Cheque', 'BanEmisNal', payment({ payment_method: 'check', check_number: '30001' })],
    ['Transferencia', 'BancoOriNal', payment()],
  ] as const)('%s from a linked account without the code names that account', (node, attribute, p) => {
    const f = finding(p, 'sale', account({ sat_bank_code: null }));
    expect(f.node).toBe(false);
    expect(f.text).toContain(`el nodo ${node} exige ${attribute}`);
    expect(f.text).toContain('«Operativa BBVA» (id ba-1)');
    expect(f.text).toContain(`${ACCOUNT_REMEDY} <cuenta> --sat-bank-code`);
    expect(f.text).not.toContain('payment create');
  });

  it.each([
    ['Cheque', 'BanEmisNal', payment({ payment_method: 'check', check_number: '30001', bank_account_id: null })],
    ['Transferencia', 'BancoOriNal', payment({ bank_account_id: null })],
  ] as const)('%s of a payment with no bank account says so, and that no command completes it', (node, attribute, p) => {
    const f = finding(p, 'sale', undefined);
    expect(f.node).toBe(false);
    expect(f.text).toContain(`el nodo ${node} exige ${attribute}`);
    expect(f.text).toContain('se registró sin cuenta bancaria');
    // There is no account to edit and no command that links one afterwards.
    expect(f.text).not.toContain(ACCOUNT_REMEDY);
    expect(f.text).not.toContain(PAYMENT_REMEDY);
    expect(f.text).toContain('ningún comando');
    // Reversing and paying again leaves the month blocked: never prescribed.
    expect(f.text).not.toContain('payment reverse');
  });

  it('a customer transfer with no payer bank: captured only at `receipt record --payer-bank`', () => {
    const f = finding(
      payment({ payment_number: 'CPMT-2026-00003', cuenta_destino: null, banco_destino_sat: null }),
      'entra',
      account()
    );
    expect(f.node).toBe(false);
    expect(f.text).toContain('el nodo Transferencia exige BancoOriNal');
    expect(f.text).toContain('receipt record --payer-bank');
    expect(f.text).not.toContain('payment create');
    expect(f.text).toContain('ningún comando');
  });

  it('a foreign destination bank: the open decision is said in words, with no remedy that fixes nothing', () => {
    const f = finding(
      payment({ cuenta_destino: 'GB29NWBK60161331926819', banco_destino_sat: null, banco_destino_extranjero: 'Bank of Nowhere' }),
      'sale',
      account()
    );
    expect(f.node).toBe(false);
    expect(f.text).toContain('el nodo Transferencia exige BancoDestNal');
    expect(f.text).toContain('«Bank of Nowhere»');
    expect(f.text).toContain('banco extranjero');
    expect(f.text).not.toContain('payment create');
  });

  it('a foreign bank name reaches the finding on one line, as the account name does', () => {
    const f = finding(
      payment({ banco_destino_sat: null, banco_destino_extranjero: 'Bank of\nNowhere\t ' }),
      'sale',
      account()
    );
    expect(f.text).toContain('«Bank of Nowhere»');
    expect(f.text).not.toMatch(/[\n\t]/);
  });

  it('a customer transfer with no account that received it gets no payment remedy either', () => {
    const f = finding(
      payment({ payment_number: 'CPMT-2026-00001', bank_account_id: null, cuenta_destino: null, banco_destino_sat: null }),
      'entra',
      undefined
    );
    expect(f.node).toBe(false);
    // Our bank account is named first (#611): it is what BancoDestNal and CtaDest come from.
    expect(f.text).toContain('el nodo Transferencia exige BancoDestNal');
    expect(f.text).toContain('se registró sin cuenta bancaria');
    expect(f.text).not.toContain('payment create');
    expect(f.text).toContain('ningún comando');
  });

  it('a destination bank not captured: it is only captured when the payment is registered', () => {
    // The payment is already registered and no command adds `--to-bank` to it;
    // reversing and paying again leaves the reversed entry untraced.
    const f = finding(payment({ banco_destino_sat: null }), 'sale', account());
    expect(f.text).toContain('el nodo Transferencia exige BancoDestNal');
    expect(f.text).toContain('payment create --to-bank');
    expect(f.text).toContain('ningún comando');
    expect(f.text).not.toContain(PAYMENT_REMEDY);
  });

  it('no finding cites a tracker number', () => {
    const texts = [
      finding(payment({ payment_method: 'check', check_number: '1' }), 'sale', account({ sat_bank_code: null })),
      finding(payment({ bank_account_id: null }), 'sale', undefined),
      finding(payment({ cuenta_destino: null }), 'entra', account()),
      ...RECEIPT_GAPS.map(([, p, bank]) => finding(p, 'entra', bank)),
      finding(payment({ banco_destino_sat: null, banco_destino_extranjero: 'Bank of Nowhere' }), 'sale', account()),
      finding(payment({ banco_destino_sat: null }), 'sale', account()),
    ].map((f) => f.text);
    for (const t of texts) {
      expect(t).not.toBe('');
      expect(t).not.toMatch(/#\d/);
    }
  });
});

// ============================================================
// #611 · A receipt's payment node: the origin is the customer's (its bank,
// its account, the cheque it drew), the destination is our bank account.
// Hand figures from the plan: T1, T2, C1, F1 and G1-G7.
// ============================================================

const PAYER_ACCOUNT = '002180009876543210';
/** A receipt as `receipt record` stores it: no destination captured, the payer's origin captured. */
const receipt = (over: Partial<Payment> = {}): Payment =>
  payment({
    payment_number: 'PMT-2026-00011',
    cuenta_destino: null,
    banco_destino_sat: null,
    banco_origen_sat: '002',
    cuenta_origen: PAYER_ACCOUNT,
    contraparte: 'Cliente Puntual SA',
    contraparte_id: 'c-1',
    contraparte_rfc: 'CPU010101AB1',
    ...over,
  });
const customerCheckPayment = (over: Partial<Payment> = {}): Payment =>
  receipt({ payment_method: 'check', check_number: '4501', banco_origen_sat: '072', cuenta_origen: '1234567890', payment_amount: '232.0000', bank_account_id: null, ...over });

/** The receipt causes the plan names G1-G7: the case, the receipt, our bank account, and the remedy the reader must find. */
const RECEIPT_GAPS: ReadonlyArray<readonly [string, Payment, BankAccount | undefined, string, string]> = [
  ['G1 a transfer with no payer bank', receipt({ banco_origen_sat: null }), account(), 'Transferencia exige BancoOriNal', 'receipt record --payer-bank'],
  ['G2 a transfer from a foreign payer bank', receipt({ banco_origen_sat: null, banco_origen_extranjero: 'Bank of Nowhere' }), account(), 'Transferencia exige BancoOriNal', 'banco extranjero'],
  ['G3 a cheque with no number', customerCheckPayment({ check_number: null }), undefined, 'el nodo Cheque lo exige', 'receipt record --check-number'],
  ['G4 a cheque with no payer bank', customerCheckPayment({ banco_origen_sat: null }), undefined, 'Cheque exige BanEmisNal', 'receipt record --payer-bank'],
  ['G5 a cheque with no drawn-on account', customerCheckPayment({ cuenta_origen: null }), undefined, 'Cheque exige CtaOri', 'receipt record --payer-account'],
  ['G6 a transfer into an account with no c_Banco code', receipt(), account({ sat_bank_code: null }), 'Transferencia exige BancoDestNal', '--sat-bank-code <clave>'],
  ['G7 a transfer into an account with no number', receipt(), account({ clabe_encrypted: null }), 'Transferencia exige CtaDest', 'bank account edit <cuenta> --clabe'],
];

describe('a receipt declares the payer as the origin and our bank account as the destination (#611)', () => {
  it('T1: a complete transfer goes out with the payer bank and account, and ours as the destination', () => {
    const r = rastroDePago(receipt({ payment_amount: '116.0000' }), 'entra', account(), OURS, passThrough, ENTRY);
    expect(r.pago).toEqual({
      clase: 'transferencia',
      ctaOri: PAYER_ACCOUNT,
      bancoOriNal: '002',
      ctaDest: CLABE,
      bancoDestNal: '012',
      fecha: '2026-10-15',
      benef: OURS.nombre,
      rfc: OURS.rfc,
      monto: '116.00',
      moneda: 'MXN',
    });
  });

  it('T2: without the payer account the node still goes out, with no CtaOri (optional in the XSD)', () => {
    const r = rastroDePago(receipt({ cuenta_origen: null }), 'entra', account(), OURS, passThrough, ENTRY);
    expect(r.pago).toMatchObject({ clase: 'transferencia', bancoOriNal: '002', ctaDest: CLABE, bancoDestNal: '012' });
    expect(r.pago).not.toHaveProperty('ctaOri');
  });

  it('C1: a customer cheque declares the customer bank and account, never ours, and needs no bank account of ours', () => {
    const r = rastroDePago(customerCheckPayment(), 'entra', undefined, OURS, passThrough, ENTRY);
    expect(r.pago).toMatchObject({
      clase: 'cheque', num: '4501', banEmisNal: '072', ctaOri: '1234567890', benef: OURS.nombre, monto: '232.00',
    });
    const deposited = rastroDePago(customerCheckPayment(), 'entra', account(), OURS, passThrough, ENTRY);
    expect(deposited.pago).toMatchObject({ banEmisNal: '072', ctaOri: '1234567890' });
    expect(JSON.stringify(deposited.pago)).not.toContain(CLABE);
  });

  it('F1: a receipt in dollars carries its currency and rate', () => {
    const r = rastroDePago(
      receipt({ payment_amount: '100.0000', currency_code: 'USD', exchange_rate: '18.50' }), 'entra', account(), OURS, passThrough, ENTRY
    );
    expect(r.pago).toMatchObject({ clase: 'transferencia', monto: '100.00', moneda: 'USD', tipCamb: '18.5' });
  });

  it.each(RECEIPT_GAPS)('%s: no node, and a remedy that is true and is no vendor command', (_case, p, bank, node, remedy) => {
    const f = finding(p, 'entra', bank);
    expect(f.node).toBe(false);
    expect(f.text).toContain(node);
    expect(f.text).toContain(remedy);
    expect(f.text).not.toContain('payment create');
    expect(f.text).not.toMatch(/#\d/);
  });

  it('a foreign payer bank is named, on one line', () => {
    const f = finding(receipt({ banco_origen_sat: null, banco_origen_extranjero: 'Bank of\nNowhere' }), 'entra', account());
    expect(f.text).toContain('«Bank of Nowhere»');
  });
});
