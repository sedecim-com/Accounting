import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import type { Scope } from '../../database/scope.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { encrypt } from '../../utils/encryption.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { BANK_ACCOUNT_TYPES } from '../../database/enums.js';

// ============================================================
// LA CUENTA BANCARIA COMO DATO MAESTRO (F05a)
//
// La tabla lleva desde la 003 sin nadie que la escriba: ni ruta, ni servicio,
// ni validación. Lo único que la tocaba era la siembra. Eso significa que los
// tres datos que hacen que una cuenta bancaria SIRVA —el identificador, la
// moneda y la cuenta de mayor— entraban sin que nadie los mirara, y los tres
// fallan callados:
//
//   · UNA CLABE MAL TECLEADA no revienta al guardarse: revienta el día que se
//     dispersa un pago. El dígito verificador existe justamente para que un
//     transpuesto se detecte en el alta y no en la transferencia, y calcularlo
//     cuesta diecisiete multiplicaciones.
//   · UNA MONEDA DISTINTA A LA DEL MAYOR convierte el saldo de libros en una
//     suma de dos unidades. La conciliación sigue corriendo, sigue dando un
//     número, y ese número no significa nada. Por eso aquí se rechaza en voz
//     alta en vez de anotarse como advertencia.
//   · DOS CUENTAS SOBRE LA MISMA CUENTA DE MAYOR hacen que cada una vea los
//     movimientos contables de la otra. La 051 puso el índice único que faltaba
//     (`uq_bank_accounts_gl`); lo que este servicio añade es que la violación se
//     lea como una frase que NOMBRA a la otra cuenta, en vez de como un 23505.
//
// LO QUE NO SALE DE AQUÍ. No hay ningún camino en este archivo que devuelva un
// identificador completo. La proyección es explícita —nunca `SELECT *`— y las
// columnas `*_encrypted` no aparecen en ella: no es una regla que haya que
// recordar en cada superficie nueva, es una que no se puede saltar desde
// fuera. Lo mismo vale para la bitácora: el antes y el después de una CLABE se
// registran ENMASCARADOS, porque audit_log es append-only (033) y un secreto
// que entra ahí ya no se puede sacar.
//
// LO QUE EL CATÁLOGO PIDE Y AQUÍ NO ESTÁ: `show` promete «firmantes» y
// «límites». No hay columnas ni tablas para ninguno de los dos —`bank signer`
// y `bank limit` son fase 3—, así que se omiten de la salida en vez de
// inventarles una forma vacía que luego habría que migrar.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ponderación 3,7,1 cíclica. Es LA MISMA para el dígito verificador de la
 * CLABE y para el checksum del routing ABA, que no es casualidad: los dos son
 * códigos de detección de transposición diseñados para dígitos leídos por un
 * humano al teléfono.
 */
const PESOS = [3, 7, 1] as const;

/**
 * El vocabulario vive en el censo de src/database/enums.ts, que es lo que la
 * prueba de contrato compara contra el CHECK de la 051. Aquí sólo se le pone
 * el nombre con el que lo lee esta familia: una segunda lista escrita a mano
 * es exactamente la divergencia que ese censo existe para impedir.
 */
export const TIPOS_DE_CUENTA = BANK_ACCOUNT_TYPES;
export type TipoDeCuenta = (typeof TIPOS_DE_CUENTA)[number];

// ---------------------------------------------------------------
// LOS DOS CHECKSUM — funciones puras, sin base de datos
// ---------------------------------------------------------------

/**
 * El dígito 18 de una CLABE a partir de los 17 primeros (3 de banco, 3 de
 * plaza, 11 de cuenta).
 *
 * El `mod 10` de adentro —sobre cada producto, antes de sumar— es el que hace
 * el trabajo: sin él, cambiar un 8 por un 1 en una posición de peso 7 movería
 * la suma en 49 y la aritmética final lo perdonaría en algunos casos. Con él,
 * cada dígito aporta exactamente un residuo y la transposición se ve.
 */
export function digitoVerificadorClabe(primeros17: string): number {
  if (!/^\d{17}$/.test(primeros17)) {
    throw new ValidationError(
      `El dígito verificador se calcula sobre los 17 primeros dígitos de la CLABE; llegaron ${primeros17.length} caracteres.`,
      'clabe'
    );
  }
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    suma += (Number(primeros17[i]) * PESOS[i % PESOS.length]) % 10;
  }
  // El `% 10` de afuera es el que convierte una suma múltiplo de diez en un
  // verificador 0 y no en un 10, que no cabe en un dígito.
  return (10 - (suma % 10)) % 10;
}

/** Verdadero si son 18 dígitos y el último es el que los otros 17 exigen. */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  return digitoVerificadorClabe(clabe.slice(0, 17)) === Number(clabe[17]);
}

/**
 * Checksum del routing ABA: nueve dígitos, la misma ponderación 3,7,1, y la
 * suma —aquí SIN residuo por término, que es como lo define la ABA— múltiplo
 * de diez.
 *
 * Cuidado con lo que este `true` significa: `000000000` lo cumple. El checksum
 * prueba que los dígitos son consistentes entre sí, NO que exista un banco
 * detrás. Esa segunda pregunta la contesta `exigirRoutingAba`.
 */
export function routingAbaValido(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    suma += Number(routing[i]) * PESOS[i % PESOS.length];
  }
  return suma % 10 === 0;
}

/** Los separadores con que un humano copia un identificador de un estado de cuenta. */
function sinSeparadores(valor: string): string {
  return valor.replace(/[\s-]/g, '');
}

/**
 * La CLABE normalizada y su clave de banco, o una excepción que dice cuál de
 * las tres cosas falló. Pura: es la que prueban las unitarias.
 */
export function exigirClabe(valor: string): { clabe: string; bancoSat: string } {
  const clabe = sinSeparadores(valor);
  if (!/^\d{18}$/.test(clabe)) {
    throw new ValidationError(
      `La CLABE son 18 dígitos (3 de banco, 3 de plaza, 11 de cuenta y 1 verificador); "${valor}" tiene ${clabe.length}.`,
      'clabe'
    );
  }
  if (!clabeValida(clabe)) {
    throw new ValidationError(
      `La CLABE terminada en ${clabe.slice(-4)} no pasa su dígito verificador: ` +
        `los 17 primeros exigen ${digitoVerificadorClabe(clabe.slice(0, 17))} y trae ${clabe[17]}. ` +
        'Casi siempre son dos dígitos transpuestos al copiarla.',
      'clabe'
    );
  }
  const bancoSat = clabe.slice(0, 3);
  if (bancoSat === '000') {
    throw new ValidationError(
      'La CLABE empieza con 000, que no es clave de ninguna institución del catálogo de Banxico ni del c_Banco del SAT.',
      'clabe'
    );
  }
  return { clabe, bancoSat };
}

