import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDocsTools,
  readDoc,
  docsIndex,
  docPartCount,
  DOC_TOPICS,
  DOC_PART_MAX_CHARS,
  type DocTopic,
} from '../../../src/ai/tools/docs-tools.js';
import { MAX_TOOL_RESULT_CHARS } from '../../../src/ai/tools/index.js';

const TOPICS = Object.keys(DOC_TOPICS) as DocTopic[];

const CABECERA_DE_PARTE = /^\[read_docs · topic "[^"]+" · part 1 of \d+/;

describe('system docs', () => {
  it('every indexed topic has a real, non-trivial doc file', () => {
    for (const topic of TOPICS) {
      const content = readDoc(topic);
      expect(content.length, `doc ${topic}`).toBeGreaterThan(400);
      // Un tema que cabe entero llega tal cual; uno paginado abre con la
      // cabecera de continuación, y su título va inmediatamente después.
      expect(content, `doc ${topic}`).toMatch(
        docPartCount(topic) === 1 ? /^# / : CABECERA_DE_PARTE
      );
      expect(content, `doc ${topic}`).toMatch(/^# /m);
    }
  });

  it('docsIndex lists every topic with its summary (system-prompt block)', () => {
    const index = docsIndex();
    for (const topic of TOPICS) expect(index).toContain(`- ${topic}:`);
    expect(index.split('\n')).toHaveLength(TOPICS.length);
  });

  it('read_docs tool returns the doc and validates the topic via enum', async () => {
    const tool = buildDocsTools({ model: 'x' })[0];
    expect(tool.name).toBe('read_docs');
    const out = await tool.run({ topic: 'payroll' });
    expect(out).toMatch(/SUTA PER STATE/);
    // zod enum rejects unknown topics at parse time (the runner calls parse)
    expect(() => tool.parse({ topic: 'made-up' })).toThrow();
  });

  it('docs separate what the AI does from what the human does', () => {
    // The editorial contract: every operational doc directs the human to their channel.
    for (const topic of ['accounting', 'receivables', 'payables', 'mexico-cfdi', 'payroll'] as DocTopic[]) {
      expect(readDoc(topic)).toMatch(/human/i);
    }
    expect(readDoc('mnemosine')).toMatch(/cannot EXECUTE — but you GUIDE/);
  });
});

// ============================================================
// PAGINACIÓN
// El defecto: todo resultado de herramienta se corta a
// MAX_TOOL_RESULT_CHARS, y cli-reference.md mide 297.710
// caracteres. El agente recibía 32.000 — 39 de 282 secciones —
// cortados a media línea de encabezado, con la orden de no
// inventar ninguna bandera que no viera. Estas pruebas anclan
// que ya no se le entrega media hoja y que nada se pierde.
// ============================================================

/** Contenido de una parte, sin la cabecera de continuación. */
function cuerpo(texto: string): string {
  const marca = texto.match(/^--- part \d+ of \d+ ---\n/m);
  if (!marca) return texto;
  return texto.slice((marca.index ?? 0) + marca[0].length);
}

function partes(topic: DocTopic): string[] {
  return Array.from({ length: docPartCount(topic) }, (_, i) => readDoc(topic, i + 1));
}

describe('read_docs pagina los temas que no caben en un resultado', () => {
  it('el presupuesto de una parte deja sitio a su cabecera bajo el tope de resultado', () => {
    // Si esta relación se invierte, el tope de tools/index.ts vuelve a cortar
    // lo que la paginación acaba de cortar bien — y otra vez a media hoja.
    expect(DOC_PART_MAX_CHARS).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });

  it('ninguna parte de ningún tema supera el tope que causaba el truncado', () => {
    for (const topic of TOPICS) {
      for (const [i, parte] of partes(topic).entries()) {
        expect(parte.length, `${topic} parte ${i + 1}`).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
      }
    }
  });

  it('cli-reference se sirve en varias partes y ninguna corta un encabezado', () => {
    const total = docPartCount('cli-reference');
    expect(total).toBeGreaterThan(1);
    for (const [i, parte] of partes('cli-reference').entries()) {
      const texto = cuerpo(parte);
      // Toda parte abre en un encabezado completo (o en el preámbulo del
      // archivo, que es la parte 1): jamás a media línea.
      expect(texto, `parte ${i + 1} empieza a media línea`).toMatch(/^(#{1,6} |```)/);
      expect(texto.trimEnd().endsWith('(alias:'), `parte ${i + 1} corta un encabezado`).toBe(false);
    }
  });

  it('ninguna parte viaja con una cerca de código abierta', () => {
    for (const topic of TOPICS) {
      for (const [i, parte] of partes(topic).entries()) {
        const cercas = (cuerpo(parte).match(/^```/gm) ?? []).length;
        expect(cercas % 2, `${topic} parte ${i + 1} deja una cerca abierta`).toBe(0);
      }
    }
  });

  it('las partes reconstruyen el documento entero: no se pierde un byte', () => {
    for (const topic of TOPICS) {
      const original = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'src', 'ai', 'docs', `${topic}.md`),
        'utf-8'
      );
      expect(partes(topic).map(cuerpo).join('\n'), `tema ${topic}`).toBe(original);
    }
  });

  it('cada parte lleva el mapa completo, para saltar a la que sirve', () => {
    const total = docPartCount('cli-reference');
    for (const parte of partes('cli-reference')) {
      for (let n = 1; n <= total; n++) {
        expect(parte).toContain(`\n  ${n} · `);
      }
      expect(parte).toMatch(/do not guess them/);
    }
  });

  it('el binario entero sigue alcanzable: toda familia contable cae en alguna parte', () => {
    const todo = partes('cli-reference').map(cuerpo).join('\n');
    for (const familia of ['entry post', 'invoice issue', 'bank reconciliation open', 'payroll']) {
      expect(todo, `"${familia}" no aparece en ninguna parte`).toContain(familia);
    }
  });

  it('una parte fuera de rango falla diciendo cuántas hay', () => {
    const total = docPartCount('cli-reference');
    expect(() => readDoc('cli-reference', total + 1)).toThrow(
      new RegExp(`se sirve en ${total} partes`)
    );
    expect(() => readDoc('cli-reference', 0)).toThrow(/entre 1 y/);
  });

  it('la herramienta acepta part y devuelve esa parte', async () => {
    const tool = buildDocsTools({ model: 'x' })[0];
    const p2 = await tool.run({ topic: 'cli-reference', part: 2 });
    expect(p2).toMatch(/^\[read_docs · topic "cli-reference" · part 2 of \d+/);
    expect(p2).not.toBe(await tool.run({ topic: 'cli-reference', part: 3 }));
    expect(() => tool.parse({ topic: 'cli-reference', part: 0 })).toThrow();
  });

  it('un tema que cabe entero llega intacto, sin cabecera', () => {
    expect(docPartCount('mnemosine')).toBe(1);
    expect(readDoc('mnemosine')).toBe(readDoc('mnemosine', 1));
    expect(readDoc('mnemosine')).not.toMatch(/^\[read_docs/);
  });
});

// ============================================================
// THE STANDARDS SUMMARIES HAVE AN ENGLISH SOURCE (MNE-001-474, #153)
//
// docs/language.md §3.8: the source is English, and a standards term is
// cited in its official language in parentheses. These summaries sit in
// the cached block of the system prompt, where the agent chooses which
// manual to read. They are the agent's own fixed text, so they had to
// leave Spanish (#141, answer 3 of 16 Nov 2026).
//
// The Spanish names are not typed from memory. An IFRS name must equal the
// `title_es` that src/ai/docs/ifrs-registry.json records from the IFRS
// Foundation, and the NIF names are the CINIF titles, pinned by hand.
// ============================================================

const STANDARDS_TOPICS = [
  'nif-marco',
  'nif-registro',
  'nif-validaciones',
  'niif-indice',
  'niif-marco-presentacion',
  'niif-activos',
  'niif-instrumentos-financieros',
  'niif-ingresos-arrendamientos',
  'niif-pasivos-empleados-impuestos',
  'niif-grupos',
  'niif-moneda-seguros-adopcion',
  'niif-interpretaciones',
  'niif-pymes-convergencia',
] as const;

interface RegistryEntry {
  code: string;
  title_es: string;
  topic: string;
}

const IFRS_REGISTRY = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'ai', 'docs', 'ifrs-registry.json'), 'utf8')
  ) as { standards: RegistryEntry[] }
).standards;

/** Each numbered standard of the registry by its Spanish code («NIC 2», «NIIF 15»). */
const BY_SPANISH_CODE = new Map<string, RegistryEntry>(
  IFRS_REGISTRY.flatMap((entry) => {
    const code = /^(NIC|NIIF) (\d+) \//.exec(entry.code);
    return code ? [[`${code[1]} ${code[2]}`, entry] as const] : [];
  })
);

const PARENTHESISED = /\([^()]*\)/g;

function outsideParentheses(summary: string): string {
  return summary.replace(PARENTHESISED, ' ');
}

function insideParentheses(summary: string): string {
  return (summary.match(PARENTHESISED) ?? []).join(' ');
}

/** «IAS 7/8/10/34» → IAS 7, IAS 8, IAS 10, IAS 34. */
function standardCodes(text: string, families: string): string[] {
  return [...text.matchAll(new RegExp(`\\b(${families}) (\\d+(?:/\\d+)*)`, 'g'))].flatMap((m) =>
    m[2].split('/').map((n) => `${m[1]} ${n}`)
  );
}

const SPANISH_LETTERS = /[áéíóúñ¿¡]/i;
const SPANISH_WORDS = /\b(los|las|del|el|la|de|y|con|para|que|qué|cómo|cada|toda|sin|su|sus|una)\b/i;
const SPANISH_STANDARD_CODES = /\b(NIF|NIC|NIIF|CINIIF|ONIF)\b/;
const ENGLISH_TO_SPANISH: Record<string, string> = { IAS: 'NIC', IFRS: 'NIIF' };

/** CINIF titles (and the two unnumbered IFRS titles), as each summary must carry them. */
const PINNED_SPANISH_NAMES: Partial<Record<(typeof STANDARDS_TOPICS)[number], string[]>> = {
  'nif-marco': [
    'NIF A-1 Marco Conceptual de las Normas de Información Financiera',
    'postulados básicos',
    'NIF A-2 Incertidumbres sobre negocio en marcha',
  ],
  'nif-registro': [
    'Orientaciones a las NIF',
    'NIF D-1 Ingresos por contratos con clientes',
    'NIF C-4 Inventarios',
    'NIF C-6 Propiedades, planta y equipo',
    'NIF C-9 Provisiones, contingencias y compromisos',
    'NIF D-3 Beneficios a los empleados',
    'NIF B-15 Conversión de monedas extranjeras',
  ],
  'nif-validaciones': ['Normas de Información Financiera'],
  'niif-marco-presentacion': ['Marco Conceptual para la Información Financiera'],
  'niif-pymes-convergencia': ['Norma de Contabilidad NIIF para las PyMEs, Tercera Edición'],
};

describe('the standards summaries of read_docs have an English source (MNE-001-474)', () => {
  it('keeps the thirteen topic names', () => {
    for (const topic of STANDARDS_TOPICS) expect(TOPICS, topic).toContain(topic);
  });

  it('writes each summary in English outside its parentheses', () => {
    for (const topic of STANDARDS_TOPICS) {
      const english = outsideParentheses(DOC_TOPICS[topic]);
      expect(english, `${topic}: Spanish letters outside the parentheses`).not.toMatch(SPANISH_LETTERS);
      expect(english, `${topic}: a Spanish word outside the parentheses`).not.toMatch(SPANISH_WORDS);
      expect(english, `${topic}: a Spanish code outside the parentheses`).not.toMatch(SPANISH_STANDARD_CODES);
    }
  });

  it('gives each summary the official Spanish name in parentheses, and every IAS/IFRS its NIC/NIIF', () => {
    for (const topic of STANDARDS_TOPICS) {
      const summary = DOC_TOPICS[topic];
      const spanish = insideParentheses(summary);
      expect(spanish, `${topic}: no Spanish name in parentheses`).toMatch(SPANISH_STANDARD_CODES);
      const spanishCodes = standardCodes(spanish, 'NIC|NIIF');
      for (const english of standardCodes(outsideParentheses(summary), 'IAS|IFRS')) {
        const [family, n] = english.split(' ');
        expect(spanishCodes, `${topic}: ${english} without its Spanish code`).toContain(
          `${ENGLISH_TO_SPANISH[family]} ${n}`
        );
      }
      for (const name of PINNED_SPANISH_NAMES[topic] ?? []) {
        expect(spanish, `${topic}: ${name}`).toContain(name);
      }
    }
  });

  it('takes every NIC/NIIF code and title from the IFRS registry, under its own topic', () => {
    for (const topic of STANDARDS_TOPICS.filter((t) => t.startsWith('niif-'))) {
      const summary = DOC_TOPICS[topic];
      for (const code of standardCodes(insideParentheses(summary), 'NIC|NIIF')) {
        expect(BY_SPANISH_CODE.get(code)?.topic, `${topic}: ${code} is not a registry standard of this topic`).toBe(
          topic
        );
      }
      for (const [code, entry] of BY_SPANISH_CODE) {
        // A code followed by a capitalised word carries a title: it must be the official one, whole.
        if (new RegExp(`\\b${code} (?=\\p{Lu})`, 'u').test(summary)) {
          expect(summary, `${topic}: ${code}`).toContain(`${code} ${entry.title_es}`);
        }
      }
    }
    // The two unnumbered IFRS titles above are the registry's own.
    for (const name of [
      ...PINNED_SPANISH_NAMES['niif-marco-presentacion']!,
      ...PINNED_SPANISH_NAMES['niif-pymes-convergencia']!,
    ]) {
      expect(IFRS_REGISTRY.some((e) => e.title_es.startsWith(name)), name).toBe(true);
    }
  });
});
