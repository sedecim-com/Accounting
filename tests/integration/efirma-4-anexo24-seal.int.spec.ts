import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { verify, X509Certificate } from 'node:crypto';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { storeCredential, CredentialAccessDenied } from '../../src/services/fiscal-credentials/service.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';
import { generarBalanza, verificarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';
import { archivarArtefacto } from '../../src/services/sat/anexo24/artefactos.js';
import { construirCatalogoCuentas } from '../../src/services/sat/anexo24/catalogo-cuentas.js';
import { originalString } from '../../src/services/sat/anexo24/original-string.js';
import { sealArchivedDocument, SealRefusedByPolicy } from '../../src/services/sat/anexo24/seal.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';
import type { AppError } from '../../src/utils/errors.js';

// ============================================================
// EFIRMA-4 (#442), against a real database. The e.firma is the synthetic
// fixture tests/fixtures/certs/efirma-sat-serial (invariant 7), stored through
// storeCredential into an in-memory vault and read back only by withCredential.
// ============================================================

const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'certs');
const RFC = 'AAA010101AAA';
const ACTOR = 'contador@efirma-4.test';

let f: Fixture;
let credentialId: string;
const vaultBlobs = new Map<string, Buffer>();

async function logRows(): Promise<{ purpose: string; outcome: string; denied_reason: string | null }[]> {
  const r = await query<{ purpose: string; outcome: string; denied_reason: string | null }>(
    `SELECT purpose, outcome, denied_reason FROM fiscal_credential_access_log
      WHERE credential_id = $1 AND tenant_id = $2 ORDER BY accessed_at, id`,
    [credentialId, f.tenantId]
  );
  return r.rows;
}

const setSealPolicy = (value: string) =>
  resolvePolicy({ tenantId: f.tenantId }, 'efirma_sellado_contabilidad_electronica', value, f.userId);

const sealPeriod = (document: 'catalogo' | 'balanza', month: number, envelopeType: 'N' | 'C' = 'N') =>
  sealArchivedDocument({
    tenantId: f.tenantId,
    entityId: f.entityId,
    document,
    year: 2026,
    month,
    envelopeType,
    actor: ACTOR,
    userId: f.userId,
  });
const sealFebruary = (document: 'catalogo' | 'balanza') => sealPeriod(document, 2);

const chartAccount = (code: string, name: string) => ({
  code, name, account_level: 1, parent_code: null, codigo_agrupador_sat: '105',
  normal_balance: 'debit' as const, account_type: 'asset', lineas_posteadas: 1, naturaleza_agrupador: null,
  estado_agrupador: 'valido' as const,
});

/** Archives a catalog as `catalog generate` does, and returns its row id. */
async function archiveChart(month: number, accounts: ReturnType<typeof chartAccount>[], mangle = (x: string) => x) {
  const built = construirCatalogoCuentas({
    rfc: RFC, anio: 2026, mes: month, cuentas: accounts,
    politicas: { niveles: 'jerarquia_completa', sinAgrupador: 'bloquear', sellado: 'sellar_con_custodia' },
  });
  const archived = await archivarArtefacto({
    tenantId: f.tenantId, entityId: f.entityId, tipo: 'catalogo', version: '1.3', rfc: RFC, anio: 2026, mes: month,
    tipoEnvio: 'N', xml: mangle(built.xml!), politicaSellado: 'sellar_con_custodia', hallazgos: [], generadoPor: f.userId,
  });
  return archived;
}

