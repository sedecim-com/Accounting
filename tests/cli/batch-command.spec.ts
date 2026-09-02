import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { registerBatchCommand, type BatchCommandDeps } from '../../src/cli/batch-command.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { hashDeCarga } from '../../src/services/idempotency/idempotency-store.js';

// ============================================================
// La familia `batch`·`lote` contra el rulebook y contra sus promesas caras:
// el riesgo sale del catálogo (post y reverse tocan el mayor → IA ✗ sin
// excepción), `batch check` sale 4 cuando ENCUENTRA algo, el acto se ensaya
// antes de preguntar, la llave de idempotencia se honra, y la atestación se
// dispara tras el commit y jamás en ensayo ni en un hit de llave.
//
// Construir el programa ya es una prueba: `declareRisk` lanza en tiempo de
// REGISTRO, así que un `batch post` declarado con agente rompería este
// archivo en `beforeAll` y no en producción.
// ============================================================

// ---- dobles --------------------------------------------------------

// El SQL que registra el doble de conexión es el de la LLAVE de idempotencia:
// el servicio del lote está doblado entero (sus consultas las prueban las 31
// del spec del servicio), así que lo único que debe tocar la base desde aquí
// es `conLlave`.
const sql: Array<{ text: string; params: unknown[] }> = [];
let responder: (text: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

const registrar = (text: string, params: unknown[] = []) => {
  sql.push({ text, params });
  return Promise.resolve(responder(text, params));
};

vi.mock('../../src/database/connection.js', () => ({
  query: (text: string, params: unknown[] = []) => registrar(text, params),
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

// La atestación es lo ÚNICO que este comando importa del motor del mayor: el
// doble la registra para poder afirmar cuándo se disparó y, sobre todo,
// cuándo NO (ensayo, hit de idempotencia, aborto).
const arnes = vi.hoisted(() => ({
  atestadas: [] as Array<{ tenantId: string; entityId: string; entryId: string }>,
}));

vi.mock('../../src/services/accounting/posting.js', () => ({
  attestEntryAsync: (tenantId: string, entityId: string, entryId: string) => {
    arnes.atestadas.push({ tenantId, entityId, entryId });
  },
}));

// El servicio del lote, doblado FUNCIÓN POR FUNCIÓN pero con sus constantes
// reales: si el vocabulario cerrado (estados, clases, categorías) cambiara,
// estas pruebas deben ver el cambio, no una copia congelada aquí.
const servicio = vi.hoisted(() => ({
  listBatches: vi.fn(),
  showBatch: vi.fn(),
  checkBatch: vi.fn(),
  postBatch: vi.fn(),
  reverseBatch: vi.fn(),
}));

vi.mock('../../src/services/accounting/batch-service.js', async () => {
  const real = await vi.importActual<
    typeof import('../../src/services/accounting/batch-service.js')
  >('../../src/services/accounting/batch-service.js');
  return { ...real, ...servicio };
});

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

// ---- programa y auditoría (estructura) -----------------------------

let program: Command;
let violations: ReturnType<typeof auditProgram>;
/**
 * El riesgo se fotografía en tiempo de registro a propósito: el registro es un
 * mapa de módulo que cualquier suite puede vaciar con `resetDeclarations()`, y
 * lo honesto es afirmar sobre lo que ESTE programa declaró al construirse.
 */
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = ['batch list', 'batch show', 'batch check', 'batch post', 'batch reverse'];

beforeAll(() => {
  program = new Command('mnemosine');
  registerBatchCommand(program, deps);
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
    expect(program.commands.map((c) => c.name())).toEqual(['batch']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ships exactly the five phase-1 leaves, each ending in a verb from the closed list', () => {
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

  it('no inventa `batch preview` (fase 2) ni `batch discard` (sin fila de catálogo)', () => {
    // `discard` existe en el CHECK de la 045; que no exista aquí es una
    // decisión reportada, no un olvido. `preview` es fase 2 y del integrador.
    const nombres = find('batch').commands.map((c) => c.name());
    expect(nombres).not.toContain('preview');
    expect(nombres).not.toContain('discard');
    expect(nombres).not.toContain('dismiss');
  });

  it('las tres grafías nuevas quedaron congeladas en el diccionario, sin forma corta', () => {
    for (const flag of ['--kind', '--partial', '--errors-only']) {
      expect(Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, flag), flag).toBe(true);
      expect(FLAG_DICTIONARY[flag], flag).toBeNull();
    }
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    batch: 'lote',
    'batch list': 'listar',
    'batch show': 'ver',
    'batch check': 'verificar',
    'batch post': 'contabilizar',
    'batch reverse': 'reversar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every leaf', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      if (find(path).commands.length > 0) continue;
      const verb = path.split(' ').pop() as string;
      expect(alias, path).toBe(VERBS[verb]);
    }
  });
});

describe('safety declarations — el riesgo sale del catálogo', () => {
  it('list, show y check son lectura con agente; check mueve estado pero no toca el mayor', () => {
    for (const path of ['batch list', 'batch show', 'batch check']) {
      expect(risks.get(path)?.risk, path).toBe('lectura');
      expect(risks.get(path)?.agentAllowed, path).toBe(true);
    }
  });

  it('post y reverse son irreversibles e IA ✗ sin excepción: postean y espejan el mayor', () => {
    for (const path of ['batch post', 'batch reverse']) {
      expect(risks.get(path)?.risk, path).toBe('irreversible');
      expect(risks.get(path)?.agentAllowed, path).toBe(false);
    }
  });

  it('las dos hojas irreversibles llevan las tres banderas del núcleo', () => {
    for (const path of ['batch post', 'batch reverse']) {
      const longs = find(path).options.map((o) => o.long);
      expect(longs, path).toEqual(
        expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key'])
      );
    }
  });

  it('reverse lleva --reason (verbo de deshacer) y post lleva --partial', () => {
    expect(find('batch reverse').options.map((o) => o.long)).toContain('--reason');
    expect(find('batch post').options.map((o) => o.long)).toContain('--partial');
  });

  it('would REFUSE to ship if someone let the agent post a batch', () => {
    expect(() =>
      declareRisk(new Command('batch post'), { risk: 'irreversible', agent: true })
    ).toThrow(/permission must never depend on the value of a flag/);
  });
});

describe('list carries the full read groups', () => {
  it('se puede paginar, formatear y acotar: nada trunca en silencio', () => {
    const longs = find('batch list').options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(['--limit', '--format', '--json', '--fields', '--since', '--kind', '--status'])
    );
  });

  it('show lleva --errors-only y check lleva --check y --strict, como promete el catálogo', () => {
    expect(find('batch show').options.map((o) => o.long)).toContain('--errors-only');
    const check = find('batch check').options.map((o) => o.long);
    expect(check).toEqual(expect.arrayContaining(['--check', '--strict']));
  });
});

// ---- conducta ------------------------------------------------------

let exitCode: number | undefined;
let errs: unknown[] = [];
let out: string[] = [];
let err: string[] = [];
let confirmado: string[] = [];
let responderConfirmacion = true;

const behaviorDeps: BatchCommandDeps = {
  ...deps,
  shutdown: (c: number) => { exitCode = c; },
  reportError: (e: unknown) => { errs.push(e); },
  confirm: (q: string) => {
    confirmado.push(q);
    return Promise.resolve(responderConfirmacion);
  },
};

async function run(argv: string[], extra: Partial<BatchCommandDeps> = {}) {
  sql.length = 0;
  errs = [];
  out = [];
  err = [];
  confirmado = [];
  exitCode = undefined;
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine').exitOverride();
    registerBatchCommand(p, { ...behaviorDeps, ...extra });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return { exitCode, errs, sql: [...sql], out: out.join(''), err: err.join('') };
}

const B1 = 'aaaaaaaa-1111-2222-3333-444444444444';

function resumen(over: Record<string, unknown> = {}) {
  return {
    id: B1, kind: 'import', layout: 'csv', file_name: 'polizas.csv',
    file_hash: 'ab'.repeat(32), status: 'staged', rows_total: 3, rows_invalid: 1,
    entries_posted: 0, created_by: 'U1', created_at: new Date('2026-08-01T12:00:00Z'),
    ...over,
  };
}

function detalle(over: Record<string, unknown> = {}) {
  return {
    lote: resumen(),
    filas: [
      {
        row_number: 1, parse_error: null, categoria: null, date: '2026-08-01',
        description: 'Renta', lineas: 2, total_debe: '1000.0000',
        entry_id: 'JE1', entry_number: 'P-001', entry_reversed: false,
      },
      {
        row_number: 2, parse_error: 'fecha inválida "2026-13-01"', categoria: 'fecha',
        date: null, description: null, lineas: null, total_debe: null,
        entry_id: null, entry_number: null, entry_reversed: false,
      },
    ],
    errores_por_categoria: { fecha: 1 },
    ...over,
  };
}

const okFila = (n: number, advertencias: string[] = []) => ({
  row_number: n, ok: true, categoria: null, errores: [], advertencias,
});
const malaFila = (n: number, categoria: string, error: string) => ({
  row_number: n, ok: false, categoria, errores: [error], advertencias: [],
});

function aplicacion(over: Record<string, unknown> = {}) {
  return {
    batchId: B1, status: 'posted',
    posteadas: [
      { row_number: 1, entry_id: 'JE1', entry_number: 'P-001' },
      { row_number: 2, entry_id: 'JE2', entry_number: 'P-002' },
    ],
    ya_posteadas: 0, invalidas: [], total_debe: '2500.0000',
    attestations: [
      { entityId: 'E1', entryId: 'JE1' },
      { entityId: 'E1', entryId: 'JE2' },
    ],
    dryRun: false,
    ...over,
  };
}

function reversa(over: Record<string, unknown> = {}) {
  return {
    batchId: B1, status: 'posted',
    espejos: [
      { original: 'P-001', espejo: 'R-001', espejo_id: 'JR1' },
      { original: 'P-002', espejo: 'R-002', espejo_id: 'JR2' },
    ],
    attestations: [
      { entityId: 'E1', entryId: 'JR1' },
      { entityId: 'E1', entryId: 'JR2' },
    ],
    dryRun: false,
    ...over,
  };
}

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
  responder = () => ({ rows: [], rowCount: 1 });
  responderConfirmacion = true;
  arnes.atestadas.length = 0;
  servicio.listBatches.mockReset().mockResolvedValue([resumen()]);
  servicio.showBatch.mockReset().mockResolvedValue(detalle());
  servicio.checkBatch.mockReset();
  servicio.postBatch.mockReset();
  servicio.reverseBatch.mockReset();
});

