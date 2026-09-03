import { z } from 'zod';
import { cotaDeArreglo } from './topes.js';

// ============================================================
// DE ZOD A JSON SCHEMA — EL CONVERSOR QUE SE NIEGA A ADIVINAR.
//
// POR QUÉ PROPIO Y NO UNA DEPENDENCIA. Antes de escribirlo se midió el
// subconjunto de Zod que esta API usa DE VERDAD, recorriendo los 44
// esquemas que `validateBody` recibe en la pila montada (980 nodos,
// profundidad máxima 9):
//
//   ZodString 293 · ZodOptional 291 · ZodObject 71 · ZodNumber 45 ·
//   ZodBoolean 36 · ZodEnum 31 · ZodUnion 31 · ZodArray 29 ·
//   ZodNullable 23 · ZodRecord 20 · ZodUnknown 19 · ZodEffects 18 ·
//   ZodDefault 2   (+ ZodNever 71, que es sólo el `catchall` que Zod le
//                   pone a todo objeto y nunca un tipo escrito a mano)
//
//   comprobaciones: string uuid 58 · max 40 · min 30 · regex 19 ·
//   email 10 · length 6 · url 3 ; number int 10 · min 8 · max 2 ;
//   objeto strip 56 / passthrough 15 ; efectos refinement 16 /
//   transform 2.
//
// Trece constructores y once comprobaciones. Zod tiene más de treinta
// constructores que esta API no usa —ni tuplas, ni intersecciones, ni
// uniones discriminadas, ni lazy, ni fechas, ni literales—, así que traer
// una dependencia para traducirlos sería pagar por lo que no se usa en un
// sistema contable, donde cada dependencia nueva es superficie que hay que
// auditar. Lo de abajo cabe en un archivo que se lee de una sentada.
//
// LA OTRA OPCIÓN QUE SÍ EXISTÍA, y por qué no se tomó: la zod instalada es
// la 3.25.76, que YA TRAE `zod/v4` con `toJSONSchema()` de fábrica. No
// sirve: los 50 esquemas están escritos contra la API v3 (`z` de 'zod'),
// y `toJSONSchema` sobre uno de ellos revienta con «Cannot read properties
// of undefined (reading 'def')». Usarla obligaría a migrar a v4 la capa de
// validación entera de una API contable viva. Es una migración legítima y
// puede que valga la pena; no es este tramo. Queda nombrada.
//
// LA REGLA QUE HACE ESTO UN INSTRUMENTO Y NO UN ADORNO: ante un
// constructor o una comprobación que no sabe traducir, este conversor
// LANZA. No emite `{}`, no ignora el nodo, no aproxima. Un contrato que
// calla un campo es peor que ninguno, porque quien integra lo lee como
// «cualquier cosa vale». Así que el día que alguien escriba
// `z.discriminatedUnion` en una ruta, la prueba del contrato falla con el
// nombre del constructor y la ruta donde está — que es exactamente cómo
// se entera de que hay que ampliar este archivo.
// ============================================================

/** Un nodo de JSON Schema, tal como se serializa. */
export type EsquemaJson = Record<string, unknown>;

/**
 * Un esquema que este conversor no sabe traducir SIN INVENTAR.
 *
 * Lleva la ruta dentro del esquema (`cuerpo.lines[].account_id`) porque
 * un mensaje que sólo diga «ZodTuple no soportado» obliga a buscar a mano
 * en 5 000 renglones de rutas.
 */
export class ZodNoTraducible extends Error {
  constructor(
    public readonly donde: string,
    detalle: string
  ) {
    super(
      `No se puede publicar el contrato de ${donde}: ${detalle}\n\n` +
        'El conversor de src/api/rest/zod-a-json-schema.ts lanza en vez de emitir un esquema ' +
        'vacío, porque un contrato que calla un campo se lee como «aquí vale cualquier cosa» y ' +
        'es peor que no publicar nada. Añade el caso al conversor —con su prueba— o expresa el ' +
        'esquema con los constructores que ya sabe traducir.'
    );
    this.name = 'ZodNoTraducible';
  }
}

