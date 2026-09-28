import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { PreRegistrationService } from '../../src/services/xml-ingestion/pre-registration-service.js';
import { getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

// ============================================================
// MNE-001-045 (#128): the prepaid threshold reaches the classifier.
//
// Before this slice pre-registration read four policies and passed exactly
// those four to the classifier, so `prepaidThreshold` fell back to the
// 5,000 constant whatever the firm had answered for `umbral_anticipado_mxn`.
// Here a 7,000 annual insurance policy goes through the real ingestion path
// in two entities of the same tenant: the one that answered 10,000 is not
// asked to defer it, its sibling on the default still is. The sibling is the
// control that the description does trigger the deferral question, and that
// the value is read per entity, not from a constant.
// ============================================================

const service = new PreRegistrationService();

const GOLDEN = fs.readFileSync(path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8');

/** The golden received CFDI, turned into a 7,000 annual insurance premium with its own UUID. */
function insuranceXml(uuid: string): string {
  return GOLDEN.replace('SubTotal="3500.00" Total="4060.00"', 'SubTotal="7000.00" Total="8120.00"')
    .replace('ClaveProdServ="76111501"', 'ClaveProdServ="84131500"')
    .replace(
      'Descripcion="Servicio mensual de limpieza de oficinas - agosto 2026"',
      'Descripcion="Seguro anual de equipo de oficina"'
    )
    .replace('ValorUnitario="3500.00" Importe="3500.00"', 'ValorUnitario="7000.00" Importe="7000.00"')
    .replace('TotalImpuestosTrasladados="560.00"', 'TotalImpuestosTrasladados="1120.00"')
    .replace('Base="3500.00"', 'Base="7000.00"')
    .replace('Importe="560.00"', 'Importe="1120.00"')
    .replace('UUID="11A1A1A1-0001-4A01-8A01-A1A1A1A1A001"', `UUID="${uuid}"`);
}

/** Uploads the CFDI, resolves its vendor and runs it to accounting; returns the decisions the trail kept. */
async function classify(f: Fixture): Promise<string[]> {
  const uuid = uuidv4().toUpperCase();
  await service.processXMLUpload(f.entityId, insuranceXml(uuid), 'api', f.userId);

  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by)
     VALUES ($1, $2, 'V-0001', 'Limpieza Corporativa del Centro SA de CV', $3)`,
    [vendorId, f.entityId, f.userId]
  );
  const preReg = await query<Record<string, unknown>>(
    `UPDATE pre_registrations SET vendor_id = $2, status = 'ready', default_account_id = $3
      WHERE entity_id = $1 RETURNING *`,
    [f.entityId, vendorId, f.cuentas['6100']]
  );
  expect(preReg.rowCount).toBe(1);
  // The outcome of posting is not what this test pins; the trail is written
  // before the postable verdict, so it holds the classification either way.
  await service.processToAccounting(preReg.rows[0], f.userId).catch(() => undefined);

  const trail = await getClassificationTrail(f.entityId, uuid);
  return (trail.decisions as Array<{ id: string }>).map((d) => d.id);
}

let answered: Fixture;
let sibling: Fixture;

beforeAll(async () => {
  answered = await crearInquilino('MNE-001-045 prepaid threshold');
  sibling = await crearEntidadHermana(answered, 'MNE-001-045 sibling on the default');
  await seedPolicies({ tenantId: answered.tenantId, entityId: answered.entityId });
  await seedPolicies({ tenantId: sibling.tenantId, entityId: sibling.entityId });
  await resolvePolicy(
    { tenantId: answered.tenantId, entityId: answered.entityId },
    'umbral_anticipado_mxn',
    '10000',
    'owner@test'
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('umbral_anticipado_mxn reaches the CFDI classifier (MNE-001-045)', () => {
  it('with umbral_anticipado_mxn=10000 a 7,000 CFDI is classified against 10,000: no deferral question', async () => {
    expect(await classify(answered)).not.toContain('gasto_vs_anticipado');
  });

  it('the sibling entity on the default 5,000 is still asked to defer the same 7,000 CFDI', async () => {
    expect(await classify(sibling)).toContain('gasto_vs_anticipado');
  });
});
