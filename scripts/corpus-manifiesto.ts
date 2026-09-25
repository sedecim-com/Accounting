import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ============================================================
// EL MANIFIESTO DEL CORPUS DEL AGENTE
//
// Los .md de src/ai/docs INSTRUYEN al agente: read_docs se los sirve como
// verdad y el pase de grounding lo manda a leerlos para *verificar*. Un
// manual desfasado no lo desinforma — lo mal-instruye, y su lector no puede
// dudar como dudaría una persona.
//
// Esto compara el hash de cada fuente declarada contra el que se registró la
// última vez que su manual se revisó. No verifica VERDAD (eso sería medir
// prosa con regex, el antipatrón que el tablero persigue): detecta CADUCIDAD,
// y nombra qué releer.
//
//   npx tsx scripts/corpus-manifiesto.ts              → informa
//   npx tsx scripts/corpus-manifiesto.ts --check      → sale 1 si algo caducó
//   npx tsx scripts/corpus-manifiesto.ts --actualizar → sella los hashes de hoy
// ============================================================

const RAIZ = path.resolve(__dirname, '..');
const RUTA = path.join(RAIZ, 'src/ai/docs/manifiesto.json');

interface Manifiesto {
  manuales: Record<string, string[]>;
  /** Manuales que nadie ha releído contra el código de hoy. Sólo encoge. */
  sin_revisar: string[];
  /**
   * Manuales que no tienen fuente en `src/` cuyo hash signifique algo, con la
   * razón escrita de por qué. Estaba en prosa en MANIFIESTO.md, donde ningún
   * programa la leía; en datos, un `.md` nuevo que nadie declare sale en rojo.
   */
  exentos?: Record<string, string>;
  hashes: Record<string, string>;
  [k: string]: unknown;
}

/**
 * DEUDA DECLARADA. Sellar los trece de golpe habría dicho «revisado» sobre
 * páginas congeladas desde agosto — la misma mentira que el manifiesto viene a
 * acabar. Se sellan los que se releyeron de verdad y los restantes quedan
 * nombrados. Este número sólo BAJA.
 *
 * F04 lo bajó de 9 a 8 revisando `payables.md`, que era el manual que este
 * flujo dejaba más desactualizado: describía el pago a proveedor como «cargo a
 * CxP, abono a bancos» cuando el cargo ya se reparte entre pasivo y anticipo,
 * no mencionaba que aplicar un pago después existiera, y daba por buena la
 * frase sobre el descuento por pronto pago que el código llevaba meses
 * rechazando. Un manual obsoleto no es documentación vieja: es el agente
 * afirmando cosas falsas con seguridad.
 */
// S4b lo bajó de 8 a 1. Llevaba clavado en su techo desde que se creó: los
// ocho manuales «sin revisar» no eran manuales desactualizados, eran manuales
// que NADIE había contrastado nunca contra el código, mientras el agente los
// citaba como su mundo. Siete se revisaron afirmación por afirmación —unas
// 220, de las que 56 mentían— y quedó `payroll.md`, que otra sesión está
// tocando ahora mismo: revisarlo mientras se mueve sería sellar un blanco
// móvil. Como el suelo del catálogo y como el piso: sólo baja.
export const SIN_REVISAR_MAXIMO = 1;

/** El mismo hash que `git hash-object`: nadie tiene que aprender otro. */
export function hashDe(rel: string): string | null {
  const abs = path.join(RAIZ, rel);
  if (!fs.existsSync(abs)) return null;
  const contenido = fs.readFileSync(abs);
  return crypto
    .createHash('sha1')
    .update(`blob ${contenido.length}\0`)
    .update(contenido)
    .digest('hex');
}

export interface Caducado {
  manual: string;
  fuente: string;
  motivo: 'cambió' | 'sin sellar' | 'desapareció';
}

export function revisar(m: Manifiesto): Caducado[] {
  const caducados: Caducado[] = [];
  for (const [manual, fuentes] of Object.entries(m.manuales)) {
    // Un manual declarado sin revisar no puede caducar: nunca estuvo al día.
    // Lo que lo vigila es que la lista no crezca, no su hash.
    if (m.sin_revisar.includes(manual)) continue;
    for (const fuente of fuentes) {
      const hoy = hashDe(fuente);
      if (hoy === null) {
        caducados.push({ manual, fuente, motivo: 'desapareció' });
        continue;
      }
      const sellado = m.hashes[fuente];
      if (sellado === undefined) caducados.push({ manual, fuente, motivo: 'sin sellar' });
      else if (sellado !== hoy) caducados.push({ manual, fuente, motivo: 'cambió' });
    }
  }
  return caducados;
}

export function leerManifiesto(): Manifiesto {
  return JSON.parse(fs.readFileSync(RUTA, 'utf-8')) as Manifiesto;
}

