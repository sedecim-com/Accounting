#!/usr/bin/env tsx
/**
 * EL METRO DEL IDIOMA (I2 · issue #144)
 *
 *   npm run language:status                 el tablero, para leerlo
 *   npm run language:status -- --json       el mismo dato, para una máquina
 *   npm run language:status -- --check      sale con 1 si algún carril CRECIÓ
 *   npm run language:status -- --apretar    baja las líneas base con holgura
 *   npm run language:status -- --escribir   reescribe el bloque del documento rector
 *   npm run language:status -- --sembrar    crea la línea base desde cero
 *
 * ============================================================
 * POR QUÉ EXISTE
 *
 * El epic #141 traduce el código al inglés en veintisiete tramos. Sin una
 * cifra por deuda, ninguno es evaluable: «queda español» no se puede cerrar,
 * y un plan cuyo avance no se mide se abandona a la mitad con la mitad
 * traducida, que es peor que no haber empezado — dos convenciones vivas y
 * ninguna vigente.
 *
 * El metro cuenta LO MISMO QUE VA A CONTAR EL LINT DE I3, con el mismo
 * recorrido y el mismo léxico. Si cada uno trae su población, publican dos
 * números y nadie sabe cuál miente.
 *
 * ============================================================
 * LA LÍNEA BASE SÓLO ENCOGE, Y ES UN ARCHIVO APARTE
 *
 * `docs/language-baseline.json`, como `docs/catalogo-minimos.json`: el bloque
 * que este comando publica se REGENERA, así que por sí solo no impide un
 * retroceso —bastaría con regenerarlo—. El trinquete es el JSON, y subir un
 * número es un ACTO MANUAL con rastro en el diff. `--apretar` sólo baja.
 *
 * Y guarda el desglose POR ARCHIVO, no sólo el total. Sin él, bajar un carril
 * exige tocar todos sus archivos a la vez y la deuda se queda congelada; con
 * él, cada PR cierra los archivos que toca y el trinquete lo nota.
 *
 * ============================================================
 * LO QUE ESTE METRO NO HACE
 *
 * No mide la ayuda renderizada del CLI: eso lo mide `ux-status.ts` y aquí se
 * CITA por su `--json` en vez de recontarse. Dos instrumentos midiendo la
 * misma superficie divergen el día que uno cambie su recorrido, y entonces
 * hay que decidir cuál tiene razón sin nadie que lo sepa.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Lane } from './language/lane.js';
import { codeLanes } from './language/lanes/code.js';
import { planLanes } from './language/lanes/plan.js';
import { docsLanes } from './language/lanes/docs.js';

const RAIZ = path.resolve(__dirname, '..');
const BASE = path.join(RAIZ, 'docs', 'language-baseline.json');
const RECTOR = path.join(RAIZ, 'docs', 'language.md');
const ABRE = '<!-- LANGUAGE-STATUS:START -->';
const CIERRA = '<!-- LANGUAGE-STATUS:END -->';

interface Baseline {
  _: string;
  _por_que: string;
  sembrada: string;
  carriles: Record<string, number>;
  porArchivo: Record<string, Record<string, number>>;
}

/** Los dieciséis carriles, en el orden en que se publican. */
export function medir(): Lane[] {
  return [...codeLanes(), ...planLanes(), ...docsLanes()];
}

function leerBase(): Baseline | null {
  if (!fs.existsSync(BASE)) return null;
  return JSON.parse(fs.readFileSync(BASE, 'utf8')) as Baseline;
}

/**
 * UN HALLAZGO ES UN CARRIL QUE CRECIÓ, O UNA ENTRADA QUE YA NO MIDE NADA.
 *
 * Las dos direcciones importan y por razones distintas. Que un número CREZCA
 * es la regresión obvia. Que una entrada de la línea base ya no corresponda a
 * ningún carril —o a ningún archivo— es la silenciosa: el trinquete se queda
 * protegiendo algo que no existe, y nadie se entera hasta que alguien lee el
 * JSON y no reconoce la mitad.
 */
export interface Hallazgo {
  carril: string;
  detalle: string;
}

