import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { ConflictError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, type AccionAuditada } from '../audit/audit-log.js';
import { sqlKeepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { getPolicy, type PolicyContext } from '../policy/policy-service.js';
import { REQUIRED_ACCOUNTS, type AccountSpec } from '../xml-ingestion/account-roles-seed.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';

// ============================================================
// WHERE THE ENTITY'S WITHHOLDINGS ACCUMULATE (#309, MNE-001-147)
//
// The owner's decision of 2026-09-29: the accounts for the ISR and VAT the
// entity withholds as payer are a panel answer (`withholding_accounts_layout`),
// and what happens to an entity whose roles do not follow it is another
// (`withholding_accounts_existing`). Payroll ISR stays on 2140 in every layout.
//
// A layout is a set of role mappings. The lease/fees split of ISR uses the
// qualifier column of account_roles: the classifier asks for the 'lease'
// variant on a lease and falls back to the default mapping otherwise, so a
// layout that does not split ISR needs no qualified row at all.
//
// Same shape as account-roles-backfill.ts: the census does not write, the
// plan of each entity is applied in one transaction with an audit row per
// change, and a mapping someone set by hand is never overwritten. Nothing
// here posts an entry: balances already on an account stay there.
// ============================================================

const LAYOUT_KEY = 'withholding_accounts_layout';
const EXISTING_KEY = 'withholding_accounts_existing';
export const LEASE_QUALIFIER = 'lease';
const ISR: AccountRole = 'isr_retenido_por_pagar';
const VAT: AccountRole = 'iva_retenido_por_pagar';

export type WithholdingLayout = 'per_tax' | 'single' | 'by_concept';

interface Target { role: AccountRole; qualifier: string | null; code: string; groupingCode?: string }

/** Default mapping first in each role: a qualified row falls back to it. */
export const WITHHOLDING_LAYOUTS: Readonly<Record<WithholdingLayout, readonly Target[]>> = {
  per_tax: [
    { role: ISR, qualifier: null, code: '2141' },
    { role: ISR, qualifier: LEASE_QUALIFIER, code: '2141' },
    { role: VAT, qualifier: null, code: '2142' },
  ],
  single: [
    { role: ISR, qualifier: null, code: '2143' },
    { role: ISR, qualifier: LEASE_QUALIFIER, code: '2143' },
    { role: VAT, qualifier: null, code: '2143' },
  ],
  // The SAT grouping code (c_CodAgrup) names these three lines; ISR withheld
  // on anything that is not a lease is booked as professional services, the
  // RESICO 1.25 % (LISR 113-J) included; a RESICO real-estate lease is a lease
  // (withholdingQualifierOf).
  by_concept: [
    { role: ISR, qualifier: null, code: '2145', groupingCode: '216.04' },
    { role: ISR, qualifier: LEASE_QUALIFIER, code: '2144', groupingCode: '216.03' },
    { role: VAT, qualifier: null, code: '2142', groupingCode: '216.10' },
  ],
};

const LIABILITY = { account_type: 'liability', normal_balance: 'credit', fs_category: 'current_liabilities' } as const;
const LAYOUT_ACCOUNTS: readonly AccountSpec[] = [
  ...REQUIRED_ACCOUNTS.filter((a) => a.code === '2141' || a.code === '2142'),
  {
    code: '2143', name: 'ISR e IVA Retenidos por Enterar', ...LIABILITY,
    description: 'ISR e IVA retenidos a proveedores, pendientes de enterar el día 17, en una sola cuenta.',
  },
  {
    code: '2144', name: 'ISR Retenido por Arrendamiento', ...LIABILITY,
    description: 'ISR retenido a personas físicas por el uso de inmuebles (LISR 116), pendiente de enterar el día 17.',
  },
  {
    code: '2145', name: 'ISR Retenido por Servicios Profesionales', ...LIABILITY,
    description: 'ISR retenido a personas físicas por servicios profesionales (LISR 106), pendiente de enterar el día 17.',
  },
];

/** The codes this system ever pointed the role at: 2140 before MNE-001-056, and every layout's. */
function seededCodes(role: AccountRole): Set<string> {
  const codes = Object.values(WITHHOLDING_LAYOUTS).flat().filter((t) => t.role === role).map((t) => t.code);
  return new Set(['2140', ...codes]);
}

export interface RoleMove {
  /** null: the qualified mapping does not exist yet and is created. */
  roleId: string | null;
  role: AccountRole;
  qualifier: string | null;
  fromAccountId: string | null;
  fromCode: string | null;
  toCode: string;
}

export interface WithholdingPlan {
  entityId: string;
  entityName: string;
  tenantId: string;
  layout: string;
  existing: string;
  create: string[];
  moves: RoleMove[];
  groupingCodes: Array<{ code: string; value: string }>;
  /** Mappings set by hand, or to an account no layout uses: never moved. */
  kept: Array<{ role: string; qualifier: string | null; code: string }>;
  /** Why the plan cannot be applied at all; null when it can. */
  blocked: string | null;
}

export const hasWork = (p: WithholdingPlan): boolean =>
  p.create.length + p.moves.length + p.groupingCodes.length > 0;

/** What doctor and the close checklist warn about: never under "keep". */
export const needsSync = (p: WithholdingPlan): boolean =>
  p.existing !== 'keep' && (hasWork(p) || p.blocked !== null);

type Q = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => Promise<pg.QueryResult<T>>;

/** Read-only: the plan of every active Mexican entity in scope. */
export async function censusWithholdingLayout(
  scope: { tenantId?: string; entityId?: string },
  client?: pg.PoolClient
): Promise<WithholdingPlan[]> {
  const q: Q = client ? (sql, params) => client.query(sql, params) : query;
  const entities = await q<{ id: string; name: string; tenant_id: string }>(
    `SELECT le.id, le.name, le.tenant_id FROM legal_entities le
      WHERE le.is_active AND ${sqlKeepsMexicanBooks('le')}
        AND ($1::uuid IS NULL OR le.tenant_id = $1::uuid) AND ($2::uuid IS NULL OR le.id = $2::uuid)
      ORDER BY le.name`,
    [scope.tenantId ?? null, scope.entityId ?? null]
  );
  const plans: WithholdingPlan[] = [];
  for (const e of entities.rows) plans.push(await planFor(q, e, client));
  return plans;
}

async function planFor(
  q: Q,
  e: { id: string; name: string; tenant_id: string },
  client?: pg.PoolClient
): Promise<WithholdingPlan> {
  const ctx = { tenantId: e.tenant_id, entityId: e.id };
  const plan: WithholdingPlan = {
    entityId: e.id, entityName: e.name, tenantId: e.tenant_id,
    layout: (await getPolicy(ctx, LAYOUT_KEY, client)).value,
    existing: (await getPolicy(ctx, EXISTING_KEY, client)).value,
    create: [], moves: [], groupingCodes: [], kept: [], blocked: null,
  };
  if (!Object.prototype.hasOwnProperty.call(WITHHOLDING_LAYOUTS, plan.layout)) {
    plan.blocked = `${LAYOUT_KEY} = "${plan.layout}" is not a layout this system knows (${Object.keys(WITHHOLDING_LAYOUTS).join(' | ')})`;
    return plan;
  }
  const targets = WITHHOLDING_LAYOUTS[plan.layout as WithholdingLayout];
  // A mapping is manual when someone other than this module changed it
  // (`account role set` audits without the layout marker), or when it points
  // at an account no layout ever used.
  const rows = (await q<{ id: string; role: string; qualifier: string | null; account_id: string; code: string; manual: boolean }>(
    `SELECT ar.id, ar.role, ar.qualifier, ar.account_id, a.code,
            EXISTS (SELECT 1 FROM audit_log al
                     WHERE al.entity_type = 'account_role' AND al.entity_id = ar.id AND al.tenant_id = ar.tenant_id
                       AND NOT (COALESCE(al.new_values, '{}'::jsonb) ? 'withholding_layout')) AS manual
       FROM account_roles ar JOIN accounts a ON a.id = ar.account_id AND a.entity_id = ar.entity_id
      WHERE ar.entity_id = $1 AND ar.tenant_id = $2 AND ar.role = ANY($3::text[])
        AND (ar.qualifier IS NULL OR ar.qualifier = $4)`,
    [e.id, e.tenant_id, [ISR, VAT], LEASE_QUALIFIER]
  )).rows;
  const accounts = new Map((await q<{ code: string; usable: boolean; grouping: string | null }>(
    `SELECT code, (is_active AND NOT is_header AND account_type = 'liability') AS usable,
            codigo_agrupador_sat AS grouping
       FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
    [e.id, targets.map((t) => t.code)]
  )).rows.map((a) => [a.code, a]));

  const keptRoles = new Set<string>();
  for (const t of targets) {
    const row = rows.find((r) => r.role === t.role && r.qualifier === t.qualifier);
    const fallback = targets.find((x) => x.role === t.role && x.qualifier === null)?.code;
    // No default mapping is `account role seed`'s business; a missing lease
    // variant is right whenever the default already resolves to its account.
    if (!row && (t.qualifier === null || t.code === fallback)) continue;
    if (row?.code !== t.code) {
      if (keptRoles.has(t.role) || (row && (row.manual || !seededCodes(t.role).has(row.code)))) {
        keptRoles.add(t.role);
        if (row) plan.kept.push({ role: t.role, qualifier: t.qualifier, code: row.code });
        continue;
      }
      plan.moves.push({
        roleId: row?.id ?? null, role: t.role, qualifier: t.qualifier,
        fromAccountId: row?.account_id ?? null, fromCode: row?.code ?? null, toCode: t.code,
      });
    }
    const account = accounts.get(t.code);
    if (!account) {
      if (!plan.create.includes(t.code)) plan.create.push(t.code);
    } else if (!account.usable) {
      plan.blocked = `${t.code} exists but is not an active liability account that takes postings`;
    } else if (t.groupingCode && account.grouping === null && !plan.groupingCodes.some((g) => g.code === t.code)) {
      plan.groupingCodes.push({ code: t.code, value: t.groupingCode });
    }
  }
  return plan;
}

/** One line per change, for the dry run, doctor, the checklist and `closing explain`. */
export function describeWithholdingPlan(p: WithholdingPlan): string[] {
  const name = (role: string, qualifier: string | null) => (qualifier ? `${role}[${qualifier}]` : role);
  return [
    ...(p.blocked ? [`cannot apply: ${p.blocked}`] : []),
    ...p.create.map((code) => `create ${code} ${LAYOUT_ACCOUNTS.find((a) => a.code === code)?.name ?? ''}`.trim()),
    ...p.moves.map((m) => `${name(m.role, m.qualifier)}: ${m.fromCode ?? 'default'} → ${m.toCode}`),
    ...p.groupingCodes.map((g) => `${g.code} grouping code → ${g.value}`),
    ...p.kept.map((k) => `${name(k.role, k.qualifier)} stays on ${k.code} (set by hand)`),
  ];
}

/**
 * Applies one entity's plan in one transaction (the caller's, when given).
 * Every UPDATE is guarded by the state the census saw: a mapping someone
 * changed in between aborts the entity instead of being overwritten.
 */
export async function applyWithholdingLayout(
  plan: WithholdingPlan,
  actorId: string,
  client?: pg.PoolClient
): Promise<void> {
  if (plan.blocked) throw new ValidationError(`${plan.entityName}: ${plan.blocked}`);
  const targets = WITHHOLDING_LAYOUTS[plan.layout as WithholdingLayout];
  const run = async (c: pg.PoolClient): Promise<void> => {
    const audit = (action: AccionAuditada, entityType: string, id: string, oldValues: object | null, newValues: object) =>
      registrarAuditoria(c, {
        tenantId: plan.tenantId, legalEntityId: plan.entityId, userId: actorId, action, entityType, entityId: id,
        oldValues: oldValues as Record<string, unknown> | null,
        newValues: { ...newValues, withholding_layout: plan.layout },
        reason: `MNE-001-147 (#309): withholding roles follow ${LAYOUT_KEY} = ${plan.layout}`,
      });
    const stale = (what: string) =>
      new ConflictError(`${plan.entityName}: ${what} changed since the plan was made; nothing was applied, run it again.`);

    for (const code of plan.create) {
      const spec = LAYOUT_ACCOUNTS.find((a) => a.code === code) as AccountSpec;
      const grouping = targets.find((t) => t.code === code)?.groupingCode ?? null;
      const ins = await c.query<{ id: string }>(
        `INSERT INTO accounts (code, name, account_type, normal_balance, fs_category, description,
           entity_id, allow_manual_entries, is_header, created_by, codigo_agrupador_sat)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, false, $8, $9) RETURNING id`,
        [code, spec.name, spec.account_type, spec.normal_balance, spec.fs_category ?? null,
          spec.description, plan.entityId, actorId, grouping]
      );
      await audit('create', 'account', ins.rows[0].id, null, { code, name: spec.name, codigo_agrupador_sat: grouping });
    }
    for (const g of plan.groupingCodes) {
      const u = await c.query<{ id: string }>(
        `UPDATE accounts SET codigo_agrupador_sat = $1, updated_at = NOW()
          WHERE entity_id = $2 AND code = $3 AND codigo_agrupador_sat IS NULL RETURNING id`,
        [g.value, plan.entityId, g.code]
      );
      if (u.rowCount !== 1) throw stale(`the grouping code of ${g.code}`);
      await audit('update', 'account', u.rows[0].id, { code: g.code, codigo_agrupador_sat: null }, { code: g.code, codigo_agrupador_sat: g.value });
    }
    const ids = await c.query<{ id: string; code: string }>(
      'SELECT id, code FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])',
      [plan.entityId, plan.moves.map((m) => m.toCode)]
    );
    for (const m of plan.moves) {
      const to = ids.rows.find((r) => r.code === m.toCode)?.id;
      const r = m.roleId
        ? await c.query<{ id: string }>(
          `UPDATE account_roles SET account_id = $1, updated_at = NOW()
            WHERE id = $2 AND entity_id = $3 AND tenant_id = $4 AND account_id = $5 RETURNING id`,
          [to, m.roleId, plan.entityId, plan.tenantId, m.fromAccountId]
        )
        : await c.query<{ id: string }>(
          `INSERT INTO account_roles (tenant_id, entity_id, role, qualifier, account_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
          [plan.tenantId, plan.entityId, m.role, m.qualifier, to]
        );
      if (r.rowCount !== 1) throw stale(`the mapping of ${m.role}${m.qualifier ? `[${m.qualifier}]` : ''}`);
      await audit(
        m.roleId ? 'update' : 'create', 'account_role', r.rows[0].id,
        m.roleId ? { role: m.role, qualifier: m.qualifier, account_id: m.fromAccountId, code: m.fromCode } : null,
        { role: m.role, qualifier: m.qualifier, account_id: to, code: m.toCode }
      );
    }
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * Called by `resolvePolicy` after either key is set. Under "repoint" it
 * applies the plan of every entity in scope that needs one, signed by whoever
 * answered; without an active user by that email or id nothing moves and
 * doctor keeps warning. Returns what happened, one line per entity.
 */
export async function followWithholdingPolicy(ctx: PolicyContext, resolvedBy: string): Promise<string[]> {
  const plans = (await censusWithholdingLayout(ctx)).filter((p) => p.existing === 'repoint' && needsSync(p));
  if (plans.length === 0) return [];
  const user = await query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = $1 AND is_active = true AND (email = $2 OR id::text = $2) LIMIT 1`,
    [ctx.tenantId, resolvedBy]
  );
  const actor = user.rows[0]?.id;
  const notes: string[] = [];
  for (const p of plans) {
    try {
      if (!actor) throw new ValidationError(`"${resolvedBy}" is not an active user of this tenant who can sign the change`);
      await applyWithholdingLayout(p, actor);
      notes.push(`${p.entityName}: withholding roles repointed (${describeWithholdingPlan(p).join('; ')})`);
    } catch (err) {
      notes.push(`${p.entityName}: not repointed, ${(err as Error).message}. Run: mnemosine account role sync --dry-run`);
    }
  }
  return notes;
}
