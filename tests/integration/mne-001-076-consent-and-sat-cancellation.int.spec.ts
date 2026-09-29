import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { runArChecks } from '../../src/services/ar/ar-controls.js';
import { revalidateEntityCfdis, type FetchImpl } from '../../src/services/sat/cfdi-status.js';
import { CONSENT_VERSION, storeCredential } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';

// ============================================================
// MNE-001-076 (#313), against a real database.
//
// 1. A consent given under an earlier CONSENT_VERSION keeps its version when
//    a new e.firma is stored under the new text: the old row is revoked, not
//    rewritten.
// 2. The SAT's word reaches the invoice: when the status query finds an
//    issued CFDI cancelled, `invoices.cfdi_status` becomes 'cancelled' and
//    the `cancelled-cfdi-open` AR control lights up. Before this bridge the
//    mirror said «Cancelado» and the control never fired.
//
// Synthetic data only: the fixture e.firma of tests/fixtures/certs and a
// fake SAT that answers with a fixture SOAP envelope.
// ============================================================

const OLD_VERSION = '2026-08-1';
const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'certs');
const FIEL_RFC = 'AAA010101AAA';

let f: Fixture;

const satAnswers = (satState: string): FetchImpl => async () =>
  new Response(
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<ConsultaResponse xmlns="http://tempuri.org/"><ConsultaResult xmlns:a="http://schemas.datacontract.org/2004/07/Sat.Cfdi">' +
      `<a:CodigoEstatus>S - Comprobante obtenido satisfactoriamente.</a:CodigoEstatus><a:Estado>${satState}</a:Estado>` +
      '<a:EsCancelable>Cancelable sin aceptación</a:EsCancelable><a:EstatusCancelacion>Cancelado sin aceptación</a:EstatusCancelacion>' +
      '</ConsultaResult></ConsultaResponse></s:Body></s:Envelope>',
    { status: 200 }
  );

async function customer(entityId: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, 'Synthetic customer', 'MXN', $4)`,
    [id, entityId, `C-${id.slice(0, 8)}`, f.userId]
  );
  return id;
}

/** A stamped, unpaid invoice carrying `cfdiUuid`. */
async function stampedInvoice(entityId: string, cfdiUuid: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
       total_amount, amount_due, currency_code, invoice_date, due_date, status,
       cfdi_uuid, cfdi_status, created_by)
     VALUES ($1, $2, $3, $4, 1000, 160, 1160, 1160, 'MXN', CURRENT_DATE, CURRENT_DATE, 'sent',
       $5, 'stamped', $6)`,
    [id, entityId, `INV-${id.slice(0, 8)}`, await customer(entityId), cfdiUuid, f.userId]
  );
  return id;
}

/** The SAT mirror row of an issued CFDI, not yet queried. */
async function mirror(entityId: string, cfdiUuid: string): Promise<void> {
  await query(
    `INSERT INTO xml_documents (entity_id, document_type, cfdi_uuid, cfdi_version, cfdi_fecha,
       emisor_rfc, receptor_rfc, subtotal, total, moneda, xml_content, xml_hash,
       import_source, processing_status)
     VALUES ($1, 'cfdi_ingreso', $2, '4.0', NOW(), 'XAXX010101000', 'SIN060101AB1',
       1000, 1160, 'MXN', '<x/>', $3, 'manual_upload', 'completed')`,
    [entityId, cfdiUuid, cfdiUuid]
  );
}

async function cancelledControl(entityId: string): Promise<number> {
  const r = await runArChecks(entityId, { checks: ['cancelled-cfdi-open'] });
  return r.results[0].count;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-076 consent and SAT cancellation');
});

afterAll(async () => {
  setVaultForTesting(null);
  await drainAttestations(2000);
  await closeDatabase();
});

