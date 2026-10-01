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
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { ResolvedProfile } from '../../src/ai/providers/types.js';
import { buildIvaWorkpaper, type IvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';

// ============================================================
// MNE-001-058 · A SALE THAT ENTERS AS ITS CFDI XML (review of PR #512)
//
// The main real-world path for sales: an issued CFDI ingested, drafted and
// approved (ING-3), which writes invoice_lines WITHOUT tax and keeps the IVA
// on the invoice header. The workpaper must split it by the CFDI:
//
//   issued PPD on 2026-08-20, collected half on 2026-09-20:
//     2 000 at 16 % (320) · 1 000 exempt · 500 no objeto (ObjetoImp 01)
//     the customer withholds 4 % of 2 000 = 80 of IVA
//     subtotal 3 500, total 3 500 + 320 − 80 = 3 740; collected 1 870
//
//   August:    nothing collected, nothing withheld: the 80 posted at issuance
//              is NOT this month's retention (LIVA art. 1-A: at payment).
//   September: 16 % base 1 000, IVA 160 · exempt base 500 · no objeto 250
//              withheld 40 (half of 80) · payable 160 − 40 = 120
// ============================================================

const OWN_RFC = 'XAXX010101000';
const CUSTOMER_RFC = 'SIN060101AB1';

const PROFILE: ResolvedProfile = {
  name: 'fake', type: 'openai-compatible', model: 'fake-model',
  base_url: 'http://localhost.invalid/v1', stream: false, apiKey: 'sk-test',
};

function issuedXml(uuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="W" Folio="58" Fecha="2026-08-20T10:00:00" FormaPago="99" MetodoPago="PPD" TipoDeComprobante="I" Moneda="MXN" SubTotal="3500.00" Total="3740.00" LugarExpedicion="06600">
  <cfdi:Emisor Rfc="${OWN_RFC}" Nombre="Demo Corp MX" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${CUSTOMER_RFC}" Nombre="Servicios Integrales SA" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="78101800" ClaveUnidad="E48" Descripcion="Flete" Cantidad="1" ValorUnitario="2000.00" Importe="2000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados><cfdi:Traslado Base="2000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="320.00"/></cfdi:Traslados>
        <cfdi:Retenciones><cfdi:Retencion Base="2000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.040000" Importe="80.00"/></cfdi:Retenciones>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="86121500" ClaveUnidad="E48" Descripcion="Colegiatura" Cantidad="1" ValorUnitario="1000.00" Importe="1000.00" ObjetoImp="02">
      <cfdi:Impuestos>
        <cfdi:Traslados><cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="84111506" ClaveUnidad="ACT" Descripcion="Reembolso" Cantidad="1" ValorUnitario="500.00" Importe="500.00" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosRetenidos="80.00" TotalImpuestosTrasladados="320.00">
    <cfdi:Retenciones><cfdi:Retencion Impuesto="002" Importe="80.00"/></cfdi:Retenciones>
    <cfdi:Traslados>
      <cfdi:Traslado Base="2000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="320.00"/>
      <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Exento"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="2026-08-20T10:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="selloCFD" NoCertificadoSAT="30001000000500000001" SelloSAT="selloSAT"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

/** The entry an accountant approves: the IVA parked in 2125, the withholding in 1146. */
const SALE: DraftLine[] = [
  { account_code: '1120', debit: 3740 },
  { account_code: '1146', debit: 80 },
  { account_code: '4100', credit: 3500, description: 'Venta W58' },
  { account_code: '2125', credit: 320 },
];

let f: Fixture;
let ctx: AgentContext;
let reviewer: Reviewer;
let dir: string;
let customerId: string;
let invoiceId: string;
let august: IvaWorkpaper;
let september: IvaWorkpaper;

async function ingest(xml: string, lines: DraftLine[]): Promise<string> {
  const file = path.join(dir, `${uuidv4()}.xml`);
  fs.writeFileSync(file, xml);
  const capture: DraftCapture = { drafts: [] };
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_0', type: 'function',
            function: {
              name: 'draft_journal_entry',
              arguments: JSON.stringify({
                entry_date: '2026-08-20', description: 'Venta W58', reference: 'W58',
                confidence: 0.9, reasoning: 'Issued sale', lines,
              }),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    .mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Draft created.' }, finish_reason: 'stop' }] });
  const session = new OpenAiCompatSession(
    { chat: { completions: { create } } } as unknown as OpenAI, PROFILE, ctx, 'system',
    { onDraftCreated: (d) => capture.drafts.push(d), draftOrigin: () => capture.origin },
    { grounding: { enabled: false }, cwd: dir }
  );
  const report = await ingestCfdiFiles({
    ctx, reviewer, files: [file],
    thresholds: { autoPost: false, minConfidence: 0.95, maxAmount: 100000 },
    session, capture,
  });
  expect(report.results[0].status, report.results[0].detail).toBe('draft');
  return capture.drafts[0].draftId;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-058 venta por CFDI');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-058 CFDI', tenantId: f.tenantId, currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: OWN_RFC,
  };
  const email = (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [f.userId])).rows[0].email;
  reviewer = { userId: f.userId, email };
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mne058-cfdi-'));
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1, $2, 'C-058X', 'Servicios Integrales SA', $3, 'rfc', 'MXN', $4)`,
    [customerId, f.entityId, CUSTOMER_RFC, f.userId]
  );

  const uuid = uuidv4().toUpperCase();
  const draftId = await ingest(issuedXml(uuid), SALE);
  const d = await getDraft(ctx, draftId);
  await approveDraft(ctx, draftId, reviewer, undefined, canonicalDraftHash(d!.payload, d!.origin));
  invoiceId = (await query<{ id: string }>(
    `SELECT id FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2`, [f.entityId, uuid]
  )).rows[0].id;

  await recordCustomerPayment(
    {
      entityId: f.entityId, counterpartyId: customerId, paymentAmount: '1870', paymentDate: '2026-09-20',
      paymentMethod: 'spei', applications: [{ documentId: invoiceId, amountApplied: '1870' }],
    },
    f.userId
  );

  august = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 8 });
  september = await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month: 9 });
}, 240_000);

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a sale born from its CFDI is split by the CFDI, on cash basis', () => {
  it('the approved invoice carries its IVA on the header and none on its lines', async () => {
    const r = await query<{ header: string; lines: string }>(
      `SELECT i.tax_amount::text AS header, SUM(il.tax_amount)::text AS lines
         FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id WHERE i.id = $1 GROUP BY i.id`,
      [invoiceId]
    );
    expect(r.rows[0]).toEqual({ header: '320.0000', lines: '0.0000' });
  });

  it('the month it is issued declares nothing of it: not the IVA, not the 80 withheld at issuance', () => {
    expect(august.figures.charged.tasa16).toEqual({ base: '0.0000', iva: '0.0000' });
    expect(august.figures.withheldByCustomers).toBe('0.0000');
    expect(august.ledger.iva_retenido_a_favor).toBe('80.0000');
    expect(august.findings.map((h) => h.codigo)).not.toContain('IVA-WP-WITHHELD-VS-LEDGER');
  });

  it('the month it is collected: 16 %, exempt and no objeto by the CFDI, half of each', () => {
    const c = september.figures.charged;
    expect(c.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(c.exento).toEqual({ base: '500.0000', iva: '0.0000' });
    expect(c.tasa0).toEqual({ base: '0.0000', iva: '0.0000' });
    expect(september.figures.chargedNotSubject).toBe('250.0000');
    expect(september.blockedBy).toEqual([]);
    expect(september.findings.map((h) => h.codigo)).not.toContain('DIOT-IVA-CABECERA');
  });

  it('the IVA withheld follows the collection: 40 of the 80, and 120 payable', () => {
    expect(september.figures.withheldByCustomers).toBe('40.0000');
    expect(september.settlement?.resultCents).toBe('120.00');
    expect(september.settlement?.resultWhole).toBe('120');
  });

  it('exempt and no objeto acts collected: both count in the proportion (MNE-001-385)', () => {
    // 1 000 taxed of 1 000 + 500 exempt + 250 no objeto; no IVA paid, so nothing to credit.
    expect(september.figures.proration).toMatchObject({
      method: 'monthly', taxedActs: '1000.0000', totalActs: '1750.0000', factor: '0.571429', creditable: '0.0000',
    });
    expect(september.findings.map((h) => h.codigo)).not.toContain('IVA-WP-PRORATION-NOT-APPLIED');
    expect(september.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CHARGED-VS-LEDGER');
  });
});
