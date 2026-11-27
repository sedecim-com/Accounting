import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  // G3: `createVendor` audita, y `tenantDe` (services/audit/audit-log.ts)
  // pregunta primero por el inquilino del CONTEXTO. Devolverlo aquí evita
  // que cada prueba tenga que encolar además el SELECT a legal_entities.
  currentTenant: vi.fn(() => 'tenant-1'),
}));

// R2: scope.ts se mockea PASANDO por el mismo mockQuery, para que las
// secuencias mockResolvedValueOnce de cada prueba sigan alineadas (una
// consulta por lectura, como antes). La frontera real la prueba la suite de
// integración (perimetro-r2); aquí se prueba la lógica del servicio.
vi.mock('../../../src/database/scope.js', async () => {
  const { NotFoundError } = await vi.importActual<typeof import('../../../src/utils/errors.js')>(
    '../../../src/utils/errors.js'
  );
  const { query } = await import('../../../src/database/connection.js');
  const find = async (tabla: string, id: string) => {
    const r = await (query as unknown as (s: string, p: unknown[]) => Promise<{ rows: unknown[] }>)(
      `SELECT * FROM ${tabla} WHERE id = $1 AND entity_id = $2`,
      [id, 'e-1']
    );
    return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
  };
  return {
    entityScope: (tenantId: string, entityId: string) => ({ kind: 'entity', tenantId, entityId }),
    tenantScope: (tenantId: string) => ({ kind: 'tenant', tenantId }),
    findByIdInScope: find,
    requireByIdInScope: async (tabla: string, id: string) => {
      const fila = await find(tabla, id);
      if (!fila) throw new NotFoundError(tabla, id);
      return fila;
    },
    condicionDeAlcance: async (_t: string, _s: unknown, i: number) => ({
      sql: `entity_id = $${i}`,
      valor: 'e-1',
    }),
  };
});


import {
  listVendors,
  getVendorById,
  resolveVendor,
  createVendor,
  updateVendor,
  setVendorTerms,
  setVendorTaxId,
  normalizeTaxId,
  taxIdTypeForCountry,
  parsePaymentTerms,
  dueDateFrom,
  redactBankSecrets,
  VENDOR_UPDATABLE_FIELDS,
} from '../../../src/services/ap/vendor-service.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const SCOPE = { kind: 'entity', tenantId: 't-1', entityId: 'e-1' } as const;
const mockTx = withTransaction as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';
const TENANT = 'tenant-1';

