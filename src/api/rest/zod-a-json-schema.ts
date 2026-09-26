import { z } from 'zod';
import { cotaDeArreglo } from './topes.js';

// ============================================================
// DE ZOD A JSON SCHEMA — EL CONVERSOR QUE SE NIEGA A ADIVINAR.
//
// WHY ITS OWN AND NOT A DEPENDENCY. Before it was written, the subset of Zod
// this API really uses was measured by walking the schemas `validateBody`
// receives on the mounted stack. Re-measured on zod 4.6.5 for #367, on top
// of 20b05d03, walking `_zod.def` of the 46 distinct mounted body schemas
// (697 nodes, maximum depth 8):
//
//   string 239 · optional 223 · object 54 · number 37 · union 28 ·
//   enum 25 · boolean 23 · nullable 19 · array 19 · unknown 12 ·
//   record 12 · pipe 2 (each with its transform) · default 2
//
//   checks: string guid 45 · max_length 36 · min_length 24 · regex 19 ·
//   email 8 · length_equals 6 · url 2 ; number safeint 6 ·
//   greater_than 5 · less_than 2 ; array min_length 6 · max_length 2 ·
//   custom 5 (the caps of topes.ts) ; object custom 8 (refinements) ;
//   objects strip 41 / passthrough 12 / strict 1.
//
// A dozen constructors and a dozen checks. Zod has more than thirty
// constructors this API does not use —no tuples, intersections,
// discriminated unions, lazy, dates or literals—, so a dependency to
// translate them would be paying for what is not used in an accounting
// system, where every new dependency is surface to audit. What follows fits
// in a file that reads in one sitting.
//
// z.toJSONSchema, AND WHY IT IS STILL NOT USED (#367). On zod 3 the reason
// was mechanical: the schemas were v3 and `toJSONSchema` crashed on them. On
// zod 4 that reason is gone and the others remain. Measured on 4.6.5 with
// { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }, it
// differs from docs/openapi.json on almost every node kind: a `$schema` on
// every root; uuid and email carry zod's own regex as `pattern`; `.int()`
// adds ±9007199254740991 bounds; nullable becomes `anyOf` while a primitive
// union collapses to a `type` array; strip objects lose
// `additionalProperties: true` and the unknown-key extension; refinements
// lose `x-validacion-adicional`; the array cap disappears. Worse, it does
// what this converter exists to prevent: it publishes the INNER schema of a
// `z.preprocess` (a false contract), drops regex flags, and translates
// discriminated unions, tuples, literals and native enums instead of
// refusing, with no field path in its errors. Byte identity would need an
// `override` that rewrites every node, i.e. this file on a moving target.
//
// NOTE: the safe-integer bound that src/utils/zod-compat.ts enforces on
// integers (T2 in #367) is deliberately NOT published: JSON cannot carry an
// integer beyond it exactly, so no client can send one on purpose, and
// publishing it would change docs/openapi.json for every integer field.
//
// LA REGLA QUE HACE ESTO UN INSTRUMENTO Y NO UN ADORNO: ante un
// constructor o una comprobación que no sabe traducir, este conversor
// LANZA. No emite `{}`, no ignora el nodo, no aproxima. Un contrato que
// calla un campo es peor que ninguno, porque quien integra lo lee como
// «cualquier cosa vale». Así que el día que alguien escriba
// `z.discriminatedUnion` en una ruta, la prueba del contrato falla con el
// nombre del constructor y la ruta donde está — que es exactamente cómo
// se entera de que hay que ampliar este archivo.
//
// It reads zod 4 through `instanceof z.core.$Zod*` and `_zod.def` only:
// never `_zod.bag`, whose integer bounds would leak into the contract.
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
 * 3.1 y no 3.0 por una razón medida: hay 19 `.nullable()` y 28 uniones de
 * primitivos en estos esquemas. En 3.0 lo primero es la extensión
 * propietaria `nullable: true` y lo segundo un `oneOf` con reglas de
 * exclusividad que Zod no tiene; en 3.1 son `type: ['string','null']` y
 * `anyOf`, que es literalmente lo que Zod hace.
 *
 * @param donde  Cómo llamar a este esquema en un error. La recursión le va
 *               añadiendo el camino del campo.
 */
