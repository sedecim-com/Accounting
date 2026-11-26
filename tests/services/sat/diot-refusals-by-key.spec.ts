/**
 * MNE-001-726 (#151), I9 by folder, part 3: the refusals of the DIOT
 * (src/services/sat/diot) that reached the requester in Spanish prose are
 * catalogue keys now. The Spanish twin must print, byte for byte, what each
 * site printed before (the strings below are written by hand from those sites,
 * with synthetic values), and the English is the source the error's `message`
 * is fixed in. The refusals of the SAT batch file are a list inside one
 * error: each item renders in the reader's language too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/accounting/iva-cash-basis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/accounting/iva-cash-basis.js')>()),
  entityUsesCashBasisIva: vi.fn(),
}));

import type pg from 'pg';
import { entityUsesCashBasisIva } from '../../../src/services/accounting/iva-cash-basis.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ValidationError } from '../../../src/utils/errors.js';
import { construirDiot } from '../../../src/services/sat/diot/diot-service.js';
import {
  DiotFormatoNoFundamentado,
  DiotNoEntregable,
  SERIALIZADOR_SAT,
} from '../../../src/services/sat/diot/serializador.js';
import { serializeSatBatch } from '../../../src/services/sat/diot/sat-batch.js';
import { desgloseCero } from '../../../src/services/sat/diot/desglose.js';
import type { DiotConstruida, RenglonDiot } from '../../../src/services/sat/diot/modelo.js';
import { serviceUserStrings } from '../../../scripts/language/lanes/service-strings.js';
import fs from 'node:fs';
import path from 'node:path';

type Case = readonly [TranslationKey, MessageParams, string];

const WHO = 'Papelería del Centro (ABC010101AA1)';
const URL = 'https://www.sat.gob.mx/instructivo-de-prueba';
const B = 'error.DIOT_NO_ENTREGABLE.sat_batch';

const SPANISH_AS_BEFORE: readonly Case[] = [
  ['error.VALIDATION_ERROR.diot.entity_not_mexican', { name: 'Ejemplo SA', country: 'US' },
    'La entidad Ejemplo SA no es mexicana (país US). La DIOT es una obligación de la LIVA: no hay declaración ' +
      'informativa de operaciones con terceros que armar para una entidad que no causa IVA.'],
  ['error.VALIDATION_ERROR.diot.entity_without_rfc', { name: 'Ejemplo SA' },
    'La entidad Ejemplo SA no tiene RFC en el expediente y la DIOT se presenta a nombre de un contribuyente identificado.'],
  ['error.VALIDATION_ERROR.diot.month', { month: '13' },
    'El mes de la DIOT es 13. La declaración es mensual y no tiene mes 13: la balanza de cierre del Anexo 24 sí, ésta no.'],
  ['error.DIOT_FORMATO_NO_FUNDAMENTADO', { period: '12/2024', url: URL, consulted: '2026-09-29' },
    'La DIOT de 12/2024 se presenta con el layout del ejercicio 2024 y anteriores, que este repositorio no ' +
      `implementa: sólo está fundamentado el de 2025 en adelante (${URL}, consultado el 2026-09-29). No se ` +
      'escribe con la forma nueva un periodo que la autoridad valida con la vieja.'],
  ['error.DIOT_NO_ENTREGABLE.no_third_parties', { period: '11/2026' },
    'La DIOT de 11/2026 no tiene terceros que declarar: un archivo de lote vacío no es una declaración, y no se escribe.'],
  [B, { period: '04/2026', refusals: 'uno\n  · dos' },
    'La DIOT de 04/2026 no cabe en el layout del SAT tal cual:\n  · uno\n  · dos'],
  [`${B}.operation`, { who: WHO, partyType: '04', operation: '03', allowed: '02, 03, 06, 07, 08, 85, 87' },
    `${WHO}: tipo de tercero 04 con tipo de operación 03, que el layout 2025 no admite (§3.1: 02, 03, 06, 07, 08, 85, 87).`],
  [`${B}.country`, { who: WHO, country: 'US' },
    `${WHO}: el país "US" no es una clave de tres letras del catálogo de países del layout (§5, p. ej. USA; ` +
      'ZZZ para otro). Corrige el país de residencia del proveedor.'],
  [`${B}.country_other`, { who: WHO },
    `${WHO}: país ZZZ (Otro) exige especificar la jurisdicción, y el expediente no la tiene.`],
  [`${B}.too_long`, { who: WHO },
    `${WHO}: la identificación fiscal pasa de 40 caracteres o el nombre de 300 (§3.1).`],
  [`${B}.too_wide`, { who: WHO, amount: '123456789012345.0000', digits: 14 },
    `${WHO}: el importe 123456789012345.0000 no cabe en un campo numérico de 14 posiciones.`],
  [`${B}.iva_without_acts`, { who: WHO, iva: '16.0000', ivaField: 22, valueField: 12 },
    `${WHO}: tiene IVA de 16.0000 (campo 22) sin un valor de los actos mayor a cero en el campo 12, y el ` +
      'layout sólo admite el IVA cuando lo hay (§3.3).'],
  [`${B}.border_rate`, { who: WHO },
    `${WHO}: tiene actos a la tasa del 8 %, y el layout los separa en región fronteriza NORTE (campos 8 y 18) ` +
      'y SUR (10 y 20). El expediente no dice en cuál está el proveedor.'],
  [`${B}.unnamed_rates`, { who: WHO, rates: '11.00, 4.00' },
    `${WHO}: tiene importes a tasas que el layout no nombra (11.00, 4.00).`],
  [`${B}.foreign_zero_rate`, { who: WHO, base: '300.0000' },
    `${WHO}: tiene actos a tasa 0 % (300.0000) de un proveedor extranjero. El campo 51 es para actos ` +
      'nacionales a tasa 0 %; lo de un extranjero va en el 53 (no objeto, sin establecimiento en México), en ' +
      'importación de servicios (IVA autodeterminado) o en el 49 (importación exenta), según la operación. ' +
      'Captúralo en el portal.'],
  [`${B}.negative_net`, { who: WHO, fields: 'campo 12: -5.0000', anyUndone: 'yes', undone: 'BILL-1, BILL-2' },
    `${WHO}: el neto del mes es negativo (campo 12: -5.0000): lo que el mes deshizo o devolvió supera a lo que ` +
      'pagó. Gastos de un pago desaplicado o reversado en el mes: BILL-1, BILL-2. El layout no admite importes ' +
      'negativos y declara las devoluciones, descuentos y bonificaciones en sus propios campos de §3.2, que este ' +
      'archivo todavía no llena; captúralo en el portal.'],
  [`${B}.negative_net`, { who: WHO, fields: 'campo 12: -5.0000', anyUndone: 'no', undone: '' },
    `${WHO}: el neto del mes es negativo (campo 12: -5.0000): lo que el mes deshizo o devolvió supera a lo que ` +
      'pagó. Gastos de un pago desaplicado o reversado en el mes: ninguno. El layout no admite importes ' +
      'negativos y declara las devoluciones, descuentos y bonificaciones en sus propios campos de §3.2, que este ' +
      'archivo todavía no llena; captúralo en el portal.'],
  [`${B}.negative_net.field`, { field: 12, amount: '-5.0000' }, 'campo 12: -5.0000'],
  [`${B}.proportion`, { proportion: 'block' },
    'La política diot_creditable_iva_proportion vale "block": la entidad aplica la proporción del art. 5 frac. V ' +
      'LIVA, que este sistema todavía no calcula. El IVA acreditable se reparte a mano en el portal.'],
] as Case[];

const ENGLISH: readonly Case[] = [
  ['error.VALIDATION_ERROR.diot.entity_not_mexican', { name: 'Ejemplo SA', country: 'US' },
    'The entity Ejemplo SA is not Mexican (country US). The DIOT is an obligation under the LIVA: there is no ' +
      'informative return of operations with third parties to build for an entity that does not cause IVA.'],
  ['error.VALIDATION_ERROR.diot.entity_without_rfc', { name: 'Ejemplo SA' },
    'The entity Ejemplo SA has no RFC on file, and the DIOT is filed in the name of an identified taxpayer.'],
  ['error.VALIDATION_ERROR.diot.month', { month: '13' },
    'The month of the DIOT is 13. The return is monthly and has no month 13: the year-end trial balance of ' +
      'Anexo 24 does, this one does not.'],
  ['error.DIOT_FORMATO_NO_FUNDAMENTADO', { period: '12/2024', url: URL, consulted: '2026-09-29' },
    'The DIOT of 12/2024 is filed with the layout of fiscal year 2024 and earlier, which this repository does ' +
      `not implement: only the one for 2025 onward is grounded (${URL}, consulted on 2026-09-29). A period the ` +
      'authority validates with the old shape is not written in the new one.'],
  ['error.DIOT_NO_ENTREGABLE.no_third_parties', { period: '11/2026' },
    'The DIOT of 11/2026 has no third parties to declare: an empty batch file is not a return, and it is not written.'],
  [B, { period: '04/2026', refusals: 'one\n  · two' },
    'The DIOT of 04/2026 does not fit the SAT layout as it stands:\n  · one\n  · two'],
  [`${B}.operation`, { who: WHO, partyType: '04', operation: '03', allowed: '02, 03, 06, 07, 08, 85, 87' },
    `${WHO}: third-party type 04 with operation type 03, which the 2025 layout does not accept (§3.1: 02, 03, 06, 07, 08, 85, 87).`],
  [`${B}.country`, { who: WHO, country: 'US' },
    `${WHO}: the country "US" is not a three-letter key of the layout's country catalogue (§5, e.g. USA; ZZZ ` +
      'for other). Correct the vendor\'s country of residence.'],
  [`${B}.country_other`, { who: WHO },
    `${WHO}: country ZZZ (Otro) requires the jurisdiction to be specified, and the record does not have it.`],
  [`${B}.too_long`, { who: WHO },
    `${WHO}: the tax identification exceeds 40 characters or the name 300 (§3.1).`],
  [`${B}.too_wide`, { who: WHO, amount: '123456789012345.0000', digits: 14 },
    `${WHO}: the amount 123456789012345.0000 does not fit in a numeric field of 14 positions.`],
  [`${B}.iva_without_acts`, { who: WHO, iva: '16.0000', ivaField: 22, valueField: 12 },
    `${WHO}: it has IVA of 16.0000 (field 22) with no value of acts above zero in field 12, and the layout ` +
      'only accepts the IVA when there is one (§3.3).'],
  [`${B}.border_rate`, { who: WHO },
    `${WHO}: it has acts at the 8 % rate, and the layout splits them into the NORTHERN border region (fields 8 ` +
      'and 18) and the SOUTHERN one (10 and 20). The record does not say which one the vendor is in.'],
  [`${B}.unnamed_rates`, { who: WHO, rates: '11.00, 4.00' },
    `${WHO}: it has amounts at rates the layout does not name (11.00, 4.00).`],
  [`${B}.foreign_zero_rate`, { who: WHO, base: '300.0000' },
    `${WHO}: it has 0 % acts (300.0000) from a foreign vendor. Field 51 is for domestic 0 % acts; a foreign ` +
      'vendor\'s go in field 53 (not subject, no establishment in Mexico), in the import of services ' +
      '(self-assessed IVA) or in field 49 (exempt import), depending on the operation. Capture it in the portal.'],
  [`${B}.negative_net`, { who: WHO, fields: 'field 12: -5.0000', anyUndone: 'yes', undone: 'BILL-1, BILL-2' },
    `${WHO}: the month's net is negative (field 12: -5.0000): what the month undid or returned exceeds what it ` +
      'paid. Bills of a payment unapplied or reversed in the month: BILL-1, BILL-2. The layout accepts no ' +
      'negative amounts and declares returns, discounts and rebates in its own fields of §3.2, which this file ' +
      'does not fill yet; capture it in the portal.'],
  [`${B}.negative_net`, { who: WHO, fields: 'field 12: -5.0000', anyUndone: 'no', undone: '' },
    `${WHO}: the month's net is negative (field 12: -5.0000): what the month undid or returned exceeds what it ` +
      'paid. Bills of a payment unapplied or reversed in the month: none. The layout accepts no negative ' +
      'amounts and declares returns, discounts and rebates in its own fields of §3.2, which this file does not ' +
      'fill yet; capture it in the portal.'],
  [`${B}.negative_net.field`, { field: 12, amount: '-5.0000' }, 'field 12: -5.0000'],
  [`${B}.proportion`, { proportion: 'block' },
    'The policy diot_creditable_iva_proportion is set to "block": the entity applies the proportion of LIVA ' +
      'art. 5 frac. V, which this system does not compute yet. The creditable IVA is allocated by hand in the portal.'],
] as Case[];

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
});

// ------------------------------------------------------------
// The SAT serializer: a period without a grounded layout, an empty month, and
// the list of every third party the layout cannot express.
// ------------------------------------------------------------

const origin = { tipoTercero: 'declarado', tipoOperacion: 'declarado' } as const;

const national = (): RenglonDiot => {
  const breakdown = desgloseCero();
  breakdown.tasa16 = { base: '1000.0000', iva: '160.0000' };
  return {
    tercero: { vendorId: 'v1', nombre: 'Papelería del Centro', tipoTercero: '04', tipoOperacion: '85', rfc: 'ABC010101AA1', procedencia: origin },
    desglose: breakdown,
    ivaRetenido: '0.0000',
    documentos: [],
  };
};

const diot = (rows: RenglonDiot[] = [national()]): DiotConstruida => ({
  periodo: { anio: 2026, mes: 4, desde: '2026-04-01', hasta: '2026-04-30' },
  rfc: 'AAA010101AA1',
  razonSocial: 'Contribuyente de prueba',
  renglones: rows,
  totales: { desglose: desgloseCero(), ivaRetenido: '0.0000', ivaAcreditablePagado: '160.0000', terceros: rows.length, documentos: 0 },
  politicas: [{ clave: 'diot_creditable_iva_proportion', valor: 'taxed_only', definida: false }],
  hallazgos: [],
});

const thrown = (d: DiotConstruida): AppError => {
  try {
    SERIALIZADOR_SAT.serializar(d);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  return expect.unreachable('the serializer had to refuse');
};

describe('the SAT serializer refuses by key, with the codes it always had', () => {
  it('a period before the first grounded layout is a keyed 501', () => {
    const d = diot();
    d.periodo = { anio: 2024, mes: 12, desde: '2024-12-01', hasta: '2024-12-31' };
    const err = thrown(d);
    expect(err).toBeInstanceOf(DiotFormatoNoFundamentado);
    expect(err).toMatchObject({
      statusCode: 501,
      code: 'DIOT_FORMATO_NO_FUNDAMENTADO',
      messageKey: { key: 'error.DIOT_FORMATO_NO_FUNDAMENTADO', params: { period: '12/2024', consulted: '2026-09-29' } },
      details: { primer_ejercicio: 2025 },
    });
    expect(err.message).toMatch(/^The DIOT of 12\/2024 is filed with the layout of fiscal year 2024 and earlier/);
    expect(err.localized('es')).toMatch(/^La DIOT de 12\/2024 se presenta con el layout del ejercicio 2024 y anteriores/);
  });

  it('a month with no third parties is a keyed 422', () => {
    const err = thrown(diot([]));
    expect(err).toBeInstanceOf(DiotNoEntregable);
    expect(err).toMatchObject({ statusCode: 422, code: 'DIOT_NO_ENTREGABLE', details: { terceros: 0 } });
    expect(err.message).toBe(
      'The DIOT of 04/2026 has no third parties to declare: an empty batch file is not a return, and it is not written.'
    );
    expect(err.localized('es')).toBe(
      'La DIOT de 04/2026 no tiene terceros que declarar: un archivo de lote vacío no es una declaración, y no se escribe.'
    );
  });

  it('every refusal of the layout renders in the reader\'s language, the list included', () => {
    const border = national();
    border.desglose.tasa8 = { base: '100.0000', iva: '8.0000' };
    const negative = national();
    negative.tercero = { ...negative.tercero, vendorId: 'v2', nombre: 'Fletes del Norte', rfc: 'FNO010101AA1' };
    negative.desglose = { ...desgloseCero(), tasa16: { base: '-1000.0000', iva: '-160.0000' } };
    negative.documentos = [{
      billId: 'b1', billNumber: 'BILL-UNDONE', metodo: 'PPD', origenDelMetodo: 'cfdi', ivaPagado: '-160.0000',
      ivaRetenido: '0.0000', desglose: { ...desgloseCero(), tasa16: { base: '-1000.0000', iva: '-160.0000' } },
    }];
    const d = diot([border, negative]);
    d.politicas = [{ clave: 'diot_creditable_iva_proportion', valor: 'block', definida: true }];

    const err = thrown(d);
    expect(err).toBeInstanceOf(DiotNoEntregable);
    expect(err).toMatchObject({
      statusCode: 422,
      code: 'DIOT_NO_ENTREGABLE',
      messageKey: { key: B },
      details: { vendors: ['v1', 'v2'] },
    });
    expect(err.localized('es')).toBe(
      'La DIOT de 04/2026 no cabe en el layout del SAT tal cual:\n' +
        '  · La política diot_creditable_iva_proportion vale "block": la entidad aplica la proporción del art. 5 ' +
        'frac. V LIVA, que este sistema todavía no calcula. El IVA acreditable se reparte a mano en el portal.\n' +
        '  · Papelería del Centro (ABC010101AA1): tiene actos a la tasa del 8 %, y el layout los separa en región ' +
        'fronteriza NORTE (campos 8 y 18) y SUR (10 y 20). El expediente no dice en cuál está el proveedor.\n' +
        '  · Fletes del Norte (FNO010101AA1): el neto del mes es negativo (campo 12: -1000.0000; campo 22: ' +
        '-160.0000): lo que el mes deshizo o devolvió supera a lo que pagó. Gastos de un pago desaplicado o ' +
        'reversado en el mes: BILL-UNDONE. El layout no admite importes negativos y declara las devoluciones, ' +
        'descuentos y bonificaciones en sus propios campos de §3.2, que este archivo todavía no llena; captúralo ' +
        'en el portal.'
    );
    expect(err.message).toBe(
      'The DIOT of 04/2026 does not fit the SAT layout as it stands:\n' +
        '  · The policy diot_creditable_iva_proportion is set to "block": the entity applies the proportion of ' +
        'LIVA art. 5 frac. V, which this system does not compute yet. The creditable IVA is allocated by hand in ' +
        'the portal.\n' +
        '  · Papelería del Centro (ABC010101AA1): it has acts at the 8 % rate, and the layout splits them into the ' +
        'NORTHERN border region (fields 8 and 18) and the SOUTHERN one (10 and 20). The record does not say which ' +
        'one the vendor is in.\n' +
        '  · Fletes del Norte (FNO010101AA1): the month\'s net is negative (field 12: -1000.0000; field 22: ' +
        '-160.0000): what the month undid or returned exceeds what it paid. Bills of a payment unapplied or ' +
        'reversed in the month: BILL-UNDONE. The layout accepts no negative amounts and declares returns, ' +
        'discounts and rebates in its own fields of §3.2, which this file does not fill yet; capture it in the ' +
        'portal.'
    );
    // The envelope's params carry every placeholder, in English, as RequestValidationError's issues do.
    expect(String(err.messageKey?.params?.refusals)).toContain('the 8 % rate');
    expect(err.localized('en')).toBe(err.message);
  });

  it('a refusal of the batch file is a key, never prose', () => {
    const d = diot();
    d.renglones[0].tercero = { ...d.renglones[0].tercero, tipoTercero: '05', idFiscalExtranjero: 'X1', paisResidencia: 'ZZZ' };
    const { refusals } = serializeSatBatch(d, { proportion: 'taxed_only' });
    expect(refusals.map((r) => r.message.key)).toEqual([`${B}.operation`, `${B}.country_other`]);
    expect(refusals[0].message.params).toMatchObject({ who: 'Papelería del Centro (ABC010101AA1)', partyType: '05', operation: '85' });
  });
});

// ------------------------------------------------------------
// construirDiot and its taxpayer
// ------------------------------------------------------------

const clientWith = (row: Record<string, unknown>): pg.PoolClient =>
  ({ query: vi.fn().mockResolvedValue({ rows: [row] }) }) as unknown as pg.PoolClient;

const ENTITY = { tenant_id: 't', name: 'Ejemplo SA', tax_id: null, tax_id_type: null, incorporation_country: 'US' };

describe('construirDiot refuses by key, with the field it always had', () => {
  it('month 13', async () => {
    const err = await construirDiot({ tenantId: 't', entityId: 'e', anio: 2026, mes: 13 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', field: 'mes', messageKey: { key: 'error.VALIDATION_ERROR.diot.month' } });
    expect((err as ValidationError).localized('es')).toBe(SPANISH_AS_BEFORE[2][2]);
    expect((err as ValidationError).message).toBe(ENGLISH[2][2]);
  });

  it('an entity that is not Mexican', async () => {
    vi.mocked(entityUsesCashBasisIva).mockResolvedValue(false);
    const err = await construirDiot({ tenantId: 't', entityId: 'e', anio: 2026, mes: 4, client: clientWith(ENTITY) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', field: 'entity_id' });
    expect((err as ValidationError).localized('es')).toBe(SPANISH_AS_BEFORE[0][2]);
    expect((err as ValidationError).message).toBe(ENGLISH[0][2]);
  });

  it('an entity with no RFC', async () => {
    vi.mocked(entityUsesCashBasisIva).mockResolvedValue(true);
    const err = await construirDiot({ tenantId: 't', entityId: 'e', anio: 2026, mes: 4, client: clientWith(ENTITY) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', field: 'tax_id' });
    expect((err as ValidationError).localized('es')).toBe(SPANISH_AS_BEFORE[1][2]);
    expect((err as ValidationError).message).toBe(ENGLISH[1][2]);
  });
});

// ------------------------------------------------------------
// The list a keyed message carries, and what an error without one keeps.
// ------------------------------------------------------------

describe('a keyed message with lists', () => {
  it('renders each item in the frame\'s language, nested lists included', () => {
    const err = new DiotNoEntregable({
      key: B,
      params: { period: '04/2026' },
      lists: {
        refusals: {
          join: '\n  · ',
          items: [{
            key: `${B}.negative_net`,
            params: { who: WHO, anyUndone: 'no', undone: '' },
            lists: { fields: { join: '; ', items: [{ key: `${B}.negative_net.field`, params: { field: 12, amount: '-5.0000' } }] } },
          }],
        },
      },
    });
    expect(err.localized('es')).toContain('(campo 12: -5.0000): lo que el mes deshizo');
    expect(err.localized('es')).toContain('reversado en el mes: ninguno.');
    expect(err.message).toContain('(field 12: -5.0000): what the month undid');
    expect(err.message).toContain('reversed in the month: none.');
  });

  it('an error written by key without lists keeps its key and its params as given', () => {
    const key = { key: 'error.VALIDATION_ERROR.diot.month', params: { month: '0' } } as const;
    const err = new ValidationError(key, 'mes');
    expect(err.messageKey).toBe(key);
    expect(err.localized('es')).toBe(t('error.VALIDATION_ERROR.diot.month', { month: '0' }, 'es'));
  });
});

describe('the lane', () => {
  it('sat-batch.ts keeps only the SAT instructivo\'s own words', () => {
    const file = 'src/services/sat/diot/sat-batch.ts';
    const code = fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
    expect(serviceUserStrings(code, file).map((h) => h.line).length).toBe(2);
  });
});