describe('consent versions', () => {
  it('stores a new e.firma under the current version and leaves the earlier consent with its own', async () => {
    await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`,
      [FIEL_RFC, f.entityId, f.tenantId]);
    const old = await query<{ id: string; consent_at: Date }>(
      `INSERT INTO fiscal_credentials (
         tenant_id, entity_id, credential_type, rfc, cert_serial,
         valid_from, valid_to, vault_backend, vault_ref,
         consent_at, consent_by, consent_version
       ) VALUES ($1,$2,'efirma',$3,'30001000000400000076',
         NOW() - interval '1 year', NOW() + interval '1 year', 'test', 'test://old',
         NOW() - interval '30 days', 'earlier@example.test', $4)
       RETURNING id, consent_at`,
      [f.tenantId, f.entityId, FIEL_RFC, OLD_VERSION]
    );

    const vault = {
      backend: 'test',
      put: async () => ({ backend: 'test', ref: 'test://new', version: null }),
      get: async () => Buffer.alloc(0),
      destroy: async () => undefined,
      healthCheck: async () => ({ ok: true }),
    } as unknown as SecretVault;
    setVaultForTesting(vault);

    const stored = await storeCredential({
      tenantId: f.tenantId,
      entityId: f.entityId,
      material: {
        cer: fs.readFileSync(path.join(CERT_DIR, 'fiel.cer')),
        key: fs.readFileSync(path.join(CERT_DIR, 'fiel.key')),
        password: 'test1234',
      },
      consentBy: 'current@example.test',
    });

    const rows = await query<{ id: string; status: string; consent_version: string; consent_at: Date; consent_by: string }>(
      `SELECT id, status, consent_version, consent_at, consent_by FROM fiscal_credentials
        WHERE entity_id = $1 AND tenant_id = $2`,
      [f.entityId, f.tenantId]
    );
    const before = rows.rows.find((r) => r.id === old.rows[0].id)!;
    const now = rows.rows.find((r) => r.id === stored.id)!;

    expect(before.status, 'the earlier credential is revoked by the new one').toBe('revoked');
    expect(before.consent_version, 'an earlier consent keeps the version it was given under').toBe(OLD_VERSION);
    expect(before.consent_by).toBe('earlier@example.test');
    expect(before.consent_at.getTime()).toBe(old.rows[0].consent_at.getTime());

    expect(now.consent_version).toBe(CONSENT_VERSION);
    expect(now.consent_version, 'the new consent is recorded under the new text').not.toBe(OLD_VERSION);
  }, 60_000);
});

describe('the SAT cancellation reaches the invoice', () => {
  it('marks the stamped invoice cancelled when the SAT says Cancelado, and the AR control fires', async () => {
    const cfdiUuid = uuidv4().toUpperCase();
    const invoiceId = await stampedInvoice(f.entityId, cfdiUuid);
    await mirror(f.entityId, cfdiUuid);
    expect(await cancelledControl(f.entityId), 'premise: the control is quiet before the query').toBe(0);

    const summary = await revalidateEntityCfdis({ entityId: f.entityId }, { fetchImpl: satAnswers('Cancelado') });
    expect(summary.cancelados).toBe(1);
    expect(summary.invoices_cancelled).toBe(1);

    const mirrorRow = await query<{ sat_estado: string }>(
      `SELECT sat_estado FROM xml_documents WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, cfdiUuid]
    );
    expect(mirrorRow.rows[0].sat_estado).toBe('Cancelado');

    const inv = await query<{ cfdi_status: string }>(
      `SELECT cfdi_status FROM invoices WHERE id = $1 AND entity_id = $2`,
      [invoiceId, f.entityId]
    );
    expect(inv.rows[0].cfdi_status).toBe('cancelled');
    expect(await cancelledControl(f.entityId), 'a cancelled CFDI with an open balance is blocking').toBe(1);
  }, 60_000);

  it('leaves a CFDI the SAT reports valid, and another entity carrying the same UUID, untouched', async () => {
    const cfdiUuid = uuidv4().toUpperCase();
    const validInvoice = await stampedInvoice(f.entityId, cfdiUuid);
    await mirror(f.entityId, cfdiUuid);
    await revalidateEntityCfdis({ entityId: f.entityId }, { fetchImpl: satAnswers('Vigente') });
    const still = await query<{ cfdi_status: string }>(
      `SELECT cfdi_status FROM invoices WHERE id = $1 AND entity_id = $2`,
      [validInvoice, f.entityId]
    );
    expect(still.rows[0].cfdi_status).toBe('stamped');

    // A second entity of the same tenant holds an invoice with the UUID the
    // first entity's SAT query will now find cancelled.
    const other = uuidv4();
    await query(
      `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
         incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
       SELECT $1, tenant_id, organization_id, 'Other entity', 'corporation', 'XEXX010101000', 'rfc',
         'MX', 'MXN', 'mx_nif', 1, true
         FROM legal_entities WHERE id = $2 AND tenant_id = $3`,
      [other, f.entityId, f.tenantId]
    );
    const foreign = await stampedInvoice(other, cfdiUuid);

    await query(`UPDATE xml_documents SET sat_validated_at = NULL WHERE entity_id = $1 AND cfdi_uuid = $2`,
      [f.entityId, cfdiUuid]);
    const summary = await revalidateEntityCfdis({ entityId: f.entityId }, { fetchImpl: satAnswers('Cancelado') });
    expect(summary.invoices_cancelled).toBe(1);

    const theirs = await query<{ cfdi_status: string }>(
      `SELECT cfdi_status FROM invoices WHERE id = $1 AND entity_id = $2`,
      [foreign, other]
    );
    expect(theirs.rows[0].cfdi_status, 'the bridge is scoped to the entity that queried').toBe('stamped');
  }, 60_000);
});
