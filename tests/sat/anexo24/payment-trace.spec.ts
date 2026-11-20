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
      ...(r.completedBy !== undefined ? { completedBy: r.completedBy } : {}),
    },
  ]);
  return { node: false, text: h!.detalle };
}

/** What the capture command offered: a payment already registered is never sent back to it. */
const CAPTURE_REMEDY = 'payment create';
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
  ] as const)('%s of a payment with no bank account says so, and links one on the registered payment (MNE-001-569)', (node, attribute, p) => {
    const f = finding(p, 'sale', undefined);
    expect(f.node).toBe(false);
    expect(f.text).toContain(`el nodo ${node} exige ${attribute}`);
    expect(f.text).toContain('se registró sin cuenta bancaria');
    // There is no account to edit: the bank account is linked to the payment.
    expect(f.text).not.toContain(ACCOUNT_REMEDY);
    expect(f.text).toContain('`payment trace record VPMT-2026-00007 --bank <cuenta> --reason <motivo>`');
    expect(f.text).not.toContain(CAPTURE_REMEDY);
    expect(f.text).not.toContain('ningún comando');
    // Reversing and paying again leaves the month blocked: never prescribed.
    expect(f.text).not.toContain('payment reverse');
  });

  it('a customer transfer with no payer bank: completed on the registered receipt (MNE-001-570)', () => {
    const f = finding(
      payment({ payment_number: 'CPMT-2026-00003', cuenta_destino: null, banco_destino_sat: null }),
      'entra',
      account()
    );
    expect(f.node).toBe(false);
    expect(f.text).toContain('el nodo Transferencia exige BancoOriNal');
    expect(f.text).toContain('`receipt trace record CPMT-2026-00003 --payer-bank <clave> --reason <motivo>`');
    expect(f.text).not.toContain('payment create');
    expect(f.text).not.toContain('receipt record');
    expect(f.text).not.toContain('ningún comando');
  });

  // MNE-001-401 (#532): a foreign bank is declared as 999 with its name.
  it('a foreign destination bank goes out as 999 with its name in BancoDestExt', () => {
    const r = rastroDePago(
      payment({ cuenta_destino: 'GB29NWBK60161331926819', banco_destino_sat: null, banco_destino_extranjero: 'Bank of Nowhere' }),
      'sale', account(), OURS, passThrough, ENTRY
    );
    expect(r.motivo).toBeUndefined();
    expect(r.pago).toEqual({
      clase: 'transferencia',
      ctaOri: CLABE,
      bancoOriNal: '012',
      ctaDest: 'GB29NWBK60161331926819',
      bancoDestNal: '999',
      bancoDestExt: 'Bank of Nowhere',
      fecha: '2026-10-15',
      benef: 'Fletes del Norte SA',
      rfc: 'FNO010101AB1',
      monto: '116.00',
      moneda: 'MXN',
    });
  });

  it('the foreign bank name goes through the sanitizer it is given, with the voucher and the field', () => {
    const calls: string[][] = [];
    const recording = (raw: string, entry: string, field: string): string => {
      calls.push([raw, entry, field]);
      return raw.replace(/\s+/g, ' ').trim();
    };
    const r = rastroDePago(
      payment({ banco_destino_sat: null, banco_destino_extranjero: 'Bank of\nNowhere\t ' }), 'sale', account(), OURS, recording, ENTRY
    );
    expect(r.pago).toMatchObject({ bancoDestNal: '999', bancoDestExt: 'Bank of Nowhere' });
    // The stored value is trimmed first, as every captured trace field is.
    expect(calls).toContainEqual(['Bank of\nNowhere', ENTRY, 'BancoDestExt del pago VPMT-2026-00007']);
  });

  it('a name of 150 characters, the column and the attribute limit, goes out whole', () => {
    const name = 'B'.repeat(150);
    const r = rastroDePago(payment({ banco_destino_sat: null, banco_destino_extranjero: name }), 'sale', account(), OURS, passThrough, ENTRY);
    expect(r.pago).toMatchObject({ bancoDestExt: name });
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
    // MNE-001-570: the receipt gets its bank account linked, as a vendor payment does.
    expect(f.text).toContain('`receipt trace record CPMT-2026-00001 --bank <cuenta> --reason <motivo>`');
    expect(f.text).not.toContain('ningún comando');
  });

  it('a destination bank not captured: completed on the registered payment (MNE-001-568)', () => {
    const f = finding(payment({ banco_destino_sat: null }), 'sale', account());
    expect(f.text).toContain('el nodo Transferencia exige BancoDestNal');
    expect(f.text).toContain('`payment trace record VPMT-2026-00007 --to-bank <clave> --reason <motivo>`');
    expect(f.text).not.toContain(CAPTURE_REMEDY);
    expect(f.text).not.toContain('ningún comando');
  });

  it('no finding cites a tracker number', () => {
    const texts = [
      finding(payment({ payment_method: 'check', check_number: '1' }), 'sale', account({ sat_bank_code: null })),
      finding(payment({ bank_account_id: null }), 'sale', undefined),
      finding(payment({ cuenta_destino: null }), 'entra', account()),
      ...RECEIPT_GAPS.map(([, p, bank]) => finding(p, 'entra', bank)),
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
  ['G1 a transfer with no payer bank', receipt({ banco_origen_sat: null }), account(), 'Transferencia exige BancoOriNal', 'receipt trace record PMT-2026-00011 --payer-bank <clave>'],
  ['G3 a cheque with no number', customerCheckPayment({ check_number: null }), undefined, 'el nodo Cheque lo exige', 'receipt trace record PMT-2026-00011 --check-number <número>'],
  ['G4 a cheque with no payer bank', customerCheckPayment({ banco_origen_sat: null }), undefined, 'Cheque exige BanEmisNal', 'receipt trace record PMT-2026-00011 --payer-bank <clave>'],
  ['G5 a cheque with no drawn-on account', customerCheckPayment({ cuenta_origen: null }), undefined, 'Cheque exige CtaOri', 'receipt trace record PMT-2026-00011 --payer-account <cuenta>'],
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
    // MNE-001-570: a registered receipt is completed, never recorded again.
    expect(f.text).not.toContain('receipt record');
    expect(f.text).not.toMatch(/#\d/);
  });

  // MNE-001-401 (#532): the customer's foreign bank, stored by #611, is declared as 999 with its name.
  it('G2: a transfer from a foreign payer bank goes out as 999 with its name in BancoOriExt', () => {
    const r = rastroDePago(
      receipt({ banco_origen_sat: null, banco_origen_extranjero: 'Bank of Nowhere' }), 'entra', account(), OURS, passThrough, ENTRY
    );
    expect(r.motivo).toBeUndefined();
    expect(r.pago).toMatchObject({
      clase: 'transferencia', ctaOri: PAYER_ACCOUNT, bancoOriNal: '999', bancoOriExt: 'Bank of Nowhere', ctaDest: CLABE, bancoDestNal: '012',
    });
  });

  it('a customer cheque from a foreign bank goes out as 999 with its name in BanEmisExt', () => {
    const r = rastroDePago(
      customerCheckPayment({ banco_origen_sat: null, banco_origen_extranjero: 'Banco de Ultramar SA' }), 'entra', undefined, OURS, passThrough, ENTRY
    );
    expect(r.pago).toMatchObject({
      clase: 'cheque', num: '4501', banEmisNal: '999', banEmisExt: 'Banco de Ultramar SA', ctaOri: '1234567890', monto: '232.00',
    });
  });

  it('a customer cheque from a foreign bank with no drawn-on account is still named for CtaOri', () => {
    const f = finding(customerCheckPayment({ banco_origen_sat: null, banco_origen_extranjero: 'Banco de Ultramar SA', cuenta_origen: null }), 'entra', undefined);
    expect(f.node).toBe(false);
    expect(f.text).toContain('Cheque exige CtaOri');
  });
});