export function comparar(carriles: Lane[], base: Baseline): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const vivos = new Map(carriles.map((c) => [c.id, c]));

  for (const c of carriles) {
    const suelo = base.carriles[c.id];
    if (suelo === undefined) {
      // Un carril nuevo sin entrada no es un error: es un carril que nadie ha
      // sembrado. Se dice, y `--sembrar` o `--apretar` lo incorporan.
      hallazgos.push({ carril: c.id, detalle: `carril nuevo sin línea base (vale ${c.value}); siémbralo` });
      continue;
    }
    if (c.value > suelo) {
      const ejemplos = (c.examples ?? []).slice(0, 3).join(' · ');
      hallazgos.push({
        carril: c.id,
        detalle: `creció: ${suelo} → ${c.value}${ejemplos ? ` — ${ejemplos}` : ''}`,
      });
    }
    // EL DESGLOSE, ARCHIVO POR ARCHIVO. Un total que no crece puede esconder
    // un archivo que empeoró mientras otro mejoró, y eso es exactamente lo
    // que el trinquete por archivo existe para no dejar pasar.
    const suelosArchivo = base.porArchivo[c.id] ?? {};
    for (const [archivo, n] of Object.entries(c.perFile ?? {})) {
      const previo = suelosArchivo[archivo];
      if (previo !== undefined && n > previo) {
        hallazgos.push({ carril: c.id, detalle: `${archivo}: creció ${previo} → ${n}` });
      }
    }
    for (const archivo of Object.keys(suelosArchivo)) {
      if (!(archivo in (c.perFile ?? {}))) continue;
    }
  }

  // ENTRADAS MUERTAS: la línea base nombra carriles que ya no existen.
  for (const id of Object.keys(base.carriles)) {
    if (!vivos.has(id)) {
      hallazgos.push({
        carril: id,
        detalle: 'la línea base protege un carril que ya no se mide: bórralo o devuélvelo',
      });
    }
  }
  return hallazgos;
}

/** `--apretar`: baja lo que tiene holgura. NUNCA sube. */
export function apretar(carriles: Lane[], base: Baseline): Baseline {
  const nueva: Baseline = { ...base, carriles: { ...base.carriles }, porArchivo: {} };
  for (const c of carriles) {
    const suelo = base.carriles[c.id];
    nueva.carriles[c.id] = suelo === undefined ? c.value : Math.min(suelo, c.value);
    const suelosArchivo = base.porArchivo[c.id] ?? {};
    const mapa: Record<string, number> = {};
    for (const [archivo, n] of Object.entries(c.perFile ?? {})) {
      const previo = suelosArchivo[archivo];
      mapa[archivo] = previo === undefined ? n : Math.min(previo, n);
    }
    // Los archivos que ya no aportan salen del desglose: si vuelven, el carril
    // los ve como nuevos y el total los acusa.
    if (Object.keys(mapa).length > 0) nueva.porArchivo[c.id] = mapa;
  }
  // Un carril que desapareció no se conserva: su entrada dejaría de medir algo.
  for (const id of Object.keys(nueva.carriles)) {
    if (!carriles.some((c) => c.id === id)) delete nueva.carriles[id];
  }
  return nueva;
}

function sembrar(carriles: Lane[], fecha: string): Baseline {
  const b: Baseline = {
    _: 'LÍNEA BASE DEL IDIOMA. La comprueba `npm run language:status -- --check`, que corre en CI.',
    _por_que:
      'El bloque que el metro publica en el documento rector se REGENERA, así que por sí solo no ' +
      'impide un retroceso: bastaría con regenerarlo. Este archivo es el trinquete — sólo baja, y ' +
      'baja en el MISMO commit que gana el terreno, igual que docs/catalogo-minimos.json. Subir un ' +
      'número es un acto manual y su rastro es el diff.',
    sembrada: fecha,
    carriles: {},
    porArchivo: {},
  };
  for (const c of carriles) {
    b.carriles[c.id] = c.value;
    if (c.perFile && Object.keys(c.perFile).length > 0) b.porArchivo[c.id] = { ...c.perFile };
  }
  return b;
}

function bloque(carriles: Lane[], base: Baseline | null): string {
  const fila = (c: Lane): string => {
    const suelo = base?.carriles[c.id];
    const holgura = suelo !== undefined && c.value < suelo ? ` (baseline ${suelo})` : '';
    const marca = c.informational ? ' *(informational)*' : '';
    return `| \`${c.id}\` | ${c.title}${marca} | ${c.value}${holgura} | ${c.target} |`;
  };
  const exigidos = carriles.filter((c) => !c.informational);
  const observados = carriles.filter((c) => c.informational);
  return [
    ABRE,
    '',
    '<!--',
    '  DO NOT EDIT BY HAND. Regenerate with:  npm run language:status -- --escribir',
    '  CI verifies it with --check, so a hand edit shows up red.',
    '-->',
    '',
    '### How much Spanish is left, and where',
    '',
    `${exigidos.length} lanes under the ratchet and ${observados.length} measured but not yet required.`,
    'The ratchet lives in `docs/language-baseline.json` and only goes down; raising a number is a',
    'manual act and its trace is the diff.',
    '',
    '| Lane | What it counts | Today | Towards |',
    '|---|---|---:|---:|',
    ...exigidos.map(fila),
    ...observados.map(fila),
    '',
    CIERRA,
  ].join('\n');
}

