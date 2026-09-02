import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
// `vi.mock` se iza por encima de los imports, así que el estático ya ve los
// dobles. El archivo nació con `await import(...)` de nivel superior, que no
// compila bajo CommonJS y hacía fallar `tsc -p tsconfig.test.json` — una
// prueba que no typechequea es una prueba que nadie va a mantener.
import { registerBillCommand } from '../../src/cli/bill-command.js';

// ---- mocks --------------------------------------------------------
const sql: Array<{ text: string; params: unknown[] }> = [];
let responder: (text: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

vi.mock('../../src/database/connection.js', () => ({
  query: (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    return Promise.resolve(responder(text, params));
  },
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () =>
    Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));

const processSpy = vi.fn();
vi.mock('../../src/services/xml-ingestion/pre-registration-service.js', async () => {
  const real = await vi.importActual<
    typeof import('../../src/services/xml-ingestion/pre-registration-service.js')
  >('../../src/services/xml-ingestion/pre-registration-service.js');
  return {
    ...real,
    PreRegistrationService: class {
      processToAccounting(...args: unknown[]) {
        return processSpy(...args) as unknown;
      }
    },
  };
});

const ID = '11111111-1111-1111-1111-111111111111';

function fila(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    external_reference: 'A-1',
    document_date: '2026-07-01',
    total_amount: '1160.0000',
    currency_code: 'MXN',
    status: 'ready',
    processing_mode: 'manual',
    requires_approval: false,
    approval_status: null,
    validation_status: 'valid',
    is_new_vendor: false,
    document_type: 'bill',
    error_message: null,
    vendor_name: 'Proveedor SA',
    suggested_vendor_name: null,
    emisor_rfc: 'AAA010101AAA',
    emisor_nombre: 'Proveedor SA',
    ...over,
  };
}

let exitCode: number | undefined;
let errs: unknown[] = [];
const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: (c: number) => { exitCode = c; },
  reportError: (e: unknown) => { errs.push(e); },
  confirm: () => Promise.resolve(true),
};

async function run(argv: string[], resp: typeof responder, impl?: (...a: unknown[]) => unknown) {
  sql.length = 0;
  errs = [];
  exitCode = undefined;
  // OJO: aquí NO se resetea el espía. Lo hacía, y borraba el
  // `mockResolvedValue` que la prueba acababa de poner una línea antes —el
  // orden es «configura, luego ejecuta»—, así que el servicio devolvía
  // `undefined` y el comando salía con 1 por una razón inventada por el
  // andamio. El reseteo vive en `beforeEach`, que corre cuando debe.
  if (impl) processSpy.mockImplementation(impl);
  responder = resp;
  const program = new Command('mnemosine').exitOverride();
  registerBillCommand(program, deps as never);
  await program.parseAsync(['node', 'mnemosine', ...argv]);
  return { exitCode, errs, sql: [...sql] };
}

const defaultResp = (rows: unknown[]) => (text: string) => {
  // La relectura acotada por entidad devuelve LA MISMA fila del caso. Antes
  // devolvía `{ id, entity_id }` a secas, así que cualquier guardia que mire
  // el documento —su tipo, su aprobación— no tenía nada que mirar y la prueba
  // no podía distinguir «pasa el control» de «no hay control».
  const cruda = (rows[0] ?? {}) as Record<string, unknown>;
  if (/COUNT\(\*\) AS n/.test(text)) return { rows: [{ n: String(rows.length) }], rowCount: 1 };
  if (/FROM pre_registrations pr/.test(text)) return { rows, rowCount: rows.length };
  if (/^\s*SELECT \* FROM pre_registrations/.test(text)) {
    return {
      rows: [{ document_type: 'bill', requires_approval: false, ...cruda, entity_id: 'E1' }],
      rowCount: 1,
    };
  }
  if (/UPDATE pre_registrations/.test(text)) return { rows: [], rowCount: 1 };
  if (/FROM processing_batches/.test(text)) return { rows: [{ id: 'B1' }], rowCount: 1 };
  if (/FROM vendors/.test(text)) return { rows: [{ id: 'V1', company_name: 'Proveedor SA' }], rowCount: 1 };
  if (/idempotency_keys/.test(text)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
  processSpy.mockReset();
});

