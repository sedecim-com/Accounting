import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { answerHeldDecision } from '../../src/services/xml-ingestion/decision-answers.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { serializeSatBatch } from '../../src/services/sat/diot/sat-batch.js';
import { buildIvaWorkpaper } from '../../src/services/fiscal/iva-workpaper.js';
import { textIn } from '../../src/utils/errors.js';

// ============================================================
// MNE-001-906 (#1075), part 2 of 2 · THE IVA OF A NON-DEDUCTIBLE EXPENSE IS
// NOT CREDITED: NOT BY THE LEDGER, NOT BY THE IVA PAPER, NOT BY THE DIOT.
//
// Measured before: a bill posted DR 6900 5,800.00 · CR 2110 5,800.00 with a
// header IVA of 800.00 parks nothing, so the facts declared it in the BILL's
// month, paid or not, with 800.00 of IVA and no split by rate.
//
// Three received CFDIs dated 2026-08-10 (LISR art. 27 fr. III; LIVA art. 5o. fr. I):
//
//   cash   · FormaPago 01, 5,000.00 + 800.00, answered «no_deducible»,
//            paid whole in cash on 2026-09-05
//   halves · the same, paid 2,900.00 on 2026-09-10 and 2,900.00 on 2026-10-03
//   plain  · FormaPago 03, 3,500.00 + 560.00, from another vendor, paid by
//            transfer on 2026-09-06: creditable, to prove nothing else moves
// ============================================================

const service = new PreRegistrationService();
const GOLDEN = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');
const NOT_CREDITABLE = 'DIOT-IVA-NOT-CREDITABLE';

/** The golden received service (3,500.00 + 560.00, FormaPago 03) with a fresh UUID. */
const plainXml = () =>
  GOLDEN.replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuidv4().toUpperCase()}"`)
    .replace('Rfc="LIM040404LM8" Nombre="Limpieza Corporativa del Centro SA de CV"', 'Rfc="SIN060101AB1" Nombre="Servicios Integrales del Norte SA de CV"');
/** The same service from its own issuer, in cash and scaled to 5,000.00 + 800.00. */
const cashXml = () =>
  GOLDEN.replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuidv4().toUpperCase()}"`)
    .replace('FormaPago="03"', 'FormaPago="01"')
    .replace('SubTotal="3500.00" Total="4060.00"', 'SubTotal="5000.00" Total="5800.00"')
    .replace('ValorUnitario="3500.00" Importe="3500.00"', 'ValorUnitario="5000.00" Importe="5000.00"')
    .replace('TotalImpuestosTrasladados="560.00"', 'TotalImpuestosTrasladados="800.00"')
    .replace('Base="3500.00"', 'Base="5000.00"')
    .replace('Importe="560.00"', 'Importe="800.00"');

let f: Fixture;
const vendors: Record<'cash' | 'plain', string> = { cash: uuidv4(), plain: uuidv4() };
const bills: Record<'cash' | 'halves' | 'plain', { id: string; entry: string; number: string }> = {} as never;
type Month = { diot: Awaited<ReturnType<typeof construirDiot>>; paper: Awaited<ReturnType<typeof buildIvaWorkpaper>> };
const months: Record<number, Month> = {};
let augustUnpaid: Month;

