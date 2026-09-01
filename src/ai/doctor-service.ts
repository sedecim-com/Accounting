import fs from 'node:fs';
import path from 'node:path';
import { query } from '../database/connection.js';
import { REQUIRED_BUCKETS } from '../services/payroll/common/payroll-account-mapping-seed.js';
import { config } from '../config/index.js';
import { isLocalHost, defaultSslMode } from '../database/ssl.js';
import { DB_PROVIDERS } from '../database/providers.js';
import { listProfiles } from './providers/config.js';
import { scanOrphans, type Orphan } from './orphan-scan.js';

// ============================================================
// DOCTOR — health diagnostics
// Answers "why isn't it working?" without reading code. Each
// check says what is wrong AND the command that fixes it; never
// just the symptom.
// ============================================================

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  /** Concrete command or action when something is wrong. */
  fix?: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  /** fail = the system cannot operate; warn = operates degraded. */
  worst: CheckLevel;
}

export interface DoctorDeps {
  migrationsDir?: string;
  cwd?: string;
  /** Injectable to test without touching disk or network. */
  now?: Date;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  checks.push(await checkDatabase());
  // Without a database the remaining checks mean nothing.
  if (checks[0].level !== 'fail') {
    checks.push(await checkMigrations(deps));
    checks.push(await checkEntities());
    checks.push(await checkAccountRoles());
    checks.push(...(await checkLookupTables()));
    checks.push(checkOrphanedCapability(deps));
    checks.push(checkConnectionTransport());
    checks.push(await checkConsistenciaCli());
    checks.push(await checkTenantIsolation());
    checks.push(await checkLedgerIntegrity());
    checks.push(await checkReopenedPeriods());
    checks.push(await checkPendingWork());
    checks.push(await checkCredentials(deps.now ?? new Date()));
  }
  checks.push(checkModelProvider(deps.cwd));
  checks.push(checkEncryptionKey());

  const worst: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, worst };
}

export async function checkDatabase(): Promise<CheckResult> {
  try {
    const r = await query<{ v: string }>('SELECT version() AS v');
    const version = r.rows[0].v.split(' ').slice(0, 2).join(' ');
    return { name: 'Database', level: 'ok', detail: version };
  } catch (err) {
    return {
      name: 'Database',
      level: 'fail',
      detail: `no connection: ${(err as Error).message}`,
      fix: 'Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)',
    };
  }
}