/**
 * El routing normalizado, o la razón por la que no lo es.
 *
 * NO se comprueba el prefijo de distrito de la Reserva Federal (00–12, 21–32,
 * 61–72, 80). Es una regla real y sería una validación más, pero equivocar sus
 * rangos rechaza altas legítimas, y un rango mal recordado es peor que una
 * validación ausente: ver el informe de F05a.
 */
export function exigirRoutingAba(valor: string, campo = 'routing'): string {
  const routing = sinSeparadores(valor);
  if (!/^\d{9}$/.test(routing)) {
    throw new ValidationError(
      `El routing ABA son 9 dígitos; "${valor}" tiene ${routing.length}.`,
      campo
    );
  }
  if (!routingAbaValido(routing)) {
    throw new ValidationError(
      `El routing ${routing} no pasa su checksum ABA (ponderación 3,7,1 múltiplo de 10).`,
      campo
    );
  }
  if (/^0{9}$/.test(routing)) {
    // Pasa el checksum y no es de nadie: la suma de nueve ceros es cero.
    throw new ValidationError(
      'El routing 000000000 cumple el checksum por aritmética y no corresponde a ninguna institución.',
      campo
    );
  }
  return routing;
}

// ---------------------------------------------------------------
// LA FRONTERA
// ---------------------------------------------------------------

/**
 * El mismo predicado que produce `condicionDeAlcance` (scope.ts), CALIFICADO
 * con el alias de la tabla.
 *
 * Se escribe aquí y no se importa de allá por una razón concreta: las lecturas
 * de este módulo unen `bank_accounts` con `accounts` y con `legal_entities`, y
 * las tres tienen `entity_id`. Un `WHERE entity_id = $2` sin alias en esa
 * consulta no es una fuga: es un error de sintaxis de Postgres por ambigüedad.
 * La forma del predicado es idéntica —incluida la de alcance por inquilino—
 * para que el comportamiento no se bifurque.
 */
function alcanceDe(
  scope: Scope,
  alias: string,
  indice: number
): { sql: string; valor: string } {
  if (scope.kind === 'entity') {
    return { sql: `${alias}.entity_id = $${indice}`, valor: scope.entityId };
  }
  return {
    sql: `${alias}.entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $${indice})`,
    valor: scope.tenantId,
  };
}

/** Un alta o una edición necesitan saber en qué entidad ocurren. */
function entidadDe(scope: Scope, acto: string): string {
  if (scope.kind !== 'entity') {
    throw new ValidationError(
      `${acto} necesita una entidad concreta: un alcance de inquilino no dice en cuál de sus entidades vive la cuenta.`
    );
  }
  return scope.entityId;
}

async function ejecutar<T extends pg.QueryResultRow>(
  client: pg.PoolClient | undefined,
  sql: string,
  params: unknown[]
): Promise<{ rows: T[] }> {
  return client ? client.query<T>(sql, params) : query<T>(sql, params);
}

// ---------------------------------------------------------------
// LA PROYECCIÓN — lo único que sale de este módulo
// ---------------------------------------------------------------

interface FilaCuenta extends Record<string, unknown> {
  id: string;
  entity_id: string;
  account_name: string;
  bank_name: string;
  bank_branch: string | null;
  account_type: TipoDeCuenta;
  currency_code: string;
  sat_bank_code: string | null;
  swift_code: string | null;
  iban: string | null;
  clabe_last4: string | null;
  account_number_last4: string | null;
  routing_en_archivo: boolean;
  is_active: boolean;
  saldo_banco: string | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  gl_id: string | null;
  gl_code: string | null;
  gl_name: string | null;
  gl_tipo: string | null;
  gl_moneda: string | null;
  saldo_libro: string;
  ultima_conciliacion: string | null;
}

/**
 * Las columnas `*_encrypted` NO están aquí, y esa ausencia es el control: no
 * hay bandera que las traiga de vuelta, así que ninguna superficie futura
 * puede filtrarlas por descuido.
 *
 * `saldo_libro` sale del mayor y no de `bank_accounts.current_balance`, que es
 * lo que dijo el banco la última vez que se sincronizó. Los dos números
 * conviven a propósito: la conciliación ES su diferencia.
 */
const SELECCION = `
  SELECT b.id, b.entity_id, b.account_name, b.bank_name, b.bank_branch,
         b.account_type, b.currency_code, b.sat_bank_code, b.swift_code, b.iban,
         b.clabe_last4, b.account_number_last4,
         (b.routing_number_encrypted IS NOT NULL) AS routing_en_archivo,
         b.is_active, b.current_balance::text AS saldo_banco,
         b.last_synced_at, b.created_at, b.updated_at,
         a.id AS gl_id, a.code AS gl_code, a.name AS gl_name,
         a.account_type AS gl_tipo,
         COALESCE(a.currency_code, le.functional_currency) AS gl_moneda,
         libro.saldo::text AS saldo_libro,
         conc.ultima::text AS ultima_conciliacion
    FROM bank_accounts b
    JOIN legal_entities le ON le.id = b.entity_id
    -- LEFT y con la entidad en la condición: si un renglón heredado apunta al
    -- catálogo de OTRA entidad, la cuenta se sigue viendo (ocultarla sería
    -- peor) pero su mapeo no se muestra, y \`show\` lo denuncia como anomalía.
    LEFT JOIN accounts a ON a.id = b.gl_account_id AND a.entity_id = b.entity_id
    LEFT JOIN LATERAL (
      -- COALESCE por LADO, no sobre la resta. La 001 deja debit_amount y
      -- credit_amount mutuamente excluyentes por CHECK: una línea acreedora
      -- tiene el débito en NULL, y \`debit − credit\` sobre eso es NULL, que
      -- SUM ignora. Restar así devolvía cero para cualquier cuenta con
      -- movimientos, que es la peor forma de equivocarse: parece un saldo.
      SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0) AS saldo
        FROM journal_entry_lines l
        JOIN journal_entries j ON j.id = l.journal_entry_id
       WHERE l.account_id = b.gl_account_id
         AND j.entity_id = b.entity_id
         AND j.status = 'posted'
    ) libro ON true
    LEFT JOIN LATERAL (
      SELECT MAX(s.end_date) AS ultima
        FROM reconciliation_sessions s
       WHERE s.bank_account_id = b.id
         AND s.entity_id = b.entity_id
         AND s.status IN ('approved', 'posted')
    ) conc ON true
`;

export interface CuentaDeMayor {
  id: string;
  code: string;
  name: string;
}

export interface RenglonCuentaBancaria {
  id: string;
  entityId: string;
  accountName: string;
  bankName: string;
  accountType: TipoDeCuenta;
  /** `credit-card` es pasivo: su saldo de libros se lee con el signo contrario. */
  esPasivo: boolean;
  currencyCode: string;
  glAccount: CuentaDeMayor | null;
  /** Débitos − créditos de las pólizas CONTABILIZADAS sobre la cuenta de mayor. */
  saldoLibro: string;
  /** Lo que dijo el banco en la última sincronización. Nulo si nunca hubo una. */
  saldoBanco: string | null;
  /** Fin del periodo de la última conciliación aprobada, YYYY-MM-DD. */
  ultimaConciliacionAprobada: string | null;
  isActive: boolean;
}