/** Uploads, answers when the CFDI is cash, and runs it through `bill inbox run`'s service. */
async function post(xml: string, cash: boolean): Promise<{ id: string; entry: string; number: string }> {
  const up = await service.processXMLUpload(f.entityId, xml, 'api', f.userId);
  const id = up.preRegistration.id as string;
  await query(
    `UPDATE pre_registrations SET status = 'ready', default_account_id = $3 WHERE id = $1 AND entity_id = $2`,
    [id, f.entityId, f.cuentas['6100']]
  );
  const row = async () =>
    (await query<Record<string, unknown>>(`SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [id, f.entityId])).rows[0];
  if (cash) {
    await expect(service.processToAccounting(await row(), f.userId)).rejects.toMatchObject({ code: 'CFDI_REQUIERE_DECISION' });
    await answerHeldDecision(f.entityId, id, { decision: 'efectivo_no_deducible', answer: 'no_deducible' }, f.userId);
  }
  const bill = (await service.processToAccounting(await row(), f.userId)).bill as { id: string };
  const b = await query<{ entry: string; number: string }>(
    `SELECT journal_entry_id::text AS entry, bill_number AS number FROM bills WHERE id = $1 AND entity_id = $2`, [bill.id, f.entityId]
  );
  return { id: bill.id, ...b.rows[0] };
}

async function linesOf(entryId: string): Promise<string[]> {
  const { rows } = await query<{ line: string }>(
    `SELECT a.code || ' ' || COALESCE(l.debit_amount, 0)::numeric(19,2) || '/' || COALESCE(l.credit_amount, 0)::numeric(19,2) AS line
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 ORDER BY a.code`,
    [entryId]
  );
  return rows.map((r) => r.line);
}

const pay = (vendor: 'cash' | 'plain', billId: string, amount: string, date: string, method: string) =>
  recordVendorPayment(
    { entityId: f.entityId, counterpartyId: vendors[vendor], paymentAmount: amount, paymentDate: date, paymentMethod: method,
      applications: [{ documentId: billId, amountApplied: amount }] },
    f.userId
  );

const monthOf = async (month: number): Promise<Month> => ({
  diot: await construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: month }),
  paper: await buildIvaWorkpaper({ tenantId: f.tenantId, entityId: f.entityId, year: 2026, month }),
});

const documentOf = (m: Month, billId: string) => m.diot.renglones.flatMap((r) => r.documentos).find((d) => d.billId === billId);
const noticesOf = (findings: Month['diot']['hallazgos'], billId: string) =>
  findings.filter((h) => h.documentId === billId).map((h) => h.codigo);
const noticeText = (m: Month, billId: string) =>
  textIn(m.diot.hallazgos.find((h) => h.documentId === billId && h.codigo === NOT_CREDITABLE)!.mensaje, 'en');

let paid: { cash: string; plain: string };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-906 non-deductible VAT facts');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  for (const [key, rfc, name] of [
    ['cash', 'LIM040404LM8', 'Limpieza Corporativa del Centro SA de CV'],
    ['plain', 'SIN060101AB1', 'Servicios Integrales del Norte SA de CV'],
  ] as const) {
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1, $2, $3, $4, $5, 'rfc', 'MXN', $6)`,
      [vendors[key], f.entityId, `V-${key}`, name, rfc, f.userId]
    );
  }
  bills.cash = await post(cashXml(), true);
  bills.halves = await post(cashXml(), true);
  bills.plain = await post(plainXml(), false);
  augustUnpaid = await monthOf(8);

  paid = {
    cash: (await pay('cash', bills.cash.id, '5800.00', '2026-09-05', 'cash')).journalEntry!.id,
    plain: (await pay('plain', bills.plain.id, '4060.00', '2026-09-06', 'spei')).journalEntry!.id,
  };
  await pay('cash', bills.halves.id, '2900.00', '2026-09-10', 'spei');
  await pay('cash', bills.halves.id, '2900.00', '2026-10-03', 'spei');
  for (const m of [8, 9, 10]) months[m] = await monthOf(m);
}, 300_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the ledger credits nothing', () => {
  it('the bill debits 5,800.00 to the non-deductible expense, and keeps its header IVA of 800.00', async () => {
    expect(await linesOf(bills.cash.entry)).toEqual(['2110 0.00/5800.00', '6900 5800.00/0.00']);
    expect(await linesOf(bills.plain.entry)).toEqual(['1135 560.00/0.00', '2110 0.00/4060.00', '6100 3500.00/0.00']);
    const header = await query<{ tax: string }>(
      `SELECT tax_amount::numeric(19,2)::text AS tax FROM bills WHERE id = $1 AND entity_id = $2`, [bills.cash.id, f.entityId]
    );
    expect(header.rows[0].tax).toBe('800.00');
  });

  it('its payment moves no IVA; the creditable bill beside it releases its 560.00', async () => {
    const cashAccount = (await linesOf(paid.cash)).filter((l) => !l.startsWith('2110'));
    expect(await linesOf(paid.cash)).toHaveLength(2);
    expect(cashAccount.every((l) => !/^113[05] /.test(l))).toBe(true);
    expect((await linesOf(paid.plain)).filter((l) => /^113[05] /.test(l))).toEqual(['1130 560.00/0.00', '1135 0.00/560.00']);
  });
});

