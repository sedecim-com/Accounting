#!/usr/bin/env tsx
/**
 * EL METRO DEL IDIOMA (I2 · issue #144)
 *
 *   npm run language:status                 el tablero, para leerlo
 *   npm run language:status -- --json       el mismo dato, para una máquina
 *   npm run language:status -- --check      sale con 1 si algún lane CRECIÓ
 *   npm run language:status -- --tighten    baja las líneas base con holgura
 *   npm run language:status -- --escribir   reescribe el block del documento rector
 *   npm run language:status -- --seed    crea la línea base desde cero
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
 * LA LÍNEA BASELINE SÓLO ENCOGE, Y ES UN ARCHIVO APARTE
 *
 * `docs/language-baseline.json`, como `docs/catalogo-minimos.json`: el block
 * que este comando publica se REGENERA, así que por sí solo no impide un
 * retroceso —bastaría con regenerarlo—. El trinquete es el JSON, y subir un
 * número es un ACTO MANUAL con rastro en el diff. `--tighten` sólo baja.
 *
 * Y guarda el desglose POR ARCHIVO, no sólo el total. Sin él, bajar un lane
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

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'docs', 'language-baseline.json');
const GOVERNING_DOC = path.join(ROOT, 'docs', 'language.md');
const OPEN_MARK = '<!-- LANGUAGE-STATUS:START -->';
const CLOSE_MARK = '<!-- LANGUAGE-STATUS:END -->';

interface Baseline {
  _: string;
  _por_que: string;
  seeded: string;
  lanes: Record<string, number>;
  perFile: Record<string, Record<string, number>>;
}

/** Los dieciséis lanes, en el orden en que se publican. */
export function measure(): Lane[] {
  return [...codeLanes(), ...planLanes(), ...docsLanes()];
}

function readBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Baseline;
}

/**
 * UN HALLAZGO ES UN CARRIL QUE CRECIÓ, O UNA ENTRADA QUE YA NO MIDE NADA.
 *
 * Las dos direcciones importan y por razones distintas. Que un número CREZCA
 * es la regresión obvia. Que una entrada de la línea base ya no corresponda a
 * ningún lane —o a ningún archivo— es la silenciosa: el trinquete se queda
 * protegiendo algo que no existe, y nadie se entera hasta que alguien lee el
 * JSON y no reconoce la mitad.
 */
export interface Finding {
  lane: string;
  detail: string;
}

export function compare(lanes: Lane[], base: Baseline): Finding[] {
  const findings: Finding[] = [];
  const alive = new Map(lanes.map((c) => [c.id, c]));

  for (const c of lanes) {
    const floor = base.lanes[c.id];
    if (floor === undefined) {
      // Un lane nuevo sin entrada no es un error: es un lane que nadie ha
      // sembrado. Se dice, y `--seed` o `--tighten` lo incorporan.
      findings.push({ lane: c.id, detail: `lane nuevo sin línea base (vale ${c.value}); siémbralo` });
      continue;
    }
    if (c.value > floor) {
      const examples = (c.examples ?? []).slice(0, 3).join(' · ');
      findings.push({
        lane: c.id,
        detail: `creció: ${floor} → ${c.value}${examples ? ` — ${examples}` : ''}`,
      });
    }
    // EL DESGLOSE, ARCHIVO POR ARCHIVO. Un total que no crece puede esconder
    // un archivo que empeoró mientras otro mejoró, y eso es exactamente lo
    // que el trinquete por archivo existe para no dejar pasar.
    const fileFloors = base.perFile[c.id] ?? {};
    for (const [file, n] of Object.entries(c.perFile ?? {})) {
      const previous = fileFloors[file];
      if (previous !== undefined && n > previous) {
        findings.push({ lane: c.id, detail: `${file}: creció ${previous} → ${n}` });
      }
    }
    for (const file of Object.keys(fileFloors)) {
      if (!(file in (c.perFile ?? {}))) continue;
    }
  }

  // ENTRADAS MUERTAS: la línea base nombra lanes que ya no existen.
  for (const id of Object.keys(base.lanes)) {
    if (!alive.has(id)) {
      findings.push({
        lane: id,
        detail: 'la línea base protege un lane que ya no se mide: bórralo o devuélvelo',
      });
    }
  }
  return findings;
}

