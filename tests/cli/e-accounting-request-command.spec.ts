import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerEAccountingCommand } from '../../src/cli/e-accounting-command.js';
import {
  requestFromFlags,
  requirePeriod,
  subledgerKindOf,
  type RequestFileEngine,
} from '../../src/cli/e-accounting-request-command.js';
import { avisarRastroIncompleto } from '../../src/cli/payment-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, ExitCode, exitCodeFor } from '../../src/cli/kernel/index.js';
import { commandCitations } from '../../src/plan/criteria/e5-1.js';

// ============================================================
// MNE-001-054 (#328) · `e-accounting voucher generate` and
// `e-accounting subledger generate` at the terminal, with the Anexo 24 engine
// replaced by a double. The engine and the XSD are proven against Postgres in
// tests/integration/mne-001-054-request-files.int.spec.ts; here: the flags,
// the hand-over to the engine, the exit codes and what reaches the disk.
// ============================================================

const world = vi.hoisted(() => ({
  vouchers: undefined as unknown,
  subledger: undefined as unknown,
  lastVouchers: undefined as unknown,
  lastSubledger: undefined as unknown,
  calls: 0,
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: (id?: string) =>
    Promise.resolve({
      tenantId: 'T1',
      entityId: id ?? 'E1',
      entityName: 'Acme SA de CV',
      currency: 'MXN',
      country: 'MX',
      accountingStandard: 'NIF',
      taxId: 'AAA010101AAA',
    }),
  listEntities: () => Promise.resolve([{ id: 'E1' }]),
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U-1', email: 'contador@despacho.mx' }),
}));

/** The engine double, handed in through the command's test seam. */
const engine = {
  vouchers: (entityId: string, opts: unknown) => {
    world.calls += 1;
    world.lastVouchers = { entityId, opts };
    return Promise.resolve(world.vouchers);
  },
  subledger: (entityId: string, kind: string, opts: unknown) => {
    world.calls += 1;
    world.lastSubledger = { entityId, kind, opts };
    return Promise.resolve(world.subledger);
  },
} as unknown as RequestFileEngine;

const plain = {
  dim: (s: string) => s,
  bold: (s: string) => s,
  cyan: (s: string) => s,
  red: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
};

const META = {
  tenant_id: 'T1',
  entity_id: 'E1',
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '07',
  period_name: 'Julio 2026',
  desde: '2026-07-01',
  hasta: '2026-07-31',
  polizas: 2,
  transacciones: 5,
  con_rastro: 1,
  criterio_sellado: 'nunca_sellar_en_el_sistema',
  sellada: false,
  bancos_sembrados: true,
};

const XML_VOUCHERS = '<?xml version="1.0" encoding="UTF-8"?>\n<PLZ:Polizas Version="1.3"/>';
const XML_AUX = '<?xml version="1.0" encoding="UTF-8"?>\n<RepAuxFol:RepAuxFol Version="1.3"/>';

function vouchers(over: Record<string, unknown> = {}) {
  return {
    xml: XML_VOUCHERS,
    hash: 'ab'.repeat(32),
    bytes: Buffer.byteLength(XML_VOUCHERS, 'utf8'),
    nombre: 'AAA010101AAA202607PL.XML',
    meta: META,
    hallazgos: [],
    conteo: { blocking: 0, warning: 0 },
    puedeEntregarse: true,
    totales: { debe: '1160.00', haber: '1160.00' },
    artefacto: { id: 'ART-9', hash_sha256: 'ab'.repeat(32), bytes: 64, generado_en: 'x', yaExistia: false },
    notaDeSellado: 'SIN SELLAR',
    ...over,
  };
}

function subledger(over: Record<string, unknown> = {}) {
  return {
    clase: 'folios',
    xml: XML_AUX,
    hash: 'cd'.repeat(32),
    bytes: Buffer.byteLength(XML_AUX, 'utf8'),
    nombre: 'AAA010101AAA202607XF.XML',
    meta: META,
    artefacto: null,
    notaDeSellado: 'SIN SELLAR',
    ...over,
  };
}

beforeEach(() => {
  world.calls = 0;
  world.lastVouchers = undefined;
  world.lastSubledger = undefined;
  world.vouchers = vouchers();
  world.subledger = subledger();
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mne054-cli-'));
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine').exitOverride();
    registerEAccountingCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
      confirm: () => Promise.resolve(false),
      requestFileEngine: engine,
    });
    await p.parseAsync(['node', 'mnemosine', 'e-accounting', ...argv, '-e', 'E1']);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

