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
];