beforeEach(() => {
  mockQuery.mockReset();
  mockTx.mockReset();
  // Run the callback against a client whose query() is the same mock, so the
  // assertions below see transactional statements in call order too.
  mockTx.mockImplementation((fn: (c: { query: unknown }) => unknown) => fn({ query: mockQuery }));
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
// Tipado como `unknown[]` y no dejado en `any`: sin esto cada `params(n)[i]`
// de este fichero cuenta una advertencia de acceso inseguro, y son decenas.
const params = (call: number): unknown[] => mockQuery.mock.calls[call][1] as unknown[];

// ============================================================
// TAX ID — the field that decides whether a CFDI can ever be
// matched to this vendor, and whether a 1099 can be filed.
// ============================================================

describe('normalizeTaxId — which country rule was applied', () => {
  it('accepts a persona moral RFC (12) and a persona física RFC (13)', () => {
    expect(normalizeTaxId('PRU060101AB1', 'rfc').taxId).toBe('PRU060101AB1');
    expect(normalizeTaxId('PRUA060101AB1', 'rfc').taxId).toBe('PRUA060101AB1');
  });

  it('accepts the SAT generic RFCs, which every ledger needs', () => {
    // Público en general and foreign residents: rejecting these would make
    // half the received CFDIs uncapturable.
    expect(normalizeTaxId('XAXX010101000', 'rfc').taxId).toBe('XAXX010101000');
    expect(normalizeTaxId('XEXX010101000', 'rfc').taxId).toBe('XEXX010101000');
  });

  it('upper-cases and strips spaces before judging', () => {
    expect(normalizeTaxId(' pru060101ab1 ', 'rfc').taxId).toBe('PRU060101AB1');
  });

  it('names Mexico in the rule it applied, so nobody guesses', () => {
    expect(normalizeTaxId('PRU060101AB1', 'rfc').rule).toMatch(/Mexico \(SAT\) RFC/);
  });

  it('rejects an RFC whose date positions cannot be a date', () => {
    expect(() => normalizeTaxId('PRU261301AB1', 'rfc')).toThrow(/impossible date/);
    expect(() => normalizeTaxId('PRU060199AB1', 'rfc')).toThrow(/impossible date/);
  });

  it('rejects the wrong shape entirely', () => {
    for (const bad of ['NOTANRFC', 'PR060101AB1', 'PRU06010AB1', '12-3456789']) {
      expect(() => normalizeTaxId(bad, 'rfc'), bad).toThrow(ValidationError);
    }
  });

  it('accepts an EIN with or without the hyphen and normalizes it to NN-NNNNNNN', () => {
    expect(normalizeTaxId('123456789', 'ein').taxId).toBe('12-3456789');
    expect(normalizeTaxId('12-3456789', 'ein').taxId).toBe('12-3456789');
    expect(normalizeTaxId('12-3456789', 'ein').rule).toMatch(/United States \(IRS\) EIN/);
  });

  it('rejects an EIN that is not nine digits', () => {
    expect(() => normalizeTaxId('12-345678', 'ein')).toThrow(/EIN/);
    expect(() => normalizeTaxId('PRU060101AB1', 'ein')).toThrow(/EIN/);
  });

  it('requires a country prefix on a VAT number', () => {
    expect(normalizeTaxId('esb12345678', 'vat').taxId).toBe('ESB12345678');
    expect(() => normalizeTaxId('12345678', 'vat')).toThrow(/VAT/);
  });

  it('refuses an empty tax id rather than storing one', () => {
    expect(() => normalizeTaxId('   ', 'rfc')).toThrow(ValidationError);
  });
});

describe('taxIdTypeForCountry', () => {
  it('maps the two countries this system knows', () => {
    expect(taxIdTypeForCountry('MX')).toBe('rfc');
    expect(taxIdTypeForCountry('USA')).toBe('ein');
    expect(taxIdTypeForCountry('US')).toBe('ein');
  });

  it('returns undefined elsewhere, so the caller must say which rule to apply', () => {
    expect(taxIdTypeForCountry('DE')).toBeUndefined();
    expect(taxIdTypeForCountry(undefined)).toBeUndefined();
  });
});

// ============================================================
// PAYMENT TERMS
// ============================================================

describe('parsePaymentTerms', () => {
  it('reads "Net 30" as thirty days', () => {
    expect(parsePaymentTerms('Net 30')).toMatchObject({ netDays: 30, discountPct: null, normalized: 'Net 30' });
  });

  it('reads BOTH halves of "2/10 Net 30" — the old inline parser lost the net part', () => {
    expect(parsePaymentTerms('2/10 Net 30')).toMatchObject({
      netDays: 30, discountPct: 2, discountDays: 10, normalized: '2/10 Net 30',
    });
  });

  it('reads due-on-receipt in either language, including the CFDI spelling PUE', () => {
    for (const text of ['Due on receipt', 'contado', 'PUE']) {
      expect(parsePaymentTerms(text), text).toMatchObject({ netDays: 0, normalized: 'Due on receipt' });
    }
  });

  it('reads a bare number and "30 días" as a net term', () => {
    expect(parsePaymentTerms('30').netDays).toBe(30);
    expect(parsePaymentTerms('45 días').netDays).toBe(45);
  });

  it('reports text it did not understand instead of inventing a due date', () => {
    const parsed = parsePaymentTerms('cuando se pueda');
    expect(parsed.recognized).toBe(false);
    expect(parsed.netDays).toBeNull();
  });
});

describe('dueDateFrom', () => {
  it('adds the net days to the bill date', () => {
    expect(dueDateFrom('2026-08-10', '2/10 Net 30')).toBe('2026-09-09');
    expect(dueDateFrom('2026-01-31', 'Net 30')).toBe('2026-03-02');
  });

  it('returns the bill date itself for due-on-receipt', () => {
    expect(dueDateFrom('2026-08-10', 'Contado')).toBe('2026-08-10');
  });

  it('returns null when the terms imply no due date at all', () => {
    expect(dueDateFrom('2026-08-10', 'cuando se pueda')).toBeNull();
    expect(dueDateFrom('2026-08-10', null)).toBeNull();
  });
});

// ============================================================
// BANK SECRETS
// ============================================================

describe('redactBankSecrets', () => {
  it('drops the encrypted blobs and leaves only whether there is anything on file', () => {
    const row = redactBankSecrets({
      id: 'v1', clabe_encrypted: 'ENC', bank_account_number_encrypted: null,
      bank_routing_number_encrypted: null, bank_name: 'BBVA',
    });
    expect(row).not.toHaveProperty('clabe_encrypted');
    expect(row).not.toHaveProperty('bank_account_number_encrypted');
    expect(row.bank_details_on_file).toBe(true);
    expect(row.bank_name).toBe('BBVA');
  });

  it('says so when nothing is on file', () => {
    expect(redactBankSecrets({ id: 'v1', clabe_encrypted: null }).bank_details_on_file).toBe(false);
  });
});

// ============================================================
// QUERIES
// ============================================================

describe('listVendors', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '87' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    const page = await listVendors(ENTITY, { limit: 1 });
    expect(page.total).toBe(87);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes every query to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listVendors(ENTITY);
    expect(sql(0)).toMatch(/WHERE entity_id = \$1/);
    expect(params(0)[0]).toBe(ENTITY);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('keeps the route search: company name or vendor number, one placeholder', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listVendors(ENTITY, { search: 'servicios' });
    expect(sql(0)).toMatch(/\(company_name ILIKE \$2 OR vendor_number ILIKE \$2\)/);
    expect(params(0)[1]).toBe('%servicios%');
  });

  it('numbers combined filters without collision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listVendors(ENTITY, { isActive: true, search: 'x', is1099: true, missingTaxId: true });
    expect(params(0)).toEqual([ENTITY, true, '%x%', true]);
    expect(sql(0)).toMatch(/is_active = \$2 AND \(company_name ILIKE \$3 OR vendor_number ILIKE \$3\) AND is_1099_vendor = \$4 AND \(tax_id IS NULL OR tax_id = ''\)/);
  });

  it('redacts the bank blobs unless the caller explicitly asks for them', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', clabe_encrypted: 'ENC' }] });
    const redacted = await listVendors(ENTITY);
    expect(redacted.rows[0]).not.toHaveProperty('clabe_encrypted');

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', clabe_encrypted: 'ENC' }] });
    const raw = await listVendors(ENTITY, { includeBankSecrets: true });
    expect(raw.rows[0].clabe_encrypted).toBe('ENC');
  });
});