// ============================================================
// `bill inbox`, contra el rulebook y contra el hueco de control.
//
// Lo que de verdad se vigila aquí no es que el comando imprima: es que
// `--allow-new-vendor` VIAJE hasta el servicio y que su ausencia signifique
// `false`. Un CFDI que llega de fuera no puede dar de alta a su propio
// emisor, y esta es la prueba que lo sujeta desde la superficie.
// ============================================================
describe('bill inbox', () => {
  it('list: entity_id is the first predicate', async () => {
    const r = await run(['bill', 'inbox', 'list'], defaultResp([fila()]));
    const sel = r.sql.filter((s) => /FROM pre_registrations pr/.test(s.text));
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) expect(s.text).toMatch(/WHERE pr\.entity_id = \$1/);
    expect(r.exitCode).toBe(0);
  });

  it('run process: passes allow-new-vendor through', async () => {
    const r = await run(
      ['bill', 'inbox', 'run', ID, '--allow-new-vendor', '--yes'],
      defaultResp([fila()]),
      () => Promise.resolve({ bill: { bill_number: 'BILL-1' }, journalEntry: { entry_number: 'JE-1' } })
    );
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy.mock.calls[0][2]).toEqual({ permitirProveedorNuevo: true });
    expect(r.exitCode).toBe(0);
  });

  it('run process: default is false', async () => {
    await run(['bill', 'inbox', 'run', ID, '--yes'], defaultResp([fila()]),
      () => Promise.resolve({ bill: { bill_number: 'BILL-1' } }));
    expect(processSpy.mock.calls[0][2]).toEqual({ permitirProveedorNuevo: false });
  });

  it('run: dry-run writes nothing', async () => {
    const r = await run(['bill', 'inbox', 'run', ID, '--dry-run'], defaultResp([fila()]));
    expect(processSpy).not.toHaveBeenCalled();
    expect(r.sql.filter((s) => /UPDATE|INSERT/.test(s.text))).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('run approve: una fila suelta no pregunta, y esa es la regla', async () => {
    // `bill-command.ts:992` sólo pide confirmación cuando la acción es
    // `process` —la que postea— o cuando el lote toca más de una fila.
    // Aprobar UNA fila no contabiliza nada: marca el pre-registro como
    // aprobado y ahí acaba. Se fija la regla en las dos direcciones para que
    // nadie la relaje sin darse cuenta: aquí que NO pregunta, y en la prueba
    // de `process` de arriba que sí exige el paso por la compuerta.
    const confirms: string[] = [];
    const d = { ...deps, confirm: (q: string) => { confirms.push(q); return Promise.resolve(true); } };
    sql.length = 0; exitCode = undefined; errs = [];
    responder = defaultResp([fila({ requires_approval: true, approval_status: 'pending' })]);
    const program = new Command('mnemosine').exitOverride();
    registerBillCommand(program, d as never);
    await program.parseAsync(['node', 'mnemosine', 'bill', 'inbox', 'run', ID, '--action', 'approve']);

    expect(confirms, 'aprobar una fila no postea, así que no pasa por la compuerta').toEqual([]);
    const upd = sql.filter((s) => /UPDATE pre_registrations/.test(s.text));
    expect(upd.length, 'y sí escribe la aprobación').toBeGreaterThan(0);
    expect(upd.some((s) => /approval_status/.test(s.text))).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('un REP no se contabiliza por la familia `bill`: registraría cobros de clientes', async () => {
    // `processToAccounting` bifurca por document_type y manda 'payment' a
    // `procesarREP`, que para un REP EMITIDO registra CARTERA DE CLIENTES.
    // La bandeja no filtraba por tipo y la confirmación decía «cada uno nace
    // como factura POSTEADA»: el operador aprobaba una cosa y pasaba otra.
    const r = await run(
      ['bill', 'inbox', 'run', ID, '--yes'],
      defaultResp([fila({ document_type: 'payment' })]),
      () => Promise.resolve({ paymentId: 'P1' })
    );
    expect(processSpy, 'ni siquiera se llama al servicio').not.toHaveBeenCalled();
    expect(r.exitCode, 'el lote reporta el fallo, no lo silencia').not.toBe(0);
  });

  it('un pre-registro que exige aprobación no se contabiliza sin ella', async () => {
    // El listado pinta una columna `approval` y este mismo comando ofrece
    // `--action approve`; `process` la atravesaba sin mirarla y el gasto nacía
    // posteado con approved_by en NULL para siempre.
    const r = await run(
      ['bill', 'inbox', 'run', ID, '--yes'],
      defaultResp([fila({ requires_approval: true, approval_status: 'pending' })])
    );
    expect(processSpy).not.toHaveBeenCalled();
    expect(r.exitCode).not.toBe(0);
  });

  it('y sí se contabiliza una vez aprobado', async () => {
    processSpy.mockResolvedValue({ bill: { bill_number: 'BILL-1' } });
    const r = await run(
      ['bill', 'inbox', 'run', ID, '--yes'],
      defaultResp([fila({ requires_approval: true, approval_status: 'approved' })])
    );
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(r.exitCode).toBe(0);
  });

  it('run: --query since/until land in SQL', async () => {
    const r = await run(
      ['bill', 'inbox', 'run', '--bulk', '--query', 'since=2026-07-01,until=2026-07-31', '--yes'],
      defaultResp([fila()]),
      () => Promise.resolve({ bill: { bill_number: 'B' } })
    );
    const sel = r.sql.find((s) => /FROM pre_registrations pr/.test(s.text) && !/COUNT/.test(s.text));
    // No basta con que las fechas aparezcan en los parámetros: tienen que
    // llegar como PREDICADO. Un `--query` que se analiza y se tira deja al
    // operador creyendo que acotó el lote cuando actuó sobre la bandeja
    // entera, que es justo lo que `--bulk` sin `--query` se niega a hacer.
    expect(sel, 'la consulta acotada tiene que existir').toBeDefined();
    const texto = sel!.text.replace(/\s+/g, ' ');
    expect(texto).toMatch(/pr\.entity_id = \$1/);
    expect(texto, 'since viaja como predicado, no sólo como parámetro').toMatch(/pr\.document_date >= \$2/);
    expect(texto, 'until también').toMatch(/pr\.document_date <= \$3/);
    expect(sel!.params.slice(0, 3)).toEqual(['E1', '2026-07-01', '2026-07-31']);
  });

  it('run: failure that needs a human → exit 11', async () => {
    const err = Object.assign(new Error('falta autorizar'), { code: 'PROVEEDOR_NUEVO_SIN_AUTORIZAR', statusCode: 422 });
    const r = await run(['bill', 'inbox', 'run', ID, '--yes'], defaultResp([fila()]),
      () => Promise.reject(err));
    // 11 es NEEDS_HUMAN en el contrato de códigos de `kernel/exit.ts`: el
    // trabajo no falló, espera a una persona. Un 1 genérico aquí haría que un
    // cron no pudiera distinguir «hay que autorizar un proveedor» de «se cayó
    // la base», que es la razón exacta por la que ese código existe.
    expect(r.exitCode, 'un proveedor sin autorizar espera a un humano, no es un fallo').toBe(11);
  });

  it('run: --bulk without --query is refused', async () => {
    const r = await run(['bill', 'inbox', 'run', '--bulk', '--yes'], defaultResp([fila()]));
    expect(r.exitCode, 'error de uso, no fallo de ejecución').toBe(2);
    expect(
      (r.errs[0] as Error | undefined)?.message,
      'y el mensaje dice el daño que evita, no sólo que se negó'
    ).toMatch(/--bulk sin --query/);
  });

  it('run set-batch: batch resolved in entity', async () => {
    const r = await run(
      ['bill', 'inbox', 'run', ID, '--action', 'set-batch', '--batch', '7', '--yes'],
      defaultResp([fila()])
    );
    const b = r.sql.find((s) => /processing_batches/.test(s.text));
    // El número de lote lo elige el operador y es de su entidad. Resolverlo
    // sin acotar dejaría mover un pre-registro al lote de OTRO cliente del
    // despacho con sólo acertar el número.
    expect(b, 'el lote se resuelve consultando, no confiando en el argumento').toBeDefined();
    expect(b!.text.replace(/\s+/g, ' '), 'y la entidad va DENTRO del SQL').toMatch(/entity_id = \$1/);
    expect(b!.params).toEqual(['E1', '7']);
    expect(r.exitCode).toBe(0);
  });

  it('list --json trae el id COMPLETO, que es el que `run` acepta', async () => {
    // `ref` son ocho caracteres y `run` exige el uuid entero. Sin el id en el
    // json, el agente —que lee esta fila en json porque está declarada
    // `agent: true`— no podía encadenar los dos comandos.
    //
    // Se lee la SALIDA, no el código de salida: comprobar que salió 0 no
    // distingue «trae el id» de «no lo trae».
    const escrito: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      escrito.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      await run(['bill', 'inbox', 'list', '--json'], defaultResp([fila()]));
    } finally {
      process.stdout.write = original;
    }
    const salida = escrito.join('');
    expect(salida, 'el uuid entero tiene que viajar en el json').toContain(ID);
    expect(JSON.parse(salida)).toBeTruthy();
  });

  it('list: --quiet emits full ids', async () => {
    // Igual que la prueba de `--json` de arriba: se lee la SALIDA, no el
    // código de salida. Comprobar que salió 0 no distingue «trae el id
    // entero» de «trae los ocho caracteres de `ref`», y de esa diferencia
    // depende que `bill inbox list -q | xargs -n1 mnemosine bill inbox run`
    // funcione — que es la razón por la que `--quiet` existe.
    const escrito: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      escrito.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(['bill', 'inbox', 'list', '--quiet'], defaultResp([fila()]));
    } finally {
      process.stdout.write = original;
    }
    const salida = escrito.join('');
    expect(salida, 'el uuid entero, no el `ref` de ocho caracteres').toContain(ID);
    expect(salida.trim().split('\n'), 'un id por renglón y nada más').toEqual([ID]);
    expect(r!.exitCode).toBe(0);
  });

  it('run: id from another entity → 404', async () => {
    const r = await run(['bill', 'inbox', 'run', ID, '--yes'], defaultResp([]));
    // 3 es NOT_FOUND. La frontera de entidad devuelve 404 SIEMPRE —nunca 403—
    // porque un 403 confirmaría que el pre-registro existe, y en un despacho
    // que lleva varios clientes ese es justo el dato que no se puede regalar.
    expect(r.exitCode, 'cruzar de entidad no existe; no es «prohibido»').toBe(3);
    expect((r.errs[0] as Error | undefined)?.message).toMatch(/no está en la bandeja/);
  });
});
