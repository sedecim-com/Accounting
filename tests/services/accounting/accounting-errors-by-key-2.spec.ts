/**
 * MNE-001-627 (#151), part 2 of MNE-001-154: the AccountingError throws of
 * src/services/accounting that were written in English prose are catalogue
 * keys now. The English source must print, byte for byte, what each site
 * printed before (the strings below are written by hand from those sites),
 * and a Spanish session reads the Spanish twin.
 */
import { describe, expect, it } from 'vitest';
import { t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError } from '../../../src/utils/errors.js';
import type { AgentContext } from '../../../src/ai/context.js';

type Row = readonly [TranslationKey, MessageParams, string, string];

const ENGLISH_AS_BEFORE_AND_SPANISH: readonly Row[] = [
  // ar-ap-posting.ts
  ['error.CREDIT_NOTE_ALREADY_POSTED', { note: 'NC-3' },
    "NC-3 already has an entry or is not this entity's: no second one is linked.",
    'NC-3 ya tiene póliza o no es de esta entidad: no se enlaza otra.'],
  ['error.FX_BANK_CURRENCY_MISMATCH', { payment: 'C-9', currency: 'USD', bankCurrency: 'MXN' },
    'C-9 is in USD but its bank account is kept in MXN. The bank converted the money at its own rate, which this payment does not carry: record it against a USD bank account, or record the conversion separately.',
    'C-9 está en USD, pero su cuenta bancaria se lleva en MXN. El banco convirtió el dinero a su propio tipo de cambio, que este pago no trae: regístralo contra una cuenta bancaria en USD, o registra la conversión por separado.'],
  ['error.PAYMENT_ALLOCATION_NOT_FOUND.no_live_allocation', { payment: 'C-9', invoice: 'inv-1' },
    'C-9: no live allocation to invoice inv-1 is waiting for its released IVA, so the amount an unapply would re-park cannot be recorded.',
    'C-9: ninguna aplicación vigente a la factura inv-1 espera su IVA liberado, así que no se puede registrar el monto que una desaplicación volvería a aparcar.'],
  ['error.PAYMENT_ALLOCATION_NOT_FOUND.release_not_recorded', { payment: 'C-9', unreleased: 3, recorded: 2 },
    'C-9: 3 live allocations released no IVA and 2 recorded it, so an unapply could not tell them from rows that never stored one.',
    'C-9: 3 aplicación(es) vigente(s) no liberaron IVA y 2 lo registraron, así que una desaplicación no podría distinguirlas de las filas que nunca lo guardaron.'],
  ['error.PAYMENT_ALREADY_POSTED.payment', { payment: 'C-9' },
    "C-9 already has an entry or is not this entity's: no second one is linked.",
    'C-9 ya tiene póliza o no es de esta entidad: no se enlaza otra.'],
  ['error.ADVANCE_SPLIT_MISMATCH', { payment: 'C-9', base: '100.00', iva: '16.00', remaining: '116.01' },
    "C-9: the advance's base 100.00 plus its IVA 16.00 is not the 116.01 left on account.",
    'C-9: la base del anticipo 100.00 más su IVA 16.00 no suman los 116.01 que quedan a cuenta.'],
  ['error.PAYMENT_ALREADY_POSTED.transfer', { transfer: 'T-2' },
    "T-2 already has an entry or is not this entity's transfer: no second one is linked.",
    'T-2 ya tiene póliza o no es una transferencia de esta entidad: no se enlaza otra.'],
  // closing-conductor.ts, period-close.ts
  ['error.PERIOD_NOT_FOUND', {}, 'Fiscal period not found', 'No se encontró el periodo fiscal'],
  ['error.UNKNOWN_CLOSING_STEP', { step: 'sweep', steps: 'a, b' },
    'Unknown step "sweep". The steps are: a, b.',
    'Paso desconocido "sweep". Los pasos son: a, b.'],
  // discount-vat-correction.ts, vat-overcredit.ts
  ['error.MISSING_ROLE_ACCOUNT.no_account', { entity: 'Demo SA', role: 'vat_payable' },
    'Demo SA has no account for the vat_payable role.',
    'Demo SA no tiene cuenta para el rol vat_payable.'],
  // fiscal-calendar-service.ts
  ['error.PERIOD_NOT_FUTURE', { period: '2026-03', status: 'open' },
    "2026-03 is 'open', not 'future'. Only a future period can be opened; reopening a closed period is a separate, audited operation.",
    "2026-03 está 'open', no 'future'. Sólo se abre un periodo futuro; reabrir un periodo cerrado es otra operación, que queda auditada."],
  // fx-revaluation.ts
  ['error.FX_POLITICA_DESCONOCIDA.policy', { policy: 'closing_exchange_rate_source', value: 'bce', known: 'dof, banxico' },
    'closing_exchange_rate_source is "bce" and this reader only understands dof, banxico. Fix it with mnemosine pending.',
    'La política closing_exchange_rate_source vale "bce" y este lector solo entiende dof, banxico. Corrige la política en mnemosine pending.'],
  ['error.MISSING_ROLE_ACCOUNT.fx_revaluation', { role: 'fx_gain' },
    'No account is mapped to the role "fx_gain" in this entity.',
    'No hay cuenta mapeada al rol "fx_gain" en esta entidad.'],
  // ieps-cash-basis.ts
  ['error.MISSING_ROLE_ACCOUNT.ieps', { role: 'ieps_due', event: 'collection' },
    'No account is mapped to the role "ieps_due" on this entity, and an invoice parked IEPS that this collection causes (LIEPS art. 10). Map it with: mnemosine account map set (or check with: mnemosine doctor)',
    'No hay cuenta mapeada al rol "ieps_due" en esta entidad, y una factura aparcó IEPS que se causa con este cobro (LIEPS art. 10). Mapea la cuenta con: mnemosine account map set (o revisa con: mnemosine doctor)'],
  // iva-cash-basis.ts
  ['error.IVA_ROLE_UNRESOLVED.same_role', { role: 'iva_acreditable' },
    'The CFDI taxonomy sends the VAT of a received PPD to iva_acreditable: a payment would have nowhere to release it from. Check CASES in src/services/xml-ingestion/cfdi-taxonomy.ts.',
    'La taxonomía CFDI manda el IVA de un PPD recibido a iva_acreditable: un pago no tendría de dónde liberarlo. Revisa CASES en src/services/xml-ingestion/cfdi-taxonomy.ts.'],
  // journal-entry-service.ts
  ['error.ENTRY_NOT_FOUND.ref', { entry: 'PD-4' }, 'Journal entry PD-4 not found', 'No se encontró la póliza PD-4'],
  // period-close.ts
  ['error.PERIOD_NOT_OPEN', {}, 'Period is not in open status', 'El periodo no está abierto'],
  ['error.CANNOT_CLOSE_PERIOD', { issues: '2 unposted journal entries' },
    'Cannot close period: 2 unposted journal entries',
    'No se puede cerrar el periodo: 2 unposted journal entries'],
  ['error.PERIOD_NOT_SOFT_CLOSED', {},
    'Period must be in soft_close status before hard close',
    'El periodo debe estar en soft_close antes del cierre definitivo'],
  // posting.ts
  ['error.PERIOD_CLOSED.no_open_period', {},
    'No open fiscal period found for the entry date',
    'No hay un periodo fiscal abierto para la fecha de la póliza'],
  ['error.VALIDATION_FAILED', { errors: 'Line 1: debit_amount must be positive' },
    'Validation failed: Line 1: debit_amount must be positive',
    'La póliza no pasó la validación: Line 1: debit_amount must be positive'],
  ['error.ENTRY_NOT_FOUND', {}, 'Journal entry not found', 'No se encontró la póliza'],
  ['error.ALREADY_POSTED.post', {}, 'Journal entry is already posted', 'La póliza ya está aplicada'],
  ['error.ENTRY_VOID.post', {}, 'Cannot post a voided entry', 'No se puede aplicar una póliza anulada'],
  ['error.PERIOD_NOT_FOUND.posting', {},
    'Fiscal period not found while posting',
    'No se encontró el periodo fiscal al aplicar la póliza'],
  ['error.PERIOD_CLOSED.in_flight', { period: '2026-03', status: 'hard_close' },
    "2026-03 is 'hard_close': it closed while this entry was in flight; nothing was posted",
    "2026-03 está 'hard_close': se cerró mientras esta póliza estaba en curso; no se aplicó nada"],
  ['error.ENTRY_NOT_POSTED', { entry: 'PD-4', status: 'draft' },
    "Only posted entries can be reversed; PD-4 is 'draft' and never touched the ledger — reject or void it instead",
    "Sólo se revierte una póliza aplicada; PD-4 está en 'draft' y nunca tocó el mayor — recházala o anúlala"],
  ['error.ALREADY_REVERSED', { entry: 'PD-4' },
    'Entry PD-4 already has a reversal — reversing again would corrupt balances',
    'La póliza PD-4 ya tiene reversión — revertirla otra vez corrompería los saldos'],
  ['error.ASSET_CARD_NOT_REFRESHED', { entry: 'PD-4' },
    'Entry PD-4 is a depreciation entry and its asset is not in this entity: the reversal was not posted',
    'La póliza PD-4 es de depreciación y su activo no está en esta entidad: la reversión no se aplicó'],
  ['error.ALREADY_VOID', {}, 'Journal entry is already voided', 'La póliza ya está anulada'],
  // vat-overcredit.ts
  ['error.POLICY_VALUE_UNKNOWN', { policy: 'vat_overcredit_correction_period', value: 'x', known: 'ask | current_period | payment_month' },
    'vat_overcredit_correction_period = "x" is not a value this system knows (ask | current_period | payment_month); nothing was posted.',
    'vat_overcredit_correction_period = "x" no es un valor que este sistema conozca (ask | current_period | payment_month); no se aplicó nada.'],
];

