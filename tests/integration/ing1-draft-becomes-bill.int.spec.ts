import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';
import type OpenAI from 'openai';

// `bill inbox run` is driven in-process: only WHO is asking is stubbed (the
// entity and the reviewer); every query runs against the real database.
const who = vi.hoisted(() => ({ ctx: null as unknown, reviewer: null as unknown }));
vi.mock('../../src/ai/context.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve(who.ctx),
}));
vi.mock('../../src/ai/draft-service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveReviewer: () => Promise.resolve(who.reviewer),
}));
// PR1b: the real engine, wrapped so one test can fail the approval AFTER the
// vendor, the bill and the entry were written.
vi.mock('../../src/services/accounting/posting.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/accounting/posting.js')>();
  return { ...real, createJournalEntry: vi.fn(real.createJournalEntry) };
});

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { grantApproval } from '../../src/ai/approval-policy.js';
import aiRouter from '../../src/api/rest/routes/ai.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { vendorToRegister } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { ingestCfdiFiles, type DraftCapture } from '../../src/ai/ingest-service.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import {
  approveDraft,
  autoApproveDraftByPolicy,
  canonicalDraftHash,
  getDraft,
  type DraftLine,
  type Reviewer,
} from '../../src/ai/draft-service.js';
import { reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { registerRepCommand } from '../../src/cli/rep-command.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { repXml } from './helpers/rep-xml.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';

// ============================================================
// ING-1 · #318 — APPROVING THE DRAFT OF A RECEIVED CFDI CREATES THE BILL.
//
// Measured before this tranche: after approving the agent's drafts,
// `bill list` said «No rows.», the pre-registrations stayed in 'ready' and the
// REP found no invoice to link. The entry posted and CxP did not exist.
//
// Everything here runs the real path: the CFDI is ingested through
// ingestCfdiFiles, the model is an OpenAI-compatible fake that calls the real
// draft_journal_entry tool, and the approval is approveDraft with the hash of
// what the reviewer saw.
// ============================================================

const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-2001.xml'),
  'utf8'
);
const FIXTURE_UUID = 'F7C0E1A3-6D41-4C8F-B05E-314C5D6E7F80';
const VENDOR_RFC = 'SIN060101AB1';

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

const PROFILE: ResolvedProfile = {
  name: 'fake',
  type: 'openai-compatible',
  model: 'fake-model',
  base_url: 'http://localhost.invalid/v1',
  stream: false,
  apiKey: 'sk-test',
};

/** The fixture CFDI with a fresh UUID; optionally another issuer or an ISR withholding of 800. */
function cfdi(o: { rfc?: string; name?: string; isr800?: boolean } = {}): { xml: string; uuid: string } {
  const uuid = uuidv4().toUpperCase();
  let xml = FIXTURE.replace(FIXTURE_UUID, uuid);
  if (o.rfc) xml = xml.replace(`Rfc="${VENDOR_RFC}"`, `Rfc="${o.rfc}"`);
  if (o.name) xml = xml.replace('Nombre="Servicios Integrales SA"', `Nombre="${o.name}"`);
  if (o.isr800) {
    xml = xml
      .replace('Total="9280.00"', 'Total="8480.00"')
      .replace(
        '<cfdi:Impuestos TotalImpuestosTrasladados="1280.00">',
        '<cfdi:Impuestos TotalImpuestosRetenidos="800.00" TotalImpuestosTrasladados="1280.00">' +
          '<cfdi:Retenciones><cfdi:Retencion Impuesto="001" Importe="800.00"/></cfdi:Retenciones>'
      );
  }
  return { xml, uuid };
}

/** The entry an accountant approves for the fixture, PPD: expense + pending VAT against CxP. */
const PPD: DraftLine[] = [
  { account_code: '6100', debit: 8000, description: 'Consultoria agosto' },
  { account_code: '1135', debit: 1280 },
  { account_code: '2110', credit: 9280 },
];

/**
 * Ingests one CFDI; the fake model answers the turn by calling
 * draft_journal_entry once per entry in `drafts`, then closes the turn.
 */
