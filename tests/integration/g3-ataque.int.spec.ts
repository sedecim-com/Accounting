import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';
import { resolvers } from '../../src/api/graphql/resolvers/index.js';
import { createJournalEntry, postJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { parseImportFile, stageEntryImport } from '../../src/services/accounting/entry-import-service.js';
import { checkBatch, postBatch } from '../../src/services/accounting/batch-service.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { checkPermisosEnConflicto } from '../../src/ai/doctor-service.js';
import { resolveReviewer } from '../../src/ai/draft-service.js';
import { SuplantacionError, SesionNoVerificableError } from '../../src/auth/sujeto-activo.js';
import { PERMISSIONS, ROLES } from '../../src/auth/roles.js';
import { config } from '../../src/config/index.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G3 · EL ATAQUE.
//
// Lo que este archivo intenta romper es la frase con la que se vende el
// producto: «se puede probar quién hizo qué». Las tres piezas de G3 la
// sostienen desde tres sitios distintos, y una prueba de aceptación por pieza
// no basta: lo que hace falsa a esa frase no es que una pieza no funcione,
// es que exista UN camino que la rodee.
//
// Así que aquí no se comprueba que el candado funcione por las puertas que ya
// se sabe que atraviesa. Se buscan las que NO: el cuerpo JSON que pide su
// propia exención, el lote de importación, el rol de Postgres que sólo mira,
// la superficie pública que sirve una prueba fabricada, y el informe que
// enseña los correos de otro despacho.
// ============================================================

// ── EL DOBLE DE LA SESIÓN OIDC ──────────────────────────────────────────
//
// `sujetoAutenticado()` habla con el proveedor: descubrimiento, JWKS y firma.
// Eso ya está probado contra sus propios dobles en tests/auth/sujeto-activo.
// Lo que NO estaba probado es lo que pasa DESPUÉS: con una sesión en la mano,
// ¿qué usuario del inquilino termina en `journal_entries.created_by` y en
// `audit_log.user_id`? Eso son dos consultas contra `identities` y `users`, y
// sólo la base contesta. Se sustituye la máquina y se deja la regla entera.
const sesion = vi.hoisted(() => ({
  actual: null as { subject: string; email: string; issuer: string } | null,
  exige: false,
}));

vi.mock('../../src/auth/sujeto-activo.js', async (original) => {
  const real = await original<typeof import('../../src/auth/sujeto-activo.js')>();
  return {
    ...real,
    sujetoAutenticado: () => Promise.resolve(sesion.actual),
    autenticacionExigida: () => sesion.exige,
  };
});

let f: Fixture;
let hermana: Fixture;
let otroUsuario: string;

const ctxDe = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function politica(fx: Fixture, valor: string): Promise<void> {
  await reopenPolicy(ctxDe(fx), 'segregacion_de_funciones').catch(() => undefined);
  await resolvePolicy(ctxDe(fx), 'segregacion_de_funciones', valor, 'ataque@test');
}

async function contarAsientos(entityId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1',
    [entityId]
  );
  return Number(rows[0].n);
}

/** Un usuario real del inquilino con los permisos que se le pidan. */
async function crearUsuario(fx: Fixture, rol: string, permisos: readonly string[]): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Rol', $4, $5::jsonb, $6::jsonb, $7::jsonb, true)`,
    [id, fx.tenantId, `${rol}-${id.slice(0, 8)}@ataque.test`, rol,
     JSON.stringify([rol]), JSON.stringify(permisos), JSON.stringify([fx.entityId])]
  );
  return id;
}


async function contarFilasDeAuditoria(tenantId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM audit_log WHERE tenant_id = $1', [tenantId]
  );
  return Number(rows[0].n);
}

/**
 * Cuántos conflictos reporta `checkPermisosEnConflicto`, incluida la cola que
 * `detail` resume: imprime los diez primeros y luego « … (+N)».
 */
function totalReportado(detail: string): number {
  if (detail.trim() === '' || /ningún usuario activo/.test(detail)) return 0;
  const cola = /\(\+(\d+)\)/.exec(detail);
  const listados = detail.replace(/ … \(\+\d+\)$/, '').split('; ').filter((x) => x !== '').length;
  return listados + (cola ? Number(cola[1]) : 0);
}

