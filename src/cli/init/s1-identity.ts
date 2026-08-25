import path from 'node:path';
import { query, withTransaction, enterTenant } from '../../database/connection.js';
import { checkEntities } from '../../ai/doctor-service.js';
import { ensureEntityAccounting } from '../../services/accounting/entity-accounting.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import { upsertEnvVar } from './s0-infra.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S1 · IDENTITY: tenant, organization, legal entity and fiscal year
// Sets MNEMOSINE_TENANT in .env so that RLS scopes from
// startup, not after the first query.
// ============================================================

const CATALOGS = {
  MX: { currency: 'MXN', standard: 'mx_nif', taxIdType: 'rfc', entityType: 'sa' },
  USA: { currency: 'USD', standard: 'us_gaap', taxIdType: 'ein', entityType: 'corporation' },
} as const;

type Country = keyof typeof CATALOGS;

export interface IdentidadDeps {
  cwd?: string;
}

export class IdentidadSection implements SetupSection {
  readonly id = 'identidad' as const;
  readonly title = 'Fiscal identity (tenant, legal entity, fiscal year)';
  readonly required = true;

  constructor(private readonly deps: IdentidadDeps = {}) {}

  async status(): Promise<SectionStatus> {
    const r = await query<{ entities: string; periods: string }>(
      `SELECT (SELECT count(*)::text FROM legal_entities WHERE is_active) AS entities,
              (SELECT count(*)::text FROM fiscal_periods) AS periods`
    );
    const entities = parseInt(r.rows[0].entities, 10);
    if (entities === 0) return 'missing';
    // An entity without fiscal periods cannot post anything: it is half done.
    return parseInt(r.rows[0].periods, 10) === 0 ? 'partial' : 'ok';
  }

  async verify(): Promise<CheckResult[]> {
    const checks: CheckResult[] = [await checkEntities()];
    const p = await query<{ n: string }>(
      `SELECT count(*)::text n FROM fiscal_periods WHERE status IN ('open','future')`
    );
    const open = parseInt(p.rows[0].n, 10);
    checks.push(
      open === 0
        ? {
            name: 'Fiscal year',
            level: 'fail',
            detail: 'no open periods: no journal entry can be posted',
            fix: 'mnemosine init --section identity',
          }
        : { name: 'Fiscal year', level: 'ok', detail: `${open} period(s) available` }
    );
    return checks;
  }

  async configure(ctx: SectionContext): Promise<void> {
    const existing = await query<{ id: string; name: string; tax_id: string; tenant_id: string }>(
      `SELECT id, name, tax_id, tenant_id FROM legal_entities WHERE is_active ORDER BY name`
    );

    if (existing.rows.length > 0) {
      ctx.print(`  There are already ${existing.rows.length} entity(ies):`);
      for (const e of existing.rows) ctx.print(`    · ${e.name} (${e.tax_id})`);
      const add = await ctx.confirm('  Add another entity?', false);
      if (!add) {
        // Pin the tenant of the first one so RLS stays active.
        this.persistTenant(existing.rows[0].tenant_id, ctx);
        await this.ensureFiscalYear(existing.rows[0].id, ctx);
        await this.ensureContabilidad(existing.rows[0].id, existing.rows[0].tenant_id, ctx);
        return;
      }
    }

    const name = ctx.flags.entity ?? (await ctx.askText('  Legal entity name: '));
    if (!name) {
      ctx.print('  Without a name I cannot create the entity; section incomplete.');
      return;
    }
    const countryRaw = (ctx.flags.country ?? (await ctx.askText('  Country [MX/USA] (MX): ')) ?? 'MX')
      .toUpperCase();
    const country: Country = countryRaw === 'USA' ? 'USA' : 'MX';
    const cat = CATALOGS[country];
    const taxLabel = country === 'MX' ? 'RFC' : 'EIN';
    const taxId = ctx.flags.rfc ?? (await ctx.askText(`  ${taxLabel}: `));
    if (!taxId) {
      ctx.print(`  Without ${taxLabel} I cannot create the entity; section incomplete.`);
      return;
    }
    const currency = ctx.flags.currency ?? cat.currency;

    const created = await this.createEntity({ name, taxId, country, currency, cat });
    this.persistTenant(created.tenantId, ctx);
    ctx.print(`  ✔ Entity "${name}" created (${taxId}, ${country}, ${currency})`);
    await this.ensureFiscalYear(created.entityId, ctx);
    await this.ensureContabilidad(created.entityId, created.tenantId, ctx);
  }

  /** Pins the tenant in .env and in the process: RLS scopes from startup. */
  private persistTenant(tenantId: string, ctx: SectionContext): void {
    const envPath = path.join(this.deps.cwd ?? process.cwd(), '.env');
    upsertEnvVar(envPath, 'MNEMOSINE_TENANT', tenantId);
    process.env.MNEMOSINE_TENANT = tenantId;
    enterTenant(tenantId);
    ctx.print(`  ✔ Tenant pinned in .env (RLS isolation active)`);
  }

