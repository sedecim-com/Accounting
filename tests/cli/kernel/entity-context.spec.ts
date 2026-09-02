import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/ai/context.js', () => ({
  resolveEntity: vi.fn(),
  listEntities: vi.fn(),
}));

import {
  resolveActiveEntity,
  requireExplicitEntity,
  esFalloDeConexion,
  useEntity,
  readState,
  writeState,
  clearActiveEntity,
  statePath,
} from '../../../src/cli/kernel/entity-context.js';
import { resolveEntity, listEntities } from '../../../src/ai/context.js';

const mockResolve = resolveEntity as unknown as Mock;
const mockList = listEntities as unknown as Mock;

const CTX = {
  entityId: 'e-1', entityName: 'Demo Corp MX', tenantId: 't-1',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
};

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemo-state-'));
  mockResolve.mockReset();
  mockList.mockReset();
  delete process.env.MNEMOSINE_ENTITY;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.MNEMOSINE_ENTITY;
});

describe('precedence: explicit beats stored beats the only one', () => {
  it('--entity wins over everything', async () => {
    writeState({ entityId: 'pinned' }, home);
    process.env.MNEMOSINE_ENTITY = 'from-env';
    mockResolve.mockResolvedValueOnce(CTX);
    const r = await resolveActiveEntity({ entity: 'explicit' }, { home });
    expect(r.source).toBe('flag');
    expect(mockResolve).toHaveBeenCalledWith('explicit');
  });

  it('the environment beats the stored pin, for CI and scripts', async () => {
    writeState({ entityId: 'pinned' }, home);
    process.env.MNEMOSINE_ENTITY = 'from-env';
    mockResolve.mockResolvedValueOnce(CTX);
    const r = await resolveActiveEntity({}, { home });
    expect(r.source).toBe('env');
    expect(mockResolve).toHaveBeenCalledWith('from-env');
  });

  it('the stored pin is used when nothing else is given', async () => {
    writeState({ entityId: 'pinned' }, home);
    mockResolve.mockResolvedValueOnce(CTX);
    const r = await resolveActiveEntity({}, { home });
    expect(r.source).toBe('stored');
    expect(mockResolve).toHaveBeenCalledWith('pinned');
  });

  it('falls back to the single-entity rule with no pin at all', async () => {
    mockResolve.mockResolvedValueOnce(CTX);
    const r = await resolveActiveEntity({}, { home });
    expect(r.source).toBe('only');
    expect(mockResolve).toHaveBeenCalledWith();
  });
});

describe('a failed lookup must never destroy the pin — and each cause gets ITS remedy', () => {
  it('base caída: lanza UNA vez, remedia con doctor/DATABASE_URL y jamás sugiere entity use', async () => {
    writeState({ entityId: 'pinned', entityName: 'Cliente SA' }, home);
    mockResolve.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const fallo = await resolveActiveEntity({}, { home }).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number }
    );

    expect(fallo).not.toBeNull();
    expect(fallo!.name).toBe('CliError');
    expect(fallo!.message).toMatch(/mnemosine doctor/);
    expect(fallo!.message).toMatch(/DATABASE_URL/);
    // `entity use` necesita la base: sugerirlo aquí mandaría al usuario a
    // estrellarse con el mismo fallo otra vez.
    expect(fallo!.message).not.toMatch(/entity use/);
    // The whole point: a transient failure is not a reason to lose user state.
    expect(readState(home).entityId).toBe('pinned');
    // Sin segundo intento contra resolveEntity(): así el error salía DOS veces.
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('entidad desaparecida: remedio entity use / entity unset, pin conservado, sin fallback', async () => {
    writeState({ entityId: 'deleted-entity' }, home);
    mockResolve.mockRejectedValueOnce(new Error('No active entity exists with id deleted-entity'));

    const fallo = await resolveActiveEntity({}, { home }).then(
      () => null,
      (e: unknown) => e as Error & { exitCode?: number }
    );

    expect(fallo).not.toBeNull();
    expect(fallo!.name).toBe('CliError');
    expect(fallo!.exitCode).toBe(3); // NOT_FOUND del contrato de salidas
    expect(fallo!.message).toMatch(/entity use/);
    expect(fallo!.message).toMatch(/entity unset/);
    expect(readState(home).entityId).toBe('deleted-entity');
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('clears only when asked to, explicitly', () => {
    writeState({ entityId: 'pinned', entityName: 'X' }, home);
    clearActiveEntity(home);
    expect(readState(home).entityId).toBeUndefined();
  });
});

describe('esFalloDeConexion — la frontera entre «no hay base» y «no hay entidad»', () => {
  it('reconoce los códigos de red y de pg aunque el mensaje no diga nada', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', '08006', '28000', '57P01', '3D000']) {
      const err = Object.assign(new Error('boom'), { code });
      expect(esFalloDeConexion(err), `code ${code}`).toBe(true);
    }
  });

  it('reconoce las firmas de texto del primer día (role postgres, terminated, tunnel)', () => {
    for (const msg of [
      'role "postgres" does not exist',
      'connection terminated unexpectedly',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'could not open SSH tunnel to bastion',
      'timed out after 3000ms',
    ]) {
      expect(esFalloDeConexion(new Error(msg)), msg).toBe(true);
    }
  });

  it('los errores de resolución de entidad NO son fallos de conexión', () => {
    for (const msg of [
      'No active entity exists with id deleted-entity',
      'No active entity matches "Demmo"',
      '"Demo" is ambiguous. Matches:',
      'There are no active legal entities in this tenant. Create one first (POST /v1/entities or seed).',
    ]) {
      expect(esFalloDeConexion(new Error(msg)), msg).toBe(false);
    }
  });
});