describe('the DIOT and the IVA paper follow the ledger', () => {
  it('unpaid, the bill is in no month: not in its own, and no notice says its IVA waits on 1135', () => {
    for (const built of [augustUnpaid, months[8]]) {
      expect(built.diot.renglones).toEqual([]);
      for (const key of ['cash', 'halves'] as const) {
        expect(noticesOf(built.diot.hallazgos, bills[key].id)).toEqual([]);
        expect(noticesOf(built.paper.findings, bills[key].id)).toEqual([]);
      }
      expect(built.paper.figures.creditable.tasa16).toEqual({ base: '0.0000', iva: '0.0000' });
    }
    // The creditable PUE beside it still says it waits for its payment.
    expect(noticesOf(augustUnpaid.diot.hallazgos, bills.plain.id)).toEqual(['DIOT-PUE-ESPERA-PAGO']);
  });

  it('paid in September: 0.0000 creditable, 800.0000 named as not creditable, the value of the acts declared', () => {
    const sep = months[9];
    expect(documentOf(sep, bills.cash.id)).toMatchObject({
      ivaPagado: '0.0000',
      nonCreditableVat: '800.0000',
      desglose: { tasa16: { base: '5000.0000', iva: '0.0000' } },
    });
    expect(noticesOf(sep.diot.hallazgos, bills.cash.id)).toEqual([NOT_CREDITABLE]);
    expect(sep.diot.hallazgos.find((h) => h.documentId === bills.cash.id)!.severidad).toBe('aviso');
    expect(noticeText(sep, bills.cash.id)).toContain(`Bill ${bills.cash.number}: 800.0000 of IVA paid this month is not creditable`);
    expect(noticeText(sep, bills.cash.id)).toContain('LIVA art. 5o. fr. I');

    // The creditable bill is untouched: 3,500.00 and its 560.00.
    const plain = documentOf(sep, bills.plain.id)!;
    expect(plain).toMatchObject({ ivaPagado: '560.0000', desglose: { tasa16: { base: '3500.0000', iva: '560.0000' } } });
    expect(plain.nonCreditableVat).toBeUndefined();
    // 560.00 is all the month credits: 5,000.00 + 2,500.00 + 3,500.00 = 11,000.00 of acts at 16 %.
    expect(sep.diot.totales.ivaAcreditablePagado).toBe('560.0000');
    expect(sep.diot.totales.desglose.tasa16).toEqual({ base: '11000.0000', iva: '560.0000' });
  });

  it('paid in two halves, each month names its 400.0000 and credits nothing', () => {
    for (const m of [9, 10]) {
      expect(documentOf(months[m], bills.halves.id)).toMatchObject({
        ivaPagado: '0.0000', nonCreditableVat: '400.0000', desglose: { tasa16: { base: '2500.0000', iva: '0.0000' } },
      });
      expect(noticesOf(months[m].diot.hallazgos, bills.halves.id)).toEqual([NOT_CREDITABLE]);
      expect(noticeText(months[m], bills.halves.id)).toContain('400.0000 of IVA');
    }
    expect(months[10].diot.totales.ivaAcreditablePagado).toBe('0.0000');
  });

  it('the paper credits 560.00 in September and 0.00 in October, ties to 1130 and lists the notices', () => {
    const [sep, oct] = [months[9].paper, months[10].paper];
    expect(sep.figures.creditable.tasa16).toEqual({ base: '11000.0000', iva: '560.0000' });
    expect(sep.ledger.iva_acreditable).toBe('560.0000');
    expect(oct.figures.creditable.tasa16).toEqual({ base: '2500.0000', iva: '0.0000' });
    expect(oct.ledger.iva_acreditable).toBe('0.0000');
    for (const paper of [sep, oct]) {
      expect(paper.findings.map((h) => h.codigo)).not.toContain('IVA-WP-CREDITABLE-VS-LEDGER');
      expect(paper.findings.map((h) => h.codigo)).not.toContain('DIOT-TOPE-APARCADO');
      expect(paper.findings.map((h) => h.codigo)).not.toContain('DIOT-IVA-CABECERA');
    }
    expect(noticesOf(sep.findings, bills.cash.id)).toEqual([NOT_CREDITABLE]);
    expect(noticesOf(sep.findings, bills.halves.id)).toEqual([NOT_CREDITABLE]);
    expect(noticesOf(oct.findings, bills.halves.id)).toEqual([NOT_CREDITABLE]);
  });

  it('the file is not refused: the vendor\'s record carries 7,500 of acts at 16 % and 0 of creditable IVA', () => {
    const { file, refusals } = serializeSatBatch(months[9].diot, { proportion: 'taxed_only' });
    expect(refusals).toEqual([]);
    const records = file.split(/\r?\n/).filter(Boolean).map((line) => line.split('|'));
    const of = (rfc: string) => records.find((r) => r[2] === rfc)!;
    // Fields 12 and 22 of the layout: value of the acts paid at 16 % and its creditable IVA.
    expect([of('LIM040404LM8')[11], of('LIM040404LM8')[21]]).toEqual(['7500', '0']);
    expect([of('SIN060101AB1')[11], of('SIN060101AB1')[21]]).toEqual(['3500', '560']);
  });
});

