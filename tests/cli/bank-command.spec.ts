import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { registerBankCommand } from '../../src/cli/bank-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';

// ============================================================
// La familia `bank` contra el rulebook y contra sus tres promesas caras:
// la frontera de entidad DENTRO del SQL, que ningún identificador salga
// entero, y que `bank statement check` salga 4 cuando encuentra algo.
//
// Construir el programa ya es una prueba: `declareRisk` lanza en tiempo de
// REGISTRO, así que un import declarado `escritura` + agente sin `draftOnly`
// rompería este archivo en `beforeAll` y no en producción.
// ============================================================

// ---- mocks --------------------------------------------------------
const sql: Array<{ text: string; params: unknown[] }> = [];
let responder: (text: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

const registrar = (text: string, params: unknown[] = []) => {
  sql.push({ text, params });
  return Promise.resolve(responder(text, params));
};

vi.mock('../../src/database/connection.js', () => ({
  query: (text: string, params: unknown[] = []) => registrar(text, params),
  // El doble corre el cuerpo con un cliente falso y sin transacción real: lo
  // que estas pruebas vigilan es QUÉ sentencias salen y con qué parámetros.
  withTransaction: (fn: (c: { query: typeof registrar }) => unknown) =>
    Promise.resolve(fn({ query: registrar })),
  currentTenant: () => 'T1',
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));

const ACC = '11111111-1111-1111-1111-111111111111';
const ST = '22222222-2222-2222-2222-222222222222';

// ---- programa y auditoría (estructura) -----------------------------

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

let program: Command;
let violations: ReturnType<typeof auditProgram>;
/**
 * El riesgo se fotografía en tiempo de registro a propósito: el registro es un
 * mapa de módulo que cualquier suite puede vaciar con `resetDeclarations()`, y
 * lo honesto es afirmar sobre lo que ESTE programa declaró al construirse.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = [
  'bank account create', 'bank account list', 'bank account show',
  'bank account edit', 'bank account set',
  'bank statement import', 'bank statement list', 'bank statement show',
  'bank statement check',
];

beforeAll(() => {
  program = new Command('mnemosine');
  registerBankCommand(program, deps);
  violations = auditProgram(program);
  for (const path of LEAVES) risks.set(path, riskOf(find(path)));
});

function find(path: string): Command {
  let node: Command = program;
  for (const token of path.split(' ')) {
    const next = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`No command "${path}" (stuck at "${token}")`);
    node = next;
  }
  return node;
}

describe('the rulebook', () => {
  it('registers without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name())).toEqual(['bank']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ships exactly the nine leaves, each ending in a verb from the closed list', () => {
    const leaves: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) leaves.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    expect(leaves.sort()).toEqual([...LEAVES].sort());
    for (const leaf of leaves) {
      expect(Object.keys(VERBS), leaf).toContain(leaf.split(' ').pop());
    }
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    bank: 'banco',
    'bank account': 'cuenta',
    'bank account create': 'crear',
    'bank account list': 'listar',
    'bank account show': 'ver',
    'bank account edit': 'editar',
    'bank account set': 'fijar',
    'bank statement': 'estado-cuenta',
    'bank statement import': 'importar',
    'bank statement list': 'listar',
    'bank statement show': 'ver',
    'bank statement check': 'verificar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every verb command', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      const verb = path.split(' ').pop() as string;
      if (VERBS[verb]) expect(alias, path).toBe(VERBS[verb]);
    }
  });
});

describe('safety declarations', () => {
  it('lets the agent read everything and write only into staging', () => {
    for (const path of [
      'bank account list', 'bank account show',
      'bank statement list', 'bank statement show', 'bank statement check',
    ]) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
    }
    for (const path of ['bank account create', 'bank account edit', 'bank account set']) {
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('grants the agent `statement import` ONLY paired with draftOnly', () => {
    const r = risks.get('bank statement import');
    expect(r?.risk).toBe('escritura');
    expect(r?.agentAllowed).toBe(true);
    // Es el par lo que lo hace legal: el catálogo promete que el import no
    // toca el mayor, y `draftOnly` es donde esa promesa se compromete.
    expect(r?.draftOnly).toBe(true);
    expect(r?.writes).toMatch(/NUNCA journal_entries/);
  });

  it('would REFUSE to ship the same grant without draftOnly', () => {
    expect(() =>
      declareRisk(new Command('bank statement import'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });

  it('never offers a flag that would print a full identifier', () => {
    // La CLABE se guarda cifrada (051) y sólo salen sus últimos 4. Una bandera
    // tipo `--reveal` sería la puerta trasera; `--redacted` va en la dirección
    // contraria y es la única que existe.
    for (const path of LEAVES) {
      const longs = find(path).options.map((o) => o.long ?? '');
      expect(longs.filter((l) => /reveal|unmask|plain|decrypt/i.test(l)), path).toEqual([]);
    }
    expect(find('bank account show').options.map((o) => o.long)).toContain('--redacted');
  });
});

describe('list commands can be paged and formatted', () => {
  it('carries the full read group, not just --json', () => {
    for (const path of ['bank account list', 'bank statement list']) {
      const longs = find(path).options.map((o) => o.long);
      expect(longs, path).toEqual(
        expect.arrayContaining(['--limit', '--format', '--json', '--fields', '--offset', '--all'])
      );
    }
  });

  it('reads the FILE format on import, and says so, because --format is taken', () => {
    const fmt = find('bank statement import').options.find((o) => o.long === '--format');
    expect(fmt?.description).toMatch(/format of the FILE/);
    // Y la salida de máquina sigue existiendo por la otra puerta.
    expect(find('bank statement import').options.map((o) => o.long)).toContain('--json');
  });
});

// ---- conducta ------------------------------------------------------

let exitCode: number | undefined;
let errs: unknown[] = [];
let salida: string[] = [];

const behaviorDeps = {
  ...deps,
  shutdown: (c: number) => { exitCode = c; },
  reportError: (e: unknown) => { errs.push(e); },
  confirm: () => Promise.resolve(true),
};

async function run(argv: string[], resp: typeof responder) {
  sql.length = 0;
  errs = [];
  salida = [];
  exitCode = undefined;
  responder = resp;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    salida.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, behaviorDeps);
    await p.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = original;
  }
  return { exitCode, errs, sql: [...sql], out: salida.join('') };
}

const filas = (rows: unknown[]) => ({ rows, rowCount: rows.length });

function cuentaMaestra(over: Record<string, unknown> = {}) {
  return {
    id: ACC, entity_id: 'E1', account_name: 'BBVA MXN', bank_name: 'BBVA',
    bank_branch: 'Polanco', account_type: 'checking', currency_code: 'MXN',
    sat_bank_code: '012', swift_code: null, iban: null,
    clabe_last4: '4321', account_number_last4: null, routing_en_archivo: false,
    is_active: true, saldo_banco: '1000.0000',
    last_synced_at: null, created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-02'),
    gl_id: 'GL1', gl_code: '1110', gl_name: 'Bancos', gl_tipo: 'asset', gl_moneda: 'MXN',
    saldo_libro: '1234.5600', ultima_conciliacion: '2026-01-31',
    ...over,
  };
}

function estadoFila(over: Record<string, unknown> = {}) {
  return {
    id: ST, bank_account_id: ACC, entity_id: 'E1', account_name: 'BBVA MXN',
    currency_code: 'MXN', statement_number: '2026-07',
    period_start: '2026-07-01', period_end: '2026-07-31',
    opening_balance: '0.0000', closing_balance: '750.0000',
    line_count: 2, source_format: 'csv', profile: 'generico',
    file_name: 'e.csv', file_sha256: 'ab'.repeat(32),
    imported_at: '2026-08-01 10:00:00', imported_by: 'U1',
    lineas_en_base: '2', suma_lineas: '750.0000',
    ...over,
  };
}

const LINEAS = [
  {
    id: 'L1', transaction_date: '2026-07-01', posted_date: null, amount: '1000.0000',
    transaction_type: 'credit', description: 'Deposito inicial', bank_transaction_id: null,
    content_hash: 'aa'.repeat(32), is_matched: false,
  },
  {
    id: 'L2', transaction_date: '2026-07-15', posted_date: null, amount: '-250.0000',
    transaction_type: 'debit', description: 'Pago de servicio', bank_transaction_id: null,
    content_hash: 'bb'.repeat(32), is_matched: false,
  },
];

/** El responder de las lecturas de la familia. */
const lector =
  (over: { estado?: Record<string, unknown>; cuenta?: Record<string, unknown> } = {}) =>
  (text: string) => {
    if (/FROM bank_accounts b\b/.test(text)) return filas([cuentaMaestra(over.cuenta)]);
    if (/clabe_encrypted, clabe_last4/.test(text)) {
      return filas([{
        id: ACC, account_name: 'BBVA MXN', currency_code: 'MXN', account_type: 'checking',
        is_active: true, clabe_encrypted: null, clabe_last4: '4321',
        account_number_encrypted: null, account_number_last4: null, iban: null,
      }]);
    }
    // El orden importa: la proyección de `list`/`show` EMPIEZA por
    // `SELECT s.id, s.bank_account_id, …`, así que el patrón de la consulta de
    // objetivos de `check` tiene que exigir su FROM o se queda con las dos.
    if (/COALESCE\(l\.n, 0\)/.test(text)) return filas([estadoFila(over.estado)]);
    if (/SELECT s\.id, s\.bank_account_id\s+FROM bank_statements/.test(text)) {
      return filas([{ id: ST, bank_account_id: ACC }]);
    }
    if (/SELECT id, statement_number/.test(text)) return filas([]); // vecinos
    if (/bt\.content_hash/.test(text)) return filas(LINEAS);
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    return filas([]);
  };

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
});

