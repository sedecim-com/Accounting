import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';

// ============================================================
// MNE-001-533 · #308 — THE RECORD OF FILED RETURNS, AGAINST POSTGRES.
//
// Migration 337: one row per filed return, its credits of earlier balances,
// and the refund requests and compensations of a balance, all append-only.
// The chain of a period (an amended return links to the one it replaces) is
// held by the schema, so the return in force is the one nobody replaces.
// Raw SQL, as the service (MNE-001-576) and the leaf (MNE-001-577) come
// later. Two tenants; all data is synthetic, figures worked by hand.
// ============================================================

let a: Fixture;
let b: Fixture;

beforeAll(async () => {
  a = await crearInquilino('MNE-001-533 A');
  b = await crearInquilino('MNE-001-533 B');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

interface Filing {
  entity: string;
  ack: string;
  period: string;
  filedOn: string;
  obligation?: string;
  type?: string;
  replaces?: string | null;
  captureLine?: string | null;
  payable?: string;
  inFavor?: string;
  paid?: string | null;
  paidOn?: string | null;
}

const file = async (x: Filing): Promise<string> =>
  (await query<{ id: string }>(
    `INSERT INTO filed_tax_returns
       (entity_id, obligation, period, return_type, replaces_return_id, filed_on,
        acknowledgement_number, capture_line, amount_payable, balance_in_favor, amount_paid, paid_on)
     VALUES ($1, $2, $3::date, $4, $5, $6::date, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12::date)
     RETURNING id`,
    [x.entity, x.obligation ?? 'iva_monthly', x.period, x.type ?? 'original', x.replaces ?? null, x.filedOn,
     x.ack, x.captureLine ?? null, x.payable ?? '0', x.inFavor ?? '0', x.paid ?? null, x.paidOn ?? null]
  )).rows[0].id;

const credit = (entity: string, returnId: string, returnPeriod: string, sourceId: string,
  sourcePeriod: string, amount: string, obligation = 'iva_monthly') =>
  query(
    `INSERT INTO filed_tax_return_credits
       (entity_id, obligation, return_id, return_period, source_return_id, source_period, amount)
     VALUES ($1, $2, $3, $4::date, $5, $6::date, $7::numeric)`,
    [entity, obligation, returnId, returnPeriod, sourceId, sourcePeriod, amount]
  );

const use = (entity: string, kind: string, sourceId: string, sourcePeriod: string, usedOn: string,
  amount: string, reference: string, offsetPeriod: string | null) =>
  query(
    `INSERT INTO tax_balance_uses
       (entity_id, obligation, kind, source_return_id, source_period, used_on, amount, reference, offset_period)
     VALUES ($1, 'iva_monthly', $2, $3, $4::date, $5::date, $6::numeric, $7, $8::date)`,
    [entity, kind, sourceId, sourcePeriod, usedOn, amount, reference, offsetPeriod]
  );

/** The return in force of a period: the link of its chain that nobody replaces. */
const inForce = async (entity: string, period: string): Promise<string[]> =>
  (await query<{ ack: string }>(
    `SELECT r.acknowledgement_number AS ack
       FROM filed_tax_returns r
      WHERE r.entity_id = $1 AND r.obligation = 'iva_monthly' AND r.period = $2::date
        AND NOT EXISTS (SELECT 1 FROM filed_tax_returns n WHERE n.replaces_return_id = r.id)`,
    [entity, period]
  )).rows.map((r) => r.ack);

const JUL = '2026-07-01';
const AUG = '2026-08-01';
const SEP = '2026-09-01';

describe('the record of filed returns (migration 337)', () => {
  let july: string;
  let august: string;

  it('T1 · keeps a return as filed, with the earlier balance it credited', async () => {
    july = await file({ entity: a.entityId, ack: 'OP-SYN-0701', period: JUL, filedOn: '2026-08-14', inFavor: '5000.00' });
    // August: 8,000.00 of IVA less 3,000.00 credited from July = 5,000.00 to pay, paid the next day.
    august = await file({
      entity: a.entityId, ack: 'OP-SYN-0801', period: AUG, filedOn: '2026-09-15', captureLine: 'LC-SYN-0801',
      payable: '5000.00', paid: '5000.00', paidOn: '2026-09-16',
    });
    await credit(a.entityId, august, AUG, july, JUL, '3000.00');

    const row = (await query<Record<string, string>>(
      `SELECT return_type, capture_line, amount_payable::text AS payable, balance_in_favor::text AS in_favor,
              amount_paid::text AS paid, to_char(paid_on, 'YYYY-MM-DD') AS paid_on
         FROM filed_tax_returns WHERE id = $1`, [august]
    )).rows[0];
    expect(row).toEqual({
      return_type: 'original', capture_line: 'LC-SYN-0801', payable: '5000.00', in_favor: '0.00',
      paid: '5000.00', paid_on: '2026-09-16',
    });
    const credits = await query<{ source: string; amount: string }>(
      `SELECT source_return_id AS source, amount::text AS amount FROM filed_tax_return_credits WHERE return_id = $1`,
      [august]
    );
    expect(credits.rows).toEqual([{ source: july, amount: '3000.00' }]);
    expect(await inForce(a.entityId, AUG)).toEqual(['OP-SYN-0801']);
  });

  it('T2 · an amended return links to the one it replaces; the period reads the last link', async () => {
    // 6,200.00 payable on the amendment; 5,000.00 was already paid, so it pays 1,200.00.
    const amended = await file({
      entity: a.entityId, ack: 'OP-SYN-0802', period: AUG, filedOn: '2026-10-02', type: 'amended',
      replaces: august, captureLine: 'LC-SYN-0802', payable: '6200.00', paid: '1200.00', paidOn: '2026-10-03',
    });
    expect(await inForce(a.entityId, AUG)).toEqual(['OP-SYN-0802']);
    const kept = await query(`SELECT 1 FROM filed_tax_returns WHERE entity_id = $1 AND period = $2::date`, [a.entityId, AUG]);
    expect(kept.rows.length, 'the replaced return is kept').toBe(2);

    // A third link extends the chain, and only it is in force.
    const third = await file({
      entity: a.entityId, ack: 'OP-SYN-0803', period: AUG, filedOn: '2026-10-20', type: 'amended',
      replaces: amended, payable: '6200.00',
    });
    expect(await inForce(a.entityId, AUG)).toEqual(['OP-SYN-0803']);

    const august2 = { entity: a.entityId, period: AUG, filedOn: '2026-10-21' };
    await expect(file({ ...august2, ack: 'OP-SYN-0804', type: 'amended', replaces: august }),
      'a replaced return cannot be amended again: the chain never branches')
      .rejects.toThrow(/filed_tax_return_replaced_once/);
    await expect(file({ ...august2, ack: 'OP-SYN-0805' }), 'one original per period')
      .rejects.toThrow(/filed_tax_return_one_original/);
    await expect(file({ ...august2, ack: 'OP-SYN-0806', type: 'amended', replaces: july }),
      'an amendment replaces a return of its own period')
      .rejects.toThrow(/filed_tax_return_replaces_its_own_period/);
    await expect(file({ ...august2, ack: 'OP-SYN-0801', type: 'amended', replaces: third }),
      'an acknowledgement is recorded once per entity')
      .rejects.toThrow(/filed_tax_return_acknowledgement_once/);
  });

  it('T3 · the table refuses what a filed return cannot be', async () => {
    const sep = { entity: a.entityId, period: SEP, filedOn: '2026-10-15' };
    const cases: Array<[Partial<Filing>, RegExp]> = [
      [{ payable: '100.00', inFavor: '50.00' }, /filed_tax_return_payable_or_in_favor/],
      [{ filedOn: '2026-09-30' }, /filed_tax_return_filed_after_its_period/],
      [{ paid: '100.00', payable: '100.00' }, /filed_tax_return_payment_has_its_day/],
      [{ paid: '100.00', payable: '100.00', paidOn: '2026-10-14' }, /filed_tax_return_payment_has_its_day/],
      [{ type: 'amended' }, /filed_tax_return_amendment_names_what_it_replaces/],
      [{ replaces: july }, /filed_tax_return_amendment_names_what_it_replaces/],
      [{ ack: '   ' }, /filed_tax_return_acknowledgement_not_blank/],
      [{ captureLine: ' ' }, /filed_tax_return_capture_line_not_blank/],
      [{ period: '2026-09-15' }, /filed_tax_return_period_is_a_month/],
      [{ obligation: 'iva_annual' }, /filed_tax_returns_obligation_check/],
      [{ type: 'normal' }, /filed_tax_returns_return_type_check/],
      [{ payable: '-1.00' }, /filed_tax_returns_amount_payable_check/],
    ];
    let n = 0;
    for (const [change, refusal] of cases) {
      await expect(file({ ...sep, ack: `OP-SYN-09X${n++}`, ...change }), String(refusal)).rejects.toThrow(refusal);
    }
    // An amendment cannot replace itself: its own id is not a row yet, so the key refuses it.
    const self = '00000000-0000-4000-8000-000000000533';
    await expect(query(
      `INSERT INTO filed_tax_returns (id, entity_id, obligation, period, return_type, replaces_return_id, filed_on,
                                      acknowledgement_number)
       VALUES ($1, $2, 'iva_monthly', $3::date, 'amended', $1, '2026-10-15', 'OP-SYN-09SELF')`,
      [self, a.entityId, SEP]
    )).rejects.toThrow(/filed_tax_return_amendment_names_what_it_replaces/);
    await expect(file({ ...sep, ack: 'OP-SYN-0901' })).resolves.toBeDefined();
  });

  it('T4 · a credit or a use of a balance stays inside its entity and its tax, and looks back', async () => {
    const julyOfB = await file({ entity: b.entityId, ack: 'OP-SYN-B0701', period: JUL, filedOn: '2026-08-14', inFavor: '900.00' });
    const isrJuly = await file({
      entity: a.entityId, ack: 'OP-SYN-ISR0701', period: JUL, filedOn: '2026-08-14', obligation: 'isr_provisional',
      inFavor: '700.00',
    });
    const september = (await query<{ id: string }>(
      `SELECT id FROM filed_tax_returns WHERE entity_id = $1 AND acknowledgement_number = 'OP-SYN-0901'`, [a.entityId]
    )).rows[0].id;

    await expect(credit(a.entityId, september, SEP, julyOfB, JUL, '100.00'), 'another tenant\'s return')
      .rejects.toThrow(/filed_tax_return_credit_source_is_its_own/);
    await expect(credit(a.entityId, september, SEP, isrJuly, JUL, '100.00'), 'another tax')
      .rejects.toThrow(/filed_tax_return_credit_source_is_its_own/);
    await expect(credit(a.entityId, july, JUL, september, SEP, '100.00'), 'a later period')
      .rejects.toThrow(/filed_tax_return_credit_looks_back/);
    await expect(credit(a.entityId, september, SEP, july, JUL, '0'))
      .rejects.toThrow(/filed_tax_return_credits_amount_check/);
    await credit(a.entityId, september, SEP, july, JUL, '1500.00');
    await expect(credit(a.entityId, september, SEP, july, JUL, '1.00'), 'one row per source')
      .rejects.toThrow(/filed_tax_return_credit_once_per_source/);

    // July's 5,000.00: 3,000.00 credited in August, 1,500.00 in September; 500.00 is left to refund or compensate.
    await use(a.entityId, 'refund_request', july, JUL, '2026-10-20', '500.00', 'DEV-SYN-0001', null);
    await use(a.entityId, 'compensation', july, JUL, '2026-10-21', '1.00', 'COMP-SYN-0001', '2026-10-01');
    await expect(use(a.entityId, 'compensation', july, JUL, '2026-10-21', '1.00', 'COMP-SYN-0002', null))
      .rejects.toThrow(/tax_balance_use_compensation_names_its_period/);
    await expect(use(a.entityId, 'refund_request', july, JUL, '2026-10-21', '1.00', 'DEV-SYN-0002', '2026-10-01'))
      .rejects.toThrow(/tax_balance_use_compensation_names_its_period/);
    await expect(use(a.entityId, 'refund_request', julyOfB, JUL, '2026-10-21', '1.00', 'DEV-SYN-0003', null))
      .rejects.toThrow(/tax_balance_use_source_is_its_own/);
    await expect(use(a.entityId, 'refund_request', july, JUL, '2026-10-21', '1.00', ' ', null))
      .rejects.toThrow(/tax_balance_use_reference_not_blank/);
    await expect(use(a.entityId, 'offset', july, JUL, '2026-10-21', '1.00', 'X-SYN', null))
      .rejects.toThrow(/tax_balance_uses_kind_check/);
  });

  it('T5 · refuses UPDATE, DELETE and TRUNCATE on the three tables, even to the schema owner', async () => {
    for (const table of ['filed_tax_returns', 'filed_tax_return_credits', 'tax_balance_uses']) {
      await expect(query(`UPDATE ${table} SET entity_id = entity_id WHERE entity_id = $1`, [a.entityId]), table)
        .rejects.toThrow(`${table} is append-only: UPDATE refused`);
      await expect(query(`DELETE FROM ${table} WHERE entity_id = $1`, [a.entityId]), table)
        .rejects.toThrow(`${table} is append-only: DELETE refused`);
    }
    // The two child tables first, then the parent with CASCADE.
    for (const table of ['filed_tax_return_credits', 'tax_balance_uses', 'filed_tax_returns']) {
      // The message names the table whose own trigger refused, so the parent's is proven, not a child's.
      await expect(query(`TRUNCATE ${table} CASCADE`), table).rejects.toThrow(`${table} is append-only: TRUNCATE refused`);
    }
    expect(await inForce(a.entityId, AUG)).toEqual(['OP-SYN-0803']);
  });
});
