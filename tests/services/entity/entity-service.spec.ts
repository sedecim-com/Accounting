import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(mockClient)),
}));
vi.mock('../../../src/services/accounting/entity-accounting.js', () => ({
  ensureEntityAccounting: vi.fn(async () => ({
    accountsCreated: [],
    rolesMapped: [],
    cuentasBaseCreadas: ['1000'],
    estrategiaAplicada: 'auto',
    teniaCatalogo: false,
    nomina: { country: 'MX', accountsCreated: [], bucketsMapped: [], bucketsAlreadyMapped: [], bucketsUnmappable: [] },
  })),
}));

import {
  createEntity,
  normalizeTaxId,
  resolveTenantForCreation,
  ensureSystemUser,
  SYSTEM_USER_EMAIL,
  COUNTRY_PROFILES,
  validateEntityTaxProfile,
  getEntityTaxProfile,
  updateEntityTaxProfile,
} from '../../../src/services/entity/entity-service.js';
import { query } from '../../../src/database/connection.js';
import { ensureEntityAccounting } from '../../../src/services/accounting/entity-accounting.js';
import { ValidationError, NotFoundError, ConflictError } from '../../../src/utils/errors.js';

// ============================================================
// Creating a company used to be a PRIVATE METHOD of the setup wizard, so
// nothing else in the system could make one — and every other capability is
// downstream of an entity existing. Two defects travelled with it:
// the tenant was chosen as "the oldest one in the installation", and
// created_by received the entity's own id.
// ============================================================

const mockClient = { query: vi.fn() };
const TENANT = 'tttttttt-tttt-tttt-tttt-tttttttttttt';
const OTHER_TENANT = 'oooooooo-oooo-oooo-oooo-oooooooooooo';
const USER = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';

beforeEach(() => {
  mockClient.query.mockReset();
  (ensureEntityAccounting as unknown as Mock).mockClear();
  (query as unknown as Mock).mockReset();
});

/** Routes each query by the table it names, so order does not matter. */
function db(over: {
  tenants?: Array<{ id: string; name: string }>;
  duplicate?: Array<{ id: string; name: string }>;
  systemUser?: Array<{ id: string }>;
} = {}) {
  const tenants = over.tenants ?? [{ id: TENANT, name: 'Despacho' }];
  mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM public\.tenants WHERE id/.test(sql)) {
      const wanted = params?.[0];
      return { rows: tenants.filter((t) => t.id === wanted) };
    }
    if (/FROM public\.tenants/.test(sql)) return { rows: tenants };
    if (/INSERT INTO public\.tenants/.test(sql)) return { rows: [{ id: 'new-tenant' }] };
    if (/FROM legal_entities WHERE tenant_id/.test(sql)) return { rows: over.duplicate ?? [] };
    if (/FROM public\.users/.test(sql)) return { rows: over.systemUser ?? [] };
    if (/INSERT INTO public\.users/.test(sql)) return { rows: [{ id: 'system-user' }] };
    if (/INSERT INTO organizations/.test(sql)) return { rows: [{ id: 'org-1' }] };
    if (/INSERT INTO legal_entities/.test(sql)) return { rows: [{ id: 'entity-1' }] };
    return { rows: [] };
  });
}

describe('tax id validation', () => {
  it('accepts a moral and a physical RFC, normalising case and separators', () => {
    expect(normalizeTaxId(' san190415hk2 ', 'MX')).toBe('SAN190415HK2');
    expect(normalizeTaxId('AAA010101AAA', 'MX')).toBe('AAA010101AAA');
    expect(normalizeTaxId('AAAA010101AA1', 'MX')).toBe('AAAA010101AA1');
  });

  it('accepts the Ñ and & that a real RFC can carry', () => {
    expect(normalizeTaxId('ÑAS010101AA1', 'MX')).toBe('ÑAS010101AA1');
    expect(normalizeTaxId('A&B010101AA1', 'MX')).toBe('A&B010101AA1');
  });

  it('accepts an EIN written either way', () => {
    expect(normalizeTaxId('12-3456789', 'USA')).toBe('123456789');
    expect(normalizeTaxId('123456789', 'USA')).toBe('123456789');
  });

  it('names the format instead of just refusing', () => {
    expect(() => normalizeTaxId('NOPE', 'MX')).toThrow(ValidationError);
    expect(() => normalizeTaxId('NOPE', 'MX')).toThrow(/homoclave/);
    expect(() => normalizeTaxId('12345', 'USA')).toThrow(/nine digits/);
  });
});

