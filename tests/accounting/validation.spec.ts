import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { validateJournalEntry } from '../../src/services/accounting/validation.js';
import { query } from '../../src/database/connection.js';
import type { JournalEntry, JournalEntryLine } from '../../src/types/index.js';

const mockQuery = query as unknown as Mock;

const ENTRY = {
  id: 'je-1',
  entity_id: 'e1',
  fiscal_period_id: 'fp-1',
  description: 'Asiento de prueba',
  status: 'draft',
} as unknown as JournalEntry;

function line(overrides: Partial<JournalEntryLine>): JournalEntryLine {
  return {
    id: 'l', journal_entry_id: 'je-1', line_number: 1,
    account_id: 'acc-1', debit_amount: null, credit_amount: null,
    description: null, cost_center_id: null, project_id: null,
    currency_code: null, exchange_rate: null, foreign_debit: null, foreign_credit: null,
    ...overrides,
  } as JournalEntryLine;
}

/**
 * The rules hit the DB in a fixed order: accountType, periodStatus,
 * accountPermission, then nifSubstance. This helper feeds them all.
 */
function mockRuleQueries(opts: {
  accounts?: Array<Record<string, unknown>>;
  periodStatus?: string;
} = {}) {
  const accounts = opts.accounts ?? [
    { id: 'acc-1', code: '6100', account_type: 'expense', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
    { id: 'acc-2', code: '2110', account_type: 'liability', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
  ];
  mockQuery.mockImplementation((sql?: unknown) => {
    const q = typeof sql === 'string' ? sql : '';
    if (q.includes('FROM fiscal_periods')) {
      return Promise.resolve({ rows: [{ status: opts.periodStatus ?? 'open' }] });
    }
    return Promise.resolve({ rows: accounts });
  });
}

beforeEach(() => mockQuery.mockReset());

describe('balanceRule — NIF A-2 dualidad económica', () => {
  it('accepts an exactly balanced entry', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '1000.00' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '1000.00' }),
    ]);
    expect(result.errors.filter((e) => e.includes('must equal'))).toHaveLength(0);
  });

  it('rejects even a sub-cent imbalance (the DB CHECK is exact)', async () => {
    // With the old 0.01 tolerance this passed validation and then died with
    // a raw Postgres constraint error at posting.
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '1000.005' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '1000.000' }),
    ]);
    expect(result.isValid).toBe(false);
    const err = result.errors.find((e) => e.includes('must equal'));
    expect(err).toBeDefined();
    expect(err).toMatch(/NIF A-2/);
  });
});

