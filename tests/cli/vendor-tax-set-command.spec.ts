import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// MNE-001-664 (#607) · `vendor tax set` over doubles: what the leaf hands to
// the service, how it settles the tax id type, what it refuses before the
// service runs, and what it prints. The service itself is measured in
// tests/services/ap/vendor-service.spec.ts and against Postgres in
// tests/integration/mne-001-664-vendor-tax-set.int.spec.ts.
// ============================================================

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async (sql: string) => { throw new Error(`query must not be called: ${sql}`); }),
  currentTenant: () => 't1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })),
  requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/ap/vendor-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveVendor: vi.fn(),
  setVendorTaxId: vi.fn(),
}));

import { registerVendorCommand } from '../../src/cli/vendor-command.js';
import { resetDeclarations, riskOf } from '../../src/cli/kernel/risk.js';
import { requireExplicitEntity } from '../../src/cli/kernel/entity-context.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { resolveVendor, setVendorTaxId } from '../../src/services/ap/vendor-service.js';

type Localized = Error & { localized: (l: 'es' | 'en') => string };
interface Receipt {
  vendor_number: string; company_name: string; tax_id: string; tax_id_type: string;
  previous_tax_id: string | null; previous_tax_id_type: string | null;
  posted_bills: number; posted_payments: number; id: string;
}
const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
const RULE = 'Mexico (SAT) RFC: the rule the service applied';

/** What the service answers: `previous` is what the vendor had, `posted` its documents in the ledger. */
function answer(previous: string | null, bills: number, payments: number, type = 'rfc') {
  vi.mocked(setVendorTaxId).mockResolvedValue({
    vendor: { id: 'v1', vendor_number: 'VND-0007', company_name: 'Papeleria Sintetica', tax_id: 'TST010101AA1', tax_id_type: type },
    previous: { tax_id: previous, tax_id_type: previous === null ? null : 'rfc' },
    rule: RULE,
    posted: { bills, payments },
  });
}

