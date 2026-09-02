// ============================================================
// LOS VOCABULARIOS CERRADOS, DECLARADOS UNA SOLA VEZ.
//
// Media docena de columnas del esquema llevan `CHECK (col IN (...))`, y el
// código que valida la entrada tenía su propia copia escrita a mano. Cuando
// las dos listas se separan pasa una de dos cosas, y las dos son malas:
//
//   · el validador acepta un valor que el CHECK rechaza → la petición pasa
//     la validación y Postgres lanza 23514. El usuario recibe un 500 sin
//     explicación en lugar del 422 que le diría qué escribir mal;
//   · el validador rechaza un valor que el CHECK acepta → la capacidad
//     existe en la base y es INALCANZABLE desde fuera.
//
// Las dos estaban pasando a la vez. `blockchain_config.redundancy_mode`
// aceptaba 'mirror' y 'verify_only' (que revientan) y no dejaba escribir
// 'async_backup', 'sync_multi' ni 'consensus' (que son los reales): de nueve
// valores en juego coincidía UNO.
//
// Aquí se declaran una vez y las usa quien valide. La prueba de integración
// tests/integration/enum-contract.int.spec.ts lee los CHECK de pg_constraint
// y falla si alguna lista se separa del esquema — así que una migración que
// cambie un vocabulario rompe CI hasta que el código la siga, en vez de
// romper en producción cuando alguien mande ese valor.
// ============================================================

export interface Vocabulario {
  /** Tabla y columna que lo restringen, para poder comprobarlo contra pg_constraint. */
  tabla: string;
  columna: string;
  valores: readonly string[];
}

const v = (tabla: string, columna: string, valores: readonly string[]): Vocabulario =>
  ({ tabla, columna, valores });

// ── Nómina ──

/**
 * OJO CON 'finiquito'. El validador aceptaba esa palabra y el CHECK no la
 * tiene: el valor canónico es 'final'. No es un descuido de traducción — el
 * finiquito es un concepto real de la nómina mexicana — pero el esquema lo
 * nombra en inglés como todo lo demás, y la superficie en español se resuelve
 * con la capa de alias, no metiendo una palabra suelta en un enum.
 */
export const PAY_RUN_TYPES = ['regular', 'bonus', 'correction', 'final', 'off_cycle'] as const;
export const PAY_RUN_STATUSES = ['draft', 'calculating', 'calculated', 'approved', 'paid', 'voided'] as const;

// ── Conciliación bancaria ──

/**
 * El validador pedía 'journal_entry' y 'payment', que no existen, y no dejaba
 * escribir 'journal_entry_line', 'customer_payment' ni 'vendor_payment', que
 * son los reales. Conciliar contra una línea de asiento —el caso más común—
 * era imposible desde la API.
 */
export const MATCHED_ENTITY_TYPES = [
  'journal_entry_line', 'invoice', 'bill', 'customer_payment', 'vendor_payment',
] as const;
export const MATCH_TYPES = ['automatic', 'manual', 'suggested'] as const;

// ── Anclaje en cadena ──

export const REDUNDANCY_MODES = ['none', 'async_backup', 'sync_multi', 'consensus'] as const;
export const VERIFICATION_LAYERS = ['zkverify', 'native', 'both'] as const;
export const MESSAGING_PROTOCOLS = ['layerzero', 'wormhole', 'axelar', 'ccip'] as const;

// ── Contabilidad ──

export const AUDIT_ACTIONS = [
  'create', 'update', 'delete', 'post', 'void', 'approve', 'close', 'reopen',
] as const;
export const FISCAL_PERIOD_STATUSES = ['future', 'open', 'soft_close', 'hard_close', 'locked'] as const;
export const CFDI_STATUSES = ['pending', 'stamped', 'cancelled', 'failed'] as const;

// ── Cobros y pagos ──

export const VENDOR_PAYMENT_STATUSES = [
  'draft', 'pending', 'processing', 'completed', 'failed', 'void',
] as const;

/**
 * 'reversed' (049): el cobro OCURRIÓ y rebotó (NSF). Distinto de 'void' —
 * que nunca debió existir. El lado del proveedor no lo tiene: un pago
 * nuestro devuelto es otra historia, con su propia fase.
 */
export const CUSTOMER_PAYMENT_STATUSES = [
  'draft', 'pending', 'processing', 'completed', 'failed', 'void', 'reversed',
] as const;

// ── Notas de crédito (049) ──

export const CREDIT_NOTE_TYPES = ['devolucion', 'descuento', 'correccion', 'anticipo'] as const;
export const CREDIT_NOTE_STATUSES = ['draft', 'issued', 'applied', 'void'] as const;

// ── Banco (051) ──

/**
 * No son cinco sinónimos de «cuenta»: el tipo decide cómo se LEE el saldo y
 * contra qué se concilia. `credit-card` es un PASIVO —su saldo va con el signo
 * contrario al de las demás— y `petty-cash` no se concilia contra un extracto
 * sino contra un arqueo, así que un tipo mal escrito no produce un error de
 * validación sino un saldo con el signo cambiado.
 */
export const BANK_ACCOUNT_TYPES = [
  'checking', 'savings', 'petty-cash', 'credit-card', 'escrow',
] as const;

/**
 * El formato del archivo del que salió el extracto. Sólo tres de los diez
 * tienen lector hoy (csv, mt940, camt053) y `manual` no tiene archivo: el
 * CHECK admite los diez porque la columna registra la PROCEDENCIA del
 * documento, que es dato de auditoría, y no la capacidad de leerlo.
 */
