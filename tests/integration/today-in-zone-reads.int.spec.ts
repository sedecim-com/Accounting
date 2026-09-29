import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import reportsRouter from '../../src/api/rest/routes/reports.js';
import { listInvoices } from '../../src/services/ar/invoice-service.js';
import { listCustomers, getCustomerBalance } from '../../src/services/ar/customer-service.js';
import { buildReportTools } from '../../src/ai/tools/report-tools.js';
import { buildSystemBlocks } from '../../src/ai/system-prompt.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * #242 · MNE-001-111 · THE READS TAKE "TODAY" FROM zona_horaria TOO.
 *
 * 20:00 on October 31st in Mexico City is 02:00 on November 1st in UTC. An
 * invoice due on the 31st is due TODAY, not one day overdue: the aging over
 * REST and over the agent's tool, `invoice list`, `customer list` and the
 * agent's "Today's date" all used the UTC day and moved it to the 1st.
 *
 * The process runs in UTC, as the server does. Only `Date` is faked: pg's
 * timers keep running.
 */

const EVENING_IN_MEXICO_CITY = new Date('2026-11-01T02:00:00Z'); // Oct 31, 20:00 CDMX
const MORNING_IN_TOKYO = new Date('2026-10-31T16:00:00Z'); // Oct 31 10:00 CDMX, Nov 1 01:00 Tokyo

let f: Fixture;
let ctx: AgentContext;
let customerId: string;
const originalTz = process.env.TZ;

beforeAll(async () => {
  f = await crearInquilino('Reads today in zone');
  ctx = {
    entityId: f.entityId, entityName: 'Zona SA', tenantId: f.tenantId,
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'ZON010101AAA',
  };
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-TZ-READ', 'Cliente Zona SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  await query(
    `INSERT INTO invoices (
       id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, status, created_by
     ) VALUES ($1,$2,'INV-TZ-001',$3,'2026-10-01','2026-10-31',1000,160,1160,1160,0,'MXN','sent',$4)`,
    [uuidv4(), f.entityId, customerId, f.userId]
  );
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

afterAll(async () => {
  await closeDatabase();
});

function atEveningInMexicoCity(): void {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING_IN_MEXICO_CITY);
}

describe('at 20:00 on Oct 31 in Mexico City, an invoice due on the 31st is due today', () => {
  it('REST aged receivables: as_of_date is the 31st and days_overdue is 0', async () => {
    atEveningInMexicoCity();
    const s = await levantar([['/v1/reports', reportsRouter]], sesionDe(f));
    try {
      const r = await pedir(s, 'GET', `/v1/reports/aged-receivables?entity_id=${f.entityId}`);
      expect(r.status).toBe(200);
      const data = r.body.data as { as_of_date: string; invoices: Array<{ days_overdue: number }> };
      expect(data.as_of_date).toBe('2026-10-31');
      expect(data.invoices.map((i) => i.days_overdue)).toEqual([0]);
    } finally {
      await s.cerrar();
    }
  });

  it('the agent\'s get_aged_receivables: the same day', async () => {
    atEveningInMexicoCity();
    // The tool list is a union of input types; this one takes an optional date only.
    const tool = buildReportTools(ctx).find((t) => t.name === 'get_aged_receivables') as unknown as {
      run: (input: { as_of_date?: string }) => Promise<string>;
    };
    const out = await tool.run({});
    expect(out).toContain('"as_of_date":"2026-10-31"');
    expect(out).toContain('"days_overdue":0');
  });

  it('invoice list: the aging column counts from the 31st', async () => {
    atEveningInMexicoCity();
    const { rows } = await listInvoices(f.entityId, { withAging: true });
    expect(rows.map((r) => Number((r as unknown as { days_overdue: number }).days_overdue))).toEqual([0]);
    const overdue = await listInvoices(f.entityId, { overdueDays: 1 });
    expect(overdue.total).toBe(0);
  });

  it('customer list: the customer owes nothing past due yet', async () => {
    atEveningInMexicoCity();
    const overdue = await listCustomers(f.entityId, { overdueOnly: true });
    expect(overdue.rows.map((c) => c.id)).not.toContain(customerId);
    const all = await listCustomers(f.entityId, { withBalance: true });
    const row = all.rows.find((c) => c.id === customerId)!;
    expect(Number(row.overdue_balance)).toBe(0);
    expect(Number((await getCustomerBalance(customerId)).overdue_balance)).toBe(0);
  });

  it('the agent\'s prompt says the 31st', async () => {
    atEveningInMexicoCity();
    const [, volatile_] = await buildSystemBlocks(ctx);
    expect(volatile_.text).toContain("Today's date: 2026-10-31.");
  });
});

describe('the entity\'s own zona_horaria row wins in the reads', () => {
  it('in Tokyo it is already Nov 1: the invoice is one day overdue', async () => {
    await query(
      `INSERT INTO policy_decisions
         (tenant_id, entity_id, key, category, question, impact, options, default_value,
          status, resolved_value, resolved_by, resolved_at, source)
       VALUES ($1, $2, 'zona_horaria', 'operativa', 'q', 'i', '[]'::jsonb, 'America/Mexico_City',
               'resolved', 'Asia/Tokyo', 'test', NOW(), 'test')`,
      [f.tenantId, f.entityId]
    );
    try {
      process.env.TZ = 'UTC';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(MORNING_IN_TOKYO);
      const { rows } = await listInvoices(f.entityId, { withAging: true });
      expect(rows.map((r) => Number((r as unknown as { days_overdue: number }).days_overdue))).toEqual([1]);
      const overdue = await listCustomers(f.entityId, { overdueOnly: true });
      expect(overdue.rows.map((c) => c.id)).toContain(customerId);
      const [, volatile_] = await buildSystemBlocks(ctx);
      expect(volatile_.text).toContain("Today's date: 2026-11-01.");
    } finally {
      await query(
        `DELETE FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = 'zona_horaria'`,
        [f.tenantId, f.entityId]
      );
    }
  });
});
