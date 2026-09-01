import path from 'node:path';
import { query, withTransaction, enterTenant } from '../../database/connection.js';
import { checkEntities } from '../../ai/doctor-service.js';
import { ensureEntityAccounting } from '../../services/accounting/entity-accounting.js';
import { createEntity as createEntityService } from '../../services/entity/entity-service.js';
import { ensureFiscalYear } from '../../services/accounting/fiscal-calendar-service.js';
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
    // Acotado al inquilino fijado, si lo hay. Sin el filtro, una instalación
    // con varios despachos listaba las entidades de todos y adoptaba el
    // inquilino de la PRIMERA POR NOMBRE, que no tiene por qué ser la del
    // usuario que está corriendo el asistente.
    const fijado = process.env.MNEMOSINE_TENANT || null;
    const existing = await query<{ id: string; name: string; tax_id: string; tenant_id: string }>(
      `SELECT id, name, tax_id, tenant_id FROM legal_entities
        WHERE is_active AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
        ORDER BY name`,
      [fijado]
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

  /**
   * El alta delega en services/entity/entity-service.
   *
   * El asistente tenía su propio camino y con él dos defectos que el
   * servicio no comete:
   *
   *  · Elegía el inquilino con `ORDER BY created_at ASC LIMIT 1`, o sea que
   *    en una instalación con varios metía la empresa nueva en el MÁS VIEJO
   *    —los libros de otro despacho— sin decir nada. El servicio se niega y
   *    los lista para que alguien elija.
   *  · Atribuía la creación a la propia entidad. El servicio resuelve un
   *    usuario de sistema real, que es lo que `created_by` necesita para
   *    significar algo.
   */
  private async createEntity(input: {
    name: string; taxId: string; country: Country; currency: string;
    cat: typeof CATALOGS[Country];
  }): Promise<{ tenantId: string; entityId: string }> {
    const r = await createEntityService({
      name: input.name,
      taxId: input.taxId,
      country: input.country,
      currency: input.currency,
      // Si el asistente ya fijó inquilino —o venía de .env— se respeta; si no,
      // el servicio decide, y con varios exige elegir en vez de adivinar.
      tenantId: process.env.MNEMOSINE_TENANT || undefined,
    });
    return { tenantId: r.tenantId, entityId: r.entityId };
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

  /**
   * Current fiscal year with 12 monthly periods: without this nothing posts.
   * The calendar itself now lives in services/accounting/fiscal-calendar-service.ts,
   * so `mnemosine year create` builds exactly the same one for any other year
   * instead of the wizard being the only way to get a calendar.
   */
  private async ensureFiscalYear(entityId: string, ctx: SectionContext): Promise<void> {
    const year = new Date().getFullYear();
    const result = await ensureFiscalYear(entityId, year);
    if (result.created) {
      ctx.print(`  ✔ Fiscal year ${year} created with 12 monthly periods`);
    } else if (result.periods === 0) {
      // The year row exists but carries no periods, so nothing can be posted.
      // ensureFiscalYear will not fill it in (the INSERT would collide on
      // UNIQUE(entity_id, year_number)); saying "already has periods" here
      // would tick a checkbox for a calendar that does not exist.
      ctx.print(
        `  ! Fiscal year ${year} exists but has no periods — nothing can be posted. ` +
          `Delete the empty fiscal_years row and re-run, or build another year with \`mnemosine year create\`.`
      );
    } else {
      ctx.print(`  ✔ Fiscal year ${year} already has ${result.periods} periods`);
    }
  }
}
