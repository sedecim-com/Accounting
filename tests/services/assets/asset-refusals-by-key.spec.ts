/**
 * MNE-001-731 (#151), I9 by folder, part 8: the refusals of src/services/assets
 * that reached the requester in Spanish prose are catalogue keys now. The
 * Spanish twin must print, byte for byte, what each site printed before (the
 * strings below are written by hand from those sites, with synthetic values),
 * and the English is the source the error's `message` is fixed in.
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(() => undefined),
}));
vi.mock('../../../src/services/policy/policy-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/policy/policy-service.js')>()),
  getPolicy: vi.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import { exigirLibroDelPanel, resolverCategoriaDeActivo } from '../../../src/services/assets/asset-lookup.js';
import { montosDelAlta, vidaUtilCoherente } from '../../../src/services/assets/asset-service.js';
import { criteriosDeLaCorrida, inquilinoDeLaEntidad } from '../../../src/services/assets/depreciation.js';
import { serviceUserStrings } from '../../../scripts/language/lanes/service-strings.js';

type Case = readonly [TranslationKey, MessageParams, string];

const A = 'error.VALIDATION_ERROR.asset';
const D = 'error.VALIDATION_ERROR.depreciation';
const CLASSES = 'Equipo de Cómputo, Equipo de Transporte';
const HINT_ES = (k: string) =>
  `\`mnemosine pending reopen ${k}\` (si ya estaba definida) y luego \`mnemosine pending define ${k}\``;
const HINT_EN = (k: string) =>
  `\`mnemosine pending reopen ${k}\` (if it was already defined) and then \`mnemosine pending define ${k}\``;
const CONTRADICTS = { requested: 'tax', base: 'vida_util_nif', book: 'book' };

const SPANISH_AS_BEFORE: readonly Case[] = [
  [`${A}.category_empty`, {}, '--category llegó vacía: el activo necesita su clase.'],
  [`${A}.category_ambiguous`, { text: 'equipo', count: 2, matches: CLASSES },
    `"equipo" casa con 2 categorías (${CLASSES}). Escribe el nombre completo o pasa su id: elegir la primera ` +
      'depreciaría contra las cuentas de otra clase durante toda la vida del activo.'],
  [`${A}.category_unknown`, { text: 'Barcos', known: CLASSES },
    `No hay ninguna categoría llamada "Barcos" en esta entidad. Las que hay: ${CLASSES}.`],
  [`${A}.book_unknown`, { declared: 'nif', first: 'book', second: 'tax' },
    '--book "nif" no existe: los dos libros son book y tax (el contable de la NIF C-6 y el fiscal de la LISR).'],
  [`${A}.book_contradicts_policy`, { ...CONTRADICTS, defined: 'no' },
    '--book tax contradice al panel: `base_depreciacion` vale "vida_util_nif", así que el libro que llega al ' +
      'mayor es book (defecto declarado, nadie ha contestado). Esta bandera declara sobre qué libro crees estar ' +
      'operando, no lo elige: cuál de las dos depreciaciones se postea es criterio del despacho y se contesta ' +
      `con ${HINT_ES('base_depreciacion')}.`],
  [`${A}.book_contradicts_policy`, { ...CONTRADICTS, defined: 'yes' },
    '--book tax contradice al panel: `base_depreciacion` vale "vida_util_nif", así que el libro que llega al ' +
      'mayor es book. Esta bandera declara sobre qué libro crees estar operando, no lo elige: cuál de las dos ' +
      `depreciaciones se postea es criterio del despacho y se contesta con ${HINT_ES('base_depreciacion')}.`],
  [`${A}.date_format`, { field: 'acquisition_date', value: '20/03/2026' },
    'La fecha de acquisition_date tiene que venir como "YYYY-MM-DD"; llegó "20/03/2026".'],
  [`${A}.life_not_positive_integer`, { field: 'useful_life_months', value: 0 },
    'La vida útil en useful_life_months tiene que ser un entero mayor que cero; llegó 0.'],
  [`${A}.life_missing`, {},
    'Ni el alta ni la categoría dicen cuánto dura el activo. Indica `useful_life_years` o `useful_life_months`, ' +
      'o dale a la categoría su vida por omisión.'],
  [`${A}.life_years_months_mismatch`, { months: 40, derived: 4, years: 3 },
    'Los años y los meses de vida útil no casan: 40 meses caben en 4 año(s) y se declararon 3. Los años son el ' +
      'techo de los meses entre doce —40 meses son 4 años—; corrige uno de los dos u omite los años y se derivan.'],
  [`${A}.amount_not_a_number`, { field: 'acquisition_cost', value: 'mil quinientos' },
    'El importe de acquisition_cost no es un número: "mil quinientos".'],
  [`${A}.amount_not_finite`, { field: 'salvage_value', value: 'Infinity' },
    'El importe de salvage_value no es finito: "Infinity".'],
  [`${A}.cost_not_positive`, { cost: '0.0000' }, 'El costo de adquisición tiene que ser mayor que cero; llegó 0.0000.'],
  [`${A}.salvage_negative`, { salvage: '-1.0000' }, 'El valor de salvamento no puede ser negativo; llegó -1.0000.'],
  [`${A}.salvage_reaches_cost`, { salvage: '1200.0000', cost: '1000.0000' },
    'El valor de salvamento (1200.0000) no puede alcanzar ni superar el costo de adquisición (1000.0000): la ' +
      'base depreciable sería cero o negativa y el activo no produciría un solo renglón de depreciación.'],
  [`${A}.name_empty`, {}, 'El activo necesita nombre: `asset_name` llegó vacío.'],
  [`${A}.category_inactive`, { name: 'Equipo de Cómputo' },
    'La categoría "Equipo de Cómputo" está dada de baja: no admite altas nuevas. Reactívala o elige otra.'],
  [`${A}.start_before_acquisition`, { start: '2026-02-01', acquired: '2026-03-20' },
    'La depreciación no puede arrancar el 2026-02-01, antes de la adquisición (2026-03-20). Si lo que buscas es ' +
      'la convención de mes completo, omite `depreciation_start_date` y el sistema la deriva del panel.'],
  [`${A}.accounts_missing`, { fields: 'asset_account_id', name: 'Equipo de Cómputo' },
    'Faltan cuentas para el activo (asset_account_id) y la categoría "Equipo de Cómputo" no las trae por ' +
      'omisión. Pásalas en el alta o complétale las cuentas a la categoría.'],
  [`${A}.accounts_rejected`, { fields: 'depreciation_expense_account_id' },
    'Estas cuentas no están en el catálogo de esta entidad, o son de encabezado y no admiten movimientos: ' +
      'depreciation_expense_account_id.'],
  ['error.RESOURCE_ALREADY_EXISTS.asset.number_taken', { number: 'AF-2026-00007' },
    'Ya hay un activo con el número "AF-2026-00007" en esta entidad.'],
  [`${D}.policy_base_unknown`, { value: 'lo_que_sea', known: 'vida_util_nif, tasa_lisr' },
    'La política `base_depreciacion` vale "lo_que_sea", que no es ninguna de las dos bases posibles ' +
      `(vida_util_nif, tasa_lisr). Corrígela con ${HINT_ES('base_depreciacion')} antes de correr la depreciación.`],
  [`${D}.policy_convention_unknown`, { value: 'quincenal', known: 'mes_completo, proporcional_dias' },
    'La política `convencion_primer_mes` vale "quincenal", que no es ninguna de las dos convenciones posibles ' +
      `(mes_completo, proporcional_dias). Corrígela con ${HINT_ES('convencion_primer_mes')} antes de correr la ` +
      'depreciación.'],
  [`${D}.tenant_unknown`, { entityId: 'e-1' }, 'No se pudo determinar el inquilino de la entidad e-1.'],
] as Case[];

const ENGLISH: readonly Case[] = [
  [`${A}.category_empty`, {}, '--category arrived empty: the asset needs its class.'],
  [`${A}.category_ambiguous`, { text: 'equipo', count: 2, matches: CLASSES },
    `"equipo" matches 2 classes (${CLASSES}). Type the full name or pass its id: taking the first one would ` +
      'depreciate against the accounts of another class for the whole life of the asset.'],
  [`${A}.category_unknown`, { text: 'Barcos', known: CLASSES },
    `This entity has no asset class named "Barcos". The ones it has: ${CLASSES}.`],
  [`${A}.book_unknown`, { declared: 'nif', first: 'book', second: 'tax' },
    '--book "nif" does not exist: the two books are book and tax (the accounting one of NIF C-6 and the tax ' +
      'one of the LISR).'],
  [`${A}.book_contradicts_policy`, { ...CONTRADICTS, defined: 'no' },
    '--book tax contradicts the panel: `base_depreciacion` is set to "vida_util_nif", so the book that reaches ' +
      'the ledger is book (declared default, nobody has answered). This flag declares which book you believe ' +
      'you are operating on; it does not choose it: which of the two depreciations is posted is the firm\'s ' +
      `criterion, and it is answered with ${HINT_EN('base_depreciacion')}.`],
  [`${A}.book_contradicts_policy`, { ...CONTRADICTS, defined: 'yes' },
    '--book tax contradicts the panel: `base_depreciacion` is set to "vida_util_nif", so the book that reaches ' +
      'the ledger is book. This flag declares which book you believe you are operating on; it does not choose ' +
      'it: which of the two depreciations is posted is the firm\'s criterion, and it is answered with ' +
      `${HINT_EN('base_depreciacion')}.`],
  [`${A}.date_format`, { field: 'acquisition_date', value: '20/03/2026' },
    'The date in acquisition_date must come as "YYYY-MM-DD"; got "20/03/2026".'],
  [`${A}.life_not_positive_integer`, { field: 'useful_life_months', value: 0 },
    'The useful life in useful_life_months must be an integer greater than zero; got 0.'],
  [`${A}.life_missing`, {},
    'Neither the registration nor the class says how long the asset lasts. Give `useful_life_years` or ' +
      '`useful_life_months`, or give the class its default life.'],
  [`${A}.life_years_months_mismatch`, { months: 40, derived: 4, years: 3 },
    'The years and months of useful life do not agree: 40 months fit in 4 year(s) and 3 were declared. The ' +
      'years are the ceiling of the months divided by twelve (40 months are 4 years); correct one of the two, ' +
      'or leave the years out and they are derived.'],
  [`${A}.amount_not_a_number`, { field: 'acquisition_cost', value: 'mil quinientos' },
    'The amount of acquisition_cost is not a number: "mil quinientos".'],
  [`${A}.amount_not_finite`, { field: 'salvage_value', value: 'Infinity' },
    'The amount of salvage_value is not finite: "Infinity".'],
  [`${A}.cost_not_positive`, { cost: '0.0000' }, 'The acquisition cost must be greater than zero; got 0.0000.'],
  [`${A}.salvage_negative`, { salvage: '-1.0000' }, 'The salvage value cannot be negative; got -1.0000.'],
  [`${A}.salvage_reaches_cost`, { salvage: '1200.0000', cost: '1000.0000' },
    'The salvage value (1200.0000) cannot reach or exceed the acquisition cost (1000.0000): the depreciable ' +
      'base would be zero or negative and the asset would not produce a single depreciation row.'],
  [`${A}.name_empty`, {}, 'The asset needs a name: `asset_name` arrived empty.'],
  [`${A}.category_inactive`, { name: 'Equipo de Cómputo' },
    'The class "Equipo de Cómputo" is deactivated: it takes no new assets. Reactivate it or choose another.'],
  [`${A}.start_before_acquisition`, { start: '2026-02-01', acquired: '2026-03-20' },
    'Depreciation cannot start on 2026-02-01, before the acquisition (2026-03-20). If what you want is the ' +
      'full-month convention, leave out `depreciation_start_date` and the system derives it from the panel.'],
  [`${A}.accounts_missing`, { fields: 'asset_account_id', name: 'Equipo de Cómputo' },
    'The asset is missing accounts (asset_account_id) and the class "Equipo de Cómputo" has no defaults for ' +
      'them. Pass them with the registration or complete the class\'s accounts.'],
  [`${A}.accounts_rejected`, { fields: 'depreciation_expense_account_id' },
    'These accounts are not in this entity\'s chart, or are header accounts that take no postings: ' +
      'depreciation_expense_account_id.'],
  ['error.RESOURCE_ALREADY_EXISTS.asset.number_taken', { number: 'AF-2026-00007' },
    'There is already an asset numbered "AF-2026-00007" in this entity.'],
  [`${D}.policy_base_unknown`, { value: 'lo_que_sea', known: 'vida_util_nif, tasa_lisr' },
    'The policy `base_depreciacion` is set to "lo_que_sea", which is neither of the two possible bases ' +
      `(vida_util_nif, tasa_lisr). Correct it with ${HINT_EN('base_depreciacion')} before running the depreciation.`],
  [`${D}.policy_convention_unknown`, { value: 'quincenal', known: 'mes_completo, proporcional_dias' },
    'The policy `convencion_primer_mes` is set to "quincenal", which is neither of the two possible conventions ' +
      `(mes_completo, proporcional_dias). Correct it with ${HINT_EN('convencion_primer_mes')} before running the ` +
      'depreciation.'],
  [`${D}.tenant_unknown`, { entityId: 'e-1' }, 'The tenant of entity e-1 could not be determined.'],
] as Case[];

afterEach(() => {
  resetLanguage();
  vi.clearAllMocks();
});

describe('each key renders what its site printed', () => {
  it.each(SPANISH_AS_BEFORE)('%s in es is the Spanish of before', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it.each(ENGLISH)('%s in en', (key, params, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });
});

/** What a site threw, checked against its key; `es` is the Spanish it printed before. */
function expectKeyed(
  err: unknown,
  want: { cls: new (...args: never[]) => AppError; key: string; field?: string; params: MessageParams }
): void {
  expect(err).toBeInstanceOf(want.cls);
  const e = err as AppError;
  expect(e.messageKey?.key).toBe(want.key);
  expect(e.field).toBe(want.field);
  expect(e.message).toBe(t(want.key as TranslationKey, want.params, 'en'));
  expect(e.localized('es')).toBe(t(want.key as TranslationKey, want.params, 'es'));
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('it did not throw');
}

