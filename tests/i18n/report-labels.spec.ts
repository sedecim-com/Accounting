import { describe, it, expect, afterEach } from 'vitest';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import {
  REPORT_SECTION_KEYS,
  reportCategoryLabel,
  reportSectionLabel,
} from '../../src/i18n/report-labels.js';
import { crudoDe } from '../../src/plan/criterios.js';
import { AccountType, FSCategory } from '../../src/types/index.js';

// ============================================================
// THE LABELS OF A STATEMENT, IN BOTH LANGUAGES (I11 · issue #153)
//
// WHY EVERY EXPECTED STRING BELOW IS TYPED OUT BY HAND. The obvious way to
// write this file is to loop over the catalog and compare `reportSectionLabel`
// against `EN['report.section.' + key]`. That test passes with the catalog
// deleted and the labeller returning the key, because both sides of the
// comparison come from the same place. A label table is exactly the kind of
// thing whose test has to REPEAT the data it is protecting; otherwise the only
// thing measured is that the map is a map.
//
// WHY EVERY CASE NAMES ITS LANGUAGE. `vitest.config.ts` pins
// MNEMOSINE_LOCALE=en-US for this suite on purpose, so a case that never says
// which language it wants is asserting English without admitting it — and
// would keep passing if the Spanish catalog were emptied. Every call below
// passes the language explicitly, except the two cases that exist precisely to
// prove the ambient language is honoured, and those pin it with `setLanguage`
// and hand it back in `afterEach`.
// ============================================================

afterEach(() => {
  resetLanguage();
});

/** key, es, en — written out, never derived. */
const SECTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['assets', 'Activo', 'Assets'],
  ['liabilities', 'Pasivo', 'Liabilities'],
  ['equity', 'Capital contable', 'Equity'],
  ['revenue', 'Ingresos', 'Revenue'],
  ['expenses', 'Gastos', 'Expenses'],
  ['result_of_the_period', 'Utilidad (pérdida) del ejercicio', 'Profit (loss) for the period'],
];

/** The thirteen `fs_category` values a balance sheet can group by. */
const CATEGORIES: ReadonlyArray<readonly [string, string, string]> = [
  ['current_assets', 'Activo circulante', 'Current assets'],
  ['non_current_assets', 'Activo no circulante', 'Non-current assets'],
  ['current_liabilities', 'Pasivo a corto plazo', 'Current liabilities'],
  ['long_term_liabilities', 'Pasivo a largo plazo', 'Long-term liabilities'],
  ['equity', 'Capital contribuido', 'Contributed capital'],
  ['ori', 'Otros resultados integrales', 'Other comprehensive income'],
  ['revenue', 'Ingresos', 'Revenue'],
  ['cogs', 'Costo de ventas', 'Cost of sales'],
  ['operating_expenses', 'Gastos de operación', 'Operating expenses'],
  ['other_income', 'Otros ingresos', 'Other income'],
  ['other_expenses', 'Otros gastos', 'Other expenses'],
  ['tax', 'Impuestos', 'Taxes'],
  ['other', 'Otros', 'Other'],
];

/**
 * What `report-service.ts` still coins for `subsection.name`, reproduced here
 * on purpose instead of imported: this is the thing the catalog replaces, and
 * a test that imported it would move with it.
 */