let out = '';
let err = '';
beforeEach(() => {
  vi.clearAllMocks();
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  vi.mocked(resolveVendor).mockResolvedValue({ id: 'v1', tax_id_type: null } as never);
  answer(null, 0, 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
});

function program() {
  resetDeclarations();
  const state: { code?: number; error?: Localized; cli: Command } = { cli: new Command('mnemosine').exitOverride() };
  state.cli.configureOutput({ writeErr: () => undefined });
  registerVendorCommand(state.cli, {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (c: number) => { state.code = c; },
    reportError: (e: unknown) => { state.error = e as Localized; },
  });
  return state;
}
async function run(argv: string[]) {
  const state = program();
  await state.cli.parseAsync(['node', 'mnemosine', ...argv]);
  return state;
}
const SET = ['vendor', 'tax', 'set', 'VND-0007', '--tax-id', 'tst010101aa1', '--reason', 'Tax status certificate of July'];

describe('vendor tax set', () => {
  it('is a write no agent may invoke, under the aliases of the customer twin', () => {
    const { cli } = program();
    const vendor = cli.commands.find((c) => c.name() === 'vendor');
    const tax = vendor?.commands.find((c) => c.name() === 'tax');
    const set = tax?.commands.find((c) => c.name() === 'set');
    expect(tax?.aliases()).toEqual(['fiscal']);
    expect(set?.aliases()).toEqual(['fijar']);
    expect(riskOf(set as Command)).toMatchObject({
      risk: 'escritura', agent: false, agentAllowed: false, writes: 'vendors.tax_id/tax_id_type',
    });
    const mandatory = set?.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory?.sort()).toEqual(['--reason', '--tax-id']);
  });

  it("its help ends with what is and is not rewritten and two examples, in the reader's language", () => {
    const leaf = () => program().cli.commands[0].commands.find((c) => c.name() === 'tax')?.commands[0] as Command;
    leaf().outputHelp();
    expect(out).toContain('No bill, payment or entry is rewritten.');
    expect(out).toContain('    mnemosine vendor tax set "Papeleria del Centro" --tax-id PCE180412TF4 --reason "Tax status certificate of July"\n');
    out = '';
    setLanguage('es');
    leaf().outputHelp();
    expect(out).toContain('No se reescribe ninguna factura, pago ni póliza.');
    expect(out).not.toContain('No bill, payment or entry is rewritten.');
  });

  it('hands the service the vendor in the scope of the named entity, the id as typed, who and why', async () => {
    const state = await run(SET);
    expect(state.error).toBeUndefined();
    expect(state.code).toBe(0);
    expect(requireExplicitEntity).toHaveBeenCalledTimes(1);
    expect(resolveVendor).toHaveBeenCalledWith('e1', 'VND-0007');
    expect(setVendorTaxId).toHaveBeenCalledWith(
      'v1',
      { kind: 'entity', tenantId: 't1', entityId: 'e1' },
      { taxId: 'tst010101aa1', taxIdType: 'rfc' },
      { userId: 'u1', reason: 'Tax status certificate of July' }
    );
  });

  it("takes the type from the vendor's own before the entity's country, and --tax-id-type before both", async () => {
    vi.mocked(resolveVendor).mockResolvedValue({ id: 'v1', tax_id_type: 'ein' } as never);
    await run(SET);
    expect(vi.mocked(setVendorTaxId).mock.calls[0][2]).toEqual({ taxId: 'tst010101aa1', taxIdType: 'ein' });
    await run([...SET, '--tax-id-type', 'vat']);
    expect(vi.mocked(setVendorTaxId).mock.calls[1][2]).toEqual({ taxId: 'tst010101aa1', taxIdType: 'vat' });
  });

  it('refuses a type it does not know, and a country with no default, before the service runs', async () => {
    const unknown = await run([...SET, '--tax-id-type', 'nit']);
    expect(unknown.error?.message).toBe('Unknown --tax-id-type "nit". Use one of: rfc, ein, vat.');
    expect(unknown.code).toBe(2);
    vi.mocked(requireExplicitEntity).mockResolvedValueOnce({ ...CTX, country: 'CO' } as never);
    const noDefault = await run(SET);
    expect(noDefault.error?.message).toContain('"CO", which has no default tax id type');
    expect(setVendorTaxId).not.toHaveBeenCalled();
  });

  it.each([
    ['--reason', SET.slice(0, 6)],
    ['--tax-id', [...SET.slice(0, 4), ...SET.slice(6)]],
  ])('without %s Commander refuses and nothing is read or written', async (flag, argv) => {
    await expect(run(argv)).rejects.toThrow(`required option '${flag} <`);
    expect(resolveVendor).not.toHaveBeenCalled();
    expect(setVendorTaxId).not.toHaveBeenCalled();
  });

  it('says what the vendor has now and what it had, and the rule applied', async () => {
    await run(SET);
    expect(out).toBe('✔ VND-0007 Papeleria Sintetica: the tax id is now TST010101AA1 (rfc); it had none.\n');
    expect(err).toBe(`  Tax id TST010101AA1 accepted under: ${RULE}.\n`);
  });

  it('counts the posted documents of the vendor and says none was rewritten, singular and plural', async () => {
    answer('TST0101', 1, 2);
    await run(SET);
    expect(out).toContain('; it was TST0101.\n');
    expect(out).toContain(
      '  This vendor has 1 posted bill and 2 posted payments: none was rewritten. What is generated from now on ' +
        '(the DIOT, the Anexo 24 vouchers file) reads the new tax id; a file already generated keeps the one it was generated with.\n'
    );
  });

  it('says it in Spanish to a reader in Spanish', async () => {
    answer(null, 2, 1);
    setLanguage('es');
    await run(SET);
    expect(out).toContain('✔ VND-0007 Papeleria Sintetica: el identificador fiscal es ahora TST010101AA1 (rfc); no tenía ninguno.\n');
    expect(out).toContain('  Este proveedor tiene 2 facturas contabilizadas y 1 pago contabilizado: ninguno se reescribió.');
  });

  it('--json returns the same facts and no prose', async () => {
    answer('TST0101', 3, 0);
    await run([...SET, '--json']);
    // The kernel's envelope, as `vendor create --json`.
    const answered = JSON.parse(out) as { schema: number; count: number; rows: Receipt[] };
    expect(answered).toEqual({
      schema: 1,
      count: 1,
      rows: [{
        vendor_number: 'VND-0007', company_name: 'Papeleria Sintetica', tax_id: 'TST010101AA1', tax_id_type: 'rfc',
        previous_tax_id: 'TST0101', previous_tax_id_type: 'rfc', posted_bills: 3, posted_payments: 0, id: 'v1',
      }],
    });
    expect(err).toBe('');
  });

  it('a refusal of the service reaches the reader in their language and exits non-zero', async () => {
    const { ConflictError } = await import('../../src/utils/errors.js');
    vi.mocked(setVendorTaxId).mockRejectedValue(
      new ConflictError({ key: 'error.RESOURCE_ALREADY_EXISTS.vendor.tax_id_taken', params: { taxId: 'TST010101AA1', number: 'VND-0003' } })
    );
    const state = await run(SET);
    expect(state.error?.message).toBe(
      'The tax id TST010101AA1 already belongs to vendor VND-0003 of this entity. Two vendors with one tax id are one taxpayer twice: correct the right record. Nothing was written.'
    );
    expect(state.error?.localized('es')).toBe(
      'El identificador fiscal TST010101AA1 ya es del proveedor VND-0003 de esta entidad. Dos proveedores con un mismo identificador son un contribuyente dado de alta dos veces: corrige el registro que corresponde. No se escribió nada.'
    );
    expect(state.code).not.toBe(0);
    expect(out).toBe('');
  });
});