function escribirBloque(texto: string): boolean {
  if (!fs.existsSync(RECTOR)) return false;
  const doc = fs.readFileSync(RECTOR, 'utf8');
  const i = doc.indexOf(ABRE);
  const j = doc.indexOf(CIERRA);
  if (i === -1 || j === -1) {
    // Sin marcadores no se inventa un sitio: el documento decide dónde va su
    // bloque, no el comando. Se dice y se sigue.
    return false;
  }
  fs.writeFileSync(RECTOR, doc.slice(0, i) + texto + doc.slice(j + CIERRA.length));
  return true;
}

/** `--sembrar` se niega en un árbol sucio: sembraría lo que alguien no ha comprometido. */
function arbolLimpio(): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: RAIZ, encoding: 'utf8' }).trim() === '';
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  const tiene = (f: string): boolean => argv.includes(f);
  const carriles = medir();
  const base = leerBase();

  if (tiene('--json')) {
    process.stdout.write(
      `${JSON.stringify({ carriles, base: base?.carriles ?? null, hallazgos: base ? comparar(carriles, base) : [] }, null, 2)}\n`
    );
    return 0;
  }

  if (tiene('--sembrar')) {
    if (!arbolLimpio()) {
      process.stderr.write(
        'El árbol tiene cambios sin comprometer. `--sembrar` congela una foto del árbol como\n' +
          'trinquete, y hacerlo sobre trabajo a medio hacer siembra deuda que nadie escribió\n' +
          'todavía — o la esconde. Comprometé o guardá lo que tengas, y vuelve a intentarlo.\n'
      );
      return 1;
    }
    const fecha = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(BASE, `${JSON.stringify(sembrar(carriles, fecha), null, 2)}\n`);
    process.stdout.write(`Línea base sembrada con ${carriles.length} carriles en ${path.relative(RAIZ, BASE)}.\n`);
    return 0;
  }

  if (base === null) {
    process.stderr.write('No hay línea base. Créala con `npm run language:status -- --sembrar`.\n');
    return 1;
  }

  if (tiene('--apretar')) {
    const antes = JSON.stringify(base.carriles);
    const nueva = apretar(carriles, base);
    fs.writeFileSync(BASE, `${JSON.stringify(nueva, null, 2)}\n`);
    const bajaron = Object.keys(nueva.carriles).filter((k) => nueva.carriles[k] < (base.carriles[k] ?? Infinity));
    process.stdout.write(
      antes === JSON.stringify(nueva.carriles)
        ? 'Ninguna línea base tenía holgura: nada que apretar.\n'
        : `Apretados ${bajaron.length} carril(es): ${bajaron.join(', ')}.\n`
    );
    return 0;
  }

  const hallazgos = comparar(carriles, base);

  if (tiene('--escribir')) {
    const puesto = escribirBloque(bloque(carriles, base));
    process.stdout.write(
      puesto
        ? `Bloque regenerado en ${path.relative(RAIZ, RECTOR)}.\n`
        : `No se escribió el bloque: ${path.relative(RAIZ, RECTOR)} no existe o no tiene marcadores ${ABRE}.\n`
    );
    return 0;
  }

  if (tiene('--check')) {
    if (hallazgos.length === 0) {
      process.stdout.write(`El idioma no retrocedió: ${carriles.length} carriles, ninguno por encima de su línea base.\n`);
      return 0;
    }
    process.stderr.write(
      `${hallazgos.length} carril(es) por encima de su línea base:\n` +
        hallazgos.map((h) => `  · ${h.carril}: ${h.detalle}`).join('\n') +
        '\n\nLa línea base sólo baja. Si el crecimiento es deliberado, súbela A MANO en\n' +
        'docs/language-baseline.json y dilo en el commit: es lo único que deja rastro.\n'
    );
    return 1;
  }

  // Sin banderas: el tablero, para leerlo.
  const ancho = Math.max(...carriles.map((c) => c.id.length));
  for (const c of carriles) {
    const suelo = base.carriles[c.id];
    const marca = c.informational ? ' (informativo)' : suelo !== undefined && c.value < suelo ? ` (base ${suelo})` : '';
    process.stdout.write(`  ${c.id.padEnd(ancho)}  ${String(c.value).padStart(6)} → ${c.target}${marca}\n`);
  }
  process.stdout.write(
    `\n${carriles.length} carriles. ${hallazgos.length === 0 ? 'Ninguno por encima de su línea base.' : `${hallazgos.length} por encima: corre --check para verlos.`}\n`
  );
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