interface IngestOptions {
  /** Wire SessionCallbacks.draftOrigin as the CLI does (default true). */
  wired?: boolean;
  /** Replaces the provider's closing reply: may act mid-turn or throw. */
  secondReply?: (capture: DraftCapture) => Promise<unknown>;
  /** The ingest status this file is expected to end in (default 'draft'). */
  expectStatus?: string;
  /** Turns the auto-post on (default off: the draft waits for review). */
  autoPost?: boolean;
}

async function ingest(
  xml: string,
  drafts: DraftLine[][] = [PPD],
  o: IngestOptions = {}
): Promise<string[]> {
  const file = path.join(dir, `${uuidv4()}.xml`);
  fs.writeFileSync(file, xml);
  const call = (lines: DraftLine[], i: number) => ({
    id: `call_${i}`,
    type: 'function',
    function: {
      name: 'draft_journal_entry',
      arguments: JSON.stringify({
        entry_date: '2026-08-20',
        description: 'Servicios Integrales B2001',
        reference: 'B2001',
        confidence: 0.9,
        reasoning: 'Consulting expense on credit',
        lines,
      }),
    },
  });
  const capture: DraftCapture = { drafts: [] };
  const closing = {
    choices: [{ message: { role: 'assistant', content: 'Draft created.' }, finish_reason: 'stop' }],
  };
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: drafts.map(call) }, finish_reason: 'tool_calls' }],
    })
    .mockImplementation(async () => {
      if (o.secondReply) await o.secondReply(capture);
      return closing;
    });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const session = new OpenAiCompatSession(
    client, PROFILE, ctx, 'system',
    {
      onDraftCreated: (d) => capture.drafts.push(d),
      ...(o.wired === false ? {} : { draftOrigin: () => capture.origin }),
    },
    { grounding: { enabled: false }, cwd: dir }
  );
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file],
    thresholds: { autoPost: o.autoPost ?? false, minConfidence: 0.95, maxAmount: 10000 },
    session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe(o.expectStatus ?? 'draft');
  return capture.drafts.map((d) => d.draftId);
}

/** Approves with the hash of what the reviewer was shown, origin included. */
async function approve(draftId: string) {
  const d = await getDraft(ctx, draftId);
  return approveDraft(ctx, draftId, reviewer, undefined, canonicalDraftHash(d!.payload, d!.origin));
}