// ============================================================
// LA COBERTURA, QUE NADIE COMPARABA (T2 · issue #89).
//
// El detector de caducidad de arriba es exacto sobre los manuales que el
// manifiesto DECLARA, y ciego sobre todos los demás. Medido al escribir esto:
// el directorio tiene 27 manuales, `manuales` declaraba 13, y los 14 restantes
// estaban exentos POR PROSA —«los trece manuales nif-*/niif- restantes
// describen normas externas»— en MANIFIESTO.md, que ningún programa lee.
//
// El agujero no es la exención, que es correcta: un manual sobre la NIC 21 no
// tiene una fuente en `src/` cuyo hash signifique algo. El agujero es que la
// exención viva en un párrafo. Un `.md` nuevo que nadie declare no entra en
// `manuales` ni en ninguna lista, no lo nombra ningún fallo, y el agente lo
// lee como verdad para siempre.
//
// Así que se comparan los tres censos que tienen que decir lo mismo:
//
//   EL DIRECTORIO   — lo que hay en src/ai/docs, que es lo que se embarca;
//   DOC_TOPICS      — lo que el agente puede PEDIR con `read_docs`. Un manual
//                     fuera de aquí es peso muerto; una entrada sin archivo es
//                     una herramienta que promete una página que no existe;
//   EL MANIFIESTO   — `manuales` (con fuentes y hash) más `exentos` (con la
//                     razón escrita de por qué un hash no diría nada de él).
//
// DOC_TOPICS se lee del FUENTE y no se importa: docs-tools.ts arrastra el SDK
// de Anthropic, y una compuerta de CI que carga un cliente de API para contar
// nombres de archivo es una compuerta que se cae por razones ajenas.
// ============================================================

const DIR_CORPUS = path.join(RAIZ, 'src/ai/docs');
const TOPICS_SOURCE = path.join(RAIZ, 'src/ai/tools/docs-tools.ts');

export interface Gap {
  manual: string;
  reason:
    | 'sin declarar'
    | 'declarado y sin archivo'
    | 'no lo puede pedir el agente'
    | 'lo pide el agente y no existe';
}

export function checkCoverage(m: Manifiesto): Gap[] {
  const gaps: Gap[] = [];

  // MANIFIESTO.md es el documento ABOUT el corpus, no parte del corpus: no lo
  // lee el agente y no tiene source que hashear.
  const onDisk = fs
    .readdirSync(DIR_CORPUS)
    .filter((f) => f.endsWith('.md') && f !== 'MANIFIESTO.md')
    .sort();

  const declared = new Set([...Object.keys(m.manuales), ...Object.keys(m.exentos ?? {})]);
  for (const f of onDisk) {
    if (!declared.has(f)) gaps.push({ manual: f, reason: 'sin declarar' });
  }
  for (const f of declared) {
    if (!onDisk.includes(f)) gaps.push({ manual: f, reason: 'declarado y sin archivo' });
  }

  // Las claves de DOC_TOPICS, del source. El block va de `DOC_TOPICS = {` a su
  // `} as const;`, y dentro cada clave abre línea — con comillas cuando lleva
  // guión (`'mexico-cfdi':`) y sin ellas cuando no (`accounting:`).
  const source = fs.readFileSync(TOPICS_SOURCE, 'utf-8');
  const block = source.match(/DOC_TOPICS\s*=\s*\{([\s\S]*?)\n\}\s*as const;/);
  if (!block) {
    // Sin poder leer el catálogo no se finge media comprobación: se acusa.
    gaps.push({ manual: 'DOC_TOPICS', reason: 'no lo puede pedir el agente' });
    return gaps;
  }
  const topics = [...block[1].matchAll(/^ {2}'?([a-z0-9-]+)'?:/gm)].map((x) => `${x[1]}.md`);
  for (const f of onDisk) {
    if (!topics.includes(f)) gaps.push({ manual: f, reason: 'no lo puede pedir el agente' });
  }
  for (const f of topics) {
    if (!onDisk.includes(f)) gaps.push({ manual: f, reason: 'lo pide el agente y no existe' });
  }

  return gaps;
}

