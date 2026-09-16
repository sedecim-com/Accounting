import { getPolicy } from '../policy/policy-service.js';
import { ACCOUNT_FS_CATEGORIES, ACCOUNT_TYPES } from '../../database/enums.js';

// ============================================================
// X1c · A SUBACCOUNT AND ITS PARENT BELONG TO THE SAME SECTION
//
// Nothing tied a child account's `fs_category` to its parent's: no trigger, no
// constraint, no validation. A firm could hang an expense account under an
// asset and every statement would foot — the number lands in the wrong section
// of a document somebody signs.
//
// WHY THE RULE IS «SAME SECTION» AND NOT «SAME CATEGORY», measured rather than
// argued. Over the 80 parent-child pairs the house itself seeds (chart-seed.ts
// and database/seed.ts), equality is FALSE eleven times and same-section is
// true 80 of 80. A strict-equality rule would be born red against the very
// catalogue the product ships: 1200 «Activo Fijo» is `non_current_assets`
// under 1000 «Activo», which is `current_assets`, and that is correct
// accounting, not a mistake.
//
// AND THE SECTION MAP IS NOT FITTED TO THOSE ELEVEN ROWS. That is the trap this
// module had to avoid: choosing the fusions after seeing the divergences they
// need to absolve proves nothing. The partition below is the one `account_type`
// ALREADY encodes, and its independent check is that `sectionOfCategory` and
// `sectionOfType` agree on 54 of 54 seeded accounts — a fact about every row,
// not only about the eleven that diverge. `coherenceOfOwnRow` is that check,
// and it is exported so a criterion can run it over the catalogue.
//
// NULL IS A THIRD STATE, NOT A VIOLATION. `fs_category` is nullable on purpose:
// the SAT import leaves it empty on BOTH sides of every edge it creates
// (sat-chart-import.ts does not name the column), and onboarding creates
// accounts without it. A rule that treats absence as a breach would refuse to
// let a firm migrate its own chart.
// ============================================================

export type StatementSection = 'assets' | 'liabilities' | 'equity' | 'income' | 'expenses';

export type FsCategory = (typeof ACCOUNT_FS_CATEGORIES)[number];
export type AccountTypeName = (typeof ACCOUNT_TYPES)[number];

/**
 * Typed as a total record on purpose: a thirteenth value added to the CHECK
 * (and therefore to `ACCOUNT_FS_CATEGORIES`, which the vocabulary contract ties
 * to Postgres) fails to COMPILE here until somebody says which section it
 * belongs to. That is stronger than discovering it at run time.
 */
const SECTION_OF_CATEGORY: Record<FsCategory, StatementSection> = {
  current_assets: 'assets',
  non_current_assets: 'assets',
  current_liabilities: 'liabilities',
  long_term_liabilities: 'liabilities',
  equity: 'equity',
  ori: 'equity',
  revenue: 'income',
  other_income: 'income',
  cogs: 'expenses',
  operating_expenses: 'expenses',
  other_expenses: 'expenses',
  tax: 'expenses',
};

/** The same partition, as `account_type` already draws it. */
const SECTION_OF_TYPE: Record<AccountTypeName, StatementSection> = {
  asset: 'assets',
  contra_asset: 'assets',
  liability: 'liabilities',
  contra_liability: 'liabilities',
  equity: 'equity',
  contra_equity: 'equity',
  revenue: 'income',
  expense: 'expenses',
};

export function sectionOfCategory(fs: string | null | undefined): StatementSection | null {
  if (!fs) return null;
  return SECTION_OF_CATEGORY[fs as FsCategory] ?? null;
}

export function sectionOfType(type: string | null | undefined): StatementSection | null {
  if (!type) return null;
  return SECTION_OF_TYPE[type as AccountTypeName] ?? null;
}

/**
 * The map's independent check: an account's own category and its own type must
 * land in the same section. Holds for 54 of the 54 accounts the house seeds,
 * and unlike the parent-child count it says something about EVERY row.
 */
export function coherenceOfOwnRow(accountType: string | null, fs: string | null): boolean {
  const byType = sectionOfType(accountType);
  const byCategory = sectionOfCategory(fs);
  if (byType === null || byCategory === null) return true;
  return byType === byCategory;
}

export const COHERENCE_POLICY_KEY = 'catalogo_coherencia_padre_hijo';
export const COHERENCE_DEFAULT = 'exigir_misma_seccion';

export interface CoherenceCriterion {
  value: string;
  /** Refuse the write. */
  blocks: boolean;
  /** Name it without refusing. */
  warns: boolean;
}

export function asCoherenceCriterion(value: string): CoherenceCriterion {
  switch (value) {
    case 'sin_regla':
      return { value, blocks: false, warns: false };
    case 'advertir_misma_seccion':
      return { value, blocks: false, warns: true };
    // The default and anything the panel does not recognise: the conservative
    // reading, which is the only one under which a signed statement cannot
    // carry a figure in the wrong section without anyone having chosen it.
    default:
      return { value, blocks: true, warns: true };
  }
}

/**
 * Reads the firm's criterion. Fails OPEN — with the declared default — rather
 * than letting a policy lookup break the creation of an account: the panel
 * decides how strict the rule is, never whether the catalogue can be written.
 */
export async function coherenceCriterion(
  tenantId: string,
  entityId: string
): Promise<CoherenceCriterion> {
  try {
    const policy = await getPolicy({ tenantId, entityId }, COHERENCE_POLICY_KEY);
    return asCoherenceCriterion(policy.value);
  } catch {
    return asCoherenceCriterion(COHERENCE_DEFAULT);
  }
}

export interface CoherenceBreach {
  childCode: string;
  childCategory: string;
  parentCode: string;
  parentCategory: string;
  childSection: StatementSection;
  parentSection: StatementSection;
}

/**
 * Judges ONE edge. Returns null when there is nothing to judge — either side
 * without a category, or a category outside the map — and the breach otherwise.
 */
export function breachOfEdge(
  child: { code: string; fs_category: string | null },
  parent: { code: string; fs_category: string | null }
): CoherenceBreach | null {
  const childSection = sectionOfCategory(child.fs_category);
  const parentSection = sectionOfCategory(parent.fs_category);
  if (childSection === null || parentSection === null) return null;
  if (childSection === parentSection) return null;
  return {
    childCode: child.code,
    childCategory: child.fs_category as string,
    parentCode: parent.code,
    parentCategory: parent.fs_category as string,
    childSection,
    parentSection,
  };
}

export function breachMessage(b: CoherenceBreach): string {
  return (
    `La cuenta ${b.childCode} (${b.childCategory}) quedaría en la sección «${b.childSection}» ` +
    `colgando de ${b.parentCode} (${b.parentCategory}), que está en «${b.parentSection}»: ` +
    'el importe saldría en una sección distinta de la de su padre en un estado que alguien firma. ' +
    `Corrige la categoría, o cambia el criterio ${COHERENCE_POLICY_KEY} en el panel de políticas.`
  );
}
