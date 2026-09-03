import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTenant, currentTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import webhooksRouter from '../../src/api/rest/routes/webhooks.js';
import { montarSuperficieCensable } from '../../src/api/rest/montajes.js';
import { censarRutas, declararRiesgoRuta } from '../../src/api/rest/risk.js';
import { construirOpenAPI, caminoOpenAPI } from '../../src/api/rest/openapi.js';
import { createWebhook, WEBHOOK_EVENTS } from '../../src/services/webhooks/webhook-service.js';
import { barrerEntregasVencidas } from '../../src/services/webhooks/barrido-entregas.js';
import { politicaDe, MUERTA_PREFIJO } from '../../src/services/webhooks/politica-reintento.js';
import { config } from '../../src/config/index.js';
import type { WebhookDelivery, WebhookSubscription } from '../../src/types/index.js';

/**
 * G4b · EL ATAQUE.
 *
 * Dos entregas que verificar y una pregunta común: ¿el instrumento mide, o
 * se mide a sí mismo?
 *
 *   · LA ESPECIFICACIÓN. Se genera del censo de la pila real. La prueba que
 *     la acompaña la genera OTRA VEZ del mismo censo y compara: eso no puede
 *     fallar nunca (§1). Lo que sí puede fallar —y es lo único que puede— es
 *     la copia en disco, y aquí se ancla dentro de la suite y no sólo en CI.
 *
 *   · EL BARRIDO. Se prueba contra Postgres de verdad, y por eso lo que se
 *     ataca no es el camino feliz sino el borde: el tope de intentos contado
 *     una a una, el solape con la petición EN VUELO (que es el único momento
 *     en que el arriendo hace algo), y la entrega que ningún barrido verá.
 *
 * Lo que este archivo encontró está en su sitio, cada hallazgo con su
 * comentario delante.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

// ============================================================
// § 1. LA ESPECIFICACIÓN CONTRA SÍ MISMA
// ============================================================

function superficie(): express.Express {
  return montarSuperficieCensable(express());
}

/** El documento tal como lo escribe scripts/openapi.ts, byte por byte. */
function documentoGenerado(app: express.Express): string {
  const paquete = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return `${JSON.stringify(construirOpenAPI(app, { version: paquete.version }), null, 2)}\n`;
}

describe('§1 la especificación: de dónde sale y qué puede fallar', () => {
  it('LA COBERTURA ES CIRCULAR: la prueba y el documento salen del MISMO censo', () => {
    // El ataque pedido era «añade una ruta al router y comprueba que la
    // especificación la ECHA EN FALTA». No la echa en falta y no puede: el
    // documento se construye recorriendo la misma pila que el censo recorre,
    // en el mismo proceso, así que la ruta nueva aparece en los dos lados a
    // la vez. La aserción «cada ruta del censo tiene su operación» de
    // openapi-contrato.spec.ts es verdadera por construcción.
    //
    // Esto NO es un defecto del diseño —derivar es justamente lo que impide
    // que el documento mienta—, pero sí lo es creer que esa prueba vigila
    // algo. Lo que vigila de verdad está en el caso siguiente.
    const app = superficie();
    const extra = Router();
    extra.post(
      '/aprobar-todo',
      declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'todo' }),
      (_req, res) => res.json({ ok: true })
    );
    app.use('/v1/ataque-g4b', extra);

    const censo = censarRutas(app);
    const doc = construirOpenAPI(app) as { paths: Record<string, Record<string, unknown>> };

    const faltan = censo.filter((r) => doc.paths[caminoOpenAPI(r.ruta)]?.[r.metodo] === undefined);
    expect(faltan, 'una ruta recién inventada YA está en la especificación').toEqual([]);
    expect(doc.paths['/v1/ataque-g4b/aprobar-todo']?.post).toBeDefined();
  });

  it('EL ANCLA NO CIRCULAR es docs/openapi.json, y hoy dice la verdad', () => {
    // Ésta es la única comparación del frente que enfrenta el documento con
    // algo que NO se acaba de derivar de la misma pila: el archivo en disco,
    // escrito en otro momento. `scripts/openapi.ts --check` la hace en CI;
    // aquí se hace también en la suite, porque un ancla que sólo existe en
    // el flujo de integración continua no protege a quien corre las pruebas
    // antes de empujar.
    const enDisco = fs.readFileSync(path.join(RAIZ, 'docs', 'openapi.json'), 'utf8');
    expect(
      documentoGenerado(superficie()),
      'docs/openapi.json quedó desfasado: regenéralo con `npm run openapi`'
    ).toBe(enDisco);
  });

  it('una ruta nueva SÍ se echa en falta: contra el disco, no contra el censo', () => {
    // El mismo experimento del primer caso, medido contra el ancla que
    // vale: la ruta nueva deja el archivo publicado desfasado, y eso es lo
    // que rompe. Un documento escrito a mano habría seguido igual de verde.
    const app = superficie();
    const extra = Router();
    extra.post(
      '/entregar-todo',
      declararRiesgoRuta({ riesgo: 'externo', escribe: 'todo' }),
      (_req, res) => res.json({ ok: true })
    );
    app.use('/v1/ataque-g4b', extra);

    const enDisco = fs.readFileSync(path.join(RAIZ, 'docs', 'openapi.json'), 'utf8');
    expect(documentoGenerado(app)).not.toBe(enDisco);
    expect(documentoGenerado(app)).toContain('/v1/ataque-g4b/entregar-todo');
    expect(enDisco).not.toContain('/v1/ataque-g4b/entregar-todo');
  });
});

