import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { setVendorTaxId } from '../../src/services/ap/vendor-service.js';
import { recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { construirDiot } from '../../src/services/sat/diot/index.js';
import { encrypt } from '../../src/utils/encryption.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/utils/errors.js';

// MNE-001-664 (#607) · the tax id of a vendor is corrected, measured against
// Postgres: a vendor captured without RFC blocks the DIOT of the month it was
// paid in and leaves its payment node out of the Anexo 24 vouchers file; once
// `setVendorTaxId` corrects it, neither blocks for that cause, and no bill,
// payment or entry was rewritten on the way. One bill by hand: 1,000.00 +
// 160.00 of IVA = 1,160.00, paid in full in cash. Every RFC is synthetic.

const MONTH = 10;
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };
const NEW_RFC = 'TST010101AA1';
const CLABE = '012180001234567895';
const REASON = 'Tax status certificate received in October';

let f: Fixture;
let sister: Fixture;
let vendorId: string;
let entry: string;

const account = async (entityId: string, code: string): Promise<string> =>
  (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`, [entityId, code])).rows[0].id;

async function vendor(fx: Fixture, name: string, taxId: string | null): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by, tipo_operacion)
     VALUES ($1,$2,$3,$4,$5,'rfc','MXN',$6,'85')`,
    [id, fx.entityId, `V-${id.slice(0, 8)}`, name, taxId, fx.userId]
  );
  return id;
}

/** Every posted document of the entity, row by row, as one digest per table. */
async function ledgerDigest(entityId: string): Promise<Record<string, string>> {
  const one = async (sql: string): Promise<string> => (await query<{ d: string }>(sql, [entityId])).rows[0].d;
  const digest = (table: string, where: string): string =>
    `SELECT md5(COALESCE(string_agg(md5(t::text), ',' ORDER BY t.id), '')) AS d FROM ${table} t WHERE ${where}`;
  return {
    bills: await one(digest('bills', 't.entity_id = $1')),
    payments: await one(digest('vendor_payments', 't.entity_id = $1')),
    entries: await one(digest('journal_entries', 't.entity_id = $1')),
    lines: await one(digest('journal_entry_lines', 't.journal_entry_id IN (SELECT id FROM journal_entries WHERE entity_id = $1)')),
  };
}

const diot = () => construirDiot({ tenantId: f.tenantId, entityId: f.entityId, anio: 2026, mes: MONTH });
const vouchers = () => generarPolizas(f.entityId, { periodo: `2026-${MONTH}`, solicitud: REQUEST });
const storedTaxId = async (id: string) =>
  (await query<{ tax_id: string | null }>(`SELECT tax_id FROM vendors WHERE id = $1`, [id])).rows[0].tax_id;
const auditRows = async (id: string) =>
  (await query<{ user_id: string; tenant_id: string; legal_entity_id: string; old_values: unknown; new_values: unknown; reason: string }>(
    `SELECT user_id, tenant_id, legal_entity_id, old_values, new_values, reason
       FROM audit_log WHERE entity_type = 'vendor' AND entity_id = $1 AND action = 'update'`,
    [id]
  )).rows;
const set = (id: string, taxId: string, reason = REASON, fx: Fixture = f) =>
  setVendorTaxId(id, entityScope(fx.tenantId, fx.entityId), { taxId, taxIdType: 'rfc' }, { userId: fx.userId, reason });

