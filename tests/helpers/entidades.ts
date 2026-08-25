import type { JournalEntry, JournalEntryLine } from '../../src/types/index.js';

/** Constructores de entidades del dominio con valores por defecto coherentes
 *  con el esquema, para no repetir veinte campos en cada prueba. */

export const ID = {
  entidad: '11111111-1111-4111-8111-111111111111',
  periodo: '22222222-2222-4222-8222-222222222222',
  asiento: '33333333-3333-4333-8333-333333333333',
  usuario: '44444444-4444-4444-8444-444444444444',
  cuentaA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cuentaB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

export function asientoFalso(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: ID.asiento,
    entry_number: 'JE-2026-00007',
    entry_type: 'standard',
    entity_id: ID.entidad,
    fiscal_period_id: ID.periodo,
    source_type: null,
    source_id: null,
    reference: null,
    entry_date: new Date('2026-08-15'),
    status: 'draft',
    description: 'Asiento de prueba',
    total_debits: '0.0000',
    total_credits: '0.0000',
    is_reversal: false,
    reverses_entry_id: null,
    reversed_by_entry_id: null,
    notes: null,
    created_by: ID.usuario,
    ...overrides,
  } as unknown as JournalEntry;
}

export function lineaFalsa(overrides: Partial<JournalEntryLine> = {}): JournalEntryLine {
  return {
    id: 'll111111-1111-4111-8111-111111111111',
    journal_entry_id: ID.asiento,
    line_number: 1,
    account_id: ID.cuentaA,
    debit_amount: null,
    credit_amount: null,
    description: null,
    cost_center_id: null,
    project_id: null,
    currency_code: null,
    exchange_rate: null,
    foreign_debit: null,
    foreign_credit: null,
    ...overrides,
  } as unknown as JournalEntryLine;
}

/** Cuenta tal como la devuelve el SELECT de las reglas de validación. */
export function cuentaFalsa(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.cuentaA,
    code: '1110',
    name: 'Bancos',
    account_type: 'asset',
    normal_balance: 'debit',
    is_active: true,
    is_header: false,
    allow_manual_entries: true,
    ...overrides,
  };
}
