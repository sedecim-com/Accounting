import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { asyncHandler } from '../../src/api/rest/middleware/async-handler.js';

import { MONTAJES_V1 } from '../../src/api/rest/montajes.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';
import aiWebhooksRouter from '../../src/api/rest/routes/ai-webhooks.js';
import billsRouter from '../../src/api/rest/routes/bills.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';
import {
  declararRiesgoRuta,
  censarRutas,
  resumirCenso,
  auditarRiesgoDeRutas,
  VERBOS_QUE_MUTAN,
} from '../../src/api/rest/risk.js';

// ============================================================
// G4a · EL ATAQUE.
//
// Lo que este tramo promete es que ya no hay DOS MOTORES: que la API
// declara lo mismo que el binario, con las mismas cuatro palabras, y que
// el servidor no arranca si una ruta que muta calla. Una sola ruta que se
// escape devuelve la API a lo que era: la puerta de atrás con menos
// reglas.
//
// Así que aquí no se comprueba que el censo cuente bien. Se busca la
// ruta que se escapó, la declaración que pasa el censo sin hacer nada, y
// el acto que el CLI llama irreversible y REST llama escritura.
// ============================================================

let f: Fixture;          // entidad principal
let hermana: Fixture;    // entidad HERMANA del mismo inquilino: lo que RLS no acota
let s: Servidor;         // servidor con la sesión de la entidad principal

beforeAll(async () => {
  f = await crearInquilino('G4a ataque');
  hermana = await crearEntidadHermana(f, 'G4a ataque hermana');
  s = await levantar(
    [
      ['/v1/bills', billsRouter],
      ['/v1', xmlIngestionRouter],
      ['/v1/ataque', routerDeMuestra()],
    ],
    sesionDe(f)
  );
});

afterAll(async () => {
  await drainAttestations(3000).catch(() => undefined);
  await s.cerrar();
  await closeDatabase();
});

// ============================================================
// 1 · ¿ES CIRCULAR EL CENSO?
//
// La sospecha primera: un censo construido de la misma lista que dice
// vigilar no demuestra nada. Se comprueba de dos lados —que el censo
// SALE de la pila de Express, y que la app que la prueba censa es la que
// el servidor monta— y se nombra lo que el censo no alcanza.
// ============================================================

/** La app tal como la arma bootstrap(), sin JWT ni base. */
function montarApiReal(): express.Express {
  const app = express();
  for (const [sufijo, router] of MONTAJES_V1) app.use(`/v1${sufijo}`, router);
  app.use('/public/v1', publicVerificationRouter);
  app.use('/v1/ai/webhooks', aiWebhooksRouter);
  return app;
}