// ============================================================
// § 2 y § 3. LO QUE LA ESPECIFICACIÓN AFIRMA, CONTRA LO QUE LA RUTA HACE
// ============================================================

type Operacion = Record<string, unknown>;

let publicado: { paths: Record<string, Record<string, Operacion>> };

function operacion(metodo: string, camino: string): Operacion {
  const op = publicado.paths[camino]?.[metodo];
  expect(op, `la especificación no publica ${metodo.toUpperCase()} ${camino}`).toBeDefined();
  return op;
}

function esquemaDe(op: Operacion): Record<string, unknown> {
  const cuerpo = op.requestBody as {
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  return cuerpo.content['application/json'].schema;
}

let f: Fixture;
let servidor: Servidor;

beforeAll(async () => {
  publicado = JSON.parse(
    fs.readFileSync(path.join(RAIZ, 'docs', 'openapi.json'), 'utf8')
  ) as typeof publicado;
  f = await crearInquilino('Ataque G4b');
  servidor = await levantar([['/v1/webhooks', webhooksRouter]], sesionDe(f));
});

afterAll(async () => {
  await servidor.cerrar();
  await closeDatabase();
});

describe('§2 el riesgo y la idempotencia que la especificación afirma', () => {
  it('las tres rutas que no se deshacen publican las cuatro marcas de su clase', () => {
    // Tres rutas irreversibles/externas, de tres archivos distintos, contra
    // lo que la especificación afirma de ellas. No se comparan con el censo
    // —eso sería otra vez la circularidad de §1— sino con la tabla de
    // verdad de risk.ts: irreversible y externo exigen marcha seca y llave;
    // sólo externo exige compuerta en vivo; ninguna es del agente.
    const casos: Array<[string, string, string, boolean]> = [
      ['delete', '/v1/webhooks/{id}', 'irreversible', false],
      ['post', '/v1/webhooks/{id}/test', 'externo', true],
      ['post', '/v1/journal-entries/{id}/post', 'irreversible', false],
    ];
    for (const [metodo, camino, clase, enVivo] of casos) {
      const op = operacion(metodo, camino);
      expect(op['x-riesgo'], camino).toBe(clase);
      expect(op['x-agente-permitido'], camino).toBe(false);
      expect(op['x-exige-marcha-seca'], camino).toBe(true);
      expect(op['x-exige-llave-de-idempotencia'], camino).toBe(true);
      expect(op['x-exige-compuerta-en-vivo'], camino).toBe(enVivo);
      // Y el 409 que la llave produce está publicado como respuesta: sin
      // él, un cliente generado no sabría que reusar la llave es un caso.
      expect((op.responses as Record<string, unknown>)['409'], camino).toEqual({
        $ref: '#/components/responses/LlaveReusada',
      });
    }
  });

  it('el alcance publicado es el que Postgres guarda, no una cadena parecida', async () => {
    // LA PRUEBA QUE NO ES CIRCULAR. `x-alcance-idempotencia` se arma en el
    // censo (`prefijo + ruta`) y el alcance real lo arma la petición
    // (`req.baseUrl + req.route.path`). Son dos cálculos distintos en dos
    // momentos distintos, y hasta aquí nadie los había enfrentado: se
    // comparan contra la columna `idempotency_keys.scope` que quedó escrita
    // después de un DELETE de verdad.
    const op = operacion('delete', '/v1/webhooks/{id}');
    const alcancePublicado = op['x-alcance-idempotencia'] as string;
    expect(alcancePublicado).toBe('DELETE /v1/webhooks/:id');

    const wh = await withTenant(f.tenantId, () =>
      createWebhook(f.tenantId, 'https://ataque-alcance.invalid/hook', ['invoice.paid'])
    );
    const llave = `g4b-${uuidv4()}`;

    const primera = await pedir(servidor, 'DELETE', `/v1/webhooks/${wh.id}`, undefined, {
      'idempotency-key': llave,
    });
    expect(primera.status).toBe(204);

    const { rows } = await query<{ scope: string }>(
      'SELECT scope FROM idempotency_keys WHERE tenant_id = $1 AND clave = $2',
      [f.tenantId, llave]
    );
    expect(rows, 'la llave se grabó').toHaveLength(1);
    expect(
      rows[0].scope,
      'el alcance publicado y el que se guarda tienen que ser la MISMA cadena'
    ).toBe(alcancePublicado);
  });

  it('reusar la llave con otra carga da el 409 que la especificación promete', async () => {
    const wh1 = await withTenant(f.tenantId, () =>
      createWebhook(f.tenantId, 'https://ataque-409-a.invalid/hook', ['invoice.paid'])
    );
    const wh2 = await withTenant(f.tenantId, () =>
      createWebhook(f.tenantId, 'https://ataque-409-b.invalid/hook', ['invoice.paid'])
    );
    const llave = `g4b-${uuidv4()}`;

    expect(
      (await pedir(servidor, 'DELETE', `/v1/webhooks/${wh1.id}`, undefined, { 'idempotency-key': llave }))
        .status
    ).toBe(204);

    // Misma llave, otro `:id`: el hash de la carga lleva los params, así que
    // esto es reuso y no acierto. Devolver el 204 grabado habría borrado un
    // webhook y contestado por el otro.
    const conflicto = await pedir(servidor, 'DELETE', `/v1/webhooks/${wh2.id}`, undefined, {
      'idempotency-key': llave,
    });
    expect(conflicto.status).toBe(409);
    const { rows } = await query('SELECT id FROM webhook_subscriptions WHERE id = $1', [wh2.id]);
    expect(rows, 'el segundo webhook NO se borró').toHaveLength(1);

    // Y el reintento idéntico devuelve lo grabado sin volver a ejecutar.
    const repetida = await pedir(servidor, 'DELETE', `/v1/webhooks/${wh1.id}`, undefined, {
      'idempotency-key': llave,
    });
    expect(repetida.status).toBe(204);
    expect(repetida.repetida, 'la respuesta salió del almacén, no del manejador').toBe(true);
  });

  /**
   * HALLAZGO — `x-escribe` de POST /v1/webhooks/:id/test dice
   * «nada en la base; ENTREGA a la URL del suscriptor», y la ruta NO
   * ENTREGA NADA A NADIE.
   *
   * El manejador (src/api/rest/routes/webhooks.ts:59) ignora `:id` por
   * completo y llama a `dispatchEvent(tenant, 'test.ping', …)`, que
   * selecciona suscripciones con `'test.ping' = ANY(events)`. `test.ping`
   * NO está en WEBHOOK_EVENTS, y la ruta de alta rechaza cualquier evento
   * que no esté en esa lista: ninguna suscripción puede llevarlo. Así que
   * la consulta devuelve cero filas siempre, no se inserta ninguna entrega,
   * no sale ninguna petición, y la respuesta es `{"sent": true}`.
   *
   * Se fija aquí la conducta REAL —no se aprueba— para que el día que
   * alguien arregle la ruta esta prueba lo diga en vez de dejar el
   * contrato mintiendo en la otra dirección. Cómo debe comportarse
   * («entregar a la suscripción nombrada saltándose el filtro de eventos»
   * o «retirar la ruta») es una decisión de diseño de la familia de
   * salida, no de este verificador: queda nombrada en el informe.
   */
  it('la ruta de prueba contesta «sent: true» y no manda NADA (defecto fijado)', async () => {
    const wh = await withTenant(f.tenantId, () =>
      createWebhook(f.tenantId, 'https://ataque-test.invalid/hook', ['invoice.paid'])
    );
    const antes = await contarEntregas(wh.id);

    const r = await pedir(servidor, 'POST', `/v1/webhooks/${wh.id}/test`);
    expect(r.status).toBe(200);
    expect((r.body.data as { sent: boolean }).sent).toBe(true);
    expect(await contarEntregas(wh.id), 'cero entregas creadas').toBe(antes);

    // Y ni siquiera comprueba que el webhook exista: un UUID inventado
    // recibe el mismo «sent: true».
    const fantasma = await pedir(servidor, 'POST', `/v1/webhooks/${uuidv4()}/test`);
    expect(fantasma.status).toBe(200);

    expect(
      WEBHOOK_EVENTS as readonly string[],
      'la causa: el evento que despacha no puede estar suscrito por nadie'
    ).not.toContain('test.ping');
  });
});

async function contarEntregas(webhookId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM webhook_deliveries WHERE webhook_id = $1',
    [webhookId]
  );
  return Number(rows[0].n);
}

