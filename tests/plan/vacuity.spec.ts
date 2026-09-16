import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { CRITERIOS, conFuenteMutada, claseDe, rutaDe } from '../../src/plan/criterios.js';

// ============================================================
// LA PRUEBA DE VACUIDAD (T2 · issue #89).
//
// El arnés de mutación de al lado pregunta, criterio por criterio: «¿te pone
// rojo ESTA mutación?». Pregunta bien y pregunta poco — sólo por las
// mutaciones que alguien se acordó de escribir. Esta prueba hace la pregunta
// contraria y de golpe: se VACÍA el repositorio entero —cada archivo
// versionado pasa a ser la cadena vacía, por el seam, sin tocar el disco— y se
// exige que los criterios se den cuenta.
//
// Un criterio que sigue diciendo `ok` sobre un árbol donde no queda nada suele
// estar midiendo la NADA y llamándolo conformidad. Los tres que encontró al
// escribirla lo decían con todas las letras:
//
//   · «dos configuraciones» — dos archivos de vitest VACÍOS bastaban, y lo que
//     se había comprado era el reparto entre suites, no dos archivos;
//   · «0 rutas revisadas; todas montan la guarda» — el censo del perímetro,
//     que es la vara con la que T9 va a medir las catorce rutas de nómina,
//     salía verde sin haber mirado una sola ruta;
//   · «una sola capa, consumida por 0 superficie(s)» — cierto y vacío.
//
// NO TODO VERDE AQUÍ ES UN DEFECTO, y por eso esto es una lista con razones y
// no un `expect(greens).toHaveLength(0)`. Un criterio que afirma una AUSENCIA
// —«ninguna ruta finge cancelar»— es correctamente verde sobre un árbol vacío:
// la ausencia se cumple. Lo que no puede pasar es que un verde así entre sin
// que nadie escriba POR QUÉ. La lista de abajo es ese registro, y sólo encoge.
//
// LO QUE ESTA PRUEBA NO ALCANZA, dicho aquí porque se tropezó con ello al
// escribirla: se vacía lo que `git ls-files` devuelve, así que un criterio que
// lea un archivo SIN VERSIONAR lo sigue leyendo entero y sale verde sin que
// esto lo note. Pasó con este mismo archivo antes de su primer `git add`. No
// es una fuga grave —un criterio del tablero que dependiera de algo no
// versionado ya sería otro problema, y mayor— pero conviene saberlo antes de
// leer un verde de aquí como una garantía.
// ============================================================

/**
 * LOS VERDES QUE SOBREVIVEN AL VACÍO, CON SU RAZÓN. Sólo encoge.
 *
 * Tres familias, y la diferencia importa:
 *
 *   AUSENCIA — el criterio afirma que algo prohibido NO está. Sobre un árbol
 *   vacío eso es cierto y no hay nada mejor que pedirle. Su verde es correcto.
 *
 *   FUERA DEL SEAM — el sujeto del criterio no es un archivo que el overlay
 *   pueda vaciar: es git, o un módulo que se carga con `import()`. El verde no
 *   dice nada sobre el árbol vacío porque el criterio nunca lo miró. Es deuda,
 *   no defecto: pasarlos al seam es trabajo aparte, y hasta entonces queda
 *   escrito que su espejo tampoco los alcanza.
 *
 *   TRINQUETE — un tope superior («no más de N huérfanos») lo satisface el
 *   cero por construcción. Correcto, y vale la pena tenerlo nombrado: es la
 *   forma en que un trinquete puede salir verde sin medir.
 */
const GREEN_ON_AN_EMPTY_TREE: ReadonlyMap<string, string> = new Map([
  // ── AUSENCIA: el verde es correcto ──
  [
    'sources-carry-no-nul-bytes',
    'ausencia: barre los archivos que encuentra y exige que ninguno lleve un NUL. Ninguno de los 943 vacíos lo lleva, y es la respuesta correcta',
  ],
  [
    'entities-table-never-queried',
    'ausencia: cero referencias a la tabla. Sin código no hay referencias, y eso es lo que afirma',
  ],
  [
    'no-faked-external-act-success',
    'ausencia: ningún TODO junto a un acto externo en el camino de escritura',
  ],
  [
    'cfdi-cancellation-requires-pac',
    'ausencia: la ruta no finge cancelar. Una ruta que no existe no finge nada',
  ],
  [
    'bank-reconciliation-posts-difference',
    'ausencia: ninguna ruta marca cuadrado sin postear la diferencia',
  ],
  [
    'posting-code-without-matview-refresh',
    'ausencia: el refresco de la vista materializada no vive en el camino de posteo',
  ],
  [
    'agent-tools-propose-never-execute',
    'ausencia: ninguno de los archivos de herramientas postea, cobra, paga ni timbra hacia fuera',
  ],
  [
    'dead-tables-dropped-or-claimed',
    'ausencia: ninguna tabla creada sin dueño ni entierro. Sin migraciones no hay tablas que reclamar',
  ],
  [
    'historic-runs-backfill-sees-its-rows',
    'ausencia: sin DML en la 060 no hay RLS que declarar, que es literalmente lo que el detalle dice',
  ],
  [
    'matview-migration-survives-rls-floor',
    'ausencia sobre las migraciones (ninguna crea una vista materializada sin declarar cómo esquiva el 42501). DEUDA DECLARADA: su otra mitad es un `existe()` sobre la prueba de integración, y un archivo de prueba VACÍO lo satisface — el mismo defecto que T2 corrigió en la separación de suites de vitest',
  ],

  // ── FUERA DEL SEAM: el criterio nunca miró el árbol ──
  [
    'repository-declares-git-remote',
    'fuera del seam: le pregunta a git por el remoto configurado, no a un archivo. El overlay no lo alcanza',
  ],
  [
    'dotenv-ignored-except-example',
    'fuera del seam: corre `git check-ignore`, y git lee el .gitignore del disco. Vaciarlo en memoria no cambia la respuesta',
  ],
  [
    'cli-audit-baseline-ratchet',
    'fuera del seam: carga el binario con `import()` y audita el `program` construido. El overlay intercepta lecturas de archivo, no cargas de módulo — y por eso ningún espejo puede morderlo tampoco',
  ],
  [
    'every-cli-leaf-declares-risk',
    'fuera del seam: igual que el anterior, mide las 233 hojas del `program` importado y no un archivo. Ver el detalle, que dice 233 sobre un árbol donde no queda una línea',
  ],

  // ── TRINQUETE: el cero satisface un tope superior ──
  [
    'orphan-export-baseline-only-shrinks',
    'trinquete: es un tope superior («no más de 2 huérfanos congelados») y el cero lo cumple por construcción. Correcto, y nombrado aquí para que se vea que un trinquete puede salir verde sin medir nada',
  ],
]);