describe('getVendorById', () => {
  it('returns null instead of throwing, so the caller chooses the error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getVendorById('v1', SCOPE)).toBeNull();
  });

  it('keeps money as strings, per currency, and the single figures are book values (MNE-001-741)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', entity_id: ENTITY }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { book_currency: 'MXN', currency_code: 'MXN', bill_count: '2', open_count: '1', billed: '900.0000',
          open_balance: '800.0000', book_billed: '900.0000', book_open_balance: '800.0000', last_bill_date: '2026-08-20' },
        { book_currency: 'MXN', currency_code: 'USD', bill_count: '1', open_count: '1', billed: '500.0000',
          open_balance: '500.0000', book_billed: '8750.0000', book_open_balance: '8750.0000', last_bill_date: '2026-08-21' },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ currency_code: 'USD', payment_count: '1', paid: '100.0000', book_paid: '1800.0000', last_payment_date: '2026-09-01' }],
    });
    const vendor = await getVendorById('v1', SCOPE, { includeActivity: true });
    const activity = vendor?.activity as Record<string, unknown>;
    // 800 + 500 × 17.50; never 800 + 500.
    expect(activity).toMatchObject({
      bill_count: '3', open_count: '2', billed: '9650.0000', open_balance: '9550.0000', paid: '1800.0000',
      book_currency: 'MXN', last_bill_date: '2026-08-21', payment_count: '1', last_payment_date: '2026-09-01',
    });
    expect((activity.by_currency as Array<{ currency_code: string; paid: string }>).map((c) => [c.currency_code, c.paid]))
      .toEqual([['MXN', '0'], ['USD', '100.0000']]);
    // Two statements, as before: bills and payments, each grouped by currency, bounded by vendor and entity.
    expect(mockQuery.mock.calls).toHaveLength(3);
    expect(sql(1)).toMatch(/GROUP BY le\.functional_currency, b\.currency_code/);
    expect(sql(1)).toMatch(/b\.vendor_id = \$1/);
    expect(sql(1)).toMatch(/WHERE le\.id = \$2/);
    // Open is what ap reconcile weighs: a draft is not owed.
    expect(mockQuery.mock.calls[1][1]).toEqual(['v1', ENTITY, ['approved', 'posted', 'partially_paid']]);
    expect(sql(2)).toMatch(/ROUND\(p\.payment_amount \* p\.exchange_rate, 4\)/);
    expect(sql(2)).toMatch(/p\.vendor_id = \$1 AND p\.entity_id = \$2/);
  });

  it('a vendor with no bills still says its book currency and owes nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', entity_id: ENTITY }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ book_currency: 'MXN', currency_code: null, bill_count: '0', open_count: '0', billed: null,
        open_balance: '0', book_billed: null, book_open_balance: '0', last_bill_date: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const activity = (await getVendorById('v1', SCOPE, { includeActivity: true }))?.activity as Record<string, unknown>;
    expect(activity).toMatchObject({ bill_count: '0', open_balance: '0.0000', book_currency: 'MXN', by_currency: [] });
  });

  it('does not touch bills or payments when activity was not asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await getVendorById('v1', SCOPE);
    expect(mockQuery.mock.calls).toHaveLength(1);
  });
});