describe('la frontera de entidad va DENTRO del SQL', () => {
  it('account list: entity_id es el primer predicado y el parámetro es la entidad', async () => {
    const r = await run(['bank', 'account', 'list'], lector());
    const sel = r.sql.filter((s) => /FROM bank_accounts b\b/.test(s.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) {
      expect(s.text.replace(/\s+/g, ' ')).toMatch(/WHERE b\.entity_id = \$1/);
      expect(s.params[0]).toBe('E1');
    }
    expect(r.exitCode).toBe(0);
  });

  it('account list --all-entities sigue acotando dentro del SQL, por inquilino', async () => {
    const r = await run(['bank', 'account', 'list', '--all-entities'], lector());
    const sel = r.sql.find((s) => /FROM bank_accounts b\b/.test(s.text));
    const texto = sel!.text.replace(/\s+/g, ' ');
    // Ni un `WHERE true` ni un filtro en JS: la lista de entidades del
    // inquilino se resuelve en la propia consulta.
    expect(texto).toMatch(
      /b\.entity_id IN \(SELECT id FROM legal_entities WHERE tenant_id = \$1\)/
    );
    expect(sel!.params[0]).toBe('T1');
    expect(r.exitCode).toBe(0);
  });

  it('statement show: las líneas se acotan por JOIN, porque la tabla no tiene entity_id', async () => {
    const r = await run(['bank', 'statement', 'show', ST, '--lines'], lector());
    // `bt.content_hash` sólo aparece en la consulta de LÍNEAS: la proyección
    // del estado también dice `FROM bank_transactions bt`, dentro de su lateral.
    const lineas = r.sql.find((s) => /bt\.content_hash/.test(s.text));
    const texto = lineas!.text.replace(/\s+/g, ' ');
    expect(texto).toMatch(/JOIN bank_accounts ba ON ba\.id = bt\.bank_account_id/);
    expect(texto).toMatch(/WHERE bt\.statement_id = \$1 AND ba\.entity_id = \$2/);
    expect(lineas!.params).toEqual([ST, 'E1', 500]);
    expect(r.exitCode).toBe(0);
  });
});

describe('ningún identificador sale entero', () => {
  it('show enmascara la CLABE a sus últimos 4', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN'], lector());
    expect(r.out).toContain('••••4321');
    expect(r.out).not.toMatch(/\d{10,}/);
    expect(r.exitCode).toBe(0);
  });

  it('--redacted quita incluso esos cuatro dígitos', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN', '--redacted'], lector());
    expect(r.out, 'ni el enmascarado').not.toContain('4321');
    expect(r.out).toContain('(redacted)');
    // Y lo que identifica al BANCO se queda: sin eso la ficha compartida no
    // sirve para lo único que se usa compartida.
    expect(r.out, 'la clave de banco del SAT sigue ahí').toContain('012');
  });

  it('en json, redactado y ausente son valores DISTINTOS', async () => {
    const r = await run(['bank', 'account', 'show', 'BBVA MXN', '--redacted', '--json'], lector());
    const payload = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    // La cuenta del caso tiene CLABE (…4321) y no tiene número de cuenta.
    // Colapsar los dos en '' haría que una cuenta SIN identificador —que es un
    // defecto que `show` debería denunciar— pasara por una cuenta discreta.
    expect(payload.rows[0].clabe).toBe('(redacted)');
    expect(payload.rows[0].account_number).toBe('');
    expect(payload.rows[0].sat_bank_code).toBe('012');
  });
});

