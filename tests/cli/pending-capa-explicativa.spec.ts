import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Command } from 'commander';

// ============================================================
// LA CAPA EXPLICATIVA EN EL SITIO DONDE EL CONTADOR VIVE
//
// El catálogo declara tres campos que explican una decisión de política
// —`whyAsking` (por qué te pregunto), `whatIDo` (qué hago con tu
// respuesta) e `ifSkipped` (qué te cuesta saltarla)— y `previewFor`
// contesta la misma pregunta contra los datos del propio cliente. Todo
// eso se gastaba en `init`: el día uno, cuando `xml_documents` está
// vacía y el preview degrada a silencio POR DISEÑO.
//
// `mnemosine pending -v` es la superficie del resto de la relación, y
// hasta hoy imprimía `impact`, `default_rationale` y las opciones:
// nunca los tres campos, nunca el preview.
//
// Lo que se ancla aquí:
//   (a) los tres campos salen en verbose y NO en el listado normal;
//   (b) el preview se PIDE con el contexto de la entidad y, cuando
//       vuelve vacío, no se imprime ni una línea — ni encabezado ni
//       marcador de posición;
//   (c) cuando trae datos, se imprimen bajo su encabezado;
//   (d) el PREVIEW VA CON SU POLÍTICA: con varias filas en pantalla,
//       el de cada clave se imprime bajo SU pregunta y no bajo otra;
//   (e) el corte de línea existe y se ve: ancho máximo y sangría
//       colgante, medidos sobre las líneas SIN aplanar;
//   (f) el código de salida lo dicta el error: una clave que no existe
//       sale 3 (NOT_FOUND), no 1.
// ============================================================

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));
vi.mock('../../src/ai/pending-service.js', () => ({
  getPendingBoard: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({
  resolveEntity: vi.fn(),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(),
}));
vi.mock('../../src/services/policy/policy-service.js', () => ({
  seedPolicies: vi.fn(),
  listPolicies: vi.fn(),
  listPending: vi.fn(),
  resolvePolicy: vi.fn(),
  dismissPolicy: vi.fn(),
  reopenPolicy: vi.fn(),
}));
vi.mock('../../src/services/policy/policy-preview.js', () => ({
  previewFor: vi.fn(),
}));

import {
  renderPolicies,
  renderAll,
  registerPendingCommands,
} from '../../src/cli/pending-command.js';
import { getPendingBoard } from '../../src/ai/pending-service.js';
import {
  seedPolicies,
  listPending,
  resolvePolicy,
} from '../../src/services/policy/policy-service.js';
import { previewFor } from '../../src/services/policy/policy-preview.js';
import { getPolicySpec } from '../../src/services/policy/pending-catalog.js';
import { resolveEntity, type AgentContext } from '../../src/ai/context.js';
import { resolveReviewer } from '../../src/ai/draft-service.js';

const mockBoard = getPendingBoard as unknown as Mock;
const mockSeed = seedPolicies as unknown as Mock;
const mockListPending = listPending as unknown as Mock;
const mockPreview = previewFor as unknown as Mock;
const mockResolveEntity = resolveEntity as unknown as Mock;
const mockResolveReviewer = resolveReviewer as unknown as Mock;
const mockResolvePolicy = resolvePolicy as unknown as Mock;

/** Paleta plana: el aserto mira el texto, no los códigos ANSI. */
const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

const CTX: AgentContext = {
  entityId: 'ent-1',
  entityName: 'Acme MX',
  tenantId: 'ten-1',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AAA010101AAA',
};

/**
 * La clave se toma del catálogo real y no de un doble: si alguien le
 * quita los tres campos explicativos a `umbral_capitalizacion_mxn`, esta
 * prueba debe enterarse, no seguir verde sobre un espécimen inventado.
 */
const KEY = 'umbral_capitalizacion_mxn';
const SPEC = getPolicySpec(KEY)!;

/**
 * Y una SEGUNDA clave, también del catálogo real. No es adorno: con una
 * sola fila en pantalla, `previews[p.key]` y «el primer preview que haya»
 * son indistinguibles, y el catálogo trae 21 políticas de las que 7 tienen
 * preview propio. Enseñar «de tus 12 facturas recibidas…» debajo de la
 * pregunta de restaurantes es el dato equivocado bajo la pregunta
 * equivocada: exactamente lo que esta capa existe para evitar.
 */
const KEY2 = 'politica_restaurantes';
const SPEC2 = getPolicySpec(KEY2)!;

/**
 * Y la tercera: el espécimen MÁS LARGO del catálogo, que es el que un
 * contrato de ancho tiene que medir. Pregunta de 79 caracteres, etiqueta de
 * opción de 97 y el `whyAsking` de cuatrocientos que cita el comentario de
 * `field()`. Un ancho probado con la fila más corta no es un ancho probado.
 */
const KEY3 = 'catalogo_entidad_no_mexicana';
const SPEC3 = getPolicySpec(KEY3)!;

/** Una fila como llega de la base: con el texto que tenía al sembrarse. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    key: KEY,
    category: 'contable',
    question: '¿A partir de qué monto se capitaliza?',
    impact: 'IMPACTO GUARDADO EN LA BASE',
    options: [{ value: '20000', label: '$20,000' }],
    default_value: '20000',
    default_rationale: 'RAZÓN DEL DEFECTO',
    status: 'pending',
    resolved_value: null,
    resolved_by: null,
    resolved_at: null,
    resolution_notes: null,
    priority: 10,
    entity_id: null,
    ...overrides,
  } as never;
}

/**
 * El renderizador envuelve la prosa larga con sangría colgante, así que
 * un campo del catálogo NO aparece contiguo en ninguna línea suelta.
 * Se compara sobre el texto con espacios colapsados, que es exactamente
 * lo que el contador lee.
 *
 * CUIDADO: `flat` colapsa TODO el espacio en blanco a propósito, y por
 * eso es ciego al corte de línea y a la sangría. Ningún aserto escrito
 * sobre `flat` puede ver que `WRAP_WIDTH` desapareció. Para eso está el
 * bloque «el corte de línea es conducta», que mira `lines` en crudo.
 */
const flat = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Una salida de `console.log` puede traer varios renglones en un string. */
const renglones = (salida: string[]) => salida.flatMap((l) => l.split('\n'));

/**
 * El bloque de un campo etiquetado: su primera línea y las continuaciones
 * que cuelgan de ella. Una continuación es una línea que empieza con
 * EXACTAMENTE la sangría del encabezado y sigue con texto.
 */
function bloque(lines: string[], label: string): string[] {
  const i = lines.findIndex((l) => l.trimStart().startsWith(`${label}: `));
  expect(i, `no se imprimió el campo «${label}»`).toBeGreaterThanOrEqual(0);
  const hang = ' '.repeat(lines[i].indexOf(`${label}: `) + label.length + 2);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].startsWith(hang) || lines[j][hang.length] === ' ') break;
    out.push(lines[j]);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSeed.mockResolvedValue({ inserted: 0 });
  mockBoard.mockResolvedValue({ items: [], totalWork: 0 });
  mockListPending.mockResolvedValue([row()]);
  mockPreview.mockResolvedValue([]);
  mockResolveEntity.mockResolvedValue(CTX);
  mockResolveReviewer.mockResolvedValue({ email: 'admin@demo.com' });
  mockResolvePolicy.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('el catálogo declara la explicación y `pending -v` la usa', () => {
  it('los tres campos existen en el catálogo (si no, no hay nada que imprimir)', () => {
    expect(SPEC.whyAsking, 'whyAsking').toBeTruthy();
    expect(SPEC.whatIDo, 'whatIDo').toBeTruthy();
    expect(SPEC.ifSkipped, 'ifSkipped').toBeTruthy();
  });

  it('verbose imprime whyAsking, whatIDo e ifSkipped', () => {
    const texto = flat(renderPolicies([row()], plain, { verbose: true }));

    expect(texto).toContain('why I ask');
    expect(texto).toContain(norm(SPEC.whyAsking!));

    expect(texto).toContain('what I do');
    expect(texto).toContain(norm(SPEC.whatIDo!));

    expect(texto).toContain('if you skip it');
    expect(texto).toContain(norm(SPEC.ifSkipped!));
  });

  it('el listado normal NO los imprime: la lista corta sigue siendo corta', () => {
    const texto = flat(renderPolicies([row()], plain, {}));

    expect(texto).not.toContain(norm(SPEC.whyAsking!));
    expect(texto).not.toContain(norm(SPEC.whatIDo!));
    expect(texto).not.toContain(norm(SPEC.ifSkipped!));
    expect(texto).not.toContain('why I ask');
    expect(texto).not.toContain('what I do');
    expect(texto).not.toContain('if you skip it');
    // Y lo que sí es de la lista corta sigue estando.
    expect(texto).toContain(KEY);
    expect(texto).toContain('¿A partir de qué monto se capitaliza?');
  });

  it('la explicación sale del CATÁLOGO, no del texto congelado en la base', () => {
    // La fila trae un `impact` viejo y ningún campo explicativo: si el
    // renderizador leyera sólo la fila, no habría explicación que dar.
    const texto = flat(renderPolicies([row()], plain, { verbose: true }));
    expect(texto).toContain(norm(SPEC.whyAsking!));
    expect(texto).toContain('IMPACTO GUARDADO EN LA BASE');
  });
});

// ============================================================
// EL CORTE DE LÍNEA ES CONDUCTA, NO ADORNO
//
// `flat` colapsa el espacio en blanco a propósito, y por eso es CIEGO al
// ancho de columna. Medido en este mismo archivo: poniendo `WRAP_WIDTH` a
// 100000, el verbose de una política pasa de 15 líneas de 88 caracteres
// como mucho a 8 líneas de hasta 259 — y las diez pruebas anteriores
// seguían verdes. Un ancho que nadie mira es un ancho que cualquiera borra.
//
// El contrato que se ancla aquí, sobre las líneas EN CRUDO:
//   · ninguna línea se pasa de la columna;
//   · la columna se USA (si el corte fuera a 20, esto también cae);
//   · las continuaciones cuelgan bajo su etiqueta, que es lo que dice
//     «esto sigue perteneciendo a ese campo».
// ============================================================

/**
 * Tope de ancho, escrito a mano y NO derivado de `WRAP_WIDTH`: si la
 * prueba importara la constante, moverla movería también la expectativa y
 * el mutante sobreviviría. Se deriva del contrato: 3 de sangría + la
 * etiqueta más larga que imprime este render (`why that default: `, 18) +
 * 72 de columna = 93.
 */
const ANCHO_MAXIMO = 93;
/** Y el suelo: por debajo de esto la columna no se está usando. */
const ANCHO_MINIMO_ESPERADO = 70;

describe('el corte de línea es conducta, no adorno', () => {
  /**
   * La fila lleva el texto REAL del catálogo, entero: pregunta, `impact` y
   * opciones. La primera versión de esta prueba usaba la pregunta corta
   * inventada de `row()` y por eso no vio que 13 de 21 preguntas del
   * catálogo se salen de la columna, ni que 19 de 55 etiquetas de opción
   * también. Medir el ancho con el ejemplar más corto es no medirlo.
   */
  const filaLarga = () =>
    row({
      key: KEY3,
      category: 'contable',
      question: SPEC3.question,
      impact: SPEC3.impact,
      options: SPEC3.options,
      default_rationale: SPEC3.defaultRationale,
    });

  it('ninguna línea del verbose se pasa de la columna', () => {
    const lineas = renderPolicies([filaLarga()], plain, { verbose: true });
    const anchos = lineas.map((l) => l.length);
    const masAncha = lineas[anchos.indexOf(Math.max(...anchos))];

    expect(Math.max(...anchos), `se desbordó: ${JSON.stringify(masAncha)}`).toBeLessThanOrEqual(
      ANCHO_MAXIMO
    );
    // Y la columna se usa de verdad: un WRAP_WIDTH ridículo no pasa por aquí.
    expect(Math.max(...anchos)).toBeGreaterThanOrEqual(ANCHO_MINIMO_ESPERADO);
  });

  it('los campos largos se parten en varias líneas con sangría colgante', () => {
    const lineas = renderPolicies([filaLarga()], plain, { verbose: true });

    for (const etiqueta of ['impact', 'why I ask', 'what I do', 'if you skip it', 'why that default']) {
      const b = bloque(lineas, etiqueta);
      expect(b.length, `«${etiqueta}» debería envolverse en más de una línea`).toBeGreaterThan(1);

      const hang = ' '.repeat(b[0].indexOf(`${etiqueta}: `) + etiqueta.length + 2);
      for (const cont of b.slice(1)) {
        expect(cont.startsWith(hang), `continuación sin colgar: ${JSON.stringify(cont)}`).toBe(true);
        expect(cont[hang.length], `sangría de más en: ${JSON.stringify(cont)}`).not.toBe(' ');
      }
    }
  });

  it('el texto envuelto es el mismo texto, sin perder ni duplicar palabras', () => {
    const lineas = renderPolicies([filaLarga()], plain, { verbose: true });
    // El corte no puede comerse una palabra: `flat` sirve para esto y sólo
    // para esto — leer la prosa, una vez que otro aserto vigila el corte.
    expect(flat(bloque(lineas, 'why I ask'))).toBe(`why I ask: ${norm(SPEC3.whyAsking!)}`);
    expect(flat(bloque(lineas, 'impact'))).toBe(`impact: ${norm(SPEC3.impact)}`);
  });

  /**
   * Las dos líneas que el contador lee para DECIDIR —la pregunta y las
   * etiquetas de opción— no llevan etiqueta de campo, y por eso se les pasó
   * el corte mientras `impact` sí lo tenía. Son las que más importan.
   */
  it('la pregunta se corta, con sus continuaciones a la misma sangría', () => {
    const lineas = renderPolicies([filaLarga()], plain, { verbose: true });
    const cab = lineas.findIndex((l) => l.includes(KEY3));
    const iImpact = lineas.findIndex((l) => l.startsWith('   impact: '));
    expect(cab).toBeGreaterThanOrEqual(0);
    expect(iImpact).toBeGreaterThan(cab);

    const pregunta = lineas.slice(cab + 1, iImpact);
    expect(pregunta.length, 'una pregunta de 79 caracteres debería envolverse').toBeGreaterThan(1);
    for (const l of pregunta) {
      expect(l.startsWith('   '), `sangría perdida: ${JSON.stringify(l)}`).toBe(true);
      expect(l[3]).not.toBe(' ');
    }
    expect(flat(pregunta)).toBe(norm(SPEC3.question));
  });

  it('las etiquetas de opción se cortan y cuelgan bajo el bullet', () => {
    const lineas = renderPolicies([filaLarga()], plain, { verbose: true });
    const iOpt = lineas.findIndex((l) => l.startsWith('     · '));
    expect(iOpt, 'no se imprimieron las opciones').toBeGreaterThanOrEqual(0);

    const opciones = lineas.slice(iOpt);
    expect(
      opciones.length,
      'una etiqueta de 97 caracteres debería ocupar más de un renglón'
    ).toBeGreaterThan(SPEC3.options.length);

    for (const l of opciones) {
      const esCabeza = l.startsWith('     · ');
      const esCuelgue = l.startsWith('       ') && l[7] !== ' ';
      expect(esCabeza || esCuelgue, `renglón de opción suelto: ${JSON.stringify(l)}`).toBe(true);
    }
    // Y ninguna etiqueta se perdió por el camino.
    const texto = flat(opciones);
    for (const o of SPEC3.options) {
      expect(texto).toContain(norm(`${o.value} — ${o.label}`));
    }
  });
});

describe('la vista previa contra los datos del cliente', () => {
  it('se pide con el contexto de la entidad', async () => {
    await renderAll(CTX, plain, { verbose: true });

    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview).toHaveBeenCalledWith(KEY, {
      entityId: 'ent-1',
      tenantId: 'ten-1',
      currency: 'MXN',
    });
  });

  it('cuando vuelve vacía NO se imprime línea alguna: silencio, no marcador', async () => {
    mockPreview.mockResolvedValue([]);
    const lineas = await renderAll(CTX, plain, { verbose: true });
    const texto = flat(lineas);

    expect(texto).not.toContain('in your data');
    // Ni un encabezado huérfano, ni un guion, ni un "(sin datos)".
    expect(lineas.some((l) => /sin datos|no data|—\s*$|\(none\)/i.test(l))).toBe(false);
    // Y la explicación sí llegó: el silencio es del preview, no del render.
    expect(texto).toContain(norm(SPEC.whyAsking!));
  });

  it('cuando trae datos se imprimen bajo su encabezado', async () => {
    mockPreview.mockResolvedValue([
      'Of your 12 received invoices:',
      '  · with $20,000 MXN → I would ask you 3 times (25%)',
    ]);
    const texto = flat(await renderAll(CTX, plain, { verbose: true }));

    expect(texto).toContain('in your data:');
    expect(texto).toContain('Of your 12 received invoices:');
    expect(texto).toContain('I would ask you 3 times (25%)');
  });

  it('el listado normal no gasta una consulta por política', async () => {
    await renderAll(CTX, plain, {});
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('cada preview se imprime bajo SU política, no bajo la primera', async () => {
    const fila2 = row({
      id: 'p2',
      key: KEY2,
      category: 'fiscal',
      question: SPEC2.question,
      impact: SPEC2.impact,
      options: [{ value: 'no_deducible', label: 'Todo a no deducible' }],
      default_value: 'split_85',
    });
    mockListPending.mockResolvedValue([row(), fila2]);
    mockPreview.mockImplementation(async (clave: string) =>
      clave === KEY ? ['De tus 12 facturas recibidas:'] : ['De tus 4 consumos en restaurante:']
    );

    const lineas = await renderAll(CTX, plain, { verbose: true });
    const donde = (aguja: string) => lineas.findIndex((l) => l.includes(aguja));

    // Se preguntó por AMBAS, cada una con su clave.
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(mockPreview).toHaveBeenCalledWith(KEY, expect.anything());
    expect(mockPreview).toHaveBeenCalledWith(KEY2, expect.anything());

    const cab1 = donde(KEY);
    const cab2 = donde(KEY2);
    expect(cab1).toBeGreaterThanOrEqual(0);
    expect(cab2).toBeGreaterThan(cab1);

    // Y cada preview cae DENTRO del bloque de su propia política.
    const prev1 = donde('De tus 12 facturas recibidas:');
    const prev2 = donde('De tus 4 consumos en restaurante:');
    expect(prev1, 'el preview del umbral debe salir bajo el umbral').toBeGreaterThan(cab1);
    expect(prev1, 'el preview del umbral no debe invadir restaurantes').toBeLessThan(cab2);
    expect(prev2, 'el preview de restaurantes debe salir bajo restaurantes').toBeGreaterThan(cab2);
  });
});

// ============================================================
// LA MISMA CLASE, UN NIVEL MÁS ABAJO
//
// `pending define <key>` sin valor abre el prompt interactivo: ése es el
// instante EXACTO de la decisión, y también enseñaba sólo `impact` y las
// opciones. Arreglar `renderPolicies` y dejar el prompt como estaba sería
// reparar la instancia y no la clase.
// ============================================================
describe('el prompt interactivo de `pending define` explica antes de preguntar', () => {
  /** Monta el comando real y lo corre; `shutdown` desenrolla la acción. */
  async function correrDefine(
    preview: string[],
    filas?: unknown[],
    clave: string = KEY
  ): Promise<string[]> {
    mockPreview.mockResolvedValue(preview);
    if (filas) mockListPending.mockResolvedValue(filas);
    const salida: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      salida.push(args.map(String).join(' '));
    });

    const program = new Command();
    program.exitOverride();
    class Detener extends Error {}
    registerPendingCommands(program, {
      color: plain,
      colorErr: { dim: (s: string) => s, red: (s: string) => s },
      shutdown: () => {
        throw new Detener();
      },
      reportError: (err: unknown) => {
        throw err;
      },
      // Enter = conservar el defecto; la acción termina en shutdown(0).
      ask: async () => '',
    });

    try {
      await program.parseAsync(['pending', 'define', clave], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Detener)) throw err;
    }
    return salida;
  }

  it('imprime los tres campos y pide el preview con el contexto de la entidad', async () => {
    const salida = await correrDefine([]);

    expect(mockPreview).toHaveBeenCalledWith(KEY, {
      entityId: 'ent-1',
      tenantId: 'ten-1',
      currency: 'MXN',
    });

    const texto = flat(salida);
    expect(texto).toContain(norm(SPEC.whyAsking!));
    expect(texto).toContain(norm(SPEC.whatIDo!));
    expect(texto).toContain(norm(SPEC.ifSkipped!));
    // Preview vacío: ni encabezado ni marcador de posición.
    expect(texto).not.toContain('in your data');
  });

  it('con datos, el preview se imprime junto a la pregunta', async () => {
    const texto = flat(await correrDefine(['Of your 12 received invoices:']));
    expect(texto).toContain('in your data:');
    expect(texto).toContain('Of your 12 received invoices:');
  });

  /**
   * La otra mitad de la clase. `renderPolicies` envolvía `impact` y este
   * prompt lo escupía crudo con un `console.log` — y el comentario de
   * `field()` afirmaba que cubría «EVERY long field». Medido sobre el
   * catálogo: las 21 políticas tienen un `impact` de más de 72 caracteres,
   * la más larga de 406. No era un caso raro: era siempre.
   */
  /** El peor caso del catálogo, en el instante exacto de la decisión. */
  const filaLarga = () =>
    row({
      key: KEY3,
      question: SPEC3.question,
      impact: SPEC3.impact,
      options: SPEC3.options,
    });

  it('el prompt de `define` también envuelve `impact`', async () => {
    const salida = renglones(await correrDefine([], [filaLarga()], KEY3));

    const anchos = salida.map((l) => l.length);
    const masAncha = salida[anchos.indexOf(Math.max(...anchos))];
    expect(Math.max(...anchos), `se desbordó: ${JSON.stringify(masAncha)}`).toBeLessThanOrEqual(
      ANCHO_MAXIMO
    );

    const b = bloque(salida, 'impact');
    expect(b.length, '`impact` debería envolverse también aquí').toBeGreaterThan(1);
    const hang = ' '.repeat(b[0].indexOf('impact: ') + 'impact'.length + 2);
    for (const cont of b.slice(1)) {
      expect(cont.startsWith(hang), `continuación sin colgar: ${JSON.stringify(cont)}`).toBe(true);
    }
    // Y sigue siendo el mismo texto, entero.
    expect(flat(b)).toBe(`impact: ${norm(SPEC3.impact)}`);
  });

  it('y la pregunta y las opciones del prompt, que es lo que se lee para decidir', async () => {
    const salida = renglones(await correrDefine([], [filaLarga()], KEY3));

    // La pregunta abre la pantalla: sus renglones van antes de `impact:`.
    const iImpact = salida.findIndex((l) => l.startsWith('impact: '));
    expect(iImpact).toBeGreaterThan(0);
    const pregunta = salida.slice(0, iImpact).filter((l) => l !== '');
    expect(pregunta.length, 'una pregunta de 79 caracteres debería envolverse').toBeGreaterThan(1);
    expect(flat(pregunta)).toBe(norm(SPEC3.question));

    // Y las opciones numeradas cuelgan bajo su número.
    const iOpt = salida.findIndex((l) => /^ {2}1\) /.test(l));
    expect(iOpt, 'no se imprimieron las opciones').toBeGreaterThanOrEqual(0);
    // La lista termina en la línea de ayuda: lo que viene después (el aviso
    // de cancelación) no es una opción y no debe colarse en el aserto.
    const iFin = salida.findIndex((l) => l.startsWith('  (number'));
    expect(iFin).toBeGreaterThan(iOpt);
    const opciones = salida.slice(iOpt, iFin);
    expect(
      opciones.length,
      'una etiqueta de 97 caracteres debería ocupar más de un renglón'
    ).toBeGreaterThan(SPEC3.options.length);
    for (const l of opciones) {
      const esCabeza = /^ {2}\d+\) \S/.test(l);
      const esCuelgue = /^ {5,6}\S/.test(l);
      expect(esCabeza || esCuelgue, `renglón de opción suelto: ${JSON.stringify(l)}`).toBe(true);
    }
  });
});

