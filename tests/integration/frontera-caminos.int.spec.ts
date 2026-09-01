import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { validateJournalEntry } from '../../src/services/accounting/validation.js';
import { findBestMatch } from '../../src/services/banking/matching.js';
import { entityScope } from '../../src/database/scope.js';
import { resolvers } from '../../src/api/graphql/resolvers/index.js';
import bankReconciliationRouter from '../../src/api/rest/routes/bank-reconciliation.js';
import blockchainRouter from '../../src/api/rest/routes/blockchain.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import type { JournalEntry, JournalEntryLine } from '../../src/types/index.js';

/**
 * LOS CINCO CAMINOS QUE QUEDABAN, CONTRA POSTGRES REAL.
 *
 * El primer tramo de TEN-1 cerró la anulación de facturas y dejó enumerados
 * cinco cruces de la frontera de entidad con ruta de ataque comprobada. Éstas
 * son sus pruebas.
 *
 * Corren como SUPERUSUARIO, con RLS inerte a propósito: lo que demuestran es
 * la frontera del CÓDIGO, no la de la base. Si pasan aquí, pasan también con
 * RLS activa. Y sobre todo: RLS acota por INQUILINO, mientras que lo que aquí
 * se cruza es la frontera de ENTIDAD — el eje que RLS no cubre ni activa.
 *
 * Las pruebas de ruta hablan por HTTP contra el router REAL (helpers/
 * servidor.ts). Llamar al servicio directamente daría por bueno justo lo que
 * se arregla: que la ruta le pase el alcance correcto.
 */

/**
 * `a` y `b` son dos entidades legales del MISMO inquilino: el par sobre el que
 * RLS no acota NADA, porque su predicado es el inquilino. Si la prueba usara
 * dos inquilinos distintos podría pasar por el motivo equivocado —el que RLS
 * sí defendería— y no demostraría la frontera de entidad.
 *
 * `c` es un inquilino aparte, y sólo aparece en el camino 2, donde lo que se
 * viola es precisamente la pareja (inquilino, entidad) que se escribe en la
 * fila.
 */
let a: Fixture;
let b: Fixture;
let c: Fixture;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('Caminos A');
  b = await crearEntidadHermana(a, 'Caminos B');
  c = await crearInquilino('Caminos C');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

const unaCuentaDe = (f: Fixture): string => Object.values(f.cuentas)[0];

// ── Camino 1: auto-conciliación bancaria ────────────────────────────────

async function cuentaBancaria(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code)
     VALUES ($1, $2, 'Cuenta operativa', 'Banco de prueba', $3, 'MXN')`,
    [id, f.entityId, f.roles.banco ?? unaCuentaDe(f)]
  );
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, bank_transaction_id, transaction_date,
       amount, transaction_type, description)
     VALUES ($1, $2, $3, $4, 1160.00, 'credit', 'Depósito')`,
    [uuidv4(), id, `TX-${uuidv4().slice(0, 8)}`, fechaEnPeriodo()]
  );
  return id;
}

/** Una factura pendiente de cobro, candidata a conciliar. */
async function facturaDe(f: Fixture, total: string): Promise<string> {
  const id = uuidv4();
  const marca = uuidv4().slice(0, 8);
  const clienteId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente','MXN',$4)`,
    [clienteId, f.entityId, `C-${marca}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (
       id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$5,1000,160,$6,$6,0,'MXN','sent',$7)`,
    [id, f.entityId, `INV-${marca}`, clienteId, fechaEnPeriodo(), total, f.userId]
  );
  return id;
}

