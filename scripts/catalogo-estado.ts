/**
 * Genera —y verifica— el bloque de estado del catálogo de comandos.
 *
 *   npx tsx scripts/catalogo-estado.ts            escribe el bloque en el documento
 *   npx tsx scripts/catalogo-estado.ts --check    sale con 1 si el bloque está desfasado
 *
 * POR QUÉ EXISTE
 *
 * docs/cli-command-catalog.md es un documento de diseño de 1623 comandos, y su
 * dato más útil —cuánto de esa superficie existe ya— estaba escrito a mano.
 * Duró 42 commits. Decía «~30 comandos, casi todos de plomería del agente»
 * cuando el binario ya respondía 136 en 41 familias, doce de ellas contables.
 *
 * Es la misma lección que dejó la tabla de estado del plan de cierre, borrada
 * por lo mismo: un espejo del repositorio mantenido a mano se desincroniza
 * justo cuando el trabajo avanza, que es cuando más se le consulta.
 *
 * Lo que aquí se genera es sólo lo que se puede DERIVAR: qué comandos del
 * catálogo existen hoy en el binario, y si sus citas archivo:linea resuelven.
 * El juicio de cada fila —si el motor existe, a medias o no— sigue siendo
 * humano y sigue escrito a mano, porque no es mecánico. Lo que se pretende es
 * que nadie tenga que volver a CONTAR.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { program } from '../src/cli/mnemosine.js';

const RAIZ = path.resolve(__dirname, '..');
const DOC = path.join(RAIZ, 'docs', 'cli-command-catalog.md');
const SUELO = path.join(RAIZ, 'docs', 'catalogo-minimos.json');
const INICIO = '<!-- ESTADO-GENERADO:INICIO -->';
const FIN = '<!-- ESTADO-GENERADO:FIN -->';

/**
 * El árbol del binario, separando lo que EJECUTA de lo que sólo agrupa.
 *
 * `mnemosine report` no es un comando: es un menú que imprime su ayuda. De los
 * 136 nodos del árbol, 30 son de esos. Contarlos como comandos inflaba la cifra
 * de portada y —peor— hacía que 30 menús aparecieran como «comandos vivos sin
 * fila en el catálogo», convirtiendo 39 desajustes reales de nombre en 69.
 */
export function arbolVivo(): { hojas: Set<string>; grupos: Set<string> } {
  const hojas = new Set<string>();
  const grupos = new Set<string>();
  const andar = (cmd: { commands: readonly unknown[] }, prefijo: string): void => {
    for (const c of cmd.commands as Array<{ name(): string; commands: readonly unknown[] }>) {
      const nombre = prefijo ? `${prefijo} ${c.name()}` : c.name();
      (c.commands.length > 0 ? grupos : hojas).add(nombre);
      andar(c, nombre);
    }
  };
  andar(program as unknown as { commands: readonly unknown[] }, '');
  return { hojas, grupos };
}

/**
 * Toda ruta que el binario responde: hojas y menús.
 *
 * Sigue incluyendo los menús a propósito, porque el catálogo tiene filas para
 * algunos de ellos (`mnemosine sat cred`, por ejemplo, es un grupo con fila
 * propia) y marcarlas como no invocables sería falso.
 */
export function comandosVivos(): Set<string> {
  const { hojas, grupos } = arbolVivo();
  return new Set([...hojas, ...grupos]);
}

/**
 * Familias que el catálogo NO pretende cubrir, y por qué.
 *
 * Su introducción las enumera como la superficie que ya existía —«casi todos de
 * plomería del agente»— y su alcance es la capacidad CONTABLE. Sin esta lista,
 * sus 29 hojas aparecen como «comandos vivos sin fila» y se leen como deuda de
 * catalogación. No lo son: están fuera por diseño, y decirlo es lo que hace
 * creíble el número que sí queda.
 */
export const FUERA_DEL_CATALOGO = new Set([
  'jobs', 'webhooks', 'approvals', 'pending', 'skills', 'memory', 'drafts',
  'outbox', 'questions', 'sessions', 'usage', 'providers', 'entities',
  'prompt-size', 'chat', 'ask', 'review', 'ingest', 'onboard', 'doctor',
  'status', 'login', 'logout', 'whoami', 'lang', 'compact', 'init', 'close',
]);

