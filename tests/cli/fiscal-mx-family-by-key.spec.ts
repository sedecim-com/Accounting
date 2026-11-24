import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerSatCommands } from '../../src/cli/sat-commands.js';
import { registerCfdiCommand } from '../../src/cli/cfdi-command.js';
import { registerRepCommand, type RepCommandDeps } from '../../src/cli/rep-command.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';

// ============================================================
// I8.7 · the fiscal-mx family speaks by key (MNE-001-225, MNE-001-226, #269)
//
// `sat cred add` and `sat cred revoke` had four Spanish risk texts: why they
// need no idempotency key, and what they write. They are English in place now,
// like every other `writes` and `innecesaria` of the binary; the two reasons
// are the very English each leaf already prints when it gets the flag. The
// e-accounting leaves are asserted in e-accounting-command.spec.ts and diot in
// diot-command.spec.ts, beside their doubles. cfdi and rep are asserted here
// (MNE-001-226, part 2b), over doubles of modules whose names are not Spanish;
// rep's own reads come through its `receipts` seam, because its module
// (rep-pendientes) is one that test-mocks-of-spanish-modules counts.
// ============================================================

const seen = vi.hoisted(() => ({
  query: [] as Array<{ rows: unknown[] }>,
  sweep: undefined as unknown,
  trail: undefined as unknown,
  cfdi: undefined as unknown,
}));

vi.mock('../../src/ai/context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/context.js')>()),
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
}));
vi.mock('../../src/ai/draft-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/draft-service.js')>()),
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));
vi.mock('../../src/database/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/database/connection.js')>()),
  query: () => Promise.resolve(seen.query.shift() ?? { rows: [] }),
}));
vi.mock('../../src/services/sat/cfdi-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/sat/cfdi-status.js')>()),
  revalidateEntityCfdis: () => Promise.resolve(seen.sweep),
}));
vi.mock('../../src/services/xml-ingestion/cfdi-query-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/xml-ingestion/cfdi-query-service.js')>()),
  getClassificationTrail: () => Promise.resolve(seen.trail),
  getCfdiByUuid: () => Promise.resolve(seen.cfdi),
}));

describe('I8.7 · sat cred states its risk in English', () => {
  const program = new Command();
  const pass = (s: string) => s;
  registerSatCommands(program, {
    color: { dim: pass, bold: pass, cyan: pass },
    colorErr: { dim: pass, red: pass },
    shutdown: async () => { throw new Error('shutdown'); },
    reportError: () => undefined,
    ask: async () => null,
  });
  const leaf = (...names: string[]): Command =>
    names.reduce(
      (cmd: Command, n) => cmd.commands.find((c) => c.name() === n)!,
      program.commands.find((c) => c.name() === 'sat')!
    );

  it('sat cred add: custody is guarded by the typed consent, and it writes the vault material', () => {
    const risk = riskOf(leaf('cred', 'add'))!;
    expect(risk.writes).toBe('fiscal_credentials + the material in the vault; validates the certificate locally first');
    expect(risk.llave).toEqual({
      innecesaria: 'custody is guarded by the typed consent and the credential status',
    });
  });

  it('sat cred revoke: a second revoke is refused, and it destroys the vault material', () => {
    const risk = riskOf(leaf('cred', 'revoke'))!;
    expect(risk.writes).toBe('fiscal_credentials + cryptographic destruction of the material in the vault');
    expect(risk.llave).toEqual({
      innecesaria: 'a second revoke is refused because no active credential remains',
    });
  });
});

// ---- cfdi and rep (MNE-001-226, part 2b) ------------------------------

const UUID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const pass = (x: string) => x;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass } as never;

let out = '';
let err = '';
beforeEach(() => {
  out = '';
  err = '';
  seen.query = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
});

const receipts = {
  missing: vi.fn(),
  parked: vi.fn(),
  retry: vi.fn(),
};

function program(): { cli: Command; state: { exitCode?: number; errs: unknown[] } } {
  const state: { exitCode?: number; errs: unknown[] } = { errs: [] };
  const cli = new Command('mnemosine').exitOverride();
  const shutdown = (c: number) => { state.exitCode = c; };
  const reportError = (e: unknown) => { state.errs.push(e); };
  registerCfdiCommand(cli, { palette, shutdown, reportError });
  registerRepCommand(cli, { palette, shutdown, reportError, receipts: receipts as unknown as RepCommandDeps['receipts'] });
  return { cli, state };
}
async function run(...argv: string[]) {
  const { cli, state } = program();
  await cli.parseAsync(['node', 'mnemosine', ...argv, '--entity', 'E1']);
  return state;
}
const leafOf = (cli: Command, ...names: string[]): Command =>
  names.reduce((cmd: Command, n) => cmd.commands.find((c) => c.name() === n)!, cli);

