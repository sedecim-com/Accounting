import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted: los mocks capturan estas referencias al izarse (CJS).
const { queryMock, warnMock, infoMock, envHolder } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
  envHolder: { env: 'development' },
}));

vi.mock('../../src/database/connection.js', () => ({
  query: (...a: unknown[]) => queryMock(...a),
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: (...a: unknown[]) => warnMock(...a), info: (...a: unknown[]) => infoMock(...a) },
}));
vi.mock('../../src/config/index.js', () => ({
  config: {
    get env() {
      return envHolder.env;
    },
  },
}));

import { verificarRolSujetoARls, RolIgnoraRlsError } from '../../src/database/rls-guard.js';

/**
 * EL ARRANQUE FALLA CERRADO ANTE UN ROL QUE IGNORA RLS (S1).
 *
 * Antes era un logger.warn — también en producción: el aislamiento entero
 * colgaba de una línea de log. La auditoría 2026-08-31 lo volvió compuerta.
 */
const rol = (ignora: boolean) =>
  queryMock.mockResolvedValue({ rows: [{ rol: 'postgres', ignora }] });

beforeEach(() => {
  queryMock.mockReset();
  warnMock.mockReset();
  infoMock.mockReset();
  envHolder.env = 'development';
  delete process.env.ALLOW_RLS_BYPASS_ROLE;
});
afterEach(() => {
  delete process.env.ALLOW_RLS_BYPASS_ROLE;
});

describe('verificarRolSujetoARls', () => {
  it('en producción, un rol que ignora RLS impide arrancar', async () => {
    envHolder.env = 'production';
    rol(true);
    await expect(verificarRolSujetoARls()).rejects.toThrow(RolIgnoraRlsError);
  });

  it('el break-glass explícito deja arrancar, pero queda advertido con la válvula visible', async () => {
    envHolder.env = 'production';
    process.env.ALLOW_RLS_BYPASS_ROLE = 'I_UNDERSTAND';
    rol(true);
    await expect(verificarRolSujetoARls()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(
      'db_role_bypasses_rls',
      expect.objectContaining({ breakGlass: true })
    );
  });

  it('cualquier otro valor de la válvula NO abre: el break-glass se escribe completo o no existe', async () => {
    envHolder.env = 'production';
    process.env.ALLOW_RLS_BYPASS_ROLE = 'yes';
    rol(true);
    await expect(verificarRolSujetoARls()).rejects.toThrow(RolIgnoraRlsError);
  });

  it('en desarrollo sigue siendo warn: la suite de integración corre como superusuario a propósito', async () => {
    rol(true);
    await expect(verificarRolSujetoARls()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith('db_role_bypasses_rls', expect.anything());
  });

  it('un rol sujeto a RLS pasa en silencio informativo, también en producción', async () => {
    envHolder.env = 'production';
    rol(false);
    await expect(verificarRolSujetoARls()).resolves.toBeUndefined();
    expect(infoMock).toHaveBeenCalledWith('db_role_subject_to_rls', { role: 'postgres' });
  });

  it('si la consulta del rol falla, advierte y no tumba el arranque (no hay veredicto que dar)', async () => {
    envHolder.env = 'production';
    queryMock.mockRejectedValue(new Error('sin permiso a pg_roles'));
    await expect(verificarRolSujetoARls()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith('db_role_check_failed', expect.anything());
  });
});