export interface FichaCuentaBancaria extends RenglonCuentaBancaria {
  bankBranch: string | null;
  satBankCode: string | null;
  swiftCode: string | null;
  iban: string | null;
  /** `••••1234`, o nulo si no hay CLABE en archivo. Nunca el número completo. */
  clabe: string | null;
  /** `••••1234`. Nunca el número completo. */
  accountNumber: string | null;
  /**
   * Sólo si hay routing guardado. No se enmascara porque la 003 no le dio
   * columna `last4` a esta —sí a `account_number`—, y descifrar para mostrar
   * cuatro dígitos exige un camino auditado que todavía no existe.
   */
  routingEnArchivo: boolean;
  /** `saldoLibro − saldoBanco`. Nulo mientras el banco no haya dicho nada. */
  diferencia: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Invariantes de alta reevaluadas contra ESTE renglón. Una cuenta creada
   * antes de que existiera este servicio pudo entrar sin ninguna de ellas, y
   * la ficha es donde se ve.
   */
  advertencias: string[];
}

function dec(valor: string | null | undefined): Decimal {
  return new Decimal(valor ?? '0');
}

/** Pesos y centavos en todo lo que sale, igual que los cuadres de CxC y CxP. */
function pesos(d: Decimal): string {
  return d.toFixed(2);
}

function enmascarar(last4: string | null): string | null {
  return last4 ? `••••${last4}` : null;
}

function aRenglon(fila: FilaCuenta): RenglonCuentaBancaria {
  return {
    id: fila.id,
    entityId: fila.entity_id,
    accountName: fila.account_name,
    bankName: fila.bank_name,
    accountType: fila.account_type,
    esPasivo: fila.account_type === 'credit-card',
    currencyCode: fila.currency_code,
    glAccount:
      fila.gl_id && fila.gl_code
        ? { id: fila.gl_id, code: fila.gl_code, name: fila.gl_name ?? '' }
        : null,
    saldoLibro: pesos(dec(fila.saldo_libro)),
    saldoBanco: fila.saldo_banco === null ? null : pesos(dec(fila.saldo_banco)),
    ultimaConciliacionAprobada: fila.ultima_conciliacion,
    isActive: fila.is_active,
  };
}

function aFicha(fila: FilaCuenta): FichaCuentaBancaria {
  const advertencias: string[] = [];
  if (!fila.gl_id) {
    advertencias.push(
      'La cuenta de mayor mapeada no pertenece a esta entidad: el saldo de libros se lee como cero ' +
        'y la conciliación no tiene contra qué correr. Corrígelo con `bank account set`.'
    );
  } else {
    if (fila.gl_moneda && fila.gl_moneda !== fila.currency_code) {
      advertencias.push(
        `La cuenta está en ${fila.currency_code} y su cuenta de mayor ${fila.gl_code} en ` +
          `${fila.gl_moneda}: el saldo de libros mezcla dos monedas.`
      );
    }
    const esperado = fila.account_type === 'credit-card' ? 'liability' : 'asset';
    if (fila.gl_tipo && fila.gl_tipo !== esperado) {
      advertencias.push(
        `Una cuenta de tipo ${fila.account_type} debería mapear a una cuenta de mayor ` +
          `${esperado} y ${fila.gl_code} es ${fila.gl_tipo}.`
      );
    }
  }

  const saldoLibro = dec(fila.saldo_libro);
  return {
    ...aRenglon(fila),
    bankBranch: fila.bank_branch,
    satBankCode: fila.sat_bank_code,
    swiftCode: fila.swift_code,
    iban: fila.iban,
    clabe: enmascarar(fila.clabe_last4),
    accountNumber: enmascarar(fila.account_number_last4),
    routingEnArchivo: fila.routing_en_archivo,
    diferencia:
      fila.saldo_banco === null ? null : pesos(saldoLibro.minus(dec(fila.saldo_banco))),
    lastSyncedAt: fila.last_synced_at,
    createdAt: fila.created_at,
    updatedAt: fila.updated_at,
    advertencias,
  };
}

// ---------------------------------------------------------------
// RESOLUCIÓN — nadie trae un uuid en la mano
// ---------------------------------------------------------------

/** `id = $1` o `lower(account_name) = lower($1)`: nadie trae un uuid en la mano. */
function condicionDeRef(ref: string, alias: string): string {
  return UUID_RE.test(ref)
    ? `${alias}.id = $1`
    : `lower(${alias}.account_name) = lower($1)`;
}

/**
 * La fila bloqueada, en una sentencia que NO es la de la proyección.
 *
 * El candado va aparte porque la proyección une con `accounts`, con
 * `legal_entities` y con dos LATERAL agregados, y un `FOR UPDATE` sobre eso es
 * discutir con el planeador para nada. Lo que importa del candado —que la
 * pertenencia se pruebe y la fila se bloquee en la MISMA sentencia, sin
 * ventana entre comprobar y escribir— se cumple igual aquí, y la proyección
 * posterior corre dentro de la misma transacción sobre una fila ya bloqueada.
 */
async function bloquear(client: pg.PoolClient, scope: Scope, ref: string): Promise<string> {
  const alcance = alcanceDe(scope, 'bank_accounts', 2);
  const r = await client.query<{ id: string }>(
    `SELECT id FROM bank_accounts
      WHERE ${condicionDeRef(ref, 'bank_accounts')} AND ${alcance.sql}
      FOR UPDATE`,
    [ref, alcance.valor]
  );
  return exigirUna(r.rows, ref).id;
}

function exigirUna<T>(filas: T[], ref: string): T {
  if (filas.length === 0) {
    // «No existe» y «no es tuya» son indistinguibles a propósito (scope.ts).
    throw new NotFoundError('Bank account', ref);
  }
  if (filas.length > 1) {
    throw new ConflictError(
      `"${ref}" nombra a ${filas.length} cuentas bancarias dentro de este alcance. ` +
        'Acota a una entidad o usa el identificador.'
    );
  }
  return filas[0];
}

async function filaPorRef(
  scope: Scope,
  ref: string,
  opts: { client?: pg.PoolClient; forUpdate?: boolean } = {}
): Promise<FilaCuenta> {
  let texto = ref.trim();
  if (opts.forUpdate && opts.client) {
    // Bloquear primero convierte además un nombre ambiguo en un id, así que la
    // proyección de abajo ya no puede resolver a otra fila.
    texto = await bloquear(opts.client, scope, texto);
  }
  const alcance = alcanceDe(scope, 'b', 2);
  const r = await ejecutar<FilaCuenta>(
    opts.client,
    `${SELECCION} WHERE ${condicionDeRef(texto, 'b')} AND ${alcance.sql}`,
    [texto, alcance.valor]
  );
  return exigirUna(r.rows, texto);
}