export const STATEMENT_SOURCE_FORMATS = [
  'csv', 'ofx', 'qfx', 'mt940', 'mt942', 'camt053', 'camt054', 'bai2', 'xlsx', 'manual',
] as const;

// ── Sesión de conciliación (003, 054, 055) ──

/**
 * El CHECK vive en la 003 y la lista a mano vivía en `reconciliation-service.ts`
 * con un comentario que decía «los estados del CHECK de la 003» — una promesa de
 * fidelidad que nada comprobaba. Se censa ahora porque hasta F05d los dos
 * últimos valores eran decorativos: NADIE escribía 'approved' ni 'posted', así
 * que una divergencia en esa mitad de la lista no tenía cómo doler. La firma y
 * el sello los vuelven alcanzables, y con ellos el filtro de
 * `bank reconciliation list --state` empieza a decidir sobre valores que de
 * verdad existen en la tabla.
 *
 * La 054 y la 055 añaden más CHECK sobre esta misma columna (los que exigen
 * aritmética, firma y rastro), y sus literales son SUBCONJUNTOS de éstos: la
 * prueba de contrato acumula por columna y deduplica, así que el vocabulario
 * que compara sigue siendo exactamente estos cuatro.
 */
export const RECONCILIATION_SESSION_STATUSES = [
  'in_progress', 'balanced', 'approved', 'posted',
] as const;

// ── Activo fijo y su corrida (003, 056) ──

/**
 * LOS SEIS MÉTODOS, QUE VIVEN EN CUATRO COLUMNAS A LA VEZ.
 *
 * La 003 puso el CHECK sobre `fixed_assets.depreciation_method` y sobre
 * `asset_categories.default_depreciation_method`, y dejó
 * `book_depreciation_method` y `tax_depreciation_method` como VARCHAR(50)
 * SIN CHECK: nadie las escribía ni las leía, así que la divergencia no tenía
 * dónde doler. La 056 les pone el CHECK que les faltaba, con los mismos seis
 * literales, porque F06a es lo que las vuelve alcanzables.
 *
 * Se censan las CUATRO y no sólo las dos nuevas. Que el par contable/fiscal
 * quedara vigilado y su hermana `depreciation_method` —la que de verdad rige
 * el importe posteado— siguiera fuera del censo repetiría el defecto que este
 * archivo existe para cerrar, y encima en la misma sentencia: el alta de
 * activo escribe las tres en un solo INSERT.
 *
 * Que sean dos columnas y no una es deliberado: la depreciación contable
 * sigue la vida útil de la NIF C-6 y la fiscal las tasas máximas de los
 * artículos 31-38 de la LISR, y dan números distintos sobre el mismo activo.
 * La política `base_depreciacion` decide cuál de las dos llega al mayor.
 */
export const DEPRECIATION_METHODS = [
  'straight_line', 'declining_balance_150', 'declining_balance_200',
  'sum_of_years_digits', 'units_of_production', 'macrs',
] as const;

/**
 * El CHECK es de la 003 y hasta F06a no había un solo activo que pudiera
 * estar en ninguno de estos cuatro estados. Se censa ahora porque la corrida
 * filtra por `status = 'active'` dentro del SQL: un quinto valor que entrara
 * al esquema sin entrar aquí dejaría activos vivos fuera de la corrida sin
 * que nada lo dijera, y eso no se ve en el mayor, se ve en su ausencia.
 */
export const ASSET_STATUSES = [
  'active', 'inactive', 'disposed', 'fully_depreciated',
] as const;

/**
 * El censo que la prueba de contrato recorre. Añadir una fila aquí es lo que
 * pone el vocabulario bajo vigilancia; declararlo arriba sin registrarlo lo
 * deja fuera y vuelve a permitir que se separe en silencio.
 */
export const VOCABULARIOS: readonly Vocabulario[] = [
  v('pay_runs', 'run_type', PAY_RUN_TYPES),
  v('pay_runs', 'status', PAY_RUN_STATUSES),
  v('reconciliation_matches', 'matched_entity_type', MATCHED_ENTITY_TYPES),
  v('reconciliation_matches', 'match_type', MATCH_TYPES),
  v('blockchain_config', 'redundancy_mode', REDUNDANCY_MODES),
  v('blockchain_config', 'verification_layer', VERIFICATION_LAYERS),
  v('blockchain_config', 'messaging_protocol', MESSAGING_PROTOCOLS),
  v('audit_log', 'action', AUDIT_ACTIONS),
  v('fiscal_periods', 'status', FISCAL_PERIOD_STATUSES),
  v('invoices', 'cfdi_status', CFDI_STATUSES),
  v('vendor_payments', 'status', VENDOR_PAYMENT_STATUSES),
  v('customer_payments', 'status', CUSTOMER_PAYMENT_STATUSES),
  v('credit_notes', 'type', CREDIT_NOTE_TYPES),
  v('credit_notes', 'status', CREDIT_NOTE_STATUSES),
  v('bank_accounts', 'account_type', BANK_ACCOUNT_TYPES),
  v('bank_statements', 'source_format', STATEMENT_SOURCE_FORMATS),
  v('reconciliation_sessions', 'status', RECONCILIATION_SESSION_STATUSES),
  v('fixed_assets', 'depreciation_method', DEPRECIATION_METHODS),
  v('fixed_assets', 'book_depreciation_method', DEPRECIATION_METHODS),
  v('fixed_assets', 'tax_depreciation_method', DEPRECIATION_METHODS),
  v('fixed_assets', 'status', ASSET_STATUSES),
  v('asset_categories', 'default_depreciation_method', DEPRECIATION_METHODS),
];