describe('tenant selection — never "the oldest one"', () => {
  it('uses the explicit tenant when given', async () => {
    db({ tenants: [{ id: TENANT, name: 'Despacho' }] });
    const r = await resolveTenantForCreation(mockClient as never, TENANT, 'Acme');
    expect(r).toEqual({ tenantId: TENANT, created: false });
  });

  it('refuses an explicit tenant that does not exist', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    await expect(resolveTenantForCreation(mockClient as never, 'ghost', 'Acme')).rejects.toThrow(NotFoundError);
  });

  it('auto-selects only when the installation has exactly one', async () => {
    db({ tenants: [{ id: TENANT, name: 'Despacho' }] });
    const r = await resolveTenantForCreation(mockClient as never, undefined, 'Acme');
    expect(r.tenantId).toBe(TENANT);
  });

  it('REFUSES to guess with several tenants, and names them', async () => {
    // The old wizard took ORDER BY created_at ASC LIMIT 1, so in a firm
    // running two practices every new company silently joined the first —
    // and RLS then made that invisible.
    db({ tenants: [{ id: TENANT, name: 'Despacho A' }, { id: OTHER_TENANT, name: 'Despacho B' }] });
    await expect(resolveTenantForCreation(mockClient as never, undefined, 'Acme')).rejects.toThrow(ValidationError);
    await expect(resolveTenantForCreation(mockClient as never, undefined, 'Acme')).rejects.toThrow(/Despacho A[\s\S]*Despacho B/);
  });

  it('creates the first tenant when there are none at all', async () => {
    db({ tenants: [] });
    const r = await resolveTenantForCreation(mockClient as never, undefined, 'Acme Servicios SA');
    expect(r).toEqual({ tenantId: 'new-tenant', created: true });
  });
});

describe('attribution — created_by must reference a user', () => {
  it('uses the given user when one is in session', async () => {
    db();
    const r = await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER });
    expect(r.createdBy).toBe(USER);
    expect(r.attributedToSystem).toBe(false);
  });

  it('falls back to a per-tenant SYSTEM account, never to the entity id', async () => {
    db();
    const r = await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT });
    expect(r.createdBy).toBe('system-user');
    expect(r.createdBy).not.toBe(r.entityId);
    expect(r.attributedToSystem).toBe(true);
  });

  it('reuses the system account instead of creating a second one', async () => {
    db({ systemUser: [{ id: 'existing-system' }] });
    const id = await ensureSystemUser(mockClient as never, TENANT);
    expect(id).toBe('existing-system');
    const inserts = mockClient.query.mock.calls.filter(([sql]) => /INSERT INTO public\.users/.test(String(sql)));
    expect(inserts).toHaveLength(0);
  });

  it('creates the system account inactive, so it can never be signed in as', async () => {
    db();
    await ensureSystemUser(mockClient as never, TENANT);
    const [sql, params] = mockClient.query.mock.calls.find(([s]) => /INSERT INTO public\.users/.test(String(s)))!;
    expect(String(sql)).toMatch(/false/); // is_active
    expect(params[1]).toBe(SYSTEM_USER_EMAIL);
    // The hash is random, not a known value someone could guess.
    expect(String(params[2])).toHaveLength(64);
  });
});