beforeAll(async () => {
  f = await crearInquilino('EFIRMA-4 Anexo 24 seal');
  enterTenant(f.tenantId);
  await seedPolicies({ tenantId: f.tenantId });
  await query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [RFC, f.entityId, f.tenantId]);
  await createJournalEntry(
    f.entityId,
    fechaEnPeriodo(2, 10),
    JournalEntryType.STANDARD,
    'Venta de febrero',
    [
      { account_id: f.cuentas['1140']!, debit_amount: '1300.0000', credit_amount: null, description: 'venta' },
      { account_id: f.cuentas['4100']!, debit_amount: null, credit_amount: '1300.0000', description: 'venta' },
    ],
    f.userId,
    { autoPost: true }
  );
  setVaultForTesting({
    backend: 'test',
    put: async (_ctx: unknown, blob: Buffer) => {
      vaultBlobs.set('test://efirma-4', Buffer.from(blob));
      return { backend: 'test', ref: 'test://efirma-4' };
    },
    get: async (_ctx: unknown, ref: { ref: string }) => Buffer.from(vaultBlobs.get(ref.ref)!),
    destroy: async () => undefined,
    healthCheck: async () => ({ ok: true }),
  } as unknown as SecretVault);
  const stored = await storeCredential({
    tenantId: f.tenantId,
    entityId: f.entityId,
    material: {
      cer: fs.readFileSync(path.join(CERT_DIR, 'efirma-sat-serial.cer')),
      key: fs.readFileSync(path.join(CERT_DIR, 'efirma-sat-serial.key')),
      password: 'test1234',
    },
    consentBy: 'owner@efirma-4.test',
  });
  credentialId = stored.id;
  await generarBalanza(f.entityId, { periodo: f.periodos[2], generadoPor: f.userId });
});

afterAll(async () => {
  setVaultForTesting(null);
  await drainAttestations(2000);
  await closeDatabase();
});