async function caughtAsync(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('it did not throw');
    },
    (err: unknown) => err
  );
}

// ------------------------------------------------------------
// The sites. Each one throws its class, its field and its key, and its
// Spanish is the one of the table above.
// ------------------------------------------------------------

describe('the useful life and the amounts of the registration', () => {
  it.each([
    [() => vidaUtilCoherente(3, 40, null), 'life_years_months_mismatch', 'useful_life_years', { months: 40, derived: 4, years: 3 }],
    [() => vidaUtilCoherente(undefined, undefined, null), 'life_missing', 'useful_life_years', {}],
    [() => vidaUtilCoherente(undefined, 0, null), 'life_not_positive_integer', 'useful_life_months', { field: 'useful_life_months', value: '0' }],
    [() => montosDelAlta('mil quinientos', undefined), 'amount_not_a_number', 'acquisition_cost', { field: 'acquisition_cost', value: 'mil quinientos' }],
    [() => montosDelAlta('1000', 'Infinity'), 'amount_not_finite', 'salvage_value', { field: 'salvage_value', value: 'Infinity' }],
    [() => montosDelAlta('0', undefined), 'cost_not_positive', 'acquisition_cost', { cost: '0.0000' }],
    [() => montosDelAlta('1000', '-1'), 'salvage_negative', 'salvage_value', { salvage: '-1.0000' }],
    [() => montosDelAlta('1000', '1200'), 'salvage_reaches_cost', 'salvage_value', { salvage: '1200.0000', cost: '1000.0000' }],
  ] as const)('%#: %s', (fn, key, field, params) => {
    expectKeyed(caught(fn), { cls: ValidationError, key: `${A}.${key}`, field, params });
  });

  it('the Spanish of a site is the one it printed', () => {
    const e = caught(() => vidaUtilCoherente(3, 40, null)) as AppError;
    expect(e.localized('es')).toBe(SPANISH_AS_BEFORE.find(([k]) => k === `${A}.life_years_months_mismatch`)?.[2]);
  });
});