describe('batch list · el contexto y los filtros llegan enteros al servicio', () => {
  it('pasa tenant+entity y los filtros exactamente como se teclearon', async () => {
    const r = await run(['batch', 'list', '--status', 'staged', '--kind', 'import',
      '--since', '2026-01-01', '-n', '10']);
    expect(r.exitCode).toBe(0);
    expect(servicio.listBatches).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' },
      { status: 'staged', kind: 'import', since: '2026-01-01', limit: 10 }
    );
  });

  it('rechaza el vocabulario del catálogo (pending…) como error de USO, nombrando el real', async () => {
    const r = await run(['batch', 'list', '--status', 'pending']);
    expect(r.exitCode).toBe(2);
    expect(servicio.listBatches).not.toHaveBeenCalled();
    expect(String(r.errs[0])).toMatch(/staged, checked, posted, discarded/);
  });

  it('rechaza dos estados a la vez en vez de honrar uno y callar el otro', async () => {
    const r = await run(['batch', 'list', '--status', 'staged', 'posted']);
    expect(r.exitCode).toBe(2);
    expect(servicio.listBatches).not.toHaveBeenCalled();
  });

  it('rechaza --until en voz alta: una bandera aceptada y no leída es una promesa incumplida', async () => {
    const r = await run(['batch', 'list', '--until', '2026-08-31']);
    expect(r.exitCode).toBe(2);
    expect(String(r.errs[0])).toMatch(/--since/);
    expect(servicio.listBatches).not.toHaveBeenCalled();
  });

  it('rechaza --offset: no hay cursor estable que lo honre', async () => {
    const r = await run(['batch', 'list', '--offset', '5']);
    expect(r.exitCode).toBe(2);
    expect(servicio.listBatches).not.toHaveBeenCalled();
  });

  it('--fields manda también en la salida por omisión, no sólo en json', async () => {
    const r = await run(['batch', 'list', '--fields', 'id,status']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('id');
    expect(r.out).toContain('staged');
    expect(r.out).not.toContain('polizas.csv');
  });

  it('avisa por stderr cuando la lista llenó el tope: puede haber más', async () => {
    servicio.listBatches.mockResolvedValue([resumen()]);
    const r = await run(['batch', 'list', '-n', '1']);
    expect(r.exitCode).toBe(0);
    expect(r.err).toMatch(/tope de --limit/);
  });
});

