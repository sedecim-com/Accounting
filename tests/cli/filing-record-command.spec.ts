import { afterEach, describe, expect, it } from 'vitest';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { parseFilingCorrect, parseFilingRecord } from '../../src/cli/filing-record-command.js';
import { CliError } from '../../src/cli/kernel/cli-error.js';
import { resetLanguage } from '../../src/i18n/index.js';
import { describedIn, expectEveryKeyInFormat, expectSpanishHelp, node, unkeyedInFamilies } from './helpers/help-by-key.js';

// ============================================================
// MNE-001-577 (#308, part 3/3) · `mnemosine filing record`
//
// The flags become the filing recordFiledReturn takes, or the first one that
// fails is refused by key with exit 2, before any query. The leaf is a write
// the agent cannot call, and its help speaks by key in en and es. The rules
// of the return itself are the service's (tests/services/fiscal), and the
// whole leaf runs against Postgres in mne-001-577-filing-record.int.spec.ts.
//
// MNE-001-629 · `mnemosine filing correct` is the same leaf for an amended
// return: the same flags, and `--replaces`, the acuse of the return in force
// it replaces. It runs against Postgres in mne-001-629-filing-correct.int.spec.ts.
// ============================================================

afterEach(() => resetLanguage());

/** The August return of the plan: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 payable. */
const AUGUST = {
  form: 'iva', period: '2026-08', filedOn: '2026-09-15', acuse: 'OP-SYN-0801', captureLine: 'LC-SYN-0801',
  payable: '5000.00', paid: '5000.00', paidOn: '2026-09-16', credit: ['OP-SYN-0701:3000.00'],
};

const refusal = (
  opts: Record<string, unknown>, parse: (o: Record<string, unknown>) => unknown = parseFilingRecord
): { exit: number; key: string | undefined } => {
  try {
    parse(opts);
  } catch (e) {
    const err = e as CliError;
    return { exit: err.exitCode, key: err.key };
  }
  throw new Error('expected a refusal');
};

describe('parseFilingRecord', () => {
  it('turns the August flags into the monthly IVA filing, credits in order', () => {
    expect(parseFilingRecord({ ...AUGUST, credit: ['OP-SYN-0601:1200', 'OP-SYN-0701:2000.00'] })).toEqual({
      obligation: 'iva_monthly', period: '2026-08', filedOn: '2026-09-15', acknowledgementNumber: 'OP-SYN-0801',
      captureLine: 'LC-SYN-0801', amountPayable: '5000.00', amountPaid: '5000.00', paidOn: '2026-09-16',
      credits: [
        { sourceAcknowledgement: 'OP-SYN-0601', amount: '1200' },
        { sourceAcknowledgement: 'OP-SYN-0701', amount: '2000.00' },
      ],
    });
  });

  it('a balance in favour with no payment and no credit leaves those fields out', () => {
    expect(parseFilingRecord({ form: 'IVA', period: '2026-07', filedOn: '2026-08-14', acuse: ' OP-SYN-0701 ', inFavor: '5000' }))
      .toEqual({
        obligation: 'iva_monthly', period: '2026-07', filedOn: '2026-08-14', acknowledgementNumber: 'OP-SYN-0701',
        balanceInFavor: '5000',
      });
  });

  it('a return at zero is stated with --payable 0', () => {
    expect(parseFilingRecord({ ...AUGUST, payable: '0', paid: undefined, paidOn: undefined, credit: undefined }))
      .toMatchObject({ amountPayable: '0' });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no --form', { form: undefined }, 'filing.record.form_invalid'],
    ['the provisional ISR', { form: 'isr' }, 'filing.record.form_invalid'],
    ['no --period', { period: undefined }, 'filing.record.period_invalid'],
    ['a period that is not a month', { period: '2026-13' }, 'filing.record.period_invalid'],
    ['no --filed-on', { filedOn: undefined }, 'filing.record.date_invalid'],
    ['a filing date that is not a day', { filedOn: '2026-02-30' }, 'filing.record.date_invalid'],
    ['no --acuse', { acuse: undefined }, 'filing.record.acuse_required'],
    ['an acuse of spaces', { acuse: '   ' }, 'filing.record.acuse_required'],
    ['a blank capture line', { captureLine: ' ' }, 'filing.record.capture_line_blank'],
    ['--payable and --in-favor together', { inFavor: '0' }, 'filing.record.result_both'],
    ['neither --payable nor --in-favor', { payable: undefined }, 'filing.record.result_required'],
    ['three decimals', { payable: '5000.001' }, 'filing.record.amount_invalid'],
    ['a negative balance', { payable: undefined, inFavor: '-1' }, 'filing.record.amount_invalid'],
    ['--paid without --paid-on', { paidOn: undefined }, 'filing.record.payment_incomplete'],
    ['--paid-on without --paid', { paid: undefined }, 'filing.record.payment_incomplete'],
    ['a payment date that is not a day', { paidOn: '2026-09-31' }, 'filing.record.date_invalid'],
    ['a paid amount with a comma', { paid: '5,000.00' }, 'filing.record.amount_invalid'],
    ['a credit without its amount', { credit: ['OP-SYN-0701'] }, 'filing.record.credit_invalid'],
    ['a credit without its acuse', { credit: [':3000.00'] }, 'filing.record.credit_invalid'],
    ['a credit whose amount is not one', { credit: ['OP-SYN-0701:tres mil'] }, 'filing.record.credit_invalid'],
  ])('refuses %s with exit 2 by key', (_, change, key) => {
    expect(refusal({ ...AUGUST, ...change })).toEqual({ exit: 2, key });
  });
});