function asTheOldPrettifierWouldHaveIt(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

describe('a section has a label in both languages', () => {
  for (const [key, es, en] of SECTIONS) {
    it(`${key} reads "${es}" in Spanish and "${en}" in English`, () => {
      expect(reportSectionLabel(key, 'es')).toBe(es);
      expect(reportSectionLabel(key, 'en')).toBe(en);
    });
  }

  it('the exported list of sections is the list that has labels, with nothing extra', () => {
    expect([...REPORT_SECTION_KEYS]).toEqual(SECTIONS.map(([key]) => key));
  });

  it('every section label is prose, never the key that reached it', () => {
    for (const [key] of SECTIONS) {
      expect(reportSectionLabel(key, 'es')).not.toBe(key);
      expect(reportSectionLabel(key, 'en')).not.toBe(key);
    }
  });
});

describe('a balance-sheet category has a label in both languages', () => {
  for (const [key, es, en] of CATEGORIES) {
    it(`${key} reads "${es}" in Spanish and "${en}" in English`, () => {
      expect(reportCategoryLabel(key, 'es')).toBe(es);
      expect(reportCategoryLabel(key, 'en')).toBe(en);
    });
  }

  it('there are thirteen of them, so one added to the CHECK without a label shows up here', () => {
    expect(CATEGORIES).toHaveLength(13);
  });
});

describe('what the old prettifier got wrong, and the catalog does not', () => {
  // `cat.replace(/_/g, ' ')…` turned two stored values into things that are
  // not words in either language. They are the reason this catalog exists, so
  // they get their own case rather than being one row of a loop.
  it('ori is a statement line, not the syllable «Ori»', () => {
    expect(asTheOldPrettifierWouldHaveIt('ori')).toBe('Ori'); // what it used to print
    expect(reportCategoryLabel('ori', 'es')).toBe('Otros resultados integrales');
    expect(reportCategoryLabel('ori', 'en')).toBe('Other comprehensive income');
    expect(reportCategoryLabel('ori', 'es')).not.toBe('Ori');
    expect(reportCategoryLabel('ori', 'en')).not.toBe('Ori');
  });

  it('cogs is the cost of sales, not the syllable «Cogs»', () => {
    expect(asTheOldPrettifierWouldHaveIt('cogs')).toBe('Cogs');
    expect(reportCategoryLabel('cogs', 'es')).toBe('Costo de ventas');
    expect(reportCategoryLabel('cogs', 'en')).toBe('Cost of sales');
    expect(reportCategoryLabel('cogs', 'es')).not.toBe('Cogs');
    expect(reportCategoryLabel('cogs', 'en')).not.toBe('Cogs');
  });

  it('the equity CATEGORY is not the label of the equity SECTION that contains it', () => {
    // The prettifier printed «Equity» inside «Equity»: a subtotal that looked
    // like the section total and was not. Contributed capital is one line of
    // equity; `ori` and the result of the period are others.
    for (const language of ['es', 'en'] as const) {
      const section = reportSectionLabel('equity', language);
      const category = reportCategoryLabel('equity', language);
      expect(category, `${language}: the subsection repeats its parent`).not.toBe(section);
    }
    expect(reportSectionLabel('equity', 'es')).toBe('Capital contable');
    expect(reportCategoryLabel('equity', 'es')).toBe('Capital contribuido');
    expect(reportSectionLabel('equity', 'en')).toBe('Equity');
    expect(reportCategoryLabel('equity', 'en')).toBe('Contributed capital');
  });
});

describe('an unknown key falls back to the key, and never throws', () => {
  it('a section nobody has a label for prints its identifier', () => {
    expect(() => reportSectionLabel('minority_interest', 'es')).not.toThrow();
    expect(reportSectionLabel('minority_interest', 'es')).toBe('minority_interest');
    expect(reportSectionLabel('minority_interest', 'en')).toBe('minority_interest');
  });

  it('a category nobody has a label for prints its identifier', () => {
    expect(() => reportCategoryLabel('deferred_tax', 'en')).not.toThrow();
    expect(reportCategoryLabel('deferred_tax', 'es')).toBe('deferred_tax');
    expect(reportCategoryLabel('deferred_tax', 'en')).toBe('deferred_tax');
  });

  it('the empty string and a key shaped like another catalog entry are still keys', () => {
    expect(reportSectionLabel('', 'es')).toBe('');
    expect(reportCategoryLabel('', 'es')).toBe('');
    // `report.total_of` exists in the catalog, but not under these prefixes,
    // and a label that resolved it would print «Total {name}» at a reader.
    expect(reportSectionLabel('total_of', 'en')).toBe('total_of');
    expect(reportCategoryLabel('net_income', 'en')).toBe('net_income');
  });

  it('the two namespaces do not lend each other labels', () => {
    // `cogs` is a category and not a section; `assets` is a section and not a
    // category. One lookup table for both would answer the wrong prose here.
    expect(reportSectionLabel('cogs', 'es')).toBe('cogs');
    expect(reportSectionLabel('current_assets', 'es')).toBe('current_assets');
    expect(reportCategoryLabel('assets', 'es')).toBe('assets');
    expect(reportCategoryLabel('liabilities', 'es')).toBe('liabilities');
  });
});

describe('with no language named, the label follows the language in force', () => {
  it('Spanish is pinned, Spanish comes out', () => {
    setLanguage('es');
    expect(reportSectionLabel('assets')).toBe('Activo');
    expect(reportCategoryLabel('current_assets')).toBe('Activo circulante');
  });

  it('English is pinned, English comes out', () => {
    setLanguage('en');
    expect(reportSectionLabel('assets')).toBe('Assets');
    expect(reportCategoryLabel('current_assets')).toBe('Current assets');
  });

  it('the fallback also follows it, which is to say it does not depend on it', () => {
    setLanguage('es');
    expect(reportCategoryLabel('deferred_tax')).toBe('deferred_tax');
    setLanguage('en');
    expect(reportCategoryLabel('deferred_tax')).toBe('deferred_tax');
  });
});

describe('ori is a statement CATEGORY, and it is in the enum that means that', () => {
  // It was added to `AccountType`, whose eight members answer «what kind of
  // account is this» — the thing that decides the normal balance and the sign
  // of a posting. `ori` answers «which line of the statement does it group
  // under», which is `FSCategory` and is what migration 078's CHECK holds. An
  // account typed `ori` is not a ninth kind of account: it is equity.

  /** The eight kinds of account, typed out rather than read off the enum. */
  const ACCOUNT_TYPES = [
    'asset',
    'liability',
    'equity',
    'revenue',
    'expense',
    'contra_asset',
    'contra_liability',
    'contra_equity',
  ];

  it('AccountType has its eight members and `ori` is not one of them', () => {
    expect(Object.values(AccountType)).toEqual(ACCOUNT_TYPES);
    expect(Object.values(AccountType)).not.toContain('ori');
    expect(AccountType).not.toHaveProperty('ORI');
  });

  it('FSCategory is where it belongs, and it has the label to prove it', () => {
    expect(Object.values(FSCategory)).toContain('ori');
    expect(FSCategory.ORI).toBe('ori');
    expect(reportCategoryLabel(FSCategory.ORI, 'es')).toBe('Otros resultados integrales');
    expect(reportCategoryLabel(FSCategory.ORI, 'en')).toBe('Other comprehensive income');
  });

  it('every FSCategory member has a label, so the enum and the catalog cannot drift', () => {
    // The enum is the third statement of the same domain, after the CHECK and
    // the catalog. All three are asserted, and none is derived from another.
    const values = Object.values(FSCategory);
    expect(values).toHaveLength(12);

    const withLabel = new Set(CATEGORIES.map(([key]) => key));
    for (const value of values) {
      expect(withLabel, `FSCategory.${value} has no row in this spec`).toContain(value);
      expect(reportCategoryLabel(value, 'es'), `${value} has no Spanish label`).not.toBe(value);
      expect(reportCategoryLabel(value, 'en'), `${value} has no English label`).not.toBe(value);
    }
    // The thirteenth row is `other`, which the enum cannot hold because the
    // column is NULL there: `report-service.ts` coins it for an account with
    // no fs_category at all.
    expect(values as string[]).not.toContain('other');
  });

  it('the two enums overlap in exactly two words, and `ori` is in neither overlap', () => {
    // They are different vocabularies that happen to share two spellings, and
    // that is the trap: `equity` and `revenue` read alike in both and mean
    // different things — a kind of account on one side, a statement line on
    // the other. `ori` is only ever a statement line, so it must appear on one
    // side only. Written out rather than counted.
    const types = new Set<string>(Object.values(AccountType));
    expect(Object.values(FSCategory).filter((value) => types.has(value)))
      .toEqual(['equity', 'revenue']);

    // And the shared spellings do not share meaning: the equity CATEGORY is
    // contributed capital, one line of the equity SECTION that contains it.
    expect(reportCategoryLabel('equity', 'es')).toBe('Capital contribuido');
    expect(reportSectionLabel('equity', 'es')).toBe('Capital contable');
  });
});

describe('the catalog covers the domain the database can actually store', () => {
  it('every fs_category admitted by migration 078 has a label in both languages', () => {
    // Read by the seam, and anchored on the CONSTRAINT rather than on the file
    // as a whole: the same migration mentions `ori` again in a COMMENT, and a
    // grep for quoted words over the whole file would pass on the prose alone.
    const sql = crudoDe('src/database/migrations/078_lo_que_se_debe_y_todavia_no_se_paga.sql');
    const check = /accounts_fs_category_check[\s\S]*?CHECK \(fs_category IN \(([\s\S]*?)\)\)/.exec(
      sql
    );
    expect(check, 'the CHECK that fixes the domain of fs_category is no longer there').not.toBeNull();

    const stored = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // Twelve in the CHECK; `other` is not storable — `report-service.ts` coins
    // it for an account whose fs_category is NULL — and the catalog needs it
    // all the same.
    expect(stored).toHaveLength(12);
    expect(stored).toContain('ori');

    const withLabel = new Set(CATEGORIES.map(([key]) => key));
    for (const key of [...stored, 'other']) {
      expect(withLabel, `fs_category "${key}" has no row in this spec`).toContain(key);
      expect(reportCategoryLabel(key, 'es'), `fs_category "${key}" has no Spanish label`).not.toBe(key);
      expect(reportCategoryLabel(key, 'en'), `fs_category "${key}" has no English label`).not.toBe(key);
    }
  });
});