// ============================================================
// MNE-001-568/569/570 (#612, parts 1-3/4) · EVERY CAUSE OF A REGISTERED PAYMENT, AND
// ITS REMEDY. A payment already registered is never sent back to the command
// that captures one (`payment create`, `receipt record`): the remedy names
// the record that lacks the datum, or the command that completes it on that
// payment. None is left with no command: a foreign bank, the last one, is
// declared as 999 with its name (MNE-001-401).
// ============================================================

/** `site` is the branch of `rastroDePago` that names the cause. */
interface Cause {
  name: string;
  direction: 'sale' | 'entra';
  payment: Payment;
  bank: BankAccount | undefined;
  remedy: string;
  site: string;
}

const vendorCheck = (over: Partial<Payment> = {}): Payment => payment({ payment_method: 'check', check_number: '30001', ...over });
const CAUSES: readonly Cause[] = [
  { name: 'a vendor without RFC', direction: 'sale', payment: payment({ contraparte_rfc: null }), bank: account(), remedy: 'falta en el registro del proveedor', site: 'payee' },
  { name: 'a cheque with no number', direction: 'sale', payment: vendorCheck({ check_number: null }), bank: account(), remedy: '`payment trace record VPMT-2026-00007 --check-number <número> --reason <motivo>`', site: 'sale-check-number' },
  { name: 'a cheque from an account with no c_Banco code', direction: 'sale', payment: vendorCheck(), bank: account({ sat_bank_code: null }), remedy: 'bank account edit <cuenta> --sat-bank-code <clave>', site: 'our-bank-code' },
  { name: 'a cheque with no bank account', direction: 'sale', payment: vendorCheck({ bank_account_id: null }), bank: undefined, remedy: '`payment trace record VPMT-2026-00007 --bank <cuenta> --reason <motivo>`', site: 'our-bank-none' },
  { name: 'a cheque from an account with no number', direction: 'sale', payment: vendorCheck(), bank: account({ clabe_encrypted: null }), remedy: 'bank account edit <cuenta> --clabe <18 dígitos>', site: 'sale-check-account' },
  { name: 'a transfer with no destination account', direction: 'sale', payment: payment({ cuenta_destino: null, banco_destino_sat: null }), bank: account(), remedy: '`payment trace record VPMT-2026-00007 --to-account <cuenta> --reason <motivo>`', site: 'sale-to-account' },
  { name: 'a transfer from an account with no c_Banco code', direction: 'sale', payment: payment(), bank: account({ sat_bank_code: null }), remedy: 'bank account edit <cuenta> --sat-bank-code <clave>', site: 'our-bank-code' },
  { name: 'a transfer with no bank account', direction: 'sale', payment: payment({ bank_account_id: null }), bank: undefined, remedy: '`payment trace record VPMT-2026-00007 --bank <cuenta> --reason <motivo>`', site: 'our-bank-none' },
  { name: 'a transfer with no destination bank', direction: 'sale', payment: payment({ banco_destino_sat: null }), bank: account(), remedy: '`payment trace record VPMT-2026-00007 --to-bank <clave> --reason <motivo>`', site: 'sale-to-bank' },
  { name: 'a receipt into an entity with no RFC', direction: 'entra', payment: receipt(), bank: account(), remedy: 'falta en el registro de la entidad', site: 'payee' },
  { name: 'a customer cheque with no number', direction: 'entra', payment: customerCheckPayment({ check_number: null }), bank: undefined, remedy: '`receipt trace record PMT-2026-00011 --check-number <número> --reason <motivo>`', site: 'entra-check-number' },
  { name: 'a customer cheque with no payer bank', direction: 'entra', payment: customerCheckPayment({ banco_origen_sat: null }), bank: undefined, remedy: '`receipt trace record PMT-2026-00011 --payer-bank <clave> --reason <motivo>`', site: 'payer-bank' },
  { name: 'a customer cheque with no drawn-on account', direction: 'entra', payment: customerCheckPayment({ cuenta_origen: null }), bank: undefined, remedy: '`receipt trace record PMT-2026-00011 --payer-account <cuenta> --reason <motivo>`', site: 'entra-check-account' },
  { name: 'a receipt with no bank account', direction: 'entra', payment: receipt({ bank_account_id: null }), bank: undefined, remedy: '`receipt trace record PMT-2026-00011 --bank <cuenta> --reason <motivo>`', site: 'our-bank-none' },
  { name: 'a receipt into an account with no c_Banco code', direction: 'entra', payment: receipt(), bank: account({ sat_bank_code: null }), remedy: 'bank account edit <cuenta> --sat-bank-code <clave>', site: 'our-bank-code' },
  { name: 'a receipt into an account with no number', direction: 'entra', payment: receipt(), bank: account({ clabe_encrypted: null }), remedy: 'bank account edit <cuenta> --clabe <18 dígitos>', site: 'entra-to-account' },
  { name: 'a receipt with no payer bank', direction: 'entra', payment: receipt({ banco_origen_sat: null }), bank: account(), remedy: '`receipt trace record PMT-2026-00011 --payer-bank <clave> --reason <motivo>`', site: 'payer-bank' },
];

