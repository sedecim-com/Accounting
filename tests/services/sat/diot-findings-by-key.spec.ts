/**
 * MNE-001-830 (#151), I9 by folder, part 3b: the findings the DIOT returns in
 * `Hallazgo.mensaje` for a third party and for the return itself
 * (src/services/sat/diot: rfc.ts, tercero.ts, diot-service.ts) are catalogue
 * keys now, rendered at the edge in the reader's language; and the frame of
 * `exigirEntregable` that lists the blocking ones renders keys and prose alike.
 * The Spanish twin must print, byte for byte, what each site printed before
 * (the strings below are written by hand from those sites, with synthetic
 * values), and the English is the source.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { textIn, type KeyedText } from '../../../src/utils/errors.js';
import { clasificarRfc } from '../../../src/services/sat/diot/rfc.js';
import { resolverTercero, type PoliticasDelTercero, type TerceroCrudo } from '../../../src/services/sat/diot/tercero.js';
import { proportionFindings } from '../../../src/services/sat/diot/diot-service.js';
import {
  DiotNoEntregable,
  exigirEntregable,
  PAPEL_DE_TRABAJO,
} from '../../../src/services/sat/diot/serializador.js';
import { desgloseCero } from '../../../src/services/sat/diot/desglose.js';
import type { Hallazgo } from '../../../src/services/sat/diot/hallazgos.js';
import type { DiotConstruida } from '../../../src/services/sat/diot/modelo.js';
import { serviceUserStrings } from '../../../scripts/language/lanes/service-strings.js';

type Case = readonly [TranslationKey, MessageParams, string];

const F = 'diot.finding';
const R = 'diot.rfc_reason';
const NAME = 'Papelería del Centro SA de CV';
const BASE_POLICY = { value: 'inventar', first: 'exigir_base', second: 'derivar_del_subtotal', third: 'omitir_y_avisar' };
const MALFORMED = 'tiene "XXXX" como RFC, que no tiene forma de RFC mexicano (12 caracteres persona moral o 13 persona ' +
  'física: 3 o 4 letras, AAMMDD y homoclave de 3)';

const SPANISH_AS_BEFORE: readonly Case[] = [
  [`${R}.empty`, {}, 'no tiene RFC en el expediente'],
  [`${R}.generic_national`, { rfc: 'XAXX010101000' },
    'tiene el RFC genérico XAXX010101000, que es el del público en general y no identifica a nadie'],
  [`${R}.generic_foreign`, { rfc: 'XEXX010101000' },
    'tiene el RFC genérico XEXX010101000, que es el de los residentes en el extranjero: la DIOT los identifica por ' +
      'su número de identificación fiscal, no por él'],
  [`${R}.malformed`, { rfc: 'XXXX' }, MALFORMED],
  [`${R}.impossible_date`, { rfc: 'ABC261301AA1', date: '26-13-01' },
    'tiene "ABC261301AA1" como RFC, cuya fecha (26-13-01) no existe'],
  [`${R}.valid`, {}, 'RFC con forma válida'],
  [`${F}.operation_type_not_allowed`, { name: NAME, partyType: '04', operation: '07', allowed: '02, 03, 06, 08, 85' },
    `El proveedor ${NAME} es tercero 04 y tiene capturado el tipo de operación 07, que el catálogo 2025 de la DIOT no ` +
      'admite para ese tipo de tercero (§3.1: 02, 03, 06, 08, 85). Corrige el tipo de operación del proveedor.'],
  [`${F}.operation_type_undeclared`, { name: NAME },
    `El proveedor ${NAME} no tiene tipo de operación declarado y la política pide no suponer ninguno. Es un dato del ` +
      'PROVEEDOR, no de la factura: se captura una vez y vale para todos los meses.'],
  [`${F}.policy_out_of_catalogue`, { policy: 'diot_tipo_operacion_por_omision', value: '99', allowed: '85, 02, 03, 06' },
    'La política diot_tipo_operacion_por_omision vale "99", que no es 85, 02, 03, 06. Se prefiere detenerse a ' +
      'inventar una equivalencia: el catálogo lo fija la autoridad.'],
  [`${F}.operation_type_by_default`, { name: NAME, operation: '85', allowed: '02, 03, 06, 08, 85' },
    `El proveedor ${NAME} se declara con tipo de operación 85 por omisión: no lo tiene capturado. Afínalo si su ` +
      'operación es otra de las que admite el catálogo (§3.1: 02, 03, 06, 08, 85).'],
  [`${F}.foreign_incomplete`, { name: NAME, missing: 'país de residencia, nacionalidad' },
    `El proveedor ${NAME} se declara como tercero extranjero (05) y le falta: país de residencia, nacionalidad. El ` +
      'formato pide los tres, y una fila de tipo 05 incompleta la rechaza la autoridad al recibir el archivo, ' +
      'cuando el plazo ya corrió.'],
  [`${F}.foreign_incomplete.tax_id`, {}, 'número de identificación fiscal'],
  [`${F}.foreign_incomplete.country`, {}, 'país de residencia'],
  [`${F}.foreign_incomplete.nationality`, {}, 'nacionalidad'],
  [`${F}.global_with_rfc`, { name: NAME, rfc: 'ABC010101AA1', generic: 'XAXX010101000' },
    `El proveedor ${NAME} está marcado como tercero global (15) y tiene el RFC ABC010101AA1 en el expediente. El 15 ` +
      'declara operaciones sin contraparte identificable: se declara con el genérico XAXX010101000 y su RFC real no ' +
      'viaja. Revisa si el tipo de tercero es el correcto.'],
  [`${F}.no_rfc_declared_global`, { name: NAME, reason: 'no tiene RFC en el expediente', generic: 'XAXX010101000' },
    `El proveedor ${NAME} no tiene RFC en el expediente, y por política se declara como tercero global (15) con el ` +
      'genérico XAXX010101000. La declaración dirá que esas compras no tuvieron contraparte identificable, y la ' +
      'autoridad lo cruza contra lo que ese proveedor declaró por su lado.'],
  [`${F}.no_rfc`, { name: NAME, reason: 'no tiene RFC en el expediente' },
    `El proveedor ${NAME} no tiene RFC en el expediente. Sin RFC que lo identifique no se puede declarar como tercero ` +
      'nacional, y el tipo 15 es para el público en general, no un cajón para proveedores cuyo RFC nadie capturó.'],
  [`${F}.exempt_revenue_without_proportion`, { exemptRevenue: '1500.00', groupingCodes: '401.07, 401.08, 401.09' },
    'El mayor registra 1500.00 de ingresos exentos en el ejercicio (cuentas con agrupador 401.07, 401.08, 401.09), y ' +
      'la política diot_creditable_iva_proportion declara todo el IVA como de actividades exclusivamente gravadas. Con ' +
      'actividades exentas el IVA acreditable sigue la proporción del art. 5 frac. V LIVA: contesta la política con ' +
      '"block" y reparte el IVA en el portal.'],
  [`${F}.proportion_by_default`, {},
    'Todo el IVA acreditable se declara como de actividades exclusivamente gravadas porque la política ' +
      'diot_creditable_iva_proportion no está contestada. Confírmala si la entidad no tiene actividades exentas.'],
  [`${F}.exempt_base_policy_out_of_catalogue`, BASE_POLICY,
    'La política diot_iva_exento_y_base vale "inventar", que no es exigir_base, derivar_del_subtotal ni omitir_y_avisar.'],
  [`${F}.bill_without_lines`, { billNumber: 'BILL-0007' },
    'El gasto BILL-0007 no tiene renglones guardados, así que su IVA no se puede desglosar por tasa. La DIOT declara ' +
      'por tasa, no un total.'],
  [`${F}.vendor_of_another_entity`, { bills: 'BILL-0001, BILL-0002', vendorId: 'v-ajeno' },
    'Los gastos BILL-0001, BILL-0002 apuntan al proveedor v-ajeno, que no pertenece a esta entidad.'],
  ['error.DIOT_NO_ENTREGABLE.blocking_findings', { period: '04/2026', count: 2, findings: 'uno\n  · dos' },
    'La DIOT de 04/2026 tiene 2 problema(s) que impiden entregarla:\n  · uno\n  · dos'],
  ['error.DIOT_NO_ENTREGABLE.blocking_findings.item', { code: 'DIOT-SIN-RFC', text: 'Proveedor A' },
    '[DIOT-SIN-RFC] Proveedor A'],
] as Case[];

const ENGLISH: readonly Case[] = [
  [`${R}.empty`, {}, 'has no RFC on file'],
  [`${R}.generic_national`, { rfc: 'XAXX010101000' },
    'has the generic RFC XAXX010101000, which is the one of the general public and identifies no one'],
  [`${R}.generic_foreign`, { rfc: 'XEXX010101000' },
    'has the generic RFC XEXX010101000, which is the one of residents abroad: the DIOT identifies them by their tax ' +
      'identification number, not by it'],
  [`${R}.malformed`, { rfc: 'XXXX' },
    'has "XXXX" as its RFC, which does not have the shape of a Mexican RFC (12 characters for a legal person or 13 ' +
      'for an individual: 3 or 4 letters, YYMMDD and a homoclave of 3)'],
  [`${R}.impossible_date`, { rfc: 'ABC261301AA1', date: '26-13-01' },
    'has "ABC261301AA1" as its RFC, whose date (26-13-01) does not exist'],
  [`${R}.valid`, {}, 'RFC with a valid shape'],
  [`${F}.operation_type_not_allowed`, { name: NAME, partyType: '04', operation: '07', allowed: '02, 03, 06, 08, 85' },
    `The vendor ${NAME} is third-party type 04 and has operation type 07 on file, which the 2025 DIOT catalogue does ` +
      'not accept for that type of third party (§3.1: 02, 03, 06, 08, 85). Correct the vendor\'s operation type.'],
  [`${F}.operation_type_undeclared`, { name: NAME },
    `The vendor ${NAME} has no declared operation type and the policy asks not to assume one. It is a datum of the ` +
      'VENDOR, not of the invoice: it is captured once and holds for every month.'],
  [`${F}.policy_out_of_catalogue`, { policy: 'diot_tipo_operacion_por_omision', value: '99', allowed: '85, 02, 03, 06' },
    'The policy diot_tipo_operacion_por_omision is set to "99", which is not 85, 02, 03, 06. Stopping is preferred ' +
      'to inventing an equivalence: the catalogue is set by the authority.'],
  [`${F}.operation_type_by_default`, { name: NAME, operation: '85', allowed: '02, 03, 06, 08, 85' },
    `The vendor ${NAME} is declared with operation type 85 by default: it has none on file. Refine it if its ` +
      'operation is another of those the catalogue accepts (§3.1: 02, 03, 06, 08, 85).'],
  [`${F}.foreign_incomplete`, { name: NAME, missing: 'country of residence, nationality' },
    `The vendor ${NAME} is declared as a foreign third party (05) and is missing: country of residence, ` +
      'nationality. The layout asks for all three, and the authority rejects an incomplete type 05 row when it ' +
      'receives the file, once the deadline has run.'],
  [`${F}.foreign_incomplete.tax_id`, {}, 'tax identification number'],
  [`${F}.foreign_incomplete.country`, {}, 'country of residence'],
  [`${F}.foreign_incomplete.nationality`, {}, 'nationality'],
  [`${F}.global_with_rfc`, { name: NAME, rfc: 'ABC010101AA1', generic: 'XAXX010101000' },
    `The vendor ${NAME} is marked as a global third party (15) and has the RFC ABC010101AA1 on file. Type 15 ` +
      'declares operations with no identifiable counterparty: it is declared with the generic XAXX010101000 and its ' +
      'real RFC does not travel. Check whether the third-party type is the right one.'],
  [`${F}.no_rfc_declared_global`, { name: NAME, reason: 'has no RFC on file', generic: 'XAXX010101000' },
    `The vendor ${NAME} has no RFC on file, and by policy it is declared as a global third party (15) with the ` +
      'generic XAXX010101000. The return will say those purchases had no identifiable counterparty, and the ' +
      'authority cross-checks it against what that vendor declared on its side.'],
  [`${F}.no_rfc`, { name: NAME, reason: 'has no RFC on file' },
    `The vendor ${NAME} has no RFC on file. Without an RFC that identifies it, it cannot be declared as a domestic ` +
      'third party, and type 15 is for the general public, not a drawer for vendors whose RFC nobody captured.'],
  [`${F}.exempt_revenue_without_proportion`, { exemptRevenue: '1500.00', groupingCodes: '401.07, 401.08, 401.09' },
    'The ledger records 1500.00 of exempt revenue in the fiscal year (accounts with grouping code 401.07, 401.08, ' +
      '401.09), and the policy diot_creditable_iva_proportion declares all the IVA as tied to exclusively taxed ' +
      'activities. With exempt activities the creditable IVA follows the proportion of art. 5 frac. V LIVA: answer ' +
      'the policy with "block" and allocate the IVA in the portal.'],
  [`${F}.proportion_by_default`, {},
    'All the creditable IVA is declared as tied to exclusively taxed activities because the policy ' +
      'diot_creditable_iva_proportion is not answered. Confirm it if the entity has no exempt activities.'],
  [`${F}.exempt_base_policy_out_of_catalogue`, BASE_POLICY,
    'The policy diot_iva_exento_y_base is set to "inventar", which is not exigir_base, derivar_del_subtotal or ' +
      'omitir_y_avisar.'],
  [`${F}.bill_without_lines`, { billNumber: 'BILL-0007' },
    'The bill BILL-0007 has no stored lines, so its IVA cannot be split by rate. The DIOT declares by rate, not a total.'],
  [`${F}.vendor_of_another_entity`, { bills: 'BILL-0001, BILL-0002', vendorId: 'v-ajeno' },
    'The bills BILL-0001, BILL-0002 point to the vendor v-ajeno, which does not belong to this entity.'],
  ['error.DIOT_NO_ENTREGABLE.blocking_findings', { period: '04/2026', count: 1, findings: 'one' },
    'The DIOT of 04/2026 has 1 problem that prevents filing it:\n  · one'],
  ['error.DIOT_NO_ENTREGABLE.blocking_findings', { period: '04/2026', count: 2, findings: 'one\n  · two' },
    'The DIOT of 04/2026 has 2 problems that prevent filing it:\n  · one\n  · two'],
  ['error.DIOT_NO_ENTREGABLE.blocking_findings.item', { code: 'DIOT-SIN-RFC', text: 'Vendor A' },
    '[DIOT-SIN-RFC] Vendor A'],
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
// The sites: each finding is a key, and its fragments go with it.
// ------------------------------------------------------------

const vendor = (o: Partial<TerceroCrudo> = {}): TerceroCrudo => ({
  vendorId: 'v1',
  nombre: NAME,
  taxId: 'ABC010101AA1',
  taxIdType: 'rfc',
  tipoTercero: null,
  tipoOperacion: null,
  idFiscalExtranjero: null,
  paisResidencia: null,
  nacionalidad: null,
  ...o,
});

const POLICIES: PoliticasDelTercero = {
  tipoOperacionPorOmision: '85',
  terceroSinRfc: 'bloquear',
  foreignOperationDefault: '07',
};

const only = (hs: readonly Hallazgo[], code: string): KeyedText => {
  const h = hs.find((x) => x.codigo === code);
  expect(h, code).toBeDefined();
  expect(typeof h!.mensaje, `${code} is a key, not prose`).toBe('object');
  return h!.mensaje as KeyedText;
};

describe('the RFC motive is a key', () => {
  it('names the culprit in each state', () => {
    expect(clasificarRfc('').motivo).toEqual({ key: `${R}.empty` });
    expect(clasificarRfc('XAXX010101000').motivo).toEqual({ key: `${R}.generic_national`, params: { rfc: 'XAXX010101000' } });
    expect(clasificarRfc('XEXX010101000').motivo).toEqual({ key: `${R}.generic_foreign`, params: { rfc: 'XEXX010101000' } });
    expect(clasificarRfc('xxxx').motivo).toEqual({ key: `${R}.malformed`, params: { rfc: 'XXXX' } });
    expect(clasificarRfc('ABC261301AA1').motivo).toEqual({ key: `${R}.impossible_date`, params: { rfc: 'ABC261301AA1', date: '26-13-01' } });
    expect(clasificarRfc('ABC010101AA1').motivo).toEqual({ key: `${R}.valid` });
  });
});

describe('resolverTercero speaks by key', () => {
  it('a vendor without an RFC: the motive renders inside the sentence, in each language', () => {
    const m = only(resolverTercero(vendor({ taxId: 'XXXX' }), POLICIES).hallazgos, 'DIOT-SIN-RFC');
    expect(m.key).toBe(`${F}.no_rfc`);
    expect(textIn(m, 'es')).toBe(
      `El proveedor ${NAME} ${MALFORMED}. Sin RFC que lo identifique no se puede declarar como tercero nacional, y el ` +
        'tipo 15 es para el público en general, no un cajón para proveedores cuyo RFC nadie capturó.'
    );
    expect(textIn(m, 'en')).toMatch(/^The vendor Papelería del Centro SA de CV has "XXXX" as its RFC, which does not have/);
  });

  it('declared global by policy', () => {
    const r = resolverTercero(vendor({ taxId: null }), { ...POLICIES, terceroSinRfc: 'declarar_global' });
    const m = only(r.hallazgos, 'DIOT-SIN-RFC-DECLARADO-GLOBAL');
    expect(textIn(m, 'es')).toBe(SPANISH_AS_BEFORE.find(([k]) => k === `${F}.no_rfc_declared_global`)![2]);
    expect(textIn(m, 'en')).toBe(ENGLISH.find(([k]) => k === `${F}.no_rfc_declared_global`)![2]);
  });

  it('a foreign vendor lists what it lacks, in the reader\'s language', () => {
    const r = resolverTercero(vendor({ tipoTercero: '05', taxId: null, idFiscalExtranjero: 'X-1' }), POLICIES);
    const m = only(r.hallazgos, 'DIOT-EXTRANJERO-INCOMPLETO');
    expect(textIn(m, 'es')).toBe(SPANISH_AS_BEFORE.find(([k]) => k === `${F}.foreign_incomplete`)![2]);
    expect(textIn(m, 'en')).toBe(ENGLISH.find(([k]) => k === `${F}.foreign_incomplete`)![2]);
  });

  it('the operation type: not allowed, undeclared, out of catalogue, by default', () => {
    const notAllowed = only(resolverTercero(vendor({ tipoOperacion: '07' }), POLICIES).hallazgos, 'DIOT-OPERATION-TYPE-NOT-ALLOWED');
    expect(notAllowed).toEqual({
      key: `${F}.operation_type_not_allowed`,
      params: { name: NAME, partyType: '04', operation: '07', allowed: '02, 03, 06, 08, 85' },
    });
    const undeclared = only(
      resolverTercero(vendor(), { ...POLICIES, tipoOperacionPorOmision: 'bloquear' }).hallazgos,
      'DIOT-TIPO-OPERACION-SIN-DECLARAR'
    );
    expect(undeclared).toEqual({ key: `${F}.operation_type_undeclared`, params: { name: NAME } });
    const outside = only(
      resolverTercero(vendor(), { ...POLICIES, tipoOperacionPorOmision: '99' }).hallazgos,
      'DIOT-POLITICA-FUERA-DE-CATALOGO'
    );
    expect(outside).toEqual({
      key: `${F}.policy_out_of_catalogue`,
      params: { policy: 'diot_tipo_operacion_por_omision', value: '99', allowed: '85, 02, 03, 06' },
    });
    const byDefault = only(resolverTercero(vendor(), POLICIES).hallazgos, 'DIOT-TIPO-OPERACION-POR-OMISION');
    expect(byDefault).toEqual({
      key: `${F}.operation_type_by_default`,
      params: { name: NAME, operation: '85', allowed: '02, 03, 06, 08, 85' },
    });
  });

  it('a global vendor that carries its real RFC', () => {
    const m = only(resolverTercero(vendor({ tipoTercero: '15' }), POLICIES).hallazgos, 'DIOT-GLOBAL-CON-RFC');
    expect(m).toEqual({ key: `${F}.global_with_rfc`, params: { name: NAME, rfc: 'ABC010101AA1', generic: 'XAXX010101000' } });
  });
});

describe('proportionFindings speaks by key', () => {
  it('exempt revenue blocks, and the unanswered policy notices', () => {
    const hs = proportionFindings({ value: 'taxed_only', defined: false }, '1500.00');
    expect(hs.map((h) => h.mensaje)).toEqual([
      { key: `${F}.exempt_revenue_without_proportion`, params: { exemptRevenue: '1500.00', groupingCodes: '401.07, 401.08, 401.09' } },
      { key: `${F}.proportion_by_default` },
    ]);
  });
});

// ------------------------------------------------------------
// The frame that lists the blocking findings, and the working paper.
// ------------------------------------------------------------

const diot = (findings: Hallazgo[]): DiotConstruida => ({
  periodo: { anio: 2026, mes: 4, desde: '2026-04-01', hasta: '2026-04-30' },
  rfc: 'AAA010101AA1',
  razonSocial: 'Contribuyente de prueba',
  renglones: [],
  totales: { desglose: desgloseCero(), ivaRetenido: '0.0000', ivaAcreditablePagado: '0.0000', terceros: 0, documentos: 0 },
  politicas: [],
  hallazgos: findings,
});

const MIXED: Hallazgo[] = [
  { codigo: 'DIOT-SIN-RENGLONES', severidad: 'bloqueante', mensaje: { key: `${F}.bill_without_lines`, params: { billNumber: 'BILL-0007' } } },
  { codigo: 'DIOT-IVA-CABECERA', severidad: 'bloqueante', mensaje: 'Prosa que todavía no tiene clave.' },
  { codigo: 'DIOT-PROPORTION-BY-DEFAULT', severidad: 'aviso', mensaje: { key: `${F}.proportion_by_default` } },
];

describe('exigirEntregable lists keys and prose alike', () => {
  it('throws the frame by key, with the codes it always had', () => {
    let err: unknown;
    try {
      exigirEntregable(diot(MIXED));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DiotNoEntregable);
    const e = err as DiotNoEntregable;
    expect(e).toMatchObject({
      statusCode: 422,
      code: 'DIOT_NO_ENTREGABLE',
      messageKey: { key: 'error.DIOT_NO_ENTREGABLE.blocking_findings', params: { period: '04/2026', count: 2 } },
      details: { codigos: ['DIOT-SIN-RENGLONES', 'DIOT-IVA-CABECERA'] },
    });
    expect(e.localized('es')).toBe(
      'La DIOT de 04/2026 tiene 2 problema(s) que impiden entregarla:\n' +
        '  · [DIOT-SIN-RENGLONES] El gasto BILL-0007 no tiene renglones guardados, así que su IVA no se puede ' +
        'desglosar por tasa. La DIOT declara por tasa, no un total.\n' +
        '  · [DIOT-IVA-CABECERA] Prosa que todavía no tiene clave.'
    );
    expect(e.message).toBe(
      'The DIOT of 04/2026 has 2 problems that prevent filing it:\n' +
        '  · [DIOT-SIN-RENGLONES] The bill BILL-0007 has no stored lines, so its IVA cannot be split by rate. The ' +
        'DIOT declares by rate, not a total.\n' +
        '  · [DIOT-IVA-CABECERA] Prosa que todavía no tiene clave.'
    );
    expect(String(e.messageKey?.params?.findings)).toContain('[DIOT-SIN-RENGLONES] The bill BILL-0007');
  });

  it('the working paper keeps its Spanish line: a file keeps the language it is written in', () => {
    const paper = PAPEL_DE_TRABAJO.serializar(diot(MIXED));
    expect(paper).toContain(
      '#   [DIOT-SIN-RENGLONES] El gasto BILL-0007 no tiene renglones guardados, así que su IVA no se puede ' +
        'desglosar por tasa. La DIOT declara por tasa, no un total.\n'
    );
    expect(paper).toContain('#   [DIOT-IVA-CABECERA] Prosa que todavía no tiene clave.\n');
  });
});

describe('textIn', () => {
  it('returns prose as written and renders a key with its lists', () => {
    expect(textIn('tal cual', 'en')).toBe('tal cual');
    const m: KeyedText = {
      key: `${F}.no_rfc`,
      params: { name: 'X' },
      lists: { reason: { join: '', items: [{ key: `${R}.empty` }] } },
    };
    expect(textIn(m, 'es')).toMatch(/^El proveedor X no tiene RFC en el expediente\. /);
    expect(textIn(m, 'en')).toMatch(/^The vendor X has no RFC on file\. /);
  });
});

describe('the lane', () => {
  it.each(['rfc.ts', 'tercero.ts', 'diot-service.ts'])('%s holds no Spanish prose', (name) => {
    const file = `src/services/sat/diot/${name}`;
    const code = fs.readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
    expect(serviceUserStrings(code, file).map((h) => `${h.line}: ${h.text}`)).toEqual([]);
  });
});