describe('1 · el censo sale de la pila de Express, no de una lista', () => {
  it('una ruta registrada AHORA aparece en el censo sin tocar ninguna lista', () => {
    // Si el censo se leyera de MONTAJES_V1 o de un mapa por ruta, esto no
    // saldría: nadie ha escrito esta ruta en ninguna parte.
    const app = montarApiReal();
    const nuevo = Router();
    nuevo.post(
      '/inventada-en-tiempo-de-prueba',
      declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'nada' }),
      (_req, res) => res.json({})
    );
    app.use('/v1/no-existe-en-ninguna-tabla', nuevo);

    const rutas = censarRutas(app).map((r) => `${r.metodo} ${r.ruta}`);
    expect(rutas).toContain('post /v1/no-existe-en-ninguna-tabla/inventada-en-tiempo-de-prueba');
  });

  it('una declaración que no está en la cadena no cuenta como declaración', () => {
    // El contrapeso del anterior: `declararRiesgoRuta` devuelve un manejador,
    // y un manejador que nadie registró no declara nada. Si bastara con
    // llamarla, el censo sería un contador de invocaciones.
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'una que nadie monta' });

    const app = express();
    const nuevo = Router();
    nuevo.post('/sin-declarar', (_req, res) => res.json({}));
    app.use('/v1/x', nuevo);

    expect(resumirCenso(app).sinDeclarar.map((r) => `${r.metodo} ${r.ruta}`)).toEqual([
      'post /v1/x/sin-declarar',
    ]);
  });

  it('src/index.ts no monta ningún router que la prueba del censo no cense', () => {
    // ESTE es el ataque a la circularidad de verdad. El censo del ARRANQUE
    // recorre la app entera, así que ve todo lo que bootstrap() monte. La
    // PRUEBA, en cambio, arma su propia app; si mañana index.ts monta un
    // router nuevo y nadie lo añade aquí, la prueba seguirá en verde y el
    // fallo saldrá en producción — que es el orden inverso al que se quiere.
    //
    // Así que se lee el archivo y se exige que todo identificador `…Router`
    // que index.ts monte esté en la tabla compartida o en la lista corta de
    // los que van fuera del prefijo autenticado.
    const fuente = readFileSync('src/index.ts', 'utf8');
    const montados = new Set(
      [...fuente.matchAll(/app\.use\(\s*(?:`[^`]*`|'[^']*')\s*,[^)]*?(\w+Router)/g)].map(
        (m) => m[1]
      )
    );
    // Los que la tabla monta, por el nombre con el que index.ts los importa.
    const enLaTabla = new Set(
      [...fuente.matchAll(/import\s+(\w+Router)\s+from\s+'\.\/api\/rest\/routes\//g)].map(
        (m) => m[1]
      )
    );
    const fueraDelPrefijo = new Set(['publicVerificationRouter', 'aiWebhooksRouter']);
    const huerfanos = [...montados].filter(
      (n) => !enLaTabla.has(n) && !fueraDelPrefijo.has(n)
    );
    expect(
      huerfanos,
      'src/index.ts monta un router que montarApiReal() no monta: el censo del arranque lo vería, la prueba no'
    ).toEqual([]);

    // Y que el bucle de montaje siga siendo el de la tabla compartida.
    expect(fuente).toMatch(/for\s*\(const \[sufijo, router\] of MONTAJES_V1\)/);
    expect(fuente).toMatch(/auditarRiesgoDeRutas\(app\)/);
  });

  it('lo que el censo NO alcanza: una puerta montada como middleware', () => {
    // Límite REAL y con nombre. `censarRutas` recorre `layer.route`, y un
    // `app.use(ruta, manejador)` no crea ninguna: crea una capa suelta que
    // atiende TODOS los verbos. GraphQL se monta exactamente así
    // (src/index.ts, `app.use('/graphql', …, expressMiddleware(...))`) y sus
    // mutaciones postean al mayor.
    //
    // Esta prueba no bendice el hueco: lo fija por escrito para que el día
    // que se cierre, falle aquí y se lea el porqué.
    const app = montarApiReal();
    app.use('/segunda-puerta', (_req, res) => res.json({ posteado: true }));

    expect(
      resumirCenso(app).sinDeclarar,
      'si esto deja de estar vacío es que el censo ya alcanza los montajes de middleware'
    ).toEqual([]);
    expect(censarRutas(app).map((r) => r.ruta)).not.toContain('/segunda-puerta');
  });
});

// ============================================================
// 2 · LA DECLARACIÓN QUE PASA EL CENSO Y NO HACE NADA.
//
// El módulo dice de sí mismo que la declaración «se pone el PRIMERO en la
// cadena de la ruta». El censo, en cambio, la BUSCA en toda la cadena
// (`route.stack.map(...).find(...)`), así que una declaración escrita
// después del manejador cuenta igual. Y no es lo mismo: la declaración es
// quien cuelga la llave de idempotencia. Puesta detrás, el manejador ya
// respondió cuando le toca correr.
// ============================================================

/** Una fila real, en una tabla real, para poder contar actos y no códigos. */
function routerDeMuestra(): Router {
  const r = Router();
  const grabar = asyncHandler(async (req: Request, res: Response) => {
    const id = uuidv4();
    await query(
      `INSERT INTO processing_rules (id, entity_id, rule_name, rule_type, conditions, actions)
       VALUES ($1, $2, $3, 'validation', '{}'::jsonb, '{}'::jsonb)`,
      [id, req.entityId, String((req.body as { marca?: string }).marca ?? 'sin-marca')]
    );
    res.status(201).json({ data: { id } });
  });

  // La declaración PRIMERO, como manda el módulo.
  r.post(
    '/bien',
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'processing_rules (prueba)' }),
    grabar
  );
  // La declaración AL FINAL. El censo la encuentra igual.
  r.post(
    '/mal',
    grabar,
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'processing_rules (prueba)' })
  );
  return r;
}

const contarReglas = async (marca: string): Promise<number> => {
  const r = await query<{ n: string }>(
    `SELECT count(*) AS n FROM processing_rules WHERE rule_name = $1`,
    [marca]
  );
  return Number(r.rows[0].n);
};

describe('2 · una declaración fuera de sitio declara y no protege', () => {
  it('con la declaración PRIMERO, la llave deduplica el acto', async () => {
    const marca = `bien-${randomUUID()}`;
    const llave = `K-${randomUUID()}`;
    const uno = await pedir(s, 'POST', '/v1/ataque/bien', { marca }, { 'Idempotency-Key': llave });
    const dos = await pedir(s, 'POST', '/v1/ataque/bien', { marca }, { 'Idempotency-Key': llave });

    expect(uno.status).toBe(201);
    expect(dos.repetida, 'la segunda salió del almacén').toBe(true);
    expect(await contarReglas(marca), 'una sola fila').toBe(1);
  });

  it('con la declaración AL FINAL, la misma llave ejecuta el acto DOS VECES', async () => {
    const marca = `mal-${randomUUID()}`;
    const llave = `K-${randomUUID()}`;
    await pedir(s, 'POST', '/v1/ataque/mal', { marca }, { 'Idempotency-Key': llave });
    await pedir(s, 'POST', '/v1/ataque/mal', { marca }, { 'Idempotency-Key': llave });

    // La medida es la BASE. La ruta declaró «irreversible» igual que la de
    // arriba y el censo la da por buena; lo que no hizo es correr.
    expect(
      await contarReglas(marca),
      'la declaración fuera de sitio no llegó a colgar la llave'
    ).toBe(2);
  });

  it('el censo tiene que RECHAZAR la declaración fuera de sitio', () => {
    // El arreglo de este tramo: que «declarada» signifique «declarada donde
    // la declaración actúa». Sin esto, el censo certifica una ruta que no
    // lleva llave, no deja renglón de auditoría y se lee como protegida.
    const app = express();
    app.use('/v1/ataque', routerDeMuestra());
    expect(() => auditarRiesgoDeRutas(app)).toThrow(/POST \/v1\/ataque\/mal/);
    expect(() => auditarRiesgoDeRutas(app)).toThrow(/primer manejador/i);
  });

  it('dos declaraciones en una misma ruta tampoco pasan', () => {
    // `.find()` se queda con la primera. Declarar «lectura» y luego
    // «irreversible» sobre la misma ruta dejaba el censo diciendo lectura.
    const app = express();
    const r = Router();
    r.post(
      '/dos-caras',
      declararRiesgoRuta({ riesgo: 'lectura' }),
      declararRiesgoRuta({ riesgo: 'irreversible' }),
      (_req, res) => res.json({})
    );
    app.use('/v1/x', r);
    expect(() => auditarRiesgoDeRutas(app)).toThrow(/dos-caras/);
  });

  it('la API real sigue pasando el censo endurecido', () => {
    expect(() => auditarRiesgoDeRutas(montarApiReal())).not.toThrow();
  });
});

// ============================================================
// 3 · EL MISMO ACTO, DOS DECLARACIONES.
//
// Una declaración más floja en REST que en el CLI para el MISMO acto es
// el defecto entero de este frente escrito en una línea. Y no es
// cosmética: `escritura` es la ÚNICA clase que puede abrirse al agente
// (con soloBorrador), mientras que `irreversible` no puede abrirse nunca.
// Clasificar de menos un acto que postea al mayor lo deja a un booleano
// de ser invocable por el agente.
// ============================================================

describe('3 · la superficie REST contra la del binario', () => {
  const clases = new Map(
    censarRutas(montarApiReal()).map((r) => [`${r.metodo} ${r.ruta}`, r.riesgo?.riesgo])
  );

  // Pares acto-por-acto: hoja del binario (con su clase declarada) contra la
  // ruta que hace lo mismo. La columna de la izquierda sale de
  // src/cli/**/*.ts; la de la derecha, del censo.
  it.each([
    ['mnemosine entry post',        'irreversible', 'post /v1/journal-entries/:id/post'],
    ['mnemosine entry reverse',     'irreversible', 'post /v1/journal-entries/:id/reverse'],
    ['mnemosine entry void',        'irreversible', 'post /v1/journal-entries/:id/void'],
    ['mnemosine bill approve',      'irreversible', 'post /v1/bills/:id/approve'],
    ['mnemosine payment create',    'irreversible', 'post /v1/bills/payments'],
    ['mnemosine receipt record',    'irreversible', 'post /v1/invoices/:id/payments'],
    ['mnemosine close',             'irreversible', 'post /v1/fiscal-periods/:id/hard-close'],
    ['mnemosine close',             'irreversible', 'post /v1/fiscal-periods/:id/soft-close'],
    ['mnemosine bank recon approve','irreversible', 'post /v1/bank-accounts/reconciliations/:id/complete'],
    ['mnemosine review approve',    'irreversible', 'post /v1/ai/drafts/:id/approve'],
    ['mnemosine invoice issue',     'irreversible', 'post /v1/invoices/:id/send'],
    // EL PAR QUE FALLABA. `mnemosine ingest` declara irreversible con
    // «xml_documents, pre_registrations, bills; y con auto-posteo, asientos
    // POSTEADOS» (src/cli/mnemosine.ts). La ruta gemela declaraba
    // `escritura` y decía escribir «xml_documents + pre_registrations»,
    // callando las dos mitades que no se deshacen: processXMLUpload entra
    // en processToAccounting cuando la regla del inquilino puso el
    // pre-registro en modo automático, y processToAccounting llama a
    // createJournalEntry con autoPost: true.
    ['mnemosine ingest',            'irreversible', 'post /v1/xml/upload'],
    ['mnemosine ingest',            'irreversible', 'post /v1/upload'],
    // Externo: hablar con un tercero.
    ['mnemosine sat add',           'externo',      'put /v1/admin/integrations/:provider'],
    ['mnemosine outbox run',        'externo',      'post /v1/webhooks/deliveries/:id/retry'],
  ])('%s (%s) ↔ %s', (_hoja, claseCli, ruta) => {
    expect(clases.get(ruta), `la ruta ${ruta} no está en el censo`).toBeDefined();
    expect(clases.get(ruta)).toBe(claseCli);
  });

  it('ninguna ruta que postea al mayor queda en una clase abrible al agente', () => {
    // `irreversible` y `externo` no se pueden abrir al agente: lo prohíbe
    // declararRiesgoRuta. `escritura` sí, con soloBorrador. Así que la lista
    // de rutas `escritura` es la lista de lo que un tramo futuro podría
    // conceder — y ahí no puede haber nada que postee.
    const abribles = censarRutas(montarApiReal())
      .filter((r) => VERBOS_QUE_MUTAN.includes(r.metodo) && r.riesgo?.riesgo === 'escritura')
      .map((r) => `${r.metodo} ${r.ruta}`);
    expect(abribles).not.toContain('post /v1/xml/upload');
    expect(abribles).not.toContain('post /v1/upload');
  });
});

// ============================================================
// 4 · LA LLAVE SOBRE UN PAGO DE VERDAD.
// ============================================================

async function proveedorConFactura(
  destino: Fixture
): Promise<{ vendorId: string; billId: string; total: string }> {
  const marca = uuidv4().slice(0, 8);
  const vendorId = uuidv4();
  const billId = uuidv4();
  const fecha = fechaEnPeriodo();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor G4a','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, destino.entityId, `V-${marca}`, destino.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,1000.00,160.00,1160.00,1160.00,0,'MXN',$6,$6,'draft',$7,'PUE')`,
    [billId, destino.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`, fecha, destino.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,1000.00,1000.00,160.00,1160.00)`,
    [uuidv4(), billId, destino.roles.gasto]
  );
  await approveBill(billId, destino.userId, { entityId: destino.entityId });
  return { vendorId, billId, total: '1160.00' };
}

const contarPagos = async (vendorId: string): Promise<number> => {
  const r = await query<{ n: string }>(
    `SELECT count(*) AS n FROM vendor_payments WHERE vendor_id = $1`,
    [vendorId]
  );
  return Number(r.rows[0].n);
};

describe('4 · un pago con la misma llave es UN pago', () => {
  it('el reintento no crea un segundo pago, y sin llave sí lo crea', async () => {
    const { vendorId, billId } = await proveedorConFactura(f);
    const cuerpo = {
      entity_id: f.entityId,
      vendor_id: vendorId,
      payment_amount: '500.00',
      payment_method: 'spei',
      payment_date: fechaEnPeriodo().toISOString().slice(0, 10),
      applications: [{ bill_id: billId, amount_applied: '500.00' }],
    };
    const llave = `PAGO-${randomUUID()}`;

    const uno = await pedir(s, 'POST', '/v1/bills/payments', cuerpo, {
      'Idempotency-Key': llave,
    });
    expect(uno.status, JSON.stringify(uno.body)).toBe(201);
    const dos = await pedir(s, 'POST', '/v1/bills/payments', cuerpo, {
      'Idempotency-Key': llave,
    });

    expect(await contarPagos(vendorId), 'el reintento pagó dos veces').toBe(1);
    expect(dos.repetida).toBe(true);
    expect((dos.body.data as { payment_number: string }).payment_number).toBe(
      (uno.body.data as { payment_number: string }).payment_number
    );

    // El contrapeso: sin cabecera, dos pagos idénticos son dos pagos. Es una
    // decisión, no un descuido — la cabecera es opcional a propósito.
    await pedir(s, 'POST', '/v1/bills/payments', cuerpo);
    expect(await contarPagos(vendorId)).toBe(2);
  });

  it('la misma llave con OTRO importe es 409 y no paga', async () => {
    const { vendorId, billId } = await proveedorConFactura(f);
    const llave = `PAGO-${randomUUID()}`;
    const base = {
      entity_id: f.entityId,
      vendor_id: vendorId,
      payment_method: 'spei',
      payment_date: fechaEnPeriodo().toISOString().slice(0, 10),
    };
    const primero = await pedir(
      s,
      'POST',
      '/v1/bills/payments',
      { ...base, payment_amount: '100.00', applications: [{ bill_id: billId, amount_applied: '100.00' }] },
      { 'Idempotency-Key': llave }
    );
    expect(primero.status, JSON.stringify(primero.body)).toBe(201);

    const otra = await pedir(
      s,
      'POST',
      '/v1/bills/payments',
      { ...base, payment_amount: '200.00', applications: [{ bill_id: billId, amount_applied: '200.00' }] },
      { 'Idempotency-Key': llave }
    );

    expect(otra.status, 'reusar la llave con otra carga es conflicto').toBe(409);
    expect(await contarPagos(vendorId), 'el conflicto no pagó').toBe(1);
  });
});

// ============================================================
// 5 · FRONTERA DE ENTIDAD (serie TEN) EN LO QUE ESTE TRAMO TOCÓ.
//
// Las seis rutas `/pre-registrations/:id` se acotaron en TEN-2 con
// `requireByIdInScope`. Las de `processing-rules` y `processing-batches`
// se quedaron fuera, y este tramo les colgó una declaración —una de
// ellas, `irreversible`— sin cerrarles la frontera. RLS no ayuda: su
// predicado es el INQUILINO, y estas dos entidades comparten inquilino.
// ============================================================

async function reglaDe(destino: Fixture): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO processing_rules (id, entity_id, rule_name, rule_type, conditions, actions)
     VALUES ($1, $2, 'regla de la hermana', 'validation', '{}'::jsonb, '{}'::jsonb)`,
    [id, destino.entityId]
  );
  return id;
}

describe('5 · la frontera de entidad en processing-rules y processing-batches', () => {
  it('no se edita la regla de la entidad hermana', async () => {
    const ajena = await reglaDe(hermana);
    const r = await pedir(s, 'PUT', `/v1/processing-rules/${ajena}`, { rule_name: 'secuestrada' });
    expect(r.status, 'la sesión es de la entidad principal, la regla es de la hermana').toBe(404);

    const fila = await query<{ rule_name: string }>(
      `SELECT rule_name FROM processing_rules WHERE id = $1`,
      [ajena]
    );
    expect(fila.rows[0].rule_name).toBe('regla de la hermana');
  });

  it('no se borra la regla de la entidad hermana', async () => {
    const ajena = await reglaDe(hermana);
    const r = await pedir(s, 'DELETE', `/v1/processing-rules/${ajena}`);
    expect(r.status).toBe(404);
    const fila = await query(`SELECT id FROM processing_rules WHERE id = $1`, [ajena]);
    expect(fila.rows, 'la regla ajena sigue viva').toHaveLength(1);
  });

  it('la regla PROPIA sí se edita y sí se borra', async () => {
    // El contrapeso obligatorio: un 404 incondicional pasaría las dos de
    // arriba y habría roto el endpoint en vez de acotarlo.
    const propia = await reglaDe(f);
    const editada = await pedir(s, 'PUT', `/v1/processing-rules/${propia}`, {
      rule_name: 'editada',
    });
    expect(editada.status, JSON.stringify(editada.body)).toBe(200);
    expect((editada.body.data as { rule_name: string }).rule_name).toBe('editada');

    const borrada = await pedir(s, 'DELETE', `/v1/processing-rules/${propia}`);
    expect(borrada.status).toBe(204);
    expect(
      (await query(`SELECT id FROM processing_rules WHERE id = $1`, [propia])).rows
    ).toHaveLength(0);
  });

  it('no se cancela ni se ejecuta el lote de la entidad hermana', async () => {
    const loteId = uuidv4();
    await query(
      `INSERT INTO processing_batches (id, entity_id, batch_number, batch_name, status)
       VALUES ($1, $2, $3, 'lote de la hermana', 'scheduled')`,
      [loteId, hermana.entityId, `H-${loteId.slice(0, 8)}`]
    );

    // `execute` es IRREVERSIBLE: procesa los pre-registros del lote y, con
    // auto-posteo, deja asientos POSTEADOS en el mayor de la otra entidad.
    const ejecutar = await pedir(s, 'POST', `/v1/processing-batches/${loteId}/execute`);
    expect(ejecutar.status, 'ejecutar el lote ajeno postea en sus libros').toBe(404);

    const cancelar = await pedir(s, 'POST', `/v1/processing-batches/${loteId}/cancel`);
    expect(cancelar.status).toBe(404);

    const fila = await query<{ status: string; started_at: Date | null }>(
      `SELECT status, started_at FROM processing_batches WHERE id = $1`,
      [loteId]
    );
    expect(fila.rows[0].status, 'el lote ajeno no se movió').toBe('scheduled');
    expect(fila.rows[0].started_at).toBeNull();
  });

  it('el lote PROPIO sigue ejecutándose y cancelándose', async () => {
    const propio = uuidv4();
    await query(
      `INSERT INTO processing_batches (id, entity_id, batch_number, batch_name, status)
       VALUES ($1, $2, $3, 'lote propio', 'scheduled')`,
      [propio, f.entityId, `P-${propio.slice(0, 8)}`]
    );
    const ejecutar = await pedir(s, 'POST', `/v1/processing-batches/${propio}/execute`);
    expect(ejecutar.status, JSON.stringify(ejecutar.body)).toBe(200);

    const otro = uuidv4();
    await query(
      `INSERT INTO processing_batches (id, entity_id, batch_number, batch_name, status)
       VALUES ($1, $2, $3, 'lote propio 2', 'scheduled')`,
      [otro, f.entityId, `P2-${otro.slice(0, 8)}`]
    );
    const cancelar = await pedir(s, 'POST', `/v1/processing-batches/${otro}/cancel`);
    expect(cancelar.status).toBe(200);
  });
});

// ============================================================
// 6 · EL LOTE EN EL BORDE, Y EL UPDATE QUE NO ENCUENTRA NADA.
// ============================================================

describe('6 · el tope de lote y el éxito sobre cero filas', () => {
  it('bulk por encima del tope se rechaza DICIENDO el número', async () => {
    const ids = Array.from({ length: 101 }, () => uuidv4());
    const r = await pedir(s, 'POST', '/v1/pre-registrations/bulk', { action: 'approve', ids });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body), 'el rechazo tiene que nombrar el tope').toMatch(/100/);
  });

  it('bulk justo EN el tope se acepta: el tope no está por debajo de lo que promete', async () => {
    const ids = Array.from({ length: 100 }, () => uuidv4());
    const r = await pedir(s, 'POST', '/v1/pre-registrations/bulk', { action: 'approve', ids });
    // 200 con cien renglones en error, no 422: el tope no es el que rechaza.
    expect(r.status).toBe(200);
    const filas = (r.body.data as { results: Array<{ status: string }> }).results;
    expect(filas).toHaveLength(100);
    expect(filas.every((x) => x.status === 'error'), 'ningún id existe').toBe(true);
  });

  it('un UPDATE sobre un id inexistente no puede contestar 2xx', async () => {
    const inexistente = uuidv4();
    for (const [metodo, ruta] of [
      ['PUT', `/v1/processing-rules/${inexistente}`],
      ['DELETE', `/v1/processing-rules/${inexistente}`],
      ['POST', `/v1/processing-batches/${inexistente}/cancel`],
      ['POST', `/v1/processing-batches/${inexistente}/execute`],
      ['POST', `/v1/pre-registrations/${inexistente}/reject`],
    ] as const) {
      const cuerpo =
        metodo === 'PUT'
          ? { rule_name: 'x' }
          : ruta.endsWith('/reject')
            ? { reason: 'x' }
            : undefined;
      const r = await pedir(s, metodo, ruta, cuerpo);
      expect(r.status, `${metodo} ${ruta} contestó ${r.status}`).toBeGreaterThanOrEqual(400);
    }
  });
});