describe('I8.7 · cfdi speaks by key (MNE-001-226)', () => {
  it('cfdi show counts its line items, singular and plural', async () => {
    seen.cfdi = { cfdi_uuid: UUID, xml_content: '<x/>', lineas: [{ line_number: 1 }] };
    await run('cfdi', 'show', UUID);
    expect(err).toContain('1 line item:\n');
    setLanguage('es');
    seen.cfdi = { cfdi_uuid: UUID, xml_content: '<x/>', lineas: [{ line_number: 1 }, { line_number: 2 }] };
    await run('cfdi', 'show', UUID);
    expect(err).toContain('2 conceptos:\n');
  });

  it('cfdi status show: not in the mirror, and never consulted', async () => {
    const missing = await run('cfdi', 'status', 'show', UUID);
    const e = missing.errs[0] as Error & { localized: (l: 'es') => string };
    expect(e.message).toBe(`CFDI ${UUID} is not in the mirror of this entity.`);
    expect(e.localized('es')).toBe(`CFDI ${UUID} no está en el espejo de esta entidad.`);
    seen.query = [{ rows: [{ id: 'D1' }] }, { rows: [{ cfdi_uuid: UUID, sat_validated_at: null }] }];
    await run('cfdi', 'status', 'show', UUID);
    expect(err).toContain('Never consulted: run with --refresh to ask the SAT now.\n');
    setLanguage('es');
    seen.query = [{ rows: [{ id: 'D1' }] }, { rows: [{ cfdi_uuid: UUID, sat_validated_at: null }] }];
    await run('cfdi', 'status', 'show', UUID);
    expect(err).toContain('Nunca consultado: corre con --refresh para preguntarle al SAT ahora.\n');
  });

  it('cfdi status sync without --live: how many it would consult, and why nothing was', async () => {
    seen.query = [{ rows: [{ n: '1' }] }];
    await run('cfdi', 'status', 'sync');
    expect(out).toBe('1 CFDI to consult with the SAT. Run with --live to really consult it.\n');
    out = '';
    seen.query = [{ rows: [{ n: '3' }] }];
    await run('cfdi', 'status', 'sync', '--dry-run');
    expect(out).toBe('3 CFDIs to consult with the SAT (dry-run: nothing was consulted)\n');
    setLanguage('es');
    out = '';
    seen.query = [{ rows: [{ n: '3' }] }];
    await run('cfdi', 'status', 'sync');
    expect(out).toBe('3 CFDI por consultar al SAT. Corre con --live para consultarlos de verdad.\n');
    out = '';
    seen.query = [{ rows: [{ n: '1' }] }];
    await run('cfdi', 'status', 'sync', '--dry-run');
    expect(out).toBe('1 CFDI por consultar al SAT (dry-run: nada se consultó)\n');
  });

  it('cfdi status sync --live: the tally and the cancelled warning, in both languages', async () => {
    seen.sweep = { consultados: 3, vigentes: 1, cancelados: 1, no_encontrados: 0, errores: 1, invoices_cancelled: 0, bills_marked: 0 };
    const en = await run('cfdi', 'status', 'sync', '--live', '--yes');
    expect(en.exitCode).toBe(1);
    expect(out).toBe('✔ 3 consulted: 1 valid, 1 cancelled, 0 not found, 1 error\n');
    expect(err).toContain('⚠ 1 CFDI cancelled by its issuer: review its accounting effect with cfdi list --json\n');
    setLanguage('es');
    out = '';
    err = '';
    seen.sweep = { consultados: 3, vigentes: 1, cancelados: 2, no_encontrados: 0, errores: 0, invoices_cancelled: 0, bills_marked: 0 };
    const es = await run('cfdi', 'status', 'sync', '--live', '--yes');
    expect(es.exitCode).toBe(0);
    expect(out).toBe('✔ 3 consultados: 1 vigente, 2 cancelados, 0 no encontrados, 0 errores\n');
    expect(err).toContain('⚠ 2 CFDI cancelados por el emisor: revisa su efecto contable con cfdi list --json\n');
  });

  it('cfdi explain: the trail header, its entry, and no pending decisions', async () => {
    seen.trail = { cfdi_uuid: UUID, tipo_comprobante: 'I', direction: 'recibido', case_id: 'C3', status: 'completed', journal_entry_id: 'J9', decisions: [] };
    await run('cfdi', 'explain', UUID);
    expect(err).toContain(`${UUID} · type I · recibido · case C3 · completed · entry J9\n`);
    expect(err).toContain('No pending decisions: the case was resolved by the panel policies alone.\n');
    setLanguage('es');
    err = '';
    seen.trail = { ...(seen.trail as object), case_id: null, journal_entry_id: null };
    await run('cfdi', 'explain', UUID);
    expect(err).toContain(`${UUID} · tipo I · recibido · caso — · completed\n`);
    expect(err).toContain('Sin decisiones pendientes: el caso se resolvió solo con las políticas del panel.\n');
  });

  it('cfdi states its risk and its options in English', () => {
    const { cli } = program();
    const sync = riskOf(leafOf(cli, 'cfdi', 'status', 'sync'))!;
    expect(sync.writes).toBe('xml_documents (sat_* cache)');
    expect(sync.llave).toEqual({ sinLlave: { key: 'fiscal_mx.cfdi.sync.retry_reconsults' } });
    expect(riskOf(leafOf(cli, 'cfdi', 'post'))!.llave).toEqual({
      innecesaria: 'one CFDI gives one invoice: a repeat finds its pre-registration closed, or an invoice with its UUID, and is refused',
    });
    const option = (names: string[], flag: string) =>
      leafOf(cli, ...names).options.find((o) => o.long === flag)?.description;
    expect(option(['cfdi', 'list'], '--direction')).toBe('emitido, recibido or ajeno (derived against the RFC of the entity)');
    expect(option(['cfdi', 'list'], '--type')).toBe('filter by document_type, for example cfdi_ingreso, cfdi_egreso or cfdi_pago');
    expect(option(['cfdi', 'status', 'show'], '--refresh')).toBe('ask the SAT now and update the sat_* cache of the document');
  });
});