describe('la prueba de vacuidad — un criterio que no encuentra nada no ha comprobado nada', () => {
  // Sólo los de LECTURA y sin precondición: un criterio de conducta no lee el
  // árbol —ejecuta el camino real— y uno que necesita base sale `no-evaluable`
  // aquí por falta de base, no por vacuidad. Meterlos daría rojos por la razón
  // equivocada, que es la forma más rápida de que se deje de leer el informe.
  const candidates = CRITERIOS.filter((c) => claseDe(c) === 'lectura' && !c.necesita);

  const emptyTree = (): Record<string, string> => {
    const tracked = execFileSync('git', ['ls-files'], {
      encoding: 'utf-8',
      cwd: rutaDe(),
      maxBuffer: 32 * 1024 * 1024,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    // Si esto devolviera poco, la prueba entera se volvería la vacuidad que
    // persigue: no habría vaciado nada y todos saldrían verdes «correctamente».
    expect(
      tracked.length,
      'git ls-files devolvió casi nada: sin árbol que vaciar, esta prueba mediría la nada — que es justo lo que vino a prohibir'
    ).toBeGreaterThan(500);
    return Object.fromEntries(tracked.map((f) => [f, '']));
  };

  it('ningún criterio sale verde sobre el vacío sin estar declarado, y ninguna declaración sobra', async () => {
    const emptied = emptyTree();
    const greens: string[] = [];

    for (const c of candidates) {
      // Una excepción es un no-verde perfectamente bueno: el criterio intentó
      // leer algo que el overlay dice que no está, que es darse cuenta.
      try {
        const r = await conFuenteMutada(emptied, () => c.evaluar());
        if (r.estado === 'ok') greens.push(`${c.id ?? c.enunciado}\n      dijo: ${r.detalle}`);
      } catch {
        /* no-verde */
      }
    }

    const ids = greens.map((v) => v.split('\n')[0]);
    const undeclared = greens.filter((v) => !GREEN_ON_AN_EMPTY_TREE.has(v.split('\n')[0]));
    expect(
      undeclared,
      'CRITERIO VERDE SOBRE UN ÁRBOL VACÍO Y SIN DECLARAR.\n' +
        undeclared.map((v) => `  · ${v}`).join('\n') +
        '\n\n  Está midiendo la nada y llamándolo conformidad. Dos salidas, y sólo dos:\n' +
        '  endurécelo para que exija haber ENCONTRADO algo que mirar (es lo que hicieron\n' +
        '  la separación de suites, el censo de rutas y la capa de reportes en T2), o\n' +
        '  añádelo a GREEN_ON_AN_EMPTY_TREE con la razón escrita de por qué su verde es\n' +
        '  correcto. Lo que no vale es que entre sin que nadie diga cuál de las dos es.'
    ).toEqual([]);

    // LA OTRA DIRECCIÓN, que es la que convierte la lista en trinquete. Una
    // declaración que ya no se cumple deja de ser deuda registrada y se vuelve
    // un permiso permanente — la misma lección que `obsoletas` en la auditoría
    // del CLI y que la línea base de huérfanos.
    const stale = [...GREEN_ON_AN_EMPTY_TREE.keys()].filter((id) => !ids.includes(id));
    expect(
      stale,
      `${stale.length} declaración(es) de GREEN_ON_AN_EMPTY_TREE ya no salen greens sobre el vacío: ` +
        `${stale.join(', ')}. Bórralas en el mismo commit que las paga — la lista sólo encoge.`
    ).toEqual([]);
  }, 120_000);
});
