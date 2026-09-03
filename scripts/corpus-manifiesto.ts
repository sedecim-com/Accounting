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

function main(argv: string[]): number {
  const m = leerManifiesto();
  const caducados = revisar(m);

  if (argv.includes('--actualizar')) {
    // Se sella POR MANUAL, no en bloque: sellar todo de una vez es cómo se
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

  if (m.sin_revisar.length > SIN_REVISAR_MAXIMO) {
    process.stderr.write(
      `La lista de manuales sin revisar CRECIÓ (${m.sin_revisar.length} > ${SIN_REVISAR_MAXIMO}): ` +
        'sólo encoge. Un manual que entra al corpus llega revisado.\n'
    );
    return 1;
  }

  if (caducados.length === 0) {
    const revisados = Object.keys(m.manuales).length - m.sin_revisar.length;
    process.stdout.write(
      `El corpus está al día: ${revisados} manual(es) revisados y ninguna de sus fuentes cambió` +
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