  private async createEntity(input: {
    name: string; taxId: string; country: Country; currency: string;
    cat: typeof CATALOGS[Country];
  }): Promise<{ tenantId: string; entityId: string }> {
    return withTransaction(async (client) => {
      // Reuse the existing tenant if there is one already; creating a new one
      // per entity would break the expected isolation (one company = one tenant).
      const t = await client.query<{ id: string }>(
        `SELECT id FROM public.tenants ORDER BY created_at ASC LIMIT 1`
      );
      let tenantId = t.rows[0]?.id;
      if (!tenantId) {
        const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const nt = await client.query<{ id: string }>(
          `INSERT INTO public.tenants (name, subdomain, schema_name, plan)
           VALUES ($1, $2, 'public', 'professional') RETURNING id`,
          [input.name, slug || 'principal']
        );
        tenantId = nt.rows[0].id;
      }

      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (tenant_id, name, type)
         VALUES ($1, $2, 'operating') RETURNING id`,
        [tenantId, input.name]
      );

      const ent = await client.query<{ id: string }>(
        `INSERT INTO legal_entities (
           organization_id, tenant_id, name, entity_type, tax_id, tax_id_type,
           incorporation_country, functional_currency, accounting_standard
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          org.rows[0].id, tenantId, input.name, input.cat.entityType,
          input.taxId.toUpperCase(), input.cat.taxIdType,
          input.country, input.currency, input.cat.standard,
        ]
      );
      return { tenantId, entityId: ent.rows[0].id };
    });
  }

  /**
   * Chart of accounts + account_roles. Without this an entity cannot post a
   * single invoice: postInvoiceEntry and friends resolve their accounts
   * through account_roles, and nothing used to populate that table — the
   * error message even claimed `mnemosine init` did.
   *
   * 'auto': a brand-new entity gets the full base chart; one that arrived
   * through onboarding keeps its own and only gets its roles mapped.
   */
  private async ensureContabilidad(
    entityId: string,
    tenantId: string,
    ctx: SectionContext
  ): Promise<void> {
    // El asistente no tiene usuario en sesión: las secciones posteriores son
    // las que crean usuarios. Se atribuye a la propia entidad, igual que hace
    // el resto del alta, y queda trazado en created_by.
    const r = await ensureEntityAccounting(entityId, tenantId, entityId, { estrategia: 'auto' });
    if (r.cuentasBaseCreadas.length > 0) {
      ctx.print(`  ✔ Chart of accounts seeded (${r.cuentasBaseCreadas.length} accounts)`);
    } else if (r.teniaCatalogo) {
      ctx.print('  ✔ Chart of accounts already present — kept as is');
    }
    if (r.accountsCreated.length > 0) {
      ctx.print(`  ✔ Control accounts added (${r.accountsCreated.length})`);
    }
    if (r.rolesMapped > 0) {
      ctx.print(`  ✔ Account roles mapped (${r.rolesMapped})`);
    }
    if (r.unmapped.length > 0) {
      ctx.print(`  ⚠ ${r.unmapped.length} role(s) without an account in this chart:`);
      for (const u of r.unmapped.slice(0, 6)) ctx.print(`      ${u.role} → expected code ${u.code}`);
      ctx.print('      Map them with: mnemosine doctor');
    }
  }

  /** Current fiscal year with 12 monthly periods: without this nothing posts. */
  private async ensureFiscalYear(entityId: string, ctx: SectionContext): Promise<void> {
    const year = new Date().getFullYear();
    const existing = await query<{ n: string }>(
      `SELECT count(*)::text n FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE fp.entity_id = $1 AND fy.year_number = $2`,
      [entityId, year]
    );
    if (parseInt(existing.rows[0].n, 10) > 0) {
      ctx.print(`  ✔ Fiscal year ${year} already has periods`);
      return;
    }

    await withTransaction(async (client) => {
      const fy = await client.query<{ id: string }>(
        `INSERT INTO fiscal_years (entity_id, year_number, start_date, end_date, is_calendar_year, status)
         VALUES ($1, $2, $3, $4, true, 'open') RETURNING id`,
        [entityId, year, `${year}-01-01`, `${year}-12-31`]
      );
      const now = new Date();
      for (let m = 1; m <= 12; m++) {
        const start = new Date(Date.UTC(year, m - 1, 1));
        const end = new Date(Date.UTC(year, m, 0));
        // The current month and past ones stay open; future ones, 'future'.
        const status = end < now ? 'open' : m - 1 === now.getMonth() ? 'open' : 'future';
        await client.query(
          `INSERT INTO fiscal_periods (
             entity_id, fiscal_year_id, period_number, period_name,
             start_date, end_date, period_type, status
           ) VALUES ($1,$2,$3,$4,$5,$6,'regular',$7)`,
          [
            entityId, fy.rows[0].id, m,
            // Period names are stored, not translated at render time; the CLI UI is
            // English, so they are minted in English to avoid "enero 2026" inside it.
            start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + ` ${year}`,
            start.toISOString().split('T')[0], end.toISOString().split('T')[0], status,
          ]
        );
      }
    });
    ctx.print(`  ✔ Fiscal year ${year} created with 12 monthly periods`);
  }
}
