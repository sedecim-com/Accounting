import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// ============================================================
// BILINGUAL MATRIX — pins the language policy:
//   1. Every canonical command/subcommand name is ENGLISH.
//   2. The Spanish surface is COMPLETE: every command whose
//      English name differs in Spanish has a working alias.
//   3. Help text is English (no leftovers from the translation).
// Runs the real CLI (--help never touches the database).
// ============================================================

const CLI = path.join(process.cwd(), 'src/cli/mnemosine.ts');

function help(...args: string[]): string {
  return execFileSync('npx', ['tsx', CLI, ...args, '--help'], {
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
  period: { list: 'listar', show: 'ver', open: 'abrir' },
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
  it.each(['entry', 'period', 'year', 'vendor', 'bill', 'customer', 'invoice', 'report', 'outbox', 'question', 'receipt', 'credit-note', 'ar', 'backup', 'bank'])(
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
    const out = execFileSync('npx', ['tsx', CLI, 'memoria', 'corrige', '--help'], {
      encoding: 'utf-8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1' },
    });
    expect(out).toMatch(/Usage: mnemosine memory correct\|corrige/);
  });
});

describe('help text is English', () => {
  it('no translation leftovers in any help screen', () => {
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