describe('las banderas declaradas se leen', () => {
  it('--fields manda también en la salida por omisión, no sólo en json', async () => {
    const r = await run(['bank', 'account', 'list', '--fields', 'account,currency'], lector());
    const cabecera = r.out.split('\n')[0];
    expect(cabecera).toMatch(/^account\s+currency$/);
    expect(cabecera, 'y las columnas por omisión desaparecen').not.toContain('book_balance');
  });

  it('--fields a secas enumera los nombres disponibles', async () => {
    const r = await run(['bank', 'account', 'list', '--fields'], lector());
    expect(r.out.trim().split('\n')).toContain('gl_code');
  });

  it('--quiet escupe el uuid COMPLETO, que es lo que `show` acepta', async () => {
    const r = await run(['bank', 'account', 'list', '--quiet'], lector());
    expect(r.out.trim().split('\n')).toEqual([ACC]);
  });

  it('--offset se rechaza en voz alta en vez de ignorarse', async () => {
    const r = await run(['bank', 'account', 'list', '--offset', '10'], lector());
    expect(r.exitCode, 'error de uso, no fallo de ejecución').toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--offset no está implementado/);
  });

  it('-s/--status no aplica a un estado de cuenta y se dice', async () => {
    const r = await run(['bank', 'statement', 'list', '-s', 'open'], lector());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/no tiene estado de ciclo de vida/);
  });

  it('account list -s traduce los dos estados que sí existen', async () => {
    const r = await run(['bank', 'account', 'list', '-s', 'archived'], lector());
    const sel = r.sql.find((s) => /FROM bank_accounts b\b/.test(s.text));
    expect(sel!.text.replace(/\s+/g, ' ')).toMatch(/b\.is_active = \$\d/);
    expect(sel!.params).toContain(false);
    expect(r.exitCode).toBe(0);
  });

  it('statement show emite UN solo documento json, con las líneas anidadas', async () => {
    const r = await run(['bank', 'statement', 'show', ST, '--lines', '--json'], lector());
    // Dos `render` seguidos darían dos sobres pegados, y eso no es JSON.
    const payload = JSON.parse(r.out) as { count: number; rows: Array<Record<string, unknown>> };
    expect(payload.count).toBe(1);
    expect((payload.rows[0].lines as unknown[]).length).toBe(2);
    expect(payload.rows[0].sha256).toBe('ab'.repeat(32));
  });
});