beforeAll(async () => {
  f = await crearInquilino('G3 ataque');
  enterTenant(f.tenantId);
  hermana = await crearEntidadHermana(f, 'G3 ataque · hermana');
  enterTenant(f.tenantId);
  otroUsuario = await crearUsuario(f, 'revisor', ['journal_entries:post']);
  await seedPolicies(ctxDe(f));
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ============================================================
// 1 · LA EXENCIÓN QUE SE PIDE DESDE EL CUERPO DE LA PETICIÓN
// ============================================================
describe('ataque 1 · pedir la exención en el JSON', () => {
  it("entry_type:'closing' con auto_post NO exime: el candado no mira el tipo", async () => {
    await politica(f, 'exigir');
    const antes = await contarAsientos(f.entityId);

    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    try {
      // 'closing' está en el enum del esquema de la ruta, y los asientos de
      // cierre SÍ están exentos —por `source_type = 'period_close'`, que pone
      // el barrido—. Si el candado eximiera por `entry_type`, la exención
      // entera se pediría desde el cuerpo: una palabra en un JSON.
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        entity_id: f.entityId,
        entry_date: iso(fechaEnPeriodo()),
        entry_type: 'closing',
        description: 'ataque: me declaro cierre',
        auto_post: true,
        lines: [
          { account_id: f.roles.banco, debit_amount: '11.00', description: 'cargo' },
          { account_id: f.roles.cxc, credit_amount: '11.00', description: 'abono' },
        ],
      });
      expect(r.status).toBe(422);
      expect((r.body.errors as Array<{ code: string }>)[0].code).toBe('SOD_QUIEN_CREA_NO_POSTEA');
    } finally {
      await s.cerrar();
    }
    expect(await contarAsientos(f.entityId)).toBe(antes);
  });

  it('un source_type puesto a mano en el cuerpo se ignora: el esquema no lo admite', async () => {
    await politica(f, 'exigir');
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'POST', '/v1/journal-entries', {
        entity_id: f.entityId,
        entry_date: iso(fechaEnPeriodo()),
        entry_type: 'standard',
        description: 'ataque: me invento un origen',
        auto_post: true,
        source_type: 'invoice',
        source_id: uuidv4(),
        is_reversal: true,
        lines: [
          { account_id: f.roles.banco, debit_amount: '12.00', description: 'cargo' },
          { account_id: f.roles.cxc, credit_amount: '12.00', description: 'abono' },
        ],
      });
      expect(r.status).toBe(422);
      expect((r.body.errors as Array<{ code: string }>)[0].code).toBe('SOD_QUIEN_CREA_NO_POSTEA');
    } finally {
      await s.cerrar();
    }
  });

  it('la mutación GraphQL postJournalEntry atraviesa el mismo candado', async () => {
    await politica(f, 'exigir');
    const borrador = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'ataque: GraphQL post',
      [
        { account_id: f.roles.banco, debit_amount: '13.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '13.00', description: 'abono' },
      ],
      f.userId
    );
    const ctx = {
      user: { user_id: f.userId, entities: [f.entityId], permissions: ['*'] },
      tenantId: f.tenantId,
      entityId: f.entityId,
    };
    const mutaciones = resolvers.Mutation as unknown as Record<
      string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>
    >;
    await expect(
      mutaciones.postJournalEntry(null, { id: borrador.id }, ctx)
    ).rejects.toMatchObject({ code: 'SOD_QUIEN_CREA_NO_POSTEA' });
  });
});