describe('the same road for any answer that makes the expense non-deductible', () => {
  it('a restaurant CFDI under the panel answer politica_restaurantes = no_deducible: 2,000.00 + 320.00 to 6900', async () => {
    const g = await crearInquilino('MNE-001-906 restaurant, all non-deductible');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    await resolvePolicy({ tenantId: g.tenantId, entityId: g.entityId }, 'politica_restaurantes', 'no_deducible', g.userId);
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
       VALUES ($1, $2, 'V-rest', 'Limpieza Corporativa del Centro SA de CV', 'LIM040404LM8', 'rfc', 'MXN', $3)`,
      [uuidv4(), g.entityId, g.userId]
    );
    // Fixture description stays in Spanish: it is invoice data matched by the Spanish-language rules.
    const xml = GOLDEN.replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuidv4().toUpperCase()}"`)
      .replace('Descripcion="Servicio mensual de limpieza de oficinas - agosto 2026"', 'Descripcion="Consumo de alimentos en restaurante"')
      .replace('SubTotal="3500.00" Total="4060.00"', 'SubTotal="2000.00" Total="2320.00"')
      .replace('ValorUnitario="3500.00" Importe="3500.00"', 'ValorUnitario="2000.00" Importe="2000.00"')
      .replace('TotalImpuestosTrasladados="560.00"', 'TotalImpuestosTrasladados="320.00"')
      .replace('Base="3500.00"', 'Base="2000.00"')
      .replace('Importe="560.00"', 'Importe="320.00"');
    const up = await service.processXMLUpload(g.entityId, xml, 'api', g.userId);
    await query(
      `UPDATE pre_registrations SET status = 'ready', default_account_id = $3 WHERE id = $1 AND entity_id = $2`,
      [up.preRegistration.id, g.entityId, g.cuentas['6100']]
    );
    const row = await query<Record<string, unknown>>(
      `SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`, [up.preRegistration.id, g.entityId]
    );
    const posted = await service.processToAccounting(row.rows[0], g.userId);
    expect(await linesOf(String(posted.journalEntry!.id))).toEqual(['2110 0.00/2320.00', '6900 2320.00/0.00']);
  }, 120_000);
});