describe('resolveVendor — what a person types', () => {
  it('looks a uuid up by id, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ENTITY }] });
    await resolveVendor(ENTITY, ENTITY);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
  });

  it('matches a vendor number, an exact name or a tax id before guessing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await resolveVendor(ENTITY, 'V-2026-00001');
    expect(sql(0)).toMatch(/vendor_number = \$2 OR upper\(company_name\) = upper\(\$2\) OR upper\(tax_id\) = upper\(\$2\)/);
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('falls back to a fuzzy name only when nothing matched exactly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await resolveVendor(ENTITY, 'servicios');
    expect(sql(1)).toMatch(/company_name ILIKE \$2/);
    expect(params(1)[1]).toBe('%servicios%');
  });

  it('refuses to pick one of several matches — paying the wrong vendor is not recoverable', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'v1', vendor_number: 'V-1', company_name: 'Servicios Uno' },
        { id: 'v2', vendor_number: 'V-2', company_name: 'Servicios Dos' },
      ],
    });
    const error = await resolveVendor(ENTITY, 'servicios').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toMatch(/matches 2 vendors/);
    // It lists them, so the caller can pick without a second query.
    expect((error as Error).message).toContain('V-2');
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveVendor(ENTITY, 'nadie')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('nadie') })
    );
  });
});

// ============================================================
// WRITES
// ============================================================