describe('EFIRMA-4 · the Anexo 24 seal', () => {
  it('under the default policy it refuses, naming the policy, and nothing is decrypted', async () => {
    const refused = await sealFebruary('balanza').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SealRefusedByPolicy);
    expect((refused as Error).message).toMatch(/efirma_sellado_contabilidad_electronica is "nunca_sellar_en_el_sistema"/);
    expect(await logRows()).toEqual([]);
  });

  it('under sellar_con_custodia the archived balance is sealed, logged, archived, and check stops warning', async () => {
    await setSealPolicy('sellar_con_custodia');
    const before = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(before.hallazgos.some((h) => h.check === 'sin-sello')).toBe(true);

    const sealed = await sealFebruary('balanza');

    expect(validateAgainstOfficialXsd(sealed.xml, 'trialBalance')).toEqual({ valid: true, errors: [] });
    const cert = new X509Certificate(Buffer.from(/\sCertificado="([^"]+)"/.exec(sealed.xml)![1]!, 'base64'));
    const signature = Buffer.from(/\sSello="([^"]+)"/.exec(sealed.xml)![1]!, 'base64');
    expect(verify('RSA-SHA256', Buffer.from(originalString(sealed.xml, 'balanza')), cert.publicKey, signature)).toBe(true);
    expect(sealed.certificateNumber).toBe('00001000000000000145');

    expect(await logRows()).toEqual([{ purpose: 'seal_anexo24', outcome: 'success', denied_reason: null }]);
    const rows = await query<{ sealed: boolean; sealed_from: string | null }>(
      `SELECT sellado AS sealed, sealed_from FROM sat_anexo24_artefactos WHERE id = $1 AND tenant_id = $2`,
      [sealed.artifact.id, f.tenantId]
    );
    expect(rows.rows).toEqual([{ sealed: true, sealed_from: sealed.sealedFrom }]);

    const after = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(after.meta.sellada).toBe(true);
    expect(after.hallazgos.some((h) => h.check === 'sin-sello')).toBe(false);
  });

  it('balance check with --type C sees the sealed amended balance', async () => {
    const amended = { periodo: f.periodos[2], tipo: 'C' as const, fechaModBal: '2026-03-15' };
    await generarBalanza(f.entityId, { ...amended, generadoPor: f.userId });
    expect((await verificarBalanza(f.entityId, amended)).meta.sellada).toBe(false);
    await sealPeriod('balanza', 2, 'C');
    const after = await verificarBalanza(f.entityId, amended);
    expect(after.meta.sellada).toBe(true);
    expect(after.hallazgos.some((h) => h.check === 'sin-sello')).toBe(false);
  });

  it('seals the archived catalog, and it validates against the XSD', async () => {
    const built = construirCatalogoCuentas({
      rfc: RFC,
      anio: 2026,
      mes: 2,
      cuentas: [
        {
          code: '1140', name: 'Clientes', account_level: 1, parent_code: null, codigo_agrupador_sat: '105',
          normal_balance: 'debit', account_type: 'asset', lineas_posteadas: 1, naturaleza_agrupador: null,
          estado_agrupador: 'valido',
        },
      ],
      politicas: { niveles: 'jerarquia_completa', sinAgrupador: 'bloquear', sellado: 'sellar_con_custodia' },
    });
    await archivarArtefacto({
      tenantId: f.tenantId, entityId: f.entityId, tipo: 'catalogo', version: '1.3', rfc: RFC, anio: 2026, mes: 2,
      tipoEnvio: 'N', xml: built.xml!, politicaSellado: 'sellar_con_custodia', hallazgos: [], generadoPor: f.userId,
    });

    const sealed = await sealFebruary('catalogo');
    expect(validateAgainstOfficialXsd(sealed.xml, 'chart')).toEqual({ valid: true, errors: [] });
    expect((await logRows()).at(-1)).toEqual({ purpose: 'seal_anexo24', outcome: 'success', denied_reason: null });
  });

  it('seals the file generated LAST: generate A, generate B, regenerate A, then seal signs A', async () => {
    const a = await archiveChart(3, [chartAccount('1140', 'Clientes')]);
    const b = await archiveChart(3, [chartAccount('1140', 'Clientes'), chartAccount('1150', 'Deudores')]);
    const again = await archiveChart(3, [chartAccount('1140', 'Clientes')]);
    expect(again).toMatchObject({ id: a.id, yaExistia: true });
    expect(b.id).not.toBe(a.id);

    const sealed = await sealPeriod('catalogo', 3);
    expect(sealed.sealedFrom).toBe(a.id);
    expect(sealed.sourceHash).toBe(a.hash_sha256);
  });

  it.each([
    ['the XSD rejects it', 4, (x: string) => x.replace(`RFC="${RFC}"`, 'RFC="NOT-AN-RFC"'), 'anexo24.seal.source_invalid'],
    ["an attribute carries '|'", 5, (x: string) => x.replace('Desc="Clientes"', 'Desc="Caja | chica"'), 'anexo24.seal.separator_in_attribute'],
  ] as const)('a source where %s is refused before the key: no decryption, no access used', async (_why, month, mangle, key) => {
    await archiveChart(month, [chartAccount('1140', 'Clientes')], mangle);
    const before = (await logRows()).length;
    const refused = await sealPeriod('catalogo', month).catch((e: unknown) => e);
    expect((refused as AppError).messageKey?.key).toBe(key);
    expect((await logRows()).length).toBe(before);
  });

  it('the daily cap applies: with bloquear, a seal past the cap is denied and logged, and nothing is archived', async () => {
    await resolvePolicy({ tenantId: f.tenantId }, 'efirma_accion_anomalia', 'bloquear', f.userId);
    await query(`UPDATE fiscal_credentials SET max_daily_access = 1 WHERE id = $1 AND tenant_id = $2`, [credentialId, f.tenantId]);
    const sealedRows = async () =>
      (await query(`SELECT 1 FROM sat_anexo24_artefactos WHERE entity_id = $1 AND sellado`, [f.entityId])).rows.length;
    const before = await sealedRows();

    await expect(sealFebruary('balanza')).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect((await logRows()).at(-1)).toEqual({ purpose: 'seal_anexo24', outcome: 'denied', denied_reason: 'rate_limit' });
    expect(await sealedRows()).toBe(before);
  });
});