/**
 * Hojas que el binario ejecuta y el catálogo no nombra, excluyendo la plomería.
 *
 * Es el desajuste que impide medir el avance: mientras exista, un sprint puede
 * entregar ocho comandos y cerrar cero filas. Le pasó a `report`.
 */
export function sinFila(md: string): string[] {
  const rutas = new Set(filasDelCatalogo(md).map((f) => f.ruta));
  return [...arbolVivo().hojas]
    .filter((r) => !rutas.has(r) && !FUERA_DEL_CATALOGO.has(r.split(' ')[0]))
    .sort();
}

export interface Fila {
  /** La invocación canónica tal como la escribe el catálogo. */
  invocacion: string;
  /** Sólo los verbos: `account list [query]` → `account list`. */
  ruta: string;
  familia: string;
}

/**
 * La ruta de comando son los tokens hasta el primer argumento o bandera:
 * `entry post <id> --force` es el comando `entry post`. Sin esto, cada fila
 * con un argumento distinto contaría como un comando distinto.
 */
export function rutaDe(invocacion: string): string {
  return invocacion
    .split(/\s+/)
    .filter((t) => !t.startsWith('<') && !t.startsWith('[') && !t.startsWith('-'))
    .join(' ');
}

export function filasDelCatalogo(md: string): Fila[] {
  // `\b` y no un espacio: hay una fila para la invocación DESNUDA,
  // `| \`mnemosine\` (sin argumentos)`, que detecta el estado de la máquina.
  // Exigir el espacio la dejaba fuera y el total salía 1622 en vez de 1623 —
  // un documento de referencia que se equivoca por uno se lee igual de mal
  // que uno que se equivoca por cien.
  return [...md.matchAll(/^\|\s*`mnemosine\b([^`]*)`/gm)].map((m) => {
    const invocacion = m[1].trim();
    const ruta = rutaDe(invocacion);
    return { invocacion, ruta, familia: ruta.split(' ')[0] || '(raíz)' };
  });
}

/**
 * Una fila del catálogo con TODAS sus columnas, para quien necesita los datos y
 * no sólo el recuento — el artefacto navegable, por ejemplo.
 *
 * Existe porque ese artefacto llevaba los 1623 comandos COPIADOS A MANO dentro
 * de su HTML: 20 citas a un archivo ya borrado, 1622 filas en vez de 1623, y
 * ninguna noción de qué comandos se pueden teclear hoy. Un tercer espejo del
 * repositorio, desfasado como los dos anteriores.
 */
export interface FilaCompleta extends Fila {
  /** El alias en español, tras ` · ` en la primera celda. */
  es: string;
  queHace: string;
  flags: string;
  backend: string;
  /** ✅ | 🟡 | ❌ | ? — el primer carácter de la celda Backend. */
  estado: string;
  riesgo: string;
  ia: string;
  fase: string;
  /** ¿El binario responde hoy a esta ruta de comando? */
  viva: boolean;
}

/**
 * Parte una fila de tabla markdown por sus `|` REALES.
 *
 * Un `split('|')` a secas rompe 133 de las 1623 filas: las celdas llevan tuberías
 * dentro de comillas invertidas (`--status <active|dormant>`) y escapadas (`\|`).
 */
export function celdasDe(linea: string): string[] {
  const celdas: string[] = [];
  let buf = '';
  let enTick = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '`') enTick = !enTick;
    if (ch === '|' && !enTick && linea[i - 1] !== '\\') {
      celdas.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  celdas.push(buf);
  return celdas.map((c) => c.trim());
}

export function filasCompletas(md: string): FilaCompleta[] {
  const vivos = comandosVivos();
  const out: FilaCompleta[] = [];
  for (const linea of md.split('\n')) {
    if (!/^\|\s*`mnemosine\b/.test(linea)) continue;
    const c = celdasDe(linea).slice(1);
    if (c.length < 7) continue;
    const inv = (linea.match(/`mnemosine\b([^`]*)`/) ?? [])[1]?.trim() ?? '';
    const ruta = rutaDe(inv);
    const backend = c[3] ?? '';
    const primero = [...backend][0] ?? '?';
    out.push({
      invocacion: inv,
      ruta,
      familia: ruta.split(' ')[0] || '(raíz)',
      es: (c[0].split('·')[1] ?? '').replace(/`/g, '').trim(),
      queHace: c[1] ?? '',
      flags: c[2] ?? '',
      backend,
      estado: '✅🟡❌'.includes(primero) ? primero : '?',
      riesgo: c[4] ?? '',
      ia: c[5] ?? '',
      fase: (c[6] ?? '').replace(/[^0-9]/g, ''),
      viva: ruta === '' || vivos.has(ruta),
    });
  }
  return out;
}

export interface Cita {
  archivo: string;
  linea: number;
}

export function citasDe(md: string): Cita[] {
  const vistas = new Set<string>();
  const out: Cita[] = [];
  for (const m of md.matchAll(/((?:src|tests|scripts)\/[A-Za-z0-9_/.\-]+\.(?:ts|sql)):(\d+)/g)) {
    const clave = `${m[1]}:${m[2]}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    out.push({ archivo: m[1], linea: Number(m[2]) });
  }
  return out;
}

export interface Estado {
  filas: number;
  implementadas: number;
  /** Cuántas filas declara cada símbolo de la columna Backend. */
  porEstado: { ok: number; parcial: number; falta: number };
  /** Fase 1 es «sin esto no se lleva contabilidad desde el CLI». */
  fase1: { total: number; invocables: number };
  /**
   * El recorte de S0.5: fase 3 cuyo motor no existe (❌). «Best-in-class
   * sobre motores que no existen» no es deuda, es aspiración — se declara
   * fuera del objetivo y queda como respaldo, sin borrar la fila. El corte
   * es MECÁNICO (fase y símbolo), así que se recalcula solo: una fila de
   * fase 3 que gane motor vuelve a contarse por sí misma.
   */
  recorte: { fase3SinMotor: number; objetivo: number };
  porFamilia: Array<{ familia: string; total: number; implementadas: number }>;
  citas: { total: number; sinArchivo: Cita[]; fueraDeRango: Cita[] };
  superficie: { familias: number; comandos: number };
  /** Hojas vivas que el catálogo no nombra, sin contar la plomería. */
  sinFila: string[];
}

export function medir(md: string): Estado {
  const vivos = comandosVivos();
  const filas = filasDelCatalogo(md);

  const agrupado = new Map<string, { total: number; implementadas: number }>();
  let implementadas = 0;
  for (const f of filas) {
    const g = agrupado.get(f.familia) ?? { total: 0, implementadas: 0 };
    g.total += 1;
    // La ruta vacía es la invocación desnuda: el binario siempre responde a
    // `mnemosine` a secas, así que cuenta como implementada.
    if (f.ruta === '' || vivos.has(f.ruta)) {
      g.implementadas += 1;
      implementadas += 1;
    }
    agrupado.set(f.familia, g);
  }

  const sinArchivo: Cita[] = [];
  const fueraDeRango: Cita[] = [];
  const lineasDe = new Map<string, number | null>();
  const citas = citasDe(md);
  for (const c of citas) {
    if (!lineasDe.has(c.archivo)) {
      const abs = path.join(RAIZ, c.archivo);
      lineasDe.set(abs === c.archivo ? c.archivo : c.archivo,
        fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8').split('\n').length : null);
    }
    const n = lineasDe.get(c.archivo);
    if (n === null) sinArchivo.push(c);
    else if (n !== undefined && c.linea > n) fueraDeRango.push(c);
  }

  // El conteo del motor sale de las FILAS, no de la prosa de portada: la tabla
  // escrita a mano decía 153/462/1008 donde las filas dicen 160/447/1016.
  const completas = filasCompletas(md);
  const cuenta = (s: string): number => completas.filter((f) => f.estado === s).length;
  const deFase1 = completas.filter((f) => f.fase === '1');

  return {
    filas: filas.length,
    implementadas,
    porEstado: { ok: cuenta('✅'), parcial: cuenta('🟡'), falta: cuenta('❌') },
    fase1: { total: deFase1.length, invocables: deFase1.filter((f) => f.viva).length },
    recorte: (() => {
      const fase3SinMotor = completas.filter((f) => f.fase === '3' && f.estado === '❌').length;
      return { fase3SinMotor, objetivo: filas.length - fase3SinMotor };
    })(),
    porFamilia: [...agrupado.entries()]
      .map(([familia, g]) => ({ familia, ...g }))
      .filter((g) => g.implementadas > 0 || g.total >= 20)
      .sort((a, b) => b.implementadas - a.implementadas || b.total - a.total),
    citas: { total: citas.length, sinArchivo, fueraDeRango },
    superficie: { familias: program.commands.length, comandos: arbolVivo().hojas.size },
    sinFila: sinFila(md),
  };
}

const pct = (n: number, d: number): string => (d === 0 ? '0' : ((100 * n) / d).toFixed(1));

export function render(e: Estado): string {
  const l: string[] = [];
  l.push(INICIO);
  l.push('');
  l.push('<!--');
  l.push('  NO EDITAR A MANO. Se regenera con:  npx tsx scripts/catalogo-estado.ts');
  l.push('  La CI lo verifica con --check, así que un cambio a mano sale en rojo.');
  l.push('-->');
  l.push('');
  l.push('### Cuánto de este catálogo existe ya');
  l.push('');
  l.push(
    `El binario ejecuta hoy **${e.superficie.comandos} comandos** repartidos en ` +
      `**${e.superficie.familias} familias** de primer nivel. De las **${e.filas}** filas del ` +
      `catálogo, **${e.implementadas}** (${pct(e.implementadas, e.filas)} %) ya se pueden invocar.`
  );
  l.push('');
  l.push(
    `Del motor que cada comando necesita, **${e.porEstado.ok}** filas lo declaran completo, ` +
      `**${e.porEstado.parcial}** a medias y **${e.porEstado.falta}** inexistente.`
  );
  l.push('');
  l.push(
    `**Fase 1** —«sin esto no se puede llevar una contabilidad completa desde el CLI»— son ` +
      `**${e.fase1.total}** filas, de las que **${e.fase1.invocables}** ya se teclean.`
  );
  l.push('');
  l.push(
    `**El objetivo comprometible son ${e.recorte.objetivo} filas** (S0.5): las ` +
      `**${e.recorte.fase3SinMotor}** de fase 3 cuyo motor no existe quedan declaradas fuera ` +
      '— analítica y consolidación sobre motores inexistentes no es deuda sino aspiración, y se ' +
      'conservan como respaldo. El corte es mecánico (fase 3 y ❌), así que una fila que gane ' +
      'motor vuelve a contarse sola. Los 5 solapamientos entre familias siguen SIN enumerar: ese ' +
      'medio corte espera a S0.7.'
  );
  l.push('');
  l.push('| Familia | En el catálogo | Ya invocables |');
  l.push('|---|---:|---:|');
  for (const f of e.porFamilia.slice(0, 16)) {
    l.push(`| \`${f.familia}\` | ${f.total} | ${f.implementadas === 0 ? '—' : f.implementadas} |`);
  }
  l.push('');

  if (e.sinFila.length > 0) {
    l.push(
      `**${e.sinFila.length} comandos que el binario ejecuta no tienen fila** ` +
        `(${e.sinFila.slice(0, 4).join(', ')}${e.sinFila.length > 4 ? ', …' : ''}). ` +
        'Mientras existan, un sprint puede entregar comandos y cerrar cero filas — ' +
        'le pasó a `report`, con 2 741 líneas invertidas.'
    );
    l.push('');
  }

  const rotas = e.citas.sinArchivo.length + e.citas.fueraDeRango.length;
  l.push(
    rotas === 0
      ? `Las ${e.citas.total} citas \`archivo:línea\` del documento resuelven.`
      : `**${rotas} de ${e.citas.total}** citas \`archivo:línea\` ya no resuelven` +
        (e.citas.sinArchivo.length
          ? ` — ${e.citas.sinArchivo.length} a archivos que se borraron (${[
              ...new Set(e.citas.sinArchivo.map((c) => c.archivo)),
            ]
              .slice(0, 3)
              .join(', ')})`
          : '') +
        (e.citas.fueraDeRango.length ? ` y ${e.citas.fueraDeRango.length} a líneas fuera del archivo` : '') +
        '.'
  );
  l.push('');
  l.push(
    '_Que una cita resuelva no prueba que siga apuntando a lo mismo: sólo que el archivo existe y ' +
      'tiene esa línea. El juicio ✅/🟡/❌ de cada fila es humano y se revisa a mano._'
  );
  l.push('');
  l.push(FIN);
  return l.join('\n');
}

function main(argv: string[]): number {
  if (!fs.existsSync(DOC)) {
    process.stderr.write(`No existe ${path.relative(RAIZ, DOC)}\n`);
    return 1;
  }
  const md = fs.readFileSync(DOC, 'utf-8');
  const bloque = render(medir(md));

  const i = md.indexOf(INICIO);
  const j = md.indexOf(FIN);
  if (i < 0 || j < 0) {
    process.stderr.write(
      `El documento no tiene los marcadores ${INICIO} … ${FIN}. ` +
        'Insértalos donde deba ir el bloque generado.\n'
    );
    return 1;
  }
  const actual = md.slice(i, j + FIN.length);

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(filasCompletas(md)));
    return 0;
  }

  if (argv.includes('--check')) {
    // EL TRINQUETE, ANTES QUE EL FORMATO.
    //
    // Que el bloque esté regenerado no impide un retroceso: quien borre un
    // comando y regenere pasa el check con un número más bajo. El suelo vive
    // aparte, en docs/catalogo-minimos.json, y sólo sube en el commit que gana
    // el terreno — la misma disciplina que la lista --exigir de plan:status.
    if (fs.existsSync(SUELO)) {
      const suelo = JSON.parse(fs.readFileSync(SUELO, 'utf-8')) as Record<string, number>;
      const medido = medir(md);
      const caidas: string[] = [];
      const comparar = (clave: string, hoy: number): void => {
        const min = suelo[clave];
        if (typeof min === 'number' && hoy < min) caidas.push(`${clave}: ${hoy} < ${min}`);
      };
      comparar('invocables', medido.implementadas);
      comparar('fase1Invocables', medido.fase1.invocables);
      if (caidas.length > 0) {
        process.stderr.write(
          `El catálogo RETROCEDIÓ respecto a su suelo: ${caidas.join(' · ')}.\n` +
            'Si el terreno se cedió a propósito, baja el suelo en docs/catalogo-minimos.json\n' +
            'en este mismo commit y di por qué en el mensaje.\n'
        );
        return 1;
      }
    }

    // Y que no vuelvan a separarse los nombres. Reconciliarlos hizo saltar los
    // invocables de 80 a 90 sin escribir una línea de producto: eran diez
    // comandos ya entregados que el medidor no veía. Volver a divergir es
    // volver a no poder medir.
    const sueltos = sinFila(md);
    if (sueltos.length > 0) {
      process.stderr.write(
        `${sueltos.length} comando(s) que el binario ejecuta no tienen fila en el catálogo:\n` +
          sueltos.map((x) => `  ${x}`).join('\n') +
          '\n\nDale fila a cada uno, renombra el comando para que case con la que ya existe,\n' +
          'o —si es plomería y no capacidad contable— añade su familia a FUERA_DEL_CATALOGO\n' +
          'en scripts/catalogo-estado.ts, diciendo por qué.\n'
      );
      return 1;
    }

    if (actual === bloque) {
      process.stdout.write('El estado del catálogo está al día.\n');
      return 0;
    }
    process.stderr.write(
      'El bloque de estado del catálogo está desfasado respecto al código.\n' +
        'Regenéralo con:  npx tsx scripts/catalogo-estado.ts\n'
    );
    return 1;
  }

  fs.writeFileSync(DOC, md.slice(0, i) + bloque + md.slice(j + FIN.length));
  process.stdout.write(`Bloque de estado regenerado en ${path.relative(RAIZ, DOC)}.\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
