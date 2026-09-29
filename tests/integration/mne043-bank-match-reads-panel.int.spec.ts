import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { olvidarAlcances, entityScope } from '../../src/database/scope.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { previsualizarCotejo, correrCotejo } from '../../src/services/banking/match-service.js';

// ============================================================
// MNE-001-043 · `bank match preview|run` READ THE PANEL (#128, point 1/6).
//
// `cotejo_umbral_confianza` and `cotejo_monto_maximo_auto` were only read by
// the REST `auto-match` route. The terminal used a hard-coded 0.85 and the
// bare floor, so a firm that answered "strict" in `pending` still had
// `bank match run` pairing 0.90 candidates on its own.
//
// The candidate here is rule 2 (`exact_amount_near_date`), which the engine
// scores at exactly 0.90 and marks auto-applicable: every gate but the
// panel's lets it through.
// ============================================================

let f: Fixture;
let account: string;

async function customer(): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, created_by)
     VALUES ($1,$2,$3,'Cliente prueba',$4)`,
    [id, f.entityId, `C-${id.slice(0, 8)}`, f.userId]
  );
  return id;
}

/** An open invoice and a deposit of the same amount two days later: 0.90. */
async function nearDatePair(amount: string): Promise<string> {
  const c = await customer();
  const inv = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
      total_amount, currency_code, invoice_date, due_date, status, amount_paid, amount_due,
      description, created_by)
     VALUES ($1,$2,$3,$4,$5,'0',$5,'MXN','2026-04-08'::date,'2026-04-08'::date,'sent',0,$5,
             'Servicios abril',$6)`,
    [inv, f.entityId, `F-${inv.slice(0, 8)}`, c, amount, f.userId]
  );
  const tx = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount,
      transaction_type, description, is_matched)
     VALUES ($1,$2,'2026-04-10'::date,$3::numeric,'credit','Deposito customer',false)`,
    [tx, account, amount]
  );
  return tx;
}

async function answer(key: string, value: string): Promise<void> {
  await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, key, value, f.userId);
}

beforeAll(async () => {
  olvidarAlcances();
  f = await crearInquilino('MNE-001-043 bank match reads the panel');
  await seedPolicies({ tenantId: f.tenantId });
  account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, 'Operativa', 'Banco de prueba', $3, 'MXN', true)`,
    [account, f.entityId, f.roles.banco ?? Object.values(f.cuentas)[0]]
  );
}, 180_000);

beforeEach(async () => {
  // Every case starts from the catalog defaults (0.85 and 50,000): the
  // entity's own answer, if a previous case wrote one, is removed and the
  // seeded tenant row stays pending.
  await query(
    `DELETE FROM policy_decisions
      WHERE tenant_id = $1 AND entity_id IS NOT NULL AND key LIKE 'cotejo\\_%'`,
    [f.tenantId]
  );
});

afterAll(async () => {
  await closeDatabase();
});

describe('cotejo_umbral_confianza governs bank match run', () => {
  it('with the panel at 0.95, run does not apply a 0.90 candidate', async () => {
    const tx = await nearDatePair('700.0000');
    const scope = entityScope(f.tenantId, f.entityId);

    // Control: under the catalog default the same candidate is applicable,
    // so the refusal below is the panel's and nothing else's.
    const [before] = await previsualizarCotejo(scope, { txId: tx });
    expect(before.propuesta?.confianza).toBe(0.9);
    expect(before.aplicable).toBe(true);

    await answer('cotejo_umbral_confianza', '0.95');

    const [preview] = await previsualizarCotejo(scope, { txId: tx });
    expect(preview.aplicable).toBe(false);
    expect(preview.motivo).toBe('confianza-baja');

    const r = await correrCotejo(scope, { cuentaId: account, txId: tx }, { userId: f.userId });
    expect(r.aplicados).toEqual([]);
    expect(r.omitidos).toEqual([{ txId: tx, motivo: 'confianza-baja' }]);
    const row = await query<{ is_matched: boolean }>(
      'SELECT is_matched FROM bank_transactions WHERE id = $1',
      [tx]
    );
    expect(row.rows[0].is_matched).toBe(false);
  });

  it('a looser --min-confidence flag cannot reopen what the panel closed', async () => {
    const tx = await nearDatePair('710.0000');
    await answer('cotejo_umbral_confianza', '0.95');

    const [preview] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), {
      txId: tx,
      minConfianza: 0.75,
    });
    expect(preview.aplicable).toBe(false);
    expect(preview.motivo).toBe('confianza-baja');
  });
});

describe('cotejo_monto_maximo_auto is combined with the floor by Math.min', () => {
  it('with the panel at 10,000, run leaves a 20,000 line for a person', async () => {
    const tx = await nearDatePair('20000.0000');
    const scope = entityScope(f.tenantId, f.entityId);

    const [before] = await previsualizarCotejo(scope, { txId: tx });
    expect(before.aplicable).toBe(true);

    await answer('cotejo_monto_maximo_auto', '10000');

    const r = await correrCotejo(scope, { cuentaId: account, txId: tx }, { userId: f.userId });
    expect(r.aplicados).toEqual([]);
    expect(r.omitidos).toEqual([{ txId: tx, motivo: 'monto-sobre-piso' }]);
  });

  it('neither the panel nor a flag raises the ceiling above the floor', async () => {
    const tx = await nearDatePair('60000.0000');
    await answer('cotejo_monto_maximo_auto', '0');

    const [preview] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), {
      txId: tx,
      maxMonto: '999999',
    });
    expect(preview.aplicable).toBe(false);
    expect(preview.motivo).toBe('monto-sobre-piso');
  });

  it('a --max-amount flag above the panel does not loosen it', async () => {
    const tx = await nearDatePair('15000.0000');
    await answer('cotejo_monto_maximo_auto', '10000');

    const [preview] = await previsualizarCotejo(entityScope(f.tenantId, f.entityId), {
      txId: tx,
      maxMonto: '40000',
    });
    expect(preview.motivo).toBe('monto-sobre-piso');
  });
});
