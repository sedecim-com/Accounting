/**
 * MNE-001-480 (#151), part 1: the refusals of src/services/payments that were
 * written in Spanish prose are catalogue keys now. The Spanish twin must print,
 * byte for byte, what each site printed before (the strings below are written
 * by hand from those sites, with synthetic values), and the English is the
 * source the error's `message` is fixed in.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError, ValidationError } from '../../../src/utils/errors.js';
import {
  applyCustomerPayment,
  applyVendorPayment,
  assertPayerTrace,
  assertRastroDePago,
  recordVendorPayment,
  reverseCustomerPayment,
} from '../../../src/services/payments/payment-service.js';

type Case = readonly [TranslationKey, MessageParams, string];

const WHY_NOT_BOTH = 'El Anexo 24 pide la CLAVE del catálogo para el nacional y el NOMBRE para el extranjero: declarar los dos afirma dos cosas incompatibles sobre el mismo movimiento, y el archivo las lleva tal cual a la autoridad.';
const WHY_NOT_CONVERTED = 'No lo registro convertido porque la tasa y su fuente las decide el despacho en la política `fuente_tipo_cambio`, no yo; y no lo registro sin convertir porque asentaría una cifra de otra moneda como si fuera de ésta.';

const SPANISH_AS_BEFORE: readonly Case[] = [
  // assertRastroDePago
  ['error.VALIDATION_ERROR.payment.destination_bank_both', { national: '012', foreign: 'Banco Ejemplo', foreignCode: 'no', code: '999' },
    `El pago declara banco destino nacional («012») y extranjero («Banco Ejemplo») a la vez. ${WHY_NOT_BOTH}`],
  ['error.VALIDATION_ERROR.payment.destination_bank_both', { national: '999', foreign: 'Banco Ejemplo', foreignCode: 'yes', code: '999' },
    `El pago declara banco destino nacional («999») y extranjero («Banco Ejemplo») a la vez. ${WHY_NOT_BOTH} Un banco extranjero se da sólo con su nombre: la póliza le pone la clave 999 al escribirlo.`],
  ['error.VALIDATION_ERROR.payment.destination_bank_length', { national: 'BANCO', length: 5, expected: 3 },
    'La clave de banco destino «BANCO» tiene 5 caracteres y el c_Banco del SAT son 3. Un banco no se identifica por su nombre en este campo: si el banco es extranjero, dilo con el nombre en el campo de banco extranjero.'],
  ['error.VALIDATION_ERROR.payment.destination_bank_off_list', { national: '001' },
    'La clave de banco destino «001» no está en el catálogo c_Banco del SAT (tres dígitos de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.'],
  ['error.VALIDATION_ERROR.payment.destination_account_missing', {},
    'Se indicó el banco destino y no la cuenta destino. En la póliza del Anexo 24 la cuenta destino es el dato obligatorio del nodo de transferencia y el banco el opcional: el banco solo no permite emitir el rastro y sí aparenta que el pago ya lo tiene.'],
  ['error.VALIDATION_ERROR.payment.cheque_on_other_method', { cheque: '000123', side: 'proveedor', method: 'spei' },
    'Se dio número de cheque («000123») a un pago hecho por «spei». El número de cheque identifica un cheque: sobre otro método la póliza del Anexo 24 declararía un cheque que no existe. Usa la referencia bancaria para el folio de una transferencia.'],
  ['error.VALIDATION_ERROR.payment.cheque_on_other_method', { cheque: '000123', side: 'cliente', method: 'cash' },
    'Se dio número de cheque («000123») a un pago cobrado por «cash». El número de cheque identifica un cheque: sobre otro método la póliza del Anexo 24 declararía un cheque que no existe. Usa la referencia bancaria para el folio de una transferencia.'],
  // assertPayerTrace
  ['error.VALIDATION_ERROR.payment.cheque_too_long', { cheque: '123456789012345678901' },
    'El número de cheque «123456789012345678901» pasa de los 20 caracteres que admite el nodo Cheque de la póliza del Anexo 24.'],
  ['error.VALIDATION_ERROR.payment.payer_bank_on_vendor_payment', {},
    'El banco y la cuenta del pagador sólo se capturan en un cobro. En un pago a proveedor el origen es nuestra cuenta bancaria (`--bank`), y su clave c_Banco vive en esa cuenta.'],
  ['error.VALIDATION_ERROR.payment.payer_bank_method', { method: 'cash' },
    'Se dio banco o cuenta del cliente a un cobro por «cash». Sólo un cheque o una transferencia declaran de qué banco salió el dinero en la póliza del Anexo 24.'],
  ['error.VALIDATION_ERROR.payment.payer_bank_both', { bank: '012', foreign: 'Banco Ejemplo', code: '999' },
    'El cobro declara banco del cliente nacional («012») y extranjero («Banco Ejemplo») a la vez. Un banco extranjero se da sólo con su nombre: la póliza le pone la clave 999 al escribirlo.'],
  ['error.VALIDATION_ERROR.payment.payer_bank_off_list', { bank: '001' },
    'La clave de banco del cliente «001» no está en el catálogo c_Banco del SAT (tres dígitos de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.'],
  ['error.VALIDATION_ERROR.payment.payer_account_without_bank', {},
    'Se indicó la cuenta del cliente y no su banco. El nodo de pago de la póliza exige el banco de origen: la cuenta sola no permite emitirlo y sí aparenta que el cobro ya tiene su rastro.'],
  ['error.VALIDATION_ERROR.payment.payer_trace_too_long', {},
    'La cuenta del cliente admite hasta 50 caracteres y el nombre de su banco extranjero hasta 150, los mismos límites del nodo de pago de la póliza.'],
  // recording a payment or a receipt
  ['error.PAYMENT_STATE_UNSUPPORTED', { state: 'completed', status: 'scheduled' },
    "Un pago sólo puede registrarse como 'completed': mnemosine registra pagos que YA ocurrieron. El estado 'scheduled' pertenece a un programador de pagos que no existe, y un pago que no ha salido del banco no puede tocar el mayor."],
  ['error.VALIDATION_ERROR.payment.no_application', {},
    'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.'],
  ['error.VALIDATION_ERROR.payment.advance_without_party', { side: 'proveedor' },
    'Un anticipo sin documento necesita el proveedor explícito: sin documento no hay de dónde deducirlo.'],
  ['error.VALIDATION_ERROR.payment.advance_without_party', { side: 'cliente' },
    'Un anticipo sin documento necesita el cliente explícito: sin documento no hay de dónde deducirlo.'],
  ['error.VALIDATION_ERROR.payment.document_repeated', { document: 'd-1' },
    'El documento d-1 aparece dos veces en el mismo pago. Súmalas en una sola aplicación: repetirlo restaría su saldo dos veces.'],
  ['error.VALIDATION_ERROR.payment.customer_discount_is_credit_note', {},
    'Un descuento concedido a un cliente no es una línea del cobro: es una NOTA DE CRÉDITO, con su documento y su CFDI de egreso. Emítela con `mnemosine credit-note create --type descuento` y aplícala a la factura.'],
  ['error.VALIDATION_ERROR.payment.applications_exceed_amount', { total: '600.00', amount: '500.00' },
    'Las aplicaciones suman 600.00 y el pago es de 500.00: no se puede aplicar más de lo que se pagó.'],
  ['error.VALIDATION_ERROR.payment.applications_mismatch', { total: '400.00', amount: '500.00', side: 'cliente' },
    'Las aplicaciones suman 400.00 y el pago es de 500.00. Tienen que coincidir: lo que sobra quedaría cargado a la cuenta de control sin bajar de ningún auxiliar. Si el remanente es deliberado, dilo con onAccount (--on-account): quedará como anticipo del cliente.'],
  ['error.VALIDATION_ERROR.payment.applications_mismatch', { total: '400.00', amount: '500.00', side: 'proveedor' },
    'Las aplicaciones suman 400.00 y el pago es de 500.00. Tienen que coincidir: lo que sobra quedaría cargado a la cuenta de control sin bajar de ningún auxiliar. Si el remanente es deliberado, dilo con onAccount (--on-account): quedará como anticipo a proveedores.'],
  ['error.VALIDATION_ERROR.payment.currency_mismatch', { document: 'B-1', documentCurrency: 'USD', paymentCurrency: 'MXN' },
    'B-1 está en USD y el pago en MXN. Un importe en otra moneda se restaría crudo del saldo y se asentaría crudo, sin tipo de cambio.'],
  ['error.VALIDATION_ERROR.payment.document_rate_missing', { document: 'B-1', currency: 'USD', rate: '1.000000', settle: 'pagarlo' },
    'B-1 está en USD pero su exchange_rate es 1.000000 (el default de captura): se asentó sin convertir. Corrige el documento antes de pagarlo — la diferencia cambiaria se mide contra la tasa a la que el documento nació (NIF B-15).'],
  ['error.VALIDATION_ERROR.payment.document_rate_missing', { document: 'F-1', currency: 'USD', rate: 'null', settle: 'cobrarlo' },
    'F-1 está en USD pero su exchange_rate es null (el default de captura): se asentó sin convertir. Corrige el documento antes de cobrarlo — la diferencia cambiaria se mide contra la tasa a la que el documento nació (NIF B-15).'],
  ['error.VALIDATION_ERROR.payment.rate_not_positive', { rate: '0' }, 'El tipo de cambio del pago (0) tiene que ser mayor que cero.'],
  ['error.VALIDATION_ERROR.payment.bank_account_inactive', { account: 'Cuenta de prueba' },
    'La cuenta bancaria "Cuenta de prueba" está inactiva: no registra movimientos nuevos. Elige una cuenta activa de `bank account list`.'],
  ['error.VALIDATION_ERROR.payment.advance_other_currency', { currency: 'USD', functional: 'MXN', side: 'proveedor' },
    `El anticipo viene en USD y esta entidad lleva sus libros en MXN. ${WHY_NOT_CONVERTED} Aplica el pago a un documento en su moneda, o registra el anticipo en MXN.`],
  ['error.VALIDATION_ERROR.payment.advance_other_currency', { currency: 'EUR', functional: 'MXN', side: 'cliente' },
    `El anticipo viene en EUR y esta entidad lleva sus libros en MXN. ${WHY_NOT_CONVERTED} Aplica el cobro a un documento en su moneda, o registra el anticipo en MXN.`],
  ['error.VALIDATION_ERROR.payment.vendor_unresolved', {}, 'No se pudo determinar el proveedor del pago.'],
  ['error.VALIDATION_ERROR.payment.customer_unresolved', {}, 'No se pudo determinar el cliente del cobro.'],
  ['error.FX_AR_ON_ACCOUNT_NOT_WIRED.receipt', { currency: 'USD', amount: '40.00' },
    'El cobro en USD deja 40.00 a cuenta del cliente. Un saldo a cuenta en otra moneda todavía no se puede aplicar ni desaplicar convertido, así que no lo registro: aplica el cobro completo a facturas en USD.'],
  // the documents settled
  ['error.VALIDATION_ERROR.payment.bill_not_payable', { bill: 'B-1', status: 'draft', payable: 'approved, posted, partially_paid' },
    'B-1 está en "draft" y sólo se puede pagar un gasto approved, posted, partially_paid: su pasivo tiene que estar en el mayor primero.'],
  ['error.VALIDATION_ERROR.payment.bill_not_applicable', { bill: 'B-1', status: 'paid', payable: 'approved, posted, partially_paid' },
    'B-1 está en "paid" y sólo se puede aplicar a un gasto approved, posted, partially_paid.'],
  ['error.VALIDATION_ERROR.payment.bill_other_vendor', { bill: 'B-1', vendor: 'v-1', counterparty: 'v-2' },
    'B-1 es del proveedor v-1 y el pago se atribuye a v-2: el pago quedaría en el auxiliar equivocado.'],
  ['error.VALIDATION_ERROR.payment.bill_exceeds_due', { bill: 'B-1', due: '116.00', settled: '500.00', cash: '480.00', discount: '20.00' },
    'B-1 debe 116.00 y se intentan extinguir 500.00 (480.00 de efectivo + 20.00 de descuento).'],
  ['error.VALIDATION_ERROR.payment.invoice_not_collectible', { invoice: 'F-1', status: 'draft', collectible: 'sent, viewed, partially_paid, overdue' },
    'F-1 está en "draft" y sólo se puede cobrar una factura sent, viewed, partially_paid, overdue: su ingreso tiene que estar en el mayor primero.'],
  ['error.VALIDATION_ERROR.payment.invoice_not_applicable', { invoice: 'F-1', status: 'paid', collectible: 'sent, viewed, partially_paid, overdue' },
    'F-1 está en "paid" y sólo se puede aplicar a una factura sent, viewed, partially_paid, overdue.'],
  ['error.VALIDATION_ERROR.payment.invoice_other_customer', { invoice: 'F-1', customer: 'c-1', counterparty: 'c-2' },
    'F-1 es del cliente c-1 y el cobro se atribuye a c-2: quedaría en el auxiliar equivocado.'],
  ['error.VALIDATION_ERROR.payment.invoice_exceeds_due', { invoice: 'F-1', due: '116.00', applied: '200.00' },
    'F-1 debe 116.00 y se intentan aplicar 200.00.'],
  ['error.VALIDATION_ERROR.payment.discount_over_terms', { bill: 'B-1', granted: '20.00', terms: '2/10 net 30', taken: '50.00' },
    'B-1 concede 20.00 de descuento por pronto pago ("2/10 net 30") y se están tomando 50.00. La diferencia no es descuento: es pagar de menos. Si es deliberado, dilo con --mode residual --short-pay-reason.'],
  // applying, unapplying and reversing
  ['error.VALIDATION_ERROR.payment.not_completed', { side: 'cliente', payment: 'CPMT-1', status: 'reversed' },
    "El cobro CPMT-1 está en 'reversed': sólo un cobro 'completed' admite este evento."],
  ['error.VALIDATION_ERROR.payment.not_completed', { side: 'proveedor', payment: 'VPMT-1', status: 'reversed' },
    "El pago VPMT-1 está en 'reversed': sólo un pago 'completed' admite este evento."],
  ['error.VALIDATION_ERROR.payment.apply_which_invoices', {}, 'Indica a qué factura(s) se aplica el saldo a cuenta.'],
  ['error.VALIDATION_ERROR.payment.apply_which_bills', {}, 'Indica a qué gasto(s) se aplica el saldo a cuenta.'],
  ['error.VALIDATION_ERROR.payment.application_document_repeated', { document: 'd-1' },
    'El documento d-1 aparece dos veces en la misma aplicación: súmalas en una.'],
  ['error.VALIDATION_ERROR.payment.on_account_short', { side: 'cliente', payment: 'CPMT-1', left: '100.00', total: '150.00' },
    'El cobro CPMT-1 tiene 100.00 sin aplicar y se intentan aplicar 150.00: el saldo a cuenta no alcanza.'],
  ['error.VALIDATION_ERROR.payment.on_account_short', { side: 'proveedor', payment: 'VPMT-1', left: '100.00', total: '150.00' },
    'El pago VPMT-1 tiene 100.00 sin aplicar y se intentan aplicar 150.00: el saldo a cuenta no alcanza.'],
  ['error.VALIDATION_ERROR.payment.nothing_to_unapply', { receipt: 'CPMT-1', invoice: 'F-1' },
    'El cobro CPMT-1 no tiene ninguna aplicación viva sobre F-1: no hay qué desaplicar.'],
  ['error.VALIDATION_ERROR.payment.reversal_fee_not_wired', {},
    'La comisión por devolución todavía no se puede registrar: necesita una cuenta con rol de comisiones bancarias en la capa semántica. Reversa el cobro sin --fee y registra la comisión como asiento manual mientras tanto.'],
  ['error.VALIDATION_ERROR.payment.short_pay_reason_required', {},
    'Cerrar un gasto pagando de menos borra un pasivo que sí se debía: di por qué con --short-pay-reason. Sin motivo escrito, el auditor sólo ve un saldo que desapareció.'],
  ['error.VALIDATION_ERROR.payment.short_pay_forbidden', {},
    'La política `pago_corto_residual` de este despacho está en "prohibir": ningún gasto se cierra pagando de menos. Pide al proveedor la nota de crédito y aplícala, o cambia la política con `mnemosine pending reopen pago_corto_residual` (si ya estaba definida) y luego `mnemosine pending define pago_corto_residual`.'],
];

describe('MNE-001-480 · the Spanish twin prints what each site printed before', () => {
  it.each(SPANISH_AS_BEFORE)('%s', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it('covers the 45 keys of the part, every select branch included', () => {
    expect(new Set(SPANISH_AS_BEFORE.map(([key]) => key)).size).toBe(45);
  });
});

describe('MNE-001-480 · the English source', () => {
  it('reads the same facts in English, the select branches included', () => {
    expect(t('error.VALIDATION_ERROR.payment.not_completed', { side: 'cliente', payment: 'CPMT-1', status: 'reversed' }, 'en')).toBe(
      "Receipt CPMT-1 is 'reversed': only a 'completed' receipt admits this event."
    );
    expect(t('error.VALIDATION_ERROR.payment.bill_exceeds_due', { bill: 'B-1', due: '116.00', settled: '500.00', cash: '480.00', discount: '20.00' }, 'en')).toBe(
      'B-1 owes 116.00 and 500.00 is being extinguished (480.00 in cash + 20.00 in discount).'
    );
    expect(t('error.VALIDATION_ERROR.payment.document_rate_missing', { document: 'F-1', currency: 'USD', rate: 'null', settle: 'cobrarlo' }, 'en')).toBe(
      'F-1 is in USD but its exchange_rate is null (the capture default): it was posted unconverted. Correct the document before collecting it: the exchange difference is measured against the rate the document was born with (NIF B-15).'
    );
  });
});

/** The error a call throws, synchronously or as a rejection. */
async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('MNE-001-480 · the sites throw by key, before touching the database', () => {
  it('a cheque number on a transfer: the code, an English message, the Spanish when rendered', async () => {
    const err = await caught(() =>
      assertRastroDePago({ paymentMethod: 'spei', checkNumber: '000123' }, 'proveedor')
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: 'VALIDATION_ERROR',
      messageKey: {
        key: 'error.VALIDATION_ERROR.payment.cheque_on_other_method',
        params: { cheque: '000123', side: 'proveedor', method: 'spei' },
      },
      message:
        'A cheque number («000123») was given to a payment made by «spei». A cheque number identifies a cheque: on another method the Anexo 24 voucher would declare a cheque that does not exist. Use the bank reference for the folio of a transfer.',
    });
    expect((err as ValidationError).localized('es')).toBe(
      'Se dio número de cheque («000123») a un pago hecho por «spei». El número de cheque identifica un cheque: sobre otro método la póliza del Anexo 24 declararía un cheque que no existe. Usa la referencia bancaria para el folio de una transferencia.'
    );
  });

  it('both destination banks, with 999 as the national one: the select adds the code sentence', async () => {
    const err = await caught(() =>
      assertRastroDePago({ paymentMethod: 'spei', bancoDestinoSat: '999', bancoDestinoExtranjero: 'Banco Ejemplo', cuentaDestino: '1234' }, 'proveedor')
    );
    expect(err).toMatchObject({
      messageKey: { key: 'error.VALIDATION_ERROR.payment.destination_bank_both', params: { foreignCode: 'yes', code: '999' } },
    });
    expect((err as ValidationError).localized('es')).toMatch(/la póliza le pone la clave 999 al escribirlo\.$/);
  });

  it('the payer bank on a vendor payment', async () => {
    const err = await caught(() => assertPayerTrace({ paymentMethod: 'spei', payerBankCode: '012' }, 'proveedor'));
    expect(err).toMatchObject({ messageKey: { key: 'error.VALIDATION_ERROR.payment.payer_bank_on_vendor_payment' } });
  });

  it('a payment in a status mnemosine does not record is an AccountingError by key', async () => {
    const err = await caught(() =>
      recordVendorPayment(
        { entityId: 'e-1', paymentDate: '2026-08-14', paymentAmount: '100', paymentMethod: 'spei', status: 'scheduled', applications: [] } as never,
        'u-1'
      )
    );
    expect(err).toBeInstanceOf(AccountingError);
    expect(err).toMatchObject({
      code: 'PAYMENT_STATE_UNSUPPORTED',
      messageKey: { key: 'error.PAYMENT_STATE_UNSUPPORTED', params: { state: 'completed', status: 'scheduled' } },
    });
  });

  it('applying cash on account to nothing, on both sides', async () => {
    const customer = await caught(() => applyCustomerPayment('e-1', 'p-1', [], 'u-1'));
    expect(customer).toMatchObject({ messageKey: { key: 'error.VALIDATION_ERROR.payment.apply_which_invoices' } });
    const vendor = await caught(() => applyVendorPayment('e-1', 'p-1', [], 'u-1'));
    expect(vendor).toMatchObject({ messageKey: { key: 'error.VALIDATION_ERROR.payment.apply_which_bills' } });
  });

  it('the same document twice in one application', async () => {
    const twice = [
      { documentId: 'd-1', amountApplied: '10' },
      { documentId: 'd-1', amountApplied: '5' },
    ];
    const err = await caught(() => applyVendorPayment('e-1', 'p-1', twice, 'u-1'));
    expect(err).toMatchObject({
      messageKey: { key: 'error.VALIDATION_ERROR.payment.application_document_repeated', params: { document: 'd-1' } },
    });
  });

  it('a short payment with no reason, and a reversal with a fee', async () => {
    const short = await caught(() =>
      applyVendorPayment('e-1', 'p-1', [{ documentId: 'd-1', amountApplied: '10' }], 'u-1', { modo: 'residual' })
    );
    expect(short).toMatchObject({ messageKey: { key: 'error.VALIDATION_ERROR.payment.short_pay_reason_required' } });
    const fee = await caught(() => reverseCustomerPayment('e-1', 'p-1', { reason: 'r', feeAmount: '15' }, 'u-1'));
    expect(fee).toMatchObject({ messageKey: { key: 'error.VALIDATION_ERROR.payment.reversal_fee_not_wired' } });
  });
});

describe('MNE-001-480 · the services lane', () => {
  it('payment-service.ts has no Spanish user string left', () => {
    const out = execFileSync('npx', ['tsx', 'scripts/language/lanes/service-strings.ts', 'src/services/payments'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });
});