describe('every cause of a registered payment has a remedy that is true (MNE-001-568)', () => {
  const OURS_WITHOUT_RFC = { nombre: OURS.nombre, rfc: '' };
  const textOf = (c: Cause): string => {
    const r = rastroDePago(c.payment, c.direction, c.bank, c.name.includes('entity with no RFC') ? OURS_WITHOUT_RFC : OURS, passThrough, ENTRY);
    expect(r.pago, c.name).toBeUndefined();
    const [h] = polizaConDineroSinRastro([{ numUnIdenPol: ENTRY, motivo: r.motivo ?? '', ...r }]);
    return h!.detalle;
  };

  it.each(CAUSES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const text = textOf(c);
    expect(text).toContain(c.remedy);
    expect(text).not.toMatch(/#\d/);
    // Never the capture command of the other side, and never a reversal.
    expect(text).not.toContain(c.direction === 'sale' ? 'receipt record' : 'payment create');
    expect(text).not.toContain('payment reverse');
    // A registered payment is never sent back to a capture command (MNE-001-570: the receipt's too).
    expect(text).not.toContain('payment create');
    expect(text).not.toContain('receipt record');
  });

  // MNE-001-401 (#532): a foreign bank is declared as 999 with its name, so the
  // two foreign-bank causes 570 left with no command are gone, and no cause is.
  it('no cause is left with no command that completes it (a foreign bank is declared, MNE-001-401)', () => {
    const none = CAUSES.filter((c) => rastroDePago(c.payment, c.direction, c.bank, OURS, passThrough, ENTRY).noCommandFixes !== undefined);
    expect(none.map((c) => c.site)).toEqual([]);
  });

  it('the receipt leaf completes what `receipt record` captures, naming the receipt by its number (MNE-001-570)', () => {
    const completed = CAUSES.filter((c) => c.remedy.startsWith('`receipt trace record'));
    expect(completed.map((c) => c.site)).toEqual(['entra-check-number', 'payer-bank', 'entra-check-account', 'our-bank-none', 'payer-bank']);
    for (const c of completed) {
      const r = rastroDePago(c.payment, c.direction, c.bank, OURS, passThrough, ENTRY);
      expect(r.completedBy).toMatch(/^receipt trace record PMT-2026-00011 --/);
      expect(r.noCommandFixes).toBeUndefined();
      expect(textOf(c)).toContain('Complétalo en el pago ya registrado');
    }
  });

  it('the leaf completes what the vendor side captures, naming the payment by its number', () => {
    const completed = CAUSES.filter((c) => c.remedy.startsWith('`payment trace record'));
    expect(completed.map((c) => c.site)).toEqual(['sale-check-number', 'our-bank-none', 'sale-to-account', 'our-bank-none', 'sale-to-bank']);
    for (const c of completed) {
      const r = rastroDePago(c.payment, c.direction, c.bank, OURS, passThrough, ENTRY);
      expect(r.completedBy).toMatch(/^payment trace record VPMT-2026-00007 --/);
      expect(r.noCommandFixes).toBeUndefined();
      expect(textOf(c)).toContain('Complétalo en el pago ya registrado');
    }
  });

  it('no cause is left out: one row per branch of `rastroDePago` that names a motive', () => {
    const branches = (rastroDePago.toString().match(/\bmotivo:/g) ?? []).length;
    expect(new Set(CAUSES.map((c) => c.site)).size).toBe(branches);
  });
});
