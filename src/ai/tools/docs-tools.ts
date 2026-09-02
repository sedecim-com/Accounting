import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { ToolDeps } from './observer.js';

// ============================================================
// SYSTEM DOCS (progressive disclosure)
// The compact index lives in the system prompt (cached); the
// content is loaded on demand with read_docs — the agent can
// operate or guide ANY system module without inflating each
// session's context.
// The .md files live next to this code (src/ai/docs; the build
// copies them to dist/ai/docs).
// ============================================================

export const DOC_TOPICS = {
  accounting: 'journal entries (types/states/validations), fiscal periods, signs',
  receivables: 'customers, issued invoices (states, CFDI), collections, aging',
  payables: 'vendors, received invoices (bills), approvals, payments',
  banking: 'transaction import, matching and reconciliation',
  'mexico-cfdi': 'CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping, XML ingestion',
  payroll: 'Mexico payroll (ISR/IMSS/payroll CFDI/SUA) and USA (FICA/SUTA/W-2/941/NACHA)',
  reports: 'the 7 reports: which to use and how to interpret signs',
  mnemosine: 'your own flow: drafts/review, questions/precedents, ingestion, limits',
  playbooks: 'how to GUIDE each process: new company, migration, daily flow, month end — diagnose-first protocol',
  system: 'overview: multi-tenant, webhooks, integrations, blockchain, audit',
  'external-integrations': 'other accounting systems (Contalink): pull, trial balance diff, write outbox',
  'nif-marco': 'NIF serie A: los 8 postulados, definiciones de activo/pasivo/ingreso — el fundamento de todo registro',
  'nif-registro': 'NIF B/C/D aplicadas: cómo se registra cada operación (ingresos D-1, inventarios C-4, PPyE C-6, provisiones C-9, nómina D-3, moneda extranjera B-15)',
  'nif-validaciones': 'qué valida el sistema automáticamente, qué norma respalda cada regla, y qué exige criterio humano',
  'cli-reference': 'EXACT surface of the mnemosine binary (auto-generated): every command, flag and alias — quote verbatim; served in PARTS (part 1 maps them)',
  'identity-access': 'OIDC login, tenant isolation (RLS) symptoms and fixes, database roles, reviewer attribution, SAT credentials',
  connectivity: 'database hosting (presets/TLS/SSH tunnel), doctor, the 12 model providers and their config',
  'niif-indice': 'índice maestro NIIF/IFRS: toda norma vigente con su estado, vigencias 2025-2029, supletoriedad, y cómo actualizar el corpus',
  'niif-marco-presentacion': 'Marco Conceptual IASB, NIC 1→NIIF 18 (2027), NIIF 19, NIC 7/8/10/34, NIIF 8, NIC 24/33',
  'niif-activos': 'activos no financieros IFRS: NIC 2 inventarios, 16 PP&E, 23, 36 deterioro, 38 intangibles, 40, 41, NIIF 5/6',
  'niif-instrumentos-financieros': 'NIC 32, NIIF 7, NIIF 9 (clasificación SPPI, pérdidas esperadas, coberturas, enmiendas 2026), NIIF 13 valor razonable',
  'niif-ingresos-arrendamientos': 'NIIF 15 ingresos (5 pasos a detalle), NIIF 16 arrendamientos (derecho de uso, arrendador, sale-leaseback), NIC 20',
  'niif-pasivos-empleados-impuestos': 'NIC 37 provisiones, NIC 19 beneficios definidos, NIIF 2, NIC 12 impuestos diferidos + pilar 2, NIC 26',
  'niif-grupos': 'NIIF 3 combinaciones, NIIF 10/11/12 consolidación y acuerdos conjuntos, NIC 27/28 método de participación',
  'niif-moneda-seguros-adopcion': 'NIC 21 moneda extranjera (enmiendas 2025/2027), NIC 29 hiperinflación, NIIF 17 seguros, NIIF 1, NIIF 14→NIIF 20 (2029)',
  'niif-interpretaciones': 'las 20 interpretaciones CINIIF/SIC vigentes + decisiones de agenda (criptoactivos, SaaS, depósitos restringidos)',
  'niif-pymes-convergencia': 'NIIF para PyMEs 3a edición (2027) y mapa de convergencia NIF mexicanas ↔ IFRS con supletoriedad práctica',
} as const;

export type DocTopic = keyof typeof DOC_TOPICS;

const DOCS_DIR = path.join(__dirname, '..', 'docs');