describe('MNE-001-627 · the English source prints what each site printed before', () => {
  it.each(ENGLISH_AS_BEFORE_AND_SPANISH)('%s in en', (key, params, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });

  it.each(ENGLISH_AS_BEFORE_AND_SPANISH)('%s in es', (key, params, _english, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it('covers the 31 keys of the 40 sites, once each', () => {
    expect(new Set(ENGLISH_AS_BEFORE_AND_SPANISH.map(([key]) => key)).size).toBe(31);
  });

  it('the IEPS event reads in Spanish for an unapply, and the caller\'s text otherwise', () => {
    expect(t('error.MISSING_ROLE_ACCOUNT.ieps', { role: 'ieps_due', event: 'unapply' }, 'en')).toContain(
      'parked IEPS that this unapply causes (LIEPS art. 10)'
    );
    expect(t('error.MISSING_ROLE_ACCOUNT.ieps', { role: 'ieps_due', event: 'unapply' }, 'es')).toContain(
      'aparcó IEPS que se causa con esta desaplicación (LIEPS art. 10)'
    );
    expect(t('error.MISSING_ROLE_ACCOUNT.ieps', { role: 'ieps_due', event: 'cheque CH-1 cashed 2026-05-04' }, 'en')).toContain(
      'parked IEPS that this cheque CH-1 cashed 2026-05-04 causes'
    );
  });
});

describe('MNE-001-627 · the sites throw by key', () => {
  it('an unknown --stop-at step: the code, the English message, the Spanish when rendered', async () => {
    const { conductClose, CLOSING_STEPS } = await import('../../../src/services/accounting/closing-conductor.js');
    const err = await conductClose(
      { tenantId: 't-1', entityId: 'e-1' } as unknown as AgentContext,
      { id: 'p-1', period_name: '2026-03' } as unknown as Parameters<typeof conductClose>[1],
      { userId: 'u-1', stopAt: 'sweep' } as unknown as Parameters<typeof conductClose>[2]
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect(err).toMatchObject({
      code: 'UNKNOWN_CLOSING_STEP',
      messageKey: { key: 'error.UNKNOWN_CLOSING_STEP', params: { step: 'sweep', steps: CLOSING_STEPS.join(', ') } },
      message: `Unknown step "sweep". The steps are: ${CLOSING_STEPS.join(', ')}.`,
    });
    expect((err as AccountingError).localized('es')).toBe(`Paso desconocido "sweep". Los pasos son: ${CLOSING_STEPS.join(', ')}.`);
  });

  it('a correction-period policy with an unknown value: the policy and the value travel as params', async () => {
    const { correctionPeriodOf } = await import('../../../src/services/accounting/vat-overcredit.js');
    const err = await correctionPeriodOf([{ tenantId: 't-1', entityId: 'e-1' }], 'some_policy', () =>
      Promise.resolve({ value: 'x' })
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'POLICY_VALUE_UNKNOWN',
      messageKey: {
        key: 'error.POLICY_VALUE_UNKNOWN',
        params: { policy: 'some_policy', value: 'x', known: 'ask | current_period | payment_month' },
      },
      message: 'some_policy = "x" is not a value this system knows (ask | current_period | payment_month); nothing was posted.',
    });
    expect((err as AccountingError).localized('es')).toBe(
      'some_policy = "x" no es un valor que este sistema conozca (ask | current_period | payment_month); no se aplicó nada.'
    );
  });
});