export async function checkMigrations(deps: DoctorDeps): Promise<CheckResult> {
  // Anchored to this module, not to process.cwd(): running the CLI from
  // another directory used to report "missing migrations" that were applied.
  // __dirname is src/ai in dev and dist/ai in a build; both resolve correctly.
  const dir = deps.migrationsDir ?? path.join(__dirname, '../database/migrations');
  let onDisk: string[] = [];
  try {
    onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return { name: 'Migrations', level: 'warn', detail: `could not read ${dir}` };
  }

  const applied = await query<{ filename: string }>('SELECT filename FROM public.migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));
  const missing = onDisk.filter((f) => !appliedSet.has(f));

  if (missing.length > 0) {
    return {
      name: 'Migrations',
      level: 'fail',
      detail: `${missing.length} unapplied: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`,
      fix: 'npm run migrate',
    };
  }
  return { name: 'Migrations', level: 'ok', detail: `${appliedSet.size} applied` };
}

export async function checkEntities(): Promise<CheckResult> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text n FROM legal_entities WHERE is_active = true`
  );
  const n = parseInt(r.rows[0].n, 10);
  if (n === 0) {
    return {
      name: 'Legal entities',
      level: 'fail',
      detail: 'no active entities',
      fix: 'mnemosine init  (or npm run seed for demo data)',
    };
  }
  return { name: 'Legal entities', level: 'ok', detail: `${n} active` };
}


/**
 * Los account_roles traducen semántica contable («cxc», «iva_acreditable») a
 * un código de cuenta. Sin ellos, la primera factura de una entidad falla con
 * MISSING_ROLE_ACCOUNT y no hay forma de saberlo hasta que ocurre. Este
 * chequeo lo dice antes.
 */
export async function checkAccountRoles(): Promise<CheckResult> {
  const r = await query<{ entidad: string; nombre: string; mapeados: string; total: string }>(
    `SELECT e.id AS entidad, e.name AS nombre,
            count(ar.role)::text AS mapeados,
            (SELECT count(*)::text FROM account_roles WHERE entity_id = e.id AND qualifier IS NULL) AS total
     FROM legal_entities e
     LEFT JOIN account_roles ar ON ar.entity_id = e.id AND ar.qualifier IS NULL
     WHERE e.is_active = true
     GROUP BY e.id, e.name`
  );
  if (r.rows.length === 0) {
    return { name: 'Account roles', level: 'ok', detail: 'no active entities to check' };
  }
  const sinSembrar = r.rows.filter((x) => parseInt(x.mapeados, 10) === 0);
  if (sinSembrar.length > 0) {
    return {
      name: 'Account roles',
      level: 'fail',
      detail: `${sinSembrar.length} entity(ies) without account roles: ${sinSembrar
        .map((x) => x.nombre)
        .slice(0, 3)
        .join(', ')} — invoices and bills cannot post`,
      fix: 'mnemosine init --section identity',
    };
  }
  // Some roles mapped is not the same as the right ones mapped. The four IVA
  // roles are load-bearing in Mexico: without all four, a PUE document, a PPD
  // document or the release on payment throws MISSING_ROLE_ACCOUNT — and which
  // of the three breaks depends on how the entity's chart was created, so the
  // failure surfaces at the worst possible moment instead of at setup.
  const ivaFaltante = await query<{ nombre: string; faltantes: string }>(
    `SELECT e.name AS nombre,
            (SELECT string_agg(rol, ', ') FROM unnest($1::text[]) AS rol
              WHERE NOT EXISTS (
                SELECT 1 FROM account_roles ar
                 WHERE ar.entity_id = e.id AND ar.role = rol AND ar.qualifier IS NULL)) AS faltantes
     FROM legal_entities e
     WHERE e.is_active = true AND e.incorporation_country = 'MX'`,
    [IVA_ROLES]
  );
  const incompletas = ivaFaltante.rows.filter((x) => x.faltantes);
  if (incompletas.length > 0) {
    return {
      name: 'Account roles',
      level: 'fail',
      detail:
        `${incompletas.length} Mexican entity(ies) missing IVA roles: ` +
        incompletas.map((x) => `${x.nombre} → ${x.faltantes}`).slice(0, 3).join('; ') +
        ' — cash-basis IVA cannot post without all four',
      fix: 'mnemosine init --section identity  (re-seeds the roles idempotently)',
    };
  }

  const total = r.rows.reduce((n, x) => n + parseInt(x.mapeados, 10), 0);
  return {
    name: 'Account roles',
    level: 'ok',
    detail: `${total} role(s) mapped across ${r.rows.length} entity(ies)`,
  };
}

/**
 * Mexico credits IVA on payment, so a document needs both the "pending" and
 * the "due" account of its side. All four, or the ledger cannot express the
 * treatment the law requires.
 */
export const IVA_ROLES = [
  'iva_acreditable', 'iva_pendiente_acreditar',
  'iva_trasladado', 'iva_trasladado_no_cobrado',
] as const;

/**
 * Lookup tables that have a READER and, until recently, no writer anywhere in
 * the repository. Their failure mode is the worst kind: the capability looks
 * present, and the first real use dies deep inside a posting routine with a
 * message about arithmetic or a missing key rather than about configuration.
 *
 * Each entry states what breaks, so the check reports the consequence and not
 * just an empty table. Adding another such table is one row here.
 *
 * `appliesWhen` keeps the check honest: an entity with no employees is not
 * misconfigured for lacking a payroll mapping, and reporting it as broken
 * would train people to ignore doctor.
 */
interface LookupTableSpec {
  table: string;
  label: string;
  /** Nothing to configure unless this returns rows for the entity. */
  appliesWhen?: { table: string; where?: string };
  /**
   * Keys that must be present, not merely SOME rows. A partially mapped
   * table is the harder failure to see: it looks configured and dies on the
   * one operation that needs the missing key.
   */
  requiredKeys?: { column: string; values: readonly string[] };
  level: CheckLevel;
  breaks: string;
  fix: string;
}

export const LOOKUP_TABLES: LookupTableSpec[] = [
  {
    table: 'payroll_account_mapping',
    label: 'Payroll GL mapping',
    appliesWhen: { table: 'employees', where: "status = 'active'" },
    requiredKeys: { column: 'bucket', values: REQUIRED_BUCKETS },
    level: 'fail',
    breaks: 'a pay run cannot post — postPayRunToGL throws on the first bucket it cannot resolve',
    fix: 'seedPayrollAccountMapping(entityId, tenantId, country, userId)',
  },
  {
    table: 'sat_code_mappings',
    label: 'SAT product-code mapping',
    appliesWhen: { table: 'xml_documents' },
    level: 'warn',
    breaks:
      'every received CFDI falls through to the historical-pattern guess, so account inference ' +
      'is worse than it needs to be (it still works — this is quality, not a blocker)',
    fix: 'map the ClaveProdServ codes this client actually receives',
  },
  {
    // GRADUADA DESDE LA COMPROBACIÓN ESTÁTICA.
    //
    // El escáner de capacidad huérfana la encontró con dos lectores y ningún
    // escritor en todo el repositorio, y ahí no podía pasar de 'warn': lee
    // sólo el código, y desde el código es imposible saber si ESTA instalación
    // lleva nómina en Estados Unidos. Aquí sí se puede preguntar, y por eso
    // aquí sí puede ser 'fail'.
    //
    // La diferencia con las otras huérfanas es el destinatario: las formas 940
    // y 941 se PRESENTAN. Una tabla vacía no rompe nada visible — hace que la
    // forma declare cero impuesto patronal, que es un dato falso ante el IRS.
    table: 'employer_tax_liabilities',
    label: 'Employer tax liabilities (USA)',
    appliesWhen: { table: 'employees', where: "country_code = 'US' AND status = 'active'" },
    level: 'fail',
    breaks:
      'forms 940 and 941 SUM this table, so with no rows they report ZERO employer tax — ' +
      'a filed return with a false figure, not a missing feature',
    fix: 'the pay run must write the employer side of each tax as it posts; until it does, do not file 940/941',
  },
];

export async function checkLookupTables(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const spec of LOOKUP_TABLES) {
    const applies = spec.appliesWhen;
    const rows = await query<{ nombre: string; n: string }>(
      `SELECT e.name AS nombre,
              (SELECT count(*)::text FROM ${spec.table} t WHERE t.entity_id = e.id) AS n
       FROM legal_entities e
       WHERE e.is_active = true
         ${applies ? `AND EXISTS (SELECT 1 FROM ${applies.table} a WHERE a.entity_id = e.id${applies.where ? ` AND a.${applies.where}` : ''})` : ''}`
    );

    if (rows.rows.length === 0) {
      results.push({
        name: spec.label,
        level: 'ok',
        detail: 'no entity uses this capability yet',
      });
      continue;
    }

    // A table with rows but missing a required key is the harder case to
    // see, so it is checked first and reported by NAME: "no rows" sends
    // someone to seed, "cash_payroll is unmapped" sends them to the one
    // decision they actually have to make.
    if (spec.requiredKeys) {
      const missing = await query<{ nombre: string; faltantes: string }>(
        `SELECT e.name AS nombre,
                (SELECT string_agg(k, ', ') FROM unnest($1::text[]) AS k
                  WHERE NOT EXISTS (
                    SELECT 1 FROM ${spec.table} t
                     WHERE t.entity_id = e.id AND t.${spec.requiredKeys.column} = k)) AS faltantes
         FROM legal_entities e
         WHERE e.is_active = true
           ${applies ? `AND EXISTS (SELECT 1 FROM ${applies.table} a WHERE a.entity_id = e.id${applies.where ? ` AND a.${applies.where}` : ''})` : ''}`,
        [[...spec.requiredKeys.values]]
      );
      const incomplete = missing.rows.filter((r) => r.faltantes);
      if (incomplete.length > 0) {
        results.push({
          name: spec.label,
          level: spec.level,
          detail:
            `${incomplete.length} entity(ies) missing required ${spec.requiredKeys.column}(s): ` +
            incomplete.map((r) => `${r.nombre} → ${r.faltantes}`).slice(0, 3).join('; ') +
            ` — ${spec.breaks}`,
          fix: spec.fix,
        });
        continue;
      }
    }

    const empty = rows.rows.filter((r) => parseInt(r.n, 10) === 0);
    if (empty.length > 0) {
      results.push({
        name: spec.label,
        level: spec.level,
        detail:
          `${empty.length} of ${rows.rows.length} entity(ies) have no ${spec.table} rows ` +
          `(${empty.map((r) => r.nombre).slice(0, 3).join(', ')}) — ${spec.breaks}`,
        fix: spec.fix,
      });
      continue;
    }

    const total = rows.rows.reduce((n, r) => n + parseInt(r.n, 10), 0);
    results.push({
      name: spec.label,
      level: 'ok',
      detail: `${total} row(s) across ${rows.rows.length} entity(ies)`,
    });
  }

  return results;
}

/**
 * The connection's transport: TLS mode and, if configured, the SSH tunnel.
 * `require` is the trap here — it encrypts and verifies nothing, so it reads
 * as protected while leaving a man-in-the-middle wide open.
 */
/**
 * LA AUDITORÍA DE CONSISTENCIA, SOBRE EL BINARIO QUE SE EMBARCA.
 *
 * `auditProgram` existía y nadie la corría contra el programa real: vivía en
 * un fichero de pruebas y cada prueba se construía un árbol de juguete. La
 * primera vez que se ejecutó contra el `program` de verdad dio 40
 * violaciones, ninguna de las cuales había visto nadie.
 *
 * Esas 40 están congeladas en una línea base que sólo puede encoger. Lo que
 * esta comprobación vigila es que no aparezcan NUEVAS: una superficie que se
 * degrada un comando por semana es como se llegó a las 40.
 */
export async function checkConsistenciaCli(): Promise<CheckResult> {
  // Importación PEREZOSA, y no es estilo: doctor-service lo importa el propio
  // CLI (mnemosine → doctor-command → doctor-service), así que un import
  // estático de mnemosine aquí cierra un ciclo de módulos que hoy resuelve
  // por suerte del orden de carga — y arrastraría los SDKs y el readline del
  // CLI a cualquier otro importador de doctor-service. Al diferirlo, el ciclo
  // sólo existe en tiempo de llamada, cuando mnemosine ya terminó de cargar.
  const { program } = await import('../cli/mnemosine.js');
  const { auditarContraLineaBase } = await import('../cli/kernel/audit.js');
  const { nuevas, obsoletas, heredadas } = auditarContraLineaBase(program);

  if (nuevas.length > 0) {
    const m = nuevas
      .slice(0, 3)
      .map((v) => `${v.command}: ${v.detail}`)
      .join(' · ');
    return {
      name: 'CLI consistency',
      level: 'fail',
      detail: `${nuevas.length} violación(es) nuevas — ${m}${nuevas.length > 3 ? ' …' : ''}`,
      fix:
        'La superficie del CLI se mantiene coherente porque cada verbo sale de una lista cerrada y cada ' +
        'bandera del diccionario único. Corrige el comando, o —si el cambio es deliberado— amplía el ' +
        'vocabulario en src/cli/kernel/vocabulary.ts. La línea base de src/cli/kernel/audit.ts NO se amplía.',
    };
  }

  const sobrantes = obsoletas.length > 0
    ? ` · ${obsoletas.length} entrada(s) de la línea base ya no se violan: bórralas`
    : '';
  return {
    name: 'CLI consistency',
    level: heredadas > 0 ? 'warn' : 'ok',
    detail:
      heredadas > 0
        ? `sin violaciones nuevas; quedan ${heredadas} heredadas en la línea base${sobrantes}`
        : `la superficie cumple todas las reglas${sobrantes}`,
    fix:
      heredadas > 0
        ? 'Las heredadas son deuda conocida y congelada: nueve son decisiones de nombre, tres exigen ' +
          'retirar una forma corta ya publicada, y ocho piden que cuatro listados se puedan paginar.'
        : undefined,
  };
}

export function checkConnectionTransport(): CheckResult {
  const url = config.database.url;
  const local = isLocalHost(url);
  const tunneled = Boolean(config.database.tunnel);
  const mode = (config.database.sslMode || defaultSslMode(url)) as string;

  const parts: string[] = [];
  if (config.database.provider) {
    parts.push(`provider ${config.database.provider}`);
  }
  parts.push(tunneled ? 'via SSH tunnel' : local ? 'local' : 'direct');
  parts.push(`sslmode=${mode}`);
  const detail = parts.join(' · ');

  if (!local && mode === 'disable') {
    return {
      name: 'Connection transport',
      level: 'fail',
      detail: `${detail} — credentials and data travel in the clear`,
      fix: 'Set DATABASE_SSL_MODE=verify-full',
    };
  }
  if (!local && mode === 'require') {
    return {
      name: 'Connection transport',
      level: 'warn',
      detail: `${detail} — encrypts but does NOT verify the certificate`,
      fix: 'Set DATABASE_SSL_MODE=verify-full (or verify-ca behind a tunnel)',
    };
  }

  // Provider caveats are the point of the preset: they surface the traps that
  // silently break isolation, like Neon's default role bypassing RLS.
  const preset = config.database.provider ? DB_PROVIDERS[config.database.provider] : undefined;
  return {
    name: 'Connection transport',
    level: 'ok',
    detail,
    ...(preset?.caveats.length ? { fix: preset.caveats[0] } : {}),
  };
}

/**
 * RLS can be enabled yet inert: a SUPERUSER role or one with BYPASSRLS
 * ignores it. Distinguishing that is the difference between believing there
 * is isolation and actually having it.
 */
export async function checkTenantIsolation(): Promise<CheckResult> {
  const r = await query<{ current_user: string; is_super: boolean; bypass: boolean; rls_tables: string }>(
    `SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
            (SELECT count(*)::text FROM pg_tables t
              WHERE t.schemaname = 'public' AND t.rowsecurity) AS rls_tables`
  );
  const row = r.rows[0];
  const tables = parseInt(row.rls_tables, 10);

  if (tables === 0) {
    return {
      name: 'Tenant isolation',
      level: 'warn',
      detail: 'RLS is not enabled on any table',
      fix: 'npm run migrate (re-applies src/database/rls-policies.sql)',
    };
  }
  if (row.is_super || row.bypass) {
    return {
      name: 'Tenant isolation',
      level: 'warn',
      detail: `RLS enabled on ${tables} tables, but role "${row.current_user}" bypasses it (${row.is_super ? 'SUPERUSER' : 'BYPASSRLS'})`,
      fix: 'Connect as mnemosine_app: see scripts/provision-roles.sql',
    };
  }
  return {
    name: 'Tenant isolation',
    level: 'ok',
    detail: `RLS enabled on ${tables} tables, role "${row.current_user}" subject to policies`,
  };
}

export async function checkPendingWork(): Promise<CheckResult> {
  const r = await query<{ drafts: string; questions: string; ops: string }>(
    `SELECT
       (SELECT count(*)::text FROM ai_drafts WHERE status = 'pending_review') AS drafts,
       (SELECT count(*)::text FROM ai_questions WHERE status = 'pending') AS questions,
       (SELECT count(*)::text FROM ai_external_ops WHERE status = 'pending') AS ops`
  );
  const n = {
    drafts: parseInt(r.rows[0].drafts, 10),
    questions: parseInt(r.rows[0].questions, 10),
    ops: parseInt(r.rows[0].ops, 10),
  };
  const total = n.drafts + n.questions + n.ops;
  if (total === 0) return { name: 'Pending work', level: 'ok', detail: 'nothing queued' };
  const parts = [
    n.drafts && `${n.drafts} ${n.drafts === 1 ? 'draft' : 'drafts'}`,
    n.questions && `${n.questions} ${n.questions === 1 ? 'question' : 'questions'}`,
    n.ops && `${n.ops} ${n.ops === 1 ? 'write' : 'writes'}`,
  ].filter(Boolean);
  return {
    name: 'Pending work',
    level: 'ok', // having work is not a health problem
    detail: parts.join(', '),
    fix: 'mnemosine pending',
  };
}

export async function checkCredentials(now: Date): Promise<CheckResult> {
  const r = await query<{ n: string; soonest: string | null }>(
    `SELECT count(*)::text n, MIN(valid_to)::text AS soonest
     FROM fiscal_credentials WHERE status = 'active'`
  );
  const n = parseInt(r.rows[0].n, 10);
  if (n === 0) {
    return {
      name: 'Fiscal credentials',
      level: 'ok',
      detail: 'none loaded (not required to operate)',
      fix: 'mnemosine sat cred add  (only if you will download from the SAT)',
    };
  }
  const soonest = r.rows[0].soonest ? new Date(r.rows[0].soonest) : null;
  const days = soonest ? Math.floor((soonest.getTime() - now.getTime()) / 86_400_000) : null;
  if (days !== null && days <= 0) {
    return {
      name: 'Fiscal credentials',
      level: 'fail',
      detail: `${n} loaded, the next one has ALREADY EXPIRED`,
      fix: 'Renew the e.firma at the SAT and reload it: mnemosine sat cred add',
    };
  }
  if (days !== null && days <= 30) {
    return {
      name: 'Fiscal credentials',
      level: 'warn',
      detail: `${n} loaded, expires in ${days} days`,
      fix: 'Renew the e.firma at the SAT before that date',
    };
  }
  return { name: 'Fiscal credentials', level: 'ok', detail: `${n} valid` };
}

export function checkModelProvider(cwd?: string): CheckResult {
  let profiles: ReturnType<typeof listProfiles>;
  try {
    profiles = listProfiles(cwd);
  } catch (err) {
    return {
      name: 'Model provider',
      level: 'fail',
      detail: (err as Error).message,
      fix: 'Fix mnemosine.config.json',
    };
  }

  const { profiles: all, defaultName } = profiles;
  const active = all[defaultName];
  if (!active) {
    return {
      name: 'Model provider',
      level: 'fail',
      detail: `the default "${defaultName}" does not exist`,
      fix: 'mnemosine providers  (pick a valid one)',
    };
  }
  // No api_key_env = local without a credential (ollama): ready to use.
  if (!active.api_key_env) {
    return {
      name: 'Model provider',
      level: 'ok',
      detail: `${defaultName} · ${active.model} (local, no credential)`,
    };
  }
  if (!process.env[active.api_key_env]) {
    const withKey = Object.entries(all).filter(
      ([, p]) => !p.api_key_env || process.env[p.api_key_env]
    );
    return {
      name: 'Model provider',
      level: 'fail',
      detail: `${defaultName} requires ${active.api_key_env} and it is not set`,
      fix: withKey.length
        ? `Set ${active.api_key_env} in .env, or use --provider ${withKey[0][0]}`
        : `Set ${active.api_key_env} in .env`,
    };
  }
  return {
    name: 'Model provider',
    level: 'ok',
    detail: `${defaultName} · ${active.model}`,
  };
}

/** The example default (64 zeros) is nominal encryption: it must be shouted. */
export function checkEncryptionKey(): CheckResult {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    return {
      name: 'Encryption key',
      level: 'warn',
      detail: 'ENCRYPTION_KEY not set (the code default is used)',
      fix: 'openssl rand -hex 32  → ENCRYPTION_KEY in .env',
    };
  }
  if (/^0+$/.test(key)) {
    return {
      name: 'Encryption key',
      level: 'fail',
      detail: 'ENCRYPTION_KEY is the EXAMPLE key (zeros): "encrypted" data is not protected',
      fix: 'openssl rand -hex 32  → replace ENCRYPTION_KEY in .env',
    };
  }
  if (key.length !== 64) {
    return {
      name: 'Encryption key',
      level: 'fail',
      detail: `ENCRYPTION_KEY is ${key.length} characters long; 64 hex expected`,
      fix: 'openssl rand -hex 32',
    };
  }
  return { name: 'Encryption key', level: 'ok', detail: 'own 256-bit key' };
}


// ============================================================
// CAPACIDAD HUÉRFANA
//
// `checkLookupTables` pregunta a la BASE si dos tablas concretas tienen filas.
// Esto pregunta al CÓDIGO si una capacidad tiene por dónde alcanzarse, y lo
// hace para las 96 tablas y las ~585 funciones exportadas en vez de para una
// lista escrita a mano. Es la misma enfermedad que dejó payroll_account_mapping
// con lector y sin escritor hasta la primera nómina.
//
// NUNCA es 'fail', y la razón está en este mismo archivo: `appliesWhen` existe
// porque reportar como roto lo que no lo está «enseña a la gente a ignorar
// doctor». Un huérfano no impide operar hoy — impide que algo funcione el día
// que alguien lo intente. 'fail' pondría en rojo, y en código de salida 1, una
// instalación que trabaja perfectamente.
// ============================================================

/**
 * A qué se parece el daño de un huérfano. No es su gravedad —eso depende de si
 * ESTA instalación usa la capacidad, y el escáner lee código, no la base— sino
 * la FORMA en que falla, que sí se puede saber leyendo.
 *
 *  · `numero-falso`: alguien reporta una cifra que sale de una tabla vacía y
 *    no dice que está vacía. Es el único que puede meter un dato malo en algo
 *    que se entrega.
 *  · `sin-puerta`: la capacidad existe y no hay por dónde invocarla. No miente;
 *    no puede.
 *  · `peso-muerto`: código que nadie alcanza y cuya ausencia no cambiaría nada.
 *
 * Se ordena el informe por esto, no por tipo de objeto: un revisor necesita
 * leer primero los dos que pueden falsear una cifra, no las diez funciones de
 * caché que nadie llama.
 */
export type ClaseDeHuerfano = 'numero-falso' | 'sin-puerta' | 'peso-muerto';

/** Tablas huérfanas cuyo lector alimenta una cifra que alguien lee como buena. */
const ALIMENTAN_UNA_CIFRA = new Set(['paycheck_taxes']);

export function claseDe(o: Orphan): ClaseDeHuerfano {
  if (o.kind === 'tabla') {
    return ALIMENTAN_UNA_CIFRA.has(o.name) ? 'numero-falso' : 'sin-puerta';
  }
  return 'peso-muerto';
}

export function checkOrphanedCapability(deps: DoctorDeps = {}): CheckResult {
  const raiz = deps.cwd ?? process.cwd();
  // Una instalación empaquetada corre desde dist/ y no lleva las fuentes.
  // Decirlo es más honesto que un ✅ que no comprobó nada.
  if (!fs.existsSync(path.join(raiz, 'src'))) {
    return {
      name: 'Orphaned capability',
      level: 'ok',
      detail: 'no source tree here: this check reads the repository, not the install',
    };
  }

  const { orphans, scanned } = scanOrphans(raiz);
  if (orphans.length === 0) {
    return {
      name: 'Orphaned capability',
      level: 'ok',
      detail: `${scanned.tables} tables and ${scanned.exports} exports, all reachable`,
    };
  }

  // Lo que ya vigila checkLookupTables no se repite aquí. Esa comprobación
  // sabe si la instalación usa la capacidad y puede llegar a 'fail'; decirlo
  // dos veces con dos niveles distintos sólo enseña a leer el más suave.
  const yaVigiladas = new Set(LOOKUP_TABLES.map((t) => t.table));
  const propios = orphans.filter((o) => !(o.kind === 'tabla' && yaVigiladas.has(o.name)));
  if (propios.length === 0) {
    return {
      name: 'Orphaned capability',
      level: 'ok',
      detail: `${scanned.tables} tables and ${scanned.exports} exports, all reachable or already watched`,
    };
  }

  const porClase = (c: ClaseDeHuerfano): Orphan[] => propios.filter((o) => claseDe(o) === c);
  const cifras = porClase('numero-falso');
  const sinPuerta = porClase('sin-puerta');
  const muerto = porClase('peso-muerto');

  const partes: string[] = [];
  // Primero lo que puede falsear una cifra, y por su nombre.
  if (cifras.length) {
    partes.push(`${cifras.length} feeding a figure nobody flags as empty (${cifras.map((o) => o.name).join(', ')})`);
  }
  if (sinPuerta.length) {
    partes.push(`${sinPuerta.length} capability(ies) with no way in (${sinPuerta.map((o) => o.name).slice(0, 4).join(', ')})`);
  }
  // El peso muerto se CUENTA, no se enumera: dieciocho nombres detrás de los
  // dos que importan es lo que hace que se deje de leer el renglón.
  if (muerto.length) partes.push(`${muerto.length} unreferenced export(s)`);

  return {
    name: 'Orphaned capability',
    // Nunca 'fail', y no es una simplificación pendiente: es estructural. La
    // gravedad de un huérfano depende de si esta instalación usa la capacidad,
    // y esto lee `src/`, no la base. Lo que merece 'fail' se gradúa a
    // LOOKUP_TABLES, donde `appliesWhen` puede preguntarlo — así llegó ahí
    // employer_tax_liabilities.
    level: 'warn',
    detail: `${partes.join('; ')} — of ${scanned.tables} tables and ${scanned.exports} exports`,
    fix: 'give each one a door (a writer, a command, a caller) or delete it: unreachable code still gets maintained',
  };
}

/**
 * PERIODOS REABIERTOS QUE NADIE VOLVIÓ A CERRAR.
 *
 * `reopenClosedPeriod` y `restorePeriodStatus` son dos transacciones
 * independientes, y tienen que serlo: entre ellas ocurre el trabajo que
 * motivó la reapertura, con sus propias transacciones. Si el proceso muere
 * en medio —o el `finally` que restaura falla— el periodo se queda ABIERTO
 * de forma permanente, y nadie se entera: un periodo abierto no molesta a
 * nada hasta que alguien postea en él y descuadra un cierre ya presentado.
 *
 * No se puede evitar con una transacción, así que se detecta: la bitácora
 * guarda la reapertura con su motivo, y un cierre posterior sobre el mismo
 * periodo la salda. Una reapertura sin cierre que la siga es el rastro.
 */
/**
 * LEDGER INTEGRITY (R1) — y éste sí amerita `fail`.
 *
 * `account_balances` es tabla load-bearing del cierre (balanza del checklist,
 * closing entries, carry-forward) y nada la verificaba contra la suma de
 * líneas posteadas; y un asiento posteado sin fila de bitácora es un hecho
 * sin autor. A diferencia de la capacidad huérfana (informativa a propósito),
 * un mayor que no cuadra con sus propias líneas significa que el sistema NO
 * puede operar: todo reporte construido encima hereda la mentira.
 */
export async function checkLedgerIntegrity(): Promise<CheckResult> {
  const deriva = await query<{ account_id: string; fiscal_period_id: string }>(
    `SELECT COALESCE(ab.account_id, l.account_id) AS account_id,
            COALESCE(ab.fiscal_period_id, l.fiscal_period_id) AS fiscal_period_id
       FROM account_balances ab
       FULL OUTER JOIN (
         SELECT jel.account_id, je.fiscal_period_id,
                SUM(jel.debit_amount)  AS d,
                SUM(jel.credit_amount) AS c
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE je.status = 'posted'
          GROUP BY jel.account_id, je.fiscal_period_id
       ) l ON l.account_id = ab.account_id AND l.fiscal_period_id = ab.fiscal_period_id
      WHERE COALESCE(ab.debit_total, 0)  IS DISTINCT FROM COALESCE(l.d, 0)
         OR COALESCE(ab.credit_total, 0) IS DISTINCT FROM COALESCE(l.c, 0)
      LIMIT 20`
  );
  const sinRastro = await query<{ n: string }>(
    `SELECT count(*) AS n
       FROM journal_entries je
      WHERE je.status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM audit_log a
           WHERE a.entity_type = 'journal_entries' AND a.entity_id = je.id AND a.action = 'post'
        )`
  );
  const huerfanos = Number(sinRastro.rows[0]?.n ?? 0);

  if (deriva.rows.length === 0 && huerfanos === 0) {
    return {
      name: 'Ledger integrity',
      level: 'ok',
      detail: 'account_balances = Σ líneas posteadas, y todo posteado tiene su rastro',
    };
  }
  const partes: string[] = [];
  if (deriva.rows.length > 0) {
    partes.push(
      `${deriva.rows.length}${deriva.rows.length === 20 ? '+' : ''} (cuenta, periodo) donde ` +
        'account_balances ≠ Σ líneas posteadas — todo reporte encima hereda la diferencia'
    );
  }
  if (huerfanos > 0) {
    partes.push(`${huerfanos} asiento(s) posteado(s) sin fila 'post' en audit_log — hechos sin autor`);
  }
  return {
    name: 'Ledger integrity',
    level: 'fail',
    detail: partes.join('; '),
    fix:
      'La deriva de saldos se investiga ANTES de recalcular: desde la 041 una línea posteada no se ' +
      'edita, así que una diferencia nueva apunta al camino de escritura de account_balances, no a las líneas.',
  };
}

export async function checkReopenedPeriods(): Promise<CheckResult> {
  const r = await query<{ period_name: string; entity: string; reason: string; cuando: Date }>(
    `SELECT fp.period_name, le.name AS entity, a.reason, a.timestamp AS cuando
       FROM audit_log a
       JOIN fiscal_periods fp ON fp.id = a.entity_id
       JOIN legal_entities le ON le.id = fp.entity_id
      WHERE a.entity_type = 'fiscal_period' AND a.action = 'reopen'
        AND fp.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM audit_log c
           WHERE c.entity_type = 'fiscal_period' AND c.entity_id = a.entity_id
             AND c.action = 'close' AND c.timestamp > a.timestamp
        )
      ORDER BY a.timestamp`
  );

  if (r.rows.length === 0) {
    return { name: 'Reopened periods', level: 'ok', detail: 'none left open' };
  }
  const primero = r.rows[0];
  return {
    name: 'Reopened periods',
    level: 'warn',
    detail:
      `${r.rows.length} period(s) reopened and never closed again — the first is ` +
      `${primero.period_name} of ${primero.entity}. A period left open accepts postings that ` +
      `would unbalance a close already filed.`,
    fix: 'mnemosine period close <period> --entity <entity>',
  };
}
