import type { SslMode } from './ssl.js';

// ============================================================
// PRESETS DE PROVEEDOR DE POSTGRES
//
// Lo que un preset aporta no es la cadena de conexión —esa la da
// el proveedor— sino las TRAMPAS: qué puerto usar para el pooling,
// si el rol por defecto ignora RLS, y si hace falta un CA propio.
// Son las cosas que rompen el aislamiento en silencio si nadie
// las documenta.
// ============================================================

export interface DbProviderPreset {
  label: string;
  sslMode: SslMode;
  /** De dónde sale el certificado raíz para verify-full. */
  ca: 'sistema' | 'propio';
  /** Advertencias reales, no marketing. */
  caveats: string[];
  docs?: string;
}

export const DB_PROVIDERS: Record<string, DbProviderPreset> = {
  local: {
    label: 'Postgres local',
    sslMode: 'disable',
    ca: 'sistema',
    caveats: ['Sin TLS: solo para desarrollo en la misma máquina.'],
  },

  'self-hosted': {
    label: 'Autoalojado en VPS por túnel SSH',
    sslMode: 'verify-ca',
    ca: 'propio',
    caveats: [
      'El 5432 NO debe quedar expuesto a internet: el túnel es lo que lo evita.',
      'verify-ca en vez de verify-full: a través del túnel el nombre del host local ' +
        'nunca coincide con el del certificado, así que se valida la cadena y no el nombre.',
      'La identidad que autentica es la llave SSH, revocable por persona.',
    ],
  },

  neon: {
    label: 'Neon',
    sslMode: 'verify-full',
    ca: 'sistema',
    caveats: [
      'El rol por defecto (neon_superuser) tiene BYPASSRLS: si la app conecta con él, ' +
        'las políticas quedan inertes. Crea mnemosine_app aparte y confírmalo con `mnemosine doctor`.',
      'El endpoint agrupado (-pooler) usa PgBouncer en modo transacción — compatible con ' +
        'esta app, que no depende de estado de sesión.',
      'El branching sirve para probar una migración y verificar la cobertura de RLS antes de aplicarla.',
    ],
    docs: 'https://neon.com/docs/manage/roles',
  },

  supabase: {
    label: 'Supabase',
    sslMode: 'verify-full',
    ca: 'sistema',
    caveats: [
      'Nativo en RLS: las primitivas de roles y políticas son de primera clase.',
      'Puerto 6543 = pooler en modo transacción; 5432 = conexión directa. Para migraciones usa el directo.',
      'Trae su propio sistema de autenticación: decide explícitamente quién es la autoridad de ' +
        'identidad para no duplicar la capa OIDC.',
    ],
    docs: 'https://supabase.com/docs/guides/database/postgres/roles',
  },

  rds: {
    label: 'AWS RDS / Aurora',
    sslMode: 'verify-full',
    ca: 'propio',
    caveats: [
      'Requiere el bundle de CA de AWS: descárgalo y apunta DATABASE_SSL_CA a él.',
      'La autenticación IAM entrega tokens de 15 minutos en lugar de contraseñas estáticas.',
      'Única con región Mexico (Central) si la residencia de datos pesa.',
    ],
    docs: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html',
  },

  cloudsql: {
    label: 'Google Cloud SQL',
    sslMode: 'verify-full',
    ca: 'propio',
    caveats: [
      'pgaudit exige activar la bandera cloudsql.enable_pgaudit y REINICIAR la instancia ' +
        'antes del CREATE EXTENSION.',
      'El Auth Proxy es la vía recomendada: la app conecta a localhost y el proxy autentica con IAM.',
    ],
  },

  crunchy: {
    label: 'Crunchy Bridge',
    sslMode: 'verify-full',
    ca: 'sistema',
    caveats: ['Postgres a secas, sin plataforma alrededor. Trae pooling y pgvector.'],
  },
};

export function describeProvider(name: string): DbProviderPreset {
  const preset = DB_PROVIDERS[name];
  if (!preset) {
    throw new Error(
      `Proveedor de base desconocido: "${name}". Disponibles: ${Object.keys(DB_PROVIDERS).join(', ')}`
    );
  }
  return preset;
}
