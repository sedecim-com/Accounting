import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ============================================================
// CASH FINDINGS IN THE TERMINAL'S LANGUAGE (MNE-001-528 · issue #141)
//
// `bill approve` and `payment create` print a LISR art. 27 fr. III cash
// finding at seven calls, each passing `getLanguage()`, the language the CLI
// pins at start-up (src/cli/mnemosine.ts:961):
//   bill-command.ts    :817 stderr (preview)   :822 --json (dry run)
//                      :852 --json (posted)     :865 stderr (posted)
//   payment-command.ts :800 stderr (preview, not in the dry run)
//                      :875 stderr              :888 --json
// Until this spec, nothing under tests/cli read one, so a hard-coded 'es' at
// any of them left the CLI suite green (#688, mutants X5 and X5b).
//
// Each invocation below reaches a known set of those calls, so a wrong
// language at any single one shows. The services are mocked: what is read is
// what the CLI does with a finding, not whether the service produces one
// (tests/integration/mne-001-345-cash-limit-outside-ingestion.int.spec.ts).
//
// THE EXPECTED MESSAGES ARE LITERALS copied by hand out of src/i18n/es.ts and
// en.ts: built with `t()`, the piece under test would grade itself. Which
// language is the default is read from DEFAULT_LOCALE, never written here, so
// the switch to English first (#657) rewrites none of them.
// ============================================================

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-528', entityName: 'Entidad Sintetica SA', tenantId: 'ten-528',
    currency: 'MXN', country: 'MX', accountingStandard: 'NIF', taxId: 'ESI010101AB1',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-528' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'usr-528' })),
}));
vi.mock('../../src/services/ap/bill-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/ap/bill-service.js')>()),
  resolveBill: vi.fn(),
  approveBill: vi.fn(),
}));
vi.mock('../../src/services/payments/payment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payments/payment-service.js')>()),
  recordVendorPayment: vi.fn(),
}));
// MNE-001-571 · it asks the vouchers generator, which reads the database.
vi.mock('../../src/cli/trace-completion-output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/trace-completion-output.js')>()),
  warnUntracedPayment: vi.fn(async () => undefined),
}));

import { approveBill, resolveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerPaymentCommands } from '../../src/cli/payment-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage, type Language } from '../../src/i18n/index.js';
import { DEFAULT_LOCALE, languageOfLocale } from '../../src/i18n/locale.js';
import type { CashDeductibilityFinding } from '../../src/services/ap/cash-deductibility.js';

// Synthetic: a made-up bill, amount and date. 2000.00 is the statutory limit
// the repository seeds (src/services/jurisdiction/legal-parameters-seed.ts).
const APPROVE_FINDING: CashDeductibilityFinding = {
  code: 'cash_over_limit_deductibility_at_risk',
  billNumber: 'B-CLI-528', amount: '3500.00', limit: '2000.00', onDate: '2026-04-20',
  sourceUrl: null, source: 'bill_approve', draftIds: [],
  messageKey: 'cash_limit.finding.at_approve',
  messageParams: { bill: 'B-CLI-528', amount: '3500.00', date: '2026-04-20', limit: '2000.00' },
};
// The payment's carries a note, which must come in the message's language too.
const PAYMENT_FINDING: CashDeductibilityFinding = {
  ...APPROVE_FINDING,
  source: 'vendor_payment',
  draftIds: ['52852852-8528-4528-8528-528528528528'],
  messageKey: 'cash_limit.finding.at_payment',
  noteKey: 'cash_limit.finding.draft_proposed',
  noteParams: { count: '1' },
};

const MESSAGES: Record<'approve' | 'payment', Record<Language, string>> = {
  approve: {
    es: 'B-CLI-528: el CFDI declara pago en efectivo por 3500.00 MXN (con fecha 2026-04-20), por encima del límite de 2000.00 de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo si de verdad se pagó en efectivo. No se reclasificó nada.',
    en: 'B-CLI-528: the CFDI declares payment in cash for 3500.00 MXN (dated 2026-04-20), above the 2000.00 limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk if it was really paid in cash. Nothing was reclassified.',
  },
  payment: {
    es: 'B-CLI-528: 3500.00 MXN pagados en efectivo el 2026-04-20 superan el límite de 2000.00 de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo. No se reclasificó nada. Se dejó un borrador de reclasificación en la cola de revisión (1).',
    en: 'B-CLI-528: 3500.00 MXN paid in cash on 2026-04-20 exceeds the 2000.00 limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk. Nothing was reclassified. A reclassification draft was left in the review queue (1).',
  },
};

const DEFAULT_LANGUAGE = languageOfLocale(DEFAULT_LOCALE);
const OTHER_LANGUAGE: Language = DEFAULT_LANGUAGE === 'es' ? 'en' : 'es';
const PINS = [
  ['the default locale\'s language', DEFAULT_LANGUAGE],
  ['the other language', OTHER_LANGUAGE],
] as const;

const palette = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Run { out: string; err: string; errs: unknown[] }

async function cli(argv: string[]): Promise<Run> {
  const errs: unknown[] = [];
  resetDeclarations();
  const p = new Command('mnemosine').exitOverride();
  const deps = {
    palette, home: '/tmp/mnemosine-tests-no-home',
    shutdown: () => undefined, reportError: (e: unknown) => { errs.push(e); },
  };
  registerBillCommand(p, deps);
  registerPaymentCommands(p, deps);
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { out += String(chunk); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { err += String(chunk); return true; });
  try {
    await p.parseAsync(['node', 'mnemosine', ...argv, '--entity', 'ent-528']);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err, errs };
}