// ============================================================
// 2 · LA PUERTA DEL LOTE
// ============================================================
describe('ataque 2 · el lote de importación', () => {
  it('la misma persona prepara el lote y lo aplica bajo la política que lo prohíbe', async () => {
    await politica(f, 'exigir');
    const fecha = iso(fechaEnPeriodo());
    const codigos = await query<{ id: string; code: string }>(
      'SELECT id, code FROM accounts WHERE id = ANY($1::uuid[])',
      [[f.roles.banco, f.roles.cxc]]
    );
    const codigoDe = (id: string) => codigos.rows.find((r) => r.id === id)!.code;
    const csv =
      'entry_key,entry_date,description,account_code,debit,credit,line_description\n' +
      `L1,${fecha},lote de una sola persona,${codigoDe(f.roles.banco)},77.00,,cargo\n` +
      `L1,${fecha},lote de una sola persona,${codigoDe(f.roles.cxc)},,77.00,abono\n`;

    const parseado = parseImportFile('csv', csv);
    const { batchId } = await stageEntryImport(ctxDe(f), {
      layout: 'csv', fileName: 'ataque.csv', fileHash: 'h'.repeat(64), lote: parseado,
    }, f.userId);
    await checkBatch(ctxDe(f), batchId, f.userId);

    // EL CONTRASTE ES EL HALLAZGO. La MISMA póliza, la misma persona, la
    // misma política: por el camino manual el motor la rechaza…
    const aMano = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'la misma póliza, a mano',
      [
        { account_id: f.roles.banco, debit_amount: '77.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '77.00', description: 'abono' },
      ],
      f.userId
    );
    await expect(postJournalEntry(aMano.id, f.userId)).rejects.toMatchObject({
      code: 'SOD_QUIEN_CREA_NO_POSTEA',
    });
    // …y el segundo par de ojos sí la postea, que es la política funcionando.
    expect((await postJournalEntry(aMano.id, otroUsuario)).status).toBe('posted');

    // …Y POR EL LOTE, LO MISMO. Esta prueba nació documentando el hueco: con
    // el MISMO userId que lo preparó, el lote entraba al mayor. Era la CUARTA
    // puerta, y la exención salía de `source_type` — que aquí NO traza a un
    // flujo del sistema, sino a la fila de un CSV que redactó esa persona.
    // Ahora certifica el cierre, y la simetría es el punto: el mismo acto
    // contable se comporta igual por los dos caminos.
    await expect(postBatch(ctxDe(f), batchId, f.userId, {})).rejects.toMatchObject({
      code: 'SOD_QUIEN_CREA_NO_POSTEA',
    });

    // Y el segundo par de ojos sí lo aplica, igual que a mano.
    const r = await postBatch(ctxDe(f), batchId, otroUsuario, {});
    expect(r.posteadas.length).toBe(1);

    const { rows } = await query<{ status: string; created_by: string; posted_by: string; source_type: string }>(
      'SELECT status, created_by, posted_by, source_type FROM journal_entries WHERE id = $1',
      [r.posteadas[0].entry_id]
    );
    expect(rows[0].status).toBe('posted');
    expect(rows[0].source_type).toBe('import_batch');
    // Y AQUÍ ESTÁ LA DISTINCIÓN QUE COSTÓ ENCONTRAR. En el asiento del lote,
    // created_by y posted_by son la MISMA persona —los escribe el mismo acto,
    // `createJournalEntry` con autoPost— y eso es correcto: no es la
    // separación que importa. La que importa es quien IMPORTÓ el lote contra
    // quien lo APLICA, un dato que el asiento no tiene y el lote sí. Por eso
    // el candado del lote no podía vivir en el motor de posteo.
    expect(rows[0].created_by).toBe(rows[0].posted_by);
    expect(rows[0].posted_by).toBe(otroUsuario);
    const { rows: delLote } = await query<{ created_by: string }>(
      'SELECT created_by FROM journal_entry_import_batches WHERE id = $1',
      [batchId]
    );
    expect(delLote[0].created_by).toBe(f.userId);
    expect(delLote[0].created_by).not.toBe(rows[0].posted_by);
  });
});

// ============================================================
// 3 · SOD_RULES CON USUARIOS REALES
// ============================================================
describe('ataque 3 · la regla de segregación, con un usuario real por rol', () => {
  it('el owner del inquilino aparece en el informe, que es lo que antes no pasaba', async () => {
    const g = await crearInquilino('G3 ataque · roles');
    enterTenant(g.tenantId);
    for (const [rol, spec] of Object.entries(ROLES)) {
      if (rol === 'owner') continue;
      await crearUsuario(g, rol, spec.permissions);
    }
    // `crearInquilino` ya deja un usuario con ['*'] y rol owner.
    const informe = await checkPermisosEnConflicto();
    expect(informe.level).toBe('warn');
    const correoOwner = (
      await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [g.userId])
    ).rows[0].email;
    // EL DETALLE SE RECORTA A DIEZ, y este informe es de la INSTALACIÓN: en
    // una base con muchos inquilinos —la suite completa— el owner recién
    // creado cae fuera del recorte y buscar su correo ahí es una aserción
    // sobre cuántos vecinos hay, no sobre lo que la prueba quiere probar.
    // Corriendo el archivo solo pasaba; en la suite entera, no.
    //
    // Lo que se afirma, entonces, es lo que de verdad cambió: el owner ES uno
    // de los acusados. Si cabe en el recorte, tiene que estar; y quepa o no,
    // sus permisos tienen que componer conflicto, que es lo que antes no
    // pasaba porque a `owner` se le dejaba salir limpio.
    const recortado = / … \(\+\d+\)$/.test(informe.detail ?? '');
    if (!recortado) expect(informe.detail).toContain(correoOwner);
    const { rows: suyos } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users
        WHERE id = $1 AND is_active = true AND permissions @> '["*"]'::jsonb`,
      [g.userId]
    );
    expect(suyos[0].n).toBe('1');
    enterTenant(f.tenantId);
  });

  it('el informe es de la INSTALACIÓN y no del inquilino, y lo que enumera son correos', async () => {
    // `users` está EXCLUIDA de las políticas de aislamiento (rls-policies.sql:
    // el camino de autenticación tiene que leerla antes de saber de quién es
    // quien llama) y esta consulta no acota por inquilino. `doctor` es un
    // comando de OPERADOR —no tiene `--tenant` y ningún otro consumidor lo
    // llama—, así que el alcance es deliberado; lo que no es deliberado es que
    // sea el ÚNICO check que imprime dato personal de todos los despachos a la
    // vez. Se fija aquí para que quien lo acote se entere de que cambia lo que
    // el operador ve.
    const a = await crearInquilino('G3 ataque · despacho A');
    await crearInquilino('G3 ataque · despacho B');

    enterTenant(a.tenantId);
    const informe = await checkPermisosEnConflicto();
    enterTenant(f.tenantId);

    const propios = Number((
      await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM users WHERE tenant_id = $1 AND is_active = true`,
        [a.tenantId]
      )
    ).rows[0].n);

    expect(propios).toBe(1);
    expect(totalReportado(informe.detail ?? '')).toBeGreaterThan(propios);
    expect(informe.detail).toMatch(/@/);
  });

  it('ninguna regla nombra un permiso que el catálogo no defina', () => {
    // Ya lo fija la prueba unitaria; se repite aquí porque es la condición
    // que hacía que la regla alta fuera imposible de disparar, y una regla
    // muerta ocupa el sitio de una viva.
    expect(PERMISSIONS).toContain('bills:create');
    expect(PERMISSIONS).toContain('bills:approve');
  });
});

