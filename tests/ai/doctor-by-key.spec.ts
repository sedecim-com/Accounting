import fs from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ============================================================
// MNE-001-475 · doctor speaks by key (#153, S09 of the D14 plan on #141)
//
// The six checks that wrote Spanish prose straight into `detail` and `fix`,
// the one Spanish label, and the verdict lines of `renderDoctor` now come from
// the catalogue. Each message is asserted in English, the default the suite
// pins, and again in Spanish, which is what `--locale es-MX` pins at start-up.
// What a machine reads (`id`, `level`, the commands and table names inside the
// prose) does not move with the language.
// ============================================================

const db = vi.hoisted(() => ({ answers: [] as Array<[string, unknown[] | Error]> }));
const audit = vi.hoisted(() => ({ result: { nuevas: [] as unknown[], obsoletas: [] as unknown[], heredadas: 0 } }));

vi.mock('../../src/database/connection.js', () => ({
  // The first answer whose fragment the SQL contains; the double runs the
  // tenant callback so the per-tenant count really executes.
  query: vi.fn((sql: string) => {
    const hit = db.answers.find(([fragment]) => sql.includes(fragment));
    if (hit?.[1] instanceof Error) return Promise.reject(hit[1]);
    return Promise.resolve({ rows: hit?.[1] ?? [] });
  }),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../src/cli/mnemosine.js', () => ({ program: {} }));
vi.mock('../../src/cli/kernel/audit.js', () => ({ auditarContraLineaBase: () => audit.result }));

import {
  CHECK_IDENTITIES,
  checkConsistenciaCli,
  checkExtractosCompletos,
  checkLedgerIntegrity,
  checkPermisosEnConflicto,
  checkRolAuditor,
  checkSelloDeGarantias,
} from '../../src/ai/doctor-service.js';
import { renderDoctor } from '../../src/cli/doctor-command.js';
import { query } from '../../src/database/connection.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { judgeLanguage } from '../../scripts/language/extract.js';

const answer = (...pairs: Array<[string, unknown[] | Error]>) => {
  db.answers = pairs;
};
/** Runs `check` once in English and once in Spanish. */
async function both<T>(check: () => Promise<T>): Promise<{ en: T; es: T }> {
  const en = await check();
  setLanguage('es');
  const es = await check();
  resetLanguage();
  return { en, es };
}

beforeEach(() => {
  db.answers = [];
  (query as unknown as Mock).mockClear();
});
afterEach(() => resetLanguage());

describe('MNE-001-475 · no Spanish prose left in the doctor sources', () => {
  it.each(['src/ai/doctor-service.ts', 'src/cli/doctor-command.ts'])('%s writes no Spanish string literal', (file) => {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const spanish: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
        if (judgeLanguage(node.text).spanish) {
          spanish.push(`:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.text.slice(0, 60)}`);
        }
      }
      node.forEachChild(walk);
    };
    walk(source);
    expect(spanish).toEqual([]);
  });
});

describe('MNE-001-475 · the permission check label', () => {
  it('is real English, Spanish under es, and its id never moves', async () => {
    answer(['FROM users', []]);
    const { en, es } = await both(checkPermisosEnConflicto);
    expect([en.id, en.name]).toEqual(['conflicting-permissions', 'Segregation of duties (user access)']);
    expect([es.id, es.name]).toEqual(['conflicting-permissions', 'Segregación de funciones (permisos)']);
    expect(en.detail).toBe('no active user holds conflicting permissions');
    expect(es.detail).toBe('ningún usuario activo acumula permisos en conflicto');
    // What `doctor --json` prints: the whole result, id and localized name.
    expect(Object.keys(JSON.parse(JSON.stringify(es)) as object)).toEqual(['id', 'name', 'level', 'detail']);
    expect(CHECK_IDENTITIES.permissionConflicts.name).toBe('Segregation of duties (user access)');
  });

  it('warns with the fix in both languages, keeping the panel key', async () => {
    answer(['FROM users', [{ email: 'a@example.test', permissions: ['bills:create', 'bills:approve'] }]]);
    const { en, es } = await both(checkPermisosEnConflicto);
    expect(en.fix).toBe(
      'Split the conflicting permissions between different users, or accept the risk knowingly (in a one-person firm it is unavoidable; the per-entry maker-checker lives in the panel: segregacion_de_funciones).'
    );
    expect(es.fix).toBe(
      'Reparte los permisos en conflicto entre usuarios distintos, o acepta el riesgo a sabiendas (en un despacho unipersonal es inevitable; el maker-checker por póliza vive en el panel: segregacion_de_funciones).'
    );
  });
});

describe('MNE-001-475 · CLI consistency', () => {
  it('new violations: count, sample and fix', async () => {
    audit.result = { nuevas: [{ command: 'x', detail: 'd' }], obsoletas: [], heredadas: 0 };
    const { en, es } = await both(checkConsistenciaCli);
    expect(en.detail).toBe('1 new violation — x: d');
    expect(es.detail).toBe('1 violación nueva — x: d');
    expect(en.fix).toBe(
      'The CLI surface stays consistent because every verb comes from a closed list and every flag from the single dictionary. Fix the command, or —if the change is deliberate— extend the vocabulary in src/cli/kernel/vocabulary.ts. The baseline in src/cli/kernel/audit.ts is NOT extended.'
    );
    expect(es.fix).toMatch(/^La superficie del CLI se mantiene coherente .* La línea base de src\/cli\/kernel\/audit\.ts NO se amplía\.$/);
    audit.result = { nuevas: [1, 2, 3, 4].map((n) => ({ command: `c${n}`, detail: 'd' })), obsoletas: [], heredadas: 0 };
    const many = await both(checkConsistenciaCli);
    expect(many.en.detail).toBe('4 new violations — c1: d · c2: d · c3: d …');
    expect(many.es.detail).toBe('4 violaciones nuevas — c1: d · c2: d · c3: d …');
  });

  it('inherited ones, stale entries, and a clean surface', async () => {
    audit.result = { nuevas: [], obsoletas: [1, 2], heredadas: 20 };
    const { en, es } = await both(checkConsistenciaCli);
    expect(en.detail).toBe('no new violations; 20 inherited ones remain in the baseline · 2 baseline entries are no longer violated: delete them');
    expect(es.detail).toBe('sin violaciones nuevas; quedan 20 heredadas en la línea base · 2 entradas de la línea base ya no se violan: bórralas');
    expect(en.fix).toBe(
      'The inherited ones are known, frozen debt: nine are naming decisions, three require retiring a short form already published, and eight ask for four listings to be paginated.'
    );
    expect(es.fix).toMatch(/^Las heredadas son deuda conocida y congelada: .* se puedan paginar\.$/);
    audit.result = { nuevas: [], obsoletas: [1], heredadas: 1 };
    const one = await both(checkConsistenciaCli);
    expect(one.en.detail).toBe('no new violations; 1 inherited one remains in the baseline · 1 baseline entry is no longer violated: delete it');
    expect(one.es.detail).toBe('sin violaciones nuevas; queda 1 heredada en la línea base · 1 entrada de la línea base ya no se viola: bórrala');
    audit.result = { nuevas: [], obsoletas: [], heredadas: 0 };
    const clean = await both(checkConsistenciaCli);
    expect([clean.en.detail, clean.es.detail]).toEqual(['the surface meets every rule', 'la superficie cumple todas las reglas']);
  });
});

describe('MNE-001-475 · ledger integrity', () => {
  it('ok, drift, untraced entries and the fix', async () => {
    const ok = await both(checkLedgerIntegrity);
    expect(ok.en.detail).toBe('account_balances = Σ posted lines, and everything posted has its trail');
    expect(ok.es.detail).toBe('account_balances = Σ líneas posteadas, y todo posteado tiene su rastro');
    answer(['FULL OUTER JOIN', Array.from({ length: 20 }, () => ({}))], ['audit_log', [{ n: '1' }]]);
    const bad = await both(checkLedgerIntegrity);
    expect(bad.en.detail).toBe(
      '20+ (account, period) where account_balances ≠ Σ posted lines — every report on top inherits the difference; ' +
        "1 posted entry without a 'post' row in audit_log — facts with no author"
    );
    expect(bad.es.detail).toBe(
      '20+ (cuenta, periodo) donde account_balances ≠ Σ líneas posteadas — todo reporte encima hereda la diferencia; ' +
        "1 asiento posteado sin fila 'post' en audit_log — hechos sin autor"
    );
    expect(bad.en.fix).toBe(
      'Balance drift is investigated BEFORE recalculating: since migration 041 a posted line cannot be edited, so a new difference points at the write path of account_balances, not at the lines.'
    );
    expect(bad.es.fix).toMatch(/^La deriva de saldos se investiga ANTES de recalcular: desde la 041 /);
    answer(['FULL OUTER JOIN', [{}, {}]], ['audit_log', [{ n: '3' }]]);
    const plural = await both(checkLedgerIntegrity);
    expect(plural.en.detail).toMatch(/^2 \(account, period\) where .*; 3 posted entries without/);
    expect(plural.es.detail).toMatch(/^2 \(cuenta, periodo\) donde .*; 3 asientos posteados sin/);
  });
});

describe('MNE-001-475 · guarantee triggers', () => {
  it('unsealed, with the disabled ones, and its fix', async () => {
    answer(['garantia-sellada', [
      { tgname: 'g1', relname: 't1', tgenabled: 'D' },
      { tgname: 'g2', relname: 't2', tgenabled: 'O' },
      { tgname: 'g3', relname: 't3', tgenabled: 'A' },
    ]]);
    const { en, es } = await both(checkSelloDeGarantias);
    expect(en.detail).toBe('2 of 3 guarantees unsealed (1 DISABLED): t1.g1=D, t2.g2=O');
    expect(es.detail).toBe('2 de 3 garantías sin sellar (1 APAGADA): t1.g1=D, t2.g2=O');
    expect(en.fix).toBe('ALTER TABLE <table> ENABLE ALWAYS TRIGGER <trigger>  — and find out WHO disabled it and why');
    expect(es.fix).toBe('ALTER TABLE <tabla> ENABLE ALWAYS TRIGGER <disparador>  — y averigua QUIÉN lo apagó y por qué');
    answer(['garantia-sellada', [{ tgname: 'g1', relname: 't1', tgenabled: 'O' }]]);
    const none = await both(checkSelloDeGarantias);
    expect([none.en.detail, none.es.detail]).toEqual(['1 of 1 guarantee unsealed: t1.g1=O', '1 de 1 garantía sin sellar: t1.g1=O']);
  });

  it('ok counts the sealed ones, singular and plural', async () => {
    answer(['garantia-sellada', [{ tgname: 'g1', relname: 't1', tgenabled: 'A' }]]);
    const one = await both(checkSelloDeGarantias);
    expect(one.en.detail).toBe('1 guarantee in ENABLE ALWAYS: not even session_replication_role silences it');
    expect(one.es.detail).toBe('1 garantía en ENABLE ALWAYS: ni session_replication_role la calla');
    answer(['garantia-sellada', [{ tgname: 'g1', relname: 't1', tgenabled: 'A' }, { tgname: 'g2', relname: 't2', tgenabled: 'A' }]]);
    const two = await both(checkSelloDeGarantias);
    expect(two.en.detail).toBe('2 guarantees in ENABLE ALWAYS: not even session_replication_role silences them');
    expect(two.es.detail).toBe('2 garantías en ENABLE ALWAYS: ni session_replication_role las calla');
  });
});

describe('MNE-001-475 · bank statements', () => {
  const short = [{ file_name: null, period_start: '2026-07-01', declaradas: '4', presentes: '3' }];

  it('the pre-correction 051, with every piece, and its fix', async () => {
    answer(['uq_bank_tx_contenido', [{ unico: true, ciego: true }]], ['FROM tenants', [{ id: 't1' }, { id: 't2' }]], ['bank_statements', short]);
    const { en, es } = await both(checkExtractosCompletos);
    expect(en.detail).toBe(
      'this database recorded migration 051 before its correction; the content index is UNIQUE and swallows legitimately identical transactions; ' +
        'the trigger does not watch content_hash, so the fingerprint can be forged by hand; 2 lines are already missing in 2 statements: ' +
        '(unnamed) 2026-07-01: 3/4; (unnamed) 2026-07-01: 3/4; 2 tenants checked'
    );
    expect(es.detail).toBe(
      'esta base registró la 051 antes de su corrección; el índice de contenido es ÚNICO y se traga movimientos legítimamente idénticos; ' +
        'el disparador no vigila content_hash, así que la huella se puede forjar a mano; ya faltan 2 líneas en 2 extractos: ' +
        '(sin nombre) 2026-07-01: 3/4; (sin nombre) 2026-07-01: 3/4; 2 inquilinos revisados'
    );
    expect(en.fix).toBe('npm run migrate  — applies 072; lines already lost must be re-imported by hand: the remedy gives back the capacity, not the data');
    expect(es.fix).toBe('npm run migrate  — aplica la 072; las líneas ya perdidas hay que reimportarlas a mano, el remedio devuelve la capacidad, no el dato');
  });

  it('short statements: the count, the scope and the cautious fix', async () => {
    answer(['uq_bank_tx_contenido', [{ unico: false, ciego: false }]], ['FROM tenants', [{ id: 't1' }]], ['bank_statements', short]);
    const { en, es } = await both(checkExtractosCompletos);
    expect(en.detail).toBe('1 line declared and not present in 1 statement (1 tenant checked): (unnamed) 2026-07-01: 3/4');
    expect(es.detail).toBe('1 línea declarada y no presente en 1 extracto (1 inquilino revisado): (sin nombre) 2026-07-01: 3/4');
    expect(en.fix).toMatch(/^compare before touching anything: .* never by removing the bank_statements row, which is evidence$/);
    expect(es.fix).toMatch(/^compara antes de tocar nada: .* nunca soltando la fila de bank_statements, que es evidencia$/);
  });

  it('a tenant that could not be checked, and the ok that says how much it checked', async () => {
    answer(['uq_bank_tx_contenido', [{ unico: false, ciego: false }]], ['FROM tenants', [{ id: 't1' }, { id: 't2' }]], ['bank_statements', new Error('denied')]);
    const blind = await both(checkExtractosCompletos);
    expect(blind.en.detail).toBe('the catalogue is repaired, but 2 tenants checked, 2 could not be checked: without reading their statements I cannot say they are complete');
    expect(blind.es.detail).toBe('el catálogo está reparado, pero 2 inquilinos revisados, 2 sin poder mirarse: sin poder leer sus extractos no puedo decir que estén completos');
    expect(blind.en.fix).toBe('check that the application role can query bank_statements with a tenant context');
    expect(blind.es.fix).toBe('revisa que el rol de la aplicación pueda consultar bank_statements con contexto de inquilino');
    answer(['uq_bank_tx_contenido', [{ unico: false, ciego: false }]], ['FROM tenants', [{ id: 't1' }]]);
    const ok = await both(checkExtractosCompletos);
    expect(ok.en.detail).toBe('the content index is not unique, the trigger enforces the fingerprint, and no statement has fewer lines than it declared (1 tenant checked)');
    expect(ok.es.detail).toBe('el índice de contenido no es único, el disparador impone la huella, y ningún extracto tiene menos líneas de las que declaró (1 inquilino revisado)');
  });
});

describe('MNE-001-475 · auditor role', () => {
  const SOUND = [{ rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolcreaterole: false }];
  const role = (over: Array<[string, unknown[]]>) => answer(...over, ['pg_roles', SOUND]);
  const PSQL = 'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  ';

  it('missing, with the fix that says why it is no migration', async () => {
    answer(['pg_roles', []]);
    const { en, es } = await both(checkRolAuditor);
    expect(en.detail).toBe('mnemosine_auditor does not exist: giving an outside auditor access today means lending them WRITE credentials over the books');
    expect(es.detail).toBe('mnemosine_auditor no existe: dar acceso a un auditor externo hoy exige prestarle credenciales de ESCRITURA sobre los libros');
    expect(en.fix).toBe(`${PSQL}(it does not fit in a migration: the migrator has no CREATEROLE, on purpose)`);
    expect(es.fix).toBe(`${PSQL}(no cabe en una migración: el migrador no tiene CREATEROLE, y es a propósito)`);
  });

  it('the four grave findings, and their fix', async () => {
    answer(['privilege_type IN', [{ tabla: 'journal_entries', privilegio: 'INSERT' }]], ['pg_roles', [{ rolcanlogin: false, rolbypassrls: true, rolsuper: true, rolcreaterole: true }]]);
    const { en, es } = await both(checkRolAuditor);
    expect(en.detail).toBe('mnemosine_auditor IGNORES RLS (BYPASSRLS): it sees the books of ALL tenants; is a SUPERUSER; can create roles; has WRITE on journal_entries:INSERT');
    expect(es.detail).toBe('mnemosine_auditor IGNORA LA RLS (BYPASSRLS): ve los libros de TODOS los inquilinos; es SUPERUSUARIO; puede crear roles; tiene ESCRITURA sobre journal_entries:INSERT');
    expect(en.fix).toBe(`${PSQL}— the script reasserts NOBYPASSRLS and revokes; also find out WHO granted it`);
    expect(es.fix).toBe(`${PSQL}— el guion reafirma NOBYPASSRLS y revoca; averigua además QUIÉN se lo concedió`);
  });

  it('LOGIN, and its fix', async () => {
    answer(['pg_roles', [{ ...SOUND[0], rolcanlogin: true }]]);
    const { en, es } = await both(checkRolAuditor);
    expect(en.detail).toBe('mnemosine_auditor has LOGIN: it is meant as a privilege bundle granted to NAMED accounts (one per auditor), not as a shared account');
    expect(es.detail).toBe('mnemosine_auditor tiene LOGIN: está pensado como paquete de privilegios que se concede a cuentas NOMINALES (una por auditor), no como cuenta compartida');
    expect(en.fix).toBe('ALTER ROLE mnemosine_auditor NOLOGIN;  and issue one account per person: CREATE ROLE <auditor> LOGIN IN ROLE mnemosine_auditor');
    expect(es.fix).toBe('ALTER ROLE mnemosine_auditor NOLOGIN;  y emite una cuenta por persona: CREATE ROLE <auditor> LOGIN IN ROLE mnemosine_auditor');
  });

  it('materialized views, singular and plural', async () => {
    role([['es_vista', [{ relname: 'mv_a', es_vista: true }]]]);
    const one = await both(checkRolAuditor);
    expect(one.en.detail).toBe('mnemosine_auditor reads 1 materialized view (mv_a): RLS does not filter them and a role with BYPASSRLS builds them, so they hold the books of ALL tenants');
    expect(one.es.detail).toBe('mnemosine_auditor lee 1 vista materializada (mv_a): no las filtra la RLS y las construye un rol con BYPASSRLS, así que contienen los libros de TODOS los inquilinos');
    expect(one.en.fix).toBe(`${PSQL}— its block 4 revokes every relkind = 'm'`);
    expect(one.es.fix).toBe(`${PSQL}— su bloque 4 revoca toda relkind = 'm'`);
    role([['es_vista', [{ relname: 'mv_a', es_vista: true }, { relname: 'mv_b', es_vista: true }]]]);
    const two = await both(checkRolAuditor);
    expect(two.en.detail).toMatch(/^mnemosine_auditor reads 2 materialized views \(mv_a, mv_b\)/);
    expect(two.es.detail).toMatch(/^mnemosine_auditor lee 2 vistas materializadas \(mv_a, mv_b\)/);
  });

  it('coverage unmeasured, and tables born after the last GRANT', async () => {
    role([['legibles', []]]);
    const unmeasured = await both(checkRolAuditor);
    expect(unmeasured.en.detail).toBe('mnemosine_auditor exists and is well bounded, but its table coverage could not be measured');
    expect(unmeasured.es.detail).toBe('mnemosine_auditor existe y está bien acotado, pero no se pudo medir su cobertura de tablas');
    expect(unmeasured.en.fix).toBe(`${PSQL}(its verification block prints both counts)`);
    expect(unmeasured.es.fix).toBe(`${PSQL}(su bloque de verificación imprime los dos conteos)`);
    role([['legibles', [{ legibles: '50', totales: '57' }]]]);
    const ungranted = await both(checkRolAuditor);
    expect(ungranted.en.detail).toBe('mnemosine_auditor reads only 50 of the 57 isolated tables: 7 tables were created after the last GRANT');
    expect(ungranted.es.detail).toBe('mnemosine_auditor sólo lee 50 de las 57 tablas aisladas: 7 tablas nacieron después del último GRANT');
    expect(ungranted.en.fix).toBe(`${PSQL}(grants again and sets the default privileges for whatever comes next)`);
    expect(ungranted.es.fix).toBe(`${PSQL}(vuelve a conceder y fija los privilegios por defecto de lo que venga)`);
    role([['legibles', [{ legibles: '56', totales: '57' }]]]);
    const one = await both(checkRolAuditor);
    expect(one.en.detail).toMatch(/: 1 table was created after the last GRANT$/);
    expect(one.es.detail).toMatch(/: 1 tabla nació después del último GRANT$/);
  });

  it('ok, naming the tables it reads with no tenant', async () => {
    role([['es_vista', [{ relname: 'exchange_rates', es_vista: false }]], ['legibles', [{ legibles: '57', totales: '57' }]]]);
    const { en, es } = await both(checkRolAuditor);
    expect(en.detail).toBe('read-only on 57 isolated tables, NOLOGIN and subject to RLS; also 1 without a tenant, which must be global reference only (exchange_rates)');
    expect(es.detail).toBe('sólo lectura sobre 57 tablas aisladas, NOLOGIN y sujeto a la RLS; además 1 sin inquilino, que debe ser sólo referencia global (exchange_rates)');
    role([['legibles', [{ legibles: '57', totales: '57' }]]]);
    const bare = await both(checkRolAuditor);
    expect([bare.en.detail, bare.es.detail]).toEqual([
      'read-only on 57 isolated tables, NOLOGIN and subject to RLS',
      'sólo lectura sobre 57 tablas aisladas, NOLOGIN y sujeto a la RLS',
    ]);
  });
});

describe('MNE-001-475 · the summary of renderDoctor', () => {
  const pass = (s: string) => s;
  const palette = { dim: pass, bold: pass, red: pass };
  const report = (worst: 'ok' | 'warn' | 'fail') => ({
    worst,
    checks: [{ id: 'database-connection', name: 'Database', level: worst, detail: 'PostgreSQL 15' }],
  });

  it('title and verdict in English and in Spanish', () => {
    expect(renderDoctor(report('ok'), palette)[1]).toBe('Mnemosine health check');
    expect(renderDoctor(report('fail'), palette).at(-2)).toBe('  There are failures that prevent operation. Resolve them in the order shown.');
    expect(renderDoctor(report('warn'), palette).at(-2)).toBe('  Operational with warnings.');
    expect(renderDoctor(report('ok'), palette).at(-2)).toBe('  All good.');
    setLanguage('es');
    expect(renderDoctor(report('ok'), palette)[1]).toBe('Revisión de salud de Mnemosine');
    expect(renderDoctor(report('fail'), palette).at(-2)).toBe('  Hay fallas que impiden operar. Resuélvelas en el orden en que aparecen.');
    expect(renderDoctor(report('warn'), palette).at(-2)).toBe('  Opera con avisos.');
    expect(renderDoctor(report('ok'), palette).at(-2)).toBe('  Todo en orden.');
  });
});