export function jsonSchemaDeZod(esquema: z.core.$ZodType, donde: string): EsquemaJson {
  return withRefinementFlag(esquema, translateNode(esquema, donde), donde);
}

/** The node itself, before the refinement flag. The dispatch order matters: see each step. */
function translateNode(schema: z.core.$ZodType, where: string): EsquemaJson {
  // ── envolturas: no son un tipo, modifican al de dentro ──

  if (schema instanceof z.core.$ZodOptional) {
    // La opcionalidad NO se expresa en el nodo: se expresa en la lista
    // `required` del objeto que lo contiene, y de eso se encarga el caso
    // ZodObject. Aquí sólo se desenvuelve.
    const inner = schema._zod.def.innerType;
    if (inner instanceof z.core.$ZodDefault) {
      // NOTE(#367): zod 3 and zod 4 disagree on this shape (`.default()`
      // under `.optional()`, which `.partial()` also builds over defaults): a
      // missing key stays missing on zod 3 and gets the default on zod 4. The
      // contract cannot say both, so it says neither.
      throw new ZodNoTraducible(
        where,
        'is `.default()` wrapped in `.optional()`: zod 3 leaves a missing key out and zod 4 ' +
          'fills it with the default, so the published default would be true on only one of them.'
      );
    }
    return jsonSchemaDeZod(inner, where);
  }

  if (schema instanceof z.core.$ZodNullable) {
    return admitirNulo(jsonSchemaDeZod(schema._zod.def.innerType, where));
  }

  if (schema instanceof z.core.$ZodDefault) {
    // El valor por omisión se publica tal cual: es lo que la API pondrá si
    // el campo no viene, y quien integra necesita saberlo para no mandarlo.
    const inner = jsonSchemaDeZod(schema._zod.def.innerType, where);
    return { ...inner, default: schema._zod.def.defaultValue };
  }

  if (schema instanceof z.core.$ZodPipe) return fromPipe(schema, where);

  // ── tipos ──

  if (schema instanceof z.core.$ZodString) return deCadena(schema, where);
  if (schema instanceof z.core.$ZodNumber) return deNumero(schema, where);
  if (schema instanceof z.core.$ZodBoolean) return { type: 'boolean' };

  // Zod 4 made the discriminated union and the exclusive union (z.xor)
  // subclasses of the union: they must be refused BEFORE the union case, or
  // they would be published as a plain `anyOf` that says something else.
  if (
    schema instanceof z.core.$ZodDiscriminatedUnion ||
    schema instanceof z.core.$ZodXor ||
    (schema instanceof z.core.$ZodUnion && schema._zod.def.inclusive === false)
  ) {
    throw new ZodNoTraducible(where, `el constructor de Zod "${unionName(schema)}" no está traducido.`);
  }

  if (schema instanceof z.core.$ZodEnum) return fromEnum(schema, where);
  if (schema instanceof z.core.$ZodUnion) return deUnion(schema, where);
  if (schema instanceof z.core.$ZodArray) return deArreglo(schema, where);
  if (schema instanceof z.core.$ZodObject) return deObjeto(schema, where);
  if (schema instanceof z.core.$ZodRecord) return deDiccionario(schema, where);

  // `z.unknown()` y `z.any()` son la MISMA afirmación en JSON Schema: no
  // hay restricción. Se emite `{}` a propósito y no se lanza, porque aquí
  // el vacío no es una traducción fallida: es lo que el esquema dice.
  if (schema instanceof z.core.$ZodUnknown || schema instanceof z.core.$ZodAny) return {};

  throw new ZodNoTraducible(where, `el constructor de Zod "${nombreDe(schema)}" no está traducido.`);
}

/** El `type` que Zod guarda, para poder nombrarlo en un error. */
function nombreDe(esquema: z.core.$ZodType): string {
  return esquema._zod.def.type;
}

