import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// ============================================================
// BILINGUAL MATRIX — pins the language policy:
//   1. Every canonical command/subcommand name is ENGLISH.
//   2. The Spanish surface is COMPLETE: every command whose
//      English name differs in Spanish has a working alias.
//   3. The ENGLISH help text has no leftovers from the translation.
// Runs the real CLI (--help never touches the database).
// ============================================================

const CLI = path.join(process.cwd(), 'src/cli/mnemosine.ts');

// ============================================================
// TODA PANTALLA DE ESTA MATRIZ SE PIDE EN en-US (I7 · regla 6 del epic #141)
//
// Hasta I6 el binario tenía UN idioma y esta matriz podía no nombrarlo. I7
// (issue #149) pone el cromo de commander y la descripción de cada comando a
// rendirse POR CLAVE, de modo que el MISMO `--help` pueda imprimir «Usage:» o
// «Uso:» según el locale que resuelva `describeLocale` (src/i18n/locale.ts). Y
// las tres cosas que este archivo mide son de la FUENTE INGLESA: los nombres
// canónicos, sus alias, y que el catálogo inglés no arrastre restos de la
// traducción.
//
// LA BANDERA SÍ CAMBIA ESTAS PANTALLAS, y hay que decirlo porque este mismo
// comentario afirmaba lo contrario dos párrafos después de explicar que el
// binario ya imprime en dos idiomas. Medido hoy: `bank --help` con el entorno
// limpio y con `--locale en-US` difieren en diez renglones, empezando por
// «Uso:» contra «Usage:». Lo que NO cambia es el resultado de correr ESTA
// suite, y por otra razón: `vitest.config.ts` arranca con
// MNEMOSINE_LOCALE=en-US y el hijo hereda el entorno, así que los once bloques
// `it` de abajo pasan con la bandera y sin ella. Se pone igual, y el párrafo
// siguiente dice por qué depender de aquel renglón no basta.
//
// SIN FIJARLO, EL IDIOMA LO ELEGIRÍA EL ENTORNO DE QUIEN CORRE LA SUITE. El
// hijo hereda `process.env` (ver el `env:` de abajo), y la precedencia del
// resolutor es `--locale` > MNEMOSINE_LOCALE > MNEMOSINE_LANG >
// ~/.mnemosine/config.json > ./mnemosine.config.json > el inquilino > es-MX.
// Dos escalones de esa lista son ficheros de la máquina del contribuidor.
//
// SE FIJA CON LA BANDERA, QUE ES EL ESCALÓN DE ARRIBA, Y NO CON LA VARIABLE.
// La variable YA está puesta: vitest.config.ts arranca la suite unitaria con
// MNEMOSINE_LOCALE=en-US, así que hoy —medido— estas pantallas ya salen en
// inglés sin tocar nada. Lo que la bandera añade no es color: es que el
// archivo deje de depender de un renglón que vive en otro fichero y que nadie
// relaciona con esta prueba. El día que alguien corra este spec con otra
// configuración, o quite aquel renglón, el último escalón del resolutor es
// es-MX (`DEFAULT_LOCALE`) y el bloque «help text is English» se pondría rojo
// contra un binario CORRECTO. Un instrumento que se pone rojo por una razón
// que no está escrita en él es el defecto que I6 dejó de deuda.
//
// LO QUE ESTA MATRIZ NO COMPRUEBA, dicho para que nadie lo suponga: la mitad
// ESPAÑOLA. Aquí no hay una sola aserción sobre `--locale es-MX`; quien la
// escriba tendrá que pedirla explícitamente, porque con esta constante toda
// pantalla que pase por `help()` es inglesa por construcción.
//
// VA PEGADA AL BINARIO, donde van las opciones de la raíz —la declara la RAÍZ
// (src/cli/mnemosine.ts), como `-T, --tenant`—. Medido: commander también la
// acepta DESPUÉS del subcomando, porque una opción de la raíz se reconoce en
// cualquier posición mientras no haya `enablePositionalOptions`. Se pone
// delante igual, que es donde el lector la busca y donde el catálogo la
// documenta.
// ============================================================
const IN_ENGLISH = ['--locale', 'en-US'] as const;