async function billsOf(uuid: string) {
  return (await query<{ id: string; amount_due: string; status: string; journal_entry_id: string | null }>(
    `SELECT id, amount_due::text, status, journal_entry_id FROM bills WHERE entity_id = $1 AND cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows;
}

async function preRegOf(uuid: string) {
  return (await query<{ id: string; status: string; bill_id: string | null; journal_entry_id: string | null }>(
    `SELECT p.id, p.status, p.bill_id, p.journal_entry_id
       FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2`,
    [f.entityId, uuid]
  )).rows[0];
}

async function entryCount(): Promise<number> {
  return Number((await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]
  )).rows[0].n);
}

async function statusOf(draftId: string): Promise<string> {
  return (await query<{ status: string }>(`SELECT status FROM ai_drafts WHERE id = $1`, [draftId])).rows[0].status;
}

beforeAll(async () => {
  f = await crearInquilino('ING-1 la factura nace al approve');
  ctx = {
    entityId: f.entityId, entityName: 'ING-1', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  who.ctx = ctx;
  who.reviewer = reviewer;
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ing1-'));
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'V-ING1', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [uuidv4(), f.entityId, VENDOR_RFC, f.userId]
  );
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('ING-1 · approving the draft of a received PPD CFDI', () => {
  it('creates the vendor bill, posts the entry as the bill and closes the pre-registration', async () => {
    const { xml, uuid } = cfdi();
    const [draftId] = await ingest(xml);
    const draft = await getDraft(ctx, draftId);
    expect(draft!.origin?.cfdi_uuid).toBe(uuid);

    const posted = await approve(draftId);

    const bills = await billsOf(uuid);
    expect(bills).toHaveLength(1);
    expect(bills[0].amount_due).toBe('9280.0000');
    expect(bills[0].status).toBe('posted');
    expect(bills[0].journal_entry_id).toBe(posted.entryId);

    const je = (await query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM journal_entries WHERE id = $1`, [posted.entryId]
    )).rows[0];
    expect(je).toEqual({ source_type: 'bill', source_id: bills[0].id });

    const pre = await preRegOf(uuid);
    expect(pre.status).toBe('completed');
    expect(pre.bill_id).toBe(bills[0].id);
    expect(pre.journal_entry_id).toBe(posted.entryId);

    const lines = (await query<{ line_amount: string }>(
      `SELECT line_amount::text FROM bill_lines WHERE bill_id = $1`, [bills[0].id]
    )).rows;
    expect(lines.map((l) => l.line_amount)).toEqual(['8000.0000']);
    expect(await statusOf(draftId)).toBe('approved');

    // `bill inbox run` over the same pre-registration skips it: no second entry.
    const before = await entryCount();
    const program = new Command('mnemosine').exitOverride();
    let exitCode: number | undefined;
    const reported: string[] = [];
    const id = (s: string) => s;
    registerBillCommand(program, {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { reported.push(String((e as Error)?.stack ?? e)); },
      confirm: () => Promise.resolve(true),
    });
    // The entity is named, as any writing command requires: the shared test
    // database holds other suites' entities, and the CLI refuses to guess.
    await program.parseAsync([
      'node', 'mnemosine', 'bill', 'inbox', 'run', pre.id, '--yes',
      '--entity', f.entityId, '--tenant', f.tenantId,
    ]);
    expect(exitCode, reported.join('\n')).toBe(0);
    expect(await entryCount()).toBe(before);
    expect(await billsOf(uuid)).toHaveLength(1);
  });

  it('an issuer missing from the vendor catalog rolls the whole approval back', async () => {
    const { xml, uuid } = cfdi({ rfc: 'NUE010101AAA', name: 'Proveedor Nuevo SC' });
    const [draftId] = await ingest(xml);
    const before = await entryCount();
    await expect(approve(draftId)).rejects.toThrow(/NUE010101AAA.*vendor catalog/);
    expect(await entryCount()).toBe(before);
    expect(await billsOf(uuid)).toHaveLength(0);
    expect(await statusOf(draftId)).toBe('pending_review');
    expect((await preRegOf(uuid)).status).not.toBe('completed');
  });

  it('two drafts of the same CFDI: the second one fails and rolls back', async () => {
    const { xml, uuid } = cfdi();
    const [first, second] = await ingest(xml, [PPD, PPD]);
    await approve(first);
    const before = await entryCount();
    await expect(approve(second)).rejects.toThrow(/no longer open/);
    expect(await entryCount()).toBe(before);
    expect(await billsOf(uuid)).toHaveLength(1);
    expect(await statusOf(second)).toBe('pending_review');
  });
});

// ============================================================
// ING-1 · #318 PR2 — THE REP LINKS THE APPROVED BILL AND RELEASES THE VAT.
//
// The PPD entry parks 1280 of VAT in 1135 (pending). The vendor's REP pays
// the bill: a payment is created through the payments gate, the bill's
// amount_due drops, and the same 1280 moves from 1135 to 1130 (creditable).
// ============================================================

const PAID_ON = new Date(Date.UTC(2026, 7, 25));