describe('camino 1 — conciliar el extracto de otra entidad', () => {
  let cuentaDeB: string;
  let cuentaDeA: string;

  beforeAll(async () => {
    cuentaDeB = await cuentaBancaria(b);
    cuentaDeA = await cuentaBancaria(a);
  });

  it('con el UUID de una cuenta ajena responde 404 y no toca su extracto', async () => {
    // POST /:account_id/auto-match pasaba req.params.account_id crudo al motor
    // y la ruta no lleva requireEntityAccess. El motor deducía la entidad DE LA
    // PROPIA CUENTA, así que los candidatos eran las facturas y los gastos de
    // la víctima: se conciliaba su extracto entero. Y period-close.ts lee el
    // estado de conciliación como evidencia de cierre, así que el efecto
    // llegaba a la contabilidad.
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', `/v1/bank-accounts/${cuentaDeB}/auto-match`);
      expect(r.status).toBe(404);
    } finally {
      await s.cerrar();
    }

    const bd = await query<{ is_matched: boolean }>(
      'SELECT is_matched FROM bank_transactions WHERE bank_account_id = $1',
      [cuentaDeB]
    );
    expect(
      bd.rows.every((t) => t.is_matched === false),
      'el extracto ajeno sigue sin conciliar'
    ).toBe(true);

    const marcas = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM reconciliation_matches rm
        JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       WHERE bt.bank_account_id = $1`,
      [cuentaDeB]
    );
    expect(marcas.rows[0].n).toBe('0');
  });

  it('404 y no 403: no distingue la cuenta ajena de la inexistente', async () => {
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    try {
      const ajena = await pedir(s, 'POST', `/v1/bank-accounts/${cuentaDeB}/auto-match`);
      const inventada = await pedir(s, 'POST', `/v1/bank-accounts/${uuidv4()}/auto-match`);
      expect(ajena.status).toBe(inventada.status);
      expect(ajena.status).toBe(404);
    } finally {
      await s.cerrar();
    }
  });

  it('sobre su propia cuenta sigue funcionando', async () => {
    // La frontera no puede ser «lanza siempre»: sin esto, la prueba de arriba
    // pasaría con un `throw` incondicional.
    const s = await levantar([['/v1/bank-accounts', bankReconciliationRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', `/v1/bank-accounts/${cuentaDeA}/auto-match`);
      expect(r.status).toBe(200);
      expect((r.body.data as Record<string, unknown>).unmatched).toBe(1);
    } finally {
      await s.cerrar();
    }
  });

  it('findBestMatch tampoco propone candidatos del catálogo ajeno', async () => {
    // El guarda de autoMatchUnreconciled corta antes de llegar aquí, así que
    // el acotado de getCandidates es redundante POR ESA PUERTA. Pero
    // findBestMatch está exportada y no escribe: devuelve el id de la factura
    // o el gasto con el que casa. Sin acotar, con el UUID de una cuenta ajena
    // devolvía identificadores del mayor de la víctima — divulgación, no
    // escritura. Esta prueba existe porque una mutación lo descubrió: quitar
    // el acotado de getCandidates no rompía ninguna de las otras veinte.
    const factura = await facturaDe(b, '1160.00');
    const tx = await query<{ id: string; amount: string; transaction_date: Date; description: string }>(
      'SELECT * FROM bank_transactions WHERE bank_account_id = $1 LIMIT 1',
      [cuentaDeB]
    );

    const conAlcanceAjeno = await findBestMatch(
      cuentaDeB,
      tx.rows[0] as never,
      entityScope(a.tenantId, a.entityId)
    );
    expect(conAlcanceAjeno, 'no debe proponer nada del mayor de otra entidad').toBeNull();

    // Y con el alcance de su dueño sí lo encuentra: la frontera acota, no apaga.
    const conSuAlcance = await findBestMatch(
      cuentaDeB,
      tx.rows[0] as never,
      entityScope(b.tenantId, b.entityId)
    );
    expect(conSuAlcance?.match_id).toBe(factura);
  });
});

// ── Camino 2: publicación de agregados ──────────────────────────────────

describe('camino 2 — publicar los agregados de otra entidad', () => {
  it('la ruta rechaza un entity_id del cuerpo que el token no concede', async () => {
    // requireEntityAccess NO habría servido: mira el PRIMERO de (req.entityId,
    // params, body), y req.entityId siempre tiene valor, así que en esta ruta
    // habría validado la cabecera y nunca el cuerpo.
    const s = await levantar([['/v1/admin/blockchain', blockchainRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', '/v1/admin/blockchain/publish-aggregates', {
        entity_id: b.entityId,
        period_id: b.periodos[8],
      });
      expect(r.status).toBe(403);
    } finally {
      await s.cerrar();
    }
  });

  it('y el servicio lo rechaza aunque el token conceda una entidad de OTRO inquilino', async () => {
    // La segunda capa, y la que de verdad protege la fila. Lo que se escribe
    // en published_aggregates es la pareja (tenant_id del token, entity_id del
    // cuerpo), y nadie comprobaba que la segunda colgara del primero: la fila
    // nacía con el inquilino del atacante y la entidad de la víctima. Un token
    // rancio, o uno emitido por un proveedor de identidad comprometido, bastan
    // para saltarse la capa de la ruta — por eso hay una segunda.
    const s = await levantar(
      [['/v1/admin/blockchain', blockchainRouter]],
      sesionDe(a, [a.entityId, c.entityId])
    );
    try {
      const r = await pedir(s, 'POST', '/v1/admin/blockchain/publish-aggregates', {
        entity_id: c.entityId,
        period_id: c.periodos[8],
      });
      expect(r.status).toBe(404);
    } finally {
      await s.cerrar();
    }
  });

  it('no queda ninguna fila publicada de las entidades ajenas', async () => {
    // Es lo que hacía grave este camino: published_aggregates se sirve DESPUÉS
    // SIN AUTENTICAR en GET /public/v1/entities/:entityId/aggregates, que
    // filtra sólo por entity_id. Escribir aquí era publicar al mundo.
    const r = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM published_aggregates WHERE entity_id = ANY($1)',
      [[b.entityId, c.entityId]]
    );
    expect(r.rows[0].n).toBe('0');
  });

  it('sobre su propia entidad la ruta llega al servicio', async () => {
    const s = await levantar([['/v1/admin/blockchain', blockchainRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', '/v1/admin/blockchain/publish-aggregates', {
        entity_id: a.entityId,
        period_id: a.periodos[8],
      });
      expect(r.status).toBe(200);
    } finally {
      await s.cerrar();
    }
  });
});

// ── Camino 3: mutaciones de GraphQL ─────────────────────────────────────

async function asientoBorrador(f: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO journal_entries (id, entity_id, fiscal_period_id, entry_number, entry_type,
       entry_date, description, status, created_by)
     VALUES ($1, $2, $3, $4, 'standard', $5, 'Borrador', 'draft', $6)`,
    [id, f.entityId, f.periodos[8], `JE-${uuidv4().slice(0, 8)}`, fechaEnPeriodo(), f.userId]
  );
  return id;
}

describe('camino 3 — las mutaciones de GraphQL', () => {
  const ctxDe = (f: Fixture, otra?: Fixture) => ({
    user: {
      user_id: f.userId,
      entities: [f.entityId, ...(otra ? [otra.entityId] : [])],
      permissions: ['*'],
    },
    tenantId: f.tenantId,
    entityId: f.entityId,
  });

  it('postJournalEntry sobre un asiento ajeno lanza NotFound y lo deja en borrador', async () => {
    // Su único control era leer `SELECT entity_id FROM journal_entries WHERE
    // id = $1` sin acotar y comparar después: ventana entre la comprobación y
    // la escritura, y 403 sobre un asiento ajeno frente a 404 sobre uno
    // inventado, que convierte la mutación en oráculo del mayor ajeno.
    const ajeno = await asientoBorrador(b);
    await expect(
      resolvers.Mutation.postJournalEntry(null, { id: ajeno }, ctxDe(a))
    ).rejects.toThrow(/not found/i);

    const bd = await query<{ status: string }>(
      'SELECT status FROM journal_entries WHERE id = $1',
      [ajeno]
    );
    expect(bd.rows[0].status).toBe('draft');
  });

  it('voidJournalEntry, igual', async () => {
    const ajeno = await asientoBorrador(b);
    await expect(
      resolvers.Mutation.voidJournalEntry(null, { id: ajeno, reason: 'x' }, ctxDe(a))
    ).rejects.toThrow(/not found/i);
    const bd = await query<{ status: string }>(
      'SELECT status FROM journal_entries WHERE id = $1',
      [ajeno]
    );
    expect(bd.rows[0].status).toBe('draft');
  });

  it('el asiento ajeno tampoco se lee: la consulta por id devuelve null', async () => {
    const ajeno = await asientoBorrador(b);
    expect(await resolvers.Query.journalEntry(null, { id: ajeno }, ctxDe(a))).toBeNull();
  });

  it('tener la entidad concedida NO basta si no es la entidad activa', async () => {
    // El alcance de la petición es UNO. Que el token conceda varias entidades
    // no convierte cada mutación en una sobre todas ellas.
    const ajeno = await asientoBorrador(b);
    await expect(
      resolvers.Mutation.postJournalEntry(null, { id: ajeno }, ctxDe(a, b))
    ).rejects.toThrow(/not found/i);
  });

  it('sin inquilino o sin entidad la petición no se acota, y no se sigue', async () => {
    const propio = await asientoBorrador(a);
    await expect(
      resolvers.Mutation.postJournalEntry(null, { id: propio }, {
        user: { user_id: a.userId, entities: [a.entityId], permissions: ['*'] },
        tenantId: undefined,
        entityId: undefined,
      })
    ).rejects.toThrow(/no puede acotarse/);
  });

  it('sobre lo suyo, la lectura sigue devolviendo el asiento', async () => {
    const propio = await asientoBorrador(a);
    const leido = await resolvers.Query.journalEntry(null, { id: propio }, ctxDe(a));
    expect((leido as { id: string } | null)?.id).toBe(propio);
  });
});

// ── Camino 4: carga de pre-registros ────────────────────────────────────

/** Un pre-registro listo para contabilizar, con la forma que espera el motor. */
async function preRegistro(f: Fixture): Promise<string> {
  const ref = uuidv4().slice(0, 8);
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
       currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor de prueba','BBB020202BB2','rfc','MXN',$4)`,
    [vendorId, f.entityId, `V-${ref}`, f.userId]
  );

  const cuentaGasto = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`,
    [f.entityId]
  );
  const lines = [
    {
      line_number: 1,
      clave_prod_serv: '01010101',
      clave_unidad: 'E48',
      descripcion: 'Servicio',
      cantidad: 1,
      valor_unitario: 1000,
      importe: 1000,
      suggested_account_id: cuentaGasto.rows[0].id,
      suggested_account_confidence: 1,
      suggestion_reason: 'prueba',
    },
  ];

  const id = uuidv4();
  const fecha = fechaEnPeriodo();
  await query(
    `INSERT INTO pre_registrations (
       id, entity_id, source_type, document_type, vendor_id, external_reference,
       document_date, due_date, currency_code, subtotal, tax_amount, total_amount,
       lines, default_account_id, status, created_by
     ) VALUES ($1,$2,'manual','bill',$3,$4,$5,$5,'MXN',1000,160,1160,$6::jsonb,$7,'ready',$8)`,
    [id, f.entityId, vendorId, `PR-${ref}`, fecha, JSON.stringify(lines),
     cuentaGasto.rows[0].id, f.userId]
  );
  return id;
}

describe('camino 4 — procesar el pre-registro de otra entidad', () => {
  it('/process responde 404 y no contabiliza nada en el mayor ajeno', async () => {
    // Cargaba la fila entera sin acotar y se la pasaba a processToAccounting,
    // que POSTEA. El documento trae su propio entity_id, así que el asiento
    // nacía bien formado y caía en el mayor de la víctima.
    const ajeno = await preRegistro(b);
    const antes = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM journal_entries WHERE entity_id = $1',
      [b.entityId]
    );

    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', `/v1/pre-registrations/${ajeno}/process`);
      expect(r.status).toBe(404);
    } finally {
      await s.cerrar();
    }

    const despues = await query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM journal_entries WHERE entity_id = $1',
      [b.entityId]
    );
    expect(despues.rows[0].n, 'no nació ningún asiento en la entidad ajena').toBe(antes.rows[0].n);

    const estado = await query<{ status: string }>(
      'SELECT status FROM pre_registrations WHERE id = $1',
      [ajeno]
    );
    expect(estado.rows[0].status, 'sigue sin contabilizar').toBe('ready');
  });

  it('las rutas hermanas tampoco lo mutan: rechazar, aprobar, editar y leer', async () => {
    // Cerrar /process y dejar /reject abierta no cierra el camino.
    const ajeno = await preRegistro(b);
    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(a));
    try {
      expect(
        (await pedir(s, 'POST', `/v1/pre-registrations/${ajeno}/reject`, { reason: 'x' })).status
      ).toBe(404);
      expect((await pedir(s, 'POST', `/v1/pre-registrations/${ajeno}/approve`, {})).status).toBe(404);
      expect(
        (await pedir(s, 'PATCH', `/v1/pre-registrations/${ajeno}`, { notes: 'mío' })).status
      ).toBe(404);
      expect((await pedir(s, 'GET', `/v1/pre-registrations/${ajeno}`)).status).toBe(404);
    } finally {
      await s.cerrar();
    }

    const bd = await query<{ status: string; notes: string | null }>(
      'SELECT status, notes FROM pre_registrations WHERE id = $1',
      [ajeno]
    );
    expect(bd.rows[0].status).toBe('ready');
    expect(bd.rows[0].notes).toBeNull();
  });

  it('el lote deja de reportar éxito sobre ids que no puede tocar', async () => {
    // Antes: si la fila no aparecía, `process` empujaba `success` igual. Un id
    // ajeno daba la misma respuesta satisfactoria que uno propio contabilizado.
    const ajeno = await preRegistro(b);
    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', '/v1/pre-registrations/bulk', {
        action: 'process',
        ids: [ajeno],
      });
      const resultados = (r.body.data as { results: Array<{ status: string }> }).results;
      expect(resultados[0].status).toBe('error');
    } finally {
      await s.cerrar();
    }
  });

  it('sobre el suyo, /process sigue llegando al motor', async () => {
    const propio = await preRegistro(a);
    const s = await levantar([['/v1', xmlIngestionRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'POST', `/v1/pre-registrations/${propio}/process`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally {
      await s.cerrar();
    }
  });
});

// ── Camino 5: el account_id de las líneas ───────────────────────────────

describe('camino 5 — una línea contra la cuenta de otra entidad', () => {
  const asientoDe = (f: Fixture): JournalEntry =>
    ({
      id: uuidv4(),
      entity_id: f.entityId,
      fiscal_period_id: f.periodos[8],
      entry_type: 'standard',
      description: 'Prueba de frontera',
      status: 'draft',
    }) as unknown as JournalEntry;

  const linea = (n: number, accountId: string, debe?: string, haber?: string): JournalEntryLine =>
    ({
      line_number: n,
      account_id: accountId,
      debit_amount: debe ?? null,
      credit_amount: haber ?? null,
      description: '',
      currency_code: null,
    }) as unknown as JournalEntryLine;

  it('la validación la rechaza: la cuenta ajena no existe PARA ESTA ENTIDAD', async () => {
    // Las tres reglas que leen cuentas resolvían por id GLOBALMENTE, y el
    // account_id llega crudo del cuerpo de la petición. La cuenta ajena se
    // encontraba y se validaba contra SUS banderas, así que el asiento pasaba
    // y posteaba: el disparador movía account_balances de una cuenta que no es
    // de la entidad del asiento, y la balanza de la víctima se desplazaba por
    // un asiento que no está en su mayor.
    const cuentaAjena = unaCuentaDe(b);
    const r = await validateJournalEntry(asientoDe(a), [
      linea(1, unaCuentaDe(a), '100.00'),
      linea(2, cuentaAjena, undefined, '100.00'),
    ]);

    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => e.includes(cuentaAjena))).toBe(true);
  });

  it('el rechazo no delata que la cuenta exista en otra parte', async () => {
    // Una cuenta ajena y una inventada dan el MISMO error. Es el mismo
    // criterio que el 404-siempre de scope.ts, aplicado al texto.
    const inventada = uuidv4();
    const ajena = unaCuentaDe(b);

    const conAjena = await validateJournalEntry(asientoDe(a), [
      linea(1, unaCuentaDe(a), '100.00'),
      linea(2, ajena, undefined, '100.00'),
    ]);
    const conInventada = await validateJournalEntry(asientoDe(a), [
      linea(1, unaCuentaDe(a), '100.00'),
      linea(2, inventada, undefined, '100.00'),
    ]);

    const normaliza = (e: string[]) => e.map((m) => m.replace(ajena, 'ID').replace(inventada, 'ID'));
    expect(normaliza(conAjena.errors)).toEqual(normaliza(conInventada.errors));
  });

  it('las advertencias NIF tampoco citan el código de cuenta ajeno', async () => {
    // nifSubstance nombra la cuenta en un texto que el usuario SÍ ve. Sin
    // acotar, ese texto llevaba el código del catálogo de otra entidad.
    const ajena = unaCuentaDe(b);
    const codigoAjeno = Object.entries(b.cuentas).find(([, id]) => id === ajena)![0];
    const r = await validateJournalEntry(asientoDe(a), [
      linea(1, unaCuentaDe(a), '100.00'),
      linea(2, ajena, undefined, '100.00'),
    ]);
    expect(r.warnings.some((w) => w.includes(`"${codigoAjeno}"`))).toBe(false);
  });

  it('con las dos cuentas propias, la validación pasa como siempre', async () => {
    const codigos = Object.keys(a.cuentas).sort();
    const r = await validateJournalEntry(asientoDe(a), [
      linea(1, a.cuentas[codigos[0]], '100.00'),
      linea(2, a.cuentas[codigos[1]], undefined, '100.00'),
    ]);
    // Puede traer advertencias NIF; lo que importa es que no las rechace por
    // «cuenta no encontrada».
    expect(r.errors.filter((e) => /not found/.test(e))).toEqual([]);
  });
});

// ── Limpieza: GET /v1/journal-entries/:id ───────────────────────────────

describe('la ruta que mataba al proceso al defenderse', () => {
  it('un asiento ajeno da 404 y el servidor sigue en pie', async () => {
    // El manejador era `async` y NO iba envuelto en asyncHandler. Express 4 no
    // captura la promesa rechazada de un manejador asíncrono: el ForbiddenError
    // que lanzaba su propio control de pertenencia no llegaba al errorHandler
    // —la petición quedaba colgada— y el unhandledRejection de Node, que desde
    // la v15 aborta por omisión, tumbaba el proceso. Pedir en bucle asientos
    // ajenos era una negación de servicio de una línea, y la disparaba
    // justamente el control de seguridad.
    //
    // Que esta prueba RESPONDA —en vez de agotar el tiempo— es la mitad de lo
    // que demuestra.
    const ajeno = await asientoBorrador(b);
    const s = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(a));
    try {
      const r = await pedir(s, 'GET', `/v1/journal-entries/${ajeno}`);
      expect(r.status).toBe(404);

      // Y la otra mitad: 404, no 403. Antes ramificaba —403 si el asiento era
      // de otra entidad, 404 si no existía—, y esa diferencia convierte la
      // ruta en oráculo de existencia sobre el mayor ajeno.
      const inventado = await pedir(s, 'GET', `/v1/journal-entries/${uuidv4()}`);
      expect(inventado.status).toBe(r.status);

      // El proceso sigue atendiendo después de las dos.
      const propio = await asientoBorrador(a);
      expect((await pedir(s, 'GET', `/v1/journal-entries/${propio}`)).status).toBe(200);
    } finally {
      await s.cerrar();
    }
  });
});