const AUDIT = ['--request-type', 'AF', '--order-number', 'ABC1234567/26'];

// ---- the request header, checked before the database ----------------

describe('requestFromFlags: TipoSolicitud and its number, never a default', () => {
  it('AF and FC take the order number; DE and CO the procedure number', () => {
    expect(requestFromFlags({ requestType: 'af', orderNumber: ' ABC1234567/26 ' })).toEqual({
      tipo: 'AF',
      numOrden: 'ABC1234567/26',
    });
    expect(requestFromFlags({ requestType: 'DE', procedureNumber: 'DE202600000009' })).toEqual({
      tipo: 'DE',
      numTramite: 'DE202600000009',
    });
  });

  it('refuses as a usage error (2): no type, an unknown type, the wrong number, a bad shape', () => {
    const cases = [
      {},
      { requestType: 'XX', orderNumber: 'ABC1234567/26' },
      { requestType: 'AF' },
      { requestType: 'AF', orderNumber: 'ABC1234567/26', procedureNumber: 'DE202600000009' },
      { requestType: 'CO', orderNumber: 'ABC1234567/26' },
      { requestType: 'FC', orderNumber: '1234' },
      { requestType: 'DE', procedureNumber: 'DE2026' },
    ];
    for (const c of cases) {
      let caught: unknown;
      try {
        requestFromFlags(c);
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(c)).toBeDefined();
      expect(exitCodeFor(caught), JSON.stringify(c)).toBe(ExitCode.USAGE);
    }
  });

  it('asks for the month unless --closing names month 13', () => {
    expect(() => requirePeriod({})).toThrow();
    expect(() => requirePeriod({ period: '2026-07' })).not.toThrow();
    expect(() => requirePeriod({ closing: true })).not.toThrow();
  });

  it('--kind is folios or accounts, with no default', () => {
    expect(subledgerKindOf('Folios')).toBe('folios');
    expect(subledgerKindOf('accounts')).toBe('accounts');
    for (const bad of [undefined, '', 'cuentas']) {
      expect(() => subledgerKindOf(bad), String(bad)).toThrow();
    }
  });
});

// ---- the tree ----------------------------------------------------------