/** `--tighten`: baja lo que tiene holgura. NUNCA sube. */
export function tighten(lanes: Lane[], base: Baseline): Baseline {
  const next: Baseline = { ...base, lanes: { ...base.lanes }, perFile: {} };
  for (const c of lanes) {
    const floor = base.lanes[c.id];
    next.lanes[c.id] = floor === undefined ? c.value : Math.min(floor, c.value);
    const fileFloors = base.perFile[c.id] ?? {};
    const map: Record<string, number> = {};
    for (const [file, n] of Object.entries(c.perFile ?? {})) {
      const previous = fileFloors[file];
      map[file] = previous === undefined ? n : Math.min(previous, n);
    }
    // Los archivos que ya no aportan salen del desglose: si vuelven, el lane
    // los ve como nuevos y el total los acusa.
    if (Object.keys(map).length > 0) next.perFile[c.id] = map;
  }
  // Un lane que desapareció no se conserva: su entrada dejaría de measure algo.
  for (const id of Object.keys(next.lanes)) {
    if (!lanes.some((c) => c.id === id)) delete next.lanes[id];
  }
  return next;
}

function seed(lanes: Lane[], date: string): Baseline {
  const b: Baseline = {
    _: 'LÍNEA BASELINE DEL IDIOMA. La comprueba `npm run language:status -- --check`, que corre en CI.',
    _por_que:
      'El block que el metro publica en el documento rector se REGENERA, así que por sí solo no ' +
      'impide un retroceso: bastaría con regenerarlo. Este archivo es el trinquete — sólo baja, y ' +
      'baja en el MISMO commit que gana el terreno, igual que docs/catalogo-minimos.json. Subir un ' +
      'número es un acto manual y su rastro es el diff.',
    seeded: date,
    lanes: {},
    perFile: {},
  };
  for (const c of lanes) {
    b.lanes[c.id] = c.value;
    if (c.perFile && Object.keys(c.perFile).length > 0) b.perFile[c.id] = { ...c.perFile };
  }
  return b;
}

function block(lanes: Lane[], base: Baseline | null): string {
  const row = (c: Lane): string => {
    const floor = base?.lanes[c.id];
    const slack = floor !== undefined && c.value < floor ? ` (baseline ${floor})` : '';
    const mark = c.informational ? ' *(informational)*' : '';
    return `| \`${c.id}\` | ${c.title}${mark} | ${c.value}${slack} | ${c.target} |`;
  };
  const required = lanes.filter((c) => !c.informational);
  const observed = lanes.filter((c) => c.informational);
  return [
    OPEN_MARK,
    '',
    '<!--',
    '  DO NOT EDIT BY HAND. Regenerate with:  npm run language:status -- --escribir',
    '  CI verifies it with --check, so a hand edit shows up red.',
    '-->',
    '',
    '### How much Spanish is left, and where',
    '',
    `${required.length} lanes under the ratchet and ${observed.length} measured but not yet required.`,
    'The ratchet lives in `docs/language-baseline.json` and only goes down; raising a number is a',
    'manual act and its trace is the diff.',
    '',
    '| Lane | What it counts | Today | Towards |',
    '|---|---|---:|---:|',
    ...required.map(row),
    ...observed.map(row),
    '',
    CLOSE_MARK,
  ].join('\n');
}

function writeBlock(text: string): boolean {
  if (!fs.existsSync(GOVERNING_DOC)) return false;
  const doc = fs.readFileSync(GOVERNING_DOC, 'utf8');
  const i = doc.indexOf(OPEN_MARK);
  const j = doc.indexOf(CLOSE_MARK);
  if (i === -1 || j === -1) {
    // Sin marcadores no se inventa un sitio: el documento decide dónde va su
    // block, no el comando. Se dice y se sigue.
    return false;
  }
  fs.writeFileSync(GOVERNING_DOC, doc.slice(0, i) + text + doc.slice(j + CLOSE_MARK.length));
  return true;
}

