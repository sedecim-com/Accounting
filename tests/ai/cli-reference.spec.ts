import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { program } from '../../src/cli/mnemosine.js';

/**
 * EL DOCUMENTO QUE EL AGENTE LEE COMO «LA SUPERFICIE EXACTA DEL BINARIO».
 *
 * `src/ai/docs/cli-reference.md` se publica al agente con ese contrato
 * (docs-tools.ts) y su propia cabecera le ordena «never invent a flag that is
 * not listed here». Se generó una vez y nadie lo regeneró: llegó a tener 49
 * secciones contra 137 reales, y entre las 88 ausentes estaban las CATORCE
 * familias contables enteras — entry, invoice, payment, receipt, report,
 * account, period, year, vendor, bill, customer, entity, skills, webhooks.
 *
 * Con ese contrato y ese contenido, el agente no podía guiar a nadie hacia
 * `entry post` ni `invoice issue`: para él no existían. Y ninguna prueba lo
 * veía — la que parecía cubrirlo sólo comprobaba que el archivo existiera y
 * no fuera trivial, alcance que excluye por construcción el defecto presente.
 *
 * Esta prueba compara el documento contra el `program` REAL. Importarlo es
 * seguro: su `parseAsync` está tras el guardia de `require.main`.
 */

const DOC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'ai', 'docs', 'cli-reference.md'),
  'utf-8'
);

/** Toda hoja del árbol de comandos, como `familia sub verbo`. */
function hojas(cmd: Command, prefijo: string[] = []): string[] {
  const hijos = cmd.commands as Command[];
  const nombre = cmd.name();
  const ruta = prefijo.length === 0 && nombre === 'mnemosine' ? [] : [...prefijo, nombre];
  if (hijos.length === 0) return ruta.length > 0 ? [ruta.join(' ')] : [];
  return hijos.flatMap((h) => hojas(h, ruta));
}

describe('cli-reference.md describe el binario que se embarca', () => {
  const todas = hojas(program);

  it('el árbol de comandos se lee: si no, la prueba no prueba nada', () => {
    expect(todas.length).toBeGreaterThan(80);
    expect(todas).toContain('entry post');
  });

  it('toda hoja del binario aparece en el documento', () => {
    const ausentes = todas.filter((h) => !DOC.includes(h));
    expect(
      ausentes,
      `El agente lee este documento como la superficie exacta del binario y le ordena no ` +
        `inventar banderas. Lo que no está aquí, para él no existe. Regenera con: ` +
        `npx tsx scripts/generate-cli-reference.ts`
    ).toEqual([]);
  });

  it('las familias contables están, que son las que se habían caído enteras', () => {
    for (const familia of [
      'entry', 'invoice', 'payment', 'receipt', 'report',
      'account', 'period', 'year', 'vendor', 'bill', 'customer', 'entity',
    ]) {
      expect(DOC, `la familia "${familia}" no aparece`).toMatch(
        new RegExp(`\\bmnemosine ${familia}\\b`)
      );
    }
  });

  it('conserva la cabecera que le dice al agente qué es', () => {
    // Sin ella el agente no sabe que es auto-generado ni que no debe
    // inventar banderas.
    expect(DOC.slice(0, 600)).toMatch(/auto-generated|generado autom/i);
  });
});