function unionName(schema: z.core.$ZodType): string {
  if (schema instanceof z.core.$ZodDiscriminatedUnion) return 'discriminatedUnion';
  if (schema instanceof z.core.$ZodXor) return 'xor';
  return 'union (exclusive)';
}

/**
 * `.transform()` and `z.preprocess`, which zod 4 builds as pipes.
 *
 * LO QUE SE PUBLICA ES LA ENTRADA. Una transformación tiene dos formas —la
 * que se acepta y la que sale— y para el cuerpo de una petición la que vale
 * es la primera: `decimalString` acepta cadena o número y produce cadena, y
 * quien integra necesita saber qué MANDAR.
 */
function fromPipe(schema: z.core.$ZodPipe, where: string): EsquemaJson {
  const { in: input, out } = schema._zod.def;
  if (input instanceof z.core.$ZodTransform) {
    // `preprocess` cambia el valor ANTES de validarlo, así que el esquema
    // de dentro describe lo que llega al validador y no lo que el cliente
    // manda. Publicar el de dentro sería publicar un contrato falso.
    throw new ZodNoTraducible(
      where,
      'es un `z.preprocess`, y lo que valida por dentro no es lo que el cliente manda: ' +
        'el contrato saldría describiendo el valor YA transformado.'
    );
  }
  if (out instanceof z.core.$ZodTransform) return jsonSchemaDeZod(input, where);
  throw new ZodNoTraducible(
    where,
    'es un `.pipe()` a otro esquema (o un codec): la entrada y lo que se valida después ' +
      'no son el mismo contrato, y el conversor no elige uno.'
  );
}

/**
 * The refinement a node carries, flagged as its LAST key.
 *
 * LO QUE NO SE PUEDE PUBLICAR, y por eso se marca: el predicado de un
 * refinamiento es una función de JavaScript. «company_name o first_name»,
 * «cargo o abono, no los dos» — nada de eso cabe en JSON Schema. Así que el
 * nodo lleva `x-validacion-adicional: true`, que no es la regla pero sí el
 * aviso de que existe una: un cliente que valide contra este esquema y crea
 * que ya pasó, se llevará un 422.
 *
 * In zod 4 a refinement is a `custom` check on the node itself. The one
 * refinement that DOES fit in JSON Schema is the array cap of topes.ts,
 * published whole as `maxItems` by `deArreglo` and never flagged.
 */
function withRefinementFlag(schema: z.core.$ZodType, node: EsquemaJson, where: string): EsquemaJson {
  const custom = (schema._zod.def.checks ?? []).filter((c) => c._zod.def.check === 'custom').length;
  const cap = cotaDeArreglo(schema);
  if (cap !== undefined && node.type !== 'array') {
    throw new ZodNoTraducible(where, 'lleva una cota de arreglo (topes.ts) sobre algo que no es un arreglo.');
  }
  const refinements = custom - (cap === undefined ? 0 : 1);
  return refinements > 0 ? { ...node, 'x-validacion-adicional': true } : node;
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
    const tipos: unknown[] = nodo.type;
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
    const ramas: unknown[] = nodo.anyOf;
    return { anyOf: [...ramas, { type: 'null' }] };
  }
  return { anyOf: [nodo, { type: 'null' }] };
}

/** zod 3's method name for a zod 4 check, so a refusal names what the author wrote. */
const V3_CHECK_NAMES: Readonly<Record<string, string>> = {
  starts_with: 'startsWith',
  ends_with: 'endsWith',
  lowercase: 'toLowerCase',
  uppercase: 'toUpperCase',
  ipv4: 'ip',
  ipv6: 'ip',
  cidrv4: 'cidr',
  cidrv6: 'cidr',
};

function checkName(check: z.core.$ZodCheck): string {
  const def = check._zod.def;
  const name = 'format' in def && typeof def.format === 'string' ? def.format : def.check;
  return V3_CHECK_NAMES[name] ?? name;
}

