import { describe, it, expect, vi } from 'vitest';
import express, { Router, type Express } from 'express';
import { z } from 'zod';

// ============================================================
// EL CONTRATO DE LA API, PROBADO CONTRA LA API.
//
// Una especificación de OpenAPI escrita a mano se desincroniza el primer
// martes: alguien añade una ruta, nadie toca el YAML, y a partir de ahí el
// documento miente sobre una API que sigue funcionando. Este proyecto ya
// retiró dos artefactos por ese defecto exacto —la tabla de estado del plan
// y el conteo de portada del catálogo— y en los dos casos lo que lo cerró no
// fue arreglar el documento, sino ponerle un instrumento delante.
//
// Éste es el instrumento. No comprueba que el documento esté BONITO:
// comprueba que CUBRE. Se monta la misma superficie que monta el servidor,
// se censa la pila real, y se exige que cada ruta del censo tenga su
// operación. Una ruta nueva sin nada más que hacer rompe esta prueba.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import { montarSuperficieCensable } from '../../../src/api/rest/montajes.js';
import { censarRutas, declararRiesgoRuta, VERBOS_QUE_MUTAN } from '../../../src/api/rest/risk.js';
import { construirOpenAPI, caminoOpenAPI } from '../../../src/api/rest/openapi.js';
import { jsonSchemaDeZod, ZodNoTraducible } from '../../../src/api/rest/zod-a-json-schema.js';
import { validateBody } from '../../../src/api/rest/middleware/async-handler.js';
import { requirePermission } from '../../../src/api/rest/middleware/auth.js';
import { arregloAcotado } from '../../../src/api/rest/topes.js';

function superficie(): Express {
  return montarSuperficieCensable(express());
}

type Operacion = Record<string, unknown>;
type Caminos = Record<string, Record<string, Operacion>>;

function contrato(app: Express): { paths: Caminos; components: Record<string, unknown> } {
  const doc = construirOpenAPI(app);
  return {
    paths: doc.paths as Caminos,
    components: doc.components as Record<string, unknown>,
  };
}

const APP = superficie();
const { paths: CAMINOS, components: COMPONENTES } = contrato(APP);
const CENSO = censarRutas(APP);

function operacionDe(metodo: string, ruta: string): Operacion | undefined {
  return CAMINOS[caminoOpenAPI(ruta)]?.[metodo];
}

describe('la especificación cubre la superficie censada', () => {
  it('cada ruta del censo tiene su operación en la especificación', () => {
    // LA PRUEBA QUE SOSTIENE TODO LO DEMÁS. El mensaje del fallo lleva la
    // lista para que diga QUÉ ruta falta y no sólo cuántas.
    const faltan = CENSO.filter((r) => operacionDe(r.metodo, r.ruta) === undefined).map(
      (r) => `${r.metodo.toUpperCase()} ${r.ruta}`
    );
    expect(faltan).toEqual([]);
  });

  it('la especificación no inventa operaciones que el censo no tenga', () => {
    // La otra mitad: cubrir de más también es mentir. Una ruta que se borra y
    // se queda en el documento manda a un cliente contra un 404.
    const censadas = new Set(CENSO.map((r) => `${r.metodo} ${caminoOpenAPI(r.ruta)}`));
    const sobran: string[] = [];
    for (const [camino, operaciones] of Object.entries(CAMINOS)) {
      for (const metodo of Object.keys(operaciones)) {
        if (!censadas.has(`${metodo} ${camino}`)) sobran.push(`${metodo.toUpperCase()} ${camino}`);
      }
    }
    expect(sobran).toEqual([]);
  });

  it('el censo montado no está vacío, y cubre las 87 rutas que mutan', () => {
    // Sin esto, las dos pruebas de arriba pasarían con una app vacía.
    const mutantes = CENSO.filter((r) => VERBOS_QUE_MUTAN.includes(r.metodo));
    expect(mutantes.length).toBeGreaterThan(0);
    expect(CENSO.length).toBe(
      Object.values(CAMINOS).reduce((n, ops) => n + Object.keys(ops).length, 0)
    );
  });

  it('añadir una ruta y no regenerar nada NO puede pasar: la especificación se deriva', () => {
    // El equivalente de «añadir una ruta sin declarar rompe el arranque»
    // (censo-de-riesgo.spec.ts), para el contrato: aquí no hay nada que
    // regenerar, así que lo que se demuestra es que la ruta nueva APARECE
    // sola. Un documento escrito a mano habría seguido igual.
    const app = superficie();
    const nuevo = Router();
    nuevo.post(
      '/aprobar-todo',
      declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'todo' }),
      (_req, res) => res.json({ ok: true })
    );
    app.use('/v1/experimentos', nuevo);

    const { paths } = contrato(app);
    expect(paths['/v1/experimentos/aprobar-todo']?.post).toBeDefined();
    expect(paths['/v1/experimentos/aprobar-todo'].post['x-riesgo']).toBe('irreversible');
    // Y la especificación de ANTES no la tenía: es la prueba de que la
    // cobertura de arriba no es trivialmente cierta.
    expect(CAMINOS['/v1/experimentos/aprobar-todo']).toBeUndefined();
  });
});