describe('createEntity', () => {
  it('applies the country profile', async () => {
    db();
    const mx = await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER });
    expect(mx.currency).toBe('MXN');
    expect(mx.accountingStandard).toBe('mx_nif');

    db();
    const us = await createEntity({ name: 'Acme Inc', taxId: '12-3456789', country: 'USA', tenantId: TENANT, createdBy: USER });
    expect(us.currency).toBe('USD');
    expect(us.accountingStandard).toBe('us_gaap');
    expect(us.taxId).toBe('123456789');
  });

  it('guarda un país que quepa en la columna, que es CHAR(2)', async () => {
    // legal_entities.incorporation_country es CHAR(2) y aquí se insertaba la
    // CLAVE del catálogo de perfiles, que para Estados Unidos es 'USA'. Crear
    // una entidad estadounidense moría con «value too long for type
    // character(2)»: el carril entero de EE. UU. —su nómina incluida— nunca se
    // había ejecutado, y por eso nadie lo había visto.
    db();
    await createEntity({ name: 'Acme Inc', taxId: '12-3456789', country: 'USA', tenantId: TENANT, createdBy: USER });
    const llamadas = mockClient.query.mock.calls as Array<[string, unknown[]?]>;
    const insert = llamadas.find((c) => /INSERT INTO legal_entities/.test(c[0]));
    const pais = insert?.[1]?.[6];
    expect(pais).toBe('US');
    expect(String(pais)).toHaveLength(2);
  });

  it('honours an explicit currency over the country default', async () => {
    db();
    const r = await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', currency: 'USD', tenantId: TENANT, createdBy: USER });
    expect(r.currency).toBe('USD');
  });

  it('refuses a duplicate tax id within the tenant, naming the holder', async () => {
    db({ duplicate: [{ id: 'other', name: 'Ya Existe SA' }] });
    await expect(
      createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER })
    ).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('Ya Existe SA') })
    );
  });

  it('refuses an empty name before touching the database', async () => {
    db();
    await expect(createEntity({ name: '   ', taxId: 'AAA010101AAA', country: 'MX' })).rejects.toThrow(ValidationError);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('seeds chart, roles and payroll in the SAME transaction as the entity', async () => {
    db();
    await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER });
    const call = (ensureEntityAccounting as unknown as Mock).mock.calls[0];
    expect(call[0]).toBe('entity-1');
    expect(call[1]).toBe(TENANT);
    expect(call[2]).toBe(USER);
    // Sharing the client is what stops an entity existing half-configured.
    expect(call[3].client).toBe(mockClient);
  });

  it('rejects an unsupported country by name', async () => {
    await expect(
      createEntity({ name: 'Acme', taxId: 'AAA010101AAA', country: 'CA' as never })
    ).rejects.toThrow(new RegExp(Object.keys(COUNTRY_PROFILES).join(', ')));
  });
});

// ============================================================
// MNE-001-017 (#321). The entity had an RFC and nothing else of its fiscal
// identity: customers carry c_RegimenFiscal and the fiscal postal code since
// 049, the company keeping the books did not. Same shape, same validation.
// ============================================================

describe('validateEntityTaxProfile', () => {
  it('accepts a c_RegimenFiscal code and a five-digit postal code', () => {
    expect(validateEntityTaxProfile({ taxRegime: '601', taxPostalCode: '01000' })).toEqual({
      tax_regime: '601',
      tax_postal_code: '01000',
    });
    expect(validateEntityTaxProfile({ taxRegime: ' 626 ' })).toEqual({ tax_regime: '626' });
    expect(validateEntityTaxProfile({})).toEqual({});
  });

  it('refuses a regime the SAT catalog does not carry, naming examples', () => {
    expect(() => validateEntityTaxProfile({ taxRegime: '999' })).toThrow(ValidationError);
    expect(() => validateEntityTaxProfile({ taxRegime: '999' })).toThrow(/c_RegimenFiscal.*601/);
  });

  it('refuses a postal code that is not five digits', () => {
    expect(() => validateEntityTaxProfile({ taxPostalCode: '1000' })).toThrow(/5 digits/);
    expect(() => validateEntityTaxProfile({ taxPostalCode: 'ABCDE' })).toThrow(ValidationError);
  });
});