describe('nifSubstanceRule — sustancia sobre forma', () => {
  it('warns when revenue is credited on an entry mentioning "anticipo" (NIF D-1)', async () => {
    mockRuleQueries({
      accounts: [
        { id: 'acc-1', code: '1110', account_type: 'asset', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
        { id: 'acc-2', code: '4100', account_type: 'revenue', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    const result = await validateJournalEntry(
      { ...ENTRY, description: 'Anticipo del cliente Acme por proyecto' },
      [
        line({ line_number: 1, account_id: 'acc-1', debit_amount: '11600.00' }),
        line({ line_number: 2, account_id: 'acc-2', credit_amount: '11600.00' }),
      ]
    );
    const warn = result.warnings.find((w) => w.includes('NIF D-1'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/PASIVO/);
    // Substance warnings do not block: the accountant may know better.
    expect(result.isValid).toBe(true);
  });

  it('does not warn on a normal sale without "anticipo"', async () => {
    mockRuleQueries({
      accounts: [
        { id: 'acc-1', code: '1120', account_type: 'asset', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
        { id: 'acc-2', code: '4100', account_type: 'revenue', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    const result = await validateJournalEntry(
      { ...ENTRY, description: 'Venta de servicios agosto' },
      [
        line({ line_number: 1, account_id: 'acc-1', debit_amount: '1160.00' }),
        line({ line_number: 2, account_id: 'acc-2', credit_amount: '1160.00' }),
      ]
    );
    expect(result.warnings.filter((w) => w.includes('NIF D-1'))).toHaveLength(0);
  });

  it('warns on manual postings to equity (NIF C-11)', async () => {
    mockRuleQueries({
      accounts: [
        { id: 'acc-1', code: '1110', account_type: 'asset', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
        { id: 'acc-2', code: '3100', account_type: 'equity', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '50000.00' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '50000.00' }),
    ]);
    const warn = result.warnings.find((w) => w.includes('NIF C-11'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/acta o acuerdo/);
  });
});

describe('accountPermissionRule — origen manual vs automatizado', () => {
  const noManualAccounts = [
    { id: 'acc-1', code: '1120', account_type: 'asset', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: false },
    { id: 'acc-2', code: '4100', account_type: 'revenue', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
  ];

  it('blocks manual entries against no-manual control accounts', async () => {
    mockRuleQueries({ accounts: noManualAccounts });
    const result = await validateJournalEntry(
      { ...ENTRY, entry_type: 'standard' } as JournalEntry,
      [
        line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00' }),
        line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
      ]
    );
    expect(result.errors.some((e) => e.includes('does not allow manual entries'))).toBe(true);
  });

  it('lets automated postings (auto_invoice) use control accounts', async () => {
    mockRuleQueries({ accounts: noManualAccounts });
    const result = await validateJournalEntry(
      { ...ENTRY, entry_type: 'auto_invoice' } as JournalEntry,
      [
        line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00' }),
        line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
      ]
    );
    expect(result.errors.some((e) => e.includes('does not allow manual entries'))).toBe(false);
  });

  it('still blocks inactive accounts even for automated postings', async () => {
    mockRuleQueries({
      accounts: [
        { id: 'acc-1', code: '1120', account_type: 'asset', normal_balance: 'debit', is_active: false, is_header: false, allow_manual_entries: false },
        { id: 'acc-2', code: '4100', account_type: 'revenue', normal_balance: 'credit', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    const result = await validateJournalEntry(
      { ...ENTRY, entry_type: 'payroll' } as JournalEntry,
      [
        line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00' }),
        line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
      ]
    );
    expect(result.errors.some((e) => e.includes('is inactive'))).toBe(true);
  });
});

describe('lineAmountRule — una sola columna por línea', () => {
  it('rechaza una línea con cargo Y abono a la vez', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00', credit_amount: '100.00' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
    ]);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly one'))).toBe(true);
  });

  it('rechaza una línea sin cargo NI abono', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
    ]);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes('exactly one'))).toBe(true);
  });

  it('rechaza importes negativos: el signo lo da la columna, no el número', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '-100.00' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '-100.00' }),
    ]);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /positive/i.test(e))).toBe(true);
  });

  it('acepta la forma correcta: exactamente una columna, positiva', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
    ]);
    expect(result.errors.filter((e) => e.includes('exactly one'))).toHaveLength(0);
  });
});

describe('periodStatusRule — estado del periodo fiscal', () => {
  const balanceado = [
    line({ line_number: 1, account_id: 'acc-1', debit_amount: '100.00' }),
    line({ line_number: 2, account_id: 'acc-2', credit_amount: '100.00' }),
  ];

  it('BLOQUEA si el periodo está en cierre duro', async () => {
    mockRuleQueries({ periodStatus: 'hard_close' });
    const result = await validateJournalEntry(ENTRY, balanceado);
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => /hard_close|closed/i.test(e))).toBe(true);
  });

  it('BLOQUEA si el periodo está bloqueado', async () => {
    mockRuleQueries({ periodStatus: 'locked' });
    const result = await validateJournalEntry(ENTRY, balanceado);
    expect(result.isValid).toBe(false);
  });

  it('solo ADVIERTE en cierre suave — hoy no bloquea, aunque la CLI lo anuncie', async () => {
    mockRuleQueries({ periodStatus: 'soft_close' });
    const result = await validateJournalEntry(ENTRY, balanceado);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => /soft/i.test(w))).toBe(true);
  });

  it('advierte al postear a un periodo futuro, citando devengación', async () => {
    mockRuleQueries({ periodStatus: 'future' });
    const result = await validateJournalEntry(ENTRY, balanceado);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some((w) => w.includes('NIF A-2'))).toBe(true);
  });

  it('no dice nada cuando el periodo está abierto', async () => {
    mockRuleQueries({ periodStatus: 'open' });
    const result = await validateJournalEntry(ENTRY, balanceado);
    expect(result.warnings.filter((w) => /period/i.test(w))).toHaveLength(0);
  });
});