describe('I8.7 · rep speaks by key (MNE-001-226)', () => {
  beforeEach(() => {
    receipts.missing.mockReset();
    receipts.parked.mockReset();
    receipts.retry.mockReset();
  });

  it('rep missing list --direction issued: our collections without a REP', async () => {
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'PPD' }]);
    await run('rep', 'missing', 'list', '--direction', 'issued');
    expect(err).toContain('1 collection without an issued REP: our own tax obligation, with a SAT deadline.\n');
    setLanguage('es');
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'PPD' }, { payment_number: 'PAY-2', metodo: 'PPD' }]);
    await run('rep', 'missing', 'list', '--direction', 'issued');
    expect(err).toContain('2 cobros sin REP emitido: obligación fiscal propia con plazo del SAT.\n');
  });

  it('rep missing list, received: the payments whose IVA credit lacks its support', async () => {
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'PPD' }, { payment_number: 'PAY-2', metodo: 'PPD' }]);
    await run('rep', 'missing', 'list');
    expect(err).toContain(
      '2 payments without the supplier REP: the receipt that supports crediting the IVA of those payments is missing.\n'
    );
    setLanguage('es');
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'PPD' }]);
    await run('rep', 'missing', 'list');
    expect(err).toContain(
      '1 pago sin REP del proveedor: falta el comprobante que respalda el acreditamiento del IVA de ese pago.\n'
    );
  });

  it('rep missing list: an unknown payment method is said with its doubt', async () => {
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'desconocido' }]);
    await run('rep', 'missing', 'list');
    expect(err).toContain(
      '1 with an unknown payment method (the CFDI is not in the mirror): the ledger treated it as PPD; ' +
        'it is listed with the doubt stated — a PUE needs no REP.\n'
    );
    setLanguage('es');
    receipts.missing.mockResolvedValue([{ payment_number: 'PAY-1', metodo: 'desconocido' }, { payment_number: 'PAY-2', metodo: 'desconocido' }]);
    await run('rep', 'missing', 'list', '--direction', 'issued');
    expect(err).toContain(
      '2 con método de pago desconocido (el CFDI no está en el espejo): el mayor los trató como PUE; ' +
        'se listan con la duda dicha — un PUE no exige REP.\n'
    );
  });

  it('rep missing list --min-amount that is not a number', async () => {
    const r = await run('rep', 'missing', 'list', '--min-amount', 'mil');
    const e = r.errs[0] as Error & { localized: (l: 'es') => string };
    expect(e.message).toBe('--min-amount is unreadable: "mil".');
    expect(e.localized('es')).toBe('--min-amount ilegible: "mil".');
    expect(receipts.missing).not.toHaveBeenCalled();
  });

  it('rep reconcile --dry-run: how many parked REPs it would retry', async () => {
    receipts.parked.mockResolvedValue([{ id: 'R1' }]);
    await run('rep', 'reconcile', '--dry-run');
    expect(err).toContain('1 parked REP would be retried (dry-run: nothing was touched).\n');
    setLanguage('es');
    receipts.parked.mockResolvedValue([{ id: 'R1' }, { id: 'R2' }]);
    await run('rep', 'reconcile', '--dry-run');
    expect(err).toContain('2 REP aparcados se reintentarían (dry-run: nada se tocó).\n');
  });

  it('rep reconcile: the tally, in both languages', async () => {
    receipts.retry.mockResolvedValue({ reprocesados: 2, ligados: 1, siguen_aparcados: 1, errores: 0, detalles: [] });
    const en = await run('rep', 'reconcile');
    expect(en.exitCode).toBe(0);
    expect(out).toBe('✔ 2 retried: 1 linked, 1 still parked, 0 errors\n');
    setLanguage('es');
    out = '';
    receipts.retry.mockResolvedValue({ reprocesados: 3, ligados: 1, siguen_aparcados: 2, errores: 1, detalles: [] });
    const es = await run('rep', 'reconcile');
    expect(es.exitCode).toBe(1);
    expect(out).toBe('✔ 3 reintentados: 1 ligado, 2 siguen aparcados, 1 error\n');
  });

  it('rep reconcile states what it writes in English', () => {
    const { cli } = program();
    expect(riskOf(leafOf(cli, 'rep', 'reconcile'))!.writes).toBe(
      'vendor/customer_payments + journal entries through the payments door; pre_registrations'
    );
  });
});