describe('§3 el cuerpo que la especificación declara, contra el que la ruta admite', () => {
  const CAMINO = '/v1/webhooks';

  it('lo que el esquema publicado declara VÁLIDO, la ruta lo acepta', async () => {
    const esquema = esquemaDe(operacion('post', CAMINO));
    // El cuerpo se construye LEYENDO el documento publicado, no la ruta:
    // required dice qué mandar, `format: uri` cómo es la url, `minItems`
    // cuántos eventos. Es lo que haría quien integra con el contrato en la
    // mano y sin acceso al código.
    expect(esquema.required).toEqual(['url', 'events']);
    const propiedades = esquema.properties as Record<string, Record<string, unknown>>;
    expect(propiedades.url).toMatchObject({ type: 'string', format: 'uri' });
    expect(propiedades.events).toMatchObject({ type: 'array', minItems: 1 });

    const r = await pedir(servidor, 'POST', CAMINO, {
      url: 'https://integrador.invalid/hook',
      events: ['invoice.paid'],
    });
    expect(r.status).toBe(201);
  });

  it('lo que el esquema publicado declara INVÁLIDO, la ruta lo rechaza con 422', async () => {
    // Falta un `required`.
    expect((await pedir(servidor, 'POST', CAMINO, { url: 'https://x.invalid/h' })).status).toBe(422);
    // `format: uri` incumplido.
    expect(
      (await pedir(servidor, 'POST', CAMINO, { url: 'no-es-una-url', events: ['invoice.paid'] })).status
    ).toBe(422);
    // `minItems: 1` incumplido.
    expect(
      (await pedir(servidor, 'POST', CAMINO, { url: 'https://x.invalid/h', events: [] })).status
    ).toBe(422);
    // Y el 422 está publicado como la respuesta de un cuerpo inválido: el
    // contrato no promete un 400 que la API nunca manda.
    expect((operacion('post', CAMINO).responses as Record<string, unknown>)['422']).toEqual({
      $ref: '#/components/responses/CuerpoInvalido',
    });
  });

  it('`x-claves-desconocidas: descartadas` es cierto: valida, y la clave se cae', async () => {
    const esquema = esquemaDe(operacion('post', CAMINO));
    expect(esquema.additionalProperties).toBe(true);
    expect(esquema['x-claves-desconocidas']).toBe('descartadas');

    // La extensión existe porque JSON Schema no sabe decir la diferencia
    // entre «te lo guardo» y «te lo tiro», y aquí se comprueba la segunda
    // mitad: la petición pasa (201) y el campo de más no llegó a la fila.
    const r = await pedir(servidor, 'POST', CAMINO, {
      url: 'https://descartadas.invalid/hook',
      events: ['invoice.paid'],
      retry_config: { max_retries: 999 },
      is_active: false,
    });
    expect(r.status).toBe(201);
    const creado = (r.body.data as WebhookSubscription & { retry_config: { max_retries: number } });
    expect(creado.is_active, 'la clave de más no gobernó nada').toBe(true);
    expect(creado.retry_config.max_retries).not.toBe(999);
  });

  /**
   * HALLAZGO — un cuerpo que la especificación declara VÁLIDO puede ser
   * rechazado por el manejador, y el documento no lo advertía.
   *
   * `x-validacion-adicional` sólo se emite para los refinamientos de Zod
   * que el censo VE colgados del manejador de `validateBody`. La validación
   * escrita DENTRO del cuerpo del manejador es invisible para el censo, y
   * hay 40 `throw new ValidationError` repartidos en 8 archivos de rutas.
   * `POST /v1/webhooks` era el ejemplo exacto: publicaba
   * `events: { items: { type: string } }` y rechazaba con 422 cualquier
   * evento fuera de WEBHOOK_EVENTS.
   *
   * Arreglado moviendo la regla al esquema —que es donde el censo la ve—,
   * de modo que ahora la lista viaja en el contrato. Lo GENERAL queda
   * dicho en `info.description`: validar contra `requestBody` no garantiza
   * que la petición se acepte.
   */
  it('la lista de eventos viaja en el contrato, y no sólo dentro del manejador', async () => {
    const esquema = esquemaDe(operacion('post', CAMINO));
    const eventos = (esquema.properties as Record<string, Record<string, unknown>>).events;
    const items = eventos.items as Record<string, unknown>;
    expect(items.enum, 'el contrato publica los eventos admitidos').toEqual([...WEBHOOK_EVENTS]);

    // Y el cuerpo que el contrato ahora declara inválido, la ruta lo rechaza.
    const r = await pedir(servidor, 'POST', CAMINO, {
      url: 'https://evento-raro.invalid/hook',
      events: ['no.existe'],
    });
    expect(r.status).toBe(422);
  });

  it('el documento advierte que el manejador puede rechazar lo que el esquema admite', () => {
    const doc = construirOpenAPI(superficie()) as { info: { description: string } };
    expect(doc.info.description).toMatch(/handler/i);
    expect(doc.info.description).toMatch(/requestBody/);
  });

  /**
   * HALLAZGO — la otra mitad: 17 rutas que mutan LEEN `req.body` sin
   * `validateBody`, así que el contrato no publica `requestBody` para
   * ellas. Y la ausencia de `requestBody` no se lee como «no lo sé»: se
   * lee como «esta operación no lleva cuerpo».
   *
   * El caso más caro es `POST /v1/invoices/:id/cfdi/cancel` —declarada
   * `externo`, «cancela el CFDI ante el PAC y el SAT»—: exige
   * `cancellation_reason` en el cuerpo (routes/invoices.ts:305) y no
   * publica nada. Un cliente generado de este documento no puede cancelar
   * un CFDI: manda la petición sin cuerpo y se lleva un 422.
   *
   * No se arregla aquí —son 17 rutas y trece están en payroll.ts, que
   * pertenece a otro frente en curso— pero deja de ser un silencio: el
   * documento lo dice con su número, y esta prueba fija la pareja
   * (no publica / sí exige) para que arreglar una de las dos mitades
   * obligue a mirar la otra.
   */
  it('lo que no publica cuerpo y sin embargo lo exige queda DICHO (defecto fijado)', () => {
    const cancelar = operacion('post', '/v1/invoices/{id}/cfdi/cancel');
    expect(cancelar['x-riesgo']).toBe('externo');
    expect(cancelar.requestBody, 'no publica cuerpo…').toBeUndefined();

    const rutas = fs.readFileSync(
      path.join(RAIZ, 'src', 'api', 'rest', 'routes', 'invoices.ts'),
      'utf8'
    );
    expect(rutas, '…y sin embargo lo exige').toContain(
      "throw new ValidationError('cancellation_reason is required')"
    );

    const doc = construirOpenAPI(superficie()) as { info: { description: string } };
    expect(doc.info.description).toMatch(/no `requestBody` means/i);
    expect(doc.info.description).toContain('cancellation_reason');
  });
});

