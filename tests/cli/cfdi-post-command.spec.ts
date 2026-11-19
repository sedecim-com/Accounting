import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerCfdiCommand } from '../../src/cli/cfdi-command.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { AccountingError, NotFoundError, ValidationError } from '../../src/utils/errors.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { helpKeyOf, installHelpChrome } from '../../src/cli/kernel/help.js';

// MNE-001-418 (#620): `cfdi post <uuid>` over a mocked postIssuedCfdiByHand; the real door is driven in
// tests/integration/ing3-issued-cfdi-by-hand.int.spec.ts. The help is checked with `helpKeyOf` directly:
// tests/cli/helpers/help-by-key.ts loads the whole program, which these mocks cannot serve.
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }) }));
vi.mock('../../src/services/accounting/account-service.js', () => ({
  resolveAccount: (_entity: string, code: string) => Promise.resolve({ id: `id-of-${code}`, code }),
}));
const cfdiSpy = vi.fn();
vi.mock('../../src/services/xml-ingestion/cfdi-query-service.js', () => ({
  getCfdiByUuid: (...args: unknown[]) => cfdiSpy(...args) as unknown,
}));
const doorSpy = vi.fn();
vi.mock('../../src/services/xml-ingestion/pre-registration-service.js', () => ({
  PreRegistrationService: class { postIssuedCfdiByHand = (...args: unknown[]) => doorSpy(...args) as unknown; },
}));

const UUID = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
const cfdi = (method: string | null) => ({ cfdi_uuid: UUID, receptor_rfc: 'SIN060101AB1', total: '9280.00', moneda: 'MXN', metodo_pago: method });
const posting = (dryRun: boolean) => ({
  dryRun, tenantId: 'T1', preRegistrationId: 'PRE-1',
  invoice: { id: 'I1', number: 'INV-2026-00001', status: 'sent', amountDue: '9280.00' },
  entry: { id: 'J1', number: 'JE-2026-000001' },
  lines: [{ accountCode: '1120', accountName: 'Clientes', debit: '9280.00', credit: null, description: 'x' }],
  warnings: [],
});

let out = '';
const colour = (s: string) => s;
const say = (s: unknown) => { out += String(s); return true; };
function build(confirm?: () => Promise<boolean>) {
  const state: { exitCode?: number; errs: unknown[] } = { errs: [] };
  const program = new Command('mnemosine').exitOverride();
  installHelpChrome(program);
  registerCfdiCommand(program, {
    palette: { dim: colour, bold: colour, cyan: colour, red: colour, green: colour, yellow: colour } as never,
    shutdown: (c: number) => { state.exitCode = c; }, reportError: (e: unknown) => { state.errs.push(e); }, confirm,
    parkedReceipts: () => Promise.resolve([{ id: 'REP-1' }] as never),
  });
  return { program, state };
}
async function run(argv: string[], confirm?: () => Promise<boolean>) {
  const { program, state } = build(confirm);
  await program.parseAsync(['node', 'mnemosine', 'cfdi', 'post', ...argv]);
  return state;
}

beforeEach(() => {
  out = '';
  doorSpy.mockReset().mockImplementation((o: { dryRun?: boolean }) => Promise.resolve(posting(o.dryRun === true)));
  cfdiSpy.mockReset().mockResolvedValue(cfdi('PPD'));
  vi.spyOn(process.stdout, 'write').mockImplementation(say);
  vi.spyOn(process.stderr, 'write').mockImplementation(say);
});
afterEach(() => { vi.restoreAllMocks(); resetLanguage(); });