describe('bank statement check sale 4 cuando ENCUENTRA algo', () => {
  it('sólo advertencias → 0, y con --strict → 4', async () => {
    const limpio = await run(['bank', 'statement', 'check', ST], lector());
    expect(limpio.exitCode, 'una advertencia no rompe un cierre').toBe(0);
    // La advertencia existe y es la de identidad: bank_statements no guarda la
    // cuenta que declaró el archivo, así que la prueba lo dice en vez de callar.
    expect(limpio.out).toMatch(/identidad/);

    const estricto = await run(['bank', 'statement', 'check', ST, '--strict'], lector());
    expect(estricto.exitCode).toBe(4);
  });

  it('una cadena de saldos rota → 4, y nombra la prueba que rompió', async () => {
    const r = await run(
      ['bank', 'statement', 'check', ST],
      lector({ estado: { closing_balance: '999.0000', suma_lineas: '750.0000' } })
    );
    expect(r.exitCode, '4 es «encontré algo», no «fallé»').toBe(4);
    expect(r.out).toMatch(/cadena-de-saldos/);
    expect(r.out, 'con la diferencia dentro').toMatch(/249\.00/);
  });

  it('--check a secas enumera la batería sin tocar la base', async () => {
    const r = await run(['bank', 'statement', 'check', '--check'], lector());
    expect(r.sql, 'la pregunta «qué se puede verificar» no cuesta una conexión').toEqual([]);
    expect(r.out).toContain('huecos-y-traslapes');
    expect(r.exitCode).toBe(0);
  });

  it('un nombre de prueba inventado se rechaza nombrando las siete', async () => {
    const r = await run(['bank', 'statement', 'check', ST, '--check', 'inventada'], lector());
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/Disponibles: cadena-de-saldos/);
  });
});