// ============================================================
// § 4. EL BARRIDO
// ============================================================

interface Llamada {
  url: string;
  webhookId: string;
  cuerpo: string;
}

let llamadas: Llamada[] = [];
let responder: (url: string) => Promise<{ ok: boolean; status: number }>;
const fetchReal = globalThis.fetch;

/**
 * El receptor simulado. Sólo intercepta los hosts `.invalid` —los que usan
 * las suscripciones de este archivo—; todo lo demás, incluidas las
 * peticiones que §2 y §3 hacen al servidor de pruebas, sigue por el `fetch`
 * real. Un doble que se traga TODO el tráfico del proceso es un doble que
 * rompe la prueba de al lado.
 */
function instalarReceptor(): void {
  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    // Sólo el servidor de pruebas de §2/§3 sigue por el `fetch` real; nada
    // más sale de este proceso, ni siquiera si otra prueba dejó una
    // suscripción con una URL de verdad y una entrega vencida.
    if (url.startsWith('http://127.0.0.1')) return fetchReal(entrada as string, init);
    const h = new Headers(init?.headers);
    llamadas.push({
      url,
      webhookId: h.get('X-Webhook-ID') ?? '',
      cuerpo: typeof init?.body === 'string' ? init.body : '',
    });
    const r = await responder(url);
    return new Response(r.ok ? 'ok' : 'boom', { status: r.status });
  }) as typeof globalThis.fetch;
}

