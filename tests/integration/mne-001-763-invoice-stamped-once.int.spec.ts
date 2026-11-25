import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Router } from 'express';
import { getClient, query } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { pacRouter } from '../../src/services/integrations/mexico/pac/pac-router.js';
import invoicesRouter from '../../src/api/rest/routes/invoices.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';

// ============================================================
// AN INVOICE THAT HAS ITS STAMPED CFDI IS NOT STAMPED AGAIN
// (MNE-001-763 · #696)
//
// Against a migrated Postgres, through the route (the only door that stamps an
// income CFDI) with the real error handler. The PAC is the suite's double:
// `pacRouter.stamp` is replaced, so no PAC is reached and no credential is
// read. The double answers as a real PAC would (`simulado: false`, stored as
// `stamped`) or as the simulated adapters do (`simulado: true`, stored as
// `failed`), and each case counts the calls it got.
// ============================================================

describe('an invoice with a stamped CFDI is not stamped again', () => {
  let f: Fixture;
  let srv: Servidor;
  let customerId: string;

  /** An invoice whose CFDI 4.0 ingreso builds and validates, never stamped. */
  async function invoice(): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
         amount_due, currency_code, invoice_date, due_date, status, created_by)
       VALUES ($1, $2, $3, $4, 1000, 160, 1160, 1160, 'MXN', $5, $5, 'sent', $6)`,
      [id, f.entityId, `INV-763-${id.slice(0, 8)}`, customerId, fechaEnPeriodo(), f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price, revenue_account_id,
         tax_code, tax_rate, tax_amount, line_amount, total_amount, cfdi_product_code, cfdi_unit_code)
       VALUES ($1, $2, 1, 'Servicio mensual', 1, 1000, $3, 'IVA16', 16, 160, 1000, 1160, '84111506', 'E48')`,
      [uuidv4(), id, f.cuentas['4100']]
    );
    return id;
  }

  interface Stored { uuid: string | null; status: string | null; provider: string | null; at: Date | null }
  const stored = async (invoiceId: string): Promise<Stored> =>
    (await query<Stored>(
      `SELECT cfdi_uuid AS uuid, cfdi_status AS status, pac_provider AS provider, stamped_at AS at
         FROM invoices WHERE id = $1 AND entity_id = $2`,
      [invoiceId, f.entityId]
    )).rows[0];
  const never: Stored = { uuid: null, status: null, provider: null, at: null };

  /** What a PAC answers: a new folio on each call. */
  const answer = (simulated: boolean) => ({
    uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
    fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
    provider_used: 'test', simulado: simulated,
  });
  const realPac = () => vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => answer(false));
  const simulatedPac = () => vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => answer(true));

  interface Answer { status: number; body: Record<string, unknown> }
  interface Stamped { data: { cfdi_uuid: string; cfdi_status: string } }
  interface Refused { errors: Array<{ code: string; message: string }> }
  const stamp = (invoiceId: string, on = srv, language = 'en'): Promise<Answer> =>
    pedir(on, 'POST', `/v1/invoices/${invoiceId}/cfdi/stamp`, {}, { 'accept-language': language });
  const folioOf = (a: Answer): string => (a.body as unknown as Stamped).data.cfdi_uuid;
  const errorOf = (a: Answer) => (a.body as unknown as Refused).errors[0];

  const until = async (seen: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await seen()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  /** A read of an invoice for its stamp waits for a lock, right now. */
  const aStampWaits = async (): Promise<boolean> =>
    Number((await query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM invoices i%FOR NO KEY UPDATE OF i%'`
    )).rows[0].n) > 0;

  beforeAll(async () => {
    f = await crearInquilino('MNE-001-763 · an invoice is stamped once');
    await query(
      `UPDATE legal_entities SET tax_id = 'EKU9003173C9', tax_regime = '601', tax_postal_code = '06600' WHERE id = $1`,
      [f.entityId]
    );
    customerId = uuidv4();
    await query(
      `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, tax_regime,
         tax_postal_code, uso_cfdi, payment_terms, currency_code, created_by)
       VALUES ($1, $2, $3, 'Cliente 763', 'URE180429TM6', 'rfc', '601', '65000', 'G03', 'Net 30', 'MXN', $4)`,
      [customerId, f.entityId, `C-763-${customerId.slice(0, 8)}`, f.userId]
    );
    // As src/index.ts mounts it: the language is negotiated before the routes.
    const invoices = Router();
    invoices.use(negotiateLocale, invoicesRouter);
    srv = await levantar([['/v1/invoices', invoices]], { ...sesionDe(f), permissions: ['invoices:create'] });
  }, 180_000);

  afterAll(async () => {
    await srv?.cerrar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the second stamp is refused with 409 before the PAC is called, names the first folio and writes nothing', async () => {
    const invoiceId = await invoice();
    const pac = realPac();

    const first = await stamp(invoiceId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const before = await stored(invoiceId);
    expect(before).toMatchObject({ uuid: folioOf(first), status: 'stamped', provider: 'test' });
    expect(before.at).toBeInstanceOf(Date);
    const at = before.at!.toISOString();

    const en = await stamp(invoiceId);
    expect(en.status, JSON.stringify(en.body)).toBe(409);
    expect(errorOf(en).message).toContain(
      `Invoice ${invoiceId} was not stamped again: it already has a CFDI, folio ${before.uuid} (stamped), stamped at ${at}`
    );
    const es = await stamp(invoiceId, srv, 'es');
    expect(es.status).toBe(409);
    expect(errorOf(es).message).toContain(
      `La factura ${invoiceId} no se timbró otra vez: ya tiene un CFDI, folio ${before.uuid} (stamped), timbrado el ${at}`
    );
    // One call: the one that stamped it. The folio of the first is still the invoice's.
    expect(pac).toHaveBeenCalledTimes(1);
    expect(await stored(invoiceId)).toEqual(before);
  });

  it('a folio made by a simulated adapter is kept as failed, and the invoice is stamped after it', async () => {
    const invoiceId = await invoice();
    simulatedPac();
    const simulated = await stamp(invoiceId);
    expect(simulated.status).toBe(200);
    expect(await stored(invoiceId)).toMatchObject({ uuid: folioOf(simulated), status: 'failed' });
    vi.restoreAllMocks();

    const pac = realPac();
    const real = await stamp(invoiceId);
    expect(real.status).toBe(200);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(folioOf(real)).not.toBe(folioOf(simulated));
    expect(await stored(invoiceId)).toMatchObject({ uuid: folioOf(real), status: 'stamped' });
  });

  // `cancelled` is what the SAT status sweep writes; nothing writes `pending`
  // on an invoice today. Both are put by SQL.
  it.each(['cancelled', 'pending'])('an invoice whose CFDI is %s is stamped', async (status) => {
    const invoiceId = await invoice();
    await query(
      `UPDATE invoices SET cfdi_status = $2, cfdi_uuid = $3 WHERE id = $1 AND entity_id = $4`,
      [invoiceId, status, status === 'cancelled' ? uuidv4() : null, f.entityId]
    );
    const pac = realPac();
    const result = await stamp(invoiceId);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(await stored(invoiceId)).toMatchObject({ uuid: folioOf(result), status: 'stamped' });
  });

  it('two stamps at once reach the PAC once: the one that waited is refused with the folio of the other', async () => {
    const invoiceId = await invoice();
    let letThePacAnswer!: () => void;
    const held = new Promise<void>((resolve) => { letThePacAnswer = resolve; });
    const pac = vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => {
      await held;
      return answer(false);
    });

    const a = stamp(invoiceId);
    expect(await until(() => pac.mock.calls.length === 1), 'the first stamp reaches the PAC').toBe(true);
    const b = stamp(invoiceId);
    // The second waits for the invoice's row while the PAC has not answered
    // the first. Without the lock it never waits: it goes straight to the PAC.
    const waited = await until(async () => pac.mock.calls.length > 1 || (await aStampWaits()));
    const callsWhileHeld = pac.mock.calls.length;
    letThePacAnswer();
    const [first, second] = await Promise.all([a, b]);

    expect(waited && callsWhileHeld, 'the second stamp waits instead of calling the PAC').toBe(1);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(errorOf(second).message).toContain(`folio ${folioOf(first)} (stamped)`);
    expect(await stored(invoiceId)).toMatchObject({ uuid: folioOf(first), status: 'stamped' });
  });

  it('an attempt that cannot have the invoice within the lock timeout gives up by key, before the PAC', async () => {
    const invoiceId = await invoice();
    const pac = realPac();
    const other = await getClient();
    let answered: Answer;
    try {
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      answered = await stamp(invoiceId);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect(errorOf(answered).code).toBe('RESOURCE_ALREADY_EXISTS');
    expect(errorOf(answered).message).toContain(`Invoice ${invoiceId} was not stamped by this attempt`);
    expect(pac).not.toHaveBeenCalled();
    expect(await stored(invoiceId)).toEqual(never);
  }, 25_000);

  it('when the transaction is lost while the PAC answers, the 500 names the folio and the PAC', async () => {
    const invoiceId = await invoice();
    const issued = answer(false);
    let ended = 0;
    const pac = vi.spyOn(pacRouter, 'stamp').mockImplementation(async () => {
      // The stamp's own session is the one open and idle while the PAC works;
      // its last statement read the invoice's lines for the XML.
      const r = await query<{ ended: boolean }>(
        `SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction'
            AND pid <> pg_backend_pid() AND query LIKE '%FROM invoice_lines il%'`
      );
      ended = r.rows.filter((row) => row.ended).length;
      return issued;
    });

    const lost = await stamp(invoiceId);
    expect(ended, 'the stamp holds one open transaction while the PAC works').toBe(1);
    expect(pac).toHaveBeenCalledTimes(1);
    expect(lost.status).toBe(500);
    expect(errorOf(lost).code).toBe('INVOICE_CFDI_NOT_RECORDED');
    expect(errorOf(lost).message).toContain(
      `Invoice ${invoiceId} WAS stamped: the PAC (test) answered with folio ${issued.uuid}`
    );
    expect(await stored(invoiceId)).toEqual(never);
  });

  it('from a sibling entity a stamped invoice is still a 404, and no folio is named', async () => {
    const invoiceId = await invoice();
    const pac = realPac();
    const first = await stamp(invoiceId);
    expect(first.status).toBe(200);
    pac.mockClear();

    const sister = await crearEntidadHermana(f);
    const elsewhere = await levantar([['/v1/invoices', invoicesRouter]], {
      ...sesionDe(sister), permissions: ['invoices:create'],
    });
    try {
      const refused = await stamp(invoiceId, elsewhere);
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toContain(folioOf(first));
    } finally {
      await elsewhere.cerrar();
    }
    expect(pac).not.toHaveBeenCalled();
  });
});
