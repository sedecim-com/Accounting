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

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, type DraftCapture } from '../../src/ai/ingest-service.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import {
  approveDraft,
  canonicalDraftHash,
  getDraft,
  type DraftLine,
  type Reviewer,
} from '../../src/ai/draft-service.js';
import { reopenPolicy, resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { registerBillCommand } from '../../src/cli/bill-command.js';
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
async function ingest(xml: string, drafts: DraftLine[][] = [PPD]): Promise<string[]> {
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
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: drafts.map(call) }, finish_reason: 'tool_calls' }],
    })
    .mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'Draft created.' }, finish_reason: 'stop' }],
    });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const capture: DraftCapture = { drafts: [] };
  const session = new OpenAiCompatSession(
    client, PROFILE, ctx, 'system',
    { onDraftCreated: (d) => capture.drafts.push(d) },
    { grounding: { enabled: false }, cwd: dir }
  );
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file],
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 10000 },
    session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe('draft');
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
    const id = (s: string) => s;
    registerBillCommand(program, {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id } as never,
      shutdown: (c: number) => { exitCode = c; },
      reportError: () => undefined,
      confirm: () => Promise.resolve(true),
    });
    await program.parseAsync(['node', 'mnemosine', 'bill', 'inbox', 'run', pre.id, '--yes']);
    expect(exitCode).toBe(0);
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
      { account_code: '2140', credit: 700 },
      { account_code: '2110', credit: 8580 },
    ], /withholdings \(ISR \+ VAT, same account\) is 700\.00 in the entry and 800\.00/);
  });

  it('with the withholding right, the bill is born for the net total', async () => {
    const { xml, uuid } = cfdi({ isr800: true });
    const [draftId] = await ingest(xml, [[
      { account_code: '6100', debit: 8000 },
      { account_code: '1135', debit: 1280 },
      { account_code: '2140', credit: 800 },
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