describe('las escrituras piden lo que el catálogo promete', () => {
  it('edit de un identificador sin --reason es error de USO y no llega a la base', async () => {
    const r = await run(
      ['bank', 'account', 'edit', 'BBVA MXN', '--clabe', '012180012345678901'],
      lector()
    );
    expect(r.exitCode, 'falta una bandera: 2, no una validación fallida (4)').toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--clabe/);
    expect(r.sql.filter((s) => /UPDATE bank_accounts/.test(s.text))).toEqual([]);
  });

  it('un edit sin ninguna bandera de campo se niega en vez de escribir nada', async () => {
    const r = await run(['bank', 'account', 'edit', 'BBVA MXN'], lector());
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/Nada que cambiar/);
  });

  it('create con un --type inventado no llega a la base', async () => {
    const r = await run(
      ['bank', 'account', 'create', 'Nueva', '--bank', 'BBVA', '--gl-account', '1110',
        '--currency', 'MXN', '--type', 'chequera'],
      lector()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/petty-cash/);
    expect(r.sql.filter((s) => /INSERT INTO bank_accounts/.test(s.text))).toEqual([]);
  });

  it('create sin --gl-account no se deja registrar una cuenta sin mapeo', async () => {
    // El mapeo 1:1 con el mayor es lo que hace que la conciliación signifique
    // algo; una cuenta bancaria sin él nace inservible. Es `requiredOption`
    // justo por eso, y esta prueba fija que lo siga siendo.
    responder = lector();
    const p = new Command('mnemosine').exitOverride();
    registerBankCommand(p, behaviorDeps);
    await expect(
      p.parseAsync(['node', 'mnemosine', 'bank', 'account', 'create', 'Nueva',
        '--bank', 'BBVA', '--currency', 'MXN'])
    ).rejects.toThrow(/--gl-account/);
  });

  it('set --force sin --reason lo para la compuerta del núcleo', async () => {
    const r = await run(
      ['bank', 'account', 'set', 'BBVA MXN', '--gl-account', '1110', '--force'],
      lector()
    );
    expect(r.exitCode).toBe(2);
    expect((r.errs[0] as Error).message).toMatch(/--force overrides a safety rule/);
  });
});

// ---- import: el cableado completo, con un CSV de verdad -------------

