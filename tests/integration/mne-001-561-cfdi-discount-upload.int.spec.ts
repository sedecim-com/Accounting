import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type OpenAI from 'openai';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { ingestCfdiFiles, type DraftCapture } from '../../src/ai/ingest-service.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import { approveDraft, canonicalDraftHash, getDraft, type DraftLine, type Reviewer } from '../../src/ai/draft-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';

// ============================================================
// MNE-001-561 (#729): A CFDI WITH A DISCOUNT IS INGESTED, RECEIVED OR ISSUED.
//
// Measured before: the upload threw «Invalid CFDI: Conceptos total does not
// match SubTotal» for every CFDI with a discount, before its direction was
// read, so nothing behind the parser ever received one. The fixture is the
// synthetic sale of 8,000.00 with a discount of 500.00 (VAT 1,200.00, total
// 8,700.00); the path is the real one, as in the ING-3 spec beside this file.
// ============================================================

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'factura-consultoria-descuento-2002.xml'), 'utf8');
const FIXTURE_UUID = 'A4D2B9C6-3E57-4F10-9B8A-52C7D6E8F901';
const OWN_RFC = 'XAXX010101000';
const OTHER_RFC = 'SIN060101AB1';

const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};

type Direction = 'received' | 'issued';

/** Each direction: the entry that nets the discount, the same entry gross, and where the document lands. */
const DOORS: Record<Direction, { net: DraftLine[]; gross: DraftLine[]; nonTax: string; table: string; refusal: RegExp }> = {
  received: {
    net: [{ account_code: '6100', debit: 7500 }, { account_code: '1135', debit: 1200 }, { account_code: '2110', credit: 8700 }],
    gross: [{ account_code: '6100', debit: 8000 }, { account_code: '1135', debit: 1200 }, { account_code: '2110', credit: 9200 }],
    nonTax: 'gasto', table: 'bills',
    refusal: /subtotal minus discount \(non-tax debits\) is 8000\.00 in the entry and 7500\.00 in the CFDI/,
  },
  issued: {
    net: [{ account_code: '1120', debit: 8700 }, { account_code: '4100', credit: 7500 }, { account_code: '2125', credit: 1200 }],
    gross: [{ account_code: '1120', debit: 9200 }, { account_code: '4100', credit: 8000 }, { account_code: '2125', credit: 1200 }],
    nonTax: 'ingreso', table: 'invoices',
    refusal: /subtotal minus discount \(non-tax credits\) is 8000\.00 in the entry and 7500\.00 in the CFDI/,
  },
};

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;

/** Ingests one CFDI; the fake model drafts each entry of `entries` in one turn and closes it. */
async function ingest(xml: string, entries: DraftLine[][]): Promise<string[]> {
  const file = path.join(dir, `${uuidv4()}.xml`);
  fs.writeFileSync(file, xml);
  const capture: DraftCapture = { drafts: [] };
  const call = (lines: DraftLine[], i: number) => ({
    id: `call_${i}`, type: 'function',
    function: {
      name: 'draft_journal_entry',
      arguments: JSON.stringify({
        entry_date: '2026-08-21', description: 'Consulting B2002', reference: 'B2002',
        confidence: 0.9, reasoning: 'Sale with a discount', lines,
      }),
    },
  });
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: entries.map(call) }, finish_reason: 'tool_calls' }],
    })
    .mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Drafts created.' }, finish_reason: 'stop' }] });
  const session = new OpenAiCompatSession(
    { chat: { completions: { create } } } as unknown as OpenAI, PROFILE, ctx, 'system',
    { onDraftCreated: (d) => capture.drafts.push(d), draftOrigin: () => capture.origin },
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

async function approve(draftId: string) {
  const d = await getDraft(ctx, draftId);
  return approveDraft(ctx, draftId, reviewer, undefined, canonicalDraftHash(d!.payload, d!.origin));
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-561 CFDI with a discount');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-561', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne561-'));
  // The counterparty is in both catalogs: neither door creates it from the XML.
  for (const [table, number] of [['vendors', 'vendor_number'], ['customers', 'customer_number']]) {
    await query(
      `INSERT INTO ${table} (id, entity_id, ${number}, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1, $2, 'MNE561', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
      [uuidv4(), f.entityId, OTHER_RFC, f.userId]
    );
  }
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a CFDI of 8,000.00 with a discount of 500.00 is uploaded', () => {
  it.each<Direction>(['received', 'issued'])(
    '%s: pre-registered with its SubTotal and Descuento; the proposal carries 7,500.00 on the non-tax side',
    async (direction) => {
      const door = DOORS[direction];
      const uuid = uuidv4().toUpperCase();
      let xml = FIXTURE.replace(FIXTURE_UUID, uuid);
      if (direction === 'issued') {
        xml = xml.replace(`<cfdi:Emisor Rfc="${OTHER_RFC}"`, `<cfdi:Emisor Rfc="${OWN_RFC}"`)
          .replace(`<cfdi:Receptor Rfc="${OWN_RFC}"`, `<cfdi:Receptor Rfc="${OTHER_RFC}"`);
      }
      const [grossDraft, netDraft] = await ingest(xml, [door.gross, door.net]);

      const stored = (await query<Record<string, string>>(
        `SELECT x.subtotal::text, x.descuento::text, x.total::text, p.subtotal::text AS pre_subtotal,
                p.total_amount::text AS pre_total, x.xml_content
           FROM xml_documents x JOIN pre_registrations p ON p.xml_document_id = x.id AND p.entity_id = x.entity_id
          WHERE x.entity_id = $1 AND x.cfdi_uuid = $2`,
        [f.entityId, uuid]
      )).rows[0];
      const { xml_content: storedXml, ...header } = stored;
      expect(header).toEqual({
        subtotal: '8000.0000', descuento: '500.0000', total: '8700.0000', pre_subtotal: '8000.0000', pre_total: '8700.0000',
      });

      // What the system itself proposes for the stored document.
      const proposal = await classifyXml(storedXml, {
        entityId: f.entityId, entityRfc: OWN_RFC, vendorExists: true, periodOpen: true, satStatus: 'vigente',
      });
      expect(proposal.verdict, proposal.reason).toBe('ready');
      const nonTax = proposal.lines.filter((l) => l.role === door.nonTax);
      expect(nonTax.map((l) => l.debit ?? l.credit)).toEqual([7500]);

      // Each door reconciles on «subtotal minus discount»: the gross entry is refused, the net one posts.
      await expect(approve(grossDraft)).rejects.toThrow(door.refusal);
      const posted = await approve(netDraft);
      const documents = (await query<{ total_amount: string; journal_entry_id: string }>(
        `SELECT total_amount::text, journal_entry_id FROM ${door.table} WHERE entity_id = $1 AND cfdi_uuid = $2`,
        [f.entityId, uuid]
      )).rows;
      expect(documents).toEqual([{ total_amount: '8700.0000', journal_entry_id: posted.entryId }]);
    }
  );
});
