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
const INICIO = '<!-- ESTADO-GENERADO:INICIO -->';
const FIN = '<!-- ESTADO-GENERADO:FIN -->';

/** Toda ruta de comando que el binario responde hoy: 'account', 'account list', … */
export function comandosVivos(): Set<string> {
  const vivos = new Set<string>();
  const andar = (cmd: { commands: readonly unknown[] }, prefijo: string): void => {
    for (const c of cmd.commands as Array<{ name(): string; commands: readonly unknown[] }>) {
      const nombre = prefijo ? `${prefijo} ${c.name()}` : c.name();
      vivos.add(nombre);
      andar(c, nombre);
    }
  };
  andar(program as unknown as { commands: readonly unknown[] }, '');
  return vivos;
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
  porFamilia: Array<{ familia: string; total: number; implementadas: number }>;
  citas: { total: number; sinArchivo: Cita[]; fueraDeRango: Cita[] };
  superficie: { familias: number; comandos: number };
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

  return {
    filas: filas.length,
    implementadas,
    porFamilia: [...agrupado.entries()]
      .map(([familia, g]) => ({ familia, ...g }))
      .filter((g) => g.implementadas > 0 || g.total >= 20)
      .sort((a, b) => b.implementadas - a.implementadas || b.total - a.total),
    citas: { total: citas.length, sinArchivo, fueraDeRango },
    superficie: { familias: program.commands.length, comandos: comandosVivos().size },
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
    `El binario responde hoy **${e.superficie.comandos} comandos** en ` +
      `**${e.superficie.familias} familias** de primer nivel. De las **${e.filas}** filas del ` +
      `catálogo, **${e.implementadas}** (${pct(e.implementadas, e.filas)} %) ya se pueden invocar.`
  );
  l.push('');
  l.push('| Familia | En el catálogo | Ya invocables |');
  l.push('|---|---:|---:|');
  for (const f of e.porFamilia.slice(0, 16)) {
    l.push(`| \`${f.familia}\` | ${f.total} | ${f.implementadas === 0 ? '—' : f.implementadas} |`);
  }
  l.push('');

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

  if (argv.includes('--check')) {
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
