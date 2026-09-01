import { query } from './connection.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// ============================================================
// EL ARRANQUE FALLA CERRADO ANTE UN ROL QUE IGNORA RLS (S1).
//
// El middleware de contexto acota cada petición al inquilino del token, pero
// quien hace cumplir esa frontera es RLS, y RLS es INERTE para un rol
// superusuario o con BYPASSRLS: en ese estado, un error de programación que
// olvide filtrar por inquilino devuelve las filas de todos en vez de ninguna.
//
// Antes esto era un `logger.warn` — también en producción. Un aviso que
// nadie lee no es una defensa: el aislamiento entero colgaba de una línea de
// log, exactamente la clase de aviso que config/index.ts ya desterró para
// los secretos publicados. Ahora, con NODE_ENV=production y un rol que
// ignora RLS, el proceso NO arranca, salvo la válvula explícita de
// break-glass (ALLOW_RLS_BYPASS_ROLE=I_UNDERSTAND) que deja el hecho escrito
// en el entorno y en el log. En desarrollo sigue siendo warn: conectar como
// superusuario es lo normal ahí, y la suite de integración lo hace a
// propósito.
// ============================================================

export class RolIgnoraRlsError extends Error {
  constructor(rol: string) {
    super(
      `El rol de conexión "${rol}" ignora row level security (superusuario o BYPASSRLS) y ` +
        'NODE_ENV es production: el aislamiento entre inquilinos dependería solo del código. ' +
        'Conecta como mnemosine_app (scripts/provision-roles.sql) o, para un break-glass ' +
        'deliberado, arranca con ALLOW_RLS_BYPASS_ROLE=I_UNDERSTAND.'
    );
    this.name = 'RolIgnoraRlsError';
  }
}

/**
 * Verifica el rol de conexión contra pg_roles. Lanza en producción si el rol
 * ignora RLS (salvo break-glass); advierte en cualquier otro caso.
 */
export async function verificarRolSujetoARls(): Promise<void> {
  let fila: { rol: string; ignora: boolean } | undefined;
  try {
    const r = await query<{ rol: string; ignora: boolean }>(
      `SELECT current_user AS rol,
              COALESCE(rolsuper OR rolbypassrls, false) AS ignora
         FROM pg_roles WHERE rolname = current_user`
    );
    fila = r.rows[0];
  } catch (error) {
    logger.warn('db_role_check_failed', { error: (error as Error).message });
    return;
  }
  if (!fila) return;

  if (!fila.ignora) {
    logger.info('db_role_subject_to_rls', { role: fila.rol });
    return;
  }

  const breakGlass = process.env.ALLOW_RLS_BYPASS_ROLE === 'I_UNDERSTAND';
  if (config.env === 'production' && !breakGlass) {
    throw new RolIgnoraRlsError(fila.rol);
  }
  logger.warn('db_role_bypasses_rls', {
    role: fila.rol,
    breakGlass,
    detail:
      'El rol de conexión ignora row level security: el aislamiento entre ' +
      'inquilinos depende solo del código. Conectar como mnemosine_app ' +
      '(scripts/provision-roles.sql).',
  });
}