function deCadena(esquema: z.core.$ZodString, donde: string): EsquemaJson {
  const nodo: EsquemaJson = { type: 'string' };
  for (const check of esquema._zod.def.checks ?? []) {
    // The compat checks of src/utils/zod-compat.ts subclass these three, so
    // they are read as the built-ins they replace.
    if (check instanceof z.core.$ZodCheckMinLength) {
      nodo.minLength = check._zod.def.minimum;
    } else if (check instanceof z.core.$ZodCheckMaxLength) {
      nodo.maxLength = check._zod.def.maximum;
    } else if (check instanceof z.core.$ZodCheckLengthEquals) {
      nodo.minLength = check._zod.def.length;
      nodo.maxLength = check._zod.def.length;
    } else if (check instanceof z.core.$ZodCheckStringFormat) {
      applyStringFormat(nodo, check, donde);
    } else if (check._zod.def.check !== 'custom') {
      throw new ZodNoTraducible(donde, `la comprobación de cadena "${checkName(check)}" no está traducida.`);
    }
  }
  return nodo;
}

function applyStringFormat(node: EsquemaJson, check: z.core.$ZodCheckStringFormat, where: string): void {
  const def = check._zod.def;
  switch (def.format) {
    case 'uuid':
    case 'guid':
      // `guid` is zod 3's uuid grammar (src/utils/zod-compat.ts), and the
      // published format has always been `uuid`.
      node.format = 'uuid';
      return;
    case 'email':
      // The pattern zod-compat.ts pins is zod 3's, and it is not published:
      // `format: email` is what the contract has always said.
      node.format = 'email';
      return;
    case 'url':
      if (check instanceof z.core.$ZodURL) {
        const { hostname, protocol, normalize } = check._zod.def;
        if (hostname !== undefined || protocol !== undefined || normalize !== undefined) {
          throw new ZodNoTraducible(where, 'la comprobación de cadena "url" con opciones no está traducida.');
        }
      }
      // JSON Schema no tiene «url»: tiene «uri», que es lo que
      // `z.string().url()` acepta (necesita esquema, no sólo autoridad).
      node.format = 'uri';
      return;
    case 'regex': {
      const pattern = def.pattern;
      if (pattern === undefined) {
        throw new ZodNoTraducible(where, 'la comprobación de cadena "regex" no trae su expresión.');
      }
      // `pattern` de JSON Schema NO lleva banderas, así que una expresión
      // con `i` o `m` se publicaría más estricta —o más laxa— de lo que la
      // API aplica. Ninguna de las 19 de hoy las usa; si alguna las
      // estrena, se entera aquí y no en producción.
      if (pattern.flags !== '') {
        throw new ZodNoTraducible(
          where,
          `la expresión regular /${pattern.source}/${pattern.flags} lleva banderas y ` +
            '`pattern` de JSON Schema no las admite: el contrato publicaría otra regla ' +
            'que la que la API aplica.'
        );
      }
      node.pattern = pattern.source;
      return;
    }
    default:
      throw new ZodNoTraducible(where, `la comprobación de cadena "${checkName(check)}" no está traducida.`);
  }
}

function deNumero(esquema: z.core.$ZodNumber, donde: string): EsquemaJson {
  const checks = esquema._zod.def.checks ?? [];
  // `.int()` is computed first so that `type` stays the node's first key.
  const integer = checks.some((c) => c instanceof z.core.$ZodCheckNumberFormat && c._zod.def.format === 'safeint');
  const nodo: EsquemaJson = { type: integer ? 'integer' : 'number' };
  for (const check of checks) {
    if (check instanceof z.core.$ZodCheckNumberFormat) {
      if (check._zod.def.format !== 'safeint') {
        throw new ZodNoTraducible(donde, `la comprobación numérica "${check._zod.def.format ?? 'number_format'}" no está traducida.`);
      }
    } else if (check instanceof z.core.$ZodCheckGreaterThan) {
      // `.positive()` es min 0 NO inclusivo y `.nonnegative()` es min 0
      // inclusivo: la diferencia es justo la que un cliente necesita.
      if (check._zod.def.inclusive) nodo.minimum = check._zod.def.value;
      else nodo.exclusiveMinimum = check._zod.def.value;
    } else if (check instanceof z.core.$ZodCheckLessThan) {
      if (check._zod.def.inclusive) nodo.maximum = check._zod.def.value;
      else nodo.exclusiveMaximum = check._zod.def.value;
    } else if (check instanceof z.core.$ZodCheckMultipleOf) {
      nodo.multipleOf = check._zod.def.value;
    } else if (check._zod.def.check !== 'custom') {
      throw new ZodNoTraducible(donde, `la comprobación numérica "${checkName(check)}" no está traducida.`);
    }
  }
  return nodo;
}