describe('la especificación dice la verdad que G4a estableció', () => {
  it('toda ruta que muta publica su clase de riesgo, y es la del censo', () => {
    const desajustes: string[] = [];
    for (const r of CENSO) {
      if (!VERBOS_QUE_MUTAN.includes(r.metodo)) continue;
      const op = operacionDe(r.metodo, r.ruta);
      if (op?.['x-riesgo'] !== r.riesgo?.riesgo) {
        desajustes.push(
          `${r.metodo.toUpperCase()} ${r.ruta}: censo=${String(r.riesgo?.riesgo)} ` +
            `contrato=${String(op?.['x-riesgo'])}`
        );
      }
    }
    expect(desajustes).toEqual([]);
  });

  it('las cuatro clases aparecen, con el reparto del censo', () => {
    const cuenta: Record<string, number> = {};
    for (const ops of Object.values(CAMINOS)) {
      for (const op of Object.values(ops)) {
        const clase = op['x-riesgo'];
        if (typeof clase === 'string') cuenta[clase] = (cuenta[clase] ?? 0) + 1;
      }
    }
    // Contado sobre la APP, no sobre los routers: xml-ingestion y blockchain
    // se montan dos veces, así que sus rutas se alcanzan por dos direcciones
    // y el contrato publica las dos. No es el 4/46/23/14 de
    // censo-de-riesgo.spec.ts por eso mismo, y la diferencia es real.
    expect(Object.keys(cuenta).sort()).toEqual([
      'escritura',
      'externo',
      'irreversible',
      'lectura',
    ]);
  });

  it('exactamente las rutas irreversibles y externas anuncian la llave de idempotencia', () => {
    const mal: string[] = [];
    for (const r of CENSO) {
      const op = operacionDe(r.metodo, r.ruta);
      if (!op) continue;
      const debe = r.riesgo?.exigeLlaveDeIdempotencia === true;
      const dice = op['x-exige-llave-de-idempotencia'] === true;
      const parametros = (op.parameters ?? []) as Array<{ $ref?: string }>;
      const lleva = parametros.some(
        (p) => p.$ref === '#/components/parameters/LlaveDeIdempotencia'
      );
      // Las tres tienen que coincidir: la clase que exige la llave, la
      // extensión que lo anuncia, y el parámetro que un cliente generado
      // necesita para poder mandarla. Anunciarlo sin el parámetro sería un
      // contrato que dice «manda la cabecera» sin dejar mandarla.
      if (debe !== dice || debe !== lleva) {
        mal.push(`${r.metodo.toUpperCase()} ${r.ruta}: clase=${String(debe)} x-=${String(dice)} parámetro=${String(lleva)}`);
      }
    }
    expect(mal).toEqual([]);
  });

  it('la cabecera se publica como OPCIONAL, que es lo que el guardián hace', () => {
    const parametros = COMPONENTES.parameters as Record<string, Record<string, unknown>>;
    const llave = parametros.LlaveDeIdempotencia;
    expect(llave.name).toBe('idempotency-key');
    expect(llave.in).toBe('header');
    // Exigirla es una decisión abierta y nombrada en middleware/idempotencia.ts.
    // El contrato publica lo que la API hace HOY, no lo que convendría.
    expect(llave.required).toBe(false);
  });

  it('POST /v1/journal-entries/:id/post publica todo lo que la hace peligrosa', () => {
    const op = operacionDe('post', '/v1/journal-entries/:id/post');
    expect(op?.['x-riesgo']).toBe('irreversible');
    expect(op?.['x-agente-permitido']).toBe(false);
    expect(op?.['x-exige-marcha-seca']).toBe(true);
    expect(op?.['x-exige-llave-de-idempotencia']).toBe(true);
    expect(op?.['x-alcance-idempotencia']).toBe('POST /v1/journal-entries/:id/post');
  });

  it('una ruta externa anuncia además la compuerta en vivo', () => {
    const op = operacionDe('post', '/v1/invoices/:id/cfdi/stamp');
    expect(op?.['x-riesgo']).toBe('externo');
    expect(op?.['x-exige-compuerta-en-vivo']).toBe(true);
  });

  it('los permisos publicados son los que la ruta exige de verdad', () => {
    const op = operacionDe('post', '/v1/journal-entries');
    expect(op?.['x-permisos-requeridos']).toEqual(['journal_entries:create']);
    // Y donde hay permiso hay autenticación demostrada: `assertPermissions`
    // lanza 401 sin `req.user`, y sólo `authenticate` lo puebla.
    expect(op?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('las rutas públicas no afirman una autenticación que no se puede derivar', () => {
    // /public/v1 no lleva `requirePermission`, así que no se publica
    // `security`. La ausencia significa «no derivable», y el documento lo
    // dice; lo que NO se hace es inventar que es pública ni que no lo es.
    const op = operacionDe('post', '/public/v1/verify/merkle-proof');
    expect(op).toBeDefined();
    expect(op?.security).toBeUndefined();
  });
});

describe('el cuerpo publicado es el que la API valida', () => {
  it('toda ruta con validateBody publica requestBody, y ninguna otra', () => {
    // El esquema no se busca en una tabla: viaja colgado del manejador de
    // `validateBody`, así que «tiene esquema» y «publica cuerpo» son la
    // misma pregunta hecha dos veces.
    const conCuerpo = Object.values(CAMINOS)
      .flatMap((ops) => Object.values(ops))
      .filter((op) => op.requestBody !== undefined);
    expect(conCuerpo.length).toBe(61);
  });

  it('el cuerpo es obligatorio cuando el esquema rechaza el objeto vacío', () => {
    // createJournalEntrySchema exige entity_id, entry_date y lines.
    const crear = operacionDe('post', '/v1/journal-entries');
    expect((crear?.requestBody as { required: boolean }).required).toBe(true);
    // approvePreRegSchema es `{ notes?: string }`: `{}` pasa, y Express
    // entrega `{}` cuando no viene cuerpo.
    const aprobar = operacionDe('post', '/v1/xml/pre-registrations/:id/approve');
    expect((aprobar?.requestBody as { required: boolean }).required).toBe(false);
  });

  it('el tope que vivía dentro de un cierre se publica como maxItems', () => {
    // Éste es el que más costaba: `arregloAcotado` guarda el 1 000 en el
    // cierre de un superRefine, de modo que el contrato habría anunciado
    // `minItems: 2` y callado el techo — y quien integra lo habría
    // descubierto con un 422 en producción.
    const op = operacionDe('post', '/v1/journal-entries');
    const esquema = (op?.requestBody as { content: Record<string, { schema: Record<string, unknown> }> })
      .content['application/json'].schema;
    const lineas = (esquema.properties as Record<string, Record<string, unknown>>).lines;
    expect(lineas.minItems).toBe(2);
    expect(lineas.maxItems).toBe(1000);
  });

  it('la validación cruzada que JSON Schema no expresa queda AVISADA', () => {
    // journalLineSchema exige cargo O abono, no los dos. Eso es una función
    // de JavaScript: no cabe en JSON Schema y su mensaje ni siquiera es
    // legible desde fuera. Lo que no puede pasar es que el contrato calle
    // que existe, porque un cliente que valide y crea que ya pasó, no pasó.
    const op = operacionDe('post', '/v1/journal-entries');
    const esquema = (op?.requestBody as { content: Record<string, { schema: Record<string, unknown> }> })
      .content['application/json'].schema;
    const lineas = (esquema.properties as Record<string, Record<string, unknown>>).lines;
    expect((lineas.items as Record<string, unknown>)['x-validacion-adicional']).toBe(true);
  });
});

describe('el documento se sostiene solo', () => {
  it('todos los $ref apuntan a algo que existe', () => {
    const doc = construirOpenAPI(APP);
    const rotos: string[] = [];
    const visitar = (nodo: unknown): void => {
      if (Array.isArray(nodo)) {
        nodo.forEach(visitar);
        return;
      }
      if (typeof nodo !== 'object' || nodo === null) return;
      for (const [clave, valor] of Object.entries(nodo)) {
        if (clave === '$ref' && typeof valor === 'string') {
          const partes = valor.replace(/^#\//, '').split('/');
          let cursor: unknown = doc;
          for (const p of partes) {
            cursor =
              typeof cursor === 'object' && cursor !== null
                ? (cursor as Record<string, unknown>)[p]
                : undefined;
          }
          if (cursor === undefined) rotos.push(valor);
        } else {
          visitar(valor);
        }
      }
    };
    visitar(doc);
    expect(rotos).toEqual([]);
  });

  it('dos rutas que colisionaran en operationId rompen la generación', () => {
    // Un operationId repetido no da error en ninguna herramienta: hace que
    // el generador de clientes se quede con UNA de las dos y tire la otra.
    // Se rompe aquí para que se vea.
    const app = express();
    const a = Router();
    a.get('/x', (_req, res) => res.json({}));
    app.use('/v1/dup', a);
    app.use('/v1/dup', a);
    expect(() => construirOpenAPI(app)).toThrow(/mismo operationId/);
  });

  it('los caminos de Express se publican con la plantilla de OpenAPI', () => {
    expect(caminoOpenAPI('/v1/invoices/:id/payments')).toBe('/v1/invoices/{id}/payments');
    expect(caminoOpenAPI('/v1/bank-accounts/:account_id/import')).toBe(
      '/v1/bank-accounts/{account_id}/import'
    );
    expect(CAMINOS['/v1/invoices/{id}/payments']).toBeDefined();
  });
});

// ============================================================
// EL CONVERSOR, PIEZA A PIEZA.
//
// El censo demuestra que la especificación CUBRE; esto demuestra que lo que
// pone en cada campo es lo que el esquema dice. Los trece constructores de
// abajo son exactamente los que la medición encontró en los 44 esquemas de
// la API — ni uno más, para que la última prueba del bloque signifique algo.
// ============================================================
describe('de Zod a JSON Schema: lo que la API usa', () => {
  const conv = (e: z.ZodTypeAny) => jsonSchemaDeZod(e, 'prueba');

  it('cadenas, con sus comprobaciones', () => {
    expect(conv(z.string())).toEqual({ type: 'string' });
    expect(conv(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' });
    expect(conv(z.string().email())).toEqual({ type: 'string', format: 'email' });
    // `url` de Zod es `uri` de JSON Schema: no es un sinónimo suelto, es el
    // nombre del formato que exige esquema y no sólo autoridad.
    expect(conv(z.string().url())).toEqual({ type: 'string', format: 'uri' });
    expect(conv(z.string().min(1).max(255))).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 255,
    });
    expect(conv(z.string().length(3))).toEqual({ type: 'string', minLength: 3, maxLength: 3 });
    expect(conv(z.string().regex(/^\d{4}-\d{2}-\d{2}/))).toEqual({
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}',
    });
  });

  it('números, distinguiendo entero de real y abierto de cerrado', () => {
    expect(conv(z.number())).toEqual({ type: 'number' });
    expect(conv(z.number().int())).toEqual({ type: 'integer' });
    expect(conv(z.number().int().min(1).max(100))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    // `.positive()` excluye el cero y `.nonnegative()` lo incluye: la
    // diferencia importa en un sistema donde un importe cero es legal.
    expect(conv(z.number().positive())).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect(conv(z.number().int().nonnegative())).toEqual({ type: 'integer', minimum: 0 });
  });

  it('booleanos, enums y arreglos', () => {
    expect(conv(z.boolean())).toEqual({ type: 'boolean' });
    expect(conv(z.enum(['daily', 'weekly']))).toEqual({
      type: 'string',
      enum: ['daily', 'weekly'],
    });
    expect(conv(z.array(z.string()).min(1).max(100))).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 100,
    });
  });

  it('lo opcional se expresa en `required` del objeto, no en el campo', () => {
    expect(
      conv(z.object({ a: z.string(), b: z.string().optional(), c: z.string().default('x') }))
    ).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string', default: 'x' },
      },
      // `c` tiene valor por omisión, así que tampoco es obligatoria: Zod
      // rellena el hueco y exigirla en el contrato sería pedir de más.
      required: ['a'],
      additionalProperties: true,
      'x-claves-desconocidas': 'descartadas',
    });
  });

  it('las tres políticas de claves desconocidas se distinguen', () => {
    const forma = { a: z.string() };
    expect(conv(z.object(forma).strict()).additionalProperties).toBe(false);
    expect(conv(z.object(forma).passthrough())['x-claves-desconocidas']).toBe('conservadas');
    expect(conv(z.object(forma))['x-claves-desconocidas']).toBe('descartadas');
    // `strip` y `passthrough` validan IGUAL —las claves de más no rompen la
    // petición— y por eso las dos dicen `additionalProperties: true`. Lo que
    // las separa es qué pasa después, y eso sólo cabe en la extensión.
    expect(conv(z.object(forma)).additionalProperties).toBe(true);
    expect(conv(z.object(forma).passthrough()).additionalProperties).toBe(true);
  });

  it('nulo se añade al `type` en vez de partir el nodo en dos', () => {
    expect(conv(z.string().uuid().nullable())).toEqual({
      type: ['string', 'null'],
      format: 'uuid',
    });
    // Y una unión que además admite nulo es UNA unión con una rama más.
    expect(conv(z.union([z.string(), z.number()]).nullable())).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
    });
  });

  it('las uniones son `anyOf` y no `oneOf`', () => {
    // Zod prueba las opciones en orden y se queda con la primera que valida:
    // no exige que las demás fallen. `oneOf` diría lo contrario, y con
    // `z.union([z.string(), z.number()])` —el tipo de la mitad de los
    // importes— la diferencia es real.
    expect(conv(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('diccionarios y `unknown`', () => {
    expect(conv(z.record(z.unknown()))).toEqual({ type: 'object', additionalProperties: {} });
    expect(conv(z.record(z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
    expect(conv(z.unknown())).toEqual({});
  });

  it('de una transformación se publica la ENTRADA', () => {
    // `decimalString` acepta cadena o número y produce cadena. Quien integra
    // necesita saber qué MANDAR, no qué guarda la base.
    const decimal = z.union([z.string(), z.number()]).transform((v) => String(v));
    expect(conv(decimal)).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
  });

  it('un refinamiento se avisa; un tope de arreglo se publica entero', () => {
    expect(conv(z.object({ a: z.string() }).refine(() => true))).toMatchObject({
      'x-validacion-adicional': true,
    });
    // El tope no se avisa: se traduce. `arregloAcotado` deja el número a la
    // vista precisamente para que el contrato pueda decirlo en vez de
    // limitarse a advertir que hay algo más.
    const acotado = arregloAcotado(z.string(), {
      tope: 500,
      plural: 'cosas',
      salida: 'pártelo',
      minimo: 1,
    });
    expect(conv(acotado)).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 500,
    });
    expect(conv(acotado)['x-validacion-adicional']).toBeUndefined();
  });
});

describe('el conversor se niega a adivinar', () => {
  // ESTA ES LA PARTE QUE HACE QUE EL CONTRATO NO SE PUDRA POR DENTRO.
  //
  // La cobertura de arriba comprueba que ninguna ruta se queda FUERA. Esto
  // comprueba lo otro: que ningún campo se publique VACÍO. Un conversor que
  // ante un constructor desconocido emite `{}` produce un contrato que dice
  // «aquí vale cualquier cosa» sobre un campo que la API rechaza, y nadie se
  // entera nunca — ni una prueba, ni un cliente, hasta el 422.
  const rechaza = (e: z.ZodTypeAny) => () => jsonSchemaDeZod(e, 'prueba');

  it.each([
    ['z.tuple', z.tuple([z.string(), z.number()])],
    ['z.discriminatedUnion', z.discriminatedUnion('t', [
      z.object({ t: z.literal('a'), x: z.string() }),
      z.object({ t: z.literal('b'), y: z.number() }),
    ])],
    ['z.date', z.date()],
    ['z.literal', z.literal('x')],
    ['z.intersection', z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))],
    ['z.lazy', z.lazy(() => z.string())],
    ['z.bigint', z.bigint()],
    ['z.null', z.null()],
    ['z.nativeEnum', z.nativeEnum({ A: 'a', B: 'b' })],
  ])('%s no está traducido y lanza en vez de emitir un hueco', (_nombre, esquema) => {
    expect(rechaza(esquema as z.ZodTypeAny)).toThrow(ZodNoTraducible);
    expect(rechaza(esquema as z.ZodTypeAny)).toThrow(/no está traducid/);
  });

  it('el error dice DÓNDE, con el camino dentro del esquema', () => {
    // Sin el camino, «ZodDate no está traducido» obliga a buscar a mano en
    // los 5 146 renglones de src/api/rest/routes.
    const esquema = z.object({ lines: z.array(z.object({ at: z.date() })) });
    expect(rechaza(esquema)).toThrow('prueba.lines[].at');
  });

  it('una comprobación de cadena sin traducir también lanza', () => {
    // `.startsWith()` es una comprobación de Zod que JSON Schema sólo puede
    // expresar como `pattern`, y traducirla mal es peor que no traducirla.
    expect(rechaza(z.string().startsWith('MX'))).toThrow(/comprobación de cadena "startsWith"/);
  });

  it('una expresión regular con banderas lanza: `pattern` no las tiene', () => {
    // Publicar /^abc$/i como `"^abc$"` convierte una regla que acepta «ABC»
    // en una que la rechaza. El contrato diría otra cosa que la API.
    expect(rechaza(z.string().regex(/^abc$/i))).toThrow(/banderas/);
  });

  it('`z.preprocess` lanza: lo de dentro no es lo que el cliente manda', () => {
    const esquema = z.preprocess((v) => String(v), z.string());
    expect(rechaza(esquema as z.ZodTypeAny)).toThrow(/preprocess/);
  });

  it('y el rechazo llega hasta la construcción del documento', () => {
    // No basta con que el conversor lance: tiene que lanzar CUANDO se
    // publica, sobre la ruta que lo provoca. Una ruta con un esquema no
    // traducible rompe la generación entera y nombra la ruta.
    const app = express();
    const r = Router();
    r.post(
      '/raro',
      declararRiesgoRuta({ riesgo: 'escritura' }),
      requirePermission('settings:manage'),
      validateBody(z.object({ cuando: z.date() })),
      (_req, res) => res.json({})
    );
    app.use('/v1/experimentos', r);
    expect(() => construirOpenAPI(app)).toThrow(/POST \/v1\/experimentos\/raro/);
  });
});
