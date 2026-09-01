import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  PreRegistrationService,
  DuplicateError,
} from '../../src/services/xml-ingestion/pre-registration-service.js';
import { listCfdis, getClassificationTrail } from '../../src/services/xml-ingestion/cfdi-query-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * F02 · EL ESPEJO Y LA INGESTA FISCAL, contra la base real:
 *   · la prueba del ESPEJO — el mismo XML en dos entidades del mismo
 *     inquilino, dos direcciones; la misma entidad dos veces, duplicado;
 *   · el rastro del clasificador (cfdi_classifications) escrito al
 *     procesar, con el caso y las decisiones;
 *   · el umbral del panel MORDIENDO: umbral_capitalizacion_mxn bajado a
 *     500 convierte una factura de 3,500 en decisión de capitalización;
 *   · rep_faltante_recibido='bloquear' deteniendo el cierre suave con un
 *     pago sin REP en el periodo.
 */

let f: Fixture;
let entidadEmisora: string;
const service = new PreRegistrationService();

const XML_PUE = fs.readFileSync(
  path.resolve(__dirname, '../golden/cfdi/pue-recibido.xml'), 'utf-8'
);

beforeAll(async () => {
  f = await crearInquilino('F02 espejo fiscal');
  // La OTRA parte de la operación, cliente del mismo despacho: su tax_id es
  // el RFC EMISOR del XML dorado.
  entidadEmisora = uuidv4();
  const org = await query<{ organization_id: string }>(
    `SELECT organization_id FROM legal_entities WHERE id = $1`, [f.entityId]
  );
  await query(
    `INSERT INTO legal_entities (id, tenant_id, organization_id, name, entity_type, tax_id, tax_id_type,
      incorporation_country, functional_currency, accounting_standard, fiscal_year_start_month, is_active)
     VALUES ($1, $2, $3, 'Limpieza Corporativa (espejo)', 'corporation', 'LIM040404LM8', 'rfc', 'MX', 'MXN', 'mx_nif', 1, true)`,
    [entidadEmisora, f.tenantId, org.rows[0].organization_id]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('la prueba del espejo (046)', () => {
  it('el mismo XML entra en las DOS entidades con direcciones opuestas; la misma entidad dos veces es duplicado', async () => {
    await service.processXMLUpload(f.entityId, XML_PUE, 'api', f.userId);
    // La segunda entidad NO es duplicado: es la otra cara de la operación.
    await service.processXMLUpload(entidadEmisora, XML_PUE, 'api', f.userId);

    const receptor = await listCfdis(f.entityId, {});
    const emisor = await listCfdis(entidadEmisora, {});
    expect(receptor.rows[0].direction).toBe('recibido');
    expect(emisor.rows[0].direction).toBe('emitido');
    expect(receptor.rows[0].cfdi_uuid).toBe(emisor.rows[0].cfdi_uuid);

    // Lo que sigue prohibido: la MISMA entidad, el mismo XML.
    await expect(
      service.processXMLUpload(f.entityId, XML_PUE, 'api', f.userId)
    ).rejects.toThrow(DuplicateError);
  });
});

describe('el umbral del panel muerde y el rastro queda', () => {
  it('umbral_capitalizacion_mxn=500 convierte 3,500 en decisión — y cfdi_classifications lo cuenta', async () => {
    const ctx = { tenantId: f.tenantId, entityId: f.entityId };
    await seedPolicies(ctx);
    await resolvePolicy(ctx, 'umbral_capitalizacion_mxn', '500', 'victor@test');

    const preReg = await query<Record<string, unknown>>(
      `SELECT * FROM pre_registrations WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [f.entityId]
    );
    // El proveedor del pre-registro: el camino del bill lo exige resuelto.
    const vendorId = uuidv4();
    await query(
      `INSERT INTO vendors (id, entity_id, vendor_number, company_name, created_by)
       VALUES ($1, $2, 'V-0001', 'Limpieza Corporativa del Centro SA de CV', $3)`,
      [vendorId, f.entityId, f.userId]
    );
    const cuentaGasto = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE entity_id = $1 AND code = '6100'`, [f.entityId]
    );
    await query(
      `UPDATE pre_registrations SET vendor_id = $2, status = 'ready', default_account_id = $3 WHERE id = $1`,
      [preReg.rows[0].id, vendorId, cuentaGasto.rows[0].id]
    );

    // Con el umbral del despacho en 500, los 3,500 del XML piden decidir
    // gasto vs activo: el procesamiento se detiene pidiendo decisión…
    await expect(
      service.processToAccounting(
        (await query<Record<string, unknown>>(
          `SELECT * FROM pre_registrations WHERE id = $1`, [preReg.rows[0].id]
        )).rows[0],
        f.userId
      )
    ).rejects.toThrow(/decisi/i);

    // …y el RASTRO queda escrito aunque el documento quedara bloqueado.
    const rastro = await getClassificationTrail(
      f.entityId,
      String((await query<{ cfdi_uuid: string }>(
        `SELECT cfdi_uuid FROM xml_documents WHERE entity_id = $1 LIMIT 1`, [f.entityId]
      )).rows[0].cfdi_uuid)
    );
    expect(rastro.direction).toBe('recibido');
    expect(['pending', 'blocked']).toContain(rastro.status);
    const ids = (rastro.decisions as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain('gasto_vs_activo');
  });
});

describe('rep_faltante_recibido gobierna el cierre', () => {
  it("con 'bloquear', un pago del periodo sin REP detiene el cierre; con 'avisar', avisa", async () => {
    const ctx = { tenantId: f.tenantId, entityId: f.entityId };
    const vendor = await query<{ id: string }>(
      `SELECT id FROM vendors WHERE entity_id = $1 LIMIT 1`, [f.entityId]
    );
    await query(
      `INSERT INTO vendor_payments (id, entity_id, vendor_id, payment_number,
        payment_date, payment_amount, currency_code, exchange_rate, payment_method, status, created_by)
       VALUES ($1, $2, $3, 'VPMT-2026-90001', '2026-08-20', '1160.00', 'MXN', 1, 'spei', 'completed', $4)`,
      [uuidv4(), f.entityId, vendor.rows[0].id, f.userId]
    );

    await resolvePolicy(ctx, 'rep_faltante_recibido', 'bloquear', 'victor@test');
    const bloqueado = await getPeriodCloseStatus(f.periodos[8], f.entityId);
    expect(bloqueado.blocking_issues.some((b) => /sin REP/.test(b))).toBe(true);
    expect(bloqueado.can_close).toBe(false);

    // El panel manda en las dos direcciones: reabrir y contestar 'avisar'.
    await query(
      `UPDATE policy_decisions SET resolved_value = 'avisar' WHERE tenant_id = $1 AND key = 'rep_faltante_recibido'`,
      [f.tenantId]
    );
    const avisado = await getPeriodCloseStatus(f.periodos[8], f.entityId);
    expect(avisado.blocking_issues.some((b) => /sin REP/.test(b))).toBe(false);
    expect(avisado.warnings.some((w) => /sin REP/.test(w))).toBe(true);
  });
});
