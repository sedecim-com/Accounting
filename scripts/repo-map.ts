/**
 * Generates — and checks — docs/REPO_MAP.md: the map an agent reads BEFORE
 * opening files (agentic framework §10.5, «mapa antes que exploración»).
 *
 *   npx tsx scripts/repo-map.ts           write docs/REPO_MAP.md
 *   npx tsx scripts/repo-map.ts --check   exit 1 if the published map is stale
 *
 * WHAT IT HOLDS, AND WHAT IT DELIBERATELY DOES NOT. One line per module and the
 * list of files too large to read whole. No line counts: a count changes in
 * every PR, and a generated block that goes stale on every PR is a gate that
 * gets switched off. A file only enters or leaves the «large» list when it
 * crosses the threshold, which is rare and worth a diff.
 *
 * THE DESCRIPTIONS ARE WRITTEN BY HAND, AND THAT IS THE CHECK. A module (a
 * directory under src/, src/services/, src/cli/, src/ai/ or src/api/rest/) with
 * no entry in MODULE_DESCRIPTIONS fails --check, and so does an entry whose
 * directory no longer exists. The map cannot silently omit a new module or keep
 * describing a deleted one — the two ways a hand-written map rots.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'REPO_MAP.md');

/** Files at or above this many lines are listed as «search, then read ranges». */
const LARGE_FILE_LINES = 1000;

/** Directories whose immediate subdirectories are modules of their own. */
const MODULE_PARENTS = ['src', 'src/services', 'src/cli', 'src/ai', 'src/api/rest'];

/** One line per module. Adding a module without a line here fails --check. */
const MODULE_DESCRIPTIONS: Record<string, string> = {
  'src/ai': 'El agente: proveedores de modelo, herramientas, la cola de dos tiempos (`ai_drafts`, `ai_external_ops`), el suelo `floor.ts`, la ingesta con IA y la memoria.',
  'src/ai/docs': 'Corpus que el agente lee como verdad (Markdown); sellado contra sus fuentes por `scripts/corpus-manifiesto.ts`.',
  'src/ai/eval': 'Puntuación del golden set del clasificador (`npm run eval`).',
  'src/ai/jobs': 'Trabajos programados del agente: almacén, compuerta de despertar y ejecutor.',
  'src/ai/providers': 'Adaptadores de proveedores de modelo (Anthropic y compatibles con OpenAI).',
  'src/ai/skills': 'Habilidades importables del agente: contenido no confiable, con escáner de confianza y compuerta.',
  'src/ai/tools': 'Herramientas que el agente invoca; leen servicios y proponen, nunca postean.',
  'src/ai/webhooks': 'Entrada de webhooks para el agente y su lector.',
  'src/api': 'Superficie REST (Express) bajo `/v1`.',
  'src/api/rest/middleware': 'Autenticación, contexto de inquilino, auditoría por petición, idempotencia, límites y locale.',
  'src/api/rest/routes': 'Rutas `/v1` por dominio; cada una declara su riesgo y su esquema (de ahí sale `docs/openapi.json`).',
  'src/auth': 'Identidad, roles y permisos compartidos por la terminal y REST.',
  'src/cli': 'El producto: el binario `mnemosine` (Commander), una hoja por familia de comandos.',
  'src/cli/init': 'Asistente de puesta en marcha (`mnemosine init`).',
  'src/cli/kernel': 'Núcleo del CLI: riesgo declarado, marcha seca, `--live`, vocabulario cerrado, salida y códigos de salida.',
  'src/config': 'Configuración leída del entorno.',
  'src/database': 'Pool, migraciones (`migrations/`), políticas RLS, alcance por inquilino y entidad (`scope.ts`) y semillas.',
  'src/i18n': 'Catálogos de mensajes por clave (`en.ts`, `es.ts`) y formato por locale.',
  'src/language': 'Registro del vocabulario persistido y su nombre inglés (rector del idioma).',
  'src/plan': 'El plan ejecutable: criterios (`criterios.ts`, que reúne un archivo por paquete en `criteria/`), conducta contra base efímera (`conducta.ts`) y `plan:status`.',
  'src/services': 'Motor de negocio compartido por la terminal, REST y el agente.',
  'src/services/accounting': 'Motor contable: `posting.ts` (única puerta al mayor), periodos, cierre y su conductor, catálogo, apertura, validaciones.',
  'src/services/accruals': 'Devengos mensuales y pagos anticipados.',
  'src/services/ap': 'Cuentas por pagar: proveedores y facturas de compra.',
  'src/services/ar': 'Cuentas por cobrar: clientes, facturas, notas de crédito y controles del auxiliar.',
  'src/services/assets': 'Activo fijo, categorías y depreciación.',
  'src/services/audit': 'Bitácora de auditoría.',
  'src/services/backup': 'Respaldo, verificación por restauración y exportación.',
  'src/services/banking': 'Estados de cuenta, parsers (CSV, MT940, camt053), cotejo y conciliación.',
  'src/services/blockchain': 'Publicación de cifras públicas y su sello (superficie apagada por omisión).',
  'src/services/cache': 'Limitador de tasa, con Redis opcional.',
  'src/services/entity': 'Entidades (sociedades) del inquilino.',
  'src/services/fiscal': 'Periodo fiscal, factores e INPC.',
  'src/services/fiscal-credentials': 'Custodia de e.firma y CSD y su consentimiento (ruta con dueño reforzado).',
  'src/services/fx': 'Tipos de cambio y conversión.',
  'src/services/idempotency': 'Almacén de llaves de idempotencia.',
  'src/services/integrations': 'Adaptadores externos: PAC de timbrado, Contalink, almacenamiento.',
  'src/services/jurisdiction': 'La jurisdicción como dimensión y los parámetros legales con vigencia.',
  'src/services/payments': 'Cobros y pagos: aplicación, anticipos y descuentos.',
  'src/services/payroll': 'Nómina México y Estados Unidos: cálculo, corridas, asiento, SUA y formularios.',
  'src/services/policy': 'Panel de decisiones del despacho: cada bifurcación de criterio contable, con su lector.',
  'src/services/reporting': 'Estados financieros, balanza y flujo de efectivo.',
  'src/services/sat': 'Obligaciones ante el SAT: Anexo 24, DIOT y estado de CFDI.',
  'src/services/vault': 'Cifrado y bóveda de secretos (ruta con dueño reforzado).',
  'src/services/webhooks': 'Suscripciones y entrega de webhooks salientes.',
  'src/services/xml-ingestion': 'Lectura de CFDI, pre-registro, taxonomía y decisiones de posteo.',
  'src/types': 'Tipos compartidos.',
  'src/utils': 'Utilidades: fechas de calendario, limpieza de comentarios, CSV, cifrado, secuencias, errores.',
};

