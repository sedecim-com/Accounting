// ============================================================
// UN SOLO CATÁLOGO DE AUTORIZACIÓN.
//
// Había dos, con nombres de rol distintos y conjuntos distintos: el del
// middleware REST (owner/admin/controller/accountant/viewer/auditor) y el
// del asistente de alta (owner/contador/revisor/auditor). Un usuario creado
// por la terminal recibía permisos que la API no reconocía, y los roles
// `admin` y `controller` eran inalcanzables desde el único sitio donde se
// crean usuarios.
//
// El eje que este archivo NO toca es la pertenencia. Un permiso dice QUÉ
// puedes hacer; `users.accessible_entities` dice SOBRE QUÉ. Confundirlos fue
// el defecto que se corrigió al quitar el comodín de entidad: el rol owner
// es ['*'] y eso lo convertía en comodín de FILAS además de verbos.
//
// EL CONJUNTO ES CERRADO Y SE DERIVA DE LO QUE EL CÓDIGO EXIGE. La prueba
// tests/auth/roles.spec.ts recorre las llamadas a requirePermission() del
// repositorio y falla si alguna pide un permiso que no está aquí, o si aquí
// hay uno que nadie exige y no está declarado como reservado. Así el censo
// «exigidos vs concedidos» se mantiene en cero solo.
// ============================================================

/**
 * Todo permiso del sistema, en la forma `recurso:acción`.
 *
 * Cambiarlo es un acto deliberado: añadir aquí lo que una ruta nueva vaya a
 * exigir, y borrar lo que deje de exigirse.
 */
export const PERMISSIONS = [
  // Catálogo de cuentas
  'accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete',
  // Libro mayor
  'journal_entries:read', 'journal_entries:create', 'journal_entries:post', 'journal_entries:void',
  // Ventas
  'invoices:read', 'invoices:create', 'invoices:send', 'invoices:void',
  // Compras
  'bills:read', 'bills:create', 'bills:approve', 'bills:void',
  // Nómina
  'payroll:read', 'payroll:create', 'payroll:update', 'payroll:approve',
  // Calendario fiscal
  'periods:close', 'periods:reopen',
  // Informes y administración
  'reports:read', 'reports:export',
  'users:manage', 'settings:manage', 'settings:read',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permisos que ninguna ruta exige TODAVÍA y que se conceden a propósito.
 *
 * Sin esta lista, el censo obligaría a borrarlos —y volverían a inventarse
 * cuando llegara la ruta— o a dejar el censo permanentemente en rojo, que es
 * como un censo deja de mirarse. Cada entrada dice qué falta para que salga
 * de aquí.
 */
export const RESERVADOS: Readonly<Record<string, string>> = Object.freeze({
  'periods:reopen': 'reopenClosedPeriod existe pero sólo lo invoca el backfill de IVA; falta su ruta y su comando.',
  'reports:export': 'los reportes se sirven en JSON y tabla; la exportación a archivo no está construida.',
  'users:manage': 'el alta de usuarios vive en `mnemosine init`, que no pasa por requirePermission.',
  'settings:read': 'lectura de configuración sin ruta propia todavía.',
  'audit:read': 'la bitácora no tiene ruta de consulta; hoy se lee por SQL.',
});

/** El comodín de PERMISOS. No es comodín de entidades: ver la nota de arriba. */
export const COMODIN = '*';

export type RoleName =
  | 'owner' | 'admin' | 'controller' | 'contador' | 'revisor' | 'auditor' | 'viewer';

export interface RoleSpec {
  /** Alias en español, para la superficie de la terminal. */
  alias: string;
  label: string;
  /** El comodín sólo lo tiene owner. */
  permissions: readonly Permission[] | readonly [typeof COMODIN];
}

/**
 * Los siete roles, unificando los dos catálogos anteriores.
 *
 * `contador` y `revisor` existían sólo en la terminal; `admin`, `controller`
 * y `viewer` sólo en la API. Se conservan los siete con sus nombres para no
 * romper los usuarios ya creados, y cada uno declara su alias.
 */
export const ROLES: Readonly<Record<RoleName, RoleSpec>> = Object.freeze({
  owner: {
    alias: 'dueño',
    label: 'Todo, incluidas las credenciales fiscales',
    permissions: [COMODIN],
  },
  admin: {
    alias: 'administrador',
    label: 'Opera y administra, sin cerrar periodos',
    permissions: [
      'accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete',
      'journal_entries:read', 'journal_entries:create', 'journal_entries:post', 'journal_entries:void',
      'invoices:read', 'invoices:create', 'invoices:send', 'invoices:void',
      'bills:read', 'bills:create', 'bills:approve', 'bills:void',
      'payroll:read', 'payroll:create', 'payroll:update', 'payroll:approve',
      'reports:read', 'reports:export',
      'users:manage', 'settings:manage', 'settings:read',
    ],
  },
  controller: {
    alias: 'contralor',
    label: 'Cierra periodos y gobierna el mayor',
    permissions: [
      'accounts:read', 'accounts:create',
      'journal_entries:read', 'journal_entries:create', 'journal_entries:post', 'journal_entries:void',
      'periods:close', 'periods:reopen',
      'reports:read', 'reports:export', 'audit:read',
    ],
  },
  contador: {
    alias: 'contador',
    label: 'Opera y aprueba, sin tocar las credenciales del SAT',
    permissions: [
      'accounts:read', 'accounts:create', 'accounts:update',
      'journal_entries:read', 'journal_entries:create', 'journal_entries:post',
      'invoices:read', 'invoices:create', 'invoices:send',
      'bills:read', 'bills:create', 'bills:approve',
      'payroll:read', 'payroll:create',
      'reports:read', 'periods:close', 'settings:read',
    ],
  },
  revisor: {
    alias: 'revisor',
    label: 'Aprueba borradores y responde dudas; no configura',
    permissions: [
      'accounts:read', 'journal_entries:read', 'journal_entries:post',
      'invoices:read', 'bills:read', 'bills:approve', 'reports:read',
    ],
  },
  auditor: {
    alias: 'auditor',
    label: 'Sólo lectura, incluida la bitácora',
    permissions: [
      'accounts:read', 'journal_entries:read', 'invoices:read',
      'bills:read', 'payroll:read', 'reports:read', 'audit:read',
    ],
  },
  viewer: {
    alias: 'lector',
    label: 'Sólo lectura de la operación',
    permissions: [
      'accounts:read', 'journal_entries:read', 'invoices:read',
      'bills:read', 'reports:read',
    ],
  },
});

/** Los permisos efectivos de un rol, o [] si el rol no existe. */
export function permissionsOf(role: string): readonly string[] {
  return ROLES[role as RoleName]?.permissions ?? [];
}

/** ¿El usuario puede hacer esto? El comodín autoriza verbos, nunca filas. */
export function hasPermission(granted: readonly string[], needed: string): boolean {
  return granted.includes(COMODIN) || granted.includes(needed);
}