/**
 * Traduce un esquema de Zod a JSON Schema 2020-12, que es el dialecto que
 * OpenAPI 3.1 usa sin adaptaciones.
 *
 * 3.1 y no 3.0 por una razón medida: hay 23 `.nullable()` y 31 uniones de
 * primitivos en estos esquemas. En 3.0 lo primero es la extensión
 * propietaria `nullable: true` y lo segundo un `oneOf` con reglas de
 * exclusividad que Zod no tiene; en 3.1 son `type: ['string','null']` y
 * `anyOf`, que es literalmente lo que Zod hace.
 *
 * @param donde  Cómo llamar a este esquema en un error. La recursión le va
 *               añadiendo el camino del campo.
 */
export function jsonSchemaDeZod(esquema: z.ZodTypeAny, donde: string): EsquemaJson {
  // ── envolturas: no son un tipo, modifican al de dentro ──

  if (esquema instanceof z.ZodOptional) {
    // La opcionalidad NO se expresa en el nodo: se expresa en la lista
    // `required` del objeto que lo contiene, y de eso se encarga el caso
    // ZodObject. Aquí sólo se desenvuelve.
    return jsonSchemaDeZod(esquema.unwrap() as z.ZodTypeAny, donde);
  }

  if (esquema instanceof z.ZodNullable) {
    return admitirNulo(jsonSchemaDeZod(esquema.unwrap() as z.ZodTypeAny, donde));
  }

  if (esquema instanceof z.ZodDefault) {
    const dentro = jsonSchemaDeZod(esquema._def.innerType as z.ZodTypeAny, donde);
    // El valor por omisión se publica tal cual: es lo que la API pondrá si
    // el campo no viene, y quien integra necesita saberlo para no mandarlo.
    return { ...dentro, default: esquema._def.defaultValue() as unknown };
  }

  if (esquema instanceof z.ZodEffects) {
    // LAS ASERCIONES DE ESTE BLOQUE, TODAS DE LA MISMA CLASE Y CON EL MISMO
    // MOTIVO: el `instanceof` de Zod estrecha a genéricos `any`
    // (`ZodObject<any, any, any, any, any>`), y pasarlos así arrastra ese
    // `any` por todo el conversor. Se anclan al tipo concreto justo detrás de
    // la comprobación que ya demostró que lo son.
    return deEfectos(esquema as z.ZodEffects<z.ZodTypeAny>, donde);
  }

  // ── tipos ──

  if (esquema instanceof z.ZodString) return deCadena(esquema, donde);
  if (esquema instanceof z.ZodNumber) return deNumero(esquema, donde);
  if (esquema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (esquema instanceof z.ZodEnum) {
    const valores = esquema._def.values as readonly string[];
    return { type: 'string', enum: [...valores] };
  }
  if (esquema instanceof z.ZodArray) return deArreglo(esquema as z.ZodArray<z.ZodTypeAny>, donde);
  if (esquema instanceof z.ZodObject) {
    return deObjeto(esquema as z.ZodObject<z.ZodRawShape>, donde);
  }
  if (esquema instanceof z.ZodUnion) {
    return deUnion(esquema as z.ZodUnion<readonly [z.ZodTypeAny, ...z.ZodTypeAny[]]>, donde);
  }
  if (esquema instanceof z.ZodRecord) {
    return deDiccionario(esquema as z.ZodRecord<z.ZodString, z.ZodTypeAny>, donde);
  }

  // `z.unknown()` y `z.any()` son la MISMA afirmación en JSON Schema: no
  // hay restricción. Se emite `{}` a propósito y no se lanza, porque aquí
  // el vacío no es una traducción fallida: es lo que el esquema dice.
  if (esquema instanceof z.ZodUnknown || esquema instanceof z.ZodAny) return {};

  throw new ZodNoTraducible(
    donde,
    `el constructor de Zod "${nombreDe(esquema)}" no está traducido.`
  );
}

/** El `typeName` que Zod guarda, para poder nombrarlo en un error. */
function nombreDe(esquema: z.ZodTypeAny): string {
  const def: unknown = esquema._def;
  if (typeof def === 'object' && def !== null && 'typeName' in def) {
    return String(def.typeName);
  }
  return esquema.constructor.name;
}

/**
 * Añade `null` a lo que ya admitía el nodo.
 *
 * Se prefiere ampliar el `type` a envolver en un `anyOf` porque el
 * resultado se lee: `type: ['string','null']` con su `format: 'uuid'` al
 * lado sigue siendo un campo, mientras que el `anyOf` lo parte en dos y
 * los generadores de cliente producen uniones feas. El `anyOf` queda para
 * los nodos que no tienen un `type` simple (una unión, o `{}`).
 */
function admitirNulo(nodo: EsquemaJson): EsquemaJson {
  if (typeof nodo.type === 'string') return { ...nodo, type: [nodo.type, 'null'] };
  if (Array.isArray(nodo.type)) {
    const tipos = nodo.type as unknown[];
    return tipos.includes('null') ? nodo : { ...nodo, type: [...tipos, 'null'] };
  }
  // `z.unknown().nullable()` ya admitía null: envolverlo no añadiría nada
  // y sí quitaría legibilidad.
  if (Object.keys(nodo).length === 0) return nodo;
  // Una unión que además admite null es UNA unión con una rama más. Anidar
  // `anyOf` dentro de `anyOf` valida igual y se lee la mitad de bien, y los
  // importes —`z.union([z.string(), z.number()]).nullable()`— son justo el
  // caso que más aparece.
  if (Array.isArray(nodo.anyOf) && Object.keys(nodo).length === 1) {
    const ramas = nodo.anyOf as unknown[];
    return { anyOf: [...ramas, { type: 'null' }] };
  }
  return { anyOf: [nodo, { type: 'null' }] };
}

function deCadena(esquema: z.ZodString, donde: string): EsquemaJson {
  const nodo: EsquemaJson = { type: 'string' };
  for (const c of esquema._def.checks) {
    switch (c.kind) {
      case 'min':
        nodo.minLength = c.value;
        break;
      case 'max':
        nodo.maxLength = c.value;
        break;
      case 'length':
        nodo.minLength = c.value;
        nodo.maxLength = c.value;
        break;
      case 'uuid':
        nodo.format = 'uuid';
        break;
      case 'email':
        nodo.format = 'email';
        break;
      case 'url':
        // JSON Schema no tiene «url»: tiene «uri», que es lo que
        // `z.string().url()` acepta (necesita esquema, no sólo autoridad).
        nodo.format = 'uri';
        break;
      case 'regex':
        // `pattern` de JSON Schema NO lleva banderas, así que una expresión
        // con `i` o `m` se publicaría más estricta —o más laxa— de lo que la
        // API aplica. Ninguna de las 19 de hoy las usa; si alguna las
        // estrena, se entera aquí y no en producción.
        if (c.regex.flags !== '') {
          throw new ZodNoTraducible(
            donde,
            `la expresión regular /${c.regex.source}/${c.regex.flags} lleva banderas y ` +
              '`pattern` de JSON Schema no las admite: el contrato publicaría otra regla ' +
              'que la que la API aplica.'
          );
        }
        nodo.pattern = c.regex.source;
        break;
      default:
        throw new ZodNoTraducible(
          donde,
          `la comprobación de cadena "${c.kind}" no está traducida.`
        );
    }
  }
  return nodo;
}

function deNumero(esquema: z.ZodNumber, donde: string): EsquemaJson {
  const entero = esquema._def.checks.some((c) => c.kind === 'int');
  const nodo: EsquemaJson = { type: entero ? 'integer' : 'number' };
  for (const c of esquema._def.checks) {
    switch (c.kind) {
      case 'int':
        break; // ya está en `type`
      case 'min':
        // `.positive()` es min 0 NO inclusivo y `.nonnegative()` es min 0
        // inclusivo: la diferencia es justo la que un cliente necesita.
        if (c.inclusive) nodo.minimum = c.value;
        else nodo.exclusiveMinimum = c.value;
        break;
      case 'max':
        if (c.inclusive) nodo.maximum = c.value;
        else nodo.exclusiveMaximum = c.value;
        break;
      case 'multipleOf':
        nodo.multipleOf = c.value;
        break;
      default:
        throw new ZodNoTraducible(
          donde,
          `la comprobación numérica "${c.kind}" no está traducida.`
        );
    }
  }
  return nodo;
}

function deArreglo(esquema: z.ZodArray<z.ZodTypeAny>, donde: string): EsquemaJson {
  const nodo: EsquemaJson = {
    type: 'array',
    items: jsonSchemaDeZod(esquema.element, `${donde}[]`),
  };
  const { minLength, maxLength, exactLength } = esquema._def;
  if (exactLength) {
    nodo.minItems = exactLength.value;
    nodo.maxItems = exactLength.value;
  }
  if (minLength) nodo.minItems = minLength.value;
  if (maxLength) nodo.maxItems = maxLength.value;
  return nodo;
}

function deObjeto(esquema: z.ZodObject<z.ZodRawShape>, donde: string): EsquemaJson {
  const propiedades: EsquemaJson = {};
  const obligatorias: string[] = [];
  for (const [clave, valor] of Object.entries(esquema.shape)) {
    propiedades[clave] = jsonSchemaDeZod(valor, `${donde}.${clave}`);
    // `.optional()` y `.default()` son las dos formas de «puede no venir»:
    // la segunda también lo es, porque Zod rellena el hueco.
    const puedeFaltar = valor instanceof z.ZodOptional || valor instanceof z.ZodDefault;
    if (!puedeFaltar) obligatorias.push(clave);
  }

  const nodo: EsquemaJson = { type: 'object', properties: propiedades };
  if (obligatorias.length > 0) nodo.required = obligatorias;

  // LAS TRES POLÍTICAS DE CLAVES DESCONOCIDAS, SIN APLANARLAS.
  //
  // JSON Schema sólo sabe decir «validan» o «no validan», y Zod tiene tres
  // conductas: `strict` RECHAZA, `passthrough` CONSERVA y `strip`
  // —el defecto, y 56 de los 71 objetos de esta API— DESCARTA EN SILENCIO.
  // Las dos últimas validan igual, así que `additionalProperties: true` es
  // la verdad sobre si la petición pasa; lo que pasa DESPUÉS con esas
  // claves va en una extensión, porque es justo lo que separa «me lo
  // guardas» de «te lo tiro» y ningún cliente puede adivinarlo.
  const desconocidas = esquema._def.unknownKeys;
  if (desconocidas === 'strict') {
    nodo.additionalProperties = false;
  } else {
    const catchall = esquema._def.catchall;
    nodo.additionalProperties =
      catchall instanceof z.ZodNever ? true : jsonSchemaDeZod(catchall, `${donde}.*`);
    nodo['x-claves-desconocidas'] = desconocidas === 'passthrough' ? 'conservadas' : 'descartadas';
  }
  return nodo;
}

function deUnion(
  esquema: z.ZodUnion<readonly [z.ZodTypeAny, ...z.ZodTypeAny[]]>,
  donde: string
): EsquemaJson {
  // `anyOf` y no `oneOf`: Zod prueba las opciones en orden y se queda con
  // la primera que valida, sin exigir que las demás fallen. `oneOf` diría
  // que un valor que encaje en dos es inválido, que no es lo que la API
  // hace — y `z.union([z.string(), z.number()])` de los importes es
  // exactamente donde eso se notaría.
  return {
    anyOf: esquema.options.map((o, i) => jsonSchemaDeZod(o, `${donde}|${i}`)),
  };
}

function deDiccionario(esquema: z.ZodRecord<z.ZodString, z.ZodTypeAny>, donde: string): EsquemaJson {
  const clave: z.ZodTypeAny = esquema.keySchema;
  const nodo: EsquemaJson = {
    type: 'object',
    additionalProperties: jsonSchemaDeZod(esquema.valueSchema, `${donde}.*`),
  };
  if (clave instanceof z.ZodString) {
    // `z.record(x)` usa `z.string()` sin comprobaciones como llave, y eso
    // no restringe nada: sólo se publica `propertyNames` cuando la llave
    // sí exige algo.
    const restricciones = jsonSchemaDeZod(clave, `${donde}.<clave>`);
    if (Object.keys(restricciones).length > 1) nodo.propertyNames = restricciones;
    return nodo;
  }
  if (clave instanceof z.ZodEnum) {
    nodo.propertyNames = jsonSchemaDeZod(clave, `${donde}.<clave>`);
    return nodo;
  }
  throw new ZodNoTraducible(
    donde,
    `las llaves del diccionario son "${nombreDe(clave)}" y sólo se traducen llaves de cadena o enum.`
  );
}

/**
 * `.refine()`, `.superRefine()` y `.transform()`.
 *
 * LO QUE SE PUBLICA ES LA ENTRADA. Un `ZodEffects` de transformación tiene
 * dos formas —la que se acepta y la que sale— y para el cuerpo de una
 * petición la que vale es la primera: `decimalString` acepta cadena o
 * número y produce cadena, y quien integra necesita saber qué MANDAR.
 *
 * LO QUE NO SE PUEDE PUBLICAR, y por eso se marca: el predicado de un
 * refinamiento es una función de JavaScript. «company_name o first_name»,
 * «cargo o abono, no los dos» — nada de eso cabe en JSON Schema, y su
 * mensaje ni siquiera es legible desde fuera (Zod lo encierra en el cierre
 * del refinamiento). Así que el nodo lleva `x-validacion-adicional: true`,
 * que no es la regla pero sí el aviso de que existe una: un cliente que
 * valide contra este esquema y crea que ya pasó, se llevará un 422.
 */
function deEfectos(esquema: z.ZodEffects<z.ZodTypeAny>, donde: string): EsquemaJson {
  const dentro = esquema._def.schema;
  const tipo = esquema._def.effect.type;

  if (tipo === 'preprocess') {
    // `preprocess` cambia el valor ANTES de validarlo, así que el esquema
    // de dentro describe lo que llega al validador y no lo que el cliente
    // manda. Publicar el de dentro sería publicar un contrato falso.
    throw new ZodNoTraducible(
      donde,
      'es un `z.preprocess`, y lo que valida por dentro no es lo que el cliente manda: ' +
        'el contrato saldría describiendo el valor YA transformado.'
    );
  }

  const nodo = jsonSchemaDeZod(dentro, donde);

  // El caso en que el refinamiento SÍ cabe entero en JSON Schema: el tope
  // de arreglo de topes.ts, cuyo `superRefine` no comprueba más que la
  // longitud y que deja el número a la vista justo para esto. Traducirlo
  // como `maxItems` es publicar la regla completa, no avisar de que hay una.
  const tope = cotaDeArreglo(esquema);
  if (tope !== undefined) {
    if (nodo.type !== 'array') {
      throw new ZodNoTraducible(
        donde,
        'lleva una cota de arreglo (topes.ts) sobre algo que no es un arreglo.'
      );
    }
    return { ...nodo, maxItems: tope };
  }

  if (tipo === 'transform') return nodo;
  return { ...nodo, 'x-validacion-adicional': true };
}
