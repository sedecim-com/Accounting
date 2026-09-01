import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// CAPACIDAD HUÉRFANA
//
// Generaliza lo que `checkLookupTables` hace con dos tablas concretas. Aquella
// comprobación pregunta a la BASE si una tabla conocida tiene filas; ésta
// pregunta al CÓDIGO si una capacidad tiene por dónde alcanzarse. Son la misma
// enfermedad en dos estadios: código que existe, compila, se prueba, y al que
// no llega ninguna ruta.
//
// El síntoma no es un error, es un silencio. `payroll_account_mapping` tenía
// lector y ningún escritor, y el diagnóstico llegó la primera vez que alguien
// corrió nómina — no antes.
//
// DOS FAMILIAS, DOS DEFINICIONES DISTINTAS DE «ALCANZABLE»
//
//  · Una TABLA está huérfana si el código de la aplicación la LEE y NADIE del
//    repositorio la escribe. Las migraciones cuentan como escritor: los datos
//    de referencia (tax_tables, tax_parameters) se siembran ahí y leerlos sin
//    volver a escribirlos es lo correcto. Contarlas de otro modo obligaría a
//    una lista de excepciones, y una lista de excepciones envejece sola.
//
//  · Una FUNCIÓN exportada está huérfana si su nombre no aparece en ninguna
//    parte fuera de su propia declaración. La referencia basta, no hace falta
//    la llamada: un middleware de Express se PASA, no se invoca, y exigir
//    paréntesis acusaba a errorHandler y a requireEntityAccess, que sí están
//    montados. Las líneas de import no cuentan — importar sin usar es
//    exactamente la señal que se busca, no su desmentido.
//
// Es un escáner de texto, no un grafo de llamadas del compilador. Se equivoca
// hacia el lado ruidoso (acusa lo alcanzado sólo por reflexión o por una
// cadena) y nunca hacia el lado callado, que es el que importa.
// ============================================================

export type OrphanKind = 'tabla' | 'funcion';

export interface Orphan {
  kind: OrphanKind;
  /** Nombre de la tabla o de la función. */
  name: string;
  /** Dónde vive, o quién la lee: la primera pista para actuar. */
  where: string;
  /** Qué queda roto por ello, en términos de lo que el usuario no podrá hacer. */
  consequence: string;
}

export interface OrphanReport {
  orphans: Orphan[];
  /** Denominadores, para que un número suelto no parezca peor ni mejor. */
  scanned: { tables: number; exports: number };
}

const quitarComentarios = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Quita las líneas de import/re-export: mencionar no es usar. */
const quitarImports = (t: string): string =>
  t
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
    .replace(/^\s*export\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?/gm, '');

function archivos(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) archivos(f, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(f);
  }
  return out;
}

interface Fuente {
  rel: string;
  texto: string;
}

const leer = (raiz: string, fs_: string[]): Fuente[] =>
  fs_.map((f) => ({
    rel: path.relative(raiz, f),
    texto: quitarComentarios(fs.readFileSync(f, 'utf-8')),
  }));

/** Tablas que las migraciones crean: el inventario real, no el que se adivina del SQL. */
export function tablasDelEsquema(raiz: string): string[] {
  const dir = path.join(raiz, 'src', 'database', 'migrations');
  if (!fs.existsSync(dir)) return [];
  const nombres = new Set<string>();
  for (const m of fs.readdirSync(dir)) {
    if (!m.endsWith('.sql')) continue;
    const sql = fs.readFileSync(path.join(dir, m), 'utf-8');
    for (const x of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi
    )) {
      nombres.add(x[1].toLowerCase());
    }
  }
  return [...nombres].sort();
}

export function scanOrphans(raiz: string): OrphanReport {
  const src = archivos(path.join(raiz, 'src'), ['.ts']).filter(
    // src/plan es el instrumento de medida y cita lo que persigue; las
    // migraciones son el esquema, no consumidores de él.
    (f) => !f.includes(`${path.sep}plan${path.sep}`) && !f.includes(`${path.sep}migrations${path.sep}`)
  );
  const aplicacion = leer(raiz, src);
  const repositorio = leer(raiz, [
    ...archivos(path.join(raiz, 'src'), ['.ts', '.sql']),
    ...archivos(path.join(raiz, 'scripts'), ['.ts', '.sql']),
  ]);
  const cuerpos = [
    ...aplicacion,
    ...leer(raiz, archivos(path.join(raiz, 'tests'), ['.ts'])),
  ].map((f) => ({ ...f, texto: quitarImports(f.texto) }));

  const orphans: Orphan[] = [];

  const tablas = tablasDelEsquema(raiz);
  for (const t of tablas) {
    const lee = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:public\\.)?${t}\\b`, 'i');
    const escribe = new RegExp(
      `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?(?:public\\.)?${t}\\b`,
      'i'
    );
    const lectores = aplicacion.filter((f) => lee.test(f.texto));
    if (lectores.length === 0) continue;
    if (repositorio.some((f) => escribe.test(f.texto))) continue;
    orphans.push({
      kind: 'tabla',
      name: t,
      where: lectores.map((f) => f.rel).slice(0, 3).join(', '),
      consequence:
        `${lectores.length} lector(es) y ningún escritor: la tabla sólo puede llenarse a mano, ` +
        'así que la primera operación que la necesite verá cero filas y no un error',
    });
  }

  const exportadas: Array<{ sym: string; rel: string }> = [];
  for (const f of aplicacion) {
    for (const m of f.texto.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)) {
      exportadas.push({ sym: m[1], rel: f.rel });
    }
  }
  for (const { sym, rel } of exportadas) {
    const uso = new RegExp(`\\b${sym}\\b`, 'g');
    const declaracion = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${sym}\\b`, 'gm');
    let n = 0;
    for (const f of cuerpos) {
      n += (f.texto.match(uso) ?? []).length;
      n -= (f.texto.match(declaracion) ?? []).length;
    }
    if (n > 0) continue;
    orphans.push({
      kind: 'funcion',
      name: sym,
      where: rel,
      consequence: 'exportada y no referenciada en ninguna parte: no hay forma de llegar a ella',
    });
  }

  return { orphans, scanned: { tables: tablas.length, exports: exportadas.length } };
}