describe('batch show · la ficha del lote', () => {
  it('acota por (tenant, entity, id) — el id nunca viaja solo', async () => {
    await run(['batch', 'show', B1, '--json']);
    expect(servicio.showBatch).toHaveBeenCalledWith({ tenantId: 'T1', entityId: 'E1' }, B1);
  });

  it('--errors-only deja sólo las filas que el parser rechazó', async () => {
    const todo = await run(['batch', 'show', B1, '--json']);
    const conFiltro = await run(['batch', 'show', B1, '--errors-only', '--json']);
    const filasDe = (salida: string) =>
      (JSON.parse(salida) as { rows: Array<{ filas: Array<{ row_number: number }> }> }).rows[0].filas;
    expect(filasDe(todo.out)).toHaveLength(2);
    const filtradas = filasDe(conFiltro.out);
    expect(filtradas).toHaveLength(1);
    expect(filtradas[0].row_number).toBe(2);
  });

  it('la ficha humana enseña el error con su categoría y el conteo por categoría', async () => {
    const r = await run(['batch', 'show', B1]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/\[fecha\] fecha inválida/);
    expect(r.out).toMatch(/fecha=1/);
    expect(r.out).toMatch(/1 inválida\(s\)/);
  });
});

describe('batch check · sale 4 cuando ENCUENTRA algo, con la fila y su porqué', () => {
  it('hallazgo bloqueante → salida 4, y el informe nombra la fila, la categoría y la causa', async () => {
    servicio.checkBatch.mockResolvedValue({
      batchId: B1, status: 'staged', validas: 1, invalidas: 1,
      filas: [okFila(1), malaFila(2, 'cuenta', 'Account with id 9999 not found')],
    });
    const r = await run(['batch', 'check', B1]);
    expect(r.exitCode).toBe(4);
    expect(r.out).toMatch(/fila 2/);
    expect(r.out).toMatch(/\[cuenta\]/);
    expect(r.out).toMatch(/9999/);
  });

  it('limpio → salida 0 y el lote queda checked', async () => {
    servicio.checkBatch.mockResolvedValue({
      batchId: B1, status: 'checked', validas: 2, invalidas: 0,
      filas: [okFila(1), okFila(2)],
    });
    const r = await run(['batch', 'check', B1]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/queda 'checked'/);
  });

  it('advertencias sin --strict → salida 0; el endurecimiento vive en el servicio', async () => {
    servicio.checkBatch.mockResolvedValue({
      batchId: B1, status: 'checked', validas: 1, invalidas: 0,
      filas: [okFila(1, ['periodo por cerrar'])],
    });
    const r = await run(['batch', 'check', B1]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/periodo por cerrar/);
    // Y --strict viaja al servicio, que es quien reetiqueta: dos copias del
    // criterio divergirían en el primer cambio.
    await run(['batch', 'check', B1, '--strict']);
    expect(servicio.checkBatch).toHaveBeenLastCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1', { strict: true }
    );
  });

  it('--check acota el INFORME pero el código de salida cuenta lo escondido, y lo dice', async () => {
    servicio.checkBatch.mockResolvedValue({
      batchId: B1, status: 'staged', validas: 0, invalidas: 2,
      filas: [malaFila(2, 'cuenta', 'cuenta inexistente'), malaFila(3, 'periodo', 'periodo sin abrir')],
    });
    const r = await run(['batch', 'check', B1, '--check', 'periodo']);
    expect(r.exitCode).toBe(4);
    expect(r.out).toMatch(/fila 3/);
    expect(r.out).not.toMatch(/fila 2/);
    expect(r.err).toMatch(/quedaron fuera del informe/);
  });

  it('--check con una categoría inventada es error de USO y no corre nada', async () => {
    const r = await run(['batch', 'check', B1, '--check', 'saldo']);
    expect(r.exitCode).toBe(2);
    expect(servicio.checkBatch).not.toHaveBeenCalled();
    expect(String(r.errs[0])).toMatch(/parse, forma, cuenta, periodo, validacion/);
  });
});