describe('the two leaves exist where the catalog puts them', () => {
  const program = new Command('mnemosine');
  registerEAccountingCommand(program, {
    palette: plain,
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const family = program.commands.find((c) => c.name() === 'e-accounting');
  const leaf = (group: string) =>
    family?.commands.find((c) => c.name() === group)?.commands.find((c) => c.name() === 'generate');

  it('voucher·poliza generate·generar and subledger·auxiliar generate·generar', () => {
    const voucher = family?.commands.find((c) => c.name() === 'voucher');
    const aux = family?.commands.find((c) => c.name() === 'subledger');
    expect(voucher?.aliases()).toContain('poliza');
    expect(aux?.aliases()).toContain('auxiliar');
    expect(leaf('voucher')?.aliases()).toContain('generar');
    expect(leaf('subledger')?.aliases()).toContain('generar');
  });

  it('write only the archived artifact: escritura, agent allowed with draftOnly', () => {
    for (const g of ['voucher', 'subledger']) {
      const r = riskOf(leaf(g) as Command);
      expect(r?.risk, g).toBe('escritura');
      expect(r?.agentAllowed, g).toBe(true);
      expect(r?.draftOnly, g).toBe(true);
      expect(r?.writes, g).toMatch(/sat_anexo24_artefactos/);
    }
  });

  it('carry the catalog flags plus the request header', () => {
    const common = ['--period', '--closing', '--request-type', '--order-number', '--procedure-number', '--dry-run', '--output', '--yes'];
    expect(leaf('voucher')?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([...common, '--validate-uuids'])
    );
    expect(leaf('subledger')?.options.map((o) => o.long)).toEqual(expect.arrayContaining([...common, '--kind']));
  });

  it('pass the consistency audit', () => {
    expect(auditProgram(program)).toEqual([]);
  });
});

// ---- behaviour ---------------------------------------------------------

describe('voucher generate', () => {
  it('hands period, request, --validate-uuids and --dry-run to the engine and writes nothing', async () => {
    const target = path.join(tmpRoot, 'dry.xml');
    const r = await run(['voucher', 'generate', '--period', '2026-07', ...AUDIT, '--validate-uuids', '--dry-run', '-o', target]);
    expect(r.exitCode, String(r.errs[0])).toBe(ExitCode.OK);
    expect(world.lastVouchers).toEqual({
      entityId: 'E1',
      opts: {
        periodo: '2026-07',
        solicitud: { tipo: 'AF', numOrden: 'ABC1234567/26' },
        validarUuids: true,
        generadoPor: 'U-1',
        dryRun: true,
      },
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('writes the exact bytes the engine hashed when the file is deliverable', async () => {
    const target = path.join(tmpRoot, 'nested', 'polizas.xml');
    const r = await run(['voucher', 'generate', '--period', '2026-07', ...AUDIT, '-o', target, '--json']);
    expect(r.exitCode, String(r.errs[0])).toBe(ExitCode.OK);
    expect(fs.readFileSync(target, 'utf8')).toBe(XML_VOUCHERS);
    const row = (JSON.parse(r.out) as { rows: Record<string, unknown>[] }).rows[0];
    expect(row).toMatchObject({ request_type: 'AF', order_number: 'ABC1234567/26', sealed: false, deliverable: true, archived: 'new' });
  });

  it('a blocking finding exits 4, names the voucher and leaves no file on disk', async () => {
    world.vouchers = vouchers({
      puedeEntregarse: false,
      conteo: { blocking: 1, warning: 0 },
      artefacto: null,
      hallazgos: [
        { check: 'poliza-con-dinero-sin-rastro', severity: 'blocking', referencia: 'JE-0042', detalle: 'sin cuenta destino' },
      ],
    });
    const target = path.join(tmpRoot, 'blocked.xml');
    const r = await run(['voucher', 'generate', '--period', '2026-07', ...AUDIT, '-o', target]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.err).toMatch(/poliza-con-dinero-sin-rastro\s+JE-0042/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses before the database without a request type (2)', async () => {
    const r = await run(['voucher', 'generate', '--period', '2026-07']);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(world.calls).toBe(0);
  });
});

describe('subledger generate', () => {
  it('hands the kind and the request to the engine and writes the file', async () => {
    const target = path.join(tmpRoot, 'aux.xml');
    const r = await run([
      'subledger', 'generate', '--period', '2026-07', '--kind', 'folios',
      '--request-type', 'CO', '--procedure-number', 'CO202600000011', '-o', target,
    ]);
    expect(r.exitCode, String(r.errs[0])).toBe(ExitCode.OK);
    expect(world.lastSubledger).toMatchObject({
      entityId: 'E1',
      kind: 'folios',
      opts: { periodo: '2026-07', solicitud: { tipo: 'CO', numTramite: 'CO202600000011' }, dryRun: false },
    });
    expect(fs.readFileSync(target, 'utf8')).toBe(XML_AUX);
  });

  it('refuses before the database without --kind (2)', async () => {
    const r = await run(['subledger', 'generate', '--period', '2026-07', ...AUDIT]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(world.calls).toBe(0);
  });
});

// ---- payment create no longer points at a command that does not exist --

describe('payment create names a command the binary answers', () => {
  it('its untraced-payment warning cites `mnemosine e-accounting voucher generate`', () => {
    const err: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      avisarRastroIncompleto(
        { entityId: 'E1', paymentAmount: '1.00', paymentDate: '2026-07-01', paymentMethod: 'spei', applications: [] },
        plain as never,
        false
      );
    } finally {
      process.stderr.write = original;
    }
    expect(err.join('')).toContain('`mnemosine e-accounting voucher generate --period <YYYY-MM>`');
  });

  it('every e-accounting citation in payment-command.ts resolves in the tree', () => {
    const program = new Command('mnemosine');
    registerEAccountingCommand(program, { palette: plain, shutdown: () => undefined, reportError: () => undefined });
    const file = path.resolve(__dirname, '../../src/cli/payment-command.ts');
    const found = commandCitations(file, fs.readFileSync(file, 'utf8'), program);
    // Only the e-accounting family is in this tree: citations of other
    // families are the criterion's job over the whole binary.
    expect(found.dead.filter((d) => d.startsWith('mnemosine e-accounting'))).toEqual([]);
    expect(found.live).toBeGreaterThan(0);
  });
});