function listModules(): string[] {
  const found: string[] = [];
  for (const parent of MODULE_PARENTS) {
    const abs = path.join(ROOT, parent);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && !(parent === 'src/database' && entry.name === 'migrations')) {
        found.push(`${parent}/${entry.name}`);
      }
    }
  }
  return found.sort();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.(ts|sql)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

function largeFiles(): string[] {
  return ['src', 'tests', 'scripts']
    .flatMap((d) => sourceFiles(path.join(ROOT, d)))
    .filter((f) => fs.readFileSync(f, 'utf8').split('\n').length >= LARGE_FILE_LINES)
    .map((f) => path.relative(ROOT, f))
    .sort();
}

function render(modules: string[], large: string[]): string {
  const rows = modules.map((m) => `| \`${m}/\` | ${MODULE_DESCRIPTIONS[m]} |`);
  return [
    '# Mapa del repositorio',
    '',
    '<!-- NO EDITAR A MANO. Se regenera con: npx tsx scripts/repo-map.ts',
    '     Las descripciones viven en ese script; --check falla si un módulo no tiene la suya. -->',
    '',
    'Léelo **antes** de abrir archivos. Ubica el módulo aquí, busca el símbolo con `rg`,',
    'y lee rangos de líneas: los archivos de la lista final no se leen completos.',
    'Qué es cada cosa y por qué: [`docs/SCOPE.md`](SCOPE.md), [`AGENTS.md`](../AGENTS.md),',
    '[`docs/wiki/Arquitectura.md`](wiki/Arquitectura.md).',
    '',
    '## Módulos',
    '',
    '| Módulo | Qué hay |',
    '|---|---|',
    ...rows,
    '',
    'Fuera de `src/`: `tests/` (unitarias por módulo, `tests/integration/` contra Postgres, `tests/fixtures/` sintéticos),',
    '`scripts/` (instrumentos y `verify.sh`), `docs/` (rectores, wiki, auditorías) y `.github/workflows/ci.yml`.',
    '',
    `## Archivos de ${LARGE_FILE_LINES} líneas o más: buscar y leer por rangos`,
    '',
    ...large.map((f) => `- \`${f}\``),
    '',
  ].join('\n');
}

function main(): number {
  const modules = listModules();
  const missing = modules.filter((m) => !(m in MODULE_DESCRIPTIONS));
  const orphan = Object.keys(MODULE_DESCRIPTIONS).filter((m) => !modules.includes(m));
  if (missing.length > 0 || orphan.length > 0) {
    if (missing.length > 0) {
      process.stderr.write(`Módulos sin descripción en scripts/repo-map.ts: ${missing.join(', ')}\n`);
    }
    if (orphan.length > 0) {
      process.stderr.write(`Descripciones de módulos que ya no existen: ${orphan.join(', ')}\n`);
    }
    return 1;
  }
  const content = render(modules, largeFiles());
  if (process.argv.includes('--check')) {
    const published = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (published !== content) {
      process.stderr.write('docs/REPO_MAP.md está desfasado: regenéralo con `npx tsx scripts/repo-map.ts`.\n');
      return 1;
    }
    process.stdout.write('El mapa del repositorio está al día.\n');
    return 0;
  }
  fs.writeFileSync(OUT, content);
  process.stdout.write(`Mapa regenerado en ${path.relative(ROOT, OUT)} (${modules.length} módulos, ${largeFiles().length} archivos grandes).\n`);
  return 0;
}

process.exit(main());
