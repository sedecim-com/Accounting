import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { drainAttestations, postJournalEntry } from '../../src/services/accounting/posting.js';
import { updateDraftEntry } from '../../src/services/accounting/journal-entry-service.js';
import { importSatChart } from '../../src/services/accounting/sat-chart-import.js';
import {
  checkOpeningBalance,
  importOpeningBalance,
} from '../../src/services/accounting/opening-balance.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';

// ============================================================
// MNE-001-099 · #220 · `apertura_modo_de_carga`, AGAINST POSTGRES
//
// The owner's decision of 2026-09-26: the opening load posts by default, and
// the panel key `apertura_modo_de_carga = borrador` leaves a draft instead.
// What has to hold for the draft:
//   · the load does not touch the ledger;
//   · `entry post` applies it, and then the penny check is equal;
//   · nobody edits its lines or its date — moving the date would free the
//     081/087 index slot and let a second load double every balance.
// And the default must not move: an entity without the key still posts.
// ============================================================

const RFC = 'XAXX010101000';
const NS_CAT = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';
const NS_BAL = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';

/** A small, complete migration: one bank, one capital account. */
const ACCOUNTS = [
  { num: '100', desc: 'Activo', agrup: '100', nivel: 1, natur: 'D', saldo: '50000.00' },
  { num: '102', desc: 'Bancos', padre: '100', agrup: '102', nivel: 2, natur: 'D', saldo: '50000.00' },
  { num: '102-001', desc: 'Banco del Bajío', padre: '102', agrup: '102.01', nivel: 3, natur: 'D', saldo: '50000.00' },
  { num: '300', desc: 'Capital contable', agrup: '300', nivel: 1, natur: 'A', saldo: '50000.00' },
  { num: '301', desc: 'Capital social', padre: '300', agrup: '301', nivel: 2, natur: 'A', saldo: '50000.00' },
] as const;

const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS_CAT}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025">` +
  ACCOUNTS.map(
    (c) =>
      `<catalogocuentas:Ctas CodAgrup="${c.agrup}" NumCta="${c.num}" Desc="${c.desc}"` +
      `${'padre' in c ? ` SubCtaDe="${c.padre}"` : ''} Nivel="${c.nivel}" Natur="${c.natur}"/>`
  ).join('') +
  `</catalogocuentas:Catalogo>`;

const BALANCE_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<BCE:Balanza xmlns:BCE="${NS_BAL}" Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
  ACCOUNTS.map(
    (c) => `<BCE:Ctas NumCta="${c.num}" SaldoIni="${c.saldo}" Debe="0.00" Haber="0.00" SaldoFin="${c.saldo}"/>`
  ).join('') +
  `</BCE:Balanza>`;

const ctxOf = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

let tenant: Fixture;
let drafted: Fixture;

async function migrate(fx: Fixture) {
  await importSatChart(ctxOf(fx), { entityId: fx.entityId, xml: CHART_XML, userId: fx.userId });
  return importOpeningBalance(ctxOf(fx), { entityId: fx.entityId, xml: BALANCE_XML, userId: fx.userId });
}

async function openingOf(entityId: string) {
  const r = await query<{ id: string; status: string; entry_date: string }>(
    `SELECT id, status, entry_date::text AS entry_date
       FROM journal_entries WHERE entity_id = $1 AND source_type = 'opening_balance'`,
    [entityId]
  );
  return r.rows;
}

beforeAll(async () => {
  tenant = await crearInquilino('MNE-001-099 opening draft');
  enterTenant(tenant.tenantId);
  drafted = await crearEntidadHermana(tenant, 'MNE-001-099 the one that drafts');
  await seedPolicies({ tenantId: tenant.tenantId });
  // Entity scope on purpose: the sibling keeps the tenant row, i.e. the default.
  await resolvePolicy(
    ctxOf(drafted),
    'apertura_modo_de_carga',
    'borrador',
    tenant.userId,
    'integration test MNE-001-099'
  );
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('apertura_modo_de_carga = borrador', () => {
  let entryId = '';

  it('the load leaves a draft and the ledger does not see it', async () => {
    const r = await migrate(drafted);
    expect(r.loadMode).toBe('draft');
    expect(r.escrito).toBe(true);
    entryId = r.asiento?.id ?? '';
    expect(await openingOf(drafted.entityId)).toEqual([
      { id: entryId, status: 'draft', entry_date: '2026-01-01' },
    ]);
    const check = await checkOpeningBalance(ctxOf(drafted), { entityId: drafted.entityId, xml: BALANCE_XML });
    expect(check.comparison.iguales).toBe(false);
  });

  it('nobody edits its lines', async () => {
    await expect(
      updateDraftEntry(
        drafted.entityId,
        entryId,
        { lines: [{ account: '102-001', debit: '1.00' }, { account: '301', credit: '1.00' }] },
        drafted.userId
      )
    ).rejects.toMatchObject({ code: 'OPENING_DRAFT_LOCKED' });
  });

  it('nor its date — which would free the index slot for a second load', async () => {
    await expect(
      updateDraftEntry(drafted.entityId, entryId, { date: '2026-01-02' }, drafted.userId)
    ).rejects.toMatchObject({ code: 'OPENING_DRAFT_LOCKED' });
    expect((await openingOf(drafted.entityId))[0].entry_date).toBe('2026-01-01');
    const again = await importOpeningBalance(ctxOf(drafted), {
      entityId: drafted.entityId,
      xml: BALANCE_XML,
      userId: drafted.userId,
    });
    expect(again.escrito).toBe(false);
    expect(again.findings.map((f) => f.regla)).toContain('APE-YA-CARGADA');
  });

  it('its description is still a description: that edit goes through', async () => {
    const e = await updateDraftEntry(
      drafted.entityId,
      entryId,
      { description: 'Opening 2026, reviewed' },
      drafted.userId
    );
    expect(e.description).toBe('Opening 2026, reviewed');
  });

  it('entry post applies it, and then the ledger equals the source to the peso', async () => {
    const posted = await postJournalEntry(entryId, drafted.userId);
    expect(posted.status).toBe('posted');
    const check = await checkOpeningBalance(ctxOf(drafted), { entityId: drafted.entityId, xml: BALANCE_XML });
    expect(check.comparison.iguales).toBe(true);
  });
});

describe('without the key, posting is still the default', () => {
  it('the sibling entity posts its opening in the same act', async () => {
    const r = await migrate(tenant);
    expect(r.loadMode).toBe('post');
    expect(r.escrito).toBe(true);
    expect((await openingOf(tenant.entityId)).map((e) => e.status)).toEqual(['posted']);
  });
});