/** The stderr lines that are this finding in EITHER language: a line in the wrong one is counted, not skipped. */
function findingLines(err: string, which: 'approve' | 'payment'): string[] {
  const either = Object.values(MESSAGES[which]);
  return err.split('\n').filter((l) => either.includes(l));
}

/** The finding `--json` published: the output contract's envelope, one row, one finding in it. */
function jsonFinding(out: string): Record<string, unknown> {
  const doc = JSON.parse(out) as { rows: Array<{ deductibility_findings: Array<Record<string, unknown>> }> };
  expect(doc.rows).toHaveLength(1);
  expect(doc.rows[0].deductibility_findings).toHaveLength(1);
  return doc.rows[0].deductibility_findings[0];
}

function expectIdentity(f: Record<string, unknown>, fixture: CashDeductibilityFinding): void {
  expect(f.messageKey).toBe(fixture.messageKey);
  expect(f.messageParams).toEqual(fixture.messageParams);
  expect(f.noteKey).toBe(fixture.noteKey);
  expect(f.noteParams).toEqual(fixture.noteParams);
}

beforeEach(() => {
  vi.mocked(resolveBill).mockReset();
  vi.mocked(approveBill).mockReset();
  vi.mocked(recordVendorPayment).mockReset();
});

afterEach(() => {
  resetLanguage();
});

describe.each(PINS)('bill approve prints its cash finding in %s (MNE-001-528)', (_name, language) => {
  beforeEach(() => {
    setLanguage(language);
    vi.mocked(resolveBill).mockResolvedValue(
      { id: 'bill-528', bill_number: 'B-CLI-528', status: 'draft', total_amount: '3500.00', currency_code: 'MXN', journal_entry_id: null } as never
    );
    // No entry, so `printEntry` writes to stderr and stdout carries only the JSON.
    vi.mocked(approveBill).mockResolvedValue(
      { entry: null, entryLines: [], attestation: null, deductibilityFindings: [APPROVE_FINDING] } as never
    );
  });

  it('--dry-run: the preview\'s line on stderr (:817)', async () => {
    const r = await cli(['bill', 'approve', 'B-CLI-528', '--dry-run']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'approve')).toEqual([MESSAGES.approve[language]]);
  });

  it('--dry-run --json: stderr (:817) and the JSON (:822), whose key and parameters do not change', async () => {
    const r = await cli(['bill', 'approve', 'B-CLI-528', '--dry-run', '--json']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'approve')).toEqual([MESSAGES.approve[language]]);
    const f = jsonFinding(r.out);
    expect(f.message).toBe(MESSAGES.approve[language]);
    expectIdentity(f, APPROVE_FINDING);
  });

  it('--yes: the preview\'s line (:817) and the posted one (:865)', async () => {
    const r = await cli(['bill', 'approve', 'B-CLI-528', '--yes']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'approve')).toEqual([MESSAGES.approve[language], MESSAGES.approve[language]]);
  });

  it('--yes --json: stderr (:817, :865) and the JSON (:852), whose key and parameters do not change', async () => {
    const r = await cli(['bill', 'approve', 'B-CLI-528', '--yes', '--json']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'approve')).toEqual([MESSAGES.approve[language], MESSAGES.approve[language]]);
    const f = jsonFinding(r.out);
    expect(f.message).toBe(MESSAGES.approve[language]);
    expectIdentity(f, APPROVE_FINDING);
  });
});

describe.each(PINS)('payment create prints its cash finding in %s (MNE-001-528)', (_name, language) => {
  beforeEach(() => {
    setLanguage(language);
    vi.mocked(resolveBill).mockResolvedValue(
      { id: 'bill-528', bill_number: 'B-CLI-528', status: 'approved', currency_code: 'MXN' } as never
    );
    vi.mocked(recordVendorPayment).mockResolvedValue({
      paymentId: 'vp-528', paymentNumber: 'VPMT-2026-00528', journalEntry: null, attestation: null,
      documentos: [{ id: 'bill-528', numero: 'B-CLI-528', saldoAnterior: '3500.00', saldoNuevo: '0.00', estado: 'paid', moneda: 'MXN' }],
      deductibilityFindings: [PAYMENT_FINDING],
    });
  });

  // --date keeps `todayFor` off the database; cash, so no bank trace is asked for.
  const pay = ['payment', 'create', 'B-CLI-528', '--amount', '3500.00', '--method', 'cash', '--date', '2026-04-20'];

  it('--dry-run: one line on stderr (:875); the preview\'s (:800) is not reached', async () => {
    const r = await cli([...pay, '--dry-run']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'payment')).toEqual([MESSAGES.payment[language]]);
  });

  it('--dry-run --json: stderr (:875) and the JSON (:888), whose key, parameters and note do not change', async () => {
    const r = await cli([...pay, '--dry-run', '--json']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'payment')).toEqual([MESSAGES.payment[language]]);
    const f = jsonFinding(r.out);
    expect(f.message).toBe(MESSAGES.payment[language]);
    expectIdentity(f, PAYMENT_FINDING);
  });

  it('--yes: the preview\'s line (:800) and the recorded one (:875)', async () => {
    const r = await cli([...pay, '--yes']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'payment')).toEqual([MESSAGES.payment[language], MESSAGES.payment[language]]);
  });

  it('--yes --json: stderr (:800, :875) and the JSON (:888), whose key, parameters and note do not change', async () => {
    const r = await cli([...pay, '--yes', '--json']);
    expect(r.errs).toEqual([]);
    expect(findingLines(r.err, 'payment')).toEqual([MESSAGES.payment[language], MESSAGES.payment[language]]);
    const f = jsonFinding(r.out);
    expect(f.message).toBe(MESSAGES.payment[language]);
    expectIdentity(f, PAYMENT_FINDING);
  });
});
