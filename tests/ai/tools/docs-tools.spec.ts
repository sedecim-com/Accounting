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
