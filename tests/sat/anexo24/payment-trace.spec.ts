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

  it('a customer transfer: nothing captures the payer bank, and the remedy says so', () => {
    const f = finding(
      payment({ payment_number: 'CPMT-2026-00003', cuenta_destino: null, banco_destino_sat: null }),
      'entra',
      account()
    );
    expect(f.node).toBe(false);
    expect(f.text).toContain('el nodo Transferencia exige BancoOriNal');
    expect(f.text).toContain('receipt record');
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

  it('a destination bank not captured keeps the payment remedy: there it is true', () => {
    const f = finding(payment({ banco_destino_sat: null }), 'sale', account());
    expect(f.text).toContain('el nodo Transferencia exige BancoDestNal');
    expect(f.text).toContain(PAYMENT_REMEDY);
  });

  it('no finding cites a tracker number', () => {
    const texts = [
      finding(payment({ payment_method: 'check', check_number: '1' }), 'sale', account({ sat_bank_code: null })),
      finding(payment({ bank_account_id: null }), 'sale', undefined),
      finding(payment({ cuenta_destino: null }), 'entra', account()),
      finding(payment({ banco_destino_sat: null, banco_destino_extranjero: 'Bank of Nowhere' }), 'sale', account()),
      finding(payment({ banco_destino_sat: null }), 'sale', account()),
    ].map((f) => f.text);
    for (const t of texts) {
      expect(t).not.toBe('');
      expect(t).not.toMatch(/#\d/);
    }
  });
});