function deArreglo(esquema: z.core.$ZodArray, donde: string): EsquemaJson {
  const nodo: EsquemaJson = {
    type: 'array',
    items: jsonSchemaDeZod(esquema._zod.def.element, `${donde}[]`),
  };
  const checks = esquema._zod.def.checks ?? [];
  // Zod 3 kept one exact length, one minimum and one maximum, and the last
  // two overrode the first; they are read in that order, and published in
  // the fixed order minItems then maxItems.
  let minItems: number | undefined;
  let maxItems: number | undefined;
  for (const check of checks) {
    if (check instanceof z.core.$ZodCheckLengthEquals) {
      minItems = check._zod.def.length;
      maxItems = check._zod.def.length;
    }
  }
  for (const check of checks) {
    if (check instanceof z.core.$ZodCheckMinLength) minItems = check._zod.def.minimum;
    else if (check instanceof z.core.$ZodCheckMaxLength) maxItems = check._zod.def.maximum;
    else if (!(check instanceof z.core.$ZodCheckLengthEquals) && check._zod.def.check !== 'custom') {
      throw new ZodNoTraducible(donde, `la comprobación de arreglo "${checkName(check)}" no está traducida.`);
    }
  }
  if (minItems !== undefined) nodo.minItems = minItems;
  if (maxItems !== undefined) nodo.maxItems = maxItems;
  // El caso en que el refinamiento SÍ cabe entero en JSON Schema: el tope
  // de arreglo de topes.ts, cuya comprobación no mira más que la longitud y
  // que deja el número a la vista justo para esto. Traducirlo como
  // `maxItems` es publicar la regla completa, no avisar de que hay una.
  const tope = cotaDeArreglo(esquema);
  if (tope !== undefined) nodo.maxItems = tope;
  return nodo;
}