describe('createEntity — regime and fiscal postal code', () => {
  const insertParams = (): unknown[] => {
    const calls = mockClient.query.mock.calls as Array<[string, unknown[]?]>;
    return calls.find((c) => /INSERT INTO legal_entities/.test(c[0]))?.[1] ?? [];
  };

  it('stores both, validated, and warns about nothing', async () => {
    db();
    const r = await createEntity({
      name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER,
      taxRegime: '601', taxPostalCode: '01000',
    });
    expect(insertParams().slice(-2)).toEqual(['601', '01000']);
    expect(r.taxRegime).toBe('601');
    expect(r.taxPostalCode).toBe('01000');
    expect(r.warnings).toEqual([]);
  });

  it('creates a Mexican entity without a regime, but warns and names the fix', async () => {
    db();
    const r = await createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', tenantId: TENANT, createdBy: USER });
    expect(r.entityId).toBe('entity-1');
    expect(insertParams().slice(-2)).toEqual([null, null]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/tax regime/);
    expect(r.warnings[0]).toMatch(/postal code/);
    expect(r.warnings[0]).toMatch(/mnemosine entity edit AAA010101AAA --tax-regime/);
  });

  it('does not ask a US entity for a Mexican regime', async () => {
    db();
    const r = await createEntity({ name: 'Acme Inc', taxId: '12-3456789', country: 'USA', tenantId: TENANT, createdBy: USER });
    expect(r.warnings).toEqual([]);
  });

  it('refuses an invalid regime before touching the database', async () => {
    db();
    await expect(
      createEntity({ name: 'Acme SA', taxId: 'AAA010101AAA', country: 'MX', taxRegime: '999' })
    ).rejects.toThrow(ValidationError);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});

describe('getEntityTaxProfile', () => {
  it('reads both columns inside the tenant and names the regime', async () => {
    (query as unknown as Mock).mockResolvedValue({ rows: [{ tax_regime: '626', tax_postal_code: '64000' }] });
    const p = await getEntityTaxProfile('entity-1', TENANT);
    expect(p).toEqual({
      tax_regime: '626',
      tax_regime_name: 'Régimen Simplificado de Confianza',
      tax_postal_code: '64000',
    });
    const [sql, params] = (query as unknown as Mock).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toMatch(/tenant_id = \$2/);
    expect(params).toEqual(['entity-1', TENANT]);
  });

  it('shows an unset profile as nulls', async () => {
    (query as unknown as Mock).mockResolvedValue({ rows: [{ tax_regime: null, tax_postal_code: null }] });
    expect(await getEntityTaxProfile('entity-1', TENANT)).toEqual({
      tax_regime: null, tax_regime_name: null, tax_postal_code: null,
    });
  });

  it('answers 404 for an entity outside the tenant', async () => {
    (query as unknown as Mock).mockResolvedValue({ rows: [] });
    await expect(getEntityTaxProfile('entity-1', OTHER_TENANT)).rejects.toThrow(NotFoundError);
  });
});

describe('updateEntityTaxProfile', () => {
  const AUDIT = { userId: USER, tenantId: TENANT, reason: 'constancia 2026' };

  function dbEdit(over: { found?: boolean; updated?: number } = {}) {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/FROM legal_entities/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: over.found === false ? [] : [{ tax_regime: null, tax_postal_code: '01000' }] };
      }
      if (/UPDATE legal_entities/.test(sql)) return { rows: [], rowCount: over.updated ?? 1 };
      return { rows: [] };
    });
  }

  it('persists with the same validation, guarded and audited', async () => {
    dbEdit();
    const p = await updateEntityTaxProfile('entity-1', TENANT, { taxRegime: '612' }, AUDIT);
    expect(p).toEqual({
      tax_regime: '612',
      tax_regime_name: 'Personas Físicas con Actividades Empresariales y Profesionales',
      tax_postal_code: '01000',
    });
    const calls = mockClient.query.mock.calls as Array<[string, unknown[]]>;
    const update = calls.find((c) => /UPDATE legal_entities/.test(c[0]))!;
    expect(update[0]).toMatch(/tenant_id = \$2/);
    expect(update[0]).toMatch(/is_active = true/);
    expect(update[1]).toEqual(['entity-1', TENANT, '612']);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c[0]))!;
    expect(audit[1]).toContain('legal_entities');
    expect(audit[1]).toContain('constancia 2026');
  });

  it('refuses an invalid regime before opening a transaction', async () => {
    dbEdit();
    await expect(updateEntityTaxProfile('entity-1', TENANT, { taxRegime: '999' }, AUDIT)).rejects.toThrow(ValidationError);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('refuses an empty patch, naming the flags', async () => {
    await expect(updateEntityTaxProfile('entity-1', TENANT, {}, AUDIT)).rejects.toThrow(/--tax-regime.*--tax-postal-code/);
  });

  it('answers 404 for an entity outside the tenant', async () => {
    dbEdit({ found: false });
    await expect(updateEntityTaxProfile('entity-1', OTHER_TENANT, { taxPostalCode: '64000' }, AUDIT)).rejects.toThrow(NotFoundError);
  });

  it('complains when the guarded UPDATE touches no row', async () => {
    dbEdit({ updated: 0 });
    await expect(updateEntityTaxProfile('entity-1', TENANT, { taxPostalCode: '64000' }, AUDIT)).rejects.toThrow(ConflictError);
  });
});