beforeAll(async () => {
  f = await crearInquilino('MNE-664 vendor tax id');
  sister = await crearEntidadHermana(f, 'MNE-664 sister');
  await seedPolicies({ tenantId: f.tenantId });

  const bankId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Cuenta de cheques','Banco Sintetico',$3,'MXN','012',$4,$5,true)`,
    [bankId, f.entityId, await account(f.entityId, '1120'), encrypt(CLABE), CLABE.slice(-4)]
  );

  // The vendor captured with no RFC, its bill approved and paid in the month.
  vendorId = await vendor(f, 'Fletes Sinteticos del Norte', '');
  const billId = uuidv4();
  const day = fechaEnPeriodo(MONTH, 10);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid)
     VALUES ($1,$2,$3,$4,$5,'1000.00','160.00','1160.00','1160.00',0,'MXN',$6,$6,'draft',$7,'PPD',$8)`,
    [billId, f.entityId, `BILL-${billId.slice(0, 8)}`, vendorId, `CFDI-${billId.slice(0, 8)}`, day, f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price,
       line_amount, tax_amount, total_amount, tax_rate, tipo_factor)
     VALUES ($1,$2,1,$3,'Flete',1,'1000.00','1000.00','160.00','1160.00','16.00','tasa')`,
    [uuidv4(), billId, await account(f.entityId, '6100')]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  const payment = await recordVendorPayment(
    {
      entityId: f.entityId,
      paymentAmount: '1160.00',
      paymentDate: fechaEnPeriodo(MONTH, 20),
      paymentMethod: 'cash',
      bankAccountId: bankId,
      applications: [{ documentId: billId, amountApplied: '1160.00' }],
    },
    f.userId
  );
  entry = payment.journalEntry?.entry_number ?? '';
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a vendor without RFC blocks the month, and the correction is the remedy', () => {
  it('before: the DIOT names the vendor and the vouchers file leaves its payment node out', async () => {
    expect(entry, 'the payment must have posted').not.toBe('');
    const built = await diot();
    expect(built.hallazgos.filter((h) => h.codigo === 'DIOT-SIN-RFC' && h.vendorId === vendorId)).toHaveLength(1);
    expect(built.renglones.find((r) => r.tercero.vendorId === vendorId)).toBeUndefined();

    const file = await vouchers();
    const untraced = file.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro' && h.referencia === entry);
    expect(untraced).toHaveLength(1);
    expect(untraced[0].severity).toBe('blocking');
    expect(untraced[0].detalle).toContain('no tiene RFC capturado');
  }, 60_000);

  it('refuses a malformed id, a blank reason and an id another vendor of the entity carries; nothing is written', async () => {
    // Stored in lower case and with a space: the comparison is on the id, not on how it was typed.
    await vendor(f, 'Otro Proveedor Sintetico', 'dup 020202bb2');
    const before = await ledgerDigest(f.entityId);

    await expect(set(vendorId, 'TST0101AA1')).rejects.toThrow(ValidationError);
    await expect(set(vendorId, NEW_RFC, '   ')).rejects.toMatchObject({
      messageKey: { key: 'error.VALIDATION_ERROR.vendor.tax_id_reason_required' },
    });
    const taken = await set(vendorId, 'DUP020202BB2').catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(ConflictError);
    expect((taken as ConflictError).messageKey?.key).toBe('error.RESOURCE_ALREADY_EXISTS.vendor.tax_id_taken');

    expect(await storedTaxId(vendorId)).toBe('');
    expect(await auditRows(vendorId)).toEqual([]);
    expect(await ledgerDigest(f.entityId)).toEqual(before);
  }, 60_000);

  it('a vendor of another entity answers exactly as one that does not exist', async () => {
    const foreign = await vendor(sister, 'Proveedor de la Hermana', '');
    const missing = uuidv4();
    const asForeign = await set(foreign, NEW_RFC).catch((e: unknown) => e);
    const asMissing = await set(missing, NEW_RFC).catch((e: unknown) => e);
    expect(asForeign).toBeInstanceOf(NotFoundError);
    expect(asMissing).toBeInstanceOf(NotFoundError);
    expect((asForeign as NotFoundError).message.replace(foreign, '<id>')).toBe(
      (asMissing as NotFoundError).message.replace(missing, '<id>')
    );
    expect(await storedTaxId(foreign)).toBe('');

    // The same id on a vendor of the sister entity is no duplicate here: the rule is per entity.
    await set(foreign, NEW_RFC, REASON, sister);
    expect(await storedTaxId(foreign)).toBe(NEW_RFC);
  }, 60_000);

  it('the correction writes the vendor and its audit row, and rewrites no bill, payment or entry', async () => {
    const before = await ledgerDigest(f.entityId);
    const done = await set(vendorId, ' tst010101aa1 ');

    expect(done.vendor.tax_id).toBe(NEW_RFC);
    expect(done.previous).toEqual({ tax_id: '', tax_id_type: 'rfc' });
    // One bill approved and one payment posted, both by hand above.
    expect(done.posted).toEqual({ bills: 1, payments: 1 });
    expect(await storedTaxId(vendorId)).toBe(NEW_RFC);
    expect(await ledgerDigest(f.entityId)).toEqual(before);
    expect(await auditRows(vendorId)).toEqual([{
      user_id: f.userId,
      tenant_id: f.tenantId,
      legal_entity_id: f.entityId,
      old_values: { tax_id: '', tax_id_type: 'rfc' },
      new_values: { tax_id: NEW_RFC, tax_id_type: 'rfc' },
      reason: REASON,
    }]);
  }, 60_000);

  it('after: the DIOT declares the vendor with its RFC and the payment node carries it', async () => {
    const built = await diot();
    expect(built.hallazgos.filter((h) => h.codigo === 'DIOT-SIN-RFC' && h.vendorId === vendorId)).toEqual([]);
    expect(built.renglones.find((r) => r.tercero.vendorId === vendorId)?.tercero.rfc).toBe(NEW_RFC);

    const file = await vouchers();
    expect(file.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro' && h.referencia === entry)).toEqual([]);
    const voucher = file.xml.split('<PLZ:Poliza ').find((block) => block.includes(`NumUnIdenPol="${entry}"`));
    expect(voucher).toMatch(new RegExp(`<PLZ:OtrMetodoPago\\b[^>]*RFC="${NEW_RFC}"`));
  }, 60_000);
});