describe('createVendor', () => {
  const base = { entity_id: ENTITY, company_name: 'Proveedor Uno', created_by: USER };

  it('keeps the route defaults: Net 30, USD, not a 1099 vendor', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // G3: el INSERT del rastro
    await createVendor(base);
    const p = params(1);
    expect(p[2]).toBe('V-2026-00001'); // vendor_number, drawn from the entity counter
    expect(p[7]).toBe(false); // is_1099_vendor
    expect(p[10]).toBe('Net 30');
    expect(p[12]).toBe('USD');
  });

  it('encrypts bank details rather than storing them in the clear', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await createVendor({ ...base, clabe: '012345678901234567' });
    expect(params(1)[15]).not.toBe('012345678901234567');
    expect(params(1)[15]).toBeTruthy();
  });

  // G3: el alta deja rastro, en la MISMA transacción, y sin llevarse los
  // secretos bancarios a una tabla de sólo agregar.
  it('writes an audit row in the same transaction, without the bank secrets', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '1' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'v1', company_name: 'Proveedor Uno', clabe_encrypted: 'ENC' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await createVendor({ ...base, clabe: '012345678901234567' });

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(sql(2)).toMatch(/INSERT INTO audit_log/);
    const p = params(2);
    expect(p[1]).toBe(USER);          // user_id
    expect(p[2]).toBe('tenant-1');    // tenant_id, del contexto
    expect(p[3]).toBe(ENTITY);         // legal_entity_id
    expect(p[4]).toBe('create');      // action
    expect(p[5]).toBe('vendor');      // entity_type
    expect(p[6]).toBe('v1');          // entity_id
    const nuevos = String(p[8]);
    expect(nuevos).not.toContain('012345678901234567');
    expect(nuevos).not.toContain('ENC');
    expect(nuevos).toContain('bank_details_on_file');
  });

  it('turns a unique-violation on a hand-set vendor number into a named conflict', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '5' }] });
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const error = await createVendor(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toMatch(/already exists in this entity/);
    expect((error as Error).message).toContain('V-2026-00005');
  });

  it('lets any other database error through untranslated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '1' }] });
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(createVendor(base)).rejects.toThrow(/connection lost/);
  });

  it('redacts the bank blobs from what it returns, unless asked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ value: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', clabe_encrypted: 'ENC' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await createVendor(base)).not.toHaveProperty('clabe_encrypted');
  });
});

describe('updateVendor', () => {
  it('writes only whitelisted fields — bank columns are not among them', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', email: 'old@x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await updateVendor('v1', SCOPE, { email: 'new@x', clabe_encrypted: 'ENC' } as never, { userId: USER });
    expect(sql(1)).toMatch(/SET email = \$1, updated_at = NOW\(\)/);
    expect(sql(1)).not.toMatch(/clabe/);
  });

  it('names the updatable fields when given none of them, before touching the database', async () => {
    await expect(updateVendor('v1', SCOPE, {}, { userId: USER })).rejects.toThrow(
      new RegExp(VENDOR_UPDATABLE_FIELDS.join(', '))
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('locks the row before reading the before-image, so the audit cannot race', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', email: 'old@x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await updateVendor('v1', SCOPE, { email: 'new@x' }, { userId: USER });
    // R2: la pertenencia y el candado van juntos vía requireByIdInScope
    // (forUpdate:true); el FOR UPDATE real lo ejercita la suite de
    // integración — aquí el mock de scope.ts registra la forma acotada.
    expect(sql(0)).toMatch(/SELECT \* FROM vendors WHERE id = \$1 AND entity_id = \$2/);
  });

  it('writes an audit row with before and after when a tenant is known', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', email: 'old@x' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', entity_id: 'e-1' }] });
    await updateVendor('v1', SCOPE, { email: 'new@x' }, { userId: USER, tenantId: TENANT, reason: 'por telefono' });
    expect(sql(2)).toMatch(/INSERT INTO audit_log/);
    expect(params(2)[3]).toBe('e-1'); // legal_entity_id
    expect(params(2)[5]).toBe('{"email":"old@x"}');
    expect(params(2)[6]).toBe('{"email":"new@x"}');
    expect(params(2)[7]).toBe('por telefono');
  });

  it('skips the audit row when there is no tenant to attribute it to', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await updateVendor('v1', SCOPE, { email: 'new@x' }, { userId: USER });
    expect(mockQuery.mock.calls).toHaveLength(2);
  });

  it('throws NotFound when the vendor is gone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(updateVendor('gone', SCOPE, { email: 'x@y' }, { userId: USER })).rejects.toThrow(NotFoundError);
  });
});

