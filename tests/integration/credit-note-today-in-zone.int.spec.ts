import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createCreditNote, issueCreditNote } from '../../src/services/ar/credit-note-service.js';

/**
 * #242 · A CREDIT NOTE WITHOUT --date IS DATED ON THE ENTITY'S DAY.
 *
 * 20:00 on December 31st in Mexico City is 02:00 on January 1st in UTC. The
 * UTC day put the note on January 1st of the NEXT year: its credit_date, its
 * folio series (CN-2027) and its period, which the fixture does not even have
 * — issuing it failed. The day is the one of the `zona_horaria` policy, and an
 * entity's own row wins over the default.
 *
 * Only `Date` is faked: pg's timers keep running.
 */

let f: Fixture;
let customerId: string;
const originalTz = process.env.TZ;

beforeAll(async () => {
  f = await crearInquilino('Credit note today in zone');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-TZ-001', 'Cliente Zona SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function noteWithoutDate() {
  return createCreditNote(
    { entity_id: f.entityId, customer_id: customerId, type: 'descuento', subtotal: '100.00', tax_amount: '16.00' },
    f.userId
  );
}

describe('credit-note create without --date', () => {
  it('at 20:00 on Dec 31 in Mexico City, the note is of the 31st: date, folio series and period', async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));

    const note = await noteWithoutDate();
    const stored = await query<{ credit_date: string }>(
      `SELECT credit_date::text AS credit_date FROM credit_notes WHERE id = $1 AND entity_id = $2`,
      [note.id, f.entityId]
    );
    expect(stored.rows[0].credit_date).toBe('2026-12-31');
    expect(note.credit_note_number).toMatch(/^CN-2026-\d{5}$/);

    const issued = await issueCreditNote(f.entityId, note.id, f.userId);
    const entry = await query<{ fiscal_period_id: string; entry_date: string }>(
      `SELECT fiscal_period_id, entry_date::text AS entry_date FROM journal_entries
        WHERE id = $1 AND entity_id = $2`,
      [issued.journalEntry!.id, f.entityId]
    );
    expect(entry.rows[0].fiscal_period_id).toBe(f.periodos[12]);
    expect(entry.rows[0].entry_date).toBe('2026-12-31');
  });

  it('the entity\'s own zona_horaria row wins: in Tokyo it is already the next day', async () => {
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value,
          status, resolved_value, resolved_by, resolved_at, source)
       VALUES ($1, $2, 'zona_horaria', 'operativa', 'q', 'i', '[]'::jsonb, 'America/Mexico_City',
               'resolved', 'Asia/Tokyo', 'test', NOW(), 'test')`,
      [f.tenantId, f.entityId]
    );
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-31T16:00:00Z')); // Oct 31 10:00 CDMX, Nov 1 01:00 Tokyo
      const note = await noteWithoutDate();
      const stored = await query<{ credit_date: string }>(
        `SELECT credit_date::text AS credit_date FROM credit_notes WHERE id = $1 AND entity_id = $2`,
        [note.id, f.entityId]
      );
      expect(stored.rows[0].credit_date).toBe('2026-11-01');
    } finally {
      await query(
        `DELETE FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = 'zona_horaria'`,
        [f.tenantId, f.entityId]
      );
    }
  });

  it('an explicit --date is kept as given', async () => {
    const note = await createCreditNote(
      {
        entity_id: f.entityId, customer_id: customerId, type: 'descuento',
        subtotal: '10.00', tax_amount: '1.60', credit_date: '2026-08-15',
      },
      f.userId
    );
    const stored = await query<{ credit_date: string }>(
      `SELECT credit_date::text AS credit_date FROM credit_notes WHERE id = $1 AND entity_id = $2`,
      [note.id, f.entityId]
    );
    expect(stored.rows[0].credit_date).toBe('2026-08-15');
  });
});