/** `--seed` se niega en un árbol sucio: sembraría lo que alguien no ha comprometido. */
function treeIsClean(): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() === '';
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  // NOMBRE CANÓNICO INGLÉS, ALIAS ESPAÑOL — la regla del propio epic aplicada
  // al primer comando que nace bajo ella. El alias no es cortesía: los metros
  // hermanos de esta casa se invocan con `--escribir`, `--apretar` y
  // `--sembrar`, y quien los tiene en la memoria de los dedos no debería
  // descubrir el cambio con un comando que no hace nada y sale cero.
  const ALIAS: Record<string, string> = {
    '--sembrar': '--seed',
    '--apretar': '--tighten',
    '--escribir': '--write',
    '--comprobar': '--check',
  };
  const banderas = new Set(argv.map((a) => ALIAS[a] ?? a));
  const has = (f: string): boolean => banderas.has(f);
  const lanes = measure();
  const base = readBaseline();

  if (has('--json')) {
    process.stdout.write(
      `${JSON.stringify({ lanes, base: base?.lanes ?? null, findings: base ? compare(lanes, base) : [] }, null, 2)}\n`
    );
    return 0;
  }

  if (has('--seed')) {
    if (!treeIsClean()) {
      process.stderr.write(
        'El árbol tiene cambios sin comprometer. `--seed` congela una foto del árbol como\n' +
          'trinquete, y hacerlo sobre trabajo a medio hacer siembra deuda que nadie escribió\n' +
          'todavía — o la esconde. Comprometé o guardá lo que tengas, y vuelve a intentarlo.\n'
      );
      return 1;
    }
    const date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(BASELINE, `${JSON.stringify(seed(lanes, date), null, 2)}\n`);
    process.stdout.write(`Línea base sembrada con ${lanes.length} lanes en ${path.relative(ROOT, BASELINE)}.\n`);
    return 0;
  }

  if (base === null) {
    process.stderr.write('No hay línea base. Créala con `npm run language:status -- --seed` (alias: `--sembrar`).\n');
    return 1;
  }

  if (has('--tighten')) {
    const before = JSON.stringify(base.lanes);
    const next = tighten(lanes, base);
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    const lowered = Object.keys(next.lanes).filter((k) => next.lanes[k] < (base.lanes[k] ?? Infinity));
    process.stdout.write(
      before === JSON.stringify(next.lanes)
        ? 'Ninguna línea base tenía holgura: nada que tighten.\n'
        : `Apretados ${lowered.length} lane(es): ${lowered.join(', ')}.\n`
    );
    return 0;
  }

  const findings = compare(lanes, base);

  if (has('--write')) {
    const written = writeBlock(block(lanes, base));
    process.stdout.write(
      written
        ? `Bloque regenerado en ${path.relative(ROOT, GOVERNING_DOC)}.\n`
        : `No se escribió el block: ${path.relative(ROOT, GOVERNING_DOC)} no existe o no tiene marcadores ${ABRE}.\n`
    );
    return 0;
  }

  if (has('--check')) {
    if (findings.length === 0) {
      process.stdout.write(`El idioma no retrocedió: ${lanes.length} lanes, ninguno por encima de su línea base.\n`);
      return 0;
    }
    process.stderr.write(
      `${findings.length} lane(es) por encima de su línea base:\n` +
        findings.map((h) => `  · ${h.lane}: ${h.detail}`).join('\n') +
        '\n\nLa línea base sólo baja. Si el crecimiento es deliberado, súbela A MANO en\n' +
        'docs/language-baseline.json y dilo en el commit: es lo único que deja rastro.\n'
    );
    return 1;
  }

  // Sin banderas: el tablero, para leerlo.
  const width = Math.max(...lanes.map((c) => c.id.length));
  for (const c of lanes) {
    const floor = base.lanes[c.id];
    const mark = c.informational ? ' (informativo)' : floor !== undefined && c.value < floor ? ` (base ${floor})` : '';
    process.stdout.write(`  ${c.id.padEnd(width)}  ${String(c.value).padStart(6)} → ${c.target}${mark}\n`);
  }
  process.stdout.write(
    `\n${lanes.length} lanes. ${findings.length === 0 ? 'Ninguno por encima de su línea base.' : `${findings.length} por encima: corre --check para verlos.`}\n`
  );
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
