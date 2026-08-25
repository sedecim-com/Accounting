/**
 * Regenerates the standards table in src/ai/docs/niif-indice.md from
 * src/ai/docs/ifrs-registry.json (the corpus' source of truth). Only the
 * block between the REGISTRY:BEGIN/END markers is replaced; the framing
 * prose is hand-maintained. Run: npx tsx scripts/build-niif-indice.ts
 * The sync test (tests/ai/niif-registry.spec.ts) fails when the file on
 * disk does not match what this generator produces.
 */
import fs from 'node:fs';
import path from 'node:path';
// __dirname nativo en lugar de import.meta: el proyecto compila a CommonJS
// (tsconfig NodeNext sin "type": "module" en package.json), donde import.meta
// es un error de sintaxis. Este módulo lo importa tests/ai/niif-registry.spec.ts.
const DOCS = path.join(__dirname, '..', 'src', 'ai', 'docs');

interface RegistryEntry {
  code: string;
  title_es: string;
  status: string;
  effective: string;
  topic: string;
  replaced_by?: string;
}
interface Registry {
  verified_at: string;
  standards: RegistryEntry[];
}

const STATUS_LABEL: Record<string, string> = {
  vigente: 'vigente',
  sustituida_pendiente: 'vigente (sustitución en camino)',
  futura: 'futura',
  derogada: 'derogada',
};

const GROUP_ORDER = [
  ['niif-marco-presentacion', 'Marco conceptual y presentación'],
  ['niif-activos', 'Activos no financieros'],
  ['niif-instrumentos-financieros', 'Instrumentos financieros y valor razonable'],
  ['niif-ingresos-arrendamientos', 'Ingresos y arrendamientos'],
  ['niif-pasivos-empleados-impuestos', 'Provisiones, empleados e impuestos'],
  ['niif-grupos', 'Grupos y consolidación'],
  ['niif-moneda-seguros-adopcion', 'Moneda, hiperinflación, seguros y adopción'],
  ['niif-interpretaciones', 'Interpretaciones CINIIF/SIC'],
  ['niif-pymes-convergencia', 'PyMEs y convergencia NIF'],
  ['niif-indice', 'Guía no obligatoria (Practice Statements)'],
] as const;

/** First sentence-ish fragment, capped, pipe-safe for the table cell. */
function effectiveSummary(effective: string): string {
  const firstSentence = effective.split(/(?<=\.)\s/)[0] ?? effective;
  const capped = firstSentence.length > 110 ? `${firstSentence.slice(0, 107)}…` : firstSentence;
  return capped.replace(/\|/g, '/');
}

export function buildRegistryBlock(registry: Registry): string {
  const lines: string[] = [''];
  for (const [topic, heading] of GROUP_ORDER) {
    const group = registry.standards.filter((s) => s.topic === topic);
    if (group.length === 0) continue;
    lines.push(`### ${heading}${topic === 'niif-indice' ? '' : ` → doc \`${topic}\``}`);
    lines.push('');
    lines.push('| Norma | Nombre | Estado | Vigencia |');
    lines.push('|---|---|---|---|');
    for (const s of group) {
      const status =
        (STATUS_LABEL[s.status] ?? s.status) + (s.replaced_by ? ` → ${s.replaced_by}` : '');
      lines.push(
        `| ${s.code} | ${s.title_es.replace(/\|/g, '/')} | ${status} | ${effectiveSummary(s.effective)} |`
      );
    }
    lines.push('');
  }
  lines.push(`_${registry.standards.length} fichas · verificado ${registry.verified_at}_`);
  lines.push('');
  return lines.join('\n');
}

export function regenerateIndice(): { content: string; changed: boolean } {
  const registry = JSON.parse(
    fs.readFileSync(path.join(DOCS, 'ifrs-registry.json'), 'utf-8')
  ) as Registry;
  const indicePath = path.join(DOCS, 'niif-indice.md');
  const current = fs.readFileSync(indicePath, 'utf-8');

  const begin = current.indexOf('<!-- REGISTRY:BEGIN');
  const end = current.indexOf('<!-- REGISTRY:END -->');
  if (begin === -1 || end === -1) throw new Error('niif-indice.md: REGISTRY markers not found');
  const beginLineEnd = current.indexOf('\n', begin) + 1;

  const next =
    current.slice(0, beginLineEnd) + buildRegistryBlock(registry) + current.slice(end);
  return { content: next, changed: next !== current };
}

// Run as script (tsx): regenerate in place.
if (process.argv[1] && __filename === path.resolve(process.argv[1])) {
  const { content, changed } = regenerateIndice();
  if (changed) {
    fs.writeFileSync(path.join(DOCS, 'niif-indice.md'), content);
    console.log('niif-indice.md regenerado desde ifrs-registry.json');
  } else {
    console.log('niif-indice.md ya está sincronizado');
  }
}