async function balanceOf(code: string, periodId: string): Promise<number> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(ab.debit_total - ab.credit_total, 0)::text AS s
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE a.entity_id = $1 AND a.code = $2 AND ab.fiscal_period_id = $3`,
    [f.entityId, code, periodId]
  );
  return Number(r.rows[0]?.s ?? 0);
}

async function periodOf(entryId: string): Promise<string> {
  return (await query<{ p: string }>(`SELECT fiscal_period_id AS p FROM journal_entries WHERE id = $1`, [entryId])).rows[0].p;
}

/** Uploads the vendor's REP for `uuid` and runs it; the parked outcome is returned, not thrown. */
async function ingestRep(uuid: string): Promise<{ preRegId: string; paymentId?: string; parked?: string }> {
  const svc = new PreRegistrationService();
  const up = await svc.processXMLUpload(
    f.entityId,
    repXml({ cfdiUuid: uuid, total: '9280.00', iva: 1280 }, uuidv4().toUpperCase(), {
      issuerRfc: VENDOR_RFC, issuerName: 'Servicios Integrales SA', date: PAID_ON,
    }),
    'manual_upload',
    f.userId
  );
  const preRegId = (up.preRegistration as { id: string }).id;
  try {
    const r = await svc.processToAccounting(up.preRegistration, f.userId);
    return { preRegId, paymentId: r.paymentId };
  } catch (e) {
    return { preRegId, parked: (e as Error).message };
  }
}

async function paymentsOf(billId: string) {
  return (await query<{ payment_id: string; amount_applied: string }>(
    `SELECT payment_id, amount_applied::text FROM payment_applications WHERE bill_id = $1`, [billId]
  )).rows;
}

describe('ING-1 · PR2: the REP of an approved PPD bill', () => {
  it('creates the payment, clears amount_due and moves the VAT from 1135 to 1130', async () => {
    const { xml, uuid } = cfdi();
    const [draftId] = await ingest(xml);
    const posted = await approve(draftId);
    const period = await periodOf(posted.entryId);
    const pendingBefore = await balanceOf('1135', period);
    const creditableBefore = await balanceOf('1130', period);

    const rep = await ingestRep(uuid);

    expect(rep.parked, 'the REP should link the approved bill').toBeUndefined();
    const [bill] = await billsOf(uuid);
    expect(bill.amount_due).toBe('0.0000');
    const payments = await paymentsOf(bill.id);
    expect(payments).toEqual([{ payment_id: rep.paymentId, amount_applied: '9280.0000' }]);
    expect(await balanceOf('1135', period)).toBeCloseTo(pendingBefore - 1280, 2);
    expect(await balanceOf('1130', period)).toBeCloseTo(creditableBefore + 1280, 2);
  });

  it('a REP ingested before the approval links later with `rep reconcile`', async () => {
    const { xml, uuid } = cfdi();
    const [draftId] = await ingest(xml);
    const early = await ingestRep(uuid);
    expect(early.parked, 'without a bill the REP must wait, not create anything').toMatch(/no tiene/);

    const posted = await approve(draftId);
    const period = await periodOf(posted.entryId);
    const pendingBefore = await balanceOf('1135', period);
    const creditableBefore = await balanceOf('1130', period);

    const program = new Command('mnemosine').exitOverride();
    let exitCode: number | undefined;
    const reported: string[] = [];
    const id = (s: string) => s;
    registerRepCommand(program, {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { reported.push(String((e as Error)?.stack ?? e)); },
    });
    await program.parseAsync([
      'node', 'mnemosine', 'rep', 'reconcile', '--entity', f.entityId, '--tenant', f.tenantId,
    ]);
    expect(exitCode, reported.join('\n')).toBe(0);

    const [bill] = await billsOf(uuid);
    expect(bill.amount_due).toBe('0.0000');
    expect(await paymentsOf(bill.id)).toHaveLength(1);
    const pre = (await query<{ status: string; result_type: string }>(
      `SELECT status, result_type FROM pre_registrations WHERE id = $1`, [early.preRegId]
    )).rows[0];
    expect(pre).toEqual({ status: 'completed', result_type: 'payment' });
    expect(await balanceOf('1135', period)).toBeCloseTo(pendingBefore - 1280, 2);
    expect(await balanceOf('1130', period)).toBeCloseTo(creditableBefore + 1280, 2);
  });
});

describe('ING-1 · the approved entry must match the CFDI', () => {
  async function refused(xml: string, lines: DraftLine[], message: RegExp) {
    const [draftId] = await ingest(xml, [lines]);
    const before = await entryCount();
    await expect(approve(draftId)).rejects.toThrow(message);
    expect(await entryCount()).toBe(before);
    expect(await statusOf(draftId)).toBe('pending_review');
  }

  it('a total that is not the CFDI total is refused, naming the figure', async () => {
    await refused(cfdi().xml, [
      { account_code: '6100', debit: 8001 },
      { account_code: '1135', debit: 1280 },
      { account_code: '2110', credit: 9281 },
    ], /total \(credit to accounts payable\) is 9281\.00 in the entry and 9280\.00 in the CFDI \(difference 1\.00\)/);
  });

  it('transferred VAT that is not the CFDI VAT is refused', async () => {
    await refused(cfdi().xml, [
      { account_code: '6100', debit: 8080 },
      { account_code: '1135', debit: 1200 },
      { account_code: '2110', credit: 9280 },
    ], /transferred VAT is 1200\.00 in the entry and 1280\.00 in the CFDI/);
  });

  it('a withholding that is not the CFDI withholding is refused', async () => {
    await refused(cfdi({ isr800: true }).xml, [
      { account_code: '6100', debit: 8000 },
      { account_code: '1135', debit: 1280 },
      { account_code: '2141', credit: 700 },
      { account_code: '2110', credit: 8580 },
    ], /ISR withheld is 700\.00 in the entry and 800\.00/);
  });

  it('with the withholding right, the bill is born for the net total', async () => {
    const { xml, uuid } = cfdi({ isr800: true });
    const [draftId] = await ingest(xml, [[
      { account_code: '6100', debit: 8000 },
      { account_code: '1135', debit: 1280 },
      { account_code: '2141', credit: 800 },
      { account_code: '2110', credit: 8480 },
    ]]);
    await approve(draftId);
    expect((await billsOf(uuid))[0].amount_due).toBe('8480.0000');
  });

  it('one cent of rounding passes with the default tolerance; two cents do not', async () => {
    const oneCent = cfdi();
    const [ok] = await ingest(oneCent.xml, [[
      { account_code: '6100', debit: 7999.99 },
      { account_code: '1135', debit: 1280.01 },
      { account_code: '2110', credit: 9280 },
    ]]);
    await approve(ok);
    expect(await billsOf(oneCent.uuid)).toHaveLength(1);

    await refused(cfdi().xml, [
      { account_code: '6100', debit: 7999.98 },
      { account_code: '1135', debit: 1280.02 },
      { account_code: '2110', credit: 9280 },
    ], /difference 0\.02\)/);
  });

  it('lineas_factura_desde = conceptos_cfdi refuses a split that is not one to one, and copies the concept when it is', async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde', 'conceptos_cfdi', reviewer.email);
    try {
      await refused(cfdi().xml, [
        { account_code: '6100', debit: 5000 },
        { account_code: '6100', debit: 3000 },
        { account_code: '1135', debit: 1280 },
        { account_code: '2110', credit: 9280 },
      ], /conceptos_cfdi needs the approved entry to split one to one/);

      const { xml, uuid } = cfdi();
      const [draftId] = await ingest(xml);
      await approve(draftId);
      const [bill] = await billsOf(uuid);
      const lines = (await query<{ description: string; tags: { clave_prod_serv?: string } }>(
        `SELECT description, tags FROM bill_lines WHERE bill_id = $1`, [bill.id]
      )).rows;
      expect(lines).toHaveLength(1);
      expect(lines[0].description).toMatch(/Consultoria en procesos/);
      expect(String(lines[0].tags.clave_prod_serv)).toBe('80101500');
    } finally {
      await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'lineas_factura_desde');
    }
  });
});

describe('ING-1 · the CFDI link is born with the draft (WIT-01)', () => {
  it('a provider failure after the draft is created leaves it bound, and one approval creates one bill', async () => {
    const { xml, uuid } = cfdi();
    const [draftId] = await ingest(xml, [PPD], {
      secondReply: async () => { throw new Error('provider down'); },
      expectStatus: 'error',
    });
    const draft = await getDraft(ctx, draftId);
    expect(draft!.status).toBe('pending_review');
    expect(draft!.origin?.cfdi_uuid).toBe(uuid);

    const before = await entryCount();
    const posted = await approve(draftId);
    expect(await entryCount()).toBe(before + 1);
    const bills = await billsOf(uuid);
    expect(bills).toHaveLength(1);
    expect(bills[0].journal_entry_id).toBe(posted.entryId);
    expect((await preRegOf(uuid)).status).toBe('completed');
  });

  it('a review that approves the draft before the turn ends already creates the bill', async () => {
    const { xml, uuid } = cfdi();
    let midTurn: { entryId: string } | undefined;
    await ingest(xml, [PPD], {
      secondReply: async (capture) => { midTurn = await approve(capture.drafts[0].draftId); },
    });
    expect(midTurn).toBeDefined();
    const bills = await billsOf(uuid);
    expect(bills).toHaveLength(1);
    expect(bills[0].journal_entry_id).toBe(midTurn!.entryId);
    expect((await preRegOf(uuid)).status).toBe('completed');
  });

  it('a session not wired with draftOrigin has its unbound drafts rejected, never left approvable', async () => {
    const { xml } = cfdi();
    const [draftId] = await ingest(xml, [PPD], { wired: false, expectStatus: 'error' });
    expect(await statusOf(draftId)).toBe('rejected');
    const draft = await getDraft(ctx, draftId);
    expect(draft!.pre_registration_id ?? null).toBeNull();
  });
});

describe('ING-1 · PR1b · proveedor_desconocido_al_aprobar', () => {
  // One issuer per test, RFC AND name: a «s» registers its vendor for good,
  // and the ingest matches vendors by name too (similarity > 0.7).
  const NEW_NAME = "Proveedor O'Nuevo SC";
  const pctx = () => ({ tenantId: f.tenantId, entityId: f.entityId });

  async function vendorsWith(rfc: string): Promise<number> {
    return Number((await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vendors WHERE entity_id = $1 AND tax_id = $2`, [f.entityId, rfc]
    )).rows[0].n);
  }

  /** A fresh CFDI from an unregistered issuer, ingested to one pending draft. */
  async function unknownIssuerDraft(rfc: string, o: IngestOptions = {}, name = `Emisor ${rfc}`) {
    const { xml, uuid } = cfdi({ rfc, name });
    const [draftId] = await ingest(xml, [PPD], o);
    const d = await getDraft(ctx, draftId);
    return { draftId, uuid, rfc, hash: canonicalDraftHash(d!.payload, d!.origin) };
  }

  /** Nothing of the act survived: no vendor, no bill, no entry, the draft pending. */
  async function nothingWritten(
    { draftId, uuid, rfc }: { draftId: string; uuid: string; rfc: string },
    entriesBefore: number
  ) {
    expect(await vendorsWith(rfc)).toBe(0);
    expect(await billsOf(uuid)).toHaveLength(0);
    expect(await entryCount()).toBe(entriesBefore);
    expect(await statusOf(draftId)).toBe('pending_review');
    expect((await preRegOf(uuid)).status).not.toBe('completed');
  }

  async function withAsk<T>(fn: () => Promise<T>): Promise<T> {
    await resolvePolicy(pctx(), 'proveedor_desconocido_al_aprobar', 'preguntar', reviewer.email);
    try {
      return await fn();
    } finally {
      await reopenPolicy(pctx(), 'proveedor_desconocido_al_aprobar');
    }
  }

  it('rechazar (default): refuses naming the RFC, the name and the command, and ignores a yes', async () => {
    const draft = await unknownIssuerDraft('NUE020202BBB', {}, NEW_NAME);
    const before = await entryCount();
    const err = await approve(draft.draftId).then(() => new Error('approved'), (e: unknown) => e as Error);
    expect(err.message).toContain('RFC NUE020202BBB');
    expect(err.message).toContain(NEW_NAME);
    expect(err.message).toContain("mnemosine vendor create 'Proveedor O'\\''Nuevo SC' --tax-id 'NUE020202BBB'");
    // Under 'rechazar' there is nothing to offer, and a consent changes nothing.
    expect(vendorToRegister(err)).toBeNull();
    await expect(approveDraft(ctx, draft.draftId, reviewer, undefined, draft.hash, undefined, { taxId: draft.rfc }))
      .rejects.toThrow(/vendor catalog/);
    await nothingWritten(draft, before);
  });

  it('preguntar + «N»: the same refusal as rechazar, and the review is told it may ask', async () => {
    await withAsk(async () => {
      const draft = await unknownIssuerDraft('NUE040404DDD');
      const before = await entryCount();
      const err = await approve(draft.draftId).then(() => new Error('approved'), (e: unknown) => e as Error);
      expect(err.message).toMatch(/RFC NUE040404DDD.*vendor catalog.*mnemosine vendor create/);
      expect(vendorToRegister(err)).toEqual({ name: 'Emisor NUE040404DDD', rfc: 'NUE040404DDD' });
      await nothingWritten(draft, before);
    });
  });

  it('preguntar + «s»: vendor, bill and entry are born together', async () => {
    await withAsk(async () => {
      const { draftId, uuid, hash } = await unknownIssuerDraft('NUE050505EEE');
      // A yes for another RFC is not a yes for this issuer.
      await expect(approveDraft(ctx, draftId, reviewer, undefined, hash, undefined, { taxId: VENDOR_RFC }))
        .rejects.toThrow(/vendor catalog/);
      const posted = await approveDraft(ctx, draftId, reviewer, undefined, hash, undefined, { taxId: 'NUE050505EEE' });
      const [vendor] = (await query<{ id: string; created_by: string }>(
        `SELECT id, created_by FROM vendors WHERE entity_id = $1 AND tax_id = $2`, [f.entityId, 'NUE050505EEE']
      )).rows;
      expect(vendor.created_by).toBe(reviewer.userId);
      const [bill] = await billsOf(uuid);
      expect(bill.journal_entry_id).toBe(posted.entryId);
      expect((await query<{ vendor_id: string }>(`SELECT vendor_id FROM bills WHERE id = $1`, [bill.id])).rows[0].vendor_id)
        .toBe(vendor.id);
      expect(await statusOf(draftId)).toBe('approved');
    });
  });

  it('preguntar + «s»: a failure after the vendor, the bill and the entry leaves none of the three', async () => {
    await withAsk(async () => {
      const draft = await unknownIssuerDraft('NUE030303CCC');
      const before = await entryCount();
      const real = (await vi.importActual<typeof import('../../src/services/accounting/posting.js')>(
        '../../src/services/accounting/posting.js'
      )).createJournalEntry;
      vi.mocked(createJournalEntry).mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new Error('injected after the entry');
      });
      await expect(approveDraft(ctx, draft.draftId, reviewer, undefined, draft.hash, undefined, { taxId: draft.rfc }))
        .rejects.toThrow(/injected/);
      expect(vi.mocked(createJournalEntry)).toHaveBeenCalled();
      await nothingWritten(draft, before);
    });
  });

  it('preguntar never asks through an unattended door: threshold, policy, ingest and REST all refuse', async () => {
    await withAsk(async () => {
      // Threshold auto-post: evaluarAutoPost already sends a new vendor to the
      // policy path, and approveDraft with the threshold's own arguments refuses.
      const threshold = await unknownIssuerDraft('NUE060606FFF', { autoPost: true });
      const before = await entryCount();
      await expect(approveDraft(ctx, threshold.draftId, reviewer, 'auto-post by threshold'))
        .rejects.toThrow(/vendor catalog/);
      await nothingWritten(threshold, before);

      // Approval policy, called directly and through the ingest's policy path.
      const grant = () => grantApproval(ctx, {
        scope: 'draft', pattern: { max_amount: '10000' }, mode: 'once', grantedBy: reviewer.email,
      });
      await grant();
      await expect(autoApproveDraftByPolicy(ctx, threshold.draftId, { configuredMaxAmount: 10000 }))
        .rejects.toThrow(/vendor catalog/);
      await nothingWritten(threshold, before);
      const policyId = await grant();
      const viaIngest = await unknownIssuerDraft('NUE060606FFF', { autoPost: true });
      expect((await query<{ used: boolean }>(
        `SELECT last_used_at IS NOT NULL AS used FROM ai_approval_policies WHERE id = $1 AND entity_id = $2`,
        [policyId, f.entityId]
      )).rows[0].used).toBe(true);
      await nothingWritten(viaIngest, before);

      // REST: even a body that asks for the vendor is not a person's yes.
      const server = await levantar([['/v1/ai', aiRouter]], sesionDe(f));
      try {
        const r = await pedir(server, 'POST', `/v1/ai/drafts/${threshold.draftId}/approve`, {
          notes: 'rest', allow_new_vendor: true, newVendor: { taxId: threshold.rfc },
        });
        expect(r.status).toBe(422);
        expect(JSON.stringify(r.body)).toContain(threshold.rfc);
      } finally {
        await server.cerrar();
      }
      await nothingWritten(threshold, before);
    });
  });
});