describe('cfdi post, the terminal command of the hand door (MNE-001-418)', () => {
  it('is irreversible and closed to the agent, with help by key in en and es', () => {
    const { program } = build();
    const leaf = program.commands[0].commands.find((c) => c.name() === 'post')!;
    expect(riskOf(leaf)).toMatchObject({ risk: 'irreversible', agentAllowed: false });
    expect(leaf.aliases()).toContain('contabilizar');
    expect(leaf.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--account', '--dry-run', '--yes', '--json']));
    for (const described of [leaf, ...leaf.options, ...leaf.registeredArguments]) {
      expect(helpKeyOf(described)).toMatch(/^(cli\.|help\.cfdi\.post\.(description|option\.[a-z_]+|argument\.[a-z_]+)$)/);
    }
    setLanguage('es');
    const help = leaf.helpInformation().replace(/\s+/g, ' ');
    for (const key of ['help.cfdi.post.description', 'help.cfdi.post.option.account'] as const) {
      expect(t(key, {}, 'es')).not.toBe(t(key, {}, 'en'));
      expect(help).toContain(t(key, {}, 'es'));
    }
  });

  it('with no terminal and no --yes it refuses (exit 10) and never calls the door', async () => {
    expect((await run([UUID])).exitCode).toBe(10);
    expect((await run([UUID], () => Promise.resolve(false))).exitCode).toBe(10);
    expect(doorSpy).not.toHaveBeenCalled();
  });

  it('--dry-run asks nothing, calls the door with dryRun and prints the invoice, the entry and the pre-registration id', async () => {
    const state = await run([UUID, '--dry-run', '--account', '4200']);
    expect(state).toMatchObject({ exitCode: 0, errs: [] });
    expect(doorSpy).toHaveBeenCalledWith({ entityId: 'E1', cfdiUuid: UUID, userId: 'U1', revenueAccountId: 'id-of-4200', dryRun: true });
    for (const shown of ['INV-2026-00001', 'JE-2026-000001', '1120', 'bill inbox edit PRE-1 --line', 'Nothing was written']) {
      expect(out).toContain(shown);
    }
  });

  it('--yes posts, says where a PPD parks its VAT and names rep reconcile; --json gives one row', async () => {
    expect((await run([UUID, '--yes'])).exitCode).toBe(0);
    expect(doorSpy).toHaveBeenCalledWith({ entityId: 'E1', cfdiUuid: UUID, userId: 'U1', revenueAccountId: undefined, dryRun: false });
    expect(out).toMatch(/INV-2026-00001.*JE-2026-000001/);
    expect(out).toContain('2125');
    expect(out).toContain('mnemosine rep reconcile');
    out = '';
    cfdiSpy.mockResolvedValue(cfdi(null));
    await run([UUID], () => Promise.resolve(true));
    expect(out).toContain('receipt record');
    out = '';
    await run([UUID, '--yes', '--json']);
    const row = { invoice_number: 'INV-2026-00001', status: 'sent', amount_due: '9280.00', entry_number: 'JE-2026-000001', dry_run: false };
    expect(JSON.parse(out)).toMatchObject({ rows: [row] });
  });

  it.each<[string, () => Error, number]>([
    ['an AI draft in review', () => new AccountingError('ISSUED_CFDI_DRAFT_IN_REVIEW', { key: 'error.ISSUED_CFDI_DRAFT_IN_REVIEW', params: { uuid: UUID } }), 11],
    ['a CFDI held for a decision', () => new AccountingError('CFDI_REQUIERE_DECISION', 'held'), 11],
    ['a CFDI that is not open', () => new AccountingError('ISSUED_CFDI_NOT_OPEN', 'not open'), 5],
    ['a UUID already invoiced', () => new AccountingError('CFDI_ALREADY_INVOICED', 'already'), 5],
    ['a validation refusal', () => new ValidationError('not a revenue account'), 4],
    ['an unknown UUID', () => new NotFoundError('CFDI', UUID), 3],
  ])('%s keeps the door\'s message and exits with its code', async (_name, refusal, code) => {
    doorSpy.mockRejectedValue(refusal());
    const state = await run([UUID, '--yes']);
    expect(state.exitCode).toBe(code);
    expect((state.errs[0] as { localized(): string }).localized()).toBe((refusal() as AccountingError).localized());
  });

  it('a malformed UUID is a usage error (exit 2) before anything is read', async () => {
    expect((await run(['not-a-uuid', '--yes'])).exitCode).toBe(2);
    expect(cfdiSpy).not.toHaveBeenCalled();
  });
});