describe('parseFilingCorrect', () => {
  /** August amended on 2026-10-02: 8,500.00 of IVA less the same 3,000.00 = 5,500.00 payable; 500.00 more paid. */
  const AMENDED = {
    ...AUGUST, filedOn: '2026-10-02', acuse: 'OP-SYN-0802', captureLine: 'LC-SYN-0802', payable: '5500.00',
    paid: '500.00', paidOn: '2026-10-02', replaces: ' OP-SYN-0801 ',
  };

  it('is the filing of the same flags, naming the return it replaces', () => {
    expect(parseFilingCorrect(AMENDED)).toEqual({
      obligation: 'iva_monthly', period: '2026-08', filedOn: '2026-10-02', acknowledgementNumber: 'OP-SYN-0802',
      captureLine: 'LC-SYN-0802', amountPayable: '5500.00', amountPaid: '500.00', paidOn: '2026-10-02',
      credits: [{ sourceAcknowledgement: 'OP-SYN-0701', amount: '3000.00' }], replacesAcknowledgement: 'OP-SYN-0801',
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no --replaces', { replaces: undefined }, 'filing.correct.replaces_required'],
    ['a --replaces of spaces', { replaces: '  ' }, 'filing.correct.replaces_required'],
    ['a flag of the return itself', { period: '2026-13' }, 'filing.record.period_invalid'],
  ])('refuses %s with exit 2 by key', (_, change, key) => {
    expect(refusal({ ...AMENDED, ...change }, parseFilingCorrect)).toEqual({ exit: 2, key });
  });
});

describe('mnemosine filing, help by key', () => {
  it('the lane finds no description without key in the family', () => {
    expect(unkeyedInFamilies(['filing'])).toEqual([]);
  });

  it('every description has a key in the decided format, or a generic cli.* key', () => {
    const described = describedIn(node('filing record'));
    expect(described.length).toBeGreaterThan(11);
    expectEveryKeyInFormat(described, 'filing');
  });

  it('the leaf shows its description, --acuse and --credit in Spanish', () => {
    expectSpanishHelp('filing record', 'help.filing.record.description');
    expectSpanishHelp('filing record', 'help.filing.record.option.acuse');
    expectSpanishHelp('filing record', 'help.filing.record.option.credit');
  });

  it('the leaf is a write the agent cannot call, with --dry-run and --yes, and no idempotency key', () => {
    const leaf = node('filing record');
    expect(riskOf(leaf)).toMatchObject({ risk: 'escritura', agentAllowed: false });
    const longs = leaf.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--json']));
    expect(longs).not.toContain('--idempotency-key');
    expect(longs).not.toContain('--replaces');
  });

  it('filing correct speaks by key, and is a write the agent cannot call, with --replaces and no idempotency key', () => {
    const leaf = node('filing correct');
    const described = describedIn(leaf);
    expect(described.length).toBeGreaterThan(12);
    expectEveryKeyInFormat(described, 'filing');
    expectSpanishHelp('filing correct', 'help.filing.correct.description');
    expectSpanishHelp('filing correct', 'help.filing.correct.option.replaces');
    resetLanguage();
    expect(leaf.aliases()).toEqual(['corregir']);
    expect(riskOf(leaf)).toMatchObject({ risk: 'escritura', agentAllowed: false });
    const longs = leaf.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--replaces', '--dry-run', '--yes', '--json', '--credit']));
    expect(longs).not.toContain('--idempotency-key');
  });
});