function main(argv: string[]): number {
  const m = leerManifiesto();
  const caducados = revisar(m);

  if (argv.includes('--actualizar')) {
    // Se sella POR MANUAL, no en block: sellar todo de una vez es cómo se
    // convierte un detector de caducidad en un ritual.
    const pedidos = argv.filter((a) => a.endsWith('.md'));
    if (pedidos.length === 0) {
      process.stderr.write(
        'Nombra qué manual sellaste tras releerlo: --actualizar receivables.md [otro.md]\n' +
          `Manuales sin revisar hoy: ${m.sin_revisar.join(', ') || 'ninguno'}\n`
      );
      return 1;
    }
    const desconocidos = pedidos.filter((x) => !m.manuales[x]);
    if (desconocidos.length > 0) {
      process.stderr.write(`No están en el manifiesto: ${desconocidos.join(', ')}\n`);
      return 1;
    }
    const hashes = { ...m.hashes };
    for (const manual of pedidos) {
      for (const f of m.manuales[manual]) {
        const h = hashDe(f);
        if (h === null) {
          process.stderr.write(`No existe la fuente declarada por ${manual}: ${f}\n`);
          return 1;
        }
        hashes[f] = h;
      }
    }
    const sin_revisar = m.sin_revisar.filter((x) => !pedidos.includes(x));
    fs.writeFileSync(RUTA, JSON.stringify({ ...m, sin_revisar, hashes }, null, 2) + '\n');
    process.stdout.write(
      `Sellado(s): ${pedidos.join(', ')}. Quedan ${sin_revisar.length} manual(es) sin revisar.\n` +
        (sin_revisar.length < m.sin_revisar.length
          ? `Baja SIN_REVISAR_MAXIMO a ${sin_revisar.length} en este mismo commit.\n`
          : '')
    );
    return 0;
  }

  // LA COBERTURA VA PRIMERO, y antes que el trinquete de `sin_revisar`: un
  // manual que nadie declaró no puede estar «sin revisar» ni «al día», porque
  // para este programa no existe. Acusar la caducidad de doce mientras catorce
  // son invisibles es la forma exacta de publicar una cifra tranquilizadora.
  const gaps = checkCoverage(m);
  if (gaps.length > 0) {
    process.stderr.write(
      `El corpus y el manifiesto no cuadran (${gaps.length}):\n\n` +
        gaps.map((h) => `  ${h.reason.padEnd(26)} ${h.manual}\n`).join('') +
        '\n' +
        '  sin declarar                → añádelo a `manuales` con sus fuentes de src/ y séllalo\n' +
        '                                releyéndolo, o a `exentos` con la razón por la que un\n' +
        '                                hash de código no diría nada de él.\n' +
        '  declarado y sin archivo     → el .md se borró o se renombró y su entrada se quedó.\n' +
        '  no lo puede pedir el agente → está en el directorio y fuera de DOC_TOPICS: se embarca\n' +
        '                                y `read_docs` no lo alcanza. Es peso muerto.\n' +
        '  lo pide el agente y no existe → DOC_TOPICS promete una página que no está: la\n' +
        '                                herramienta falla en manos del agente, no aquí.\n'
    );
    return 1;
  }

  if (m.sin_revisar.length > SIN_REVISAR_MAXIMO) {
    process.stderr.write(
      `La lista de manuales sin revisar CRECIÓ (${m.sin_revisar.length} > ${SIN_REVISAR_MAXIMO}): ` +
        'sólo encoge. Un manual que entra al corpus llega revisado.\n'
    );
    return 1;
  }

  if (caducados.length === 0) {
    const revisados = Object.keys(m.manuales).length - m.sin_revisar.length;
    // La cobertura se IMPRIME aunque pase. Sin esta línea, «12 manuales
    // revisados» se lee como «12 manuales» y nadie se entera de que hay 27:
    // la cifra tranquilizadora era la mitad del problema que T2 vino a cerrar.
    const exentos = Object.keys(m.exentos ?? {}).length;
    process.stdout.write(
      `El corpus está al día: ${revisados + exentos} de ${Object.keys(m.manuales).length + exentos} ` +
        `manuales cubiertos (${revisados} sellados contra sus fuentes, ${exentos} exentos con razón)` +
        (m.sin_revisar.length
          ? `; ${m.sin_revisar.length} sin revisar todavía (${m.sin_revisar.join(', ')})\n`
          : '\n')
    );
    return 0;
  }

  const porManual = new Map<string, Caducado[]>();
  for (const c of caducados) porManual.set(c.manual, [...(porManual.get(c.manual) ?? []), c]);

  process.stdout.write('Manuales del agente cuya fuente cambió desde su última revisión:\n\n');
  for (const [manual, cs] of porManual) {
    process.stdout.write(`  ${manual}\n`);
    for (const c of cs) process.stdout.write(`      ${c.motivo.padEnd(12)} ${c.fuente}\n`);
  }
  process.stdout.write(
    '\nRELEE cada manual contra su fuente. Si sigue siendo fiel, sella con:\n' +
      '  npx tsx scripts/corpus-manifiesto.ts --actualizar\n' +
      'Sellar sin releer no engaña al instrumento: engaña al agente, que lee esto como verdad.\n'
  );
  return argv.includes('--check') ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
