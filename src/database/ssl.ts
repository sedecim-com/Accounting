import fs from 'node:fs';
import type pg from 'pg';

// ============================================================
// TLS HACIA LA BASE
//
// Las cuatro modalidades son las de libpq, y la distinción que
// importa es entre las dos del medio:
//   · require     cifra y NO verifica nada — no protege de un
//                 intermediario que presente su propio certificado.
//   · verify-full cifra, valida la cadena y el nombre del servidor.
// Por eso el default para un host remoto es verify-full y no
// require, que es lo que la gente pone por costumbre.
// ============================================================

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

/** Un host local no necesita TLS; cualquier otro sí, y verificado. */
export function defaultSslMode(connectionString: string): SslMode {
  return isLocalHost(connectionString) ? 'disable' : 'verify-full';
}

export function isLocalHost(connectionString: string): boolean {
  try {
    // URL.hostname devuelve las direcciones IPv6 ENTRE CORCHETES ("[::1]"),
    // así que compararlas crudas trata a ::1 como remoto y le exige TLS
    // verificado a un Postgres local.
    const host = new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  } catch {
    return false;
  }
}

/** El CA puede venir como ruta a un .pem o como el PEM en línea. */
function readCa(source?: string): string | undefined {
  if (!source) return undefined;
  const trimmed = source.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  if (!fs.existsSync(trimmed)) {
    throw new Error(`No existe el archivo de CA indicado en DATABASE_SSL_CA: ${trimmed}`);
  }
  return fs.readFileSync(trimmed, 'utf-8');
}

export interface SslResolution {
  ssl: pg.PoolConfig['ssl'];
  /** Advertencia a mostrar cuando la configuración deja un hueco real. */
  warning?: string;
}

export function resolveSsl(opts: {
  connectionString: string;
  mode?: string;
  caSource?: string;
}): SslResolution {
  const mode = (opts.mode || defaultSslMode(opts.connectionString)) as SslMode;
  if (!SSL_MODES.includes(mode)) {
    throw new Error(`DATABASE_SSL_MODE inválido: "${mode}". Usa ${SSL_MODES.join(' | ')}`);
  }

  if (mode === 'disable') {
    const warning = isLocalHost(opts.connectionString)
      ? undefined
      : 'TLS desactivado hacia un host remoto: las credenciales y los datos viajan en claro.';
    return { ssl: false, warning };
  }

  const ca = readCa(opts.caSource);

  if (mode === 'require') {
    return {
      ssl: { rejectUnauthorized: false },
      warning:
        'sslmode=require cifra pero NO verifica el certificado: no protege de un intermediario. ' +
        'Usa verify-full en producción.',
    };
  }

  if (mode === 'verify-ca') {
    return {
      // Valida la cadena pero no el nombre del host: útil cuando se conecta a
      // través de un túnel, donde el nombre local nunca va a coincidir.
      ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}), checkServerIdentity: () => undefined },
    };
  }

  // verify-full: sin CA explícito se usa el almacén de confianza del sistema,
  // que alcanza para los proveedores con certificado de una CA pública (Neon,
  // Supabase). RDS y Cloud SQL requieren su propio bundle.
  return { ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
}