describe('setVendorTerms', () => {
  it('stores the normalized spelling, not what was typed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', payment_terms: 'Net 30', currency_code: 'MXN' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1', payment_terms: 'Net 45', currency_code: 'MXN' }] });
    const { terms } = await setVendorTerms('v1', SCOPE, { terms: 'net45' }, { userId: USER });
    expect(params(1)[0]).toBe('Net 45');
    expect(terms?.netDays).toBe(45);
  });

  it('refuses terms no due date can be computed from', async () => {
    await expect(
      setVendorTerms('v1', SCOPE, { terms: 'cuando se pueda' }, { userId: USER })
    ).rejects.toThrow(/not understood/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a currency that is not a 3-letter ISO code', async () => {
    await expect(setVendorTerms('v1', SCOPE, { currencyCode: 'pesos' }, { userId: USER })).rejects.toThrow(ValidationError);
  });

  it('upper-cases the currency', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'v1' }] });
    await setVendorTerms('v1', SCOPE, { currencyCode: 'usd' }, { userId: USER });
    expect(params(1)[0]).toBe('USD');
  });

  it('refuses to write nothing', async () => {
    await expect(setVendorTerms('v1', SCOPE, {}, { userId: USER })).rejects.toThrow(ValidationError);
  });
});

// ============================================================
// MNE-001-664 (#607) · the tax id of a vendor can be corrected, with a
// mandatory reason and an audit row. Statements inside the transaction, in
// order: 0 the advisory lock, 1 the scoped lock of the row, 2 the facts,
// 3 the guarded UPDATE, 4 the audit row.
// ============================================================