describe('the state file', () => {
  it('is written under the home directory, readable only by its owner', () => {
    const file = writeState({ entityId: 'e-9' }, home);
    expect(file).toBe(statePath(home));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('survives corruption: a broken cursor must not block every command', () => {
    fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
    fs.writeFileSync(statePath(home), '{ not json');
    expect(readState(home)).toEqual({});
  });

  it('ignores values of the wrong type instead of trusting them', () => {
    fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
    fs.writeFileSync(statePath(home), JSON.stringify({ entityId: 42 }));
    expect(readState(home).entityId).toBeUndefined();
  });

  it('merges rather than replacing, so unrelated keys survive', () => {
    writeState({ entityId: 'a', entityName: 'A' }, home);
    writeState({ entityId: 'b' }, home);
    expect(readState(home)).toEqual({ entityId: 'b', entityName: 'A' });
  });
});

describe('useEntity', () => {
  it('resolves before pinning, so a typo never becomes the active company', async () => {
    mockResolve.mockRejectedValueOnce(new Error('No active entity matches "Demmo"'));
    await expect(useEntity('Demmo', home)).rejects.toThrow(/Demmo/);
    expect(readState(home).entityId).toBeUndefined();
  });

  it('stores the resolved id and name', async () => {
    mockResolve.mockResolvedValueOnce(CTX);
    const { ctx } = await useEntity('Demo', home);
    expect(ctx.entityId).toBe('e-1');
    expect(readState(home)).toEqual({ entityId: 'e-1', entityName: 'Demo Corp MX' });
  });
});

describe('requireExplicitEntity — a write never guesses', () => {
  it('refuses the only-entity fallback when the firm has several', async () => {
    mockResolve.mockResolvedValueOnce(CTX);
    mockList.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await expect(requireExplicitEntity({}, { home })).rejects.toThrow(
      expect.objectContaining({ name: 'CliError', message: expect.stringContaining('will not guess the entity') })
    );
  });

  it('allows it when there is genuinely only one', async () => {
    mockResolve.mockResolvedValueOnce(CTX);
    mockList.mockResolvedValueOnce([{ id: 'a' }]);
    expect((await requireExplicitEntity({}, { home })).entityId).toBe('e-1');
  });

  it('is satisfied by an explicit --entity', async () => {
    mockResolve.mockResolvedValueOnce(CTX);
    expect((await requireExplicitEntity({ entity: 'Demo' }, { home })).entityId).toBe('e-1');
    expect(mockList).not.toHaveBeenCalled();
  });

  it('is satisfied by a pinned entity', async () => {
    writeState({ entityId: 'pinned' }, home);
    mockResolve.mockResolvedValueOnce(CTX);
    expect((await requireExplicitEntity({}, { home })).entityId).toBe('e-1');
    expect(mockList).not.toHaveBeenCalled();
  });
});