function deObjeto(esquema: z.core.$ZodObject, donde: string): EsquemaJson {
  const propiedades: EsquemaJson = {};
  const obligatorias: string[] = [];
  for (const [clave, valor] of Object.entries(esquema._zod.def.shape)) {
    if (valor instanceof z.core.$ZodUnknown || valor instanceof z.core.$ZodAny) {
      // NOTE(#367): a bare `z.unknown()`/`z.any()` property may be absent on
      // zod 3 and is required on zod 4. Wrap it in `.optional()` (or make it
      // a record) so the contract states one rule.
      throw new ZodNoTraducible(
        `${donde}.${clave}`,
        'is a bare `z.unknown()` or `z.any()` property: zod 3 lets it be absent and zod 4 ' +
          'requires it, so `required` would be true on only one of them. Add `.optional()`.'
      );
    }
    propiedades[clave] = jsonSchemaDeZod(valor, `${donde}.${clave}`);
    // `.optional()` y `.default()` son las dos formas de «puede no venir»:
    // la segunda también lo es, porque Zod rellena el hueco.
    const puedeFaltar = valor instanceof z.core.$ZodOptional || valor instanceof z.core.$ZodDefault;
    if (!puedeFaltar) obligatorias.push(clave);
  }

  const nodo: EsquemaJson = { type: 'object', properties: propiedades };
  if (obligatorias.length > 0) nodo.required = obligatorias;

  // LAS TRES POLÍTICAS DE CLAVES DESCONOCIDAS, SIN APLANARLAS.
  //
  // JSON Schema sólo sabe decir «validan» o «no validan», y Zod tiene tres
  // conductas: `strict` RECHAZA, `passthrough` CONSERVA y `strip`
  // —el defecto, y 41 de los 54 objetos de esta API— DESCARTA EN SILENCIO.
  // Las dos últimas validan igual, así que `additionalProperties: true` es
  // la verdad sobre si la petición pasa; lo que pasa DESPUÉS con esas
  // claves va en una extensión, porque es justo lo que separa «me lo
  // guardas» de «te lo tiro» y ningún cliente puede adivinarlo.
  //
  // In zod 4 the policy IS the catchall: none is strip, `z.never()` is
  // strict and `z.unknown()` is passthrough (`.loose()`). Zod 3's rule
  // ("a never catchall means open") would invert strict here.
  const catchall = esquema._zod.def.catchall;
  if (catchall === undefined) {
    nodo.additionalProperties = true;
    nodo['x-claves-desconocidas'] = 'descartadas';
  } else if (catchall instanceof z.core.$ZodNever) {
    nodo.additionalProperties = false;
  } else if (catchall instanceof z.core.$ZodUnknown) {
    nodo.additionalProperties = true;
    nodo['x-claves-desconocidas'] = 'conservadas';
  } else {
    throw new ZodNoTraducible(`${donde}.*`, `el catchall "${nombreDe(catchall)}" no está traducido.`);
  }
  return nodo;
}

function fromEnum(schema: z.core.$ZodEnum, where: string): EsquemaJson {
  // Zod 4 builds `z.nativeEnum` (and `z.enum` of an object) as the same
  // class as `z.enum([...])`. Only the list form, where every key is its own
  // string value, is what the contract has always published.
  const values: string[] = [];
  for (const [key, value] of Object.entries(schema._zod.def.entries)) {
    if (typeof value !== 'string' || key !== value) {
      throw new ZodNoTraducible(
        where,
        'el constructor de Zod "enum" con llaves distintas de sus valores (un `z.nativeEnum`) no está traducido.'
      );
    }
    values.push(value);
  }
  return { type: 'string', enum: values };
}

function deUnion(esquema: z.core.$ZodUnion, donde: string): EsquemaJson {
  // `anyOf` y no `oneOf`: Zod prueba las opciones en orden y se queda con
  // la primera que valida, sin exigir que las demás fallen. `oneOf` diría
  // que un valor que encaje en dos es inválido, que no es lo que la API
  // hace — y `z.union([z.string(), z.number()])` de los importes es
  // exactamente donde eso se notaría.
  return {
    anyOf: esquema._zod.def.options.map((o, i) => jsonSchemaDeZod(o, `${donde}|${i}`)),
  };
}

function deDiccionario(esquema: z.core.$ZodRecord, donde: string): EsquemaJson {
  const def = esquema._zod.def;
  if (def.mode === 'loose' || def.partial === true) {
    throw new ZodNoTraducible(donde, 'un diccionario parcial o `loose` no está traducido.');
  }
  const clave = def.keyType;
  // NOTE(#367): an enum-keyed record is partial on zod 3 and exhaustive on
  // zod 4 (every enum value becomes a required key), so it is refused along
  // with any other key type.
  if (!(clave instanceof z.core.$ZodString)) {
    throw new ZodNoTraducible(
      donde,
      `las llaves del diccionario son "${nombreDe(clave)}" y sólo se traducen llaves de cadena.`
    );
  }
  const nodo: EsquemaJson = {
    type: 'object',
    additionalProperties: jsonSchemaDeZod(def.valueType, `${donde}.*`),
  };
  // `z.record(z.string(), x)` no restringe nada con su llave: sólo se
  // publica `propertyNames` cuando la llave sí exige algo.
  const restricciones = jsonSchemaDeZod(clave, `${donde}.<clave>`);
  if (Object.keys(restricciones).length > 1) nodo.propertyNames = restricciones;
  return nodo;
}