describe('the class and the book the operator names', () => {
  const mockQuery = query as unknown as Mock;
  const classes = (...names: string[]) => ({
    rows: names.map((name, i) => ({ id: `c-${i}`, name, is_active: true, cuentas_por_omision: 3 })),
  });

  it('an empty --category refuses before any query', async () => {
    const err = await caughtAsync(resolverCategoriaDeActivo('e-1', '   '));
    expectKeyed(err, { cls: ValidationError, key: `${A}.category_empty`, field: 'category_id', params: {} });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a name that matches two classes names both', async () => {
    mockQuery.mockResolvedValueOnce(classes('Equipo de Cómputo', 'Equipo de Transporte'));
    const err = await caughtAsync(resolverCategoriaDeActivo('e-1', 'equipo'));
    expectKeyed(err, {
      cls: ValidationError, key: `${A}.category_ambiguous`, field: 'category_id',
      params: { text: 'equipo', count: 2, matches: CLASSES },
    });
  });

  it('a name that matches none names the ones there are', async () => {
    mockQuery.mockResolvedValueOnce(classes('Equipo de Cómputo', 'Equipo de Transporte'));
    const err = await caughtAsync(resolverCategoriaDeActivo('e-1', 'Barcos'));
    expectKeyed(err, {
      cls: ValidationError, key: `${A}.category_unknown`, field: 'category_id', params: { text: 'Barcos', known: CLASSES },
    });
  });

  it('an unknown --book names the two books', () => {
    const err = caught(() => exigirLibroDelPanel('nif', { libro: 'book', base: 'vida_util_nif', definida: true }));
    expectKeyed(err, {
      cls: ValidationError, key: `${A}.book_unknown`, field: 'book', params: { declared: 'nif', first: 'book', second: 'tax' },
    });
  });

  it.each([
    [false, 'no'],
    [true, 'yes'],
  ] as const)('a --book against the panel (defined: %s) says which book governs', (answered, defined) => {
    const err = caught(() => exigirLibroDelPanel('tax', { libro: 'book', base: 'vida_util_nif', definida: answered }));
    expectKeyed(err, {
      cls: ValidationError, key: `${A}.book_contradicts_policy`, field: 'book', params: { ...CONTRADICTS, defined },
    });
  });
});