// ============================================================
// PAGINACIÓN POR SECCIONES
//
// El resultado de toda herramienta se corta a MAX_TOOL_RESULT_CHARS
// (tools/index.ts). Cuatro docs pasan de ese tope, y cli-reference.md
// lo pasa por veintiocho veces: de sus 297.710 caracteres el agente
// recibía 32.000 — el 10,7 %, 40 de 283 encabezados — con el corte a
// media línea de encabezado («## `mnemosine approvals` (alias: ») y
// con la orden, en la cabecera del propio documento, de no inventar
// ninguna bandera que no aparezca ahí. Lo que no se le entrega, para
// él no existe, y no puede saber que le falta.
//
// Se pagina en vez de partir el archivo por familias porque `mnemosine
// bank` sola pesa 59.641 caracteres: partir por familia dejaría a la
// familia mayor igual de truncada, no arreglaría los tres docs niif-*
// que también pasan el tope, y metería 57 líneas nuevas en el índice
// del bloque CACHEADO del prompt, que se paga en cada sesión.
//
// El corte cae SIEMPRE en un encabezado fuera de cerca de código: una
// parte nunca empieza a media frase ni deja una cerca abierta. Y cada
// parte lleva el mapa completo de partes, para que el agente salte a la
// que le sirve en vez de recorrerlas todas.
// ============================================================

/**
 * Presupuesto de CONTENIDO por parte. Queda holgadamente por debajo de
 * MAX_TOOL_RESULT_CHARS (32.000) para que la cabecera de continuación quepa
 * sin que el tope de resultado vuelva a cortar lo que esta función acaba de
 * cortar bien; tests/ai/tools/docs-tools.spec.ts ancla esa relación.
 */
export const DOC_PART_MAX_CHARS = 20000;

interface Bloque {
  /** Encabezado que abre el bloque; null sólo en el preámbulo del archivo. */
  titulo: string | null;
  texto: string;
}