describe('batch post · ensayo, pregunta con el total enfrente, y atestación tras el commit', () => {
  it('--dry-run recorre el camino real del servicio y NO atesta nada', async () => {
    servicio.postBatch.mockResolvedValue(aplicacion({ attestations: [], dryRun: true }));
    const r = await run(['batch', 'post', B1, '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(servicio.postBatch).toHaveBeenCalledTimes(1);
    expect(servicio.postBatch).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1', { partial: false, dryRun: true }
    );
    expect(arnes.atestadas).toEqual([]);
    expect(r.err).toMatch(/Ensayo/);
  });

  it('sin -y: ensaya, enseña cuántas pólizas y su total, pregunta, y sólo entonces escribe', async () => {
    servicio.postBatch
      .mockResolvedValueOnce(aplicacion({ attestations: [], dryRun: true }))
      .mockResolvedValueOnce(aplicacion());
    const r = await run(['batch', 'post', B1]);
    expect(r.exitCode).toBe(0);
    expect(servicio.postBatch).toHaveBeenCalledTimes(2);
    expect(servicio.postBatch).toHaveBeenNthCalledWith(
      2, { tenantId: 'T1', entityId: 'E1' }, B1, 'U1', { partial: false }
    );
    expect(confirmado).toHaveLength(1);
    expect(confirmado[0]).toMatch(/2 póliza\(s\)/);
    expect(confirmado[0]).toMatch(/2500\.0000/);
    // La atestación, UNA por póliza y después del commit.
    expect(arnes.atestadas).toEqual([
      { tenantId: 'T1', entityId: 'E1', entryId: 'JE1' },
      { tenantId: 'T1', entityId: 'E1', entryId: 'JE2' },
    ]);
  });

  it('la negativa aborta con 10 y el servicio de escritura no se llama', async () => {
    responderConfirmacion = false;
    servicio.postBatch.mockResolvedValue(aplicacion({ attestations: [], dryRun: true }));
    const r = await run(['batch', 'post', B1]);
    expect(r.exitCode).toBe(10);
    // Sólo el ensayo corrió; la escritura jamás.
    expect(servicio.postBatch).toHaveBeenCalledTimes(1);
    expect(servicio.postBatch.mock.calls[0][3]).toEqual({ partial: false, dryRun: true });
    expect(arnes.atestadas).toEqual([]);
  });

  it('con -y no hay ensayo previo: nadie va a leer la vista previa', async () => {
    servicio.postBatch.mockResolvedValue(aplicacion());
    const r = await run(['batch', 'post', B1, '-y']);
    expect(r.exitCode).toBe(0);
    expect(servicio.postBatch).toHaveBeenCalledTimes(1);
    expect(servicio.postBatch).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1', { partial: false }
    );
    expect(confirmado).toEqual([]);
  });

  it('--partial que deja filas atrás sale 4: no es un éxito silencioso', async () => {
    servicio.postBatch.mockResolvedValue(aplicacion({
      status: 'staged',
      invalidas: [malaFila(3, 'periodo', 'periodo sin abrir')],
    }));
    const r = await run(['batch', 'post', B1, '--partial', '-y']);
    expect(r.exitCode).toBe(4);
    expect(servicio.postBatch).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1', { partial: true }
    );
    expect(r.out).toMatch(/1 en staging/);
  });

  it('--idempotency-key se honra: consulta y graba la llave con la carga del acto', async () => {
    servicio.postBatch.mockResolvedValue(aplicacion());
    const r = await run(['batch', 'post', B1, '-y', '--idempotency-key', 'K1']);
    expect(r.exitCode).toBe(0);
    const lectura = r.sql.find((s) => /SELECT payload_hash, resultado FROM idempotency_keys/.test(s.text));
    expect(lectura?.params).toEqual(['T1', 'batch post', 'K1']);
    const escritura = r.sql.find((s) => /INSERT INTO idempotency_keys/.test(s.text));
    // `--partial` forma parte de la carga: entero y a medias son dos actos.
    expect(escritura?.params?.[4]).toBe(hashDeCarga(B1, 'post', false));
  });

  it('la misma llave con la misma carga devuelve lo grabado: ni postea ni re-atesta', async () => {
    responder = (text) =>
      /SELECT payload_hash, resultado FROM idempotency_keys/.test(text)
        ? {
            rows: [{
              payload_hash: hashDeCarga(B1, 'post', false),
              resultado: { v: aplicacion() },
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 1 };
    const r = await run(['batch', 'post', B1, '-y', '--idempotency-key', 'K1']);
    expect(r.exitCode).toBe(0);
    expect(servicio.postBatch).not.toHaveBeenCalled();
    expect(arnes.atestadas).toEqual([]);
    expect(r.err).toMatch(/Idempotency hit/);
  });
});

describe('batch reverse · la unidad entera, con motivo y espejos enfrente', () => {
  it('sin --reason y sin --dry-run es error de USO: el kernel lo exige antes de tocar nada', async () => {
    const r = await run(['batch', 'reverse', B1, '-y']);
    expect(r.exitCode).toBe(2);
    expect(servicio.reverseBatch).not.toHaveBeenCalled();
  });

  it('--dry-run sin --reason ensaya con el marcador: el servicio exige motivo y el ensayo se revierte', async () => {
    servicio.reverseBatch.mockResolvedValue(reversa({ attestations: [], dryRun: true }));
    const r = await run(['batch', 'reverse', B1, '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(servicio.reverseBatch).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1',
      { reason: '(ensayo sin --reason)', asOf: undefined, dryRun: true }
    );
    expect(arnes.atestadas).toEqual([]);
  });

  it('sin -y enseña las pólizas que va a espejar y pregunta nombrando cuántas', async () => {
    servicio.reverseBatch
      .mockResolvedValueOnce(reversa({ attestations: [], dryRun: true }))
      .mockResolvedValueOnce(reversa());
    const r = await run(['batch', 'reverse', B1, '--reason', 'lote duplicado']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/P-001 → R-001/);
    expect(r.out).toMatch(/P-002 → R-002/);
    expect(confirmado[0]).toMatch(/2 espejo\(s\)/);
    expect(servicio.reverseBatch).toHaveBeenNthCalledWith(
      2, { tenantId: 'T1', entityId: 'E1' }, B1, 'U1',
      { reason: 'lote duplicado', asOf: undefined }
    );
    expect(arnes.atestadas).toEqual([
      { tenantId: 'T1', entityId: 'E1', entryId: 'JR1' },
      { tenantId: 'T1', entityId: 'E1', entryId: 'JR2' },
    ]);
  });

  it('--as-of viaja al servicio y entra en la carga de la llave; el texto del motivo no', async () => {
    servicio.reverseBatch.mockResolvedValue(reversa());
    const r = await run(['batch', 'reverse', B1, '-y', '--reason', 'error de layout',
      '--as-of', '2026-08-31', '--idempotency-key', 'K2']);
    expect(r.exitCode).toBe(0);
    expect(servicio.reverseBatch).toHaveBeenCalledWith(
      { tenantId: 'T1', entityId: 'E1' }, B1, 'U1',
      { reason: 'error de layout', asOf: '2026-08-31' }
    );
    const escritura = r.sql.find((s) => /INSERT INTO idempotency_keys/.test(s.text));
    expect(escritura?.params?.[4]).toBe(hashDeCarga(B1, 'reverse', '2026-08-31'));
  });

  it('el lote sigue posted después de reversar: la verdad vive en reversed_by_entry_id', async () => {
    servicio.reverseBatch.mockResolvedValue(reversa());
    const r = await run(['batch', 'reverse', B1, '-y', '--reason', 'motivo']);
    expect(r.out).toMatch(/sigue 'posted'/);
  });
});