describe('the guards before the depreciation run', () => {
  const mockPolicy = getPolicy as unknown as Mock;
  const answers = (values: Record<string, string>) =>
    mockPolicy.mockImplementation((_ctx: unknown, key: string) =>
      Promise.resolve({ key, value: values[key], defined: true })
    );

  it('a base_depreciacion outside the vocabulary stops the run', async () => {
    answers({ base_depreciacion: 'lo_que_sea', convencion_primer_mes: 'mes_completo' });
    expectKeyed(await caughtAsync(criteriosDeLaCorrida('t-1', 'e-1')), {
      cls: ValidationError, key: `${D}.policy_base_unknown`, params: { value: 'lo_que_sea', known: 'vida_util_nif, tasa_lisr' },
    });
  });

  it('a convencion_primer_mes outside the vocabulary stops the run', async () => {
    answers({ base_depreciacion: 'tasa_lisr', convencion_primer_mes: 'quincenal' });
    expectKeyed(await caughtAsync(criteriosDeLaCorrida('t-1', 'e-1')), {
      cls: ValidationError, key: `${D}.policy_convention_unknown`,
      params: { value: 'quincenal', known: 'mes_completo, proporcional_dias' },
    });
  });

  it('an entity with no tenant is refused', async () => {
    (query as unknown as Mock).mockResolvedValueOnce({ rows: [] });
    expectKeyed(await caughtAsync(inquilinoDeLaEntidad('e-1')), {
      cls: ValidationError, key: `${D}.tenant_unknown`, params: { entityId: 'e-1' },
    });
  });
});

describe('the lane', () => {
  it('asset-lookup.ts holds no Spanish prose for a person any more', () => {
    const file = path.resolve('src/services/assets/asset-lookup.ts');
    expect(serviceUserStrings(fs.readFileSync(file, 'utf8'), file)).toEqual([]);
  });

  it('the conflict of a repeated asset number keeps its code', () => {
    const e = new ConflictError({ key: 'error.RESOURCE_ALREADY_EXISTS.asset.number_taken', params: { number: 'AF-1' } });
    expect(e.code).toBe('RESOURCE_ALREADY_EXISTS');
    expect(e.localized('es')).toBe('Ya hay un activo con el número "AF-1" en esta entidad.');
  });
});
