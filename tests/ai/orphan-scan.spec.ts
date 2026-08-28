import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanOrphans, tablasDelEsquema } from '../../src/ai/orphan-scan.js';

// ============================================================
// Cada prueba de este archivo es un falso positivo o un falso negativo que el
// escáner produjo de verdad contra este repositorio antes de quedar así. Las
// tres versiones anteriores acusaban, respectivamente: palabras sueltas en
// prosa ("this", "them"), middlewares de Express que sí están montados, y los
// datos de referencia que siembra una migración.
//
// Se prueba sobre un árbol falso y no sobre el repositorio: un escáner que
// afirma cosas del código donde vive convierte cualquier commit ajeno en un
// fallo de estas pruebas.
// ============================================================

let raiz: string;

const escribir = (rel: string, contenido: string): void => {
  const f = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, contenido);
};

beforeEach(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'huerfanos-'));
  fs.mkdirSync(path.join(raiz, 'src', 'database', 'migrations'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(raiz, { recursive: true, force: true });
});

const nombres = (kind: 'tabla' | 'funcion'): string[] =>
  scanOrphans(raiz)
    .orphans.filter((o) => o.kind === kind)
    .map((o) => o.name)
    .sort();

describe('tablas', () => {
  it('acusa la que se lee y nadie escribe', () => {
    escribir('src/database/migrations/001.sql', 'CREATE TABLE paycheck_taxes (id uuid);');
    escribir('src/api/routes.ts', "const q = 'SELECT * FROM paycheck_taxes WHERE id = $1';");
    expect(nombres('tabla')).toEqual(['paycheck_taxes']);
  });

  it('no acusa la que siembra una migración: los datos de referencia se leen y ya', () => {
    // tax_tables se llena en 009_tax_tables_2026.sql y el motor de nómina sólo
    // la consulta. Contar únicamente escritores de la aplicación la delataba, y
    // arreglarlo con una lista de excepciones es una lista que envejece sola.
    escribir('src/database/migrations/001.sql', 'CREATE TABLE tax_tables (id uuid);');
    escribir('src/database/migrations/009.sql', "INSERT INTO tax_tables (id) VALUES ('x');");
    escribir('src/services/tax.ts', "const q = 'SELECT rate FROM tax_tables WHERE year = $1';");
    expect(nombres('tabla')).toEqual([]);
  });

  it('no acusa la que nadie lee: sobra, pero no rompe nada al usarla', () => {
    escribir('src/database/migrations/001.sql', 'CREATE TABLE olvidada (id uuid);');
    expect(nombres('tabla')).toEqual([]);
  });

  it('cuenta un script fuera de src como escritor', () => {
    escribir('src/database/migrations/001.sql', 'CREATE TABLE semilla (id uuid);');
    escribir('src/services/lee.ts', "const q = 'SELECT * FROM semilla';");
    escribir('scripts/sembrar.ts', "await query('INSERT INTO semilla (id) VALUES ($1)', [x]);");
    expect(nombres('tabla')).toEqual([]);
  });

  it('el inventario sale de las migraciones, no de adivinar el SQL', () => {
    escribir('src/database/migrations/001.sql', 'CREATE TABLE IF NOT EXISTS public.invoices (id uuid);');
    escribir('src/database/migrations/002.sql', 'CREATE TABLE bills (id uuid);');
    // «FROM lateral», «FROM unnest», «from what» y demás prosa no son tablas.
    escribir('src/x.ts', "const m = 'lo que viene FROM whoever escribió esto';");
    expect(tablasDelEsquema(raiz)).toEqual(['bills', 'invoices']);
  });
});

describe('funciones exportadas', () => {
  it('acusa la que nadie nombra en ninguna parte', () => {
    escribir('src/services/assets.ts', 'export async function runMonthlyDepreciation() { return 1; }');
    expect(nombres('funcion')).toEqual(['runMonthlyDepreciation']);
  });

  it('NO acusa un middleware que se pasa por referencia sin invocarse', () => {
    // Exigir paréntesis acusaba a errorHandler y a requireEntityAccess, que
    // están montados en index.ts. Un middleware se pasa, no se llama.
    escribir('src/middleware.ts', 'export function errorHandler(e, req, res, next) { next(e); }');
    escribir('src/index.ts', "import { errorHandler } from './middleware.js';\napp.use(errorHandler);");
    expect(nombres('funcion')).toEqual([]);
  });

  it('un import sin uso NO la salva: importar sin usar es la señal, no su desmentido', () => {
    escribir('src/util.ts', 'export function withNote(x) { return x; }');
    escribir('src/otro.ts', "import { withNote } from './util.js';\nconst y = 2;");
    expect(nombres('funcion')).toEqual(['withNote']);
  });

  it('una mención en un comentario NO la salva', () => {
    escribir('src/util.ts', 'export function allDeclarations() { return []; }');
    escribir('src/otro.ts', '// pendiente: conectar allDeclarations con las herramientas\nconst y = 2;');
    expect(nombres('funcion')).toEqual(['allDeclarations']);
  });

  it('una prueba que la ejercita cuenta como consumidor', () => {
    escribir('src/util.ts', 'export function calcular(x) { return x; }');
    escribir('tests/util.spec.ts', "import { calcular } from '../src/util.js';\nexpect(calcular(1)).toBe(1);");
    expect(nombres('funcion')).toEqual([]);
  });

  it('usarla sólo dentro de su archivo cuenta: sobra el export, no la función', () => {
    escribir('src/comando.ts', 'export function render(x) { return x; }\nconsole.log(render(1));');
    expect(nombres('funcion')).toEqual([]);
  });

  it('no confunde getPolicy con getPolicySpec', () => {
    escribir('src/policy.ts', 'export function getPolicy(k) { return k; }');
    escribir('src/init.ts', "import { getPolicySpec } from './catalog.js';\nconst s = getPolicySpec('x');");
    expect(nombres('funcion')).toEqual(['getPolicy']);
  });
});

describe('lo que el escáner no mira', () => {
  it('ignora src/plan, que cita los patrones que persigue', () => {
    escribir('src/plan/criterios.ts', 'export function noSoyHuerfana() { return 1; }');
    expect(nombres('funcion')).toEqual([]);
  });

  it('devuelve los denominadores, para que un número suelto no engañe', () => {
    escribir('src/database/migrations/001.sql', 'CREATE TABLE a (id uuid); CREATE TABLE b (id uuid);');
    escribir('src/x.ts', 'export function uno() { return 1; }\nexport function dos() { return uno(); }');
    expect(scanOrphans(raiz).scanned).toEqual({ tables: 2, exports: 2 });
  });
});