// ---------------------------------------------------------------
// LA CUENTA DE MAYOR — las tres preguntas del mapeo
// ---------------------------------------------------------------

interface MayorValidado extends CuentaDeMayor {
  moneda: string;
}

/**
 * Resuelve la cuenta de mayor DENTRO de la entidad y comprueba las tres cosas
 * que hacen que el mapeo signifique algo. Las tres rechazan; ninguna advierte.
 */
async function exigirCuentaDeMayor(
  client: pg.PoolClient,
  entityId: string,
  ref: string,
  tipo: TipoDeCuenta,
  moneda: string
): Promise<MayorValidado> {
  const texto = ref.trim();
  const r = await client.query<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    is_active: boolean;
    is_header: boolean;
    allow_manual_entries: boolean;
    moneda: string;
  }>(
    `SELECT a.id, a.code, a.name, a.account_type, a.is_active, a.is_header,
            a.allow_manual_entries,
            COALESCE(a.currency_code, le.functional_currency) AS moneda
       FROM accounts a
       JOIN legal_entities le ON le.id = a.entity_id
      WHERE ${UUID_RE.test(texto) ? 'a.id = $1' : 'a.code = $1'}
        AND a.entity_id = $2`,
    [texto, entityId]
  );
  const cuenta = r.rows[0];
  if (!cuenta) throw new NotFoundError('Account', texto);

  if (!cuenta.is_active) {
    throw new ValidationError(
      `La cuenta de mayor ${cuenta.code} está inactiva: una cuenta bancaria mapeada a ella no podría contabilizar nada.`,
      'gl_account'
    );
  }
  if (cuenta.is_header || !cuenta.allow_manual_entries) {
    throw new ValidationError(
      `${cuenta.code} ${cuenta.is_header ? 'es una cuenta de agrupación' : 'no admite pólizas'}: ` +
        'el mapeo bancario tiene que apuntar a una cuenta de movimiento.',
      'gl_account'
    );
  }

  // El signo. La 051 lo dice en el comentario de `account_type`: una tarjeta de
  // crédito es un PASIVO. Mapearla a un activo deja el saldo invertido en todo
  // informe que la lea, sin que nada se queje.
  const esperado = tipo === 'credit-card' ? 'liability' : 'asset';
  if (cuenta.account_type !== esperado) {
    throw new ValidationError(
      `Una cuenta de tipo ${tipo} es ${esperado === 'liability' ? 'un PASIVO' : 'un ACTIVO'} ` +
        `y ${cuenta.code} está clasificada como ${cuenta.account_type}. ` +
        'Con el tipo cruzado, el saldo se presenta con el signo invertido.',
      'gl_account'
    );
  }

  // La moneda. `accounts.currency_code` es nulable y un nulo significa «la
  // funcional de la entidad», que es lo que hace el COALESCE de arriba: si no
  // se resolviera así, toda cuenta de un catálogo sin monedas explícitas
  // pasaría esta puerta sin que nadie la mirara.
  if (cuenta.moneda !== moneda) {
    throw new ValidationError(
      `La cuenta bancaria está en ${moneda} y la cuenta de mayor ${cuenta.code} en ${cuenta.moneda}. ` +
        'Un saldo de libros que suma dos monedas no se puede conciliar contra ningún extracto: ' +
        'usa una cuenta de mayor en ' + moneda + ', o da de alta la cuenta bancaria en ' + cuenta.moneda + '.',
      'currency_code'
    );
  }

  return { id: cuenta.id, code: cuenta.code, name: cuenta.name, moneda: cuenta.moneda };
}

/**
 * El nombre es la manija: `bank account show <account>` resuelve por él, y dos
 * cuentas homónimas en la misma entidad dejan a las dos inalcanzables salvo
 * por identificador.
 *
 * La tabla no lo restringe —no hay UNIQUE(entity_id, account_name) y añadirlo
 * es una migración, no este archivo—, así que la guarda es de aplicación y
 * tiene la ventana que eso implica. Vale la pena igual: cierra el caso que
 * ocurre (dos altas parecidas con semanas de diferencia) y no el que no
 * (dos altas simultáneas del mismo nombre).
 */
