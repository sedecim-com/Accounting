/**
 * MNE-001-728 (#151), I9 by folder, part 5: the refusals of
 * src/services/xml-ingestion that reached the requester in Spanish prose are
 * catalogue keys now. The Spanish twin must print, byte for byte, what each
 * site printed before (the strings below are written by hand from those sites,
 * with synthetic values), and the English is the source the error's `message`
 * is fixed in. A refusal that a service turns into a stored string keeps the
 * Spanish it stored before (`reasonText`), and the review reason of a REP is
 * Spanish whatever the active language.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
  getPolicyNumber: vi.fn(),
}));
vi.mock('../../../src/services/payments/payment-service.js', () => ({
  recordVendorPayment: vi.fn(),
  recordCustomerPayment: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { recordVendorPayment } from '../../../src/services/payments/payment-service.js';
import { resetLanguage, setLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AccountingError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';
import {
  PROVEEDOR_NUEVO_SIN_AUTORIZAR,
  ProveedorNuevoSinAutorizar,
  reasonText,
} from '../../../src/services/xml-ingestion/pre-registration-service.js';
import { planContabilizable, type PlanDeAsiento } from '../../../src/services/xml-ingestion/cfdi-posting-plan.js';
import { getClassificationTrail, listCfdis } from '../../../src/services/xml-ingestion/cfdi-query-service.js';
import { ligarPagoREP } from '../../../src/services/xml-ingestion/rep-linkage.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;
const mockRecordVendorPayment = recordVendorPayment as unknown as Mock;

type Case = readonly [TranslationKey, MessageParams, string];

const SEED = 'Siembra la contabilidad con: mnemosine init --section identity';
const SEED_EN = 'Seed the books with: mnemosine init --section identity';

const SPANISH_AS_BEFORE: readonly Case[] = [
  ['error.PROVEEDOR_NUEVO_SIN_AUTORIZAR', { name: 'Proveedor Ejemplo', rfc: 'AAA010101AAA' },
    'El CFDI lo emite "Proveedor Ejemplo" (RFC AAA010101AAA), que no existe en el catálogo de proveedores de ' +
      'esta entidad. Contabilizarlo aquí daría de alta la contraparte con el nombre y el RFC que ' +
      'trae el XML —dato maestro escrito por un tercero, sin que ninguna persona lo apruebe— y ' +
      'acto seguido reconocería el pasivo en el mayor. Dos salidas: da de alta al proveedor tú, ' +
      'con `mnemosine vendor create --tax-id AAA010101AAA`, y vuelve a ejecutar (el pre-registro lo ' +
      'encontrará por RFC); o repite la orden con --allow-new-vendor si aceptas crearlo tal como ' +
      'viene en el comprobante.'],
  ['error.AP_ACCOUNT_MISSING', {}, `La entidad no tiene cuenta para el rol "cxp" (proveedores). ${SEED}`],
  ['error.MISSING_ROLE_ACCOUNT.seed_identity', { role: 'iva_pendiente_acreditar' },
    `La entidad no tiene cuenta para el rol "iva_pendiente_acreditar". ${SEED}`],
  ['error.REP_SIN_XML', {}, 'No se conserva el XML del comprobante de pago.'],
  ['error.ENTITY_NOT_FOUND.pre_registration', {}, 'La entidad del pre-registro no existe.'],
  ['error.REP_SIN_PAGOS', {}, 'El comprobante es de tipo P pero no trae complemento de pagos: no hay nada que ligar.'],
  ['error.CFDI_REQUIERE_DECISION.not_a_party', { issuer: 'AAA010101AAA', receiver: 'BBB020202BBB', entity: 'CCC030303CCC' },
    'El comprobante es de AAA010101AAA para BBB020202BBB y la entidad es CCC030303CCC: no es parte de la ' +
      'operación. Revisa si se subió a la entidad equivocada.'],
  ['error.CFDI_REQUIERE_DECISION.missing_accounts', { missing: 'iva_pendiente_acreditar (1135), cxp' },
    `La entidad no tiene cuenta para: iva_pendiente_acreditar (1135), cxp. ${SEED}`],
  ['error.CFDI_REQUIERE_DECISION.unbalanced', { debits: '116.00', credits: '100.00' },
    'El asiento propuesto no cuadra: cargos 116.00 vs abonos 100.00.'],
  ['error.VALIDATION_ERROR.cfdi.direction', { direction: 'enviado' },
    '--direction ilegible "enviado": emitido, recibido o ajeno.'],
  ['error.RESOURCE_NOT_FOUND.classification_trail', { uuid: 'a1b2c3d4-0000-4000-8000-000000000001' },
    'Clasificación with id a1b2c3d4-0000-4000-8000-000000000001 (el rastro existe para lo ingerido desde F02; ' +
      'lo anterior se clasificó y se tiró) not found'],
];

const ENGLISH: readonly Case[] = [
  ['error.PROVEEDOR_NUEVO_SIN_AUTORIZAR', { name: 'Proveedor Ejemplo', rfc: 'AAA010101AAA' },
    'The CFDI is issued by "Proveedor Ejemplo" (RFC AAA010101AAA), who is not in this entity\'s vendor catalog. ' +
      'Posting it here would register the counterparty with the name and RFC the XML carries (master data ' +
      'written by a third party, approved by no one) and then recognize the liability in the ledger. Two ways ' +
      'out: register the vendor yourself with `mnemosine vendor create --tax-id AAA010101AAA` and run again ' +
      '(the pre-registration will find it by RFC); or repeat the command with --allow-new-vendor if you accept ' +
      'creating it as the receipt states it.'],
  ['error.AP_ACCOUNT_MISSING', {}, `The entity has no account for the role "cxp" (vendors). ${SEED_EN}`],
  ['error.MISSING_ROLE_ACCOUNT.seed_identity', { role: 'iva_pendiente_acreditar' },
    `The entity has no account for the role "iva_pendiente_acreditar". ${SEED_EN}`],
  ['error.REP_SIN_XML', {}, 'The XML of the payment receipt is not kept.'],
  ['error.ENTITY_NOT_FOUND.pre_registration', {}, "The pre-registration's entity does not exist."],
  ['error.REP_SIN_PAGOS', {}, 'The receipt is of type P but carries no payments complement: there is nothing to link.'],
  ['error.CFDI_REQUIERE_DECISION.not_a_party', { issuer: 'AAA010101AAA', receiver: 'BBB020202BBB', entity: 'CCC030303CCC' },
    'The receipt is from AAA010101AAA to BBB020202BBB and the entity is CCC030303CCC: it is not a party to the ' +
      'transaction. Check whether it was uploaded to the wrong entity.'],
  ['error.CFDI_REQUIERE_DECISION.missing_accounts', { missing: 'iva_pendiente_acreditar (1135), cxp' },
    `The entity has no account for: iva_pendiente_acreditar (1135), cxp. ${SEED_EN}`],
  ['error.CFDI_REQUIERE_DECISION.unbalanced', { debits: '116.00', credits: '100.00' },
    'The proposed entry does not balance: debits 116.00 vs credits 100.00.'],
  ['error.VALIDATION_ERROR.cfdi.direction', { direction: 'enviado' },
    'Unreadable --direction "enviado": the values are emitido, recibido and ajeno.'],
  ['error.RESOURCE_NOT_FOUND.classification_trail', { uuid: 'a1b2c3d4-0000-4000-8000-000000000001' },
    'Classification with id a1b2c3d4-0000-4000-8000-000000000001 not found (the trail exists for what was ' +
      'ingested since F02; earlier CFDIs were classified and their trail discarded)'],
];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockPolicy.mockReset();
  mockRecordVendorPayment.mockReset();
});

afterEach(() => {
  resetLanguage();
});

describe('each key renders what its site printed', () => {
  it.each(SPANISH_AS_BEFORE)('%s in es is the Spanish of before', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it.each(ENGLISH)('%s in en', (key, params, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });

  it('the two unknown policy values of the approval reuse POLICY_VALUE_UNKNOWN, whose English is theirs', () => {
    expect(t('error.POLICY_VALUE_UNKNOWN', { policy: 'lineas_factura_desde', value: 'x', known: 'poliza | conceptos_cfdi' }, 'en'))
      .toBe('lineas_factura_desde = "x" is not a value this system knows (poliza | conceptos_cfdi); nothing was posted.');
    expect(t('error.POLICY_VALUE_UNKNOWN', { policy: 'proveedor_desconocido_al_aprobar', value: 'x', known: 'rechazar | preguntar' }, 'en'))
      .toBe('proveedor_desconocido_al_aprobar = "x" is not a value this system knows (rechazar | preguntar); nothing was posted.');
  });
});

describe('the sites throw the key, with the code they always had', () => {
  it('an unregistered vendor: PROVEEDOR_NUEVO_SIN_AUTORIZAR, a 422, the English message and the suggested vendor', () => {
    const err = new ProveedorNuevoSinAutorizar('Proveedor Ejemplo', 'AAA010101AAA');
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: PROVEEDOR_NUEVO_SIN_AUTORIZAR,
      statusCode: 422,
      field: 'vendor_id',
      details: { suggested_vendor: { company_name: 'Proveedor Ejemplo', tax_id: 'AAA010101AAA' } },
      messageKey: { key: 'error.PROVEEDOR_NUEVO_SIN_AUTORIZAR', params: { name: 'Proveedor Ejemplo', rfc: 'AAA010101AAA' } },
    });
    expect(err.message).toBe(ENGLISH[0][2]);
    expect(err.localized('es')).toBe(SPANISH_AS_BEFORE[0][2]);
  });

  const plan = (over: Partial<PlanDeAsiento>): PlanDeAsiento =>
    ({
      clasificacion: { verdict: 'ready', reason: 'PUE purchase' },
      lineas: [],
      cuentasFaltantes: [],
      desglose: 'sin_gasto',
      avisos: [],
      ...over,
    }) as unknown as PlanDeAsiento;

  it('planContabilizable names the missing accounts by key', () => {
    const verdict = planContabilizable(plan({
      cuentasFaltantes: [{ role: 'iva_pendiente_acreditar', code: '1135' }, { role: 'cxp', code: null }],
    }));
    expect(verdict).toEqual({
      ok: false,
      motivo: { key: 'error.CFDI_REQUIERE_DECISION.missing_accounts', params: { missing: 'iva_pendiente_acreditar (1135), cxp' } },
    });
  });

  it('planContabilizable names an unbalanced entry by key', () => {
    const verdict = planContabilizable(plan({
      lineas: [
        { account_id: 'a', debit_amount: '116.0000', credit_amount: null, description: 'x' },
        { account_id: 'b', debit_amount: null, credit_amount: '100.0000', description: 'x' },
      ],
    }));
    expect(verdict).toEqual({
      ok: false,
      motivo: { key: 'error.CFDI_REQUIERE_DECISION.unbalanced', params: { debits: '116.00', credits: '100.00' } },
    });
  });

  it('a ready, balanced plan keeps the classifier reason as text', () => {
    expect(planContabilizable(plan({}))).toEqual({ ok: true, motivo: 'PUE purchase' });
  });

  it('listCfdis refuses an unreadable --direction by key, before any query', async () => {
    const err = await listCfdis('ent-1', { direction: 'enviado' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', messageKey: { key: 'error.VALIDATION_ERROR.cfdi.direction', params: { direction: 'enviado' } } });
    expect((err as ValidationError).localized('es')).toBe('--direction ilegible "enviado": emitido, recibido o ajeno.');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a missing classification trail is a keyed 404 that is still a NotFoundError', async () => {
    const uuid = 'a1b2c3d4-0000-4000-8000-000000000001';
    const err = await getClassificationTrail('ent-1', uuid).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ statusCode: 404, code: 'RESOURCE_NOT_FOUND', messageKey: { key: 'error.RESOURCE_NOT_FOUND.classification_trail', params: { uuid } } });
    expect((err as NotFoundError).localized('es')).toBe(SPANISH_AS_BEFORE[10][2]);
    expect((err as NotFoundError).message).toBe(ENGLISH[10][2]);
  });
});

describe('reasonText: what a service stores or passes on keeps the language it had', () => {
  it('a key of this block is Spanish, as the stored reason was', () => {
    const err = new AccountingError('REP_SIN_XML', { key: 'error.REP_SIN_XML' });
    expect(err.message).toBe('The XML of the payment receipt is not kept.');
    expect(reasonText(err)).toBe('No se conserva el XML del comprobante de pago.');
    expect(reasonText(new ProveedorNuevoSinAutorizar('Proveedor Ejemplo', 'AAA010101AAA'))).toBe(SPANISH_AS_BEFORE[0][2]);
  });

  it('prose, and a key of another folder, keep their message', () => {
    expect(reasonText(new AccountingError('CFDI_REQUIERE_DECISION', 'OJO: texto tal cual'))).toBe('OJO: texto tal cual');
    expect(reasonText(new AccountingError('ENTRY_NOT_FOUND', { key: 'error.ENTRY_NOT_FOUND' }))).toBe('Journal entry not found');
    expect(reasonText(new Error('plain'))).toBe('plain');
  });
});

describe('the review reason of a REP is one language', () => {
  it('a keyed payment refusal inside it is Spanish under an English session', async () => {
    setLanguage('en');
    mockPolicy.mockImplementation(async (_ctx: unknown, key: string) => ({
      value: ({ rep_tolerancia_importe: '0.01', rep_ventana_dias: '3', rep_pago_no_registrado: 'crear_pago' } as Record<string, string>)[key] ?? '',
    }));
    mockQuery.mockImplementation(async (sql: string) =>
      /JOIN bills b/.test(sql)
        ? { rows: [{ id: 'bill-1', vendor_id: 'vendor-1', currency_code: 'MXN', tax_amount: '16.00', total_amount: '116.00' }] }
        : { rows: [] }
    );
    mockRecordVendorPayment.mockRejectedValue(new ValidationError({ key: 'error.VALIDATION_ERROR.payment.no_application' }));

    const r = await ligarPagoREP({
      tenantId: 'ten-1', entityId: 'ent-1', userId: 'usr-1', cfdiUuid: 'a1b2c3d4-0000-4000-8000-000000000002',
      direction: 'recibido', indice: 0, fechaCfdi: new Date('2026-08-10'), monedaFuncional: 'MXN',
      pago: { monto: 116, docsRelacionados: [{ uuid: 'a1b2c3d4-0000-4000-8000-000000000003', impPagado: 116 }] } as never,
    });

    expect(r.accion).toBe('revision');
    expect(r.motivo).toBe(
      'El comprobante no se pudo registrar como pago: ' +
        'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.'
    );
  });
});