describe('bank statement import', () => {
  let dir: string;
  let archivo: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnemosine-bank-'));
    archivo = join(dir, 'julio.csv');
    writeFileSync(
      archivo,
      [
        'fecha,descripcion,importe,saldo',
        '2026-07-01,Deposito inicial,1000.00,1000.00',
        '2026-07-15,Pago de servicio,-250.00,750.00',
      ].join('\n') + '\n',
      'utf8'
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const respImport = (text: string, params: unknown[]) => {
    if (/SELECT id, account_name FROM bank_accounts/.test(text)) {
      return filas([{ id: ACC, account_name: 'BBVA MXN' }]);
    }
    if (/clabe_encrypted, clabe_last4/.test(text)) {
      return filas([{
        id: ACC, account_name: 'BBVA MXN', currency_code: 'MXN', account_type: 'checking',
        is_active: true, clabe_encrypted: null, clabe_last4: '4321',
        account_number_encrypted: null, account_number_last4: null, iban: null,
      }]);
    }
    if (/INSERT INTO bank_transactions/.test(text)) {
      return { rows: [], rowCount: params.length / 11 };
    }
    if (/FROM legal_entities WHERE id = \$1/.test(text)) return filas([{ tenant_id: 'T1' }]);
    return filas([]);
  };

  it('lee el CSV de verdad, escribe el estado y sus líneas, y nada más', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC],
      respImport
    );
    expect(r.errs, 'sin errores').toEqual([]);
    expect(r.exitCode).toBe(0);

    const estado = r.sql.filter((s) => /INSERT INTO bank_statements/.test(s.text));
    expect(estado.length, 'un estado por archivo').toBe(1);
    // El parser derivó los saldos del saldo corrido: 1000 − 1000 = 0 de
    // apertura, 750 de cierre. Y el periodo son las fechas EXTREMAS de las
    // líneas —un CSV no publica periodo—, así que cierra el 15 y no el 31: es
    // el dato que `--closing-balance` y el estado en papel están para corregir.
    expect(estado[0].params).toEqual(
      expect.arrayContaining([
        'E1', ACC, '2026-07-01', '2026-07-15', '0.0000', '750.0000', 'MXN',
        'csv', 'generico', 'julio.csv', 'U1',
      ])
    );
    // Los saldos salen con la precisión de la columna (DECIMAL(19,4)) porque
    // el importe no se reformatea aquí: redondear dinero en la superficie es
    // exactamente donde se pierde el centavo que nadie encuentra después.
    expect(r.out).toMatch(/0\.0000 → 750\.0000 MXN/);

    const lineas = r.sql.filter((s) => /INSERT INTO bank_transactions/.test(s.text));
    expect(lineas.length).toBe(1);
    expect(lineas[0].params.length / 11, 'las dos líneas del archivo').toBe(2);
  });

  it('NUNCA manda content_hash: lo calcula el disparador de la 051', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC],
      respImport
    );
    const insert = r.sql.find((s) => /INSERT INTO bank_transactions/.test(s.text));
    // Un hash que el llamador provee es un hash que el llamador puede falsear,
    // y entonces uq_bank_tx_contenido deja de significar «esta línea ya está».
    expect(insert!.text).not.toMatch(/content_hash/);
  });

  it('el mismo archivo nombrado dos veces entra UNA vez', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--dir', dir, '--account', ACC],
      respImport
    );
    // Sin la deduplicación por ruta absoluta, la segunda pasada moriría contra
    // UNIQUE(bank_account_id, file_sha256): un conflicto inventado por la línea
    // de órdenes.
    expect(r.sql.filter((s) => /INSERT INTO bank_statements/.test(s.text)).length).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  it('--dry-run parsea, verifica y no deja nada escrito', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--dry-run'],
      respImport
    );
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/julio\.csv/);
    // El INSERT sí corre —es lo que prueba que el índice único lo aceptaría—
    // pero la transacción se deshace; lo que esta prueba fija es que el
    // resultado se reporta como ENSAYO y no como un import consumado.
    expect(r.out).not.toMatch(/^✔/m);
  });

  it('--format json se rechaza: en `import` --format es el formato del ARCHIVO', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--format', 'json'],
      respImport
    );
    expect(r.exitCode).toBe(4);
    expect((r.errs[0] as Error).message).toMatch(/no es un formato de estado de cuenta/);
  });

  it('un formato del catálogo sin lector dice «espera», no «corrige»', async () => {
    const r = await run(
      ['bank', 'statement', 'import', archivo, '--account', ACC, '--format', 'ofx'],
      respImport
    );
    expect((r.errs[0] as Error).message).toMatch(/está en el catálogo pero todavía no tiene lector/);
  });

  it('sin archivos, error de uso', async () => {
    const r = await run(
      ['bank', 'statement', 'import', join(dir, 'no-existe.csv'), '--account', ACC],
      respImport
    );
    expect(r.exitCode, 'ENOENT del lector de archivo, no un 0 silencioso').not.toBe(0);
  });
});