describe('citas NIF en reglas existentes', () => {
  it('contra-natural posting cites NIF A-5 and B-1', async () => {
    mockRuleQueries({
      accounts: [
        // Debiting a liability (contra-natural for this scenario is the
        // revenue account credited... use expense credited)
        { id: 'acc-1', code: '6100', account_type: 'expense', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
        { id: 'acc-2', code: '1110', account_type: 'asset', normal_balance: 'debit', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    const result = await validateJournalEntry(ENTRY, [
      // expense CREDITED = contra natural
      line({ line_number: 1, account_id: 'acc-1', credit_amount: '100.00' }),
      line({ line_number: 2, account_id: 'acc-2', debit_amount: '100.00' }),
    ]);
    const warn = result.warnings.find((w) => w.includes('NIF A-5'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/NIF B-1/);
  });

  it('foreign currency without exchange rate cites NIF B-15', async () => {
    mockRuleQueries();
    const result = await validateJournalEntry(ENTRY, [
      line({ line_number: 1, account_id: 'acc-1', debit_amount: '1000.00', currency_code: 'USD', foreign_debit: '54.05' }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '1000.00' }),
    ]);
    const err = result.errors.find((e) => e.includes('exchange_rate'));
    expect(err).toBeDefined();
    expect(err).toMatch(/NIF B-15/);
  });
});

/**
 * LAS DOS RAMAS QUE EL TRINQUETE DE COBERTURA SEÑALABA.
 *
 * No se añaden para subir un número: son las dos únicas del validador que
 * nadie ejercía, y las dos rechazan un asiento que llegaría al mayor. El
 * trinquete de vitest.config.ts las delataba y la CI llevaba en rojo por
 * ellas — un umbral que nadie satisface deja de mirarse, así que o se
 * cubren o se baja, y bajarlo aquí sería renunciar a las dos.
 */
describe('las ramas que faltaban por ejercer', () => {
  it('un asiento de una sola línea se rechaza antes de mirar nada más', async () => {
    // Ni siquiera llega a consultar la base: una partida sola no es un
    // asiento, es media.
    const r = await validateJournalEntry(ENTRY, [line({ line_number: 1, debit_amount: '100.00' })]);
    expect(r.isValid).toBe(false);
    expect(r.errors).toContain('Journal entry must have at least 2 lines');
    expect(mockQuery, 'no debe gastarse un viaje a la base').not.toHaveBeenCalled();
  });

  it('una línea en moneda extranjera cuya conversión no cuadra se rechaza', async () => {
    // 100 USD × 17.50 son 1 750, no 1 000. Sin esta comprobación el asiento
    // cuadra en pesos consigo mismo y miente sobre el importe en divisa: la
    // diferencia reaparece al pagar, como una pérdida cambiaria inventada.
    mockRuleQueries();
    const r = await validateJournalEntry(ENTRY, [
      line({
        line_number: 1, account_id: 'acc-1', debit_amount: '1000.0000',
        currency_code: 'USD', exchange_rate: '17.5000', foreign_debit: '100.0000',
      }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '1000.0000' }),
    ]);
    expect(r.isValid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/Currency conversion mismatch/);
    expect(r.errors.join(' '), 'debe decir cuánto esperaba y cuánto encontró').toMatch(/1750\.0000.*1000\.0000/);
  });

  it('cuando la conversión sí cuadra, no se queja', async () => {
    mockRuleQueries();
    const r = await validateJournalEntry(ENTRY, [
      line({
        line_number: 1, account_id: 'acc-1', debit_amount: '1750.0000',
        currency_code: 'USD', exchange_rate: '17.5000', foreign_debit: '100.0000',
      }),
      line({ line_number: 2, account_id: 'acc-2', credit_amount: '1750.0000' }),
    ]);
    expect(r.errors.join(' ')).not.toMatch(/Currency conversion mismatch/);
  });
});