// ============================================================
// EL CÓDIGO DE SALIDA LO DICTA EL ERROR
//
// `pending-command.ts` tenía cinco `await shutdown(1)` y ni un solo
// `exitCodeFor`. El más caro: «There is no pending decision with key X»
// salía 1 — un NOT_FOUND escrito a mano cuando el contrato del kernel dice
// 3. Un guion que distingue «no existe» de «se rompió» leía lo mismo en
// los dos casos.
//
// Los números están escritos a mano y no importados de `ExitCode`: si la
// prueba importara la tabla, moverla movería la expectativa.
// ============================================================
describe('el código de salida lo dicta el error, no el literal 1', () => {
  class Detener extends Error {}

  /** Corre el comando real y devuelve los códigos y errores observados. */
  async function correr(argv: string[]) {
    const codigos: number[] = [];
    const errores: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerPendingCommands(program, {
      color: plain,
      colorErr: { dim: (s: string) => s, red: (s: string) => s },
      shutdown: async (code: number) => {
        codigos.push(code);
        throw new Detener();
      },
      // El `shutdown` de verdad llama a `process.exit` y NO VUELVE. El doble
      // lo imita lanzando, y por eso su desenrollado tiene que atravesar el
      // `catch` del manejador: si `reportError` se lo tragara, el camino
      // feliz cerraría dos veces —0 y luego 1— y la prueba mediría el
      // artefacto del arnés en vez de la conducta.
      reportError: (err: unknown) => {
        if (err instanceof Detener) throw err;
        errores.push(err);
      },
      ask: async () => '',
    });

    try {
      await program.parseAsync(argv, { from: 'user' });
    } catch (err) {
      if (!(err instanceof Detener)) throw err;
    }
    return { codigos, errores };
  }

  it('una clave que no existe sale 3 (NOT_FOUND), no 1', async () => {
    const { codigos, errores } = await correr(['pending', 'define', 'clave-que-no-existe']);

    expect(codigos).toEqual([3]);
    const mensaje = errores[0] instanceof Error ? errores[0].message : String(errores[0]);
    expect(mensaje).toContain('There is no pending decision with key "clave-que-no-existe"');
    // El remedio viaja DENTRO del error: `reportError` ya lo imprime.
    expect(mensaje).toContain('mnemosine pending');
  });

  it('un 404 del servicio también sale 3: el mapeo no es un literal suelto', async () => {
    mockResolvePolicy.mockRejectedValue(
      Object.assign(new Error('policy vanished'), { statusCode: 404 })
    );
    const { codigos } = await correr(['pending', 'define', KEY, '20000']);
    expect(codigos).toEqual([3]);
  });

  it('un error cualquiera sigue saliendo 1: el cambio es seguro por construcción', async () => {
    mockResolveEntity.mockRejectedValue(new Error('boom'));
    const { codigos } = await correr(['pending']);
    expect(codigos).toEqual([1]);
  });

  it('el camino feliz sigue saliendo 0', async () => {
    const { codigos, errores } = await correr(['pending', 'define', KEY, '20000']);
    expect(errores).toEqual([]);
    expect(codigos).toEqual([0]);
  });
});
