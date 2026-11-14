import { describe, it, expect } from 'vitest';
import { resolveRole, normalizeUserInput, MIN_PASSWORD, MAX_PASSWORD_BYTES } from '../../../src/services/user/user-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

// MNE-001-086 (#326): what `user create` validates before any connection.

const base = { tenantId: 't', email: ' Ana@Example.COM ', role: 'viewer', password: 'x'.repeat(MIN_PASSWORD) };

describe('resolveRole', () => {
  it('takes a role of src/auth/roles.ts or its Spanish alias', () => {
    expect(resolveRole('Owner')).toBe('owner');
    expect(resolveRole('dueño')).toBe('owner');
    expect(resolveRole('lector')).toBe('viewer');
  });

  it('refuses anything else, naming the roles', () => {
    expect(() => resolveRole('system')).toThrow(/owner, admin/);
  });
});

describe('normalizeUserInput', () => {
  it('lower-cases and trims the email', () => {
    expect(normalizeUserInput(base)).toEqual({ email: 'ana@example.com', role: 'viewer' });
  });

  it('refuses an address without @', () => {
    expect(() => normalizeUserInput({ ...base, email: 'ana' })).toThrow(ValidationError);
  });

  it('refuses a short password without echoing it', () => {
    const password = 'short-pw';
    let message = '';
    try { normalizeUserInput({ ...base, password }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/too short/);
    expect(message).not.toContain(password);
  });

  it('refuses a password bcrypt would truncate', () => {
    expect(() => normalizeUserInput({ ...base, password: 'ñ'.repeat(MAX_PASSWORD_BYTES / 2 + 1) })).toThrow(/too long/);
    expect(normalizeUserInput({ ...base, password: 'a'.repeat(MAX_PASSWORD_BYTES) }).role).toBe('viewer');
  });
});