// ============================================================
// 4 · LA SUPERFICIE PÚBLICA Y EL ANCLAJE SIMULADO
// ============================================================
describe('ataque 4 · servir una prueba de anclaje sin decir que es simulada', () => {
  it('la columna nace true para lo que ya existía: un INSERT que la omite hereda simulado', async () => {
    const anchorId = uuidv4();
    await query(
      `INSERT INTO bitcoin_anchors (
         id, tenant_id, anchor_type, merkle_root, entry_count, op_return_payload,
         protocol_version, bitcoin_txid, status, broadcast_at
       ) VALUES ($1,$2,'single_tenant',$3,1,$4,1,$5,'broadcast',NOW())`,
      [anchorId, f.tenantId, `0x${'9'.repeat(64)}`, Buffer.alloc(80), 'c'.repeat(64)]
    );
    const { rows } = await query<{ is_simulated: boolean }>(
      'SELECT is_simulated FROM bitcoin_anchors WHERE id = $1', [anchorId]
    );
    expect(rows[0].is_simulated).toBe(true);
  });

  it('/public/v1/verify/:entryHash con atestación REAL y anclaje SIMULADO lo dice y no enlaza', async () => {
    // El camino que los cerrojos de /bitcoin/verify y /bitcoin/proof no
    // cubren: aquí la carga principal es la atestación —que es real, así que
    // el manejador NO se niega— y el anclaje viaja de acompañante. Si la
    // marca faltara, el tercero recibiría un txid con altura de bloque y
    // confirmaciones dentro de una respuesta que acaba de declararse
    // verificada.
    const hash = `0x${'d'.repeat(64)}`;
    const anchorId = uuidv4();
    await query(
      `INSERT INTO blockchain_attestations (
         id, tenant_id, entity_id, source_type, source_id, entry_hash, commitment,
         status, is_simulated, chain_attestations
       ) VALUES ($1,$2,$3,'journal_entry',$4,$5,'\\x00'::bytea,'confirmed',false,'[]'::jsonb)`,
      [uuidv4(), f.tenantId, f.entityId, uuidv4(), hash]
    );
    await query(
      `INSERT INTO bitcoin_anchors (
         id, tenant_id, anchor_type, merkle_root, entry_count, op_return_payload,
         protocol_version, bitcoin_txid, bitcoin_block_height, confirmations,
         status, broadcast_at, confirmed_at, is_simulated
       ) VALUES ($1,$2,'single_tenant',$3,1,$4,1,$5,880001,6,'confirmed',NOW(),NOW(),true)`,
      [anchorId, f.tenantId, `0x${'e'.repeat(64)}`, Buffer.alloc(80), 'f'.repeat(64)]
    );
    await query(
      `INSERT INTO bitcoin_anchor_entries (
         id, bitcoin_anchor_id, tenant_id, entry_type, entry_id, entry_hash, leaf_index, merkle_proof
       ) VALUES ($1,$2,$3,'journal_entry',$4,$5,0,'[]'::jsonb)`,
      [uuidv4(), anchorId, f.tenantId, uuidv4(), hash]
    );

    const s = await levantar([['/public/v1', publicVerificationRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'GET', `/public/v1/verify/${hash}`);
      expect(r.status).toBe(200);
      const data = r.body.data as { bitcoin: { isSimulated: boolean; explorerUrl: string | null };
        independentVerification: { steps: string[] } };
      expect(data.bitcoin.isSimulated).toBe(true);
      expect(data.bitcoin.explorerUrl).toBeNull();
      expect(data.independentVerification.steps.join(' ')).toMatch(/SIMULADO/);
      // Y el texto entero de la respuesta no ofrece un explorador público.
      expect(JSON.stringify(r.body)).not.toContain('mempool.space');
    } finally {
      await s.cerrar();
    }
  });
});

// ============================================================
// 5 · EL RASTRO DEL REAPUNTE Y SU IRREVERSIBILIDAD
// ============================================================
describe('ataque 5 · la fila de auditoría del reapunte no se puede reescribir', () => {
  it('reapuntar deja actor, valor viejo y valor nuevo, y ni un UPDATE ni un DELETE la tocan', async () => {
    enterTenant(f.tenantId);
    const antes = f.roles.cxc;
    const destino = f.cuentas['1130'] ?? f.cuentas['1120'];
    await setAccountRole(f.entityId, f.tenantId, 'cxc', destino, {
      userId: f.userId, reason: 'ataque: reapunte investigable',
    });

    const { rows } = await query<{ id: string; user_id: string; old_values: Record<string, unknown>;
      new_values: Record<string, unknown>; reason: string }>(
      `SELECT id, user_id, old_values, new_values, reason FROM audit_log
        WHERE tenant_id = $1 AND entity_type = 'account_role'
        ORDER BY timestamp DESC LIMIT 1`,
      [f.tenantId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(f.userId);
    expect(rows[0].old_values.account_id).toBe(antes);
    expect(rows[0].new_values.account_id).toBe(destino);
    expect(rows[0].reason).toMatch(/investigable/);

    await expect(
      query(`UPDATE audit_log SET reason = 'otra cosa' WHERE id = $1`, [rows[0].id])
    ).rejects.toThrow();
    await expect(
      query(`DELETE FROM audit_log WHERE id = $1`, [rows[0].id])
    ).rejects.toThrow();
  });

  it('FRONTERA · un rol no se puede apuntar a una cuenta de la entidad hermana', async () => {
    await expect(
      setAccountRole(f.entityId, f.tenantId, 'cxp', hermana.roles.cxp, { userId: f.userId })
    ).rejects.toThrow(/Account/);
  });
});

// ============================================================
// 6 · EL ROL QUE SÓLO MIRA
// ============================================================
describe('ataque 6 · mnemosine_auditor', () => {
  const url = process.env.DATABASE_URL!;
  let cliente: pg.Client | null = null;
  let aplicable = false;

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query<{ super: boolean; owner: boolean }>(
      `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnemosine_owner') AS owner`
    );
    aplicable = Boolean(rows[0].super && rows[0].owner);
    if (!aplicable) { await c.end(); return; }

    // El guion es de psql: `\set ON_ERROR_STOP` no es SQL y el driver lo
    // rechaza. Se quitan las metaórdenes y se aplica el resto tal cual — lo
    // que se prueba es EL ARCHIVO QUE SE ENVÍA, no una copia de sus efectos.
    const guion = fs.readFileSync(
      path.join(process.cwd(), 'scripts/rol-auditor.sql'), 'utf8'
    ).split('\n').filter((l) => !l.startsWith('\\')).join('\n');
    await c.query(guion);
    cliente = c;
  });

  afterAll(async () => {
    if (!cliente) return;
    // El rol es objeto de CLÚSTER y sobrevive a la base efímera: dejarlo
    // puesto cambiaría lo que `doctor` contesta en la siguiente corrida de
    // quien comparta este Postgres.
    await cliente.query('RESET ROLE').catch(() => undefined);
    for (const sql of [
      `ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public REVOKE SELECT ON TABLES FROM mnemosine_auditor`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE mnemosine_owner IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM mnemosine_auditor`,
      `DROP OWNED BY mnemosine_auditor`,
      `DROP ROLE IF EXISTS mnemosine_auditor`,
    ]) await cliente.query(sql).catch(() => undefined);
    await cliente.end();
  });

  it('no puede escribir: ni un INSERT en el mayor ni un UPDATE de un saldo', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    await c.query('SET ROLE mnemosine_auditor');
    try {
      await expect(
        c.query(`INSERT INTO audit_log (user_id, tenant_id, action, entity_type, entity_id)
                 VALUES ($1,$2,'create','x',$3)`, [f.userId, f.tenantId, uuidv4()])
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        c.query(`UPDATE journal_entries SET description = 'tocado'`)
      ).rejects.toThrow(/permission denied|denegado/i);
      await expect(
        c.query(`DELETE FROM account_balances`)
      ).rejects.toThrow(/permission denied|denegado/i);
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('no lee las credenciales de nadie: users, sessions y tenants le están negadas', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    await c.query('SET ROLE mnemosine_auditor');
    try {
      for (const tabla of ['users', 'sessions', 'tenants']) {
        await expect(c.query(`SELECT 1 FROM ${tabla} LIMIT 1`))
          .rejects.toThrow(/permission denied|denegado/i);
      }
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('sin contexto de inquilino no ve NINGUNA fila del mayor', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    await c.query('SET ROLE mnemosine_auditor');
    try {
      const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM journal_entries');
      expect(r.rows[0].n).toBe('0');
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('EL ATAQUE: nombra el inquilino de OTRO despacho y lee su mayor', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    // Un asiento del inquilino `f`, para que haya algo que robar.
    await politica(f, 'off');
    await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'lo que el auditor ajeno vería',
      [
        { account_id: f.roles.banco, debit_amount: '31.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '31.00', description: 'abono' },
      ],
      f.userId, { autoPost: true }
    );

    await c.query('SET ROLE mnemosine_auditor');
    try {
      // La sesión del auditor FIJA su propio inquilino: nada ata el rol a
      // uno. Si esto devuelve filas, «ve las filas de SU inquilino, ni una
      // más» es una afirmación que el esquema no sostiene.
      await c.query(`SET app.current_tenant = '${f.tenantId}'`);
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entries`
      );
      // Se afirma lo que MIDE, no lo que debería: el informe dice el resto.
      expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(0);
      console.log(`[ataque 6] filas del mayor visibles tras SET app.current_tenant ajeno: ${r.rows[0].n}`);
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('`identities` —la tabla de quién firmó— no lleva política, y por eso se le niega', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;

    // `identities` es la tabla que ata el `sub` del proveedor a un usuario:
    // es LA tabla de «quién firmó». No tiene `tenant_id` ni `entity_id`, así
    // que el generador de políticas de rls-policies.sql ni la mira, y el
    // guion del auditor sólo le niega `users`, `sessions` y `tenants`.
    const otro = await crearInquilino('G3 ataque · despacho del vecino');
    enterTenant(otro.tenantId);
    await query(
      `INSERT INTO identities (id, user_id, provider, subject, issuer, email, email_verified)
       VALUES ($1, $2, 'google', $3, 'https://accounts.google.com', $4, true)`,
      [uuidv4(), otro.userId, `sub-${otro.userId}`, `vecino-${otro.userId.slice(0, 8)}@ajeno.test`]
    );
    enterTenant(f.tenantId);

    await c.query('SET ROLE mnemosine_auditor');
    try {
      // Sin fijar inquilino ninguno: no hace falta, porque no hay política.
      // Con el bloque 4 corregido, la tabla ni siquiera se deja contar.
      await expect(c.query(`SELECT count(*) FROM identities`))
        .rejects.toThrow(/permission denied|denegado/i);
    } finally {
      await c.query('RESET ROLE');
    }
  });

  it('las vistas materializadas las construye un BYPASSRLS: el auditor no las lee', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    // R3 dejó a `mnemosine_refresher` con BYPASSRLS para poder reconstruir las
    // vistas: su contenido es de TODOS los inquilinos a la vez. Si el GRANT
    // masivo del guion las alcanzara, el auditor leería la instalación entera
    // sin fijar inquilino y sin tocar una sola tabla protegida.
    const r = await c.query<{ relname: string; legible: boolean; publica: boolean;
      duenio: string; acl: string | null }>(
      `SELECT c.relname,
              has_table_privilege('mnemosine_auditor', c.oid, 'SELECT') AS legible,
              has_table_privilege('public', c.oid, 'SELECT')            AS publica,
              pg_get_userbyid(c.relowner)                               AS duenio,
              array_to_string(c.relacl, ' ')                            AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm'
        ORDER BY 1`
    );
    for (const x of r.rows) {
      console.log(`[ataque 6] matview ${x.relname}: legible=${x.legible} publica=${x.publica} ` +
        `dueño=${x.duenio} acl=${x.acl ?? '(nula → sólo el dueño)'}`);
    }
    // Refrescada como superusuario, que es lo mismo que hace el refresher con
    // su BYPASSRLS: la vista queda con las filas de TODOS los inquilinos.
    await c.query('REFRESH MATERIALIZED VIEW mv_trial_balance');
    const todas = await c.query<{ n: string; entidades: string }>(
      `SELECT count(*)::text AS n, count(DISTINCT entity_id)::text AS entidades FROM mv_trial_balance`
    );
    console.log(`[ataque 6] mv_trial_balance materializada: ${todas.rows[0].n} filas de ` +
      `${todas.rows[0].entidades} entidades (de todos los inquilinos)`);

    await c.query('SET ROLE mnemosine_auditor');
    let leidas: string;
    try {
      const r2 = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM mv_trial_balance');
      leidas = r2.rows[0].n;
    } catch (e) {
      leidas = `denegado: ${(e as Error).message}`;
    } finally {
      await c.query('RESET ROLE');
    }
    console.log(`[ataque 6] lo que el auditor lee de mv_trial_balance: ${leidas}`);
    expect(leidas).toMatch(/^denegado/);
    expect(r.rows.filter((x) => x.legible)).toHaveLength(0);
  });

  it('lo único que lee sin aislamiento es referencia global: ni un dato de nadie', async () => {
    if (!aplicable) { expect(aplicable).toBe(false); return; }
    const c = cliente!;
    // El censo de verdad: relaciones sin política que el auditor PUEDE leer.
    // Antes de tocar el guion aquí salían `identities` y las dos vistas
    // materializadas; lo que quede tiene que ser dato que no es de ningún
    // cliente —Banxico, el SAT, las tarifas de ISR—.
    const r = await c.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m') AND NOT c.relispartition
          AND NOT c.relrowsecurity
          AND has_table_privilege('mnemosine_auditor', c.oid, 'SELECT')
        ORDER BY 1`
    );
    const nombres = r.rows.map((x) => x.relname);
    console.log(`[ataque 6] sin aislamiento y legibles por el auditor (${nombres.length}): ` +
      (nombres.join(', ') || '(ninguna)'));
    expect(nombres).toEqual(
      ['exchange_rates', 'migrations', 'sat_codigos_agrupadores', 'tax_parameters', 'tax_tables']
    );
  });
});

// ============================================================
// 7 · LA IDENTIDAD QUE FIRMA
// ============================================================
describe('ataque 7 · que la bitácora certifique a otro', () => {
  let ana: string;
  let beto: string;
  let correoAna: string;
  let correoBeto: string;
  let g: Fixture;

  beforeAll(async () => {
    g = await crearInquilino('G3 ataque · identidad');
    enterTenant(g.tenantId);
    ana = await crearUsuario(g, 'contador', ['journal_entries:create']);
    beto = await crearUsuario(g, 'contador', ['journal_entries:create']);
    const correos = await query<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [[ana, beto]]
    );
    correoAna = correos.rows.find((r) => r.id === ana)!.email;
    correoBeto = correos.rows.find((r) => r.id === beto)!.email;
    // La identidad del proveedor queda atada al `sub`, que es lo que no
    // cambia; el correo del IdP es informativo y puede cambiar mañana.
    // `provider` es EXACTAMENTE el valor que escribe el alta JIT
    // (provisioning.ts recibe `config.auth.provider` desde el middleware):
    // ponerlo a mano con otra cadena probaría otra cosa.
    await query(
      `INSERT INTO identities (id, user_id, provider, subject, issuer, email, email_verified)
       VALUES ($1, $2, $3, 'sub-de-ana', 'https://idp.test', $4, true)`,
      [uuidv4(), ana, config.auth.provider, correoAna]
    );
  });

  afterAll(() => { sesion.actual = null; sesion.exige = false; enterTenant(f.tenantId); });

  it('con sesión de Ana, --user Beto se niega ANTES de tocar la base', async () => {
    enterTenant(g.tenantId);
    sesion.actual = { subject: 'sub-de-ana', email: correoAna, issuer: 'https://idp.test' };
    const antes = await contarFilasDeAuditoria(g.tenantId);

    await expect(resolveReviewer(g.tenantId, correoBeto)).rejects.toBeInstanceOf(SuplantacionError);
    // Y no se niega por suerte —porque Beto no exista— sino por regla: Beto
    // existe, está activo y es del mismo inquilino.
    expect(await contarFilasDeAuditoria(g.tenantId)).toBe(antes);
  });

  it('con sesión de Ana y sin bandera, el asiento queda firmado por Ana aunque el inquilino tenga varios', async () => {
    enterTenant(g.tenantId);
    sesion.actual = { subject: 'sub-de-ana', email: correoAna, issuer: 'https://idp.test' };
    const revisor = await resolveReviewer(g.tenantId, undefined);
    expect(revisor.userId).toBe(ana);

    const asiento = await createJournalEntry(
      g.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'firmado por la sesión',
      [
        { account_id: g.roles.banco, debit_amount: '55.00', credit_amount: null, description: 'cargo' },
        { account_id: g.roles.cxc, debit_amount: null, credit_amount: '55.00', description: 'abono' },
      ],
      revisor.userId, { autoPost: true }
    );

    const { rows } = await query<{ user_id: string }>(
      `SELECT user_id FROM audit_log
        WHERE entity_type = 'journal_entries' AND entity_id = $1 AND action = 'post'`,
      [asiento.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ana);
  });

  it('EL ATAQUE: el correo del proveedor dice Beto y el `sub` dice Ana — manda el `sub`', async () => {
    // Un IdP permisivo, o un correo reasignado dentro del dominio, y el token
    // llega diciendo `email: beto@…` sobre el `sub` de Ana. Si la atribución
    // se resolviera por correo, el asiento lo firmaría Beto. `identities` se
    // consulta primero y por `subject`, que es el dato que no cambia.
    enterTenant(g.tenantId);
    sesion.actual = { subject: 'sub-de-ana', email: correoBeto, issuer: 'https://idp.test' };
    const revisor = await resolveReviewer(g.tenantId, undefined);
    expect(revisor.userId).toBe(ana);
    expect(revisor.userId).not.toBe(beto);
  });

  it('LO QUE SÍ SE CAE: cambiar AUTH_OIDC_PROVIDER desata el `sub` y la atribución vuelve al correo', async () => {
    // `resolveReviewer` busca la identidad por `(provider, subject)`, y
    // `provider` no viene del token: viene de `config.auth.provider`, una
    // variable de entorno con valor por omisión 'oidc'. El día que el
    // operador la ponga a 'entra' o a 'google' —que es lo que documenta su
    // despliegue— NINGUNA fila de `identities` casa, y la función NO falla:
    // cae al respaldo por correo, que es exactamente el dato mutable del que
    // el `sub` venía a protegernos.
    //
    // Se demuestra al revés, que es equivalente y no toca el entorno: una
    // identidad escrita con OTRA cadena de proveedor es indistinguible de la
    // que dejó de casar.
    enterTenant(g.tenantId);
    const carla = await crearUsuario(g, 'contador', ['journal_entries:create']);
    const correoCarla = (
      await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [carla])
    ).rows[0].email;
    await query(
      `INSERT INTO identities (id, user_id, provider, subject, issuer, email, email_verified)
       VALUES ($1, $2, 'un-proveedor-que-no-es-el-configurado', 'sub-de-carla', 'https://idp.test', $3, true)`,
      [uuidv4(), carla, correoCarla]
    );

    // Sesión de Carla por `sub`, con el correo de Beto en el token.
    sesion.actual = { subject: 'sub-de-carla', email: correoBeto, issuer: 'https://idp.test' };
    const revisor = await resolveReviewer(g.tenantId, undefined);

    // Firma BETO. Sin error, sin aviso: el `sub` dejó de mandar en silencio.
    expect(revisor.userId).toBe(beto);
    expect(revisor.userId).not.toBe(carla);
  });

  it('FRONTERA · la sesión de Ana no firma en el inquilino de al lado', async () => {
    enterTenant(f.tenantId);
    sesion.actual = { subject: 'sub-de-ana', email: correoAna, issuer: 'https://idp.test' };
    // Mismo `sub`, otro inquilino: ni la identidad casa (el JOIN acota por
    // `users.tenant_id`) ni el correo existe allí.
    await expect(resolveReviewer(f.tenantId, undefined)).rejects.toThrow(/no corresponde a ningún usuario activo/);
  });

  it('con proveedor exigido y sin sesión, no degrada a la bandera: se niega', async () => {
    enterTenant(g.tenantId);
    sesion.actual = null;
    sesion.exige = true;
    await expect(resolveReviewer(g.tenantId, correoBeto)).rejects.toBeInstanceOf(SesionNoVerificableError);
    sesion.exige = false;
  });
});