describe('setVendorTaxId', () => {
  const WHO = { userId: USER, reason: 'Tax status certificate of July' };
  const RFC = { taxId: 'TST010101AA1', taxIdType: 'rfc' } as const;
  const stored = { id: 'v1', entity_id: 'e-1', vendor_number: 'VND-0007', tax_id: null, tax_id_type: null };
  const facts = (over: Record<string, unknown> = {}) => ({ rows: [{ taken_by: null, bills: 0, payments: 0, ...over }] });
  const queue = (before: Record<string, unknown>, read = facts(), updated: unknown[] = [{ ...before, tax_id: 'TST010101AA1', tax_id_type: 'rfc' }]) => {
    for (const answer of [{ rows: [] }, { rows: [before] }, read, { rows: updated, rowCount: updated.length }, { rows: [] }]) {
      mockQuery.mockResolvedValueOnce(answer);
    }
  };

  it('refuses a blank reason by key and a malformed id with its rule, before touching the database', async () => {
    await expect(setVendorTaxId('v1', SCOPE, RFC, { userId: USER, reason: '   ' })).rejects.toMatchObject({
      messageKey: { key: 'error.VALIDATION_ERROR.vendor.tax_id_reason_required' }, field: 'reason',
    });
    await expect(setVendorTaxId('v1', SCOPE, { taxId: 'TST0101AA1', taxIdType: 'rfc' }, WHO)).rejects.toThrow(/is not a valid RFC/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('locks the row in scope and writes the normalized id with entity, tenant and state in the UPDATE', async () => {
    queue({ ...stored, tax_id: 'tst 0101', tax_id_type: 'rfc' }, facts({ bills: 3, payments: 2 }));
    const r = await setVendorTaxId('v1', SCOPE, { taxId: ' tst010101aa1 ', taxIdType: 'rfc' }, WHO);

    expect(sql(0)).toMatch(/pg_advisory_xact_lock/);
    expect(params(0)).toEqual(['vendor-tax-id:e-1:TST010101AA1']);
    expect(sql(1)).toMatch(/SELECT \* FROM vendors WHERE id = \$1 AND entity_id = \$2/);
    expect(sql(3)).toMatch(/UPDATE vendors SET tax_id = \$4, tax_id_type = \$5, updated_at = NOW\(\)/);
    expect(sql(3)).toMatch(/WHERE id = \$1 AND entity_id = \$2 AND entity_id IN \(SELECT id FROM legal_entities WHERE tenant_id = \$3\)/);
    expect(sql(3)).toMatch(/tax_id IS NOT DISTINCT FROM \$6 AND tax_id_type IS NOT DISTINCT FROM \$7/);
    expect(params(3)).toEqual(['v1', 'e-1', 't-1', 'TST010101AA1', 'rfc', 'tst 0101', 'rfc']);
    expect(r).toMatchObject({
      previous: { tax_id: 'tst 0101', tax_id_type: 'rfc' }, posted: { bills: 3, payments: 2 }, vendor: { tax_id: 'TST010101AA1' },
    });
    // The audit row of the same transaction: the old value, the new one, who and why.
    expect(sql(4)).toMatch(/INSERT INTO audit_log/);
    expect(params(4)).toEqual(expect.arrayContaining([
      USER, 't-1', 'e-1', 'update', 'vendor', 'v1',
      '{"tax_id":"tst 0101","tax_id_type":"rfc"}', '{"tax_id":"TST010101AA1","tax_id_type":"rfc"}', WHO.reason,
    ]));
  });

  it('refuses an id another vendor of the entity carries, naming it, and writes nothing', async () => {
    queue(stored, facts({ taken_by: 'VND-0003' }));
    await expect(setVendorTaxId('v1', SCOPE, RFC, WHO)).rejects.toMatchObject({
      statusCode: 409,
      messageKey: { key: 'error.RESOURCE_ALREADY_EXISTS.vendor.tax_id_taken', params: { taxId: 'TST010101AA1', number: 'VND-0003' } },
    });
    // The duplicate is looked for inside the entity, on the id without spaces, hyphens or case.
    expect(sql(2)).toMatch(/o\.entity_id = \$2 AND o\.id <> \$1/);
    expect(params(2)).toEqual(['v1', 'e-1', 'TST010101AA1']);
    expect(mockQuery.mock.calls).toHaveLength(3);
  });

  it('compares an EIN without its hyphen, and never treats a SAT generic RFC as taken', async () => {
    queue(stored, facts(), [{ ...stored, tax_id: '47-1234567', tax_id_type: 'ein' }]);
    await setVendorTaxId('v1', SCOPE, { taxId: '471234567', taxIdType: 'ein' }, WHO);
    expect(params(2)[2]).toBe('471234567');
    expect(params(3)[3]).toBe('47-1234567');
    mockQuery.mockReset();
    queue(stored, facts(), [{ ...stored, tax_id: 'XEXX010101000', tax_id_type: 'rfc' }]);
    await setVendorTaxId('v1', SCOPE, { taxId: 'XEXX010101000', taxIdType: 'rfc' }, WHO);
    expect(params(2)[2]).toBeNull();
  });

  it('refuses the id and type the vendor already has: there is nothing to correct', async () => {
    queue({ ...stored, tax_id: RFC.taxId, tax_id_type: RFC.taxIdType });
    await expect(setVendorTaxId('v1', SCOPE, RFC, WHO)).rejects.toMatchObject({
      messageKey: { key: 'error.VALIDATION_ERROR.vendor.tax_id_unchanged' },
    });
    expect(mockQuery.mock.calls).toHaveLength(3);
  });

  it('a vendor out of scope is NotFound, and so is an UPDATE that reaches no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(setVendorTaxId('gone', SCOPE, RFC, WHO)).rejects.toThrow(NotFoundError);
    mockQuery.mockReset();
    queue(stored, facts(), []);
    await expect(setVendorTaxId('v1', SCOPE, RFC, WHO)).rejects.toThrow(NotFoundError);
    expect(mockQuery.mock.calls).toHaveLength(4);
  });
});