function help(...args: string[]): string {
  return execFileSync('npx', ['tsx', CLI, ...IN_ENGLISH, ...args, '--help'], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** canonical → Spanish alias ('' = same word in both languages). */
const TOP_LEVEL: Record<string, string> = {
  // A2: la familia de métricas del agente.
  ai: 'ia',
  // F01: el mayor como sustantivo de primera clase.
  ledger: 'mayor',
  entity: 'entidad',
  account: 'cuenta',
  entry: 'poliza',
  period: 'periodo',
  year: 'ejercicio',
  vendor: 'proveedor',
  bill: 'factura-proveedor',
  customer: 'cliente',
  invoice: 'factura',
  // El dinero que sale y el que entra. Los nombres los fija
  // docs/cli-command-catalog.md: 'payment create' y 'receipt record'.
  payment: 'pago',
  receipt: 'cobro',
  // F03: la otra mitad del ciclo de cobro y los controles de la cartera.
  'credit-note': 'nota-credito',
  ar: 'cxc',
  // F04: el gemelo de `ar` del lado del pasivo — cuadra el subdiario de
  // proveedores contra su cuenta de control y enseña los asientos manuales
  // posteados directo al control, que es con lo que se cierra CxP.
  ap: 'cxp',
  // F05a: la tesorería. `bank` es el sustantivo raíz; `account` y `statement`
  // son calificadores suyos, no sustantivos de primer nivel.
  bank: 'banco',
  // F06a: el activo y su corrida. Dos familias y no una: `asset` es el
  // maestro, `depreciation` es el ACTO mensual — igual que `bank` no absorbe
  // a `reconciliation` genérica.
  asset: 'activo',
  depreciation: 'depreciacion',
  // F06c: el lote que F01 dejaba en un staging sin salida.
  batch: 'lote',
  // F06b: la lectura del cierre. `closing` es el proceso; `close` (que ya
  // existía) es el acto. El alias compuesto viene del catálogo.
  closing: 'cierre-proceso',
  // G4b: las suscripciones de SALIDA. `webhooks`·`ganchos` es la familia de
  // ENTRADA y son tablas distintas: un solo sustantivo para las dos cosas
  // sería el defecto de nombre que esta casa lleva un mes cazando.
  subscription: 'suscripcion',
  // G3: el rastro que responde «quién cambió qué». `auditoria` sin tilde,
  // como el resto del vocabulario español del binario.
  audit: 'auditoria',
  // G1b: el estado de flujos. `cashflow` es UNA palabra en inglés y su alias
  // español es `flujo` a secas — «efectivo» no se repite porque en español el
  // flujo contable ya es de efectivo; el catálogo lo fijó así.
  cashflow: 'flujo',
  // F07b: la contabilidad electrónica del Anexo 24. El alias no se abrevia:
  // «contabilidad-electronica» es como la nombra la ley y como la busca quien
  // la necesita.
  'e-accounting': 'contabilidad-electronica',
  // D1a: el gasto que cubre periodos futuros. El alias es «pago-anticipado»
  // y no «anticipo»: un anticipo A PROVEEDOR (1150) es otra cosa —dinero que
  // sale antes de recibir— y confundirlos en la terminal sería confundirlos
  // en los libros.
  prepaid: 'pago-anticipado',
  // D1: el devengo de prestaciones. `payroll`·`nomina` es la familia y
  // `accrue`·`devengar` su acto — no `provision`, que el registro de comandos
  // adjudicó a fiscal-us (la provisión del impuesto corporativo) en su
  // dictamen 39, y no `benefit`, que ya nombra los PLANES de prestaciones.
  payroll: 'nomina',
  // R4: el tipo de cambio como sustantivo raíz. `fx` no se traduce a
  // «divisa»: el catálogo fijó `cambio`, que es como el despacho lo dice.
  fx: 'cambio',
  // S3: la vía de recuperación que el propio esquema nombra.
  backup: 'respaldo',
  report: 'reporte',
  entities: 'entidades', // deprecated alias of `entity list`; kept working per R9

  providers: 'proveedores',
  ask: 'pregunta',
  chat: '',
  sessions: 'sesiones',
  drafts: 'borradores',
  review: 'revisar',
  ingest: 'ingesta',
  lang: 'idioma',
  onboard: 'alta',
  // S0.6: familias partidas. El alias español pasa a singular (catálogo);
  // `envios`/`questions`/`dudas` siguen vivos como aliases de compatibilidad.
  outbox: 'envio',
  question: 'duda',
  sat: '',
  // F07c: la DIOT no se traduce, como sat y cfdi: es el nombre del trámite.
  diot: '',
  // F08a: el ISN tampoco — es la sigla del impuesto, igual en los dos idiomas.
  isn: '',
  'tax-deposit': 'entero',
  // F02: cfdi es la misma palabra en los dos idiomas, como sat.
  cfdi: '',
  rep: '',
  pending: 'pendientes',
  login: 'entrar',
  logout: 'salir',
  whoami: 'quien',
  doctor: '',
  memory: 'memoria',
  'prompt-size': 'tamano-prompt',
  init: 'configurar',
  close: 'cierre',
  compact: 'compactar',
  approvals: 'aprobaciones',
  usage: 'uso',
  status: 'estado',
  jobs: 'tareas',
  skills: 'habilidades',
  webhooks: 'ganchos',
  // El guion de completado del shell. `completion` ya estaba reservado en
  // OBJECTLESS_COMMANDS y no existía; el alias lo fija el registro
  // (docs/cli-command-registry.md §2.12: `completion`·`completado`), no el
  // gusto de quien lo registra.
  completion: 'completado',
};

const SUBCOMMANDS: Record<string, Record<string, string>> = {
  memory: { teach: 'enseña', correct: 'corrige', retire: 'retira', restore: 'restaura' },
  pending: { define: 'definir', dismiss: 'descartar', reopen: 'reabrir' },
  entity: { list: 'listar', show: 'ver', use: 'usar', create: 'crear', archive: 'archivar', unset: 'limpiar' },
  // F01: deactivate se retiró a archive (R9; los nombres viejos quedan como
  // alias) y la familia ganó set/balance/role/map.
  account: {
    list: 'listar', show: 'ver', create: 'crear', edit: 'editar',
    archive: 'archivar', restore: 'restaurar', set: 'fijar',
    balance: 'saldo', role: 'rol', map: 'mapeo',
  },
  entry: { list: 'listar', show: 'ver', create: 'crear', check: 'verificar', post: 'contabilizar', reverse: 'reversar', void: 'anular' },
  // F06b: la reapertura auditada del periodo cerrado gana su hoja.
  period: { list: 'listar', show: 'ver', open: 'abrir', reopen: 'reabrir' },
  year: { list: 'listar', show: 'ver', create: 'crear' },
  vendor: { list: 'listar', show: 'ver', create: 'crear', edit: 'editar', terms: 'terminos' },
  bill: { list: 'listar', show: 'ver', create: 'crear', line: 'linea', approve: 'aprobar' },
  customer: {
    list: 'listar', show: 'ver', create: 'crear', edit: 'editar',
    archive: 'archivar', restore: 'restaurar', tax: 'fiscal',
  },
  invoice: {
    list: 'listar', show: 'ver', create: 'crear', edit: 'editar', delete: 'eliminar',
    issue: 'emitir', void: 'anular', series: 'serie',
  },
  // F03: el cobro completo (su familia propia), la nota de crédito y los
  // controles de la cartera.
  receipt: {
    record: 'registrar', show: 'ver', list: 'listar',
    apply: 'aplicar', unapply: 'desaplicar', reverse: 'reversar',
  },
  'credit-note': { create: 'crear', show: 'ver', list: 'listar', issue: 'emitir', apply: 'aplicar' },
  ar: { reconcile: 'conciliar', check: 'verificar' },
  ap: { reconcile: 'conciliar' },
  // R4: `rate` es calificador de `fx`, como `statement` lo es de `bank`.
  fx: { rate: 'tipo' },
  prepaid: { create: 'crear', list: 'listar', show: 'ver', run: 'ejecutar' },
  payroll: { accrue: 'devengar' },
  'e-accounting': { catalog: 'catalogo', balance: 'balanza' },
  // F08a. `rate` es la tasa del impuesto y `list`/`set` sus dos actos; el
  // pasivo patronal vive aparte porque lleva IMSS e INFONAVIT además del ISN.
  isn: { rate: 'tasa', calculate: 'calcular' },
  'tax-deposit': { list: 'listar' },
  // G1b: las dos hojas de fase 1 del catálogo.
  cashflow: { generate: 'generar', reconcile: 'conciliar' },
  subscription: { delivery: 'entrega' },
  // F05b: los tres sustantivos del cotejo. `match` es OBJETO aquí (el cotejo),
  // no acto: el verbo `cotejar` sigue reservado para `bank transaction match`.
  bank: {
    account: 'cuenta', statement: 'estado-cuenta',
    transaction: 'movimiento', 'book-item': 'partida-libros', match: 'cotejo',
    // F05c · la sesión. `conciliacion` es de la SESIÓN y `cotejo` del
    // emparejamiento de dos renglones: el registro los declara disjuntos, así
    // que los dos sustantivos conviven aquí sin compartir alias.
    reconciliation: 'conciliacion', 'reconciling-item': 'partida-conciliatoria',
    adjustment: 'ajuste',
    // F05d · los tres sustantivos de tesorería. `check` vive a profundidad 3 a
    // propósito: la palabra ya es el VERBO de `bank statement check`, y a nivel
    // raíz una de las dos dejaría de ser aprendible. Por eso su alias es el
    // sustantivo `cheque` y no el verbo `verificar`.
    fee: 'comision', interest: 'interes', check: 'cheque',
  },
  backup: { create: 'crear', list: 'listar', verify: 'comprobar', restore: 'restaurar' },
  report: { 'trial-balance': 'balanza', 'balance-sheet': 'balance', 'income-statement': 'resultados', 'general-ledger': 'mayor', 'aged-receivable': 'antiguedad-cobrar', 'aged-payable': 'antiguedad-pagar', view: 'vista' },
  outbox: { list: 'listar', run: 'ejecutar' },
  question: { list: 'listar', answer: 'responder' },
};

const SAT_CRED: Record<string, string> = {
  add: 'agregar', status: 'estado', audit: 'auditoria', revoke: 'revocar',
};

// Leftovers the translation audit actually found — the realistic regressions.
const SPANISH_LEFTOVERS = [
  /Solo muestra/, /No interactivo/, /conversa con/, /salud del sistema/,
  /Nombre de la entidad/, /Proveedor de IA/, /\(opcional\)/, /Quedan cosas/,
  /Listo\. Prueba/, /túnel/,
];

let topHelp = '';
let memoryHelp = '';
let pendingHelp = '';
let satCredHelp = '';
let entityHelp = '';
let accountHelp = '';

beforeAll(() => {
  topHelp = help();
  memoryHelp = help('memory');
  pendingHelp = help('pending');
  satCredHelp = help('sat', 'cred');
  entityHelp = help('entity');
  accountHelp = help('account');
}, 120_000);

describe('canonical English names', () => {
  it('every top-level command in the help is a known English canonical', () => {
    // Rows look like "  drafts|borradores [options]  Description…"
    const names = [...topHelp.matchAll(/^ {2}([a-z][a-z0-9-]*)(?:\|| )/gm)]
      .map((m) => m[1])
      .filter((n) => n !== 'help');
    for (const name of names) {
      expect(Object.keys(TOP_LEVEL), `"${name}" is not in the canonical matrix`).toContain(name);
    }
  });

  it('no Spanish word survives as a canonical (aliases are the Spanish surface)', () => {
    const spanishNames = Object.values(TOP_LEVEL).filter(Boolean);
    for (const alias of spanishNames) {
      // The alias must appear AFTER a pipe, never as the row's first name.
      expect(topHelp).not.toMatch(new RegExp(`^ {2}${alias}[| ]`, 'm'));
    }
  });
});

describe('Spanish surface is complete', () => {
  it('every top-level command shows its Spanish alias in the help', () => {
    for (const [canonical, alias] of Object.entries(TOP_LEVEL)) {
      if (!alias) continue;
      expect(topHelp, `${canonical} is missing its alias ${alias}`)
        .toMatch(new RegExp(`^ {2}${canonical}\\|${alias}`, 'm'));
    }
  });

  it('memory subcommands are bilingual', () => {
    for (const [canonical, alias] of Object.entries(SUBCOMMANDS.memory)) {
      expect(memoryHelp).toMatch(new RegExp(`${canonical}\\|${alias}`));
    }
  });

  it('pending subcommands are bilingual', () => {
    for (const [canonical, alias] of Object.entries(SUBCOMMANDS.pending)) {
      expect(pendingHelp).toMatch(new RegExp(`${canonical}\\|${alias}`));
    }
  });

  it('entity subcommands are bilingual', () => {
    for (const [canonical, alias] of Object.entries(SUBCOMMANDS.entity)) {
      expect(entityHelp).toMatch(new RegExp(`${canonical}\\|${alias}`));
    }
  });

  it('account subcommands are bilingual', () => {
    for (const [canonical, alias] of Object.entries(SUBCOMMANDS.account)) {
      expect(accountHelp).toMatch(new RegExp(`${canonical}\\|${alias}`));
    }
  });

  // Every accounting family added on the kernel: one assertion, so a new family
  // only has to appear in SUBCOMMANDS to be held to the bilingual policy.
  it.each(['entry', 'period', 'year', 'vendor', 'bill', 'customer', 'invoice', 'report', 'outbox', 'question', 'receipt', 'credit-note', 'ar', 'backup', 'bank', 'prepaid', 'payroll'])(
    '%s subcommands are bilingual',
    (family) => {
      const text = help(family);
      for (const [canonical, alias] of Object.entries(SUBCOMMANDS[family])) {
        expect(text, `${family} ${canonical} is missing its alias ${alias}`)
          .toMatch(new RegExp(`${canonical}\\|${alias}`));
      }
    }
  );

  it('sat cred subcommands are bilingual', () => {
    for (const [canonical, alias] of Object.entries(SAT_CRED)) {
      expect(satCredHelp).toMatch(new RegExp(`${canonical}\\|${alias}`));
    }
  });

  it('a Spanish alias resolves to the canonical command (deep path)', () => {
    // No pasa por `help()` porque el alias español va EN MEDIO de la ruta
    // (`memoria corrige`), no al final; `IN_ENGLISH` se repite aquí a mano por
    // la misma razón por la que se pone allí, y con más motivo: la aserción de
    // abajo espera literalmente «Usage:», que es cromo de commander y desde I7
    // sale como «Uso:» en cuanto el locale es es-MX. Sin la bandera esta línea
    // mediría el idioma del que ejecuta y no la resolución del alias, que es
    // lo único que la prueba dice comprobar.
    const out = execFileSync('npx', ['tsx', CLI, ...IN_ENGLISH, 'memoria', 'corrige', '--help'], {
      encoding: 'utf-8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1' },
    });
    expect(out).toMatch(/Usage: mnemosine memory correct\|corrige/);
  });
});

// Las pantallas de este bloque vienen todas de `help()`, es decir con
// `--locale en-US`: lo que se afirma es que el CATÁLOGO INGLÉS está limpio, no
// que el binario hable inglés pase lo que pase. Desde I7 lo segundo sería
// falso —y debe serlo: con `--locale es-MX` estas mismas pantallas salen en
// español a propósito—.
describe('help text is English', () => {
  it('no translation leftovers in the English help screens', () => {
    for (const screen of [topHelp, memoryHelp, pendingHelp, satCredHelp]) {
      for (const leftover of SPANISH_LEFTOVERS) {
        expect(screen).not.toMatch(leftover);
      }
    }
  });

  it('flags use English names (the audit found --buscar/--todos/--nota/--tema)', () => {
    for (const screen of [topHelp, memoryHelp, pendingHelp, satCredHelp]) {
      expect(screen).not.toMatch(/--buscar|--todos|--nota|--tema\b|--min-confianza|--max-monto/);
    }
  });
});
