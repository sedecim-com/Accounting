import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(), getClient: vi.fn() }));

import { chooseCustomer, type CustomerCandidate } from '../../src/services/xml-ingestion/issued-invoice-approval.js';

// MNE-001-523 (#671): whose receivable an issued CFDI becomes. Rows arrive oldest first.
const row = (customer_number: string, name: string | null, is_active = true): CustomerCandidate =>
  ({ id: `id-${customer_number}`, customer_number, name, is_active });
const XEXX = 'XEXX010101000';
const numberOf = (c: ReturnType<typeof chooseCustomer>) => ('customer' in c ? c.customer.customer_number : c);

describe('chooseCustomer', () => {
  const globex = row('C-1', 'Globex GmbH');
  const acme = row('C-2', 'Acme Inc');

  it('under a generic RFC the name decides, not the age of the customer', () => {
    expect(numberOf(chooseCustomer([globex, acme], XEXX, 'Acme Inc'))).toBe('C-2');
    expect(numberOf(chooseCustomer([globex, acme], ' xaxx010101000 ', 'Globex GmbH'))).toBe('C-1');
  });

  it('a name compares without case, outer spaces or runs of inner spaces', () => {
    expect(numberOf(chooseCustomer([globex, acme], XEXX, '  ACME \t  inc '))).toBe('C-2');
    expect(numberOf(chooseCustomer([globex, row('C-3', ' acme  INC')], XEXX, 'Acme Inc'))).toBe('C-3');
  });

  it('accents and punctuation are not folded', () => {
    const rows = [row('C-1', 'Peña SA'), row('C-2', 'Acme, Inc')];
    expect(chooseCustomer(rows, XEXX, 'Pena SA')).toEqual({ none: 'no-match', sameRfc: ['C-1', 'C-2'] });
    expect(chooseCustomer(rows, XEXX, 'Acme Inc')).toEqual({ none: 'no-match', sameRfc: ['C-1', 'C-2'] });
    expect(numberOf(chooseCustomer(rows, XEXX, 'PEÑA sa'))).toBe('C-1');
  });

  it('a person is named by first plus last name, as the query builds it', () => {
    expect(numberOf(chooseCustomer([globex, row('C-4', 'Ana Ruiz')], XEXX, 'ana ruiz'))).toBe('C-4');
    expect(chooseCustomer([row('C-5', null)], XEXX, 'Ana Ruiz')).toEqual({ none: 'no-match', sameRfc: ['C-5'] });
  });

  it('nobody by that name: none, with at most five numbers that carry the RFC', () => {
    const many = ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6'].map((n) => row(n, `Shop ${n}`));
    expect(chooseCustomer(many, XEXX, 'Initech LLC')).toEqual({
      none: 'no-match', sameRfc: ['C-1', 'C-2', 'C-3', 'C-4', 'C-5'],
    });
    expect(chooseCustomer([], 'SIN060101AB1', 'Initech LLC')).toEqual({ none: 'no-match', sameRfc: [] });
  });

  it('a generic RFC with an empty name names nobody, even next to a customer without a name', () => {
    expect(chooseCustomer([row('C-1', null), row('C-2', '')], XEXX, '  ')).toEqual({ none: 'unnamed', sameRfc: [] });
  });

  it('an inactive customer is taken only when no active one matches', () => {
    const hooli = row('C-3', 'Hooli Ltd', false);
    expect(numberOf(chooseCustomer([hooli, globex, acme], XEXX, 'Hooli Ltd'))).toBe('C-3');
    expect(numberOf(chooseCustomer([row('C-0', 'Acme Inc', false), acme], XEXX, 'Acme Inc'))).toBe('C-2');
    expect(numberOf(chooseCustomer([row('C-8', 'Old', false), row('C-9', 'New')], 'SIN060101AB1', 'Whoever'))).toBe('C-9');
  });

  it('more than one match stops, under a generic RFC and under a real one', () => {
    const twin = row('C-7', 'acme inc');
    expect(chooseCustomer([globex, acme, twin], XEXX, 'Acme Inc')).toEqual({ several: [acme, twin] });
    // A real RFC identifies by itself: the name is not read, and two active rows are two candidates.
    expect(chooseCustomer([globex, acme], 'SIN060101AB1', 'Globex GmbH')).toEqual({ several: [globex, acme] });
    expect(numberOf(chooseCustomer([globex], 'SIN060101AB1', 'Another name'))).toBe('C-1');
  });
});