async function exigirNombreLibre(
  client: pg.PoolClient,
  entityId: string,
  nombre: string,
  exceptoId: string | null
): Promise<void> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM bank_accounts
      WHERE lower(account_name) = lower($1) AND entity_id = $2 AND ($3::uuid IS NULL OR id <> $3)`,
    [nombre, entityId, exceptoId]
  );
  if (r.rows.length > 0) {
    throw new ConflictError(
      `Esta entidad ya tiene una cuenta bancaria llamada "${nombre}" (${r.rows[0].id}). ` +
        'El nombre es con lo que se la nombra en la terminal: repetirlo deja a las dos sin manija.'
    );
  }
}

/**
 * Traduce la violación de `uq_bank_accounts_gl` a una frase que nombra a la
 * OTRA cuenta. Un 23505 crudo dice que hay un duplicado y no dice de qué, que
 * es la mitad inútil de la información.
 */
async function conflictoDeMapeo(
  client: pg.PoolClient,
  entityId: string,
  mayor: CuentaDeMayor
): Promise<ConflictError> {
  const otra = await client.query<{ account_name: string; id: string }>(
    'SELECT id, account_name FROM bank_accounts WHERE gl_account_id = $1 AND entity_id = $2',
    [mayor.id, entityId]
  );
  const fila = otra.rows[0];
  return new ConflictError(
    fila
      ? `La cuenta de mayor ${mayor.code} ya está tomada por la cuenta bancaria "${fila.account_name}" (${fila.id}). ` +
        'El mapeo es 1:1: dos cuentas bancarias sobre el mismo mayor comparten saldo de libros y cada conciliación ve los movimientos de la otra.'
      : `La cuenta de mayor ${mayor.code} ya está tomada por una cuenta bancaria que este alcance no alcanza a ver. ` +
        'El mapeo es 1:1.'
  );
}

function esViolacionDeMapeo(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  // Postgres reporta el nombre del ÍNDICE en `constraint` para un índice único,
  // pero el mensaje se mira también: un driver que no propague el campo no
  // debe convertir esta traducción en un error crudo.
  return e.constraint === 'uq_bank_accounts_gl' || /uq_bank_accounts_gl/.test(e.message ?? '');
}

// ---------------------------------------------------------------
// MOVIMIENTOS CONTABILIZADOS — la guarda de `set`
// ---------------------------------------------------------------

async function movimientosPosteados(
  client: pg.PoolClient,
  entityId: string,
  accountId: string
): Promise<{ lineas: number; saldo: string }> {
  const r = await client.query<{ lineas: string; saldo: string }>(
    // Mismo COALESCE por lado que la proyección, y por la misma razón: la
    // mitad no usada de cada línea es NULL, no cero.
    `SELECT COUNT(*)::text AS lineas,
            COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS saldo
       FROM journal_entry_lines l
       JOIN journal_entries j ON j.id = l.journal_entry_id
      WHERE l.account_id = $1 AND j.entity_id = $2 AND j.status = 'posted'`,
    [accountId, entityId]
  );
  return { lineas: parseInt(r.rows[0].lineas, 10), saldo: r.rows[0].saldo };
}

// ---------------------------------------------------------------
// LECTURAS
// ---------------------------------------------------------------

export interface FiltroCuentas {
  /** Casa contra el nombre de la cuenta o el del banco. */
  search?: string;
  accountType?: TipoDeCuenta;
  currencyCode?: string;
  /** Sin valor: activas y archivadas juntas. */
  isActive?: boolean;
  limit?: number;
}

export async function listBankAccounts(
  scope: Scope,
  filtros: FiltroCuentas = {}
): Promise<RenglonCuentaBancaria[]> {
  const alcance = alcanceDe(scope, 'b', 1);
  const where: string[] = [alcance.sql];
  const params: unknown[] = [alcance.valor];
  let i = 2;

  if (filtros.search) {
    where.push(`(b.account_name ILIKE $${i} OR b.bank_name ILIKE $${i})`);
    params.push(`%${filtros.search}%`);
    i++;
  }
  if (filtros.accountType) {
    where.push(`b.account_type = $${i++}`);
    params.push(exigirTipo(filtros.accountType));
  }
  if (filtros.currencyCode) {
    where.push(`b.currency_code = $${i++}`);
    params.push(exigirMoneda(filtros.currencyCode));
  }
  if (filtros.isActive !== undefined) {
    where.push(`b.is_active = $${i++}`);
    params.push(filtros.isActive);
  }

  let sql = `${SELECCION} WHERE ${where.join(' AND ')} ORDER BY b.account_name ASC`;
  if (filtros.limit !== undefined) {
    sql += ` LIMIT $${i++}`;
    params.push(filtros.limit);
  }

  const r = await query<FilaCuenta>(sql, params);
  return r.rows.map(aRenglon);
}

/** La ficha por identificador o por nombre exacto. */
export async function getBankAccount(scope: Scope, ref: string): Promise<FichaCuentaBancaria> {
  return aFicha(await filaPorRef(scope, ref));
}

// ---------------------------------------------------------------
// ALTA
// ---------------------------------------------------------------

export interface EntradaCuentaBancaria {
  accountName: string;
  bankName: string;
  /** Código (1110) o identificador de la cuenta de mayor. */
  glAccount: string;
  currencyCode: string;
  accountType?: TipoDeCuenta;
  clabe?: string | null;
  accountNumber?: string | null;
  routingAch?: string | null;
  routingWire?: string | null;
  /** c_Banco del SAT. Si hay CLABE y no se da, sale de sus tres primeros dígitos. */
  satBankCode?: string | null;
  bankBranch?: string | null;
  swiftCode?: string | null;
  iban?: string | null;
}

export interface ContextoEscritura {
  userId: string;
  reason?: string | null;
  /** Corre las validaciones y la escritura de verdad, y las deshace. */
  dryRun?: boolean;
}

export interface ResultadoAlta {
  cuenta: FichaCuentaBancaria;
  /** Todo lo anterior ocurrió y se revirtió. */
  dryRun: boolean;
  advertencias: string[];
}

/** Centinela: la única forma de salir de una transacción con el trabajo hecho y deshecho. */
class DryRunRollback<T> extends Error {
  constructor(readonly payload: T) {
    super('dry run');
    this.name = 'DryRunRollback';
  }
}

function exigirTipo(valor: string): TipoDeCuenta {
  const tipo = valor.trim().toLowerCase() as TipoDeCuenta;
  if (!TIPOS_DE_CUENTA.includes(tipo)) {
    throw new ValidationError(
      `"${valor}" no es un tipo de cuenta. Los cinco son: ${TIPOS_DE_CUENTA.join(', ')}.`,
      'account_type'
    );
  }
  return tipo;
}

function exigirMoneda(valor: string): string {
  const codigo = valor.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(codigo)) {
    throw new ValidationError(
      `"${valor}" no es un código ISO de moneda de tres letras.`,
      'currency_code'
    );
  }
  return codigo;
}

function exigirClaveSat(valor: string): string {
  const clave = valor.trim();
  if (!/^\d{3}$/.test(clave)) {
    throw new ValidationError(
      `La clave de banco del SAT (c_Banco) son 3 dígitos; llegó "${valor}".`,
      'sat_bank_code'
    );
  }
  return clave;
}

function exigirTexto(valor: string, campo: string, etiqueta: string): string {
  const texto = valor?.trim() ?? '';
  if (texto.length === 0) {
    throw new ValidationError(`${etiqueta} no puede ir vacío.`, campo);
  }
  return texto;
}

function exigirSwift(valor: string): string {
  const codigo = valor.trim().toUpperCase();
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(codigo)) {
    throw new ValidationError(
      `"${valor}" no tiene forma de código SWIFT/BIC (8 u 11 caracteres: 4 de banco, 2 de país, 2 de plaza y 3 opcionales de sucursal).`,
      'swift_code'
    );
  }
  return codigo;
}

function exigirIban(valor: string): string {
  const codigo = sinSeparadores(valor).toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(codigo)) {
    throw new ValidationError(
      `"${valor}" no tiene forma de IBAN (2 letras de país, 2 dígitos de control y hasta 30 alfanuméricos).`,
      'iban'
    );
  }
  return codigo;
}

/** Los cuatro últimos, que es lo único que este sistema muestra de un identificador. */
function ultimos4(valor: string): string {
  return valor.slice(-4);
}

/**
 * Los dos routing del catálogo contra la única columna que existe.
 *
 * `--routing-ach` y `--routing-wire` son flags distintos porque en un banco
 * estadounidense suelen ser números distintos, y la 003 dejó una sola
 * `routing_number_encrypted`. Guardar uno y tirar el otro en silencio sería
 * perder un dato que el usuario escribió, así que si vienen dos y no coinciden
 * se rechaza y se dice por qué.
 */
function resolverRouting(entrada: {
  routingAch?: string | null;
  routingWire?: string | null;
}): string | null {
  const ach = entrada.routingAch ? exigirRoutingAba(entrada.routingAch, 'routing_ach') : null;
  const wire = entrada.routingWire ? exigirRoutingAba(entrada.routingWire, 'routing_wire') : null;
  if (ach && wire && ach !== wire) {
    throw new ValidationError(
      'El routing ACH y el de transferencia son distintos y la tabla sólo tiene una columna para los dos ' +
        '(`routing_number_encrypted`, migración 003): guardar uno perdería el otro sin avisar. ' +
        'Da de alta la cuenta con uno y abre la falta de columna como trabajo de F05b.',
      'routing_wire'
    );
  }
  return ach ?? wire;
}

export async function createBankAccount(
  scope: Scope,
  entrada: EntradaCuentaBancaria,
  ctx: ContextoEscritura
): Promise<ResultadoAlta> {
  const entityId = entidadDe(scope, 'Dar de alta una cuenta bancaria');
  const dryRun = ctx.dryRun === true;

  const accountName = exigirTexto(entrada.accountName, 'account_name', 'El nombre de la cuenta');
  const bankName = exigirTexto(entrada.bankName, 'bank_name', 'El nombre del banco');
  const tipo = entrada.accountType ? exigirTipo(entrada.accountType) : 'checking';
  const moneda = exigirMoneda(entrada.currencyCode);
  const branch = entrada.bankBranch?.trim() || null;
  const swift = entrada.swiftCode ? exigirSwift(entrada.swiftCode) : null;
  const iban = entrada.iban ? exigirIban(entrada.iban) : null;
  const routing = resolverRouting(entrada);
  const numero = entrada.accountNumber?.trim() || null;

  const advertencias: string[] = [];
  const clabe = entrada.clabe ? exigirClabe(entrada.clabe) : null;

  // La clave de banco del SAT y los tres primeros de la CLABE son el MISMO
  // catálogo de Banxico. Si el usuario da las dos y no coinciden, una de las
  // dos está mal y el Anexo 24 exige la correcta dentro de la póliza.
  let claveSat = entrada.satBankCode ? exigirClaveSat(entrada.satBankCode) : null;
  if (clabe && claveSat && claveSat !== clabe.bancoSat) {
    throw new ValidationError(
      `La clave de banco declarada (${claveSat}) no es la que trae la CLABE (${clabe.bancoSat}). ` +
        'Son el mismo catálogo: una de las dos está mal.',
      'sat_bank_code'
    );
  }
  if (!claveSat && clabe) claveSat = clabe.bancoSat;
  if (!claveSat) {
    advertencias.push(
      'La cuenta queda sin clave de banco del SAT: el Anexo 24 la exige dentro de la póliza ' +
        'para la cuenta origen y destino de un pago.'
    );
  }

  const id = uuidv4();
  try {
    const payload = await withTransaction(async (client) => {
      const mayor = await exigirCuentaDeMayor(client, entityId, entrada.glAccount, tipo, moneda);
      await exigirNombreLibre(client, entityId, accountName, null);

      try {
        await client.query(
          `INSERT INTO bank_accounts (
             id, entity_id, account_name, bank_name, bank_branch, account_type,
             swift_code, iban, clabe_encrypted, clabe_last4, sat_bank_code,
             account_number_encrypted, account_number_last4, routing_number_encrypted,
             gl_account_id, currency_code
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            id, entityId, accountName, bankName, branch, tipo,
            swift, iban,
            clabe ? encrypt(clabe.clabe) : null,
            clabe ? ultimos4(clabe.clabe) : null,
            claveSat,
            numero ? encrypt(numero) : null,
            numero ? ultimos4(numero) : null,
            routing ? encrypt(routing) : null,
            mayor.id, moneda,
          ]
        );
      } catch (err) {
        if (esViolacionDeMapeo(err)) throw await conflictoDeMapeo(client, entityId, mayor);
        throw err;
      }

      // La bitácora lleva los ENMASCARADOS. audit_log es append-only (033): un
      // identificador que entra ahí ya no sale, y el criterio E0.3 vigila que
      // lo que la tabla cifra no viaje en claro al rastro.
      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, entityId),
        userId: ctx.userId,
        action: 'create',
        entityType: 'bank_accounts',
        entityId: id,
        newValues: {
          account_name: accountName,
          bank_name: bankName,
          account_type: tipo,
          currency_code: moneda,
          gl_account: mayor.code,
          sat_bank_code: claveSat,
          clabe: enmascarar(clabe ? ultimos4(clabe.clabe) : null),
          account_number: enmascarar(numero ? ultimos4(numero) : null),
          routing_number: routing ? 'en-archivo' : null,
        },
        reason: ctx.reason ?? null,
      });

      const cuenta = aFicha(await filaPorRef(scope, id, { client }));
      const out: ResultadoAlta = { cuenta, dryRun: false, advertencias };
      // Todo lo de arriba ocurrió de verdad; lanzar es lo que lo deshace. Una
      // vista previa que no pasa por el índice único no prueba la unicidad.
      if (dryRun) throw new DryRunRollback(out);
      return out;
    });
    return payload;
  } catch (err) {
    if (err instanceof DryRunRollback) {
      return { ...(err.payload as ResultadoAlta), dryRun: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// EDICIÓN — campo por campo, con el antes y el después
// ---------------------------------------------------------------

/**
 * Lo que `edit` puede mover.
 *
 * Dos ausencias deliberadas:
 *   · `is_active`. Retirar una cuenta es `bank account archive`, que tiene sus
 *     propias guardas (movimientos sin cotejar, sesiones abiertas, cheques en
 *     circulación). Dejarlo aquí sería la puerta trasera que las rodea.
 *   · `gl_account_id`. Es `bank account set`, y su guarda —la historia
 *     contabilizada— no cabe en un patch genérico.
 */
export interface ParcheCuenta {
  accountName?: string;
  bankName?: string;
  bankBranch?: string | null;
  swiftCode?: string | null;
  iban?: string | null;
  satBankCode?: string | null;
  accountType?: TipoDeCuenta;
  currencyCode?: string;
  /** Sensible: exige `reason`. */
  clabe?: string | null;
  /** Sensible: exige `reason`. */
  accountNumber?: string | null;
  /** Sensible: exige `reason`. */
  routingAch?: string | null;
  /** Sensible: exige `reason`. */
  routingWire?: string | null;
}

export interface CambioDeCampo {
  campo: string;
  antes: unknown;
  despues: unknown;
}

export interface ResultadoEdicion {
  cuenta: FichaCuentaBancaria;
  cambios: CambioDeCampo[];
  dryRun: boolean;
  advertencias: string[];
}

/**
 * Los tres identificadores que el catálogo marca como irreversibles: exigen
 * motivo y, cuando exista dónde registrarla, una segunda firma. Se exporta
 * para que la CLI sepa qué flags disparan esa exigencia sin volver a
 * enumerarlos —dos listas separadas se desincronizan en la primera prisa—.
 */
export const CAMPOS_SENSIBLES = ['clabe', 'account_number', 'routing_number'] as const;

export async function updateBankAccount(
  scope: Scope,
  ref: string,
  patch: ParcheCuenta,
  ctx: ContextoEscritura
): Promise<ResultadoEdicion> {
  const entityId = entidadDe(scope, 'Editar una cuenta bancaria');
  const dryRun = ctx.dryRun === true;

  try {
    const payload = await withTransaction(async (client) => {
      // Los acumuladores viven DENTRO de la transacción. Hoy `withTransaction`
      // corre el cuerpo una sola vez, pero si algún día reintentara, unos
      // `sets` de fuera traerían los del intento anterior y el UPDATE llevaría
      // cada campo dos veces.
      const advertencias: string[] = [];
      const sets: string[] = [];
      const params: unknown[] = [];
      const cambios: CambioDeCampo[] = [];
      const antes: Record<string, unknown> = {};
      const despues: Record<string, unknown> = {};
      let i = 1;

      const anota = (campo: string, valorAnterior: unknown, valorNuevo: unknown): void => {
        cambios.push({ campo, antes: valorAnterior, despues: valorNuevo });
        antes[campo] = valorAnterior;
        despues[campo] = valorNuevo;
      };

      const previa = await filaPorRef(scope, ref, { client, forUpdate: true });

      if (patch.accountName !== undefined) {
        const v = exigirTexto(patch.accountName, 'account_name', 'El nombre de la cuenta');
        await exigirNombreLibre(client, entityId, v, previa.id);
        sets.push(`account_name = $${i++}`);
        params.push(v);
        anota('account_name', previa.account_name, v);
      }
      if (patch.bankName !== undefined) {
        const v = exigirTexto(patch.bankName, 'bank_name', 'El nombre del banco');
        sets.push(`bank_name = $${i++}`);
        params.push(v);
        anota('bank_name', previa.bank_name, v);
      }
      if (patch.bankBranch !== undefined) {
        const v = patch.bankBranch?.trim() || null;
        sets.push(`bank_branch = $${i++}`);
        params.push(v);
        anota('bank_branch', previa.bank_branch, v);
      }
      if (patch.swiftCode !== undefined) {
        const v = patch.swiftCode ? exigirSwift(patch.swiftCode) : null;
        sets.push(`swift_code = $${i++}`);
        params.push(v);
        anota('swift_code', previa.swift_code, v);
      }
      if (patch.iban !== undefined) {
        const v = patch.iban ? exigirIban(patch.iban) : null;
        sets.push(`iban = $${i++}`);
        params.push(v);
        anota('iban', previa.iban, v);
      }
      if (patch.satBankCode !== undefined) {
        const v = patch.satBankCode ? exigirClaveSat(patch.satBankCode) : null;
        sets.push(`sat_bank_code = $${i++}`);
        params.push(v);
        anota('sat_bank_code', previa.sat_bank_code, v);
      }

      // El tipo y la moneda vuelven a pasar por la puerta del mapeo: las dos
      // invariantes que valida el alta son sobre la PAREJA (cuenta bancaria,
      // cuenta de mayor), así que mover un lado obliga a revalidar la pareja.
      const tipo = patch.accountType ? exigirTipo(patch.accountType) : previa.account_type;
      const moneda = patch.currencyCode ? exigirMoneda(patch.currencyCode) : previa.currency_code;
      if (patch.accountType !== undefined || patch.currencyCode !== undefined) {
        if (!previa.gl_id) {
          throw new ValidationError(
            'La cuenta apunta a un mayor fuera de esta entidad: arregla el mapeo con `bank account set` antes de mover tipo o moneda.',
            'gl_account'
          );
        }
        await exigirCuentaDeMayor(client, entityId, previa.gl_id, tipo, moneda);
        if (patch.accountType !== undefined && tipo !== previa.account_type) {
          sets.push(`account_type = $${i++}`);
          params.push(tipo);
          anota('account_type', previa.account_type, tipo);
        }
        if (patch.currencyCode !== undefined && moneda !== previa.currency_code) {
          sets.push(`currency_code = $${i++}`);
          params.push(moneda);
          anota('currency_code', previa.currency_code, moneda);
        }
      }

      // ── Los tres identificadores ──────────────────────────────────
      const tocaSensible =
        patch.clabe !== undefined ||
        patch.accountNumber !== undefined ||
        patch.routingAch !== undefined ||
        patch.routingWire !== undefined;

      if (tocaSensible) {
        if (!ctx.reason || ctx.reason.trim().length === 0) {
          throw new ValidationError(
            `Cambiar ${CAMPOS_SENSIBLES.join(', ')} exige un motivo: es el dato con el que sale el dinero, ` +
              'y un cambio sin motivo en la bitácora es indistinguible de un desvío.',
            'reason'
          );
        }
        // Dicho en voz alta porque no se puede cumplir: el catálogo pide una
        // segunda aprobación de otro usuario y no hay tabla donde vivan las
        // aprobaciones pendientes de una cuenta bancaria (ver informe F05a).
        advertencias.push(
          'Cambio de identificador aplicado con UNA sola firma. El catálogo exige una segunda aprobación ' +
            'de otro usuario y no existe todavía la tabla que la sostenga; queda el motivo y el actor en la bitácora.'
        );
      }

      if (patch.clabe !== undefined) {
        const nueva = patch.clabe ? exigirClabe(patch.clabe) : null;
        const claveSat =
          patch.satBankCode !== undefined
            ? (patch.satBankCode ? exigirClaveSat(patch.satBankCode) : null)
            : previa.sat_bank_code;
        if (nueva && claveSat && claveSat !== nueva.bancoSat) {
          throw new ValidationError(
            `La CLABE nueva es del banco ${nueva.bancoSat} y la cuenta queda con la clave SAT ${claveSat}. ` +
              'Cambiar de banco es dar de alta otra cuenta, no editar ésta.',
            'clabe'
          );
        }
        sets.push(`clabe_encrypted = $${i++}`, `clabe_last4 = $${i++}`);
        params.push(nueva ? encrypt(nueva.clabe) : null, nueva ? ultimos4(nueva.clabe) : null);
        // Enmascarado en los dos lados: el rastro dice QUE cambió, no A QUÉ.
        anota('clabe', enmascarar(previa.clabe_last4), enmascarar(nueva ? ultimos4(nueva.clabe) : null));
      }
      if (patch.accountNumber !== undefined) {
        const v = patch.accountNumber?.trim() || null;
        sets.push(`account_number_encrypted = $${i++}`, `account_number_last4 = $${i++}`);
        params.push(v ? encrypt(v) : null, v ? ultimos4(v) : null);
        anota('account_number', enmascarar(previa.account_number_last4), enmascarar(v ? ultimos4(v) : null));
      }
      if (patch.routingAch !== undefined || patch.routingWire !== undefined) {
        const v = resolverRouting(patch);
        sets.push(`routing_number_encrypted = $${i++}`);
        params.push(v ? encrypt(v) : null);
        // Sin columna `routing_number_last4`, lo único registrable sin filtrar
        // el número es su presencia.
        anota('routing_number', previa.routing_en_archivo ? 'en-archivo' : null, v ? 'en-archivo' : null);
      }

      if (sets.length === 0) {
        throw new ValidationError(
          'No se pidió ningún cambio. Campos editables: nombre, banco, sucursal, SWIFT, IBAN, clave SAT, tipo, moneda, CLABE, número de cuenta y routing.'
        );
      }

      sets.push('updated_at = NOW()');
      params.push(previa.id);
      const idIdx = i++;
      const alcance = alcanceDe(scope, 'bank_accounts', i);
      params.push(alcance.valor);

      // La fila ya está probada y bloqueada, y la frontera viaja igual dentro
      // del UPDATE: la escritura no depende de que la lectura de arriba se
      // haya hecho bien.
      const escrito = await client.query(
        `UPDATE bank_accounts SET ${sets.join(', ')} WHERE id = $${idIdx} AND ${alcance.sql}`,
        params
      );
      if (escrito.rowCount === 0) throw new NotFoundError('Bank account', ref);

      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, entityId),
        userId: ctx.userId,
        action: 'update',
        entityType: 'bank_accounts',
        entityId: previa.id,
        oldValues: antes,
        newValues: despues,
        reason: ctx.reason ?? null,
      });

      const cuenta = aFicha(await filaPorRef(scope, previa.id, { client }));
      const out: ResultadoEdicion = { cuenta, cambios, dryRun: false, advertencias };
      if (dryRun) throw new DryRunRollback(out);
      return out;
    });
    return payload;
  } catch (err) {
    if (err instanceof DryRunRollback) {
      return { ...(err.payload as ResultadoEdicion), dryRun: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// EL MAPEO CONTABLE
// ---------------------------------------------------------------

export interface ContextoMapeo extends ContextoEscritura {
  /**
   * Remapea aunque la cuenta de mayor actual tenga historia contabilizada.
   * NO salta las otras tres puertas (moneda, tipo y unicidad 1:1): esas no son
   * una precaución, son la definición de un mapeo que sirve.
   */
  force?: boolean;
}

export interface ResultadoMapeo {
  cuenta: FichaCuentaBancaria;
  anterior: CuentaDeMayor | null;
  nueva: CuentaDeMayor;
  /** Líneas contabilizadas que colgaban del mapeo anterior. */
  movimientosPosteados: number;
  forzado: boolean;
  /** Falso cuando ya estaba mapeada ahí y no había nada que escribir. */
  cambio: boolean;
  dryRun: boolean;
  advertencias: string[];
}

export async function setBankGlMapping(
  scope: Scope,
  ref: string,
  glAccount: string,
  ctx: ContextoMapeo
): Promise<ResultadoMapeo> {
  const entityId = entidadDe(scope, 'Fijar el mapeo contable de una cuenta bancaria');
  const dryRun = ctx.dryRun === true;

  try {
    const payload = await withTransaction(async (client) => {
      const advertencias: string[] = [];
      const previa = await filaPorRef(scope, ref, { client, forUpdate: true });
      const nueva = await exigirCuentaDeMayor(
        client,
        entityId,
        glAccount,
        previa.account_type,
        previa.currency_code
      );
      const anterior =
        previa.gl_id && previa.gl_code
          ? { id: previa.gl_id, code: previa.gl_code, name: previa.gl_name ?? '' }
          : null;

      if (anterior && anterior.id === nueva.id) {
        const out: ResultadoMapeo = {
          cuenta: aFicha(previa),
          anterior,
          nueva,
          movimientosPosteados: 0,
          forzado: false,
          cambio: false,
          dryRun: false,
          advertencias: [`La cuenta ya estaba mapeada a ${nueva.code}: no había nada que escribir.`],
        };
        if (dryRun) throw new DryRunRollback(out);
        return out;
      }

      // LA GUARDA. El saldo del mapeo anterior se quedaría colgando de una
      // cuenta de mayor que ya no representa a ningún banco: la conciliación
      // de mañana no lo vería y la de ayer no se podría reproducir.
      const historia = anterior
        ? await movimientosPosteados(client, entityId, anterior.id)
        : { lineas: 0, saldo: '0' };

      if (historia.lineas > 0 && ctx.force !== true) {
        throw new ConflictError(
          `${anterior?.code} ya tiene ${historia.lineas} línea${historia.lineas === 1 ? '' : 's'} contabilizada${historia.lineas === 1 ? '' : 's'} ` +
            `(saldo ${pesos(dec(historia.saldo))}). Remapear dejaría ese saldo huérfano: sin cuenta bancaria que lo concilie ` +
            'y fuera del alcance de la nueva. Si de verdad es lo que quieres, repite con --force y un motivo.'
        );
      }
      if (historia.lineas > 0) {
        // Forzado no es gratis: queda dicho en la respuesta y en la bitácora.
        if (!ctx.reason || ctx.reason.trim().length === 0) {
          throw new ValidationError(
            'Forzar el remapeo de una cuenta con historia contabilizada exige un motivo.',
            'reason'
          );
        }
        advertencias.push(
          `Se remapeó sobre ${historia.lineas} línea${historia.lineas === 1 ? '' : 's'} contabilizada${historia.lineas === 1 ? '' : 's'} ` +
            `de ${anterior?.code} (saldo ${pesos(dec(historia.saldo))}): ese saldo queda sin cuenta bancaria que lo concilie.`
        );
      }

      // La comprobación de que la nueva no está tomada la hace el índice
      // único, no un SELECT previo: entre el SELECT y el UPDATE cabe otra
      // transacción, y el índice no tiene esa ventana.
      let escrito;
      try {
        const alcance = alcanceDe(scope, 'bank_accounts', 3);
        escrito = await client.query(
          `UPDATE bank_accounts SET gl_account_id = $1, updated_at = NOW()
            WHERE id = $2 AND ${alcance.sql}`,
          [nueva.id, previa.id, alcance.valor]
        );
      } catch (err) {
        if (esViolacionDeMapeo(err)) throw await conflictoDeMapeo(client, entityId, nueva);
        throw err;
      }
      if (escrito.rowCount === 0) throw new NotFoundError('Bank account', ref);

      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, entityId),
        userId: ctx.userId,
        action: 'update',
        entityType: 'bank_accounts',
        entityId: previa.id,
        oldValues: { gl_account: anterior?.code ?? null },
        newValues: {
          gl_account: nueva.code,
          movimientos_posteados_al_remapear: historia.lineas,
          forzado: historia.lineas > 0,
        },
        reason: ctx.reason ?? null,
      });

      const cuenta = aFicha(await filaPorRef(scope, previa.id, { client }));
      const out: ResultadoMapeo = {
        cuenta,
        anterior,
        nueva,
        movimientosPosteados: historia.lineas,
        forzado: historia.lineas > 0,
        cambio: true,
        dryRun: false,
        advertencias,
      };
      if (dryRun) throw new DryRunRollback(out);
      return out;
    });
    return payload;
  } catch (err) {
    if (err instanceof DryRunRollback) {
      return { ...(err.payload as ResultadoMapeo), dryRun: true };
    }
    throw err;
  }
}