function etiquetaDeEncabezado(linea: string): string {
  return linea
    .replace(/^#{1,6}\s+/, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Parte el documento en bloques que empiezan en encabezado. Un `#` DENTRO de
 * una cerca de código es texto de ayuda del binario, no una sección: cortar
 * ahí dejaría la cerca abierta y el resto del documento se leería como código.
 */
function bloquesPorEncabezado(texto: string): Bloque[] {
  const bloques: Bloque[] = [];
  let actual: string[] = [];
  let titulo: string | null = null;
  let enCerca = false;

  for (const linea of texto.split('\n')) {
    const esCerca = linea.startsWith('```');
    if (!enCerca && !esCerca && /^#{1,6}\s/.test(linea)) {
      if (actual.length > 0) {
        bloques.push({ titulo, texto: actual.join('\n') });
        actual = [];
      }
      titulo = etiquetaDeEncabezado(linea);
    }
    if (esCerca) enCerca = !enCerca;
    actual.push(linea);
  }
  if (actual.length > 0) bloques.push({ titulo, texto: actual.join('\n') });
  return bloques;
}

/** Margen para las cercas que hay que cerrar y reabrir al partir un bloque. */
const MARGEN_CERCA = 16;

/**
 * Último recurso: una sección sola mayor que el presupuesto. Se parte por
 * líneas cerrando y reabriendo la cerca de código, de modo que ningún trozo
 * viaje con una cerca abierta.
 */
function partirBloqueGrande(texto: string, presupuesto: number): string[] {
  const trozos: string[] = [];
  let buf: string[] = [];
  let largo = 0;
  let enCerca = false;
  let veniaDeCerca = false;

  const cerrar = (): void => {
    if (buf.length === 0) return;
    trozos.push((veniaDeCerca ? '```\n' : '') + buf.join('\n') + (enCerca ? '\n```' : ''));
    veniaDeCerca = enCerca;
    buf = [];
    largo = 0;
  };

  for (const linea of texto.split('\n')) {
    if (largo + linea.length + 1 > presupuesto - MARGEN_CERCA && buf.length > 0) cerrar();
    buf.push(linea);
    largo += linea.length + 1;
    if (linea.startsWith('```')) enCerca = !enCerca;
  }
  cerrar();
  return trozos;
}

interface Parte {
  texto: string;
  desde: string;
  hasta: string;
}

/** Empaqueta bloques en partes sin superar el presupuesto de contenido. */
function empaquetar(bloques: Bloque[], presupuesto: number): Parte[] {
  const partes: Parte[] = [];
  let buf: string[] = [];
  let largo = 0;
  let desde = '';
  let hasta = '';

  const cerrar = (): void => {
    if (buf.length === 0) return;
    partes.push({ texto: buf.join('\n'), desde, hasta });
    buf = [];
    largo = 0;
    desde = '';
  };

  for (const bloque of bloques) {
    const titulo = bloque.titulo ?? '(preamble)';
    if (bloque.texto.length > presupuesto) {
      cerrar();
      const trozos = partirBloqueGrande(bloque.texto, presupuesto);
      trozos.forEach((trozo, i) => {
        const marca = trozos.length > 1 ? `${titulo} (${i + 1}/${trozos.length})` : titulo;
        partes.push({ texto: trozo, desde: marca, hasta: marca });
      });
      hasta = titulo;
      continue;
    }
    if (largo + bloque.texto.length + 1 > presupuesto && buf.length > 0) cerrar();
    if (desde === '') desde = titulo;
    hasta = titulo;
    buf.push(bloque.texto);
    largo += bloque.texto.length + 1;
  }
  cerrar();
  return partes;
}

function paginar(texto: string, presupuesto = DOC_PART_MAX_CHARS): Parte[] {
  if (texto.length <= presupuesto) return [{ texto, desde: '', hasta: '' }];
  const partes = empaquetar(bloquesPorEncabezado(texto), presupuesto);
  // Un documento sin un solo encabezado no debe devolver cero partes.
  return partes.length > 0 ? partes : [{ texto, desde: '', hasta: '' }];
}

/**
 * Cabecera de continuación. Va en TODAS las partes, con el mapa completo:
 * el agente que busca `entry post` salta a su parte en vez de pedir quince.
 */
function cabecera(topic: DocTopic, partes: Parte[], indice: number, total: number): string {
  const mapa = partes
    .map((p, i) => `  ${i + 1} · ${p.desde}${p.hasta && p.hasta !== p.desde ? ` … ${p.hasta}` : ''}`)
    .join('\n');
  return (
    `[read_docs · topic "${topic}" · part ${indice + 1} of ${partes.length} · ` +
    `${partes[indice].texto.length} of ${total} chars]\n` +
    'This is ONE PART of the doc, not the whole doc. The sections of the other parts are ' +
    'NOT in your context: do not guess them — read the part that holds them by calling ' +
    `read_docs again with topic "${topic}" and the \`part\` number. Parts:\n${mapa}\n\n` +
    `--- part ${indice + 1} of ${partes.length} ---\n`
  );
}

/** Número de partes en que se sirve un tema (1 = cabe entero). */
export function docPartCount(topic: DocTopic): number {
  return paginar(fs.readFileSync(path.join(DOCS_DIR, `${topic}.md`), 'utf-8')).length;
}

/**
 * Lee un tema. Un documento que cabe entero se devuelve tal cual (sin
 * cabecera): la inmensa mayoría de los temas no cambia en nada. Uno que no
 * cabe se sirve por partes de 1 a N, cada una con el mapa de las demás.
 */
export function readDoc(topic: DocTopic, part?: number): string {
  const crudo = fs.readFileSync(path.join(DOCS_DIR, `${topic}.md`), 'utf-8');
  const partes = paginar(crudo);
  if (partes.length === 1) return partes[0].texto;

  const indice = (part ?? 1) - 1;
  if (!Number.isInteger(indice) || indice < 0 || indice >= partes.length) {
    throw new Error(
      `El tema "${topic}" se sirve en ${partes.length} partes: pide part entre 1 y ` +
        `${partes.length} (pediste ${String(part)}).`
    );
  }
  return cabecera(topic, partes, indice, crudo.length) + partes[indice].texto;
}

/** One-line index per topic, for the stable block of the system prompt. */
export function docsIndex(): string {
  return Object.entries(DOC_TOPICS)
    .map(([topic, summary]) => `- ${topic}: ${summary}`)
    .join('\n');
}

export function buildDocsTools(deps: ToolDeps) {
  const readDocsTool = betaZodTool({
    name: 'read_docs',
    description:
      'Reads the internal documentation of a system module. Use it BEFORE operating or explaining a ' +
      'module you do not master (payroll, CFDI, reconciliation, AR/AP…): it says what you can do with ' +
      'your tools and what the human must do (exact CLI command or REST endpoint). Cheap and local — ' +
      'when in doubt, read it. Long topics are served in numbered PARTS: the reply then opens with ' +
      'the part number and a map of every part, and you call this tool again with the same topic and ' +
      'the `part` you need. A part is a fragment: never assume the rest says nothing.',
    inputSchema: z.object({
      topic: z.enum(Object.keys(DOC_TOPICS) as [DocTopic, ...DocTopic[]]).describe('Module to consult'),
      part: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Part number for a topic served in parts (default 1). Part 1 lists every part and the ' +
            'sections it covers, so you can jump straight to the one you need.'
        ),
    }),
    run: (input) => {
      deps.observe?.('read_docs', input);
      return readDoc(input.topic, input.part);
    },
  });

  return [readDocsTool];
}