async function suscripcion(
  fx: Fixture,
  url: string,
  retry?: Record<string, number>
): Promise<string> {
  const wh = await withTenant(fx.tenantId, () => createWebhook(fx.tenantId, url, ['invoice.paid']));
  if (retry) {
    await query('UPDATE webhook_subscriptions SET retry_config = $2::jsonb WHERE id = $1', [
      wh.id,
      JSON.stringify(retry),
    ]);
  }
  return wh.id;
}

async function entregaVencida(
  webhookId: string,
  intentos = 0,
  vencida = true
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, next_retry_at)
     VALUES ($1, $2, 'invoice.paid', $3::jsonb, 'pending', $4, ${vencida ? "NOW() - interval '1 minute'" : 'NULL'})`,
    [id, webhookId, JSON.stringify({ id: `whd_${id.substring(0, 8)}`, event: 'invoice.paid' }), intentos]
  );
  return id;
}

async function leer(id: string): Promise<WebhookDelivery> {
  const { rows } = await query<WebhookDelivery>(
    'SELECT * FROM webhook_deliveries WHERE id = $1',
    [id]
  );
  return rows[0];
}

const vencer = (id: string): Promise<unknown> =>
  query("UPDATE webhook_deliveries SET next_retry_at = NOW() - interval '1 second' WHERE id = $1", [id]);

describe('§4 el barrido: el tope, el solape en vuelo y lo que nunca verá', () => {
  let g: Fixture;

  beforeAll(async () => {
    g = await crearInquilino('Ataque G4b barrido');
  });

  beforeEach(() => {
    llamadas = [];
    responder = async () => ({ ok: false, status: 500 });
    instalarReceptor();
  });

  afterEach(() => {
    globalThis.fetch = fetchReal;
  });

  /**
   * HALLAZGO — la política de 12 intentos que politica-reintento.ts
   * argumenta párrafo a párrafo no le llegaba a NINGUNA suscripción.
   *
   * `webhook_subscriptions.retry_config` es NOT NULL con DEFAULT
   * `{"max_retries": 5, "retry_interval_seconds": 60}` desde la migración
   * 003, y `politicaDe` le da precedencia a la suscripción sobre el
   * entorno. `createWebhook` no escribía la columna, así que toda
   * suscripción nacía con el 5 —la política que el módulo llama «un
   * trámite» y dice haber sustituido— y la ventana de 20 h 31 min no
   * existía en ninguna parte.
   *
   * Arreglado en `createWebhook`, que ahora escribe la política
   * configurada. Las filas ANTERIORES conservan su 5: cambiarlas pide una
   * migración de relleno y este frente no toca migraciones. Queda nombrado.
   */
  it('una suscripción recién creada nace con la política que el módulo argumenta', async () => {
    const wh = await withTenant(g.tenantId, () =>
      createWebhook(g.tenantId, 'https://politica-nueva.invalid/hook', ['invoice.paid'])
    );
    const { rows } = await query<{ retry_config: WebhookSubscription['retry_config'] }>(
      'SELECT retry_config FROM webhook_subscriptions WHERE id = $1',
      [wh.id]
    );
    expect(politicaDe(rows[0]).maxIntentos).toBe(config.webhooks.maxRetries);
    expect(politicaDe(rows[0]).baseSegundos).toBe(config.webhooks.retryInterval);

    // Y la fila que se quedó con el DEFAULT de la 003 sigue con 5: es el
    // estado de todo lo creado antes de este arreglo, y se dice.
    await query('UPDATE webhook_subscriptions SET retry_config = DEFAULT WHERE id = $1', [wh.id]);
    const vieja = await query<{ retry_config: WebhookSubscription['retry_config'] }>(
      'SELECT retry_config FROM webhook_subscriptions WHERE id = $1',
      [wh.id]
    );
    expect(politicaDe(vieja.rows[0]).maxIntentos).toBe(5);
  });

  it('el receptor caído se intenta EXACTAMENTE el tope de veces, ni una más', async () => {
    // El tope no se comprueba mirando una fila: se cuenta llamada por
    // llamada. Cuatro intentos configurados, cuatro peticiones, y después
    // el barrido no vuelve a llamar aunque se le insista.
    const wh = await suscripcion(g, 'https://tope.invalid/hook', {
      max_retries: 4,
      retry_interval_seconds: 60,
    });
    const id = await entregaVencida(wh, 0);

    for (let pasada = 0; pasada < 8; pasada++) {
      await vencer(id);
      await barrerEntregasVencidas({ tenantId: g.tenantId });
      if ((await leer(id)).status === 'failed') break;
    }

    expect(llamadas.filter((l) => l.webhookId === id)).toHaveLength(4);

    const fila = await leer(id);
    expect(fila.attempt_count).toBe(4);
    expect(fila.status).toBe('failed');
    expect(fila.next_retry_at, 'MUERTA = (failed, next_retry_at NULL)').toBeNull();
    expect(fila.error_message).toContain(MUERTA_PREFIJO);

    // MUERTA Y VISIBLE, no desaparecida: la fila se encuentra por el
    // camino que un operador usaría, filtrando por estado.
    const { rows } = await query<{ id: string }>(
      `SELECT d.id FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.webhook_id
        WHERE s.tenant_id = $1 AND d.status = 'failed' AND d.id = $2`,
      [g.tenantId, id]
    );
    expect(rows).toHaveLength(1);

    // Y una pasada más no vuelve a tocarla.
    llamadas = [];
    const ultima = await barrerEntregasVencidas({ tenantId: g.tenantId });
    expect(ultima.vencidas).toBe(0);
    expect(llamadas).toHaveLength(0);
  });

  it('500 y luego 200: termina entregada, con un intento por respuesta y sin repetir', async () => {
    const wh = await suscripcion(g, 'https://recupera.invalid/hook', {
      max_retries: 9,
      retry_interval_seconds: 60,
    });
    const id = await entregaVencida(wh, 0);

    await barrerEntregasVencidas({ tenantId: g.tenantId });
    expect((await leer(id)).status).toBe('pending');

    responder = async () => ({ ok: true, status: 200 });
    await vencer(id);
    await barrerEntregasVencidas({ tenantId: g.tenantId });

    const fila = await leer(id);
    expect(fila.status).toBe('success');
    expect(fila.attempt_count).toBe(2);
    expect(fila.delivered_at).not.toBeNull();
    expect(llamadas.filter((l) => l.webhookId === id), 'una llamada por intento').toHaveLength(2);

    // Y ya no vuelve a salir: `status = 'pending'` es la única puerta del
    // reclamo, así que una entregada no se reintenta ni forzándole la hora.
    await query("UPDATE webhook_deliveries SET next_retry_at = NOW() - interval '1 day' WHERE id = $1", [id]);
    llamadas = [];
    await barrerEntregasVencidas({ tenantId: g.tenantId });
    expect(llamadas).toHaveLength(0);
  });

  it('dos pasadas solapadas CON LA PETICIÓN EN VUELO: sale una sola vez', async () => {
    // El caso que el `FOR UPDATE ... SKIP LOCKED` NO cubre. La transacción
    // del reclamo se cierra antes del POST, así que mientras la petición
    // viaja no hay ningún candado: lo único que impide que la segunda
    // pasada reclame la misma fila es el arriendo. Aquí se retiene la
    // respuesta del receptor para que las dos pasadas coincidan de verdad
    // en el tiempo, que es lo que un Promise.all con un doble instantáneo
    // no llega a provocar.
    const wh = await suscripcion(g, 'https://solape-en-vuelo.invalid/hook', {
      max_retries: 9,
      retry_interval_seconds: 60,
    });
    const id = await entregaVencida(wh, 0);

    let soltar: () => void = () => undefined;
    const retenida = new Promise<void>((ok) => {
      soltar = ok;
    });
    responder = async () => {
      await retenida;
      return { ok: true, status: 200 };
    };

    const primera = barrerEntregasVencidas({ tenantId: g.tenantId });
    // Esperar a que la petición esté EN VUELO, no sólo lanzada.
    for (let i = 0; i < 200 && llamadas.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(llamadas, 'la primera pasada ya está esperando al receptor').toHaveLength(1);

    const segunda = await barrerEntregasVencidas({ tenantId: g.tenantId });
    expect(segunda.vencidas, 'la fila está arrendada: la segunda pasada no la ve').toBe(0);
    expect(llamadas, 'y por tanto no la manda otra vez').toHaveLength(1);

    soltar();
    const r1 = await primera;
    expect(r1.entregadas).toBe(1);
    expect((await leer(id)).status).toBe('success');
    expect(llamadas.filter((l) => l.webhookId === id)).toHaveLength(1);
  });

  it('barrer a todos no filtra el contexto de un inquilino al siguiente', async () => {
    const h = await crearInquilino('Ataque G4b vecino');
    const whG = await suscripcion(g, 'https://frontera-g.invalid/hook', { max_retries: 9 });
    const whH = await suscripcion(h, 'https://frontera-h.invalid/hook', { max_retries: 9 });
    const idG = await entregaVencida(whG, 0);
    const idH = await entregaVencida(whH, 0);

    // El barrido corre DENTRO de un contexto ajeno a propósito: lo que se
    // comprueba es que al salir lo deja como estaba y no con el del último
    // inquilino barrido. `withTenant` (y no `enterTenant`) es lo que lo
    // garantiza; con el segundo, todo lo que corriera después en este
    // proceso leería con el contexto del vecino.
    await withTenant(f.tenantId, async () => {
      await barrerEntregasVencidas({});
      expect(currentTenant(), 'el contexto del llamador sobrevive intacto').toBe(f.tenantId);
    });

    expect(llamadas.find((l) => l.webhookId === idG)?.url).toBe('https://frontera-g.invalid/hook');
    expect(llamadas.find((l) => l.webhookId === idH)?.url).toBe('https://frontera-h.invalid/hook');
    expect(currentTenant(), 'y no se queda pegado el del último barrido').not.toBe(h.tenantId);
  });

  /**
   * HALLAZGO (nombrado, no arreglado) — la entrega que NINGÚN barrido verá.
   *
   * `dispatchEvent` inserta la entrega con `next_retry_at` en NULL y lanza
   * el envío sin esperarlo (`webhook-service.ts:96`, «fire and forget»). Si
   * el proceso muere en esa ventana —un despliegue, un OOM— la fila se
   * queda en (`pending`, `next_retry_at NULL`), y el reclamo del barrido
   * exige `next_retry_at IS NOT NULL`: nadie la volverá a mirar nunca.
   *
   * No se arregla aquí porque el arreglo obliga a elegir a partir de cuándo
   * una entrega «en vuelo» se da por abandonada, y adoptarlas demasiado
   * pronto significa entregar dos veces lo que sí estaba viajando. Es una
   * decisión de plazo, no un descuido: va nombrada en el informe.
   */
  it('la entrega nunca intentada es invisible para el barrido (defecto fijado)', async () => {
    const wh = await suscripcion(g, 'https://huerfana.invalid/hook', { max_retries: 9 });
    const id = await entregaVencida(wh, 0, false);
    expect((await leer(id)).next_retry_at).toBeNull();

    const r = await barrerEntregasVencidas({ tenantId: g.tenantId });
    expect(r.detalle.some((d) => d.deliveryId === id)).toBe(false);
    expect(llamadas.filter((l) => l.webhookId === id)).toHaveLength(0);

    const fila = await leer(id);
    expect(fila.status).toBe('pending');
    expect(fila.attempt_count).toBe(0);
  });
});
