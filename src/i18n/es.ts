import type { EN } from './en.js';

// ============================================================
// EL CATÁLOGO ESPAÑOL, Y LA PUERTA QUE LO OBLIGA (I6 · issue #148)
//
// `Record<keyof typeof EN, string>` NO ES DECORACIÓN DE TIPOS: es la puerta
// entera del tramo. Una clave que se añade en `en.ts` y se olvida aquí es un
// error de `tsc` —«Property 'x' is missing»— y una clave que sobra aquí
// también lo es, porque la comprobación de propiedades excedentes de un
// literal de objeto contra un tipo mapeado la rechaza. Las dos direcciones,
// sin una sola prueba de por medio y sin esperar a CI: el compilador que ya
// corre antes de cada commit.
//
// POR QUÉ ESTO Y NO UN JSON. Un catálogo en JSON obliga a una prueba que lo
// lea, y esa prueba corre después —y sólo si alguien la corre—. Un `Record`
// tipado falla en el editor, en la tecla siguiente. La sincronía deja de ser
// algo que se vigila y pasa a ser algo que no se puede escribir.
//
// LO QUE `tsc` NO VE, y por eso existe `tests/i18n/sync.spec.ts`: que los
// PARÁMETROS sean los mismos en los dos idiomas (un `{command}` traducido a
// `{comando}` compila igual de bien y sale vacío en pantalla), que las ramas de
// un `select` coincidan, que ninguna cadena esté vacía, que ninguna sea la
// inglesa copiada sin traducir, y que no quede ningún `__TRANSLATE__` dentro.
//
// EL ESPAÑOL DE AQUÍ ES EL QUE EL CLI YA IMPRIME, palabra por palabra, con su
// archivo y su renglón en `en.ts`. No es una traducción nueva: es la que hay,
// mudada a una clave.
// ============================================================

export const ES: Record<keyof typeof EN, string> = {
  // ==== error.* — mensajes de los errores de la API y los servicios (I9) ====
  'error.PERIOD_ALREADY_OPEN': '{period} ya está abierto.',

  'error.FX_REVALUATION_PERIOD_NOT_OPEN':
    '{period} es {type} y está en {status}: la revaluación corresponde a un mes regular abierto o con cierre suave, antes de su sello.',
  'error.FX_REVALUATION_NEXT_PERIOD_NOT_OPEN':
    'La revaluación de {period} se revierte el primer día del periodo siguiente, y ese periodo {status, select, missing {no existe} other {está en {status}}}. Ábrelo (en diciembre, abre antes el ejercicio siguiente) y vuelve a correrla: no se posteó nada.',
  'error.FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED':
    'La revaluación de cierre está hecha para entidades que llevan sus libros en pesos mexicanos (NIF B-15), y ésta los lleva en {currency}. Otras monedas funcionales, y ASC 830, son el issue 124: no se posteó nada.',
  'error.INVOICE_CHANGED': '{invoice} cambió bajo este cobro; no se escribió nada.',
  'error.BILL_CHANGED': '{bill} cambió mientras se aplicaba el pago; no se escribió nada.',
  'error.FX_REVALUATION_PLAN_CHANGED':
    'La revaluación de {period} cambió entre el plan que confirmaste (utilidad {expectedGain}, pérdida {expectedLoss}) y el posteo (utilidad {gain}, pérdida {loss}): algo se posteó o cambió un tipo entretanto. No se posteó nada; vuelve a correrla para ver el plan nuevo.',
  'error.FX_REVALUATION_MARKER_MISMATCH':
    'El registro de la revaluación de {period} no coincide con el mayor: el mayor tiene {ledger} pólizas de revaluación para él y el registro {marker}, o sus importes difieren. Volver a correrla podría postear la revaluación dos veces, así que no se posteó nada; hay que revisar el registro.',
  'error.FX_REVALUATION_KEY_LOCKED':
    '{policy} no puede cambiar ahora: {entity} revaluó {period}, que aún no tiene cierre definitivo, y los meses de su ejercicio que faltan por revaluar se medirían con el valor nuevo. Cambia cuando los meses revaluados estén sellados, o al inicio de un ejercicio: cuando el ejercicio siguiente esté abierto, sin revaluación todavía, y cada mes anterior esté revaluado o con cierre definitivo.',
  'error.FX_RATE_MISSING':
    'No hay tipo de cambio {from}→{to} de la fuente {source} para {date}. Captúralo con: mnemosine fx rate set {from}/{to} {date} TASA --source {source}, o descárgalo con: mnemosine fx rate download. No se toma otra fuente ni otra fecha en silencio: la fuente la eligió el panel de políticas, y es un criterio del despacho.',
  // ---- MNE-001-154 · the AccountingError of src/services/accounting; see en.ts ----
  'error.MISSING_ROLE_ACCOUNT.unmapped':
    'No hay cuenta mapeada al rol "{role}" en esta entidad. Siembra la contabilidad con: mnemosine init --section identity (o revisa qué falta con: mnemosine doctor)',
  'error.FX_RATE_CONFLICT':
    "{invoice} trae tipo de cambio {rate} y la fuente '{source}' de la política fuente_tipo_cambio publicó {published} para {date}. No elijo uno en silencio: corrige el tipo de la factura o la política antes de emitirla.",
  'error.INVOICE_ALREADY_POSTED': '{invoice} ya tiene póliza o no es de esta entidad: no se enlaza otra.',
  'error.FX_RATE_MISSING.document':
    '{bill} está en {currency} y los libros en {functional}, pero su exchange_rate es {rate, select, none {nulo} other {{rate}}} (el default de captura). Registra el tipo de cambio del documento antes de aprobarlo: sin él el pasivo se asentaría sin convertir y perdería su origen (NIF B-15).',
  'error.FX_AR_ON_ACCOUNT_NOT_WIRED':
    '{payment} deja {amount} {currency} a cuenta del cliente: un saldo a cuenta en otra moneda todavía no se aplica ni se desaplica convertido.',
  'error.WRITE_OFF_ACCOUNT_UNRESOLVED':
    'Hay un pago corto que condona saldo y nadie dijo a qué cuenta va. La decide la política `pago_corto_residual`; postear sin ella dejaría el asiento descuadrado.',
  'error.REASON_REQUIRED': 'Reabrir un periodo cerrado exige un motivo: queda en el rastro de auditoría.',
  'error.PERIOD_LOCKED':
    "{period} está 'locked': su información ya salió del sistema y no se reabre. La corrección va en el periodo abierto más próximo.",
  'error.PERIOD_NOT_CLOSED': "{period} está '{status}': esta operación es sólo para periodos cerrados.",
  'error.INVALID_STATUS': "Sólo se restaura a 'soft_close' o 'hard_close'; se pidió '{status}'.",
  'error.PERIOD_NOT_OPEN.restore': 'No se pudo restaurar el periodo {period}: ya no estaba abierto.',
  'error.TENANT_NO_RESUELTO.period': 'No se pudo determinar el inquilino de {entity}.',
  'error.IVA_ROLE_UNRESOLVED.no_line':
    'La taxonomía CFDI no define una línea de IVA para ({side}, {method}). Revisa CASES en src/services/xml-ingestion/cfdi-taxonomy.ts.',
  'error.MISSING_ROLE_ACCOUNT.no_semantic_layer':
    'La entidad {entity} no tiene sembrada la capa semántica, así que no se puede saber cuánto IVA tiene aparcado: el pago liberaría cero y el impuesto se quedaría ahí. Siémbrala con: npm run backfill:account-roles -- --tenant <uuid> --aplicar',
  'error.ALREADY_POSTED.preview': '{entry} ya está aplicada: no hay delta que previsualizar.',
  'error.ENTRY_VOID.preview': '{entry} está anulada y jamás se aplicará.',
  'error.ALREADY_POSTED.edit': '{entry} ya está aplicada: una póliza en el mayor es inmutable.',
  'error.ENTRY_VOID.edit': '{entry} está anulada.',
  'error.ENTRY_NOT_EDITABLE': '{entry} está en {status}: solo un borrador se edita.',
  'error.OPENING_DRAFT_LOCKED':
    '{entry} es la apertura cargada de la balanza: sus renglones y su fecha no se editan. Aplícala con `entry post`, o anúlala con `entry void` y vuelve a cargar la balanza.',
  'error.ENTITY_NOT_FOUND.functional_currency':
    'No existe la entidad {entity}: sin su moneda funcional no se puede convertir nada.',
  'error.FX_POLITICA_DESCONOCIDA.rate_source':
    'La política fuente_tipo_cambio vale "{value}" y este lector solo entiende {known}. Corrige la política en mnemosine pending.',
  'error.FX_RATE_MISSING.policy_source':
    "No hay tipo de cambio {from}→{to} de la fuente '{source}' para {date}. Captúralo con: mnemosine fx rate set {from}/{to} {date} <tasa> --source {source} — o descárgalo con: mnemosine fx rate download. No se toma otra fuente ni otra fecha en silencio: la política fuente_tipo_cambio ({policy}) es un criterio fiscal del despacho, no una preferencia de esta función.",
  'error.TENANT_NO_RESUELTO.close':
    'No se pudo determinar el inquilino de la entidad {entity}: el cierre no se registra sin rastro.',
  'error.CIERRE_YA_EMITIDO':
    'El periodo ya emitió su cierre ({entries}) y la política cierre_recierre_de_periodo_reabierto lo prohíbe volver a cerrar: corrígelo por reclasificación explícita, o cambia la política en mnemosine pending.',
  'error.RESULTADO_SIN_BARRER':
    'El cierre no dejó el ejercicio en cero: {count} cuenta(s) de resultados conservan saldo ({detail}). El cierre se revirtió entero y el periodo sigue abierto: un saldo que sobrevive al cierre siembra mal el ejercicio siguiente. Si el despacho prefiere que esto sólo avise, la política es severidad_resultado_sin_barrer.',
  'error.SOD_QUIEN_CREA_NO_POSTEA.apply':
    '{reference}: la política de segregación de funciones exige que quien aplica no sea quien lo preparó. Que otro usuario lo aplique, o ajusta la política segregacion_de_funciones en mnemosine pending.',
  'error.SOD_QUIEN_CREA_NO_POSTEA.post':
    '{entry}: la política de segregación de funciones exige que quien postea no sea quien creó el borrador. Que otro usuario corra entry post, o ajusta la política segregacion_de_funciones en mnemosine pending.',
  'error.ENTITY_NOT_FOUND.posting': 'La entidad {entity} no existe o no es visible.',
  'error.TENANT_NO_RESUELTO.entry':
    'No se pudo determinar el inquilino de la entidad {entity}: el asiento no se escribe sin rastro de auditoría.',
  // ---- MNE-001-480 part 1 · the refusals of src/services/payments; see en.ts ----
  'error.VALIDATION_ERROR.payment.destination_bank_both':
    'El pago declara banco destino nacional («{national}») y extranjero («{foreign}») a la vez. El Anexo 24 pide la CLAVE del catálogo para el nacional y el NOMBRE para el extranjero: declarar los dos afirma dos cosas incompatibles sobre el mismo movimiento, y el archivo las lleva tal cual a la autoridad.{foreignCode, select, yes { Un banco extranjero se da sólo con su nombre: la póliza le pone la clave {code} al escribirlo.} other {}}',
  'error.VALIDATION_ERROR.payment.destination_bank_length':
    'La clave de banco destino «{national}» tiene {length} caracteres y el c_Banco del SAT son {expected}. Un banco no se identifica por su nombre en este campo: si el banco es extranjero, dilo con el nombre en el campo de banco extranjero.',
  'error.VALIDATION_ERROR.payment.destination_bank_off_list':
    'La clave de banco destino «{national}» no está en el catálogo c_Banco del SAT (tres dígitos de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.',
  'error.VALIDATION_ERROR.payment.destination_account_missing':
    'Se indicó el banco destino y no la cuenta destino. En la póliza del Anexo 24 la cuenta destino es el dato obligatorio del nodo de transferencia y el banco el opcional: el banco solo no permite emitir el rastro y sí aparenta que el pago ya lo tiene.',
  'error.VALIDATION_ERROR.payment.cheque_on_other_method':
    'Se dio número de cheque («{cheque}») a un pago {side, select, cliente {cobrado} other {hecho}} por «{method}». El número de cheque identifica un cheque: sobre otro método la póliza del Anexo 24 declararía un cheque que no existe. Usa la referencia bancaria para el folio de una transferencia.',
  'error.VALIDATION_ERROR.payment.cheque_too_long':
    'El número de cheque «{cheque}» pasa de los 20 caracteres que admite el nodo Cheque de la póliza del Anexo 24.',
  'error.VALIDATION_ERROR.payment.payer_bank_on_vendor_payment':
    'El banco y la cuenta del pagador sólo se capturan en un cobro. En un pago a proveedor el origen es nuestra cuenta bancaria (`--bank`), y su clave c_Banco vive en esa cuenta.',
  'error.VALIDATION_ERROR.payment.payer_bank_method':
    'Se dio banco o cuenta del cliente a un cobro por «{method}». Sólo un cheque o una transferencia declaran de qué banco salió el dinero en la póliza del Anexo 24.',
  'error.VALIDATION_ERROR.payment.payer_bank_both':
    'El cobro declara banco del cliente nacional («{bank}») y extranjero («{foreign}») a la vez. Un banco extranjero se da sólo con su nombre: la póliza le pone la clave {code} al escribirlo.',
  'error.VALIDATION_ERROR.payment.payer_bank_off_list':
    'La clave de banco del cliente «{bank}» no está en el catálogo c_Banco del SAT (tres dígitos de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.',
  'error.VALIDATION_ERROR.payment.payer_account_without_bank':
    'Se indicó la cuenta del cliente y no su banco. El nodo de pago de la póliza exige el banco de origen: la cuenta sola no permite emitirlo y sí aparenta que el cobro ya tiene su rastro.',
  'error.VALIDATION_ERROR.payment.payer_trace_too_long':
    'La cuenta del cliente admite hasta 50 caracteres y el nombre de su banco extranjero hasta 150, los mismos límites del nodo de pago de la póliza.',
  'error.PAYMENT_STATE_UNSUPPORTED':
    "Un pago sólo puede registrarse como '{state}': mnemosine registra pagos que YA ocurrieron. El estado '{status}' pertenece a un programador de pagos que no existe, y un pago que no ha salido del banco no puede tocar el mayor.",
  'error.VALIDATION_ERROR.payment.no_application':
    'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.',
  'error.VALIDATION_ERROR.payment.advance_without_party':
    'Un anticipo sin documento necesita el {side, select, cliente {cliente} other {proveedor}} explícito: sin documento no hay de dónde deducirlo.',
  'error.VALIDATION_ERROR.payment.document_repeated':
    'El documento {document} aparece dos veces en el mismo pago. Súmalas en una sola aplicación: repetirlo restaría su saldo dos veces.',
  'error.VALIDATION_ERROR.payment.customer_discount_is_credit_note':
    'Un descuento concedido a un cliente no es una línea del cobro: es una NOTA DE CRÉDITO, con su documento y su CFDI de egreso. Emítela con `mnemosine credit-note create --type descuento` y aplícala a la factura.',
  'error.VALIDATION_ERROR.payment.applications_exceed_amount':
    'Las aplicaciones suman {total} y el pago es de {amount}: no se puede aplicar más de lo que se pagó.',
  'error.VALIDATION_ERROR.payment.applications_mismatch':
    'Las aplicaciones suman {total} y el pago es de {amount}. Tienen que coincidir: lo que sobra quedaría cargado a la cuenta de control sin bajar de ningún auxiliar. Si el remanente es deliberado, dilo con onAccount (--on-account): quedará como anticipo {side, select, cliente {del cliente} other {a proveedores}}.',
  'error.VALIDATION_ERROR.payment.currency_mismatch':
    '{document} está en {documentCurrency} y el pago en {paymentCurrency}. Un importe en otra moneda se restaría crudo del saldo y se asentaría crudo, sin tipo de cambio.',
  'error.VALIDATION_ERROR.payment.document_rate_missing':
    '{document} está en {currency} pero su exchange_rate es {rate} (el default de captura): se asentó sin convertir. Corrige el documento antes de {settle, select, cobrarlo {cobrarlo} other {pagarlo}} — la diferencia cambiaria se mide contra la tasa a la que el documento nació (NIF B-15).',
  'error.VALIDATION_ERROR.payment.rate_not_positive': 'El tipo de cambio del pago ({rate}) tiene que ser mayor que cero.',
  'error.VALIDATION_ERROR.payment.bank_account_inactive':
    'La cuenta bancaria "{account}" está inactiva: no registra movimientos nuevos. Elige una cuenta activa de `bank account list`.',
  'error.VALIDATION_ERROR.payment.advance_other_currency':
    'El anticipo viene en {currency} y esta entidad lleva sus libros en {functional}. No lo registro convertido porque la tasa y su fuente las decide el despacho en la política `fuente_tipo_cambio`, no yo; y no lo registro sin convertir porque asentaría una cifra de otra moneda como si fuera de ésta. Aplica el {side, select, cliente {cobro} other {pago}} a un documento en su moneda, o registra el anticipo en {functional}.',
  'error.VALIDATION_ERROR.payment.vendor_unresolved': 'No se pudo determinar el proveedor del pago.',
  'error.VALIDATION_ERROR.payment.customer_unresolved': 'No se pudo determinar el cliente del cobro.',
  'error.FX_AR_ON_ACCOUNT_NOT_WIRED.receipt':
    'El cobro en {currency} deja {amount} a cuenta del cliente. Un saldo a cuenta en otra moneda todavía no se puede aplicar ni desaplicar convertido, así que no lo registro: aplica el cobro completo a facturas en {currency}.',
  'error.VALIDATION_ERROR.payment.bill_not_payable':
    '{bill} está en "{status}" y sólo se puede pagar un gasto {payable}: su pasivo tiene que estar en el mayor primero.',
  'error.VALIDATION_ERROR.payment.bill_not_applicable': '{bill} está en "{status}" y sólo se puede aplicar a un gasto {payable}.',
  'error.VALIDATION_ERROR.payment.bill_other_vendor':
    '{bill} es del proveedor {vendor} y el pago se atribuye a {counterparty}: el pago quedaría en el auxiliar equivocado.',
  'error.VALIDATION_ERROR.payment.bill_exceeds_due':
    '{bill} debe {due} y se intentan extinguir {settled} ({cash} de efectivo + {discount} de descuento).',
  'error.VALIDATION_ERROR.payment.invoice_not_collectible':
    '{invoice} está en "{status}" y sólo se puede cobrar una factura {collectible}: su ingreso tiene que estar en el mayor primero.',
  'error.VALIDATION_ERROR.payment.invoice_not_applicable':
    '{invoice} está en "{status}" y sólo se puede aplicar a una factura {collectible}.',
  'error.VALIDATION_ERROR.payment.invoice_other_customer':
    '{invoice} es del cliente {customer} y el cobro se atribuye a {counterparty}: quedaría en el auxiliar equivocado.',
  'error.VALIDATION_ERROR.payment.invoice_exceeds_due': '{invoice} debe {due} y se intentan aplicar {applied}.',
  'error.VALIDATION_ERROR.payment.discount_over_terms':
    '{bill} concede {granted} de descuento por pronto pago ("{terms}") y se están tomando {taken}. La diferencia no es descuento: es pagar de menos. Si es deliberado, dilo con --mode residual --short-pay-reason.',
  'error.VALIDATION_ERROR.payment.not_completed':
    "{side, select, cliente {El cobro} other {El pago}} {payment} está en '{status}': sólo un {side, select, cliente {cobro} other {pago}} 'completed' admite este evento.",
  'error.VALIDATION_ERROR.payment.apply_which_invoices': 'Indica a qué factura(s) se aplica el saldo a cuenta.',
  'error.VALIDATION_ERROR.payment.apply_which_bills': 'Indica a qué gasto(s) se aplica el saldo a cuenta.',
  'error.VALIDATION_ERROR.payment.application_document_repeated':
    'El documento {document} aparece dos veces en la misma aplicación: súmalas en una.',
  'error.VALIDATION_ERROR.payment.on_account_short':
    '{side, select, cliente {El cobro} other {El pago}} {payment} tiene {left} sin aplicar y se intentan aplicar {total}: el saldo a cuenta no alcanza.',
  'error.VALIDATION_ERROR.payment.nothing_to_unapply':
    'El cobro {receipt} no tiene ninguna aplicación viva sobre {invoice}: no hay qué desaplicar.',
  'error.VALIDATION_ERROR.payment.reversal_fee_not_wired':
    'La comisión por devolución todavía no se puede registrar: necesita una cuenta con rol de comisiones bancarias en la capa semántica. Reversa el cobro sin --fee y registra la comisión como asiento manual mientras tanto.',
  'error.VALIDATION_ERROR.payment.short_pay_reason_required':
    'Cerrar un gasto pagando de menos borra un pasivo que sí se debía: di por qué con --short-pay-reason. Sin motivo escrito, el auditor sólo ve un saldo que desapareció.',
  'error.VALIDATION_ERROR.payment.short_pay_forbidden':
    'La política `pago_corto_residual` de este despacho está en "prohibir": ningún gasto se cierra pagando de menos. Pide al proveedor la nota de crédito y aplícala, o cambia la política con `mnemosine pending reopen pago_corto_residual` (si ya estaba definida) y luego `mnemosine pending define pago_corto_residual`.',
  // ---- MNE-001-417 · la puerta a mano de un CFDI emitido; see en.ts ----
  'error.ISSUED_CFDI_NOT_SUPPORTED':
    'El CFDI {uuid} no se contabiliza en CxC a mano: {reason, select, received {la entidad lo recibió; contabilízalo con: mnemosine bill inbox run {detail}} document_type {es un {detail}, no una factura de venta} currency {está en {detail}, y este camino no convierte monedas} advance {es un anticipo de cliente, un pasivo y no una venta} applies_advance {aplica un anticipo (TipoRelacion 07)} other {su caso es {detail}, no una venta PUE o PPD}}. No se posteó nada.',
  'error.ISSUED_CFDI_PPD_IEPS':
    'El CFDI {uuid} es una venta PPD que traslada IEPS ({ieps}): ese IEPS se causa al cobro (LIEPS art. 10) y espera en el rol {role} (2181), que no tiene cuenta en esta entidad. Añádela con: npm run backfill:account-roles -- --aplicar. No se posteó nada.',
  'error.ISSUED_CFDI_NOT_OPEN':
    'El CFDI {uuid} no está abierto: su pre-registro está en {status}{invoice, select, none {} other {, como la factura de cliente {invoice}}}. No se posteó nada.',
  'error.ISSUED_CFDI_DRAFT_IN_REVIEW':
    'El CFDI {uuid} tiene un borrador de IA en revisión o aprobado: apruébalo o recházalo con: mnemosine review. No se posteó nada.',
  'error.ISSUED_CFDI_HELD':
    'El CFDI {uuid} queda detenido y no se posteó nada: {reason}{commands, select, none {} other {. Contéstalo con: {commands}, y vuelve a correr el comando}}',
  'error.ISSUED_CFDI_SUBSTITUTES_INVOICE':
    'El CFDI {uuid} sustituye a un CFDI que sigue siendo la factura de cliente {invoice} ({status}): anula primero esa factura. No se posteó nada.',
  'error.ISSUED_CFDI_REVENUE_LINES_MISMATCH':
    'Los conceptos del CFDI {uuid} suman {lines} netos de sus descuentos, y su SubTotal − Descuento es {revenue}: el ingreso no se puede repartir por concepto. No se posteó nada.',
  'error.ISSUED_CFDI_REVENUE_ACCOUNT':
    'La cuenta {account} ({type}, saldo {balance}){line, select, none {} other {, codificada en el renglón {line},}} no puede recibir el ingreso del CFDI {uuid}: una venta abona una cuenta de ingresos activa y afectable, de saldo acreedor. No se posteó nada.',
  // ---- MNE-001-152 · el 422 de validateBody y validateQuery, una clave por issue de Zod; see en.ts ----
  'error.VALIDATION_ERROR.body': 'Cuerpo de la petición inválido: {issues}',
  'error.VALIDATION_ERROR.query': 'Parámetro de consulta inválido: {name}: {issues}',
  'error.VALIDATION_ERROR.issue.required': 'Obligatorio',
  'error.VALIDATION_ERROR.issue.integer_received_float': 'Se esperaba un número entero y llegó uno con decimales',
  'error.VALIDATION_ERROR.issue.not_finite': 'El número debe ser finito',
  'error.VALIDATION_ERROR.issue.invalid_type': 'Se esperaba {expected} y llegó {received}',
  'error.VALIDATION_ERROR.issue.invalid_literal': 'Valor literal inválido: se esperaba {expected}',
  'error.VALIDATION_ERROR.issue.invalid_enum_value': "Valor no admitido. Se esperaba {expected} y llegó '{received}'",
  'error.VALIDATION_ERROR.issue.invalid_format':
    '{format, select, regex {Formato inválido} other {Formato {format} inválido}}',
  'error.VALIDATION_ERROR.issue.invalid_affix':
    'Entrada inválida: debe {affix, select, starts_with {empezar con} ends_with {terminar con} other {incluir}} "{value}"',
  'error.VALIDATION_ERROR.issue.too_small.array':
    'El arreglo debe tener {bound, select, exact {exactamente} inclusive {al menos} other {más de}} {minimum, plural, one {# elemento} other {# elementos}}',
  'error.VALIDATION_ERROR.issue.too_small.string':
    'La cadena debe tener {bound, select, exact {exactamente} inclusive {al menos} other {más de}} {minimum, plural, one {# carácter} other {# caracteres}}',
  'error.VALIDATION_ERROR.issue.too_small.number':
    'El número debe ser {bound, select, exact {exactamente igual a} inclusive {mayor o igual que} other {mayor que}} {minimum}',
  'error.VALIDATION_ERROR.issue.too_big.array':
    'El arreglo debe tener {bound, select, exact {exactamente} inclusive {como máximo} other {menos de}} {maximum, plural, one {# elemento} other {# elementos}}',
  'error.VALIDATION_ERROR.issue.too_big.string':
    'La cadena debe tener {bound, select, exact {exactamente} inclusive {como máximo} other {menos de}} {maximum, plural, one {# carácter} other {# caracteres}}',
  'error.VALIDATION_ERROR.issue.too_big.number':
    'El número debe ser {bound, select, exact {exactamente} inclusive {menor o igual que} other {menor que}} {maximum}',
  'error.VALIDATION_ERROR.issue.too_big.bigint':
    'El BigInt debe ser {bound, select, exact {exactamente} inclusive {menor o igual que} other {menor que}} {maximum}',
  'error.VALIDATION_ERROR.issue.not_multiple_of': 'El número debe ser múltiplo de {divisor}',
  'error.VALIDATION_ERROR.issue.unrecognized_keys': 'Claves que el objeto no admite: {keys}',
  'error.VALIDATION_ERROR.issue.invalid_input': 'Entrada inválida',
  // ---- MNE-001-588 · the messages the REST schemas set themselves, by key; see en.ts ----
  'error.VALIDATION_ERROR.schema.at_least_one_field': 'Debe enviarse al menos un campo',
  'error.VALIDATION_ERROR.schema.at_least_one_field_required': 'Hace falta al menos un campo',
  'error.VALIDATION_ERROR.schema.xml_content_required': 'Hace falta xml_content o el arreglo xml_contents',
  'error.VALIDATION_ERROR.schema.customer_name_required': 'Hace falta company_name o first_name',
  'error.VALIDATION_ERROR.schema.line_debit_or_credit': 'Cada renglón lleva debit_amount O credit_amount, no los dos',
  'error.VALIDATION_ERROR.schema.unknown_pac': 'Proveedor de PAC desconocido',
  'error.VALIDATION_ERROR.schema.matched_amount_positive': 'matched_amount debe ser un decimal positivo',
  'error.VALIDATION_ERROR.schema.matched_amount_scale':
    'matched_amount debe ser un decimal positivo con 4 decimales como máximo',
  'error.VALIDATION_ERROR.schema.invoice_min_lines': 'Hace falta al menos 1 renglón',
  'error.VALIDATION_ERROR.schema.entry_min_lines': 'Hacen falta al menos 2 renglones',
  'error.VALIDATION_ERROR.schema.void_reason_required': 'Para anular hace falta un motivo',
  'error.VALIDATION_ERROR.schema.date_format': 'AAAA-MM-DD',
  // ---- MNE-001-150 · a path no route serves; see en.ts ----
  'error.ROUTE_NOT_FOUND': 'No hay ninguna ruta para {method} {path}.',
  // ==== fin de error.* ================================================

  // ==== policy.* — the policy panel, by key (I10 · #152); see en.ts ====
  'policy.non_mexican_entity_chart.question':
    '¿Qué catálogo de cuentas recibe una entidad que no lleva contabilidad mexicana?',
  'policy.non_mexican_entity_chart.impact':
    'Decide con qué nace una entidad extranjera. El catálogo de la casa la deja contabilizando desde el primer día; sin catálogo base se queda con las cuentas de rol de CFDI y los renglones de mapeo de nómina y nada más, y hasta que importe el suyo cada factura falla con MISSING_ROLE_ACCOUNT y la primera corrida de nómina también, porque los roles y los grupos que piden banco, clientes, proveedores o ingresos no tienen a qué cuenta apuntar.',
  'policy.non_mexican_entity_chart.rationale':
    'Una entidad que puede contabilizar el primer día es mejor que una que no puede. El andamiaje universal es partida doble, no algo mexicano, así que sirve en cualquier país; importar un catálogo después sigue funcionando y nunca sobrescribe lo que eligió el despacho.',
  'policy.non_mexican_entity_chart.why':
    'Tu subsidiaria extranjera puede empezar con el mismo catálogo que usan tus entidades mexicanas —sin las cuentas de IVA, ISR y retenciones, que nunca va a usar— o puede empezar sin ese catálogo porque piensas traer el que ya tiene desde otro sistema. Las dos son defendibles; cuál es la correcta depende de si esa entidad ya lleva su contabilidad en otro lado.',
  'policy.non_mexican_entity_chart.what':
    'Con el catálogo de la casa siembro las cuentas universales más una cuenta genérica de banco y de impuesto sobre ventas, así que facturas, cuentas por pagar y pagos se contabilizan de inmediato. Sin catálogo base me salto ESE catálogo y nada más: la entidad nace igual con las cuentas de rol de CFDI y los renglones de mapeo de nómina, así que «sin catálogo» no quiere decir una entidad vacía; cuenta con unas dieciséis cuentas. Lo que no recibe es todo lo que trae el catálogo base: banco, clientes, proveedores, ingresos. Cada factura falla con MISSING_ROLE_ACCOUNT hasta que llegue la importación, y también la primera corrida de nómina: el grupo cash_payroll es obligatorio y apunta a una cuenta de banco (1111 en México, 1115 en el catálogo neutro) que sólo crea el catálogo base, y por eso `entity create` avisa de ella por su nombre. `mnemosine doctor` lista los roles sin cuenta, para que sepas qué le falta todavía a la importación.',
  'policy.non_mexican_entity_chart.if_skipped':
    'Las entidades extranjeras reciben el catálogo de la casa. Si ibas a importar su catálogo real, tendrás unas cuantas cuentas sin uso que desactivar.',
  'policy.non_mexican_entity_chart.option.base_neutro':
    'El catálogo de la casa sin el estrato fiscal mexicano (en su lugar, banco e impuesto sobre ventas genéricos)',
  'policy.non_mexican_entity_chart.option.ninguno':
    'Sin catálogo base: la entidad importa el suyo (las cuentas de rol y de nómina se crean igual)',

  'policy.depreciation_basis.question':
    '¿Qué depreciación mueve el gasto que contabilizas: la vida útil contable o la tasa fiscal?',
  'policy.depreciation_basis.impact':
    'Gobierna `depreciation run`. Con «vida_util_nif» el gasto mensual sigue la vida útil que fijas para cada activo (NIF C-6). Con «tasa_lisr» sigue la tasa fiscal guardada en cada activo, como máximo la de su clase (arts. 34-35 LISR), aplicada al monto original de la inversión sin restar el valor de desecho (art. 31 LISR), que es lo que registran la mayoría de las pymes mexicanas para que la contabilidad y la deducción no se separen; «vida_util_nif» reparte el costo menos el valor de desecho. Se calcula y se contabiliza UN solo calendario: la otra base no se lleva en paralelo. Un activo sin tasa fiscal guardada (dado de alta antes de que existieran las tasas) sigue corriendo con su vida útil, sobre el costo menos el valor de desecho, con cualquiera de las dos respuestas. Un activo que ya contabilizó renglones nunca cambia de base: si cambias esta respuesta, la corrida rechaza ese activo y dice por qué, en vez de depreciarlo con la otra base.',
  'policy.depreciation_basis.rationale':
    'Es lo que se supone que muestran los estados financieros, y es la columna que el motor ya usaba. Elegir la tasa fiscal es una simplificación legítima, pero hay que elegirla.',
  'policy.depreciation_basis.why':
    'Una máquina que esperas usar diez años se puede deducir más rápido o más despacio, según la regla que sigas. Las dos respuestas son defendibles y contabilizan importes distintos cada mes; por eso es criterio de tu despacho, no algo que yo pueda consultar.',
  'policy.depreciation_basis.what':
    'Calculo el gasto mensual con la base que elijas y anoto cuál usé en cada renglón del calendario, para que una corrida posterior pueda demostrar que conservó el mismo criterio. Si algún día cambias, los renglones ya contabilizados siguen diciendo lo que fueron.',
  'policy.depreciation_basis.if_skipped':
    'Uso la vida útil contable. Tu deducción puede entonces diferir del gasto registrado, lo cual es normal pero exige una conciliación al cierre del ejercicio.',
  'policy.depreciation_basis.option.vida_util_nif':
    'Contable: la vida útil que le asignaste al activo (NIF C-6)',
  'policy.depreciation_basis.option.tasa_lisr':
    'Fiscal: la tasa de la LISR guardada en el activo, como máximo la de su clase, para que libros y deducción coincidan',

  'policy.first_month_convention.question':
    'Un activo comprado a mediados de mes: ¿se deprecia el mes completo o sólo los días que se tuvo?',
  'policy.first_month_convention.impact':
    'Gobierna el primer y el último importe de cada activo. «mes_completo» carga el mes completo de la fecha de inicio de uso; «proporcional_dias» carga sólo los días que se tuvo y pasa el resto al último mes. A lo largo de la vida del activo el total es idéntico; lo que cambia es qué periodo lo carga y, por lo tanto, cada resultado mensual intermedio.',
  'policy.first_month_convention.rationale':
    'Es lo que cuenta la ley del impuesto sobre la renta, es más fácil de auditar y evita un importe parcial que nadie puede reproducir un año después sin conocer el día exacto de la compra.',
  'policy.first_month_convention.why':
    'Compras una máquina el día 20. Cargar el mes completo sobreestima un poco ese mes; cargar once días lo subestima y deja un remanente al final. Ninguna es incorrecta: tu despacho elige una y se queda con ella.',
  'policy.first_month_convention.what':
    'Aplico la convención que elijas al primer y al último mes de cada activo, y la anoto en el renglón del calendario para que el importe se pueda reproducir.',
  'policy.first_month_convention.if_skipped':
    'Cargo el mes completo, que coincide con cómo cuenta la ley fiscal y es la más fácil de defender de las dos.',
  'policy.first_month_convention.option.mes_completo':
    'Mes completo desde el mes en que empezó a usarse (la LISR cuenta meses completos)',
  'policy.first_month_convention.option.proporcional_dias':
    'En proporción a los días que se tuvo en el primer y el último mes',

  'policy.depreciation_missing_at_close.question':
    'Cerrar un mes con activos cuya depreciación nunca se corrió: ¿avisar o rechazar?',
  'policy.depreciation_missing_at_close.impact':
    'Gobierna el punto «Depreciación calculada y contabilizada» de la lista de verificación del cierre. Con «avisar» el mes cierra y la lista dice qué falta; con «bloquear» se rechaza el cierre hasta que se haga la corrida. Un mes cerrado sin depreciación sobreestima la utilidad y el activo, y el error se acumula porque el mes siguiente parte de un valor en libros equivocado.',
  'policy.depreciation_missing_at_close.rationale':
    'El mismo valor por omisión que las otras dos compuertas de cierre de este panel, y por la misma razón: un bloqueo duro sobre un control que apenas empieza a producir datos atoraría el primer cierre después de que salga esta función. Actívalo cuando la corrida ya sea parte de tu rutina.',
  'policy.depreciation_missing_at_close.why':
    'Olvidar la corrida de depreciación es la forma más fácil de cerrar un mes que se ve mejor de lo que fue y, a diferencia de casi cualquier error, no se corrige solo: el mes siguiente parte de un valor en libros demasiado alto.',
  'policy.depreciation_missing_at_close.what':
    'Cuento los activos vigentes sin depreciación contabilizada en el periodo y te aviso o rechazo el cierre, como elijas. En los dos casos la lista de verificación los nombra.',
  'policy.depreciation_missing_at_close.if_skipped':
    'Aviso pero dejo cerrar el mes, para que el primer mes después de que salga esta función no se atore.',
  'policy.depreciation_missing_at_close.option.avisar':
    'Avisar: el mes cierra y la lista de verificación nombra lo que falta',
  'policy.depreciation_missing_at_close.option.bloquear':
    'Rechazar: ningún mes cierra con depreciación pendiente',

  'policy.capitalization_threshold_mxn.question':
    '¿A partir de qué importe una partida se capitaliza como activo fijo en vez de ir a gasto?',
  'policy.capitalization_threshold_mxn.impact':
    'Determina cuándo el sistema pregunta «gasto o activo fijo» al cargar un CFDI. Un umbral bajo interrumpe seguido; uno alto capitaliza menos de lo que debería. También afecta la depreciación futura.',
  'policy.capitalization_threshold_mxn.rationale':
    'Es el umbral más común en la práctica mexicana. No es una regla legal: es política interna.',
  'policy.capitalization_threshold_mxn.why':
    'Cuando llega una factura de equipo tengo que decidir si es gasto de este mes o un activo que se deprecia a lo largo de años. Esa línea es política de tu empresa, no una regla del SAT: la ley fija tasas de depreciación, no el umbral para capitalizar.',
  'policy.capitalization_threshold_mxn.what':
    'Por encima de ese importe me detengo y te pregunto caso por caso en vez de decidir solo. Por debajo, lo registro como gasto sin interrumpirte.',
  'policy.capitalization_threshold_mxn.if_skipped':
    'Sigo preguntando a partir de $20,000, lo que puede interrumpirte más (o menos) de lo que quieres.',
  'policy.capitalization_threshold_mxn.option.5000':
    '$5,000 — conservador, capitaliza casi todo el equipo',
  'policy.capitalization_threshold_mxn.option.20000':
    '$20,000 — común en las pymes mexicanas',
  'policy.capitalization_threshold_mxn.option.50000':
    '$50,000 — sólo inversiones significativas',

  'policy.restaurant_meal_treatment.question':
    'Consumos en restaurantes (deducibles al 8.5%): ¿cómo se registran?',
  'policy.restaurant_meal_treatment.impact':
    'Define si el sistema divide cada consumo en dos renglones (deducible / no deducible) o manda todo a no deducible y el ajuste se hace en la declaración. Afecta la conciliación contable-fiscal.',
  'policy.restaurant_meal_treatment.rationale':
    'Mantiene los libros alineados con la deducción real sin trabajo extra al cierre.',
  'policy.restaurant_meal_treatment.why':
    'La ley del impuesto sobre la renta sólo te deja deducir el 8.5% de los consumos en restaurantes. El otro 91.5% es un gasto real pero no deducible, y mezclarlos complica la conciliación fiscal al cierre del ejercicio.',
  'policy.restaurant_meal_treatment.what':
    'Divido cada factura de restaurante en dos renglones —deducible y no deducible— o la mando completa a no deducible, lo que elijas.',
  'policy.restaurant_meal_treatment.if_skipped':
    'Divido 8.5/91.5, lo que mantiene los libros alineados pero añade un renglón a cada consumo.',
  'policy.restaurant_meal_treatment.option.split_85':
    'Dividir en la póliza 8.5% deducible / 91.5% no deducible',
  'policy.restaurant_meal_treatment.option.no_deducible':
    'Todo a no deducible; se ajusta en la declaración',

  'policy.ieps_treatment.question':
    '¿La empresa es contribuyente del IEPS y lo traslada?',
  'policy.ieps_treatment.impact':
    'Si no lo es, el IEPS que le trasladan forma parte del costo. Si lo es, es acreditable. Determina la cuenta de cada compra con IEPS (combustible, bebidas, tabaco).',
  'policy.ieps_treatment.rationale':
    'La mayoría de las empresas no son contribuyentes del IEPS (LIEPS art. 4).',
  'policy.ieps_treatment.why':
    'El IEPS sólo es acreditable si tu empresa es contribuyente de ese impuesto y lo traslada. Para todos los demás forma parte del costo de los bienes. Por la factura no puedo saber en qué caso estás.',
  'policy.ieps_treatment.what':
    'Decide la cuenta de cada compra que lleva IEPS: combustible, bebidas, tabaco.',
  'policy.ieps_treatment.if_skipped':
    'Lo trato como costo, lo que es correcto para la mayoría de las empresas pero subestima tu impuesto acreditable si eres contribuyente del IEPS.',
  'policy.ieps_treatment.option.costo':
    'No es contribuyente: el IEPS forma parte del costo',
  'policy.ieps_treatment.option.acreditable':
    'Es contribuyente: el IEPS es acreditable',

  'policy.fees_without_withholding.question':
    'Una persona física (régimen 612) le factura servicios profesionales a tu empresa y el CFDI no declara ISR retenido. ¿Qué pasa?',
  'policy.fees_without_withholding.impact':
    'Gobierna los CFDI recibidos de una persona física del régimen 612 cuyos conceptos son todos servicios profesionales (legales, consultoría, contabilidad, ingeniería, desarrollo de software, médicos): una compra de bienes, o un CFDI con algún concepto que no sea uno de esos servicios, nunca se toma por honorarios. «request_substitute_cfdi» deja el CFDI en espera en la bandeja, no escribe nada en el mayor y dice que se le pida al proveedor un CFDI sustituto con la retención. «withhold_by_law» calcula el 10 % de ISR y las dos terceras partes del IVA con legal_parameters y deja esa póliza en revisión. «record_as_issued» contabiliza el CFDI tal como viene, sin retención, y la lista de verificación del cierre lo muestra en honorarios sin retención.',
  'policy.fees_without_withholding.rationale':
    'Una persona moral que paga honorarios sin retener es responsable solidaria del impuesto (CFF 26-I) y el gasto puede no ser deducible (LISR 27-V). El CFDI es de un tercero: el remedio limpio es un sustituto del proveedor, y no se registra nada sobre una cifra que va a cambiar.',
  'policy.fees_without_withholding.why':
    'Cuando tu empresa le paga servicios profesionales a una persona física tiene que retener parte del ISR y del IVA. Si la factura no muestra la retención, o el proveedor se equivocó o el pago se va a hacer completo. Esperar una factura corregida, retener de todos modos o registrarla como vino es decisión de tu despacho.',
  'policy.fees_without_withholding.what':
    'Por omisión dejo la factura en espera y te digo que le pidas un sustituto al proveedor. Con «withhold_by_law» propongo la póliza con la retención que exige la ley y la dejo para que la revises. Con «record_as_issued» la contabilizo como vino y la listo en la lista de verificación del cierre.',
  'policy.fees_without_withholding.if_skipped':
    'Dejo esas facturas en espera hasta que llegue un CFDI sustituto con la retención: nada llega a tus libros.',
  'policy.fees_without_withholding.option.request_substitute_cfdi':
    'Dejarlo en espera y pedirle al proveedor un CFDI sustituto con la retención',
  'policy.fees_without_withholding.option.withhold_by_law':
    'Calcular la retención de ley y dejar la póliza en revisión',
  'policy.fees_without_withholding.option.record_as_issued':
    'Registrarlo como se emitió, con un aviso en la lista de verificación del cierre',

  'policy.withholding_mismatch.question':
    "¿Qué pasa cuando un CFDI recibido declara una retención (ISR o IVA) distinta de la que la ley le exige a tu empresa como retenedora?",
  'policy.withholding_mismatch.impact':
    "Gobierna los CFDI recibidos sobre los que una persona moral retiene por ley (honorarios o arrendamiento de una persona física, fletes, una persona física del RESICO) y cuya retención declarada difiere de la de ley más allá del redondeo; los honorarios del régimen 612 que no declaran ISR retenido siguen fees_without_withholding. «request_substitute_cfdi» deja el CFDI en espera en la bandeja, no escribe nada en el mayor y dice que se le pida al proveedor un CFDI sustituto. «withhold_by_law» propone la póliza con la retención de ley y la deja en revisión. «record_as_issued» contabiliza el CFDI con la retención que declara, y la lista de verificación del cierre lo muestra en honorarios sin retención.",
  'policy.withholding_mismatch.rationale':
    "Quien paga es responsable solidario del impuesto que debió retener (CFF 26-I) y el gasto sólo es deducible si la retención se hizo y se enteró (LISR 27-V). El CFDI es de un tercero: el remedio limpio es un sustituto del proveedor, y no se registra nada sobre una cifra que va a cambiar.",
  'policy.withholding_mismatch.why':
    "Cuando tu empresa retiene por ley, la factura tiene que mostrar la misma retención que exige la ley. Si muestra otra, o el proveedor se equivocó o el caso no es el que describe la ley. Esperar una factura corregida, aplicar de todos modos la retención de ley o registrarla como vino es decisión de tu despacho.",
  'policy.withholding_mismatch.what':
    "Por omisión dejo la factura en espera y te digo que le pidas un sustituto al proveedor. Con «withhold_by_law» propongo la póliza con la retención de ley y la dejo para que la revises. Con «record_as_issued» la contabilizo como vino y la listo en la lista de verificación del cierre.",
  'policy.withholding_mismatch.if_skipped':
    "Dejo esas facturas en espera y te pregunto por cada una: nada llega a tus libros hasta que llegue un sustituto o contestes.",
  'policy.withholding_mismatch.option.request_substitute_cfdi':
    "Dejarlo en espera y pedirle al proveedor un CFDI sustituto",
  'policy.withholding_mismatch.option.withhold_by_law':
    "Registrar la retención de ley y dejar la póliza en revisión",
  'policy.withholding_mismatch.option.record_as_issued':
    "Registrarlo como se declaró, con un aviso en la lista de verificación del cierre",

  'policy.inventory_method.question':
    '¿La empresa lleva inventarios perpetuos?',
  'policy.inventory_method.impact':
    'Si los lleva, las compras de mercancía van a inventario y el costo se reconoce al vender. Si no, van directo a costo. Cambia la póliza de cada compra de mercancía o materia prima.',
  'policy.inventory_method.rationale':
    'Mientras no se defina se pregunta caso por caso; el valor por omisión evita inventar inventarios.',
  'policy.inventory_method.why':
    'Si llevas inventarios perpetuos, una compra de mercancía va a inventario y el costo se reconoce cuando vendes. Si no, va directo a costo de ventas. La factura se ve idéntica en los dos casos.',
  'policy.inventory_method.what':
    'Cambia la póliza de cada compra de mercancía o materia prima.',
  'policy.inventory_method.if_skipped':
    'Te pregunto caso por caso en cada compra de mercancía, lo que es seguro pero repetitivo.',
  'policy.inventory_method.option.perpetuos':
    'Sí: compras a inventario, costo al vender',
  'policy.inventory_method.option.directo':
    'No: compras directo a costo de ventas',

  'policy.cfdi_from_closed_period.question':
    'Un CFDI de un periodo ya cerrado: ¿en qué periodo se registra?',
  'policy.cfdi_from_closed_period.impact':
    'Define si el sistema propone el periodo abierto actual o marca el documento para reabrir el periodo original. Afecta la comparabilidad de los estados financieros.',
  'policy.cfdi_from_closed_period.rationale':
    'Sin política definida, cada caso se escala en vez de suponerse.',
  'policy.cfdi_from_closed_period.why':
    'Una factura de diciembre que llega en febrero no tiene un lugar obvio: registrarla en el periodo cerrado rompe la comparabilidad, registrarla hoy distorsiona el mes en curso. Cada despacho lo resuelve distinto.',
  'policy.cfdi_from_closed_period.what':
    'Decide si propongo el periodo abierto actual, marco el documento para reabrir el original o te pregunto cada vez.',
  'policy.cfdi_from_closed_period.if_skipped':
    'Te pregunto cada vez, que es el valor por omisión más seguro pero el que más interrumpe.',
  'policy.cfdi_from_closed_period.option.periodo_actual':
    'Registrar en el periodo abierto actual',
  'policy.cfdi_from_closed_period.option.preguntar':
    'Preguntar caso por caso',
  'policy.cfdi_from_closed_period.option.reabrir':
    'Reabrir el periodo original (requiere autorización)',

  'policy.cfdi_reconciliation_tolerance.question':
    'Cuando un borrador aprobado se coteja contra su CFDI, ¿cuánta diferencia por cifra sigue contando como redondeo?',
  'policy.cfdi_reconciliation_tolerance.impact':
    'Aprobar el borrador de un CFDI recibido crea la cuenta por pagar, y la póliza aprobada tiene que coincidir con el XML cifra por cifra: total, IVA trasladado, cada retención y subtotal menos descuento. Una diferencia dentro de la tolerancia pasa; una mayor deshace la aprobación completa y nombra la cifra. La diferencia nunca se absorbe moviendo centavos a otra cuenta.',
  'policy.cfdi_reconciliation_tolerance.rationale':
    'El SAT acepta diferencias de redondeo en los impuestos por concepto (Anexo 20), y un centavo por cifra es lo que produce ese redondeo. Más de un centavo no es redondeo: es otro importe distinto del que ampara el CFDI (CFF 29 y 29-A; LIVA art. 5 fracc. II y III).',
  'policy.cfdi_reconciliation_tolerance.why':
    'Cuando apruebas la póliza de una factura de proveedor, la cotejo contra el XML. Necesito saber cuánto redondeo aceptas antes de rechazarla.',
  'policy.cfdi_reconciliation_tolerance.what':
    'Dentro de la tolerancia creo la cuenta por pagar y contabilizo la póliza. Fuera de ella rechazo la aprobación y te digo qué cifra no cuadra y por cuánto.',
  'policy.cfdi_reconciliation_tolerance.if_skipped':
    'Acepto un centavo por cifra.',
  'policy.cfdi_reconciliation_tolerance.option.0_01':
    'Un centavo por cifra — sólo redondeo verdadero',
  'policy.cfdi_reconciliation_tolerance.option.0':
    'Coincidencia exacta o nada',

  'policy.bill_lines_source.question':
    'Cuando un borrador aprobado crea la cuenta por pagar, ¿de dónde salen sus renglones?',
  'policy.bill_lines_source.impact':
    'El encabezado de la cuenta por pagar (subtotal, impuestos, total) siempre sale del CFDI. Esto decide los renglones: tu propia codificación en la póliza aprobada, o un renglón por concepto del CFDI. Los conceptos sólo toman cuenta cuando la póliza se divide uno a uno con ellos; si no, la aprobación se rechaza, nunca se prorratea.',
  'policy.bill_lines_source.rationale':
    'A qué cuentas va un gasto es una decisión interna de quien lo registra: varios conceptos pueden ir a una cuenta, o un concepto puede dividirse. La póliza aprobada ya guarda esa decisión, y la cuenta por pagar debe reflejarla en vez de imponer al mayor la redacción del proveedor.',
  'policy.bill_lines_source.why':
    'Algunos despachos quieren que la cuenta por pagar se lea como la factura del proveedor, concepto por concepto; otros quieren que siga cómo codificaron el gasto.',
  'policy.bill_lines_source.what':
    'Por omisión cada cargo no fiscal de la póliza que aprobaste se vuelve un renglón de la cuenta por pagar. Con «conceptos_cfdi» copio los conceptos y rechazo cuando tu póliza no se divide igual.',
  'policy.bill_lines_source.if_skipped':
    'Los renglones de la cuenta por pagar siguen la póliza que aprobaste.',
  'policy.bill_lines_source.option.poliza':
    'Un renglón por cada cargo no fiscal de la póliza aprobada, con su cuenta y su importe',
  'policy.bill_lines_source.option.conceptos_cfdi':
    'Un renglón por concepto del CFDI (descripción, cantidad, clave SAT); se rechaza si la póliza no se divide uno a uno',

  'policy.unknown_vendor_on_approval.question':
    'Cuando apruebas el borrador de un CFDI recibido cuyo emisor no está en el catálogo de proveedores, ¿qué pasa?',
  'policy.unknown_vendor_on_approval.impact':
    'Aprobar crea la cuenta por pagar, y una cuenta por pagar necesita un proveedor dado de alta. Darlo de alta crea una contraparte con el nombre y el RFC escritos dentro del XML de un tercero. O se rechaza la aprobación hasta que alguien dé de alta al proveedor, o `mnemosine review` te pregunta, y tu sí da de alta al proveedor, la cuenta por pagar y la póliza en una sola transacción.',
  'policy.unknown_vendor_on_approval.rationale':
    'Es la regla que ya sigue `bill inbox run`: no se crea ningún proveedor sin un acto explícito de una persona, y aprobar una póliza no es, por sí solo, aprobar datos maestros nuevos.',
  'policy.unknown_vendor_on_approval.why':
    'Algunos despachos dan de alta a propósito a cada proveedor antes de registrar nada; otros prefieren confirmar un proveedor nuevo mientras revisan su primera factura.',
  'policy.unknown_vendor_on_approval.what':
    'Por omisión rechazo la aprobación, no se contabiliza nada y te digo el comando que da de alta al proveedor. Con «preguntar», la revisión te pregunta, y sólo tu sí crea al proveedor.',
  'policy.unknown_vendor_on_approval.if_skipped':
    'Rechazo la aprobación hasta que el proveedor esté dado de alta.',
  'policy.unknown_vendor_on_approval.option.rechazar':
    'Rechazar la aprobación y nombrar el comando que da de alta al proveedor',
  'policy.unknown_vendor_on_approval.option.preguntar':
    'Preguntar en `mnemosine review` si se da de alta al proveedor; un no quiere decir rechazar',

  'policy.rep_payment_not_recorded.question':
    'Llega un complemento de pago (REP) y no hay un pago registrado que le corresponda: ¿qué pasa?',
  'policy.rep_payment_not_recorded.impact':
    'Decide si cargar un REP puede mover dinero por su cuenta. Crear el pago es lo que libera el IVA pendiente, porque la liberación cuelga de las aplicaciones del pago; pero también quiere decir que el sistema mueve el banco sin que una persona lo haya registrado.',
  'policy.rep_payment_not_recorded.rationale':
    'El REP es prueba documental de que el dinero ya se movió: trae la fecha y la forma de pago. Crear el pago lo hace pasar por la única puerta que además libera el IVA. Una tercera opción —contabilizar el efectivo directo, sin registro de pago— NO se ofrece a propósito: es lo que registra dos veces el movimiento del banco cuando el pago también se capturó a mano, y deja el IVA pendiente para siempre. No hay comportamiento anterior con el cual ser compatible, porque esta puerta nunca funcionó: un CFDI de tipo P moría con UNSUPPORTED_TYPE antes de llegar a contabilizarse.',
  'policy.rep_payment_not_recorded.why':
    'Cuando tu proveedor manda el complemento de una factura que pagaste, puedo tomarlo como el registro de ese pago o esperar a que alguien lo confirme. Los despachos que capturan los movimientos del banco a diario quieren confirmar; los que registran directo desde los CFDI quieren que lo tome.',
  'policy.rep_payment_not_recorded.what':
    'Con «crear_pago» registro el pago y lo aplico a las facturas que nombra el complemento, que es lo que me deja acreditar el IVA que estaba esperando. Con «revision» archivo el complemento y te pregunto.',
  'policy.rep_payment_not_recorded.if_skipped':
    'Creo el pago. Si también capturas pagos a mano, dímelo; si no, podríamos terminar con el mismo pago dos veces.',
  'policy.rep_payment_not_recorded.option.crear_pago':
    'Crear el pago y aplicarlo a cada documento relacionado',
  'policy.rep_payment_not_recorded.option.revision':
    'Registrar el complemento y dejar el vínculo para que una persona lo confirme',

  'policy.rep_amount_tolerance.question':
    '¿Cuánta diferencia entre el complemento y el pago registrado sigue contando como redondeo?',
  'policy.rep_amount_tolerance.impact':
    'Se usa dos veces: para decidir si un pago capturado a mano es el mismo evento que el complemento, y para comparar el IVA que declara el complemento (ImpuestosDR) contra el prorrateo sobre la factura. Fuera de ella, el complemento va a revisión: casar un pago que no es el mismo acredita IVA por un importe distinto del que de verdad se pagó.',
  'policy.rep_amount_tolerance.rationale':
    'La comparación se hace por documento relacionado, no complemento contra pago, y el prorrateo del IVA ya liquida su remanente en la última parcialidad. Una diferencia mayor a un centavo no es redondeo: es otra parcialidad, otro tipo de cambio u otro pago.',
  'policy.rep_amount_tolerance.why':
    'Los complementos y tus propios registros rara vez difieren, pero cuando lo hacen importa si es un centavo de redondeo o un pago completamente distinto.',
  'policy.rep_amount_tolerance.what':
    'Dentro de la tolerancia los caso. Fuera de ella dejo el complemento para que lo revises.',
  'policy.rep_amount_tolerance.if_skipped':
    'Acepto un centavo.',
  'policy.rep_amount_tolerance.option.0_01':
    'Un centavo — sólo redondeo verdadero',
  'policy.rep_amount_tolerance.option.1_00':
    'Un peso',
  'policy.rep_amount_tolerance.option.0':
    'Coincidencia exacta o nada',

  'policy.rep_unknown_document.question':
    'El complemento nombra una factura que el sistema no tiene: ¿qué pasa con ese IVA?',
  'policy.rep_unknown_document.impact':
    'Sin la factura original no hay base para prorratear el IVA de esa parcialidad. Decide si el complemento espera en revisión hasta que una persona corre mnemosine rep reconcile, ya con su factura en el sistema, o si los documentos que conoce siguen como siempre y la parte y el IVA del desconocido nunca se registran desde este complemento.',
  'policy.rep_unknown_document.rationale':
    'Las descargas masivas del SAT llegan en desorden, así que un complemento que llega antes que su factura es normal, no excepcional. El IVA no se pierde: se queda pendiente, que es justo donde lo quiere el art. 5 fracc. III de la LIVA hasta que un documento lo ampare. Cuando el complemento SÍ trae ImpuestosDR, esa cifra se coteja contra el prorrateo sobre la factura original: si difieren más allá de la tolerancia, el complemento va a revisión en vez de liberar cualquiera de las dos cifras en silencio.',
  'policy.rep_unknown_document.why':
    'Los complementos suelen llegar antes que la factura a la que se refieren. Puedo dejar pendiente el traslado del impuesto hasta que aparezca la factura, o seguir sin él.',
  'policy.rep_unknown_document.what':
    'Por omisión dejo el complemento en revisión. Nada lo reintenta solo: cuando su factura ya está en el sistema, correr mnemosine rep reconcile lo liga.',
  'policy.rep_unknown_document.if_skipped':
    'Espero. No se pierde nada: el impuesto se queda donde estaba.',
  'policy.rep_unknown_document.option.esperar':
    'Esperar: todo el pago del complemento espera en revisión, con las facturas conocidas que paga, y no se traslada nada de su IVA',
  'policy.rep_unknown_document.option.postear_sin_iva':
    'Casar el efectivo y dejar el IVA sin trasladar, con un aviso',
  'policy.rep_unknown_document.option.preguntar':
    'Igual que «Esperar»: el complemento espera en revisión y no se pide importe de IVA. Se conserva para los despachos que ya la eligieron.',

  'policy.rep_voided_document.question':
    'Un pago de un complemento (REP) cubre una factura viva y otra que los libros anularon: ¿qué pasa?',
  'policy.rep_voided_document.impact':
    'Aplica a un complemento que la entidad emitió. Con «review» todo el pago espera a una persona, así que el IVA de la factura viva sigue como no cobrado hasta entonces. Con «post_live_documents» el pago se registra sólo por las facturas vivas y su IVA se libera; la parte de la factura anulada queda sin registrar, con un aviso guardado en el complemento.',
  'policy.rep_voided_document.rationale':
    'Un complemento se emite sólo cuando el dinero efectivamente se recibe (SAT, Guía de llenado del complemento para recepción de pagos, Apéndice 6, pregunta 11), así que uno que nombra una factura que los libros anularon los contradice, y sólo una persona puede decir cuál está mal; el ADR-0006 elige la opción que no registra sin revisión, como hace `rep_documento_desconocido` al esperar. Un despacho que contabiliza directo de los CFDI puede registrar los documentos vivos, cuyo IVA se causa cuando se cobra (LIVA arts. 1o.-B, 11 y 17).',
  'policy.rep_voided_document.why':
    'Cuando un movimiento de banco paga varias facturas y una de ellas está anulada o cancelada en los libros, o el complemento o los libros están mal. Unos despachos quieren aclararlo antes de registrar nada; otros quieren cobrar de una vez las facturas que sí siguen en pie.',
  'policy.rep_voided_document.what':
    'Por omisión mando todo el pago a revisión y nombro la factura anulada. Con «post_live_documents» cobro las facturas vivas, no aplico nada a la anulada y guardo un aviso que la nombra.',
  'policy.rep_voided_document.if_skipped':
    'Todo el pago va a revisión, nombrando la factura anulada.',
  'policy.rep_voided_document.option.review':
    'Revisión: detener todo el pago y nombrar la factura anulada',
  'policy.rep_voided_document.option.post_live_documents':
    'Registrar las facturas vivas y dejar la anulada sin registrar, con un aviso',

  'policy.rep_match_window_days.question':
    '¿Cuántos días de diferencia puede haber entre la fecha del complemento y la del pago registrado para que sigan siendo el mismo evento?',
  'policy.rep_match_window_days.impact':
    'Una ventana demasiado estrecha produce falsos negativos, y un falso negativo termina en un pago duplicado, que es justo el daño que el cotejo existe para evitar.',
  'policy.rep_match_window_days.rationale':
    'La fecha es una heurística de cotejo, no un hecho fiscal: lo que revisa el SAT son los importes y la cadena de parcialidades. Los pagos capturados a mano suelen llevar la fecha del estado de cuenta y no la fecha valor, y tres días cubren esa brecha sin abarcar dos parcialidades del mismo documento.',
  'policy.rep_match_window_days.why':
    'Tus registros y el complemento rara vez traen exactamente la misma fecha. ¿Qué tan separadas pueden estar antes de que deje de suponer que son el mismo pago?',
  'policy.rep_match_window_days.what':
    'Dentro de la ventana los considero el mismo evento y los vinculo en vez de crear un segundo pago.',
  'policy.rep_match_window_days.if_skipped':
    'Acepto tres días.',
  'policy.rep_match_window_days.option.0':
    'Exactamente el mismo día',
  'policy.rep_match_window_days.option.3':
    'Tres días naturales',
  'policy.rep_match_window_days.option.15':
    'Quince días, para captura mensual',

  'policy.prepaid_amortization_convention.question':
    'Un pago anticipado que empieza a mediados de mes: ¿el primer mes se devenga completo o sólo por los días que cubre?',
  'policy.prepaid_amortization_convention.impact':
    'Fija cada mes del calendario. Una póliza de seguro del 20 de marzo al 19 de marzo se devenga en 12 meses con una convención y en 13 con la otra, y el último mes del ejercicio cambia.',
  'policy.prepaid_amortization_convention.rationale':
    'Es lo que de verdad dice el postulado de devengación contable (NIF A-1, cap. 20) —el gasto pertenece al periodo que consumió el servicio— y es la única convención que mantiene el calendario atado a las fechas del contrato y no al calendario. Los despachos que prefieren meses completos por sencillez pueden decirlo aquí, pero el valor por omisión debe ser el correcto y no el fácil.',
  'policy.prepaid_amortization_convention.why':
    'Tu seguro empieza el día 20, no el 1. Por días se reparte en trece meses de calendario y por meses completos en doce, así que la elección cambia qué mes carga el gasto y qué muestra el último mes del año.',
  'policy.prepaid_amortization_convention.what':
    'Devengo los días que de verdad cubre cada mes.',
  'policy.prepaid_amortization_convention.if_skipped':
    'Devengo por días.',
  'policy.prepaid_amortization_convention.option.proporcional_dias':
    'Por días: el primer y el último mes sólo devengan los días cubiertos',
  'policy.prepaid_amortization_convention.option.meses_completos':
    'Meses completos: el mes inicial devenga completo y el último no',

  'policy.prepaid_amortization_missing_at_close.question':
    'Cerrar un mes con calendarios de pagos anticipados cuya amortización nunca se corrió: ¿avisar o rechazar?',
  'policy.prepaid_amortization_missing_at_close.impact':
    'Un calendario sin correr quiere decir que falta el gasto de ese mes y que el activo está sobreestimado por el mismo importe. Es exactamente la forma del defecto que este sistema ya corrigió para la depreciación.',
  'policy.prepaid_amortization_missing_at_close.rationale':
    'Es la misma respuesta que el despacho ya tiene para la depreciación, y aquí la coherencia entre dos situaciones idénticas importa más que la elección misma: una lista de verificación en la que un devengo bloquea y el otro avisa no le enseña nada a nadie.',
  'policy.prepaid_amortization_missing_at_close.why':
    'Si un calendario nunca se corrió, al mes que estás cerrando le falta ese gasto y el pago anticipado está sobreestimado por el mismo importe; y lo firmarías de todos modos.',
  'policy.prepaid_amortization_missing_at_close.what':
    'Lo señalo en la lista de verificación del cierre y te dejo decidir.',
  'policy.prepaid_amortization_missing_at_close.if_skipped':
    'Aviso.',
  'policy.prepaid_amortization_missing_at_close.option.avisar':
    'Avisar: el punto de la lista de verificación se pone en rojo y el cierre sigue',
  'policy.prepaid_amortization_missing_at_close.option.bloquear':
    'Rechazar: el periodo no cierra hasta que se corra cada calendario',

  'policy.prepaid_threshold_mxn.question':
    '¿Por encima de qué importe un gasto de varios periodos se difiere a pagos anticipados en vez de ir a gasto de una vez?',
  'policy.prepaid_threshold_mxn.impact':
    'Por debajo del umbral el importe completo pega en el mes en que se pagó; por encima, se crea un calendario y el gasto se reparte. `prepaid create` lee tu respuesta y se detiene por debajo de ella salvo que pases --force con un motivo. Al cargar, el clasificador de CFDI también compara contra tu respuesta: sólo ofrece diferir importes iguales o mayores (5,000 MXN hasta que respondas).',
  'policy.prepaid_threshold_mxn.rationale':
    'Importancia relativa (NIF A-4): una suscripción anual de 900 pesos partida en doce pólizas de 75 cuesta más en registro que la precisión que compra, y llena el calendario de renglones que nadie va a revisar. Cinco mil es el orden de magnitud en el que la división empieza a pagarse sola.',
  'policy.prepaid_threshold_mxn.why':
    'No toda suscripción anual vale la pena repartirla en doce meses; tú decides dónde está la línea.',
  'policy.prepaid_threshold_mxn.what':
    'Ofrezco diferir los gastos de varios periodos iguales o mayores a tu umbral (5,000 MXN por omisión) y mando a gasto el resto conforme llegan.',
  'policy.prepaid_threshold_mxn.if_skipped':
    'Uso 5,000 MXN.',
  'policy.prepaid_threshold_mxn.option.0':
    'Sin umbral: diferir todo gasto de varios periodos',
  'policy.prepaid_threshold_mxn.option.5000':
    '5,000 MXN',
  'policy.prepaid_threshold_mxn.option.20000':
    '20,000 MXN',

  'policy.benefit_accrual_wage_base.question':
    '¿Qué salario diario usa como base la provisión mensual de prestaciones?',
  'policy.benefit_accrual_wage_base.impact':
    'Fija el importe de cada devengo de aguinaldo, vacaciones y prima vacacional. El salario integrado es mayor que el nominal, así que la elección mueve la provisión —y la utilidad reportada— cada mes.',
  'policy.benefit_accrual_wage_base.rationale':
    'El salario nominal es la cifra que el despacho de verdad pactó y la que ya tiene la nómina. El SDI es una base de SEGURIDAD SOCIAL (LSS art. 27) hecha para calcular cuotas, y tomarlo prestado para un devengo de la NIF D-3 mete una convención fiscal en una cifra de información financiera. El despacho que lo quiera lo declara; el sistema no infla un pasivo por su cuenta.',
  'policy.benefit_accrual_wage_base.why':
    'El salario nominal y el integrado dan provisiones distintas, y las dos son defendibles. Sólo tu despacho sabe qué convención sigue.',
  'policy.benefit_accrual_wage_base.what':
    'Devengo las prestaciones sobre el salario diario nominal.',
  'policy.benefit_accrual_wage_base.if_skipped':
    'Uso el salario diario nominal.',
  'policy.benefit_accrual_wage_base.option.nominal':
    'Salario diario nominal — lo que dice el contrato',
  'policy.benefit_accrual_wage_base.option.integrado':
    'Salario diario integrado (SDI) — incluye las prestaciones que integra el art. 84 de la LFT',

  'policy.vacation_accrual_timing.question':
    '¿Cuándo se reconoce el pasivo de vacaciones?',
  'policy.vacation_accrual_timing.impact':
    'Decide si la provisión de vacaciones crece mes a mes o aparece completa en el aniversario laboral de cada empleado. El total anual es el mismo; la forma de once de los doce estados mensuales, no.',
  'policy.vacation_accrual_timing.rationale':
    'La NIF D-3 reconoce un beneficio a corto plazo conforme el empleado PRESTA el servicio, no cuando el derecho se vuelve exigible. Devengar en el aniversario concentra doce meses de costo en uno, que es justo la distorsión que la base de devengado existe para quitar. La alternativa sigue disponible porque el art. 76 de la LFT sí hace nacer el derecho en esa fecha, y algunos despachos informan con esa lectura.',
  'policy.vacation_accrual_timing.why':
    'La ley hace nacer el derecho en el aniversario; la norma contable lo reconoce conforme se gana. Las dos lecturas existen en la práctica.',
  'policy.vacation_accrual_timing.what':
    'Devengo las vacaciones en proporción al tiempo laborado, mes a mes.',
  'policy.vacation_accrual_timing.if_skipped':
    'Devengo en proporción.',
  'policy.vacation_accrual_timing.option.proporcional':
    'Mes a mes, en proporción al tiempo laborado',
  'policy.vacation_accrual_timing.option.aniversario':
    'Completo en el aniversario, cuando nace el derecho',

  'policy.monthly_ptu_accrual.question':
    '¿El despacho provisiona la PTU cada mes o sólo al cierre del ejercicio?',
  'policy.monthly_ptu_accrual.impact':
    'Una provisión mensual de PTU necesita una ESTIMACIÓN de la utilidad fiscal del año, que es un juicio. Provisionar sólo al cierre deja once meses sin el cargo y un duodécimo que lo lleva todo.',
  'policy.monthly_ptu_accrual.rationale':
    'Un devengo mensual de PTU descansa en la estimación de una cifra que no existirá hasta la declaración anual, y una provisión construida sobre una suposición es peor que una ausencia revelada: parece una medición. El despacho que tiene un pronóstico confiable la activa y se hace cargo de la estimación.',
  'policy.monthly_ptu_accrual.why':
    'La PTU es el 10 % de la utilidad fiscal (LFT art. 120) y esa utilidad no se conoce hasta que cierra el año. Estimarla cada mes es decisión de tu despacho, no mía.',
  'policy.monthly_ptu_accrual.what':
    'Registro la PTU al cierre del ejercicio, cuando ya se conoce la utilidad fiscal.',
  'policy.monthly_ptu_accrual.if_skipped':
    'La registro sólo al cierre del ejercicio.',
  'policy.monthly_ptu_accrual.option.no':
    'Sólo al cierre del ejercicio, cuando se conoce la utilidad fiscal',
  'policy.monthly_ptu_accrual.option.si':
    'Cada mes, sobre la utilidad fiscal estimada',

  'policy.aguinaldo_days_per_year.question':
    '¿Cuántos días de aguinaldo otorga el despacho por año de servicio?',
  'policy.aguinaldo_days_per_year.impact':
    'Lo leen dos cálculos. El finiquito (finiquito-calculator.ts) prorratea estos días por año sobre los días trabajados en el año de la baja. La provisión mensual de prestaciones (provisions-run.ts, `payroll accrue` y el cierre) devenga aguinaldo sobre ellos cada mes. Los dos comparan el valor contra el mínimo legal vigente a su fecha (LFT art. 87) y se niegan a calcular por debajo de él.',
  'policy.aguinaldo_days_per_year.rationale':
    'El art. 87 de la LFT fija quince días como piso, y un piso es la única cifra que el sistema puede suponer sin conocer el contrato. Lo que pase de ahí es una prestación que otorgó el patrón y debe declararse, nunca adivinarse.',
  'policy.aguinaldo_days_per_year.why':
    'La ley fija un mínimo de quince días; muchos despachos pagan más, y yo no puedo saber cuál es el tuyo.',
  'policy.aguinaldo_days_per_year.what':
    'Calculo el aguinaldo con los días por año que fijes, en proporción al tiempo laborado.',
  'policy.aguinaldo_days_per_year.if_skipped':
    'Uso el mínimo legal de quince días.',
  'policy.aguinaldo_days_per_year.option.15':
    '15 días — el mínimo legal (LFT art. 87)',
  'policy.aguinaldo_days_per_year.option.20':
    '20 días',
  'policy.aguinaldo_days_per_year.option.30':
    '30 días (un mes)',

  'policy.vacation_premium_pct.question':
    '¿Qué prima vacacional paga el despacho sobre los días de vacaciones ganados?',
  'policy.vacation_premium_pct.impact':
    'Se aplica igual al finiquito y a la provisión mensual de vacaciones.',
  'policy.vacation_premium_pct.rationale':
    'El mismo razonamiento que el aguinaldo: el art. 80 de la LFT fija el 25 % como piso, y el piso es la única cifra que es seguro suponer. Un despacho que paga más otorga una prestación, y una prestación se declara, no se infiere.',
  'policy.vacation_premium_pct.why':
    'La ley fija el 25 % como prima vacacional mínima; la tuya puede ser mayor.',
  'policy.vacation_premium_pct.what':
    'Aplico el 25 % sobre los días de vacaciones ganados.',
  'policy.vacation_premium_pct.if_skipped':
    'Uso el mínimo legal del 25 %.',
  'policy.vacation_premium_pct.option.0_25':
    '25 % — el mínimo legal (LFT art. 80)',
  'policy.vacation_premium_pct.option.0_50':
    '50 %',
  'policy.vacation_premium_pct.option.1_00':
    '100 %',

  'policy.usmo_isr_subsidy.question':
    'Para el ISR de la separación, ¿el ISR del último sueldo mensual ordinario (USMO) se toma bruto de tarifa, o neto del subsidio para el empleo?',
  'policy.usmo_isr_subsidy.impact':
    'El art. 96 LISR, en su párrafo de los pagos del art. 95, retiene el ISR de una prima de antigüedad o de una indemnización a una tasa: el ISR del último sueldo mensual ordinario entre ese sueldo. Lo lee el finiquito (finiquito-calculator.ts), cuyo ISR de la separación retiene la parte gravada a esa tasa. Neto del subsidio baja la tasa, así que se retiene menos.',
  'policy.usmo_isr_subsidy.rationale':
    'El art. 96 LISR, en su párrafo de los pagos del art. 95 (el antepenúltimo; el art. 172 RLISR descuenta de esos pagos la exención), divide «el impuesto correspondiente al último sueldo mensual ordinario» entre ese sueldo. El subsidio para el empleo es un crédito contra el ISR retenido, no impuesto causado, así que el impuesto que corresponde es el de la tarifa. Bruto es la lectura que eligió el dueño en MNE-001-373 (ADR-0006, decisión 1); neto del subsidio es la otra lectura, y retiene menos.',
  'policy.usmo_isr_subsidy.why':
    'La ley arma la tasa de la separación con el ISR del último sueldo mensual, y no dice si ese ISR resta el subsidio para el empleo. Lo decide tu despacho.',
  'policy.usmo_isr_subsidy.what':
    'Tomo el ISR del último sueldo mensual ordinario por la tarifa mensual, sin restar el subsidio, y el finiquito retiene la parte gravada de la separación a ese ISR entre el sueldo.',
  'policy.usmo_isr_subsidy.if_skipped':
    'Lo tomo bruto de tarifa, sin restar el subsidio.',
  'policy.usmo_isr_subsidy.option.gross_of_tariff':
    'El ISR del USMO por la tarifa mensual, sin restar el subsidio para el empleo',
  'policy.usmo_isr_subsidy.option.net_of_subsidy':
    'El ISR del USMO por la tarifa mensual, menos el subsidio para el empleo que tendría ese sueldo',

  'policy.usmo_days_per_month.question':
    '¿Cuántos días hacen el último sueldo mensual ordinario (USMO) de un finiquito: 30 o 30.4?',
  'policy.usmo_days_per_month.impact':
    'El USMO es el salario diario por estos días, y sobre él se arma el ISR de la separación del art. 96 LISR, en su párrafo de los pagos del art. 95. Lo lee el finiquito (finiquito-calculator.ts), que informa el USMO en su desglose, compara con él los pagos por separación y divide entre él. Con un salario diario de 300.00 el USMO es 9,000.00 a 30 días y 9,120.00 a 30.4.',
  'policy.usmo_days_per_month.rationale':
    'El art. 89 LFT divide un salario mensual entre treinta para obtener el salario diario, así que el sueldo mensual ordinario de un salario diario es ese salario × 30; el art. 96 LISR, en su párrafo de los pagos del art. 95, arma la tasa de la separación sobre ese sueldo. 30 es la lectura que eligió el dueño en MNE-001-373 (ADR-0006, decisión 1); 30.4 es la otra lectura, el mes con el que prorratean la tarifa mensual y el decreto del subsidio.',
  'policy.usmo_days_per_month.why':
    'La ley nombra el último sueldo mensual ordinario pero no dice cuántos días tiene un mes. Lo decide tu despacho.',
  'policy.usmo_days_per_month.what':
    'Calculo el USMO como salario diario × 30; el finiquito compara con él los pagos por separación y arma sobre él la tasa de retención.',
  'policy.usmo_days_per_month.if_skipped':
    'Uso 30 días.',
  'policy.usmo_days_per_month.option.30':
    'Salario diario × 30 (el art. 89 LFT divide un salario mensual entre treinta)',
  'policy.usmo_days_per_month.option.30_4':
    'Salario diario × 30.4 (el mes de la tarifa mensual)',

  'policy.separation_isr_usmo_comparison.question':
    'Para el ISR de la separación, ¿con qué se compara el último sueldo mensual ordinario (USMO) para elegir entre la tarifa mensual y la tasa del USMO: con el total pagado por la separación, o sólo con su parte gravada?',
  'policy.separation_isr_usmo_comparison.impact':
    'El art. 96 LISR, en su párrafo de los pagos del art. 95, retiene una prima de antigüedad o una indemnización al ISR del USMO entre el USMO, y aplica en su lugar la tarifa mensual cuando «los pagos» son inferiores al USMO. Lo lee el ISR de la separación del finiquito (separation-isr.ts). Cuando la parte gravada queda debajo del USMO y el total pagado no, comparar el total retiene a la tasa, más que la tarifa sobre la parte gravada sola.',
  'policy.separation_isr_usmo_comparison.rationale':
    'El art. 96 LISR aplica la tasa a «el ingreso total por este concepto» y pasa a la tarifa «Cuando los pagos por estos conceptos sean inferiores al último sueldo mensual ordinario»: la palabra es los pagos, así que el total pagado es la lectura literal, y, bruto de tarifa, nunca retiene de menos, porque la tasa media de la tarifa sube con el ingreso. Comparar sólo la parte gravada sigue al art. 172 RLISR, que descuenta del total del art. 95 la exención del art. 93 fr. XIII LISR, como arma el CFDI de nómina su IngresoAcumulable; es la otra práctica común. Es el valor conservador, por ADR-0006; lo retenido de más se acredita en el cálculo anual.',
  'policy.separation_isr_usmo_comparison.why':
    'La ley compara «los pagos» con el último sueldo mensual sin decir si cuenta su parte exenta. Comparar el total retiene más veces a la tasa del USMO; comparar sólo la parte gravada aplica más veces la tarifa mensual. Lo decide tu despacho.',
  'policy.separation_isr_usmo_comparison.what':
    'Comparo el total pagado por la separación con el USMO: debajo de él, la tarifa mensual sobre la parte gravada; si no, la tasa del USMO sobre la parte gravada.',
  'policy.separation_isr_usmo_comparison.if_skipped':
    'Comparo el total pagado.',
  'policy.separation_isr_usmo_comparison.option.total_payments':
    'El total pagado por la separación, con su parte exenta (los «pagos» literales del art. 96 LISR)',
  'policy.separation_isr_usmo_comparison.option.taxable_payments':
    'Sólo la parte gravada, después de la exención de 90 UMA (art. 172 RLISR)',

  'policy.cash_flow_method.question':
    '¿El estado de flujos de efectivo se presenta por el método indirecto o por el directo?',
  'policy.cash_flow_method.impact':
    'Decide la cara completa del estado. Antes de G1b el motor aceptaba un parámetro `method`, lo repetía en la respuesta y NUNCA cambiaba una cifra: cada llamada que pedía el método directo recibía el indirecto, rotulado como directo.',
  'policy.cash_flow_method.rationale':
    'La NIF B-2 permite los dos y la práctica mexicana presenta de forma abrumadora el indirecto: se deriva de los mismos saldos que ya tiene la balanza, mientras que el directo necesita que cada movimiento de efectivo se clasifique por concepto en el momento en que se registra. Ofrecer «directo» sobre datos que nunca se clasificaron para eso produciría un estado que se ve bien y no lo está.',
  'policy.cash_flow_method.why':
    'Los dos métodos presentan el mismo efectivo de forma distinta, y la presentación es una decisión del despacho, no un cálculo.',
  'policy.cash_flow_method.what':
    'Armo el estado por el método indirecto y lo rotulo así.',
  'policy.cash_flow_method.if_skipped':
    'Uso el método indirecto.',
  'policy.cash_flow_method.option.indirecto':
    'Indirecto: partir de la utilidad neta y ajustar por partidas que no son efectivo y por movimientos del capital de trabajo',
  'policy.cash_flow_method.option.directo':
    'Directo: cobros y pagos brutos por concepto (clientes, proveedores, empleados, impuestos)',

  'policy.cash_flow_cash_accounts.question':
    '¿Qué cuentas cuentan como «efectivo y equivalentes de efectivo» al cuadrar el estado de flujos de efectivo?',
  'policy.cash_flow_cash_accounts.impact':
    'El estado sólo quiere decir algo si su movimiento neto es igual al cambio real del efectivo, y para eso hay que saber qué cuentas SON efectivo. Antes de G1b la clasificación corría sobre nombres de cuenta comparados con ILIKE «%receivable%» y «%payable%» —en inglés, contra un catálogo de cuentas que este mismo producto siembra en español—, así que no casaba con nada y el capital de trabajo salía en cero.',
  'policy.cash_flow_cash_accounts.rationale':
    'El mapa de roles es la capa semántica que este sistema ya usa en todos lados para responder «qué cuenta es ésta»: sobrevive a renombres, traducciones y catálogos importados, que es justo lo que no hacen los nombres de cuenta. Comparar por nombre es como llegó aquí ese defecto.',
  'policy.cash_flow_cash_accounts.why':
    'Para cuadrar el estado de flujos de efectivo tengo que saber qué cuentas guardan el efectivo del que habla.',
  'policy.cash_flow_cash_accounts.what':
    'Tomo las cuentas mapeadas a los roles de banco y caja.',
  'policy.cash_flow_cash_accounts.if_skipped':
    'Uso el mapa de roles.',
  'policy.cash_flow_cash_accounts.option.rol':
    'Por rol: las cuentas que account_roles marca como banco y caja',
  'policy.cash_flow_cash_accounts.option.subtipo':
    'Por subtipo: cuentas de activo circulante marcadas expresamente como efectivo',
  'policy.cash_flow_cash_accounts.option.lista':
    'Una lista de códigos de cuenta que declara el despacho',

  'policy.cash_flow_mismatch.question':
    'Cuando el estado de flujos de efectivo no es igual al movimiento real del efectivo, ¿lo publico, nombro la diferencia o me niego?',
  'policy.cash_flow_mismatch.impact':
    'Un estado de flujos de efectivo que no cuadra con el efectivo es el único estado financiero cuyo error se puede probar desde fuera: cualquiera lo puede comparar contra el banco. Absorber el residuo en un renglón esconde justo lo que el lector habría detectado.',
  'policy.cash_flow_mismatch.rationale':
    'Negarse dejaría al despacho sin un estado que puede necesitar para un plazo de presentación, y el silencio es como se firma un estado equivocado. Nombrar el residuo mantiene el documento utilizable y pone la discrepancia donde la va a ver quien lo prepara, y el auditor.',
  'policy.cash_flow_mismatch.why':
    'El estado derivado y el movimiento real del efectivo pueden no coincidir. Es el único estado financiero que cualquiera puede revisar contra tu banco, así que si la diferencia se dice o se entierra lo decides tú, no yo.',
  'policy.cash_flow_mismatch.what':
    'Publico el estado y digo la diferencia contra el efectivo real, con su importe.',
  'policy.cash_flow_mismatch.if_skipped':
    'Lo publico y nombro la diferencia.',
  'policy.cash_flow_mismatch.option.avisar':
    'Publicarlo con la diferencia dicha y cuantificada',
  'policy.cash_flow_mismatch.option.bloquear':
    'Negarse a emitir el estado hasta que cuadre',
  'policy.cash_flow_mismatch.option.silencio':
    'Publicar el neto calculado sin contrastarlo',

  'policy.diot_default_operation_type.question':
    'Un proveedor nacional sin tipo de operación declarado: ¿con cuál lo reporta la DIOT?',
  'policy.diot_default_operation_type.impact':
    'La DIOT reporta a cada proveedor con un tipo de operación. Para un proveedor nacional el catálogo 2025 ofrece 02 enajenación de bienes, 03 servicios profesionales, 06 uso o goce temporal de bienes, 08 importación por transferencia virtual y 85 otros. Es por PROVEEDOR, no por factura, así que un valor por omisión equivocado está mal todos los meses hasta que alguien lo corrige. Los proveedores extranjeros tienen su propia clave, diot_default_operation_type_foreign.',
  'policy.diot_default_operation_type.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1: 85 «Otros» es la clave residual para un proveedor nacional cuya operación no es una de las específicas (02 bienes, 03 servicios profesionales, 06 uso de bienes, 08 importación por transferencia virtual). El mayor no sabe si un proveedor sin declarar vendió bienes o servicios, así que afirmar 02, 03 o 06 por omisión pondría una afirmación concreta a tu nombre; 85 sólo afirma que no se capturó una clave específica, y cada proveedor que la toma se lista para que se afinen los que importan. 08 no se ofrece como valor por omisión: exige un pedimento aduanal y no puede ser una respuesta general. Negarse bloquearía una declaración mensual por una clasificación que no cambia el impuesto.',
  'policy.diot_default_operation_type.why':
    'El formato clasifica a cada proveedor por el tipo de operación que tienes con él; los que llevan una clave específica me los tienes que decir.',
  'policy.diot_default_operation_type.what':
    'Reporto con 85 a los proveedores nacionales sin tipo declarado, y los listo para que afines los que importan.',
  'policy.diot_default_operation_type.if_skipped':
    'Uso 85 y te digo qué proveedores la tomaron.',
  'policy.diot_default_operation_type.option.85':
    'Otros (85) — la clave residual que da el catálogo',
  'policy.diot_default_operation_type.option.02':
    'Enajenación de bienes (02)',
  'policy.diot_default_operation_type.option.03':
    'Servicios profesionales (03)',
  'policy.diot_default_operation_type.option.06':
    'Uso o goce temporal de bienes (06)',
  'policy.diot_default_operation_type.option.bloquear':
    'Ninguno: negarse a armar la DIOT hasta que cada proveedor declare uno',

  'policy.diot_default_operation_type_foreign.question':
    'Un proveedor extranjero sin tipo de operación declarado: ¿con cuál lo reporta la DIOT?',
  'policy.diot_default_operation_type_foreign.impact':
    'Para un proveedor extranjero (tipo de tercero 05) el catálogo de la DIOT 2025 sólo acepta 02 enajenación de bienes, 03 servicios profesionales y 07 importación de bienes o servicios. 85 y 06 no se aceptan, así que el valor por omisión nacional no se puede reutilizar para ellos.',
  'policy.diot_default_operation_type_foreign.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1 limita a un proveedor extranjero a 02, 03 y 07. Según el art. 24 de la LIVA (frac. I–V), introducir bienes, o adquirir o usar en México intangibles o servicios que presta un no residente, es una IMPORTACIÓN, así que 07 es la clave que describe lo que hizo la entidad en el caso habitual, y coincide con las casillas de importación donde el archivo ya pone ese IVA. 02 y 03 siguen disponibles para un despacho cuyos proveedores extranjeros se describan mejor así; un proveedor distinto declara su propia clave.',
  'policy.diot_default_operation_type_foreign.why':
    'Los proveedores extranjeros no pueden usar la clave nacional «otros», y el archivo se rechaza si la llevan.',
  'policy.diot_default_operation_type_foreign.what':
    'Reporto con 07 a los proveedores extranjeros sin tipo declarado, y los listo.',
  'policy.diot_default_operation_type_foreign.if_skipped':
    'Uso 07 y te digo qué proveedores la tomaron.',
  'policy.diot_default_operation_type_foreign.option.07':
    'Importación de bienes o servicios (07)',
  'policy.diot_default_operation_type_foreign.option.03':
    'Servicios profesionales (03)',
  'policy.diot_default_operation_type_foreign.option.02':
    'Enajenación de bienes (02)',
  'policy.diot_default_operation_type_foreign.option.block':
    'Ninguno: negarse a armar la DIOT hasta que cada proveedor extranjero declare uno',

  'policy.diot_third_party_without_rfc.question':
    'Un proveedor con RFC faltante, inválido o genérico al armar la DIOT: ¿negarse o reportarlo como global?',
  'policy.diot_third_party_without_rfc.impact':
    'La DIOT identifica a cada proveedor nacional por su RFC. Hoy el sistema detecta un RFC VACÍO y nada más: ni uno mal formado ni el genérico XAXX010101000, que es precisamente el valor que convierte a un proveedor real en uno anónimo en la declaración.',
  'policy.diot_third_party_without_rfc.rationale':
    'El tipo 15 existe para las ventas genuinas al público en general, no como cajón para proveedores cuyo RFC nadie capturó. Usarlo así presenta una declaración que dice que esas operaciones no tuvieron una contraparte identificable, lo cual es una afirmación sobre tus libros y no una elección de formato; y es justo el tipo de cosa que la autoridad cruza contra las declaraciones de los propios proveedores.',
  'policy.diot_third_party_without_rfc.why':
    'Un proveedor sin RFC válido no se puede identificar en la declaración, y la alternativa a detenerse es declarar que esas compras no tuvieron una contraparte conocida.',
  'policy.diot_third_party_without_rfc.what':
    'Me niego a armar la DIOT y nombro a los proveedores cuyo RFC falta, está mal formado o es genérico.',
  'policy.diot_third_party_without_rfc.if_skipped':
    'Me niego y los nombro.',
  'policy.diot_third_party_without_rfc.option.bloquear':
    'Negarse a armarla y nombrar a los proveedores',
  'policy.diot_third_party_without_rfc.option.declarar_global':
    'Reportarlos con el tipo 15 (global, público en general)',

  'policy.diot_exempt_vat_and_base.question':
    '¿Cómo se reportan los actos exentos cuando el documento de origen no traía su base?',
  'policy.diot_exempt_vat_and_base.impact':
    'La DIOT declara el VALOR de los actos, no sólo el impuesto. Un renglón exento no trae importe de impuesto y, hasta ahora, el lector lo descartaba por completo: un nodo exento de CFDI 4.0 tiene TipoFactor="Exento" y no tiene Importe, así que se tiraba en silencio.',
  'policy.diot_exempt_vat_and_base.rationale':
    'La actividad exenta no es la ausencia de una operación: es una operación que la DIOT quiere contada, y subestimarla subestima el total que la autoridad concilia contra tu declaración de IVA. Derivarla del subtotal acierta tan seguido que es peligroso: se rompe en silencio en cualquier renglón que mezcle conceptos exentos y gravados. La base se captura al cargar: cada renglón de la cuenta por pagar guarda como valor de los actos la Base que su CFDI declaró en el traslado de IVA, así que exigirla es exigir algo que el documento ya dijo. Una Base que el CFDI omitió se queda desconocida —nunca se rellena a partir de un importe—, y lo mismo la base de cada renglón armado desde la póliza aprobada cuando algún concepto de ese CFDI la omitió; a las cuentas por pagar registradas antes de que existiera la captura también les falta.',
  'policy.diot_exempt_vat_and_base.why':
    'Las compras exentas cuentan igual en la declaración, y son aquellas cuyo importe el sistema tiraba sin decírselo a nadie.',
  'policy.diot_exempt_vat_and_base.what':
    'Me detengo y nombro los documentos cuya base exenta se desconoce, en vez de adivinarla.',
  'policy.diot_exempt_vat_and_base.if_skipped':
    'Exijo la base y nombro lo que falta.',
  'policy.diot_exempt_vat_and_base.option.exigir_base':
    'Exigir la base: negarse a reportar un periodo con renglones exentos cuyo valor se desconoce',
  'policy.diot_exempt_vat_and_base.option.derivar_del_subtotal':
    'Derivarla del subtotal del renglón',
  'policy.diot_exempt_vat_and_base.option.omitir_y_avisar':
    'Dejar fuera esos renglones y listarlos',

  'policy.diot_creditable_iva_proportion.question':
    '¿Esta entidad acredita su IVA con la proporción del art. 5 frac. V de la LIVA?',
  'policy.diot_creditable_iva_proportion.impact':
    'El formato de carga masiva de la DIOT 2025 divide el IVA acreditable de cada proveedor en dos casillas: el IVA ligado EXCLUSIVAMENTE a actividades gravadas y el IVA al que se aplicó una proporción porque la entidad también tiene actividades exentas o no objeto. El mayor acredita cada peso de IVA pagado; todavía no calcula esa proporción.',
  'policy.diot_creditable_iva_proportion.rationale':
    'El art. 5 frac. V de la LIVA sólo exige la proporción cuando el contribuyente también realiza actividades exentas o no objeto; un despacho cuyas actividades están todas gravadas acredita el IVA completo, y eso es justo lo que el mayor ya registra en iva_acreditable. Declararlo en la casilla de exclusivamente gravadas (instructivo DIOT del SAT, Enero 2025, §3.3) mantiene el archivo igual a los libros y a la declaración mensual de IVA. La DIOT rechaza este valor por omisión cuando el mayor muestra ingresos exentos en el ejercicio (cuentas mapeadas al agrupador 401.07–401.09), y una entidad que aplica la proporción debe responder «block»: las casillas proporcionales todavía no se calculan aquí, y un factor que nadie calculó no se declara.',
  'policy.diot_creditable_iva_proportion.why':
    'Sólo tú sabes si la entidad también tiene actividades exentas, y eso decide en qué casilla de la DIOT va su IVA acreditable.',
  'policy.diot_creditable_iva_proportion.what':
    'Declaro todo el IVA pagado como ligado exclusivamente a actividades gravadas, y me detengo si el mayor muestra ingresos exentos.',
  'policy.diot_creditable_iva_proportion.if_skipped':
    'Lo declaro como exclusivamente gravado y te lo recuerdo en cada DIOT; responde «block» si la entidad aplica la proporción.',
  'policy.diot_creditable_iva_proportion.option.taxed_only':
    'No: todas las actividades están gravadas, así que todo el IVA pagado va a la casilla de exclusivamente gravadas',
  'policy.diot_creditable_iva_proportion.option.block':
    'Sí: negarse a generar el archivo de carga masiva hasta que exista el tratamiento proporcional (captura en el portal)',

  'policy.efirma_sealing_e_accounting.question':
    '¿El sistema sella los archivos del Anexo 24 con tu e.firma, o los sellas tú?',
  'policy.efirma_sealing_e_accounting.impact':
    'Sellar quiere decir que este software carga y usa la llave privada del contribuyente. Los archivos que produce son una declaración ante la autoridad fiscal firmada a tu nombre.',
  'policy.efirma_sealing_e_accounting.rationale':
    'La e.firma es el contribuyente firmando, no el software. Producir el archivo y firmarlo son actos distintos y corresponden a manos distintas: este sistema arma el XML, te muestra lo que contiene y se detiene. La bóveda existe para las credenciales que el sistema de verdad necesita; la firma de una declaración no es una de ellas. Los despachos que decidan otra cosa pueden decirlo aquí, y entonces cada descifrado queda en bitácora; pero por omisión tu llave nunca entra a este proceso.',
  'policy.efirma_sealing_e_accounting.why':
    'Sellar un archivo del Anexo 24 quiere decir que este software usa tu llave privada para firmar una declaración a tu nombre. No es un detalle técnico que yo pueda suponer por ti: es tu firma.',
  'policy.efirma_sealing_e_accounting.what':
    'Armo el XML sin sellar y te lo entrego; el sellado y el envío son tuyos.',
  'policy.efirma_sealing_e_accounting.if_skipped':
    'Nunca sello: tu llave no entra a este proceso.',
  'policy.efirma_sealing_e_accounting.option.nunca_sellar_en_el_sistema':
    'Nunca: el sistema produce el XML sin sellar y tú lo sellas y lo envías',
  'policy.efirma_sealing_e_accounting.option.sellar_con_custodia':
    'Sellar aquí, con la llave guardada en la bóveda de credenciales y cada uso en bitácora',

  'policy.anexo24_account_without_grouping_code.question':
    'Generar el catálogo del Anexo 24 con cuentas sin código agrupador: ¿negarse o emitirlas?',
  'policy.anexo24_account_without_grouping_code.impact':
    'El nodo CtaCatalogo exige CodigoAgrupador en cada cuenta. Una cuenta sin él o se queda fuera del archivo —y la balanza hace referencia a una cuenta que el catálogo no declara— o entra vacía y el XSD la rechaza.',
  'policy.anexo24_account_without_grouping_code.rationale':
    'Emitir un catálogo incompleto es peor que no emitir ninguno: la balanza que se presenta después hace referencia a cuentas que el catálogo nunca declaró, y esa incongruencia es justo lo que la autoridad valida entre declaraciones. Detenerse cuesta una sesión de mapeo; presentar un catálogo que contradice la balanza cuesta un rechazo con el plazo ya vencido.',
  'policy.anexo24_account_without_grouping_code.why':
    'Cada cuenta del archivo necesita su código agrupador del SAT, y puedo detenerme y decirte cuáles faltan o entregarte un catálogo que no coincide con la balanza que vas a presentar después.',
  'policy.anexo24_account_without_grouping_code.what':
    'Me niego a generar y nombro las cuentas a las que les falta su código agrupador.',
  'policy.anexo24_account_without_grouping_code.if_skipped':
    'Me niego y las nombro.',
  'policy.anexo24_account_without_grouping_code.option.bloquear':
    'Negarse a generar hasta que cada cuenta lleve su código agrupador',
  'policy.anexo24_account_without_grouping_code.option.omitir_y_avisar':
    'Dejarlas fuera del archivo y listarlas',
  'policy.anexo24_voucher_money_without_trace.question':
    'Una póliza mueve dinero del banco sin un pago registrado detrás (una comisión, intereses, una nómina, un traspaso entre cuentas propias): ¿qué hacen las pólizas del Anexo 24?',
  'policy.anexo24_voucher_money_without_trace.impact':
    'Decide si `e-accounting voucher generate` entrega un mes con esos asientos. «block» rechaza el archivo (código 4) y nombra cada póliza hasta que se capture un pago con su rastro. «warn» lo entrega sin nodo de pago y nombra cada póliza. Ninguna toca el mayor. Declarar un nodo OtrMetodoPago no se ofrece: el XSD exige su Benef y su RFC, y sin un pago registrado el mayor no tiene ninguno de los dos, así que se inventarían.',
  'policy.anexo24_voucher_money_without_trace.rationale':
    'En PolizasPeriodo 1.3 (Anexo 24 de la RMF) los nodos Cheque, Transferencia y OtrMetodoPago son opcionales y cada uno «se convierte en requerido» cuando hay una salida o entrada de recursos por ese método; Transferencia también es requerido en toda transacción entre cuentas propias del contribuyente (la documentación del XSD de cada nodo). Sin un pago registrado el sistema no sabe cuál de esos casos es el asiento, y un archivo al que le falta un nodo requerido es contabilidad incompleta (CFF 28-IV). Por eso, por omisión, se rechaza y se nombra la póliza. Un despacho cuyos asientos sin rastro son cargos del banco que ningún instrumento movió puede contestar «warn».',
  'policy.anexo24_voucher_money_without_trace.why':
    'Las comisiones e intereses del banco mueven dinero que ningún cheque ni transferencia tuya movió. Si tu despacho presenta esas pólizas sin nodo de pago o captura antes un pago, es criterio tuyo.',
  'policy.anexo24_voucher_money_without_trace.what':
    'Aplico tu respuesta a cada póliza que mueve dinero del banco sin un pago registrado, y siempre nombro cada una.',
  'policy.anexo24_voucher_money_without_trace.if_skipped':
    'Rechazo el archivo y nombro cada póliza.',
  'policy.anexo24_voucher_money_without_trace.option.block':
    'Rechazar el archivo hasta que cada una tenga un pago registrado con su rastro',
  'policy.anexo24_voucher_money_without_trace.option.warn':
    'Entregar el archivo sin nodo de pago y listar las pólizas',

  'policy.chart_parent_child_coherence.question':
    '¿Una subcuenta puede estar en una sección de los estados distinta de la de su cuenta padre?',
  'policy.chart_parent_child_coherence.impact':
    'Hoy nada ata una cuenta hija a su padre, así que una cuenta de gasto puede colgar de un activo y todos los estados siguen sumando: el importe simplemente aparece en la sección equivocada de un documento que alguien firma. Medido sobre los 80 pares padre-hija que siembra este producto, exigir la MISMA CATEGORÍA fallaría once veces (1200 «Activo Fijo» es non_current_assets bajo 1000 «Activo», que es current_assets, y eso es contabilidad correcta); exigir la misma SECCIÓN se cumple en los 80. Por eso la igualdad no se ofrece: rechazaría el catálogo que el propio producto trae.',
  'policy.chart_parent_child_coherence.rationale':
    'Una cifra en la sección equivocada de un estado firmado no se detecta más adelante: el estado cuadra de cualquier modo. Negarse cuesta una cuenta corregida en el momento en que alguien ya está mirando el catálogo; dejarla pasar cuesta encontrarla en una declaración. Una cuenta sin fs_category en ninguno de los dos lados NO se juzga: la importación del SAT la deja vacía en los dos lados de cada arista que crea, y una regla que leyera la ausencia como falta detendría a un despacho que migra su propio catálogo.',
  'policy.chart_parent_child_coherence.why':
    'Tu catálogo ya tiene padres e hijas, y puedo mantener una subcuenta dentro de la sección de su padre o dejarte ponerla donde el catálogo la necesite.',
  'policy.chart_parent_child_coherence.what':
    'Rechazo una subcuenta cuya categoría cae en una sección distinta de la de su padre, y nombro a las dos.',
  'policy.chart_parent_child_coherence.if_skipped':
    'La rechazo y nombro los dos lados.',
  'policy.chart_parent_child_coherence.option.exigir_misma_seccion':
    'Rechazar la cuenta: una subcuenta se queda en la sección de su padre',
  'policy.chart_parent_child_coherence.option.advertir_misma_seccion':
    'Nombrarla y dejarla pasar',
  'policy.chart_parent_child_coherence.option.sin_regla':
    'Sin regla: el catálogo es asunto del despacho',

  'policy.anexo24_levels_to_report.question':
    '¿Qué niveles del catálogo entran en el catálogo del Anexo 24?',
  'policy.anexo24_levels_to_report.impact':
    'El archivo declara la jerarquía con SubCtaDe y Nivel. Presentar sólo los niveles superiores esconde el detalle que la autoridad usa para seguir una póliza; presentarlo todo expone un catálogo que puede traer cuentas analíticas internas.',
  'policy.anexo24_levels_to_report.rationale':
    'El catálogo es el mapa contra el que la autoridad lee la balanza y las pólizas, así que una cuenta que aparece en cualquiera de las dos tiene que aparecer aquí. Recortarlo crea referencias que el archivo no puede resolver, y la jerarquía es precisamente lo que SubCtaDe existe para llevar.',
  'policy.anexo24_levels_to_report.why':
    'El archivo tiene que declarar la jerarquía de tu catálogo, y qué tan hondo llega decide si una declaración posterior puede hacer referencia a una cuenta que este catálogo nunca mencionó.',
  'policy.anexo24_levels_to_report.what':
    'Incluyo el catálogo completo con su estructura de padres e hijas.',
  'policy.anexo24_levels_to_report.if_skipped':
    'Incluyo todas las cuentas con su jerarquía.',
  'policy.anexo24_levels_to_report.option.jerarquia_completa':
    'Todas las cuentas, con su padre y su nivel',
  'policy.anexo24_levels_to_report.option.hasta_nivel_2':
    'Sólo rubros y cuentas de primer nivel',
  'policy.anexo24_levels_to_report.option.las_que_se_mueven':
    'Sólo las cuentas con movimiento contabilizado, más sus padres',

  'policy.grouping_code_gate_scope.question':
    '¿Qué cuentas tienen que llevar código agrupador del SAT antes de poder presentar la contabilidad?',
  'policy.grouping_code_gate_scope.impact':
    'Decide a quién acusa la compuerta. Hoy filtra por account_level <= 2, lo que en un catálogo real reportó 43 faltantes, de los cuales 42 eran cuentas sin ningún movimiento, mientras que la única cuenta que SÍ se había movido sin código agrupador no se reportó. Falla en las dos direcciones.',
  'policy.grouping_code_gate_scope.rationale':
    'Lo que lee el SAT es la balanza y las pólizas, así que una cuenta que nunca se movió no puede agrupar mal nada. Acusar al catálogo completo entierra la única cuenta que importa bajo decenas que no importan, que es justo como una compuerta deja de leerse.',
  'policy.grouping_code_gate_scope.why':
    'Un catálogo de cuentas siempre tiene renglones a los que nadie contabiliza nunca. Avisarte de ellos es ruido, y el ruido es como un aviso deja de leerse; pero la cuenta que SÍ se movió y no tiene código agrupador es una declaración que no puedes presentar.',
  'policy.grouping_code_gate_scope.what':
    'Sólo señalo las cuentas que de verdad se movieron en el periodo que se presenta.',
  'policy.grouping_code_gate_scope.if_skipped':
    'Señalo las cuentas con movimiento.',
  'policy.grouping_code_gate_scope.option.cuentas_con_movimientos':
    'Sólo las cuentas con movimiento contabilizado en el periodo',
  'policy.grouping_code_gate_scope.option.todas_las_de_detalle':
    'Todas las cuentas de detalle, con o sin movimiento',
  'policy.grouping_code_gate_scope.option.todas':
    'Todas las cuentas del catálogo',

  'policy.grouping_code_missing_at_close.question':
    'Cerrar un mes con cuentas que se movieron y no tienen código agrupador del SAT: ¿avisar o rechazar?',
  'policy.grouping_code_missing_at_close.impact':
    'Sin código agrupador esas cuentas no pueden entrar en el catálogo del Anexo 24, así que la declaración de ese mes es imposible hasta que alguien las mapee.',
  'policy.grouping_code_missing_at_close.rationale':
    'El cierre es un acto contable y el código agrupador es un requisito de la declaración: bloquear los libros por un catálogo fiscal confunde dos obligaciones con plazos distintos. El aviso es lo que te da los días entre el cierre y la presentación para arreglarlo.',
  'policy.grouping_code_missing_at_close.why':
    'Cerrar el mes y presentarlo al SAT son dos plazos distintos, y una cuenta sin mapear sólo rompe el segundo; así que es razonable que quieras cerrar de todos modos y mapear antes de presentar.',
  'policy.grouping_code_missing_at_close.what':
    'Pongo el punto en rojo en la lista de verificación del cierre, con las cuentas, y dejo que el cierre siga.',
  'policy.grouping_code_missing_at_close.if_skipped':
    'Aviso y las nombro.',
  'policy.grouping_code_missing_at_close.option.avisar':
    'Avisar: el punto de la lista de verificación se pone en rojo y el cierre sigue',
  'policy.grouping_code_missing_at_close.option.bloquear':
    'Negarse a cerrar hasta que cada cuenta con movimiento esté mapeada',

  'policy.grouping_code_outside_catalog.question':
    'Un código agrupador que no está en el catálogo oficial del SAT de ese año: ¿aceptar o rechazar?',
  'policy.grouping_code_outside_catalog.impact':
    'La autoridad revisa el catálogo c_CodAgrup, así que un código válido en 2022 puede no serlo en 2026, y una declaración se valida contra el catálogo vigente en su ejercicio.',
  'policy.grouping_code_outside_catalog.rationale':
    'Un código agrupador inválido no falla aquí: falla en el SAT, después de que el archivo se selló con la e.firma y se envió, cuando el plazo ya corrió. Detectarlo al capturar cuesta un mensaje; detectarlo en la autoridad fiscal cuesta una declaración rechazada.',
  'policy.grouping_code_outside_catalog.why':
    'El SAT publica y revisa este catálogo, así que un código que era correcto hace dos años puede estar mal hoy; y el archivo sólo se rechaza después de que ya lo sellaste y lo enviaste.',
  'policy.grouping_code_outside_catalog.what':
    'Rechazo un código agrupador que no esté en el catálogo vigente de ese año, y digo cuál es.',
  'policy.grouping_code_outside_catalog.if_skipped':
    'Rechazo los códigos fuera del catálogo.',
  'policy.grouping_code_outside_catalog.option.rechazar':
    'Rechazar: el código tiene que existir en el catálogo vigente',
  'policy.grouping_code_outside_catalog.option.avisar':
    'Aceptarlo y avisar',

  'policy.anexo24_trial_balance_opening_balance.question':
    '¿De dónde sale el saldo inicial de la balanza de comprobación del Anexo 24?',
  'policy.anexo24_trial_balance_opening_balance.impact':
    'El SAT recalcula SaldoIni + Debe − Haber = SaldoFin sobre la balanza presentada. Hoy el saldo inicial sólo lo siembra el cierre DURO, así que una entidad que sólo hace cierres blandos presentaría ceros en todas las cuentas: una declaración sellada de que la empresa abrió el mes en nada.',
  'policy.anexo24_trial_balance_opening_balance.rationale':
    'El mayor ya tiene la respuesta y la capa de informes ya sabe cómo pedirla, así que derivarlo cuesta una consulta y es verdad sea cual sea el estado del periodo. Exigir un cierre duro haría depender una obligación de presentación de una ceremonia contable interna que la ley no menciona.',
  'policy.anexo24_trial_balance_opening_balance.why':
    'Tu saldo inicial sólo se guarda cuando un periodo se cierra en duro, y la declaración lo necesita cada mes; así que o lo tomo del mayor o me niego a armar la balanza.',
  'policy.anexo24_trial_balance_opening_balance.what':
    'Derivo el saldo inicial de todo lo contabilizado antes del periodo, sea cual sea su estado de cierre.',
  'policy.anexo24_trial_balance_opening_balance.if_skipped':
    'Lo derivo del mayor.',
  'policy.anexo24_trial_balance_opening_balance.option.derivar_del_mayor':
    'Derivarlo del mayor: sumar todo lo contabilizado antes de que empiece el periodo',
  'policy.anexo24_trial_balance_opening_balance.option.exigir_cierre_duro':
    'Exigir un cierre duro: negarse a armar la balanza sin un saldo inicial sembrado',

  'policy.opening_balance_load_mode.question':
    'Cuando se carga la balanza de apertura del Anexo 24, ¿se contabiliza o se deja como borrador?',
  'policy.opening_balance_load_mode.impact':
    'Contabilizar pone la apertura en el mayor en el mismo acto, después del --dry-run y el --yes. Un borrador la deja fuera del mayor hasta que alguien corre `entry post` sobre ella, para que una segunda persona la revise antes; sus renglones y su fecha no se pueden editar, porque mover la fecha dejaría que una segunda carga duplicara cada saldo.',
  'policy.opening_balance_load_mode.rationale':
    'La carga ya muestra el informe completo con --dry-run y pregunta antes de escribir, y la comprobación al centavo la compara después contra el origen. Un borrador añade un segundo paso que sólo se paga cuando otra persona revisa la apertura antes de aplicarla.',
  'policy.opening_balance_load_mode.why':
    'Algunos despachos quieren que una segunda persona mire la apertura migrada antes de que llegue al mayor; otros la cargan ellos mismos.',
  'policy.opening_balance_load_mode.what':
    'Contabilizo la apertura cuando se confirma la carga, o dejo un borrador bloqueado para `entry post`.',
  'policy.opening_balance_load_mode.if_skipped':
    'La contabilizo.',
  'policy.opening_balance_load_mode.option.contabilizar':
    'Contabilizarla: la apertura queda en el mayor en cuanto se confirma la carga',
  'policy.opening_balance_load_mode.option.borrador':
    'Dejar un borrador: `entry post` lo aplica después de una revisión',

  'policy.census_cfdi_types.question':
    '¿Qué tipos de CFDI del censo del SAT cuentan para la completitud al cierre?',
  'policy.census_cfdi_types.impact':
    'El censo del SAT lista todos los CFDI emitidos y recibidos: ingreso (I), egreso (E), pago (P), nómina (N) y traslado (T). Se guardan todos los tipos; esto decide cuáles reporta como faltantes la revisión de completitud cuando no están contabilizados. Añadir N compara la nómina que la entidad timbró con la que contabilizó.',
  'policy.census_cfdi_types.rationale':
    'Decisión del dueño del 2026-09-26 en la issue 312: la nómina y los traslados no salen como faltantes por omisión. I, E y P son los CFDI que soportan los asientos de ingresos, compras y su cobro o pago (CFF art. 29 y 29-A; LISR art. 27 fr. III; LIVA art. 5 fr. II). Un CFDI de nómina (N, LISR art. 99 fr. III) soporta un gasto que el módulo de nómina contabiliza en conjunto, no un asiento por recibo, y un CFDI de traslado (T) ampara mercancía en tránsito sin contraprestación, así que ninguno corresponde uno a uno con un documento contabilizado. Un despacho que también concilia su nómina timbrada elige N.',
  'policy.census_cfdi_types.why':
    'El SAT también lista recibos de nómina y documentos de traslado. Hay despachos que los cotejan con los libros y otros que no.',
  'policy.census_cfdi_types.what':
    'Cuento los CFDI de los tipos que elijas cuando te digo qué falta en los libros; los demás se quedan en el censo.',
  'policy.census_cfdi_types.if_skipped':
    'Cuento ingresos, egresos y pagos, y dejo fuera la nómina y los traslados.',
  'policy.census_cfdi_types.option.invoices_and_payments':
    'Ingreso, egreso y pago (I, E, P)',
  'policy.census_cfdi_types.option.plus_payroll':
    'También nómina (I, E, P, N)',
  'policy.census_cfdi_types.option.all_types':
    'Todos los tipos, traslados incluidos (I, E, P, N, T)',

  'policy.census_missing_at_close.question':
    'Al cierre falta en los libros un CFDI que el SAT lista: ¿qué dirección detiene el cierre?',
  'policy.census_missing_at_close.impact':
    'El censo del SAT se lee contra lo contabilizado. Un CFDI emitido sin contabilizar subestima el ingreso y el IVA a cargo; un CFDI recibido sin contabilizar subestima una deducción y el IVA acreditable. Esto decide si cada dirección detiene el cierre o sólo avisa.',
  'policy.census_missing_at_close.rationale':
    'Un CFDI emitido es un ingreso que la entidad ya timbró y que el SAT ya tiene: dejarlo sin contabilizar subestima la base del ISR y el IVA trasladado del mes (LISR art. 17; LIVA arts. 1-B y 17), y la contabilidad debe registrar todas las operaciones (CFF art. 28 fr. I). Un CFDI recibido sin contabilizar es un derecho aún no ejercido: la deducción y el IVA acreditable se pueden reclamar en un periodo posterior (LISR art. 27 fr. III; LIVA art. 5), así que sólo avisa. Un despacho que quiere los libros cuadrados con el SAT en ambas direcciones antes de cualquier cierre elige both_block.',
  'policy.census_missing_at_close.why':
    'Que falte un CFDI emitido y que falte uno recibido no cuesta lo mismo, y los despachos difieren en cuánto de eso aceptan al cierre.',
  'policy.census_missing_at_close.what':
    'Listo en el checklist del cierre lo que el SAT tiene y los libros no, y detengo el cierre sólo por las direcciones que elijas.',
  'policy.census_missing_at_close.if_skipped':
    'Un CFDI emitido faltante detiene el cierre y uno recibido faltante sólo avisa.',
  'policy.census_missing_at_close.option.issued_blocks':
    'Lo emitido detiene el cierre; lo recibido avisa',
  'policy.census_missing_at_close.option.both_block':
    'Ambas direcciones detienen el cierre',
  'policy.census_missing_at_close.option.both_warn':
    'Ambas direcciones sólo avisan',

  'policy.opening_payable_iva.question':
    'Cuando una factura de proveedor migrada no dice la tasa de IVA dentro de su saldo pendiente, ¿qué hace la carga de apertura?',
  'policy.opening_payable_iva.impact':
    'Una factura de proveedor migrada se vuelve una cuenta por pagar. Con su tasa de IVA, la cuenta por pagar lleva la base y el IVA pendiente de acreditar, así que pagarla pasa ese IVA a acreditable y la DIOT de ese mes lo declara por tasa. Sin la tasa, «require_rate» detiene la carga y nombra los documentos; «assume_zero_rate» los carga al 0 %: pagarlos no acredita IVA y la DIOT los declara como actos al 0 %. El IVA de los documentos también tiene que estar en la cuenta de IVA pendiente de la apertura.',
  'policy.opening_payable_iva.rationale':
    'Con el IVA en flujo de efectivo, el impuesto de una compra no pagada se vuelve acreditable cuando se paga (LIVA art. 1-B y art. 5 fr. III), y la DIOT reporta lo pagado por tasa (LIVA art. 32 fr. VIII). Suponer 0 % pierde el acreditamiento y declara actos a una tasa que no tuvieron; pedir la tasa cuesta una columna en el archivo.',
  'policy.opening_payable_iva.why':
    'El sistema anterior me da lo que se le sigue debiendo a cada proveedor, no siempre cuánto de eso es IVA. O espero a que me lo digas, o lo cargo como si no tuviera IVA.',
  'policy.opening_payable_iva.what':
    'Por omisión detengo la carga y listo los documentos de proveedor sin tasa. Con «assume_zero_rate» los cargo al 0 % y te digo cuáles.',
  'policy.opening_payable_iva.if_skipped':
    'Detengo la carga hasta que cada documento de proveedor diga su tasa de IVA.',
  'policy.opening_payable_iva.option.require_rate':
    'Detener la carga hasta que cada documento de proveedor diga su tasa de IVA',
  'policy.opening_payable_iva.option.assume_zero_rate':
    'Cargarlos al 0 % y avisar: no se acredita IVA cuando se paguen',

  'policy.received_line_without_account.question':
    'Cuando un renglón de un CFDI de proveedor llega a contabilizarse sin cuenta de gasto, ¿qué hago con él?',
  'policy.received_line_without_account.impact':
    'Un renglón recibido se contabiliza en su propia cuenta, luego en la que se dio para todo el documento, luego en una sugerencia que no sea cuenta de control. Esto gobierna el renglón que no tiene ninguna de las tres cuando el CFDI se contabiliza desde la bandeja (`bill inbox run`). Con «refuse» no se contabiliza nada: el CFDI se queda en la bandeja y dice qué renglón no tiene cuenta, hasta que alguien lo codifique. Con «role_generic_account» el renglón va a la cuenta que tu catálogo le da al rol de gasto con el que se clasificó el CFDI (gastos generales en una compra ordinaria), y la cuenta por pagar se contabiliza sin que nadie haya elegido la cuenta; cuando la clasificación no tiene un solo rol de gasto con cuenta, se rechaza igual y dice por qué.',
  'policy.received_line_without_account.rationale':
    'Una deducción tiene que estar debidamente registrada en contabilidad (LISR art. 27 fr. IV): un gasto registrado en una cuenta genérica que nadie eligió queda registrado, pero no como lo que es. Rechazar es la opción conservadora del ADR-0006, decisión 1: nada se contabiliza sin revisión, y codificar el renglón cuesta un comando.',
  'policy.received_line_without_account.why':
    'A veces un CFDI de proveedor llega a contabilizarse con un renglón al que nadie le puso cuenta y sin nada en su historia que sugiera una. O espero a que lo codifiques, o lo registro en la cuenta genérica de gastos para no detener la cuenta por pagar.',
  'policy.received_line_without_account.what':
    'Por omisión dejo el CFDI en la bandeja y te digo qué renglón no tiene cuenta. Con «role_generic_account» contabilizo ese renglón en la cuenta del rol de gasto con el que clasifiqué el CFDI.',
  'policy.received_line_without_account.if_skipped':
    'No contabilizo nada hasta que cada renglón tenga cuenta.',
  'policy.received_line_without_account.option.refuse':
    'No contabilizar nada hasta que alguien le ponga cuenta al renglón',
  'policy.received_line_without_account.option.role_generic_account':
    'Contabilizar el renglón en la cuenta genérica de su rol de gasto',

  'policy.vat_overcredit_correction_period.question':
    'Pagos que pasaron de la 1135 a la 1130 el IEPS de un CFDI como si fuera IVA: ¿en qué periodo va la corrección?',
  'policy.vat_overcredit_correction_period.impact':
    'Hasta MNE-001-488, un CFDI de proveedor con IEPS guardaba en la cabecera de su factura el IVA más el IEPS, y cada pago acreditaba como IVA su parte de esa suma. `npm run correct:vat-overcredit` lista cada factura, pago y mes, y con `--apply` contabiliza DR 1135 / CR 1130 por el exceso. Esta clave decide la fecha de esa póliza. Con «ask» no se contabiliza nada y cada factura se nombra con las dos opciones. Con «current_period» va una póliza por factura con fecha de hoy, en el periodo abierto. Con «payment_month» va una póliza por factura y mes, en el mes de cada pago; un mes cerrado sólo se reabre si la corrida dice `--reopen`, y uno bloqueado nunca. En los dos casos la declaración complementaria de cada mes (CFF art. 32) la presenta una persona, con las cifras que da el censo.',
  'policy.vat_overcredit_correction_period.rationale':
    'El IVA se acredita en el mes en que se paga (LIVA art. 5 fr. III), así que el exceso es un error de esos meses: la NIF B-1 lo corrige de forma retrospectiva y el CFF art. 32 con una complementaria, mientras que los despachos que no reabren sus libros lo registran en el periodo actual. La norma deja margen, así que la opción por omisión es la conservadora del ADR-0006, decisión 1: no se contabiliza nada ni se reabre un mes cerrado hasta que una persona elija.',
  'policy.vat_overcredit_correction_period.why':
    'Los pagos de CFDI de proveedor con IEPS acreditaron parte del IEPS como IVA antes de que la cabecera de la factura guardara sólo el IVA. La corrección puede fecharse en el mes de cada pago, reabriéndolo si está cerrado, o en el periodo abierto de hoy.',
  'policy.vat_overcredit_correction_period.what':
    'Por omisión no contabilizo nada y nombro cada factura con las dos opciones. Con «current_period» contabilizo una corrección por factura hoy; con «payment_month», una por factura y mes, en ese mes.',
  'policy.vat_overcredit_correction_period.if_skipped':
    'No contabilizo ninguna corrección hasta que elijas.',
  'policy.vat_overcredit_correction_period.option.ask':
    'No contabilizar nada hasta que alguien elija',
  'policy.vat_overcredit_correction_period.option.current_period':
    'Una corrección por factura, con fecha de hoy en el periodo abierto',
  'policy.vat_overcredit_correction_period.option.payment_month':
    'Una corrección por factura y mes, en el mes de cada pago',

  'policy.discount_vat_correction_period.question':
    'Descuentos por pronto pago registrados antes de la migración 341, cuyo IVA se quedó en la 1135: ¿en qué periodo va la corrección?',
  'policy.discount_vat_correction_period.impact':
    'Antes de la migración 341, un descuento por pronto pago iba completo a la 5200 y su parte del IVA de la factura se quedaba en la 1135, sin ser nunca acreditable. `npm run correct:discount-vat` lista cada factura, pago y mes, y con `--apply` contabiliza DR 5200 / CR 1135 por esa parte. Esta clave decide la fecha de esa póliza. Con «ask» no se contabiliza nada y cada factura se nombra con las dos opciones. Con «current_period» va una póliza por factura y pago con fecha de hoy, en el periodo abierto. Con «payment_month» va una póliza por factura, pago y mes, con la fecha en que se registró el descuento; un mes cerrado sólo se reabre si la corrida dice `--reopen`, y uno bloqueado nunca. El IVA declarado no cambia; las deducciones de ISR del mes en que va la póliza suben por esa parte.',
  'policy.discount_vat_correction_period.rationale':
    'Un descuento baja el precio y su IVA (LIVA art. 7), así que su parte no es acreditable ni es costo: la 5200 la guarda de más y el costo de la compra, que es deducción (LISR art. 27), queda corto en el mes del descuento. La NIF B-1 corrige ese error de forma retrospectiva, mientras que los errores inmateriales y los despachos que no reabren sus libros lo registran en el periodo actual. La norma deja margen, así que la opción por omisión es la conservadora del ADR-0006, decisión 1: no se contabiliza nada ni se reabre un mes cerrado hasta que una persona elija.',
  'policy.discount_vat_correction_period.why':
    'Los descuentos tomados al pagar a un proveedor, antes de la migración 341, dejaron su IVA en la 1135 y lo contaron como menor costo. La corrección puede fecharse en el mes de cada descuento, reabriéndolo si está cerrado, o en el periodo abierto de hoy.',
  'policy.discount_vat_correction_period.what':
    'Por omisión no contabilizo nada y nombro cada factura con las dos opciones. Con «current_period» contabilizo una corrección por factura y pago hoy; con «payment_month», una por factura, pago y mes, en ese mes.',
  'policy.discount_vat_correction_period.if_skipped':
    'No contabilizo ninguna corrección hasta que elijas.',
  'policy.discount_vat_correction_period.option.ask':
    'No contabilizar nada hasta que alguien elija',
  'policy.discount_vat_correction_period.option.current_period':
    'Una corrección por factura y pago, con fecha de hoy en el periodo abierto',
  'policy.discount_vat_correction_period.option.payment_month':
    'Una corrección por factura y pago, en el mes en que se registró el descuento',

  'policy.closing_entries_in_reports.question':
    'Cuando un informe abarca la fecha en que se cerró el ejercicio, ¿sus pólizas de cierre cuentan como actividad?',
  'policy.closing_entries_in_reports.impact':
    'La póliza de cierre lleva fecha del FINAL del periodo que cierra, dentro del rango que consulta el estado de resultados. Contarla deja el año en cero: una empresa con 10,000 de ventas imprime «Utilidad neta 0.0000». Excluirla del estado y conservarla en la balanza es la única combinación en la que los dos documentos son verdad a la vez.',
  'policy.closing_entries_in_reports.rationale':
    'El estado de resultados responde «qué ganó el negocio», y la póliza de cierre no es ganancia: es el acto de guardar la ganancia. La balanza responde «qué dicen los libros», y ahí la póliza SÍ es parte de los libros; esconderla rompería el amarre con el mayor general contra el que se revisa el Anexo 24.',
  'policy.closing_entries_in_reports.why':
    'La póliza que cierra tu ejercicio cae dentro del rango que piden tus informes de fin de año, así que tengo que saber si la cuento.',
  'policy.closing_entries_in_reports.what':
    'Dejo las pólizas de cierre fuera del estado de resultados y las conservo en la balanza.',
  'policy.closing_entries_in_reports.if_skipped':
    'Las excluyo del estado y las incluyo en la balanza.',
  'policy.closing_entries_in_reports.option.estado_sin_cierre_balanza_con_cierre':
    'El estado de resultados las excluye; la balanza las incluye y lo dice',
  'policy.closing_entries_in_reports.option.excluir_siempre':
    'Ningún informe las cuenta nunca',
  'policy.closing_entries_in_reports.option.incluir_siempre_y_advertir':
    'Todos los informes las cuentan y avisan que el rango contiene un cierre',

  'policy.year_result_destination.question':
    'En el cierre del ejercicio, ¿a dónde va el resultado: directo a «Resultado de Ejercicios Anteriores», o antes a «Resultado del Ejercicio»?',
  'policy.year_result_destination.impact':
    'Decide si el balance general todavía puede mostrar lo que ganó ESTE año después del cierre. Barrerlo directo a 3200 lo mezcla con todos los años anteriores el día del cierre, antes de que los accionistas hayan aprobado nada.',
  'policy.year_result_destination.rationale':
    'La práctica mexicana mantiene aparte el resultado del ejercicio hasta que la asamblea resuelve qué hacer con él (dividendos, reserva legal, capitalización): el art. 19 de la LGSM prohíbe repartir utilidades mientras no se absorban las pérdidas, y ese argumento necesita que el año siga siendo identificable. La cuenta 3300 ya existe en el catálogo sembrado y nada escribe en ella.',
  'policy.year_result_destination.why':
    'Después de cerrar diciembre, tu balance general o sigue mostrando lo que ganó este año o lo suma al total acumulado. Es una decisión de presentación, y es tuya.',
  'policy.year_result_destination.what':
    'Cierro el ejercicio en 3300 y dejo el traspaso a 3200 como un acto aparte y auditado.',
  'policy.year_result_destination.if_skipped':
    'Uso la ruta de dos pasos por «Resultado del Ejercicio».',
  'policy.year_result_destination.option.dos_pasos_hasta_asamblea':
    'Cerrar a «Resultado del Ejercicio» (3300); una reclasificación posterior y auditada lo pasa a «Resultado de Ejercicios Anteriores» (3200)',
  'policy.year_result_destination.option.directo_a_acumulados':
    'Cerrar directo a «Resultado de Ejercicios Anteriores» (3200)',

  'policy.reclose_of_reopened_period.question':
    'Si un periodo de fin de año que ya emitió su póliza de cierre se reabre y se vuelve a cerrar, ¿qué pasa con la primera?',
  'policy.reclose_of_reopened_period.impact':
    'Hoy el segundo cierre emite un segundo juego COMPLETO de pólizas de cierre y nada quita el primero: «Resultado de Ejercicios Anteriores» (3200) recibe el resultado dos veces. `period reopen` hizo que esto se pudiera alcanzar desde la terminal, así que la respuesta dejó de ser hipotética.',
  'policy.reclose_of_reopened_period.rationale':
    'Es la única opción que deja los libros diciendo una sola verdad y muestra cómo llegaron ahí: la NIF B-1 corrige por reversión, nunca por edición, y la reversión es la evidencia de que el primer cierre se deshizo a propósito. «Incremental» dependería de que el primer cierre estuviera bien, que es precisamente lo que una reapertura pone en duda.',
  'policy.reclose_of_reopened_period.why':
    'Reabrir un ejercicio cerrado quiere decir que su póliza de cierre ya está en los libros, y volver a cerrar escribirá una segunda. Necesito saber si deshago la primera o la dejo como está.',
  'policy.reclose_of_reopened_period.what':
    'Revierto la póliza de cierre anterior con su motivo registrado, y luego cierro otra vez desde cero.',
  'policy.reclose_of_reopened_period.if_skipped':
    'Revierto y vuelvo a emitir.',
  'policy.reclose_of_reopened_period.option.reversar_y_reemitir':
    'Revertir la póliza de cierre anterior (folio propio, motivo auditado) y emitir otra vez el cierre completo',
  'policy.reclose_of_reopened_period.option.incremental':
    'Dejar en pie el primer cierre; el nuevo sólo barre lo que quedó',
  'policy.reclose_of_reopened_period.option.prohibir':
    'Negarse: un periodo cuyo cierre ya se emitió se corrige con una reclasificación explícita, no cerrando otra vez',

  'policy.unswept_pl_accounts_severity.question':
    'Si el cierre del ejercicio termina y alguna cuenta de ingresos o gastos todavía tiene saldo, ¿es un aviso o una falla?',
  'policy.unswept_pl_accounts_severity.impact':
    'Un cierre que deja cuentas sin barrer no cerró el ejercicio, y el mismo defecto que esta revisión existe para atrapar —el abs() que duplicaba las devoluciones en vez de barrerlas— produjo exactamente eso: cuentas con el doble de su saldo mientras la póliza misma cuadraba y todos los demás indicadores salían en verde.',
  'policy.unswept_pl_accounts_severity.rationale':
    'El cierre es lo que vuelve definitivo el ejercicio; un cierre que funcionó a medias deja el año siguiente sembrado con saldos iniciales equivocados, y para cuando alguien lo nota los estados ya están firmados. Detenerse tiene remedio; un saldo inicial equivocado arrastrado hacia adelante, no.',
  'policy.unswept_pl_accounts_severity.why':
    'Cuando el cierre no puede barrer una cuenta a cero, o se detiene y te lo dice o termina y espera que leas el aviso.',
  'policy.unswept_pl_accounts_severity.what':
    'Deshago el cierre y nombro las cuentas que no se barrieron.',
  'policy.unswept_pl_accounts_severity.if_skipped':
    'Me niego a completar un cierre que deja resultados sin barrer.',
  'policy.unswept_pl_accounts_severity.option.bloquear_cierre':
    'Fallar: el cierre duro se deshace y el periodo sigue abierto',
  'policy.unswept_pl_accounts_severity.option.avisar':
    'Avisar: el cierre se completa y el residuo se reporta con su remedio',
  'policy.unswept_pl_accounts_severity.option.tolerancia':
    'Aceptar hasta la tolerancia de cierre de la entidad y fallar por encima de ella',

  'policy.exchange_rate_source.question':
    'Cuando necesito un tipo de cambio para una fecha, ¿qué fuente publicada uso?',
  'policy.exchange_rate_source.impact':
    'Cada conversión de moneda extranjera lee el tipo de esta fuente para la fecha de la operación. Si esa fuente no tiene tipo para esa fecha, la conversión SE DETIENE y lo dice: nunca toma prestado en silencio un tipo de otra fuente, porque eso sería elegir el criterio fiscal por ti.',
  'policy.exchange_rate_source.rationale':
    'En México el tipo con efectos legales es el que publica el Diario Oficial (art. 20 CFF): el IVA acreditable de un pago en moneda extranjera se convierte al tipo del DOF, y el FIX es otra cifra para el mismo día. Un sistema mexicano que pone primero los libros usa por omisión la fuente contra la que lo va a medir el SAT; los despachos con razones de tesorería para preferir el FIX pueden decirlo aquí.',
  'policy.exchange_rate_source.why':
    'El DOF y el FIX del mismo día son cifras distintas, y cuál usan tus libros es un criterio, no una preferencia.',
  'policy.exchange_rate_source.what':
    'Convierto con el tipo de la fuente elegida para la fecha de la operación, y me detengo si falta.',
  'policy.exchange_rate_source.if_skipped':
    'Uso el tipo del DOF.',
  'policy.exchange_rate_source.option.dof':
    'DOF (Diario Oficial; el tipo fiscal según el art. 20 CFF)',
  'policy.exchange_rate_source.option.fix_banxico':
    'FIX de Banxico (el tipo de referencia, publicado como banco_mexico)',
  'policy.exchange_rate_source.option.manual':
    'Tipos que fijo a mano con `fx rate set`',

  'policy.closing_exchange_rate_source.question':
    'Al cierre, ¿con qué tipo publicado se revalúan los saldos vivos en moneda extranjera?',
  'policy.closing_exchange_rate_source.impact':
    'closing fx revalue revalúa las cuentas por cobrar, por pagar y los bancos en moneda extranjera al tipo de esta fuente para el último día natural del periodo, ese día exacto. Si la fuente no publicó tipo para ese día, la corrida se detiene y lo dice: nunca toma el día hábil anterior ni otra fuente.',
  'policy.closing_exchange_rate_source.rationale':
    'La NIF B-15 revalúa las partidas monetarias al tipo de cierre, y la diferencia realizada de un pago posterior se mide con la fuente de las operaciones: cerrar con la misma fuente deja en la misma escala las mitades no realizada y realizada de una misma diferencia. Para un despacho mexicano esa fuente es por omisión el DOF, el tipo al que el art. 20 CFF da efectos y con el que se mide la ganancia o pérdida cambiaria del art. 8 LISR.',
  'policy.closing_exchange_rate_source.why':
    'El DOF y el FIX del mismo día son números distintos, y la revaluación postea la brecha entre el tipo en libros y éste.',
  'policy.closing_exchange_rate_source.what':
    'Revalúo al tipo de la fuente elegida para el último día del periodo, y me detengo si falta.',
  'policy.closing_exchange_rate_source.if_skipped':
    'Uso la misma fuente que las operaciones: el DOF, salvo que la hayas cambiado.',
  'policy.closing_exchange_rate_source.option.operations_source':
    'La misma fuente que las operaciones (fuente_tipo_cambio; el DOF salvo que se cambie)',
  'policy.closing_exchange_rate_source.option.dof':
    'DOF (Diario Oficial; el tipo fiscal del art. 20 CFF), usen lo que usen las operaciones',
  'policy.closing_exchange_rate_source.option.fix_banxico':
    'FIX de Banxico (publicado como banco_mexico)',

  'policy.fx_revaluation_reversal.question':
    '¿La revaluación de cierre de los saldos en moneda extranjera se revierte el día 1 del periodo siguiente?',
  'policy.fx_revaluation_reversal.impact':
    'closing fx revalue postea la diferencia cambiaria no realizada el último día del periodo y su espejo el día 1 del siguiente, que tiene que existir y estar abierto. El saldo vuelve a su tipo histórico, contra el que se mide la diferencia realizada de un pago o cobro posterior.',
  'policy.fx_revaluation_reversal.rationale':
    'La NIF B-15 revalúa las partidas monetarias al tipo de cierre para el balance. Los pagos y cobros miden la diferencia realizada contra el tipo histórico del documento (ar-ap-posting.ts), así que la revaluación se revierte el día 1: si no, la misma diferencia se reconocería dos veces, no realizada al cierre y otra vez al pagarse. Conservar la revaluación (sin reversión) no se ofrece hasta que los pagos lean el tipo en libros.',
  'policy.fx_revaluation_reversal.why':
    'Revertir o conservar la revaluación son legítimos bajo la NIF B-15; cuál es el correcto depende de cómo miden los pagos la diferencia realizada.',
  'policy.fx_revaluation_reversal.what':
    'Posteo el espejo de la revaluación el día 1 del periodo siguiente.',
  'policy.fx_revaluation_reversal.if_skipped':
    'La revierto el día 1 del periodo siguiente.',
  'policy.fx_revaluation_reversal.option.reverse_on_day_one':
    'Revertirla el día 1 del periodo siguiente',

  'policy.rep_foreign_currency.question':
    'Un complemento en una moneda distinta de la funcional: ¿registrarlo o dejarlo en revisión?',
  'policy.rep_foreign_currency.impact':
    'Decide si un REP en moneda extranjera crea su pago. Cuando lo hace, pasa por el mismo motor de pagos que un pago tecleado a mano (pagos a proveedores desde R4, cobranza desde MNE-001-082): cada documento se extingue al tipo con el que nació, el efectivo se convierte al tipo del día del pago según `fuente_tipo_cambio`, el IVA se causa a ese mismo tipo y la diferencia se contabiliza en las cuentas de utilidad o pérdida cambiaria. No se lee el TipoCambioP del propio REP; se lee la fuente del despacho.',
  'policy.rep_foreign_currency.rationale':
    'La NIF B-15 quiere la diferencia realizada en el periodo en que el pago liquida el documento, y para el IVA el importe causado o acreditable es el efectivamente pagado convertido al tipo de la fecha del pago (LIVA arts. 1-B, 5-III y 11; art. 20 CFF). El motor de pagos ya registra las dos cosas, así que registrar es sólido; el valor por omisión sigue deteniéndose en revisión porque un REP que el despacho no tecleó se crea sin cuenta de banco y con un tipo que nadie miró, y una persona debería ver los primeros antes de que se contabilicen. No hay una opción que case al tipo del documento y no reconozca diferencia: dejaría el IVA al tipo equivocado y escondería un resultado realizado que exige la B-15.',
  'policy.rep_foreign_currency.why':
    'Un pago en dólares liquida documentos registrados a otro tipo: la diferencia es dinero real y cae en las cuentas de utilidad o pérdida cambiaria.',
  'policy.rep_foreign_currency.what':
    'Dejo el complemento sin casar y te aviso, o lo registro con su diferencia realizada si así lo dices.',
  'policy.rep_foreign_currency.if_skipped':
    'No caso complementos en moneda extranjera, y lo digo cada vez.',
  'policy.rep_foreign_currency.option.no_casar':
    'No casar: dejarlo en revisión con un aviso de varias monedas',
  'policy.rep_foreign_currency.option.payment_day_rate':
    'Registrarlo por el motor de pagos, realizando la diferencia cambiaria al tipo del día del pago',

  'policy.efirma_max_daily_accesses.question':
    '¿Cuántos descifrados de la e.firma al día son normales?',
  'policy.efirma_max_daily_accesses.impact':
    'Es el límite que dispara la negación y la señal de acceso anómalo. Demasiado alto = la señal pierde valor; demasiado bajo = interrumpe sincronizaciones legítimas. Debe salir de la cadencia real de descarga.',
  'policy.efirma_max_daily_accesses.rationale':
    'Uno por hora: holgado para cualquier cadencia razonable, pero pone un tope al abuso.',
  'policy.efirma_max_daily_accesses.why':
    'Tu e.firma se descifra cada vez que me autentico ante el SAT. Un límite convierte un patrón de acceso anormal en una señal visible, pero sólo si refleja tu cadencia real de sincronización.',
  'policy.efirma_max_daily_accesses.what':
    'Por encima de ese número de descifrados en 24 horas niego el acceso y lo registro como anomalía.',
  'policy.efirma_max_daily_accesses.if_skipped':
    'Permito 24 al día (uno por hora), lo que es holgado: un abuso tendría que ser grande antes de que se dispare la señal.',
  'policy.efirma_max_daily_accesses.option.4':
    '4 — sincronizar cada 6 horas',
  'policy.efirma_max_daily_accesses.option.24':
    '24 — uno por hora',
  'policy.efirma_max_daily_accesses.option.96':
    '96 — cada 15 minutos',

  'policy.efirma_anomaly_action.question':
    'Cuando se detecta un patrón anómalo de acceso a la e.firma, ¿bloquear o sólo alertar?',
  'policy.efirma_anomaly_action.impact':
    'Bloquear protege pero puede tumbar la sincronización de un cliente por un falso positivo. Alertar no interrumpe pero exige a alguien vigilando. Define si necesitas guardia.',
  'policy.efirma_anomaly_action.rationale':
    'El límite diario ya niega el exceso; bloquear la credencial completa sin alguien de guardia que lo atienda dejaría al cliente sin servicio hasta que alguien se diera cuenta.',
  'policy.efirma_anomaly_action.why':
    'Cuando el patrón de acceso se ve mal puedo bloquear la credencial o sólo alertar. Bloquear protege pero un falso positivo tumba tu sincronización; alertar nunca interrumpe pero necesita a alguien vigilando.',
  'policy.efirma_anomaly_action.what':
    'Decide qué pasa en el momento en que se detecta una anomalía.',
  'policy.efirma_anomaly_action.if_skipped':
    'Sólo alerto. Si nadie vigila las alertas, un acceso anormal podría seguir sin que nadie lo note.',
  'policy.efirma_anomaly_action.option.bloquear':
    'Bloquear la credencial y notificar',
  'policy.efirma_anomaly_action.option.alertar':
    'Sólo alertar y dejar que siga',
  'policy.efirma_anomaly_action.option.bloquear_fuera_horario':
    'Bloquear sólo fuera del horario definido',

  'policy.ingest_auto_post.question':
    '¿Está activada la contabilización automática al cargar CFDI?',
  'policy.ingest_auto_post.impact':
    'Con la contabilización automática apagada, todo se queda en borrador para revisión. Encendida, el sistema contabiliza sin intervención cuando se cumplen los umbrales de confianza, importe y proveedor conocido.',
  'policy.ingest_auto_post.rationale':
    'Mejor medir durante varias semanas qué tan seguido acertaría antes de dejar que mueva dinero por su cuenta.',
  'policy.ingest_auto_post.why':
    'Puedo clasificar una factura y contabilizarla sin preguntar, o dejarla siempre en borrador para que la apruebes. Encenderla ahorra trabajo; dejarla apagada quiere decir que nada llega a tus libros sin revisión.',
  'policy.ingest_auto_post.what':
    'Apagada, cada factura clasificada por la IA espera tu aprobación en `mnemosine review`. Encendida, las facturas que cumplen los umbrales de confianza, importe y proveedor conocido se contabilizan solas.',
  'policy.ingest_auto_post.if_skipped':
    'Se queda apagada: todo pasa por tu revisión, que es la forma segura de empezar.',
  'policy.ingest_auto_post.option.off':
    'Apagada: todo va a revisión humana',
  'policy.ingest_auto_post.option.shadow':
    'Sombra: correr todas las compuertas, registrar el veredicto y no contabilizar NADA — construye el historial',
  'policy.ingest_auto_post.option.on':
    'Encendida con los umbrales configurados',

  'policy.ingest_auto_post_max_amount.question':
    '¿Cuál es el importe máximo que la IA puede contabilizar sin revisión humana?',
  'policy.ingest_auto_post_max_amount.impact':
    'Tope duro de la contabilización automática. Por encima de este importe siempre pasa por revisión.',
  'policy.ingest_auto_post_max_amount.rationale':
    'Acota la exposición mientras se construye un historial.',
  'policy.ingest_auto_post_max_amount.why':
    'Aun con la contabilización automática encendida, hay un importe por encima del cual seguramente quieres revisar tú antes de que toque los libros.',
  'policy.ingest_auto_post_max_amount.what':
    'Es un tope duro: por encima de ese importe una factura siempre va a revisión, sin importar qué tan segura sea la clasificación.',
  'policy.ingest_auto_post_max_amount.if_skipped':
    'El tope se queda en $10,000.',
  'policy.ingest_auto_post_max_amount.option.5000':
    '$5,000 — sólo gastos menores',
  'policy.ingest_auto_post_max_amount.option.10000':
    '$10,000',
  'policy.ingest_auto_post_max_amount.option.50000':
    '$50,000',

  'policy.rep_missing_received.question':
    'Al cierre, un pago a proveedor de una factura PPD todavía no tiene REP, aunque su IVA ya se acreditó. ¿Bloquear el cierre, sólo avisar o no vigilarlo al cierre?',
  'policy.rep_missing_received.impact':
    'Con «bloquear», el cierre blando se niega mientras algún pago del periodo no tenga su REP; con «avisar» cierra y la lista de verificación registra el acreditamiento sin soporte; con «no_vigilar» el cierre ignora el lado del proveedor y rep missing list es el único lugar que lo muestra.',
  'policy.rep_missing_received.rationale':
    'El IVA de una factura PPD es acreditable cuando se paga (LIVA art. 5 fr. III), y el proveedor debe emitir el REP que ampara ese acreditamiento (CFF art. 29, RMF 2.7.1.35). Un proveedor atrasado no debería congelar tu cierre, pero un acreditamiento sin su complemento es una exposición ante una auditoría, así que el cierre lo mantiene visible; rep missing list nombra a los responsables.',
  'policy.rep_missing_received.why':
    'El REP es lo que ampara el acreditamiento del IVA de una PPD. Algunos despachos se niegan a cerrar un mes cuyos acreditamientos de IVA todavía no tienen su REP; otros cierran y persiguen al proveedor; otros lo siguen fuera del cierre.',
  'policy.rep_missing_received.what':
    'Decide si getPeriodCloseStatus cuenta los REP faltantes de proveedores como un problema que bloquea, como un aviso o no los cuenta.',
  'policy.rep_missing_received.if_skipped':
    'Avisa: el cierre sigue y la lista de verificación muestra los REP pendientes.',
  'policy.rep_missing_received.option.avisar':
    'Avisar: el cierre sigue, el REP faltante sigue visible en la lista de verificación',
  'policy.rep_missing_received.option.bloquear':
    'Bloquear: no hay cierre hasta que cada pago tenga su REP',
  'policy.rep_missing_received.option.no_vigilar':
    'No vigilar al cierre: el acreditamiento ya está registrado; los REP se persiguen desde rep missing list',

  'policy.rep_missing_issued.question':
    'Al cierre, un cobro a cliente no tiene un REP emitido por nosotros. ¿Bloquear el cierre o sólo avisar?',
  'policy.rep_missing_issued.impact':
    'El REP de una factura PPD cobrada es NUESTRA obligación, con un plazo del SAT. «bloquear» se niega a cerrar mientras algún cobro no tenga su REP; «avisar» cierra y lo registra.',
  'policy.rep_missing_issued.rationale':
    'Avisar mantiene el cierre utilizable desde el primer día; cambia a bloquear cuando la emisión de REP (rep stamp) exista en el sistema y la obligación se pueda cumplir desde aquí.',
  'policy.rep_missing_issued.why':
    'A diferencia del caso del proveedor, este REP lo emitimos nosotros y el plazo del SAT es nuestro. Si eso bloquea tu cierre es política del despacho.',
  'policy.rep_missing_issued.what':
    'Decide si getPeriodCloseStatus cuenta nuestros REP no emitidos como un problema que bloquea o como un aviso.',
  'policy.rep_missing_issued.if_skipped':
    'Avisa: el cierre sigue y la lista de verificación muestra la obligación.',
  'policy.rep_missing_issued.option.bloquear':
    'Bloquear: nuestra propia obligación de REP debe cumplirse antes de cerrar',
  'policy.rep_missing_issued.option.avisar':
    'Avisar: el cierre sigue, la obligación se queda en la lista de verificación',

  'policy.segregation_of_duties.question':
    '¿La persona que hizo el trabajo también puede darle el visto bueno?',
  'policy.segregation_of_duties.impact':
    'Control de cuatro ojos, sobre DOS actos que hacen la misma pregunta. En la vía manual: con «exigir», entry post rechaza que quien hizo el borrador contabilice su propia póliza. En la vía del banco: rechaza que quien cerró una sesión de conciliación también la apruebe. Con «alertar» los dos pasan y el renglón de auditoría registra la coincidencia; apagado quiere decir que no hay revisión. Una clave y no dos a propósito: es una sola decisión sobre las manos del despacho, y dos claves para ella acabarían separándose.',
  'policy.segregation_of_duties.rationale':
    'Un despacho de una sola persona no puede separar funciones; exigirlo por omisión congelaría cada contabilización. Actívalo cuando haya al menos dos usuarios.',
  'policy.segregation_of_duties.why':
    'La segregación de funciones es el control clásico contra que una sola persona invente y aplique una póliza. Si tu despacho puede permitírsela depende de cuántas manos tiene.',
  'policy.segregation_of_duties.what':
    'Con «exigir», `entry post` se niega cuando quien contabiliza creó el borrador, y `bank reconciliation approve` se niega cuando quien aprueba es quien cerró la sesión (los flujos del sistema quedan exentos: se rastrean por su origen). Con «alertar», los dos pasan y dejan el hecho en la bitácora de auditoría.',
  'policy.segregation_of_duties.if_skipped':
    'Se queda apagado: no hay revisión de separación, que es el único valor por omisión viable para un inquilino de un solo usuario; un despacho de una sola persona que tuviera que encontrar a un segundo firmante nunca cerraría un mes.',
  'policy.segregation_of_duties.option.off':
    'Apagado: cualquiera puede contabilizar lo que preparó (despacho de una sola persona)',
  'policy.segregation_of_duties.option.alertar':
    'Avisar: la contabilización pasa y la bitácora de auditoría registra la coincidencia',
  'policy.segregation_of_duties.option.exigir':
    'Exigir: quien contabiliza debe ser un usuario distinto de quien preparó el borrador',

  'policy.reconciliation_tolerance.question':
    '¿Una conciliación bancaria tiene que llegar exactamente a cero, o se puede arrastrar un residuo pequeño?',
  'policy.reconciliation_tolerance.impact':
    'Gobierna `bank reconciliation close`. Con «cero_exacto» la sesión sólo llega a `balanced` cuando los dos lados coinciden al centavo, y la lista de verificación del cierre se puede leer como prueba de que el efectivo se verificó. Con una tolerancia, lo que quede por debajo se arrastra como una partida en conciliación con nombre en vez de bloquear: se cierra más rápido, y el residuo hay que perseguirlo después o envejece.',
  'policy.reconciliation_tolerance.rationale':
    'La lista de verificación del cierre lee una sesión cuadrada como evidencia de que el saldo del efectivo se verificó. Una tolerancia hace esa evidencia más débil de lo que parece, así que hay que pedirla, nunca suponerla.',
  'policy.reconciliation_tolerance.why':
    'Una conciliación bancaria que «casi» cuadra es el escondite más viejo para un error: el residuo es pequeño cada mes y nunca es la misma cosa pequeña. Si tu despacho cierra en cero exacto es una política real: algunos lo hacen, otros arrastran una tolerancia y la persiguen.',
  'policy.reconciliation_tolerance.what':
    'Con «cero_exacto» me niego a cerrar una sesión cuyos dos lados difieren por un centavo, y te digo qué falta explicar. Con una tolerancia la cierro y dejo el residuo como partida en conciliación con responsable y fecha, para que no envejezca en silencio.',
  'policy.reconciliation_tolerance.if_skipped':
    'Exijo cero exacto. Nada se rompe; algunos meses tendrás que perseguir un centavo antes de que cierre.',
  'policy.reconciliation_tolerance.option.cero_exacto':
    'Cero exacto: nada cierra hasta que los dos lados coinciden al centavo',
  'policy.reconciliation_tolerance.option.tolerancia_con_residual':
    'Permitir un residuo por debajo de la tolerancia, arrastrado como partida con nombre',

  'policy.unexplained_bank_line_at_close.question':
    'Al cierre, ¿qué pasa con un renglón del banco que no tiene una póliza que lo explique?',
  'policy.unexplained_bank_line_at_close.impact':
    'Gobierna `bank reconciliation close` cuando el estado de cuenta muestra un movimiento que los libros nunca registraron y que nadie ha clasificado. «partida_conciliatoria» lo arrastra como una partida con nombre, responsable y fecha; «bloquear_cierre» se niega a cerrar hasta que una persona diga qué es; «suspenso» lo estaciona en una cuenta de suspenso, que es una práctica real y también el lugar clásico al que una diferencia va a morir.',
  'policy.unexplained_bank_line_at_close.rationale':
    'Mantiene el movimiento visible y perseguible sin detener el cierre. Bloquear es más estricto pero atora el mes por un solo renglón desconocido; el suspenso lo esconde detrás de un saldo.',
  'policy.unexplained_bank_line_at_close.why':
    'Tarde o temprano el banco muestra un movimiento que tus libros nunca registraron y que nadie reconoce. Qué haces con él el día del cierre es una elección entre detener el mes, arrastrarlo a la vista o estacionarlo; y la tercera es como desaparecen las diferencias.',
  'policy.unexplained_bank_line_at_close.what':
    'Por omisión lo arrastro como partida en conciliación, así que aparece en `bank reconciling-item list` con su antigüedad hasta que alguien lo resuelva. Si eliges «suspenso» lo seguiré nombrando cada mes que se quede ahí: una cuenta de suspenso no es un lugar para dejar de buscar.',
  'policy.unexplained_bank_line_at_close.if_skipped':
    'Lo arrastro a la vista como partida en conciliación, que es la opción que lo mantiene visible.',
  'policy.unexplained_bank_line_at_close.option.partida_conciliatoria':
    'Arrastrarlo como partida en conciliación, con responsable y fecha esperada',
  'policy.unexplained_bank_line_at_close.option.bloquear_cierre':
    'Negarse a cerrar hasta que alguien lo clasifique',
  'policy.unexplained_bank_line_at_close.option.suspenso':
    'Contabilizarlo en una cuenta de suspenso y depurarlo después',

  'policy.bank_statement_overlap.question':
    'Cuando un estado de cuenta nuevo repite movimientos ya importados de otro, ¿qué pasa?',
  'policy.bank_statement_overlap.impact':
    'Gobierna `bank statement import`. Compara cada renglón del archivo nuevo, por su huella de contenido y contando repeticiones, contra los renglones de los OTROS estados de cuenta de la misma cuenta. «block» rechaza el archivo completo y nombra cada renglón repetido y el estado de cuenta en el que ya está; «mark» importa el archivo y anota en cada renglón repetido con qué estado de cuenta se traslapa, visible en `bank statement show --lines`; «warn» importa el archivo y sólo nombra los renglones repetidos en la salida de la importación. Con «mark» y «warn» los movimientos repetidos SÍ están dos veces en los libros hasta que alguien quite uno. Dos renglones idénticos dentro del mismo archivo nunca se tocan con esto: el banco cobró dos veces.',
  'policy.bank_statement_overlap.rationale':
    'Es la única opción en la que nada entra dos veces a los libros sin que una persona lo decida. Un trimestral sobre un mensual se detecta antes de duplicar enero; el costo es que quien opera tiene que recortar el archivo o cambiar esta respuesta.',
  'policy.bank_statement_overlap.why':
    'Los bancos reemiten estados de cuenta y mandan archivos trimestrales que contienen los mensuales. El mismo archivo dos veces ya lo rechazo; dos archivos distintos que comparten movimientos no los puedo distinguir de dos movimientos reales sin que tú decidas qué tan cuidadoso ser.',
  'policy.bank_statement_overlap.what':
    'Por omisión rechazo un estado de cuenta que repite movimientos de otro y te digo qué renglones y dónde están ya. Si eliges «mark» lo importo y dejo una marca en cada renglón repetido; con «warn» lo importo y sólo te aviso.',
  'policy.bank_statement_overlap.if_skipped':
    'Rechazo el estado de cuenta que se traslapa, que es la opción que nunca cuenta un movimiento dos veces.',
  'policy.bank_statement_overlap.option.block':
    'Rechazar el archivo y nombrar los renglones que ya están importados',
  'policy.bank_statement_overlap.option.mark':
    'Importarlo y marcar cada renglón repetido con el estado de cuenta con el que se traslapa',
  'policy.bank_statement_overlap.option.warn':
    'Importarlo y sólo avisar qué renglones ya estaban importados',

  'policy.match_confidence_threshold.question':
    '¿Qué tan seguro tiene que estar el motor de cotejo antes de emparejar un renglón del banco por su cuenta?',
  'policy.match_confidence_threshold.impact':
    'Gobierna `bank match run`. Más bajo quiere decir menos renglones para una persona y más parejas equivocadas que deshacer; más alto quiere decir que el motor te pasa más trabajo pero casi nunca adivina. Un cotejo equivocado no es silencioso —`bank match unapply` lo deshace y deja el motivo—, pero cuesta la revisión que pretendía ahorrar.',
  'policy.match_confidence_threshold.rationale':
    'Es lo que el motor ya usaba antes de que se le preguntara a nadie. Se nombra aquí para que deje de ser un accidente del código.',
  'policy.match_confidence_threshold.why':
    'Cada renglón del banco tiene que terminar emparejado con algo de tus libros. Puedo hacerlo por ti cuando el importe y la fecha coinciden, pero «qué tan cerca es suficientemente cerca» es un juicio sobre tu propia tolerancia a deshacer mis errores, no un dato que yo pueda consultar.',
  'policy.match_confidence_threshold.what':
    'Por encima de este número emparejo el renglón y registro qué tan seguro estaba. Por debajo te lo dejo con mi mejor candidato y el motivo por el que no alcanzó. La sola similitud de la descripción NUNCA empareja nada, con ningún umbral.',
  'policy.match_confidence_threshold.if_skipped':
    'Uso 0.85, que empareja cuando importe y fecha coinciden de cerca y te deja el resto.',
  'policy.match_confidence_threshold.option.0_75':
    'Holgado: empareja más por su cuenta; espera deshacer algunos',
  'policy.match_confidence_threshold.option.0_85':
    'Equilibrado: sólo empareja cuando importe y fecha coinciden de cerca',
  'policy.match_confidence_threshold.option.0_95':
    'Estricto: el motor casi no decide nada solo',

  'policy.match_max_auto_amount.question':
    '¿Por encima de qué importe una persona tiene que confirmar un cotejo, por seguro que esté el motor?',
  'policy.match_max_auto_amount.impact':
    'Una segunda compuerta de `bank match run`, independiente de la confianza: por encima de este importe el renglón se le deja a una persona aun con 0.99. Se combina con el piso inquebrantable por Math.min, así que siempre gana el más estricto de los dos y ningún valor de aquí lo puede subir.',
  'policy.match_max_auto_amount.rationale':
    'Se alinea con FLOOR_MAX_AUTO_POST para que haya una sola cifra sobre la cual razonar, no dos. Es un techo para el motor, nunca un permiso: el piso lo sigue acotando.',
  'policy.match_max_auto_amount.why':
    'La confianza mide qué tanto se parecen dos registros, no cuánto cuesta equivocarse. Una transferencia grande que se ve exactamente como una factura sigue siendo la que querrías ver con tus propios ojos.',
  'policy.match_max_auto_amount.what':
    'Por encima de este importe me detengo y te muestro el candidato en vez de emparejarlo, sin importar qué tan seguro esté. Por debajo, decide el umbral de confianza.',
  'policy.match_max_auto_amount.if_skipped':
    'Me detengo en $50,000, el mismo techo que gobierna la contabilización automática.',
  'policy.match_max_auto_amount.option.10000':
    '$10,000 — una persona ve cada movimiento importante',
  'policy.match_max_auto_amount.option.50000':
    '$50,000 — el mismo techo que usa el piso de contabilización automática',
  'policy.match_max_auto_amount.option.0':
    'Sin compuerta de importe: decide sólo la confianza',

  'policy.short_payment_residual.question':
    'Cuando una cuenta por pagar se cierra pagando menos de lo que se debía, ¿a dónde va el faltante?',
  'policy.short_payment_residual.impact':
    'Gobierna `payment apply --mode residual`. Con «descuento_compras» el faltante cae en 5200 (contracosto), la misma cuenta que un descuento por pronto pago, así que el costo de la compra baja. Con «otros_ingresos» es en cambio un ingreso del periodo y el costo no se toca. Con «prohibir» el modo se rechaza de plano y la cuenta por pagar sigue abierta hasta que el proveedor emita una nota de crédito.',
  'policy.short_payment_residual.rationale':
    'Mantiene un pago corto y un descuento por pronto pago en la misma cuenta, que es lo que económicamente son: menos pagado por la misma compra. También evita inflar los ingresos con algo que nunca fue una venta.',
  'policy.short_payment_residual.why':
    'A veces una cuenta por pagar se liquida por menos de su saldo —un flete en disputa, unos pesos de redondeo, una deducción pactada— y el resto nunca se va a pagar. Ese resto tiene que dejar de ser un pasivo, y a dónde lo mandes cambia tu costo de ventas y tus ingresos. Es un criterio de tu despacho, no una regla del SAT.',
  'policy.short_payment_residual.what':
    'Cuando cierras corta una cuenta por pagar con `payment apply --mode residual --short-pay-reason "..."`, contabilizo el faltante en la cuenta que elijas aquí y escribo tu motivo en la póliza, para que el auditor lea por qué desapareció el pasivo. Si eliges «prohibir», me niego a la operación y te digo que le pidas una nota de crédito al proveedor.',
  'policy.short_payment_residual.if_skipped':
    'Los faltantes van a descuentos sobre compras (5200). Nada se rompe, pero si tu criterio es tratarlos como ingreso, el costo de ventas quedará subestimado hasta que lo digas.',
  'policy.short_payment_residual.option.descuento_compras':
    'Contracosto (5200): reduce lo que costó la compra, como un descuento',
  'policy.short_payment_residual.option.otros_ingresos':
    'Otros ingresos: el costo se queda y el faltante es una ganancia del periodo',
  'policy.short_payment_residual.option.prohibir':
    'Negarse: ninguna cuenta por pagar cierra corta; exigir la nota de crédito del proveedor',

  'policy.received_credit_note_cost.question': 'Cuando un proveedor manda una nota de crédito de un gasto, ¿qué cuenta recibe el costo que baja?',
  'policy.received_credit_note_cost.impact': 'Gobierna la póliza de una nota de crédito recibida que se contabiliza desde la bandeja (`bill inbox run`). Con «bill_accounts» el costo regresa a las cuentas de gasto que el gasto cargó, en proporción a sus renglones. Con «purchase_returns» va a devoluciones y descuentos sobre compras (5200), haya cargado lo que haya cargado el gasto. El pasivo y el IVA se mueven igual en los dos casos.',
  'policy.received_credit_note_cost.rationale': 'Reversa lo que el gasto registró, así que nada se mueve entre el costo de ventas y los gastos de operación, que un estado de resultado integral clasificado por función presenta por separado (NIF B-3). Un gasto de operación bajado por la 5200 subestimaría un costo de ventas del que nunca fue parte.',
  'policy.received_credit_note_cost.why': 'Una nota de crédito baja lo que costó una compra. Unos despachos lo quieren en la misma cuenta del gasto; otros llevan las devoluciones y descuentos en su propia cuenta para ver cuánto regresan los proveedores.',
  'policy.received_credit_note_cost.what': 'Cuando contabilizas desde la bandeja la nota de crédito de un proveedor, cargo proveedores por su total, saco su IVA de donde está el IVA de su gasto y abono el costo a la cuenta que elijas aquí.',
  'policy.received_credit_note_cost.if_skipped': 'El costo regresa a las cuentas de gasto del gasto.',
  'policy.received_credit_note_cost.option.bill_accounts': 'Las cuentas que el gasto cargó: la nota reversa lo que se registró',
  'policy.received_credit_note_cost.option.purchase_returns': 'Devoluciones y descuentos sobre compras (5200): lo que regresan los proveedores se ve aparte',

  'policy.employment_subsidy_paid_treatment.question':
    'El subsidio para el empleo sobre el ISR que se le entregó en efectivo al trabajador (la regla anterior al 1 de mayo de 2024): ¿es una cuenta por cobrar al fisco o un gasto del despacho?',
  'policy.employment_subsidy_paid_treatment.impact':
    'Decide si el efectivo que entregas regresa como acreditamiento contra el ISR retenido a otros trabajadores, o cae en gasto de nómina y nunca regresa.',
  'policy.employment_subsidy_paid_treatment.rationale':
    'Es lo que permite la ley y lo que de verdad es el dinero: el patrón adelanta efectivo que la autoridad le devuelve vía acreditamiento. Mandarlo a gasto es decidir renunciar a ese acreditamiento, lo que algunos despachos hacen a propósito cuando los importes son pequeños y el papeleo no vale la pena; pero debe ser una decisión, no la consecuencia de un valor por omisión.',
  'policy.employment_subsidy_paid_treatment.why':
    'Hasta el 30 de abril de 2024, cuando el subsidio era mayor que el ISR del periodo el patrón debía entregarle la diferencia en efectivo al trabajador. Ese dinero salió del despacho y sólo regresa si lo acreditas, así que dónde lo registras cambia tu gasto de nómina y lo que le debes al SAT. Un recibo pagado desde el 1 de mayo de 2024 no entrega nada (decreto DOF 01-05-2024): eso es ley, y esta decisión no le aplica. Sí aplica a un recibo que ya se calculó con ese efectivo.',
  'policy.employment_subsidy_paid_treatment.what':
    'En un recibo que entregó efectivo, contabilizo ese efectivo en la cuenta que nombra esta política; con «cuenta_por_cobrar_fisco» además lo compenso contra el ISR retenido que reporta la declaración mensual. En un recibo pagado desde el 1 de mayo de 2024 la retención de ISR es cero, no se entrega nada y no contabilizo nada por el excedente, diga lo que diga esta política.',
  'policy.employment_subsidy_paid_treatment.if_skipped':
    'Va a una cuenta por cobrar a la autoridad. Nada se rompe; si tu criterio es absorberlo, el gasto de nómina quedará subestimado hasta que lo digas.',
  'policy.employment_subsidy_paid_treatment.option.cuenta_por_cobrar_fisco':
    'Una cuenta por cobrar: se acredita contra el ISR retenido a otros trabajadores',
  'policy.employment_subsidy_paid_treatment.option.gasto_del_patron':
    'Un gasto: el despacho lo absorbe y no lo acredita',

  'policy.employment_subsidy_rounding.question':
    '¿Cómo redondeas el subsidio para el empleo de un periodo de pago menor a un mes: una vez, sobre el importe del periodo, o primero sobre el importe diario?',
  'policy.employment_subsidy_rounding.impact':
    'Mueve unos centavos el subsidio de una semana o una quincena, y con él el ISR retenido, el efectivo entregado al trabajador y el CFDI de nómina. En 2026 sólo cambia enero: la quincena es de 264.58 con un redondeo y de 264.60 redondeando primero el importe diario.',
  'policy.employment_subsidy_rounding.rationale':
    'Un solo redondeo, hacia arriba en el medio, sobre el resultado es la lectura que sigue el decreto al pie de la letra —un porcentaje de la UMA mensual, dividido entre 30.4 y multiplicado por los días— sin meter una cifra intermedia que el decreto nunca nombra. De febrero a diciembre de 2026 da 535.65 al mes, 264.30 a la quincena y 123.34 a la semana. El 536.22 del considerando del decreto no es una opción: ningún redondeo de la UMA vigente lo produce.',
  'policy.employment_subsidy_rounding.why':
    'El decreto fija el porcentaje de la UMA y dice dividir entre 30.4 y multiplicar por los días, pero no dónde redondear. El software de nómina y los despachos lo hacen de las dos formas, y la diferencia llega al trabajador y al SAT.',
  'policy.employment_subsidy_rounding.what':
    'Cada corrida de nómina mexicana calcula el subsidio mensual al centavo y deriva el del periodo de ese importe mensual redondeado, de la forma que elijas aquí. La nota del recibo nombra el redondeo usado.',
  'policy.employment_subsidy_rounding.if_skipped':
    'Redondeo una vez, sobre el importe del periodo. De febrero a diciembre las dos opciones dan las mismas cifras.',
  'policy.employment_subsidy_rounding.option.producto_al_centavo':
    'Una vez: el importe mensual al centavo, luego mensual × días / 30.4 al centavo',
  'policy.employment_subsidy_rounding.option.diario_al_centavo':
    'Primero el importe diario: mensual / 30.4 al centavo, luego × los días del periodo',

  'policy.employment_subsidy_separate_run.question':
    'Cuando un trabajador recibe un segundo recibo en el mismo periodo de pago (un aguinaldo pagado en su propia corrida, por ejemplo), ¿cuánto subsidio al empleo lleva?',
  'policy.employment_subsidy_separate_run.impact':
    'Decide el subsidio, el ISR retenido, el efectivo que se entrega al trabajador y el CFDI de nómina de cada recibo del periodo. En cualquier caso el periodo nunca recibe el subsidio dos veces; con el recálculo sigue al ingreso de todo el periodo, y con "ninguno" se queda en el recibo ordinario.',
  'policy.employment_subsidy_separate_run.rationale':
    'El decreto que rige el subsidio (DOF 31-12-2025) otorga un importe por periodo a quien no gana más de un tope mensual, así que el importe y el tope se miden sobre el ingreso del periodo, no de cada recibo. Recalcular sobre el ingreso combinado aplica ese tope a todo el periodo, y un recibo posterior acredita sólo lo que los anteriores no. Cuando el ingreso combinado rebasa el tope, el subsidio que ya causó un recibo anterior no procedía: el recibo posterior no acredita nada más, pero ese subsidio no se recupera, así que entonces el resultado difiere de pagar el aguinaldo junto con el sueldo, que no daría subsidio alguno.',
  'policy.employment_subsidy_separate_run.why':
    'El decreto mide el subsidio y su tope de ingreso por periodo de pago, no por recibo, y pagar el aguinaldo en su propia corrida es común. Sin una regla el segundo recibo del periodo volvía a recibir el subsidio y entregaba en efectivo al trabajador la parte que excedía su ISR.',
  'policy.employment_subsidy_separate_run.what':
    'Antes de acreditar el subsidio en un recibo, leo los otros recibos calculados, aprobados o pagados del mismo trabajador y periodo. Con "recompute_on_combined_income" calculo el subsidio sobre su ingreso más el de éste y acredito la diferencia, nunca menos de cero. Con "none_on_separate_paycheck" un recibo de una corrida que no es la ordinaria, o uno que sólo paga aguinaldo, no lleva ninguno, y el recibo ordinario conserva el suyo sin importar cuál se calculó primero.',
  'policy.employment_subsidy_separate_run.if_skipped':
    'Recalculo sobre el ingreso combinado del periodo y acredito sólo la diferencia.',
  'policy.employment_subsidy_separate_run.option.recompute_on_combined_income':
    'Recalcularlo una sola vez sobre el ingreso de ambos recibos, y acreditar en el segundo sólo la diferencia',
  'policy.employment_subsidy_separate_run.option.none_on_separate_paycheck':
    'Ninguno en el recibo aparte: una corrida que no es la ordinaria, o un recibo que sólo paga aguinaldo, no lleva subsidio; el recibo ordinario conserva el suyo',

  'policy.imss_old_age_band_edge.question':
    'Cuando el SBC de un trabajador queda apenas arriba del límite superior de un tramo de la cuota patronal de cesantía en edad avanzada y vejez, ¿qué tramo paga?',
  'policy.imss_old_age_band_edge.impact':
    'Decide la tasa de la cuota patronal de cesantía en edad avanzada y vejez de un SBC que cae entre dos tramos de la LSS art. 168 fr. II a), y con ella el recibo, la póliza de nómina, el pasivo patronal y el archivo del SUA. En marzo de 2026 un SBC de 352.00 (3.0006 UMA) paga 6.361 % con "above_upper_edge" (335.86 por quincena) y 6.026 % con "truncated_to_hundredths" (318.17); uno de 316.00 (1.003 salarios mínimos) paga 6.026 % (285.63) o 3.150 % (149.31).',
  'policy.imss_old_age_band_edge.rationale':
    'La LSS art. 168 fr. II a) cobra todo SBC pero escribe sus tramos a dos decimales sin regla de redondeo; leer «1.51» como «más de 1.50» conserva cada límite superior como está escrito y nunca calcula menos de lo que la tabla puede exigir.',
  'policy.imss_old_age_band_edge.why':
    'La tabla escribe sus límites a dos decimales («3.00 UMA» y luego «3.01 UMA») y no da regla de redondeo, así que la ley no dice qué tramo paga un SBC de 3.0006 UMA. Si el programa con el que determinas tus cuotas trunca, elige esa opción para que ambos den la misma cifra.',
  'policy.imss_old_age_band_edge.what':
    'Por cada día cotizado ubico el SBC, topado a 25 UMA, con la UMA y el salario mínimo general vigentes ese día, y cobro la tasa de ese tramo y año de la tabla con fechas. La nota del cálculo nombra el tramo, la tasa y la regla usada.',
  'policy.imss_old_age_band_edge.if_skipped':
    'Un SBC arriba de un límite superior paga el tramo siguiente.',
  'policy.imss_old_age_band_edge.option.above_upper_edge':
    'Un SBC arriba del límite superior de un tramo, por cualquier monto, paga el tramo siguiente',
  'policy.imss_old_age_band_edge.option.truncated_to_hundredths':
    'SBC ÷ salario mínimo y SBC ÷ UMA se cortan a dos decimales y luego se ubican en la tabla',

  'policy.imss_old_age_minimum_wage_area.question':
    '¿Con qué salario mínimo se mide el tramo «1.00 SM» de la cuota patronal de cesantía en edad avanzada y vejez: el del área de tu registro patronal, o el de la zona general para todo trabajador?',
  'policy.imss_old_age_minimum_wage_area.impact':
    'Decide qué SBC paga la tasa más baja de la cuota patronal de cesantía en edad avanzada y vejez (LSS art. 168 fr. II a). En marzo de 2026, para una entidad registrada en la frontera norte, un SBC de 400.00 paga 3.150 % con "employer_registration_area" (189.00 por quincena, bajo su mínimo de 440.87) y 6.361 % con "general_zone" (381.66, medido con 315.04).',
  'policy.imss_old_age_minimum_wage_area.rationale':
    'Un salario mínimo general rige para los trabajadores de su propia área (LFT art. 92), y el IMSS determina las cuotas de cada registro patronal (LSS arts. 28 y 39), así que el tramo se mide con el mínimo del área del registro. Una entidad que no ha declarado su zona se mide con el mínimo general, y la nota del cálculo lo dice.',
  'policy.imss_old_age_minimum_wage_area.why':
    'La tabla nombra su primer tramo en salarios mínimos, y México tiene dos mínimos generales: el de la zona general y el de la Zona Libre de la Frontera Norte. Si el programa con el que determinas tus cuotas usa el mínimo de la zona general para todo registro, elige esa opción para que ambos den la misma cifra.',
  'policy.imss_old_age_minimum_wage_area.what':
    'Por cada día cotizado tomo el salario mínimo general del área que esta política nombra, vigente ese día, y ubico el SBC en el tramo de la tabla con fechas. La nota del cálculo nombra el mínimo, su área y si la entidad la declaró.',
  'policy.imss_old_age_minimum_wage_area.if_skipped':
    'Uso el mínimo del área del registro patronal, que es la zona declarada de la entidad, o el mínimo general mientras no haya una declarada.',
  'policy.imss_old_age_minimum_wage_area.option.employer_registration_area':
    'El mínimo general del área del registro patronal (la zona declarada de la entidad)',
  'policy.imss_old_age_minimum_wage_area.option.general_zone':
    'El mínimo de la zona general para todo trabajador, sea cual sea el área del registro',

  'policy.filing_rounding_to_pesos.question':
    'En el papel de trabajo fiscal del mes, ¿qué cifras ajustas a pesos: cada renglón que capturas o sólo el importe a pagar?',
  'policy.filing_rounding_to_pesos.impact':
    'Puede mover el IVA a pagar uno o dos pesos: ajustar cada renglón y sumar pesos no es lo mismo que sumar centavos y ajustar el resultado.',
  'policy.filing_rounding_to_pesos.rationale':
    'El art. 20 del CFF ajusta a pesos las cantidades de una declaración (de 1 a 50 centavos a la unidad anterior, de 51 a 99 a la siguiente), después de redondear al centavo los cuatro decimales del mayor. Ajustar cada renglón antes de sumarlo deja en pesos cada cifra capturada, como la ley pide de cada cantidad. Premisa sin verificar: que el formulario vigente de IVA en Declaraciones y Pagos capture cada renglón en pesos; si captura sólo las bases y calcula él el impuesto, ninguna de las dos opciones lo modela.',
  'policy.filing_rounding_to_pesos.why':
    'El art. 20 del CFF dice que las cantidades de una declaración se ajustan a pesos, pero no en qué paso del cálculo. Los despachos lo hacen de las dos maneras, y el IVA a pagar que declaran puede diferir uno o dos pesos.',
  'policy.filing_rounding_to_pesos.what':
    'El papel de trabajo muestra siempre dos columnas, los centavos rastreables al mayor y los pesos a capturar, y obtiene el IVA a pagar o a favor como elijas aquí.',
  'policy.filing_rounding_to_pesos.if_skipped':
    'Ajusto cada renglón a pesos antes de sumarlo.',
  'policy.filing_rounding_to_pesos.option.cada_renglon':
    'Cada renglón: cada cifra capturada se ajusta a pesos y el cálculo sigue en pesos enteros',
  'policy.filing_rounding_to_pesos.option.solo_el_pago':
    'Sólo el pago: el cálculo corre en centavos y sólo el resultado se ajusta a pesos',
  'policy.iva_creditable_proration.question':
    'Cuando la entidad cobra actos exentos o no objeto junto a gravados, ¿qué proporción acredita el IVA que pagó: la del mes o la del año anterior?',
  'policy.iva_creditable_proration.impact':
    'Mueve el IVA acreditable de cada mes con actividades mixtas, y con él el IVA a pagar. "monthly" divide los actos gravados cobrados en el mes entre todos los actos cobrados en él; "annual" usa esa proporción sobre el año de calendario anterior. En los dos casos la proporción multiplica todo el IVA pagado del mes.',
  'policy.iva_creditable_proration.rationale':
    'El art. 5 fr. V inc. c de la LIVA (inc. d num. 3 para inversiones) acredita el IVA de lo que sirve a actos gravados y exentos en la proporción que los actos gravados representan en el total de actos del mes: es la regla de la ley, y sigue a la actividad de la entidad conforme cambia. El art. 5-B, vigente desde su última reforma (DOF 12-11-2021), permite aplicar en su lugar la proporción del año de calendario anterior y obliga a mantener la opción sesenta meses, así que es una elección que se toma a propósito, no un valor por omisión. El mayor no dice qué gasto sirve sólo a actos gravados (inc. a, acreditable completo) o sólo a exentos (inc. b, no acreditable), así que la proporción del mes se aplica a todo el IVA pagado: sobrestima el acreditable de un gasto sólo de exentos y subestima el de uno sólo de gravados, y el papel de trabajo lo avisa siempre. Premisa sin verificar: la proporción se usa como cociente exacto; si el formulario de Declaraciones y Pagos la captura con un número fijo de decimales, el acreditable puede diferir en centavos.',
  'policy.iva_creditable_proration.why':
    'La ley da las dos proporciones y la elección es del contribuyente. La anual suaviza los meses, y una vez elegida se mantiene sesenta meses.',
  'policy.iva_creditable_proration.what':
    'El papel de trabajo mensual del IVA acredita todo el IVA pagado en el mes por la proporción que elijas aquí, muestra la proporción y sus actos, y resta sólo la parte acreditable. Con "annual", un año anterior sin ningún acto cobrado, o uno que el mayor no tiene desde enero, detiene el papel de trabajo en vez de suponer una proporción. No hago cumplir el candado de sesenta meses del art. 5-B: cambiar esta respuesta queda bajo tu responsabilidad.',
  'policy.iva_creditable_proration.if_skipped':
    'Uso la proporción del mes.',
  'policy.iva_creditable_proration.option.monthly':
    'La proporción del mes, sobre todo el IVA pagado (art. 5 fr. V inc. c LIVA)',
  'policy.iva_creditable_proration.option.annual':
    'La proporción del año de calendario anterior, sobre todo el IVA pagado (art. 5-B LIVA)',
  'policy.provisional_isr_sales_returns.question':
    'En el ISR provisional, ¿las devoluciones, descuentos y bonificaciones sobre ventas disminuyen los ingresos nominales, o se dejan a la declaración anual como deducción?',
  'policy.provisional_isr_sales_returns.impact':
    'Mueve los ingresos nominales de cada pago provisional de ISR por las devoluciones del ejercicio, y la utilidad estimada por ese importe por el coeficiente.',
  'policy.provisional_isr_sales_returns.rationale':
    'El art. 14 fr. I de la LISR toma como ingresos nominales los ingresos acumulables, menos sólo el ajuste anual por inflación acumulable, y el art. 25 fr. I hace de las devoluciones, descuentos y bonificaciones del ejercicio una deducción, no un ingreso menor. El coeficiente de la declaración anual divide la utilidad fiscal entre esos ingresos nominales brutos, así que una base mensual armada igual es aquella contra la que se midió el coeficiente. Premisa sin verificar: que la declaración anual de la que sale el coeficiente declaró las devoluciones como deducción; un despacho cuya declaración las restó al ingreso elige la otra opción.',
  'policy.provisional_isr_sales_returns.why':
    'La ley llama deducción a las devoluciones, pero los despachos que las restan al ingreso en la anual también las restan cada mes. El coeficiente y los ingresos nominales del mes tienen que armarse igual.',
  'policy.provisional_isr_sales_returns.what':
    'El papel de trabajo lista aparte de los ingresos nominales las cuentas de ingreso con el rol de devoluciones sobre ventas, y las suma o no según elijas aquí.',
  'policy.provisional_isr_sales_returns.if_skipped':
    'Dejo las devoluciones fuera de los ingresos nominales, como deducción de la declaración anual.',
  'policy.provisional_isr_sales_returns.option.deduction':
    'Deducción: los ingresos nominales son brutos y las devoluciones esperan a la declaración anual',
  'policy.provisional_isr_sales_returns.option.net_of_income':
    'Netas del ingreso: las devoluciones del ejercicio se restan de los ingresos nominales',
  'policy.overtime_isr_exemption.question':
    '¿Aplicas a las horas extra que pagas la exención de ISR del art. 93 fr. I de la LISR?',
  'policy.overtime_isr_exemption.impact':
    'Mueve el ISR retenido en cada recibo con horas extra, y la parte exenta que declara el CFDI de nómina. "exempt_by_law" exenta el 50 % de las horas dobles dentro del límite semanal de la LFT, hasta 5 UMA diarias de la fecha de pago por cada semana del periodo; las horas triples van como una percepción aparte y gravan completas. "taxed_in_full" grava todas las horas extra.',
  'policy.overtime_isr_exemption.rationale':
    'El art. 93 fr. I de la LISR exenta el 50 % del tiempo extraordinario dentro del límite de la ley laboral (art. 66 de la LFT, fechado por la reforma del DOF 01-05-2026), hasta 5 veces el salario mínimo (la UMA desde el DOF 27-01-2016) por cada semana de servicios. Retener sobre la mitad exenta le retiene de más al trabajador cada periodo. Gravarlas completas es para un despacho que no puede acreditar que las horas se trabajaron, donde el SAT rechazaría la exención.',
  'policy.overtime_isr_exemption.why':
    'La ley exenta una parte de las horas extra, pero sólo de las que de verdad se trabajaron y se registraron. Un despacho con control de asistencia aplica la exención; uno sin él puede preferir retener sobre todas.',
  'policy.overtime_isr_exemption.what':
    'Con "exempt_by_law" separo cada renglón de horas extra en su parte exenta y su parte gravada y calculo el ISR sobre la gravada. Cada renglón de horas extra debe traer sus `hours`: un renglón sin ellas, o unas horas que, sumadas a los demás renglones y corridas del mismo periodo, pasan el límite semanal de la LFT, detienen la corrida antes de escribir ningún recibo. Con "taxed_in_full" el renglón entero grava y no hacen falta las horas.',
  'policy.overtime_isr_exemption.if_skipped':
    'Aplico la exención de la ley.',
  'policy.overtime_isr_exemption.option.exempt_by_law':
    'Exentarlas como dice el art. 93 fr. I de la LISR: la mitad, hasta 5 UMA por semana',
  'policy.overtime_isr_exemption.option.taxed_in_full':
    'Gravar todas las horas extra, sin exención',

  'policy.overtime_exempt_weeks.question':
    '¿Cuántas semanas de servicios cuenta un periodo de pago para el tope de horas extra del art. 93 fr. I de la LISR (5 UMA por semana)?',
  'policy.overtime_exempt_weeks.impact':
    'Mueve la parte exenta de las horas extra de cada periodo que no es un número entero de semanas, y el límite de horas de la LFT de ese periodo: una quincena recibe 5 × 15/7 UMA (1 256.89 desde febrero de 2026) con "calendar_days_over_seven", y 5 × 2 UMA (1 173.10) con "whole_weeks_of_period". Una nómina semanal recibe 5 UMA en ambos casos.',
  'policy.overtime_exempt_weeks.rationale':
    'La fracción I topa la exención "por cada semana de servicios" y ni la LISR, ni su reglamento, ni la RMF dicen cómo las cuenta un periodo que no es un número entero de semanas. Días / 7 escala el tope semanal a los días del periodo, como la tarifa del ISR de cada periodo se escala a sus días (Anexo 8 de la RMF: tarifas semanal, decenal, quincenal y mensual). Semanas completas es la lectura más estricta del texto y nunca exenta una fracción de semana: retiene más. Confirma este valor por omisión.',
  'policy.overtime_exempt_weeks.why':
    'La ley topa las horas extra por semana, pero la mayoría de las nóminas pagan por quincena o por mes, y hay dos formas honestas de contar las semanas que contienen.',
  'policy.overtime_exempt_weeks.what':
    'Multiplico el tope de 5 UMA y las horas semanales de la LFT por las semanas que da esta respuesta: los días del periodo / 7, o las semanas completas que contiene.',
  'policy.overtime_exempt_weeks.if_skipped':
    'Cuento los días del periodo / 7.',
  'policy.overtime_exempt_weeks.option.calendar_days_over_seven':
    'Los días de calendario del periodo / 7: una quincena son 15/7 semanas',
  'policy.overtime_exempt_weeks.option.whole_weeks_of_period':
    'Sólo las semanas completas del periodo: una quincena son 2 semanas, un mes 4',

  'policy.isn_taxing_state.question':
    'Para el impuesto sobre nómina (ISN), ¿a qué estado pertenece un trabajador: al estado donde se presta el trabajo, o al del domicilio fiscal del despacho?',
  'policy.isn_taxing_state.impact':
    'Decide en qué estado declaras y a qué tasa: las tasas van de cerca del 1% al 4% y cada estado fiscaliza lo suyo.',
  'policy.isn_taxing_state.rationale':
    'El ISN es un impuesto estatal sobre la nómina pagada por trabajo prestado dentro de ese estado, así que el estado donde se trabaja es el que lo puede exigir. Un despacho cuyos trabajadores están todos en el domicilio fiscal obtiene la misma respuesta de las dos formas; uno con gente en varios estados no, y declarar todo en el estado de la oficina matriz es como un despacho acaba debiéndole a otro estado durante años sin saberlo.',
  'policy.isn_taxing_state.why':
    'Las plantillas remotas y en varios estados hacen de esto una bifurcación real, y no es una regla que el sistema pueda resolver: depende de dónde están tus establecimientos y de lo que dice de ellos la ley de cada estado.',
  'policy.isn_taxing_state.what':
    'Agrupo cada corrida de nómina por el estado al que apunta esta política, busco la tasa de ese estado para el periodo y devengo un pasivo de ISN por estado. Si un estado no tiene tasa capturada, digo qué estado y qué periodo en vez de calcular cero.',
  'policy.isn_taxing_state.if_skipped':
    'Uso el estado donde trabaja el empleado. Si tus establecimientos están todos en un estado, esto no cambia nada.',
  'policy.isn_taxing_state.option.centro_de_trabajo':
    'Donde se presta el trabajo (el estado donde trabaja el empleado)',
  'policy.isn_taxing_state.option.domicilio_fiscal':
    'El estado del domicilio fiscal del despacho, para cada trabajador',

  'policy.isn_recognition_basis.question':
    '¿Devengas el ISN cuando se gana la nómina, o cuando se paga?',
  'policy.isn_recognition_basis.impact':
    'Mueve el gasto entre meses cada vez que un periodo de pago cruza un fin de mes.',
  'policy.isn_recognition_basis.rationale':
    'El gasto de nómina sobre el que va montado está devengado, y separar el impuesto de su base pone los dos en meses distintos sin razón. Los despachos con criterio de flujo de efectivo para los impuestos estatales pueden decirlo aquí.',
  'policy.isn_recognition_basis.why':
    'Un periodo de pago que empieza en un mes y termina en el siguiente tiene que caer en algún lado, y las dos respuestas dan resultados mensuales distintos.',
  'policy.isn_recognition_basis.what':
    'Fecho el pasivo de ISN con el criterio que elijas aquí, y el vencimiento con el calendario del estado en cualquier caso.',
  'policy.isn_recognition_basis.if_skipped':
    'Se devenga con la nómina que lo causó.',
  'policy.isn_recognition_basis.option.devengo':
    'Cuando se gana, con la nómina a la que pertenece',
  'policy.isn_recognition_basis.option.pago':
    'Cuando se paga, con el efectivo que sale',

  'policy.employer_contribution_accrual.question':
    '¿Devengas las cuotas patronales del IMSS y del INFONAVIT con cada corrida de nómina, o una vez al mes cuando se pagan?',
  'policy.employer_contribution_accrual.impact':
    'Decide si una nómina de mediados de mes muestra su costo patronal de inmediato o sólo al fin de mes.',
  'policy.employer_contribution_accrual.rationale':
    'La cuota patronal es un costo del mismo trabajo que paga la nómina, y devengarla con su corrida mantiene completo el costo de un periodo sin esperar al fin de mes. Los despachos que concilian contra el SUA renglón por renglón suelen preferir el devengo mensual, y ése es un criterio real, no un error.',
  'policy.employer_contribution_accrual.why':
    'El IMSS y el INFONAVIT se pagan mensual y bimestralmente, no por corrida de nómina, así que hay una elección genuina entre empatar el costo y empatar el pago.',
  'policy.employer_contribution_accrual.what':
    'Escribo un renglón de pasivo patronal por corrida de nómina o uno por mes según esto, y la conciliación del SUA lee el que hayas elegido.',
  'policy.employer_contribution_accrual.if_skipped':
    'Se devengan con cada corrida de nómina.',
  'policy.employer_contribution_accrual.option.por_corrida':
    'Con cada corrida de nómina, junto a la nómina que la causó',
  'policy.employer_contribution_accrual.option.mensual_al_cierre':
    'Una vez al mes, igual que como de verdad se pagan',

  'policy.archived_accounts_in_reports.question':
    'Una vez archivada una cuenta, ¿conserva su renglón en una balanza donde no tiene nada que mostrar?',
  'policy.archived_accounts_in_reports.impact':
    'Sólo afecta a una cuenta archivada que NUNCA recibió un renglón contabilizado antes de la fecha de corte: una línea del catálogo que se abrió y se retiró sin usarse nunca. En cuanto una cuenta archivada tiene cualquier historial contabilizado, se muestra en todos los informes y ningún valor de aquí la puede esconder: eso es lo que impidió que un estado de resultados firmado cambiara cuando se ordenó el catálogo, y es conservador a propósito; la regla se inclina por mostrar, porque la falla que existe para evitar es dinero que desaparece de un estado firmado. Lo que esto decide es si la línea retirada que nunca se usó conserva su renglón en cero, mes tras mes.',
  'policy.archived_accounts_in_reports.rationale':
    'Es PARA lo que sirve archivar —el despacho retiró la línea para dejar de verla— y es lo que ya hacían los informes, así que ninguna balanza gana renglones que nunca tuvo. Conservarla es un criterio real para un despacho que concilia el Anexo 24 contra un catálogo fijo y quiere el mismo juego de renglones cada periodo; ninguna de las dos respuestas mueve una cifra, que es justo por lo que es una preferencia y no una corrección.',
  'policy.archived_accounts_in_reports.why':
    'Retirar una línea de tu catálogo al cierre del ejercicio es rutina. Lo que no es obvio es si esa línea debe desaparecer de la balanza del año siguiente o quedarse ahí en cero, y las dos son contabilidad defendible.',
  'policy.archived_accounts_in_reports.what':
    'En la balanza siempre incluyo una cuenta archivada que el mayor respalda hasta la fecha de corte del informe —CUALQUIER renglón contabilizado hasta ella, no sólo movimiento en el rango—, así que ninguna cifra desaparece nunca. Con «retirar» dejo fuera las cuentas archivadas que nunca recibieron uno; con «mantener» las conservo, en cero, junto a las cuentas vigentes sin uso que la balanza ya lista. El estado de resultados, el balance general y el mayor no leen esta política en absoluto: ya muestran exactamente las cuentas que llevan algo en el periodo.',
  'policy.archived_accounts_in_reports.if_skipped':
    'Una cuenta archivada que nunca se usó sale de la balanza. Toda cuenta archivada con historial contabilizado se queda, siempre.',
  'policy.archived_accounts_in_reports.option.retirar_cuando_no_tiene_nada':
    'Quitarla: una línea archivada que nunca se usó sale de la balanza',
  'policy.archived_accounts_in_reports.option.mantener_en_la_balanza':
    'Conservarla en cero, como cualquier cuenta sin uso, para que el juego de renglones coincida con el catálogo cada mes',

  'policy.cash_flow_unclassified.question':
    'Cuando una cuenta se movió pero no pertenece a ninguna sección del estado de flujos de efectivo, ¿publico el estado nombrándola o me niego hasta que tenga una?',
  'policy.cash_flow_unclassified.impact':
    'Esta NO es la misma pregunta que la de un estado que no cuadra con el efectivo. Dos cuentas sin clasificar cuyos importes se cancelan dejan el neto cuadrando perfecto contra el banco mientras operación, inversión y financiamiento están cada uno mal por la parte que les tocaba. El residuo es invisible desde fuera: nadie lo puede detectar comparando contra el estado de cuenta del banco.',
  'policy.cash_flow_unclassified.rationale':
    'Negarse dejaría al despacho sin un estado que puede necesitar para un plazo de presentación, y el remedio —darle a la cuenta un fs_category— es una edición del catálogo que quien prepara el estado puede no poder hacer en ese momento. Nombrar las cuentas mantiene el documento utilizable y pone el hueco donde lo ve quien lo prepara.',
  'policy.cash_flow_unclassified.why':
    'Si un estado con una cuenta sin clasificar se puede publicar lo decides tú. Lo único que no voy a hacer es quedarme callado: una cuenta que se movió y no cayó en ninguna sección es un subtotal que está mal sin que el total lo muestre.',
  'policy.cash_flow_unclassified.what':
    'Publico el estado y nombro cada cuenta que se movió sin sección.',
  'policy.cash_flow_unclassified.if_skipped':
    'Lo publico y las nombro.',
  'policy.cash_flow_unclassified.option.avisar':
    'Publicarlo, nombrando cada cuenta que no cayó en ninguna sección',
  'policy.cash_flow_unclassified.option.bloquear':
    'Negarse a emitirlo hasta que cada cuenta que se movió tenga una sección',

  'policy.withholding_accounts_layout.question':
    '¿En qué cuentas se acumulan el ISR y el IVA que esta entidad les retiene a sus proveedores?',
  'policy.withholding_accounts_layout.impact':
    'Decide dónde se registran las retenciones de honorarios y arrendamiento hasta que el día 17 se pagan. El ISR de nómina se queda en 2140 en cualquier esquema. Una cuenta por impuesto da los dos renglones del pago mensual y de la DIOT sin partir un saldo. Tres cuentas siguen el código agrupador del SAT (216.03 arrendamiento, 216.04 servicios profesionales, 216.10 IVA); el ISR retenido sobre algo que no sea arrendamiento, incluido el 1.25 % del RESICO (LISR 113-J) sobre bienes, servicios o fletes, se registra como servicios profesionales; el arrendamiento de inmuebles de un RESICO se registra como arrendamiento. Con una cuenta por impuesto, 2141 junta el ISR de arrendamiento y de honorarios, así que su código agrupador en la balanza del Anexo 24 (CFF 28-IV) sólo puede ser uno de los dos. Una sola cuenta necesita el papel de trabajo para separar el ISR del IVA, y la aprobación de un borrador sólo puede revisar su suma.',
  'policy.withholding_accounts_layout.rationale':
    'El retenedor paga el ISR (LISR 106, 116) y el IVA (LIVA 1-A, 5-D) que retuvo con la declaración mensual que vence el día 17, como impuestos separados, y la DIOT reporta el IVA retenido por proveedor (LIVA 32-VIII): un saldo por impuesto es lo que leen las dos sin partir nada. Es con lo que se siembran las entidades.',
  'policy.withholding_accounts_layout.why':
    'Algunos despachos llevan una sola cuenta de retenciones, otros una por impuesto, otros siguen el código agrupador del SAT renglón por renglón.',
  'policy.withholding_accounts_layout.what':
    'Apunto los dos roles de retención a las cuentas del esquema, creo las que falten y registro ahí cada retención.',
  'policy.withholding_accounts_layout.if_skipped':
    'Llevo una cuenta por impuesto: 2141 para el ISR, 2142 para el IVA.',
  'policy.withholding_accounts_layout.option.per_tax':
    'Una cuenta por impuesto: 2141 ISR retenido, 2142 IVA retenido',
  'policy.withholding_accounts_layout.option.single':
    'Una cuenta para los dos: 2143 ISR e IVA retenidos',
  'policy.withholding_accounts_layout.option.by_concept':
    'Tres cuentas: 2144 ISR por arrendamiento (216.03), 2145 ISR por servicios profesionales (216.04), 2142 IVA (216.10)',

  'policy.withholding_accounts_existing.question':
    'Cuando los roles de retención de una entidad existente no siguen el esquema, ¿qué hago?',
  'policy.withholding_accounts_existing.impact':
    'Gobierna las entidades sembradas antes de que existiera el esquema (los dos roles en 2140, con el ISR de nómina) o cuyo esquema cambió. «warn» las nombra en doctor y en la lista de verificación del cierre, sin bloquear, con el comando que las arregla: `account role sync`, que tiene --dry-run. «repoint» lo corre cuando se fija esta clave o el esquema, y avisa de lo que no pudo mover. «keep» no hace ninguna de las dos. El comando crea las cuentas que faltan y reapunta los roles, con auditoría; no contabiliza nada y deja los saldos pasados donde están. Un mapeo que alguien fijó a mano nunca se sobrescribe.',
  'policy.withholding_accounts_existing.rationale':
    'Reapuntar cambia dónde caen las retenciones del mes siguiente, y el saldo que ya está en 2140 se queda ahí hasta que alguien lo reclasifique con una póliza. La contabilidad debe permitir rastrear cada operación hasta su cuenta (CFF 28, RCFF 33): un cambio que una persona revisó con --dry-run es uno que el despacho puede explicarle a un auditor; un cambio que nadie miró, no.',
  'policy.withholding_accounts_existing.why':
    'Mover los roles de una empresa que ya está contabilizando cambia sus libros a partir de la siguiente póliza.',
  'policy.withholding_accounts_existing.what':
    'Aviso y nombro `account role sync`; con «repoint» lo corro yo mismo cuando se fija el esquema.',
  'policy.withholding_accounts_existing.if_skipped':
    'Aviso, y no cambio nada.',
  'policy.withholding_accounts_existing.option.warn':
    'Avisar en doctor y en la lista de verificación del cierre, nombrando el comando',
  'policy.withholding_accounts_existing.option.repoint':
    'Reapuntarlos, con auditoría, cuando se fija el esquema',
  'policy.withholding_accounts_existing.option.keep':
    'Dejarlos como están, sin aviso',

  'policy.cheque_advance_before_cashing.question':
    'Un anticipo recibido con cheque se aplica a una factura antes de que el banco cobre el cheque, donde cancelaría IVA todavía no causado: ¿qué hago?',
  'policy.cheque_advance_before_cashing.impact':
    'Gobierna `receipt apply` de un cheque sin cobro registrado cuyo efectivo lleva el IVA de su anticipo, a una factura PPD o a una PUE de otro tratamiento. Con "refuse" no se escribe nada, y el mensaje nombra `bank check reconcile --receipt`, después del cual la aplicación pasa. Con "defer_to_cashing" una aplicación a una factura PPD se postea ya sin renglón de IVA, y el cobro compensa ese IVA contra la parte que la factura libera ese día; una PUE de otro tratamiento no libera ninguna, así que se sigue negando. Una factura PUE del mismo tratamiento del cobro se aplica en cualquier caso.',
  'policy.cheque_advance_before_cashing.rationale':
    'LIVA art. 1-B, segundo párrafo: un precio pagado con cheque se cobra, y su IVA se causa, el día en que el banco cobra el cheque. Aplicar su anticipo antes cancelaría en el mayor un IVA que nadie ha causado todavía, y el mes leería menos IVA que el papel. Negarlo no postea nada sin revisión, la opción conservadora de ADR-0006.',
  'policy.cheque_advance_before_cashing.why':
    'Algunos despachos aplican el cheque de un cliente a su factura el día que llega, antes de que el banco lo cobre. Eso funciona si el IVA del anticipo se compensa el día del cobro; negarlo mantiene cada mes exacto hasta entonces.',
  'policy.cheque_advance_before_cashing.what':
    'Con "refuse" niego la aplicación y nombro el comando del cobro. Con "defer_to_cashing" la aplico a una factura PPD sin renglón de IVA y compenso su IVA cuando se registra el cobro; una PUE de otro tratamiento la sigo negando.',
  'policy.cheque_advance_before_cashing.if_skipped': 'Niego la aplicación hasta que se registre el cobro.',
  'policy.cheque_advance_before_cashing.option.refuse': 'Negarla hasta que se registre el cobro',
  'policy.cheque_advance_before_cashing.option.defer_to_cashing':
    'Aplicarla ya a una factura PPD y compensar su IVA el día del cobro',

  'policy.plain_receipt_unapply_iva.question':
    'Un cobro sin tratamiento de anticipo se desaplica de una factura PPD: ¿el IVA que causó su cobro se queda causado, o vuelve a no cobrado?',
  'policy.plain_receipt_unapply_iva.impact':
    'Gobierna `receipt unapply` de un cobro sin tratamiento de anticipo sobre una factura PPD cuyo cobro liberó su IVA. Con "keep_caused" el IVA se queda en 2120 y el efectivo vuelve a 2150 por su base, llevando ese IVA, así que aplicarlo otra vez lo netea en lugar de causarlo dos veces. Con "repark_same_month" cada aplicación cuyo IVA se liberó en el mes calendario del desaplicar vuelve a 2125, con el IEPS que movió; una liberada en un mes anterior se queda causada, y también un cheque que el banco no ha cobrado. El papel de trabajo del IVA lo deja causado con cualquiera de las dos respuestas, y su cotejo nombra el re-aparcado.',
  'policy.plain_receipt_unapply_iva.rationale':
    'LIVA art. 1-B, primer párrafo: un precio se cobra cuando se recibe, aun como anticipo, y desaplicar no devuelve dinero. LIVA art. 7: sólo una devolución, descuento o bonificación documentada regresa el IVA. Dejarlo causado nunca baja un mes sin una devolución, la opción conservadora de ADR-0006. Re-aparcar en un mes posterior bajaría un mes ya declarado, lo que pide una declaración complementaria (CFF art. 32), así que ninguna respuesta lo hace.',
  'policy.plain_receipt_unapply_iva.why':
    'Algunos despachos tratan un desaplicar del mismo mes como la corrección de un error, y quieren que el IVA de la factura vuelva a no cobrado hasta que el efectivo se aplique otra vez. Dejarlo causado sigue la ley y se netea cuando el efectivo se aplica de nuevo.',
  'policy.plain_receipt_unapply_iva.what':
    'Con "keep_caused" dejo el IVA en 2120 y guardo en la aplicación lo que dejó causado. Con "repark_same_month" regreso a 2125 el IVA de cada aplicación liberada en el mes del desaplicar, dejo causado el resto, y el ensayo dice por qué.',
  'policy.plain_receipt_unapply_iva.if_skipped': 'Dejo el IVA causado.',
  'policy.plain_receipt_unapply_iva.option.keep_caused': 'Dejar el IVA causado y llevarlo en el efectivo que vuelve a cuenta',
  'policy.plain_receipt_unapply_iva.option.repark_same_month':
    'Re-aparcarlo cuando el desaplicar es del mes en que se liberó el IVA',

  'policy.note_reversal_after_cashing_iva.question':
    'Una nota de crédito emitida mientras esperaba el cheque de un cliente se reversa después de que el banco lo cobró: ¿en qué mes cuenta el papel del IVA el IVA que la nota ya no restituye?',
  'policy.note_reversal_after_cashing_iva.impact':
    'Gobierna el papel de trabajo del IVA después de `entry reverse` o `entry void` de esa nota. Con cualquiera de las dos respuestas el mayor postea DR 2150 / CR 2120 por ese IVA, con la fecha de la reversa, o con la del cobro cuando la reversa lleva una fecha anterior. Con "reversal_month" el papel lo cuenta en el mes de esa póliza, así que cada mes cuadra con el mayor y ningún mes ya declarado se mueve. Con "cashing_month" el papel lee la nota como nunca emitida y lo cuenta en el mes del cobro; el cotejo nombra la complementaria que ese mes necesita y la corrección en el mes de la reversa.',
  'policy.note_reversal_after_cashing_iva.rationale':
    'LIVA art. 1-B y la decisión (A) sobre el efectivo a cuenta: el efectivo que cubría la nota se le debía al cliente, no era contraprestación, y la cancelación es el acto que lo vuelve contraprestación guardada a cuenta. El mayor fecha esa corrección con la reversa (NIF B-1), y contarla ahí no cambia ningún mes ya declarado ni baja ninguno, la opción conservadora de ADR-0006. Leer el CFDI cancelado como nunca emitido (CFF art. 29-A) también se acepta, y pide una complementaria del mes del cobro (CFF art. 32).',
  'policy.note_reversal_after_cashing_iva.why':
    'Algunos despachos tratan una nota de crédito cancelada como si nunca hubiera existido y corrigen el mes que afectó; otros reconocen la cancelación en el mes en que ocurre. El mayor queda igual de cualquier modo.',
  'policy.note_reversal_after_cashing_iva.what':
    'Con "reversal_month" cuento ese IVA en el mes de la corrección de la reversa. Con "cashing_month" lo cuento en el mes del cobro y nombro, en el cotejo, la complementaria y la corrección.',
  'policy.note_reversal_after_cashing_iva.if_skipped': 'Lo cuento en el mes de la reversa.',
  'policy.note_reversal_after_cashing_iva.option.reversal_month': 'Contarlo en el mes de la reversa, como el mayor',
  'policy.note_reversal_after_cashing_iva.option.cashing_month':
    'Contarlo en el mes del cobro, como si la nota nunca se hubiera emitido',

  'policy.cash_over_limit_outside_ingestion.question':
    'Cuando una factura se liquida en efectivo por encima del límite de la LISR fuera de la ingesta de CFDI, ¿qué hago?',
  'policy.cash_over_limit_outside_ingestion.impact':
    'Gobierna `bill approve` (para una factura cuyo CFDI dice FormaPago 01) y `payment create --method cash`. Con "signal" la operación devuelve un hallazgo de deducibilidad en riesgo y no cambia nada. Con "draft_reclassification" además propone, como borrador que una persona aprueba, pasar el gasto y el IVA de la factura a la cuenta no deducible. Con "ignore" no dice nada. Una factura que creó la ingesta nunca se vuelve a juzgar: su respuesta a `efectivo_no_deducible` prevalece.',
  'policy.cash_over_limit_outside_ingestion.rationale':
    'La LISR art. 27 fr. III niega la deducción de lo pagado en efectivo por encima del límite, y la LIVA art. 5 fr. I niega con ella el acreditamiento del IVA; pero la ley atiende a cómo se pagó de verdad, y una factura sola no lo prueba (el método del CFDI puede ser el equivocado, la misma excepción que ofrece la ingesta). Los libros conservan lo asentado (NIF A-1, representación fiel) y se avisa a una persona, con las cifras, antes de presentar la declaración.',
  'policy.cash_over_limit_outside_ingestion.why':
    'El efectivo por encima del límite vuelve no deducible el gasto, pero sólo si de verdad se pagó en efectivo. Algunos despachos quieren un borrador listo, otros sólo el aviso.',
  'policy.cash_over_limit_outside_ingestion.what':
    'Comparo el efectivo con el límite vigente en la fecha del pago y lo informo; con "draft_reclassification" dejo un borrador en la cola de revisión.',
  'policy.cash_over_limit_outside_ingestion.if_skipped': 'Lo señalo y no cambio nada.',
  'policy.cash_over_limit_outside_ingestion.option.signal': 'Señalarlo y no cambiar nada: decide una persona',
  'policy.cash_over_limit_outside_ingestion.option.draft_reclassification':
    'Señalarlo y proponer la reclasificación a no deducible como borrador',
  'policy.cash_over_limit_outside_ingestion.option.ignore': 'No decir nada',

  // MNE-001-345 · el texto del hallazgo de efectivo sobre el límite (LISR art. 27 fr. III).
  'cash_limit.finding.at_approve':
    '{bill}: el CFDI declara pago en efectivo por {amount} MXN (con fecha {date}), por encima del límite de {limit} de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo si de verdad se pagó en efectivo. No se reclasificó nada.',
  'cash_limit.finding.at_payment':
    '{bill}: {amount} MXN pagados en efectivo el {date} superan el límite de {limit} de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo. No se reclasificó nada.',
  'cash_limit.finding.unavailable':
    '{bill}: pagado en efectivo el {date}, pero ninguna vigencia del límite de la LISR art. 27 fr. III cubre esa fecha, así que no se pudo juzgar. Siembra el parámetro legal y revísalo.',
  'cash_limit.finding.draft_proposed': 'Se dejó un borrador de reclasificación en la cola de revisión ({count}).',
  'cash_limit.finding.draft_failed': 'No se pudo proponer el borrador de reclasificación: {reason}.',

  'policy.time_zone.question':
    '¿En qué zona horaria cae el «hoy» de estos libros?',
  'policy.time_zone.impact':
    'Cada fecha que el sistema llena por su cuenta —una nota de crédito creada sin --date, por ejemplo— es el día de calendario en esta zona en ese momento. A las 20:00 en la Ciudad de México ya es el día siguiente en UTC; una fecha tomada de UTC deja el documento en el día siguiente y, el último día de un mes, en el periodo y la serie de folios siguientes.',
  'policy.time_zone.rationale':
    'La mayoría de los libros mexicanos llevan la hora del centro, que no tiene horario de verano desde 2022. Se acepta cualquier zona IANA; una que el entorno de ejecución no conoce se rechaza, porque una zona mal escrita caería si no en algún otro reloj sin decirlo.',
  'policy.time_zone.why':
    'El reloj del servidor corre en UTC. Si el día con el que se fecha un documento es el de la Ciudad de México, el de Tijuana o el de Cancún es un hecho de tus libros que no puedo adivinar.',
  'policy.time_zone.what':
    'Tomo el día de calendario en esta zona cada vez que no me dan una fecha.',
  'policy.time_zone.if_skipped':
    'Uso el día de la Ciudad de México.',
  'policy.time_zone.option.america_mexico_city':
    'Centro de México (UTC−6 todo el año)',
  'policy.time_zone.option.america_tijuana':
    'Baja California (sigue el horario de verano de EE. UU.)',
  'policy.time_zone.option.america_cancun':
    'Quintana Roo (UTC−5 todo el año)',
  'policy.time_zone.option.america_hermosillo':
    'Sonora (UTC−7 todo el año)',
  // ==== end of policy.* ===============================================
  // ==== pending.* and policy_preview.* — the `pending` screen by key (I10 · #152, MNE-001-091) ====
  'pending.board.empty':
    'Nada pendiente. Estás al corriente.',
  'pending.board.work':
    '{count, plural, one {# cosa por resolver} other {# cosas por resolver}}',
  'pending.board.warnings_only':
    'sólo avisos',
  'pending.board.draft':
    '{count, plural, one {# borrador espera} other {# borradores esperan}} tu aprobación',
  'pending.board.question':
    '{count, plural, one {# pregunta sin responder} other {# preguntas sin responder}} de la IA',
  'pending.board.outbox':
    '{count, plural, one {# escritura en cola} other {# escrituras en cola}} hacia {providers}',
  'pending.board.credential_expired':
    '{kind, select, efirma {tu e.firma YA VENCIÓ: renuévala} other {tu CSD YA VENCIÓ: renuévalo}} en el SAT',
  'pending.board.credential_expires':
    'tu {label} vence en {days, plural, one {# día} other {# días}}',
  'pending.board.period_close':
    '{count, plural, one {# periodo terminado sigue} other {# periodos terminados siguen}} sin cerrar',
  'pending.board.minimum_wage_zone':
    'la zona de salario mínimo no está declarada: {count, plural, one {# trabajador se calcula} other {# trabajadores se calculan}} con el mínimo general',
  'pending.board.period_example':
    '{period} (terminó el {date})',
  'pending.policies.none':
    'No hay definiciones pendientes.',
  'pending.policies.operating_with':
    ' — operando con: {value}',
  'pending.policies.no_default':
    ' — sin valor por omisión',
  'pending.policies.heading':
    'Por definir ({count})',
  'pending.policies.heading_note':
    ' — mientras tanto se opera con los valores por omisión',
  'pending.policies.define_hint':
    '→  mnemosine pending define <clave> <valor>',
  'pending.policies.label.impact':
    'impacto',
  'pending.policies.label.why':
    'por qué lo pregunto',
  'pending.policies.label.what':
    'qué hago con tu respuesta',
  'pending.policies.label.if_skipped':
    'si lo omites',
  'pending.policies.label.in_your_data':
    'en tus datos:',
  'pending.policies.label.why_default':
    'por qué ese valor por omisión',
  'pending.policies.already_defined':
    'Ya definidas',
  'pending.policies.dismissed_value':
    '(descartada)',
  'pending.define.not_found':
    'No hay una decisión pendiente con la clave "{key}". Consulta las abiertas con: mnemosine pending',
  'pending.define.input_hint':
    '(número, valor libre, o vacío para cancelar)',
  'pending.define.cancelled':
    'Cancelado; sigue pendiente.',
  'pending.define.ambiguous':
    '"{typed}" es a la vez la opción {typed} ({byPosition}) y el valor {byValue}. Escribe p para la opción {typed}, v para el valor {byValue}, o déjalo vacío para cancelar.',
  'pending.define.done':
    '✔ {key} = {value}',
  'pending.define.remaining':
    '{count, plural, one {# definición sigue pendiente} other {# definiciones siguen pendientes}}.',
  'pending.dismiss.done':
    '✘ {key} descartada.',
  'pending.reopen.done':
    '↻ {key} vuelve a estar pendiente.',
  'policy_preview.threshold.intro':
    'De {count, plural, one {tu # factura recibida} other {tus # facturas recibidas}}:',
  'policy_preview.threshold.line':
    '  · con {threshold} → te preguntaría {asked, plural, one {# vez} other {# veces}} ({pct})',
  'policy_preview.auto_post.intro':
    'De {total, plural, one {el # borrador} other {los # borradores}} que he propuesto hasta ahora:',
  'policy_preview.auto_post.counts':
    '  · aprobaste {approved} y rechazaste {rejected}',
  'policy_preview.auto_post.rejected':
    '  · una tasa de rechazo mayor que cero es motivo para mantenerlo apagado hasta que se asiente',
  'policy_preview.auto_post.track_record':
    '  · aún sin rechazos: un historial que respalda encenderlo',
  'policy_preview.auto_post.too_few':
    '  · todavía son muy pocos para saber cuántas veces acertaría',
  'policy_preview.auto_post.shadow_some':
    '  · sombra: {verdicts, plural, one {# veredicto} other {# veredictos}} en {days, plural, one {# día} other {# días}}, {decided, plural, one {# decidido} other {# decididos}} por una persona, acuerdo {agreement} (encender "on" exige al menos {minDays} días, {minDecided} decididos y {minAgreement} de acuerdo)',
  'policy_preview.auto_post.shadow_none':
    '  · aún sin historial de sombra: responde "shadow" primero; "on" exige esa evidencia',
  'policy_preview.amounts.intro':
    'Tus facturas recibidas, por importe:',
  'policy_preview.amounts.half':
    '  · la mitad está por debajo de {amount}',
  'policy_preview.amounts.nine_of_ten':
    '  · 9 de cada 10 están por debajo de {amount}',
  'policy_preview.amounts.largest':
    '  · la mayor fue de {amount}',
  'policy_preview.amounts.cap':
    '  · un tope de {cap} cubriría el {pct} de ellas',
  'policy_preview.inventory.some':
    'Veo {count, plural, one {# movimiento contabilizado} other {# movimientos contabilizados}} en cuentas de inventario: parece que los llevas.',
  'policy_preview.inventory.none':
    'Aún no veo movimientos en cuentas de inventario.',
  'policy_preview.restaurants.none':
    'Aún no hay facturas de restaurantes en tu historial.',
  'policy_preview.restaurants.intro':
    '{count, plural, one {# factura de restaurante} other {# facturas de restaurantes}} por {total}:',
  'policy_preview.restaurants.deductible':
    '  · deducible ({rate}): {amount}',
  'policy_preview.restaurants.non_deductible':
    '  · no deducible: {amount}',
  'policy_preview.efirma.none':
    'Aún no hay accesos a la e.firma registrados.',
  'policy_preview.efirma.summary':
    '{count, plural, one {# acceso cuenta} other {# accesos cuentan}} para el tope en {days, plural, one {# día} other {# días}} (~{perDay} por día).',
  'policy_preview.closed_period.some':
    '{count, plural, one {# factura de tu historial cae} other {# facturas de tu historial caen}} en periodos ya cerrados.',
  'policy_preview.closed_period.none':
    'Hasta ahora no hay facturas de periodos cerrados.',
  // ==== end of pending.* and policy_preview.* ====================================

  // --- El kernel: confirmación y salida --------------------------------
  confirm_answer_not_understood:
    'no entendí «{answer}»: responde y/s para sí, n para no',

  confirm_yes_no_suffix: '[s/N]',
  confirm_yes_no_suffix_default_yes: '[S/n]',

  no_changes_ledger_untouched: 'Sin cambios: el mayor no se tocó.',

  no_changes_no_terminal:
    'Sin cambios: no hay terminal donde confirmar. Añade -y para que `{command}` corra ' +
    'sin preguntar, o --dry-run para ver el efecto completo sin escribir nada.',

  // --- Los ensayos, que dicen qué se deshizo ---------------------------
  dry_run_rolled_back: 'Ensayo: se escribió de verdad y se deshizo.',

  dry_run_no_asset_created: 'Ensayo: la transacción se deshizo. No se creó ningún activo.',

  dry_run_ledger_untouched: 'Ensayo: el mayor no se tocó y no se escribió ningún renglón.',

  // --- Los tres `(s)` que el plural propio viene a jubilar -------------
  cfdi_cancelled_by_issuer:
    '{count, plural, one {# CFDI cancelado} other {# CFDI cancelados}} por el emisor: ' +
    'revisa su efecto contable con cfdi list --json',

  diot_checks_passed:
    'sin hallazgos: la DIOT pasa ' +
    '{count, plural, one {la # verificación pedida} other {las # verificaciones pedidas}}.',

  diot_findings_summary:
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}}, ' +
    '{warnings, plural, one {# aviso} other {# avisos}}. ' +
    'Un bloqueante impide capturar la declaración.',

  // --- El único `select` de la siembra ---------------------------------
  prepaid_row_skipped:
    '{reason, select, ' +
    'coverage_not_started {la cobertura todavía no empieza} ' +
    'coverage_ended {la cobertura ya terminó} ' +
    'zero_month_row {el renglón del mes es cero} ' +
    'no_balance_left {no queda saldo por devengar} ' +
    'other {no hay nada que devengar este mes}}',

  // --- Prosa de listado ------------------------------------------------
  prepaid_no_live_schedule: 'No hay ningún calendario vivo en esta entidad.',

  prepaid_no_schedule_covers_date: 'Ningún calendario cubre el {date}. Con -a se listan todos.',

  bank_run_hit_cap:
    'La corrida llegó a su tope: quedan movimientos sin evaluar. Vuelve a correrla.',
  // ====================================================================
  // I7 · EL CROMO DEL CLI, EL KERNEL Y LAS HOJAS DE `mnemosine.ts`
  //
  // EL ESPAÑOL DE UN TÍTULO DE COMMANDER NO ES UNA TRADUCCIÓN LIBRE. `Uso:`,
  // `Opciones:` y `Comandos:` son las palabras con las que un contador mexicano
  // ya lee cualquier binario traducido; inventar sinónimos aquí obligaría a
  // aprender dos vocabularios para la misma pantalla.
  //
  // LO QUE NO SE TRADUCE, y está decidido: los NOMBRES de las banderas
  // (`--dry-run`, `--entity`) y de los comandos. La R8 del catálogo dice que
  // el nombre canónico sigue en inglés con alias español; lo que se traduce es
  // el TEXTO que los explica. Por eso `--dry-run` aparece igual en las dos
  // columnas y `compute and show the full effect` no.
  // ====================================================================

  // --- El cromo que Commander maqueta solo -----------------------------
  'cli.chrome.usage': 'Uso:',
  'cli.chrome.arguments': 'Argumentos:',
  'cli.chrome.options': 'Opciones:',
  'cli.chrome.global_options': 'Opciones globales:',
  'cli.chrome.commands': 'Comandos:',
  'cli.chrome.help_description': 'muestra la ayuda del comando',
  'cli.chrome.version_description': 'imprime el número de versión',

  // --- Los errores que Commander escribe por `outputError` -------------
  'cli.error.unknown_command': 'error: no existe el comando «{name}»',
  'cli.error.unknown_option': 'error: no existe la opción «{flag}»',
  'cli.error.missing_argument': 'error: falta el argumento obligatorio «{name}»',
  'cli.error.option_missing_argument': 'error: a la opción «{flags}» le falta su valor',
  'cli.error.missing_mandatory_option': 'error: falta la opción obligatoria «{flags}»',
  'cli.error.did_you_mean': '(¿Querías decir {suggestion}?)',
  'cli.error.did_you_mean_one_of': '(¿Querías decir alguno de {suggestions}?)',

  // --- El diccionario de banderas (`src/cli/kernel/flags.ts`) ----------
  'cli.flag.entity': 'entidad legal sobre la que operar (por omisión, la activa)',
  'cli.flag.tenant_scope': 'inquilino (despacho) al que se acota lo que se lee y se escribe',
  'cli.flag.user': 'usuario que actúa, para la atribución y los permisos',
  'cli.flag.format': 'formato de salida',
  'cli.flag.json': 'atajo de --format json',
  'cli.flag.output': 'escribe en un archivo en vez de en la salida estándar',
  'cli.flag.fields':
    'columnas separadas por comas; sin valor, lista las disponibles',
  'cli.flag.quiet': 'sólo identificadores, uno por renglón, para encadenar por tubería',
  'cli.flag.limit': 'máximo de renglones a devolver',
  'cli.flag.offset': 'salta estos renglones',
  'cli.flag.status': 'filtra por estado del ciclo de vida (se puede repetir)',
  'cli.flag.all': 'sin límite por omisión; incluye lo archivado y lo cerrado',
  'cli.flag.period':
    'selector de periodo: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06',
  'cli.flag.since': 'límite inferior inclusivo (AAAA-MM-DD)',
  'cli.flag.until': 'límite superior inclusivo (AAAA-MM-DD)',
  'cli.flag.as_of': 'fecha de valuación o de saldo (AAAA-MM-DD)',
  'cli.flag.date_basis': 'a qué fecha se aplican los filtros',
  'cli.flag.strict': 'trata los avisos como bloqueantes (salida 4)',
  'cli.flag.force':
    'pasa por encima de una validación bloqueante (periodo cerrado, fecha de bloqueo, ' +
    'duplicado); exige --reason',
  'cli.flag.note': 'anotación libre que se guarda con el registro',

  'cli.flag.error_not_whole_number':
    '{name} tiene que ser un entero no negativo; llegó "{value}".',
  'cli.flag.error_not_port': '{name} tiene que ser un puerto entre 0 y 65535; llegó "{value}".',
  'cli.flag.error_not_origin':
    '{name} tiene que ser sólo un origen —esquema, anfitrión y puerto, sin ruta—; llegó "{value}".',
  'cli.flag.error_empty': '{name} no puede ir vacía.',
  'cli.flag.error_not_date': '{name} tiene que ser una fecha AAAA-MM-DD; llegó "{value}".',

  // --- Las banderas que inyecta la declaración de riesgo (risk.ts) -----
  'cli.flag.dry_run':
    'calcula y muestra el efecto completo; no escribe nada ni llama a nada externo',
  'cli.flag.yes': 'omite la confirmación',
  'cli.flag.idempotency_key':
    'llave de deduplicación del cliente, guardada al tener éxito: un reintento con la misma ' +
    'llave y la misma carga devuelve el resultado registrado',
  'cli.flag.idempotency_key_unhonored':
    'este comando TODAVÍA NO la honra: un reintento vuelve a escribir en vez de devolver el ' +
    'resultado registrado',
  'cli.flag.idempotency_key_unneeded':
    'no hace falta: este comando ya deduplica por el estado que escribe; se acepta y se ignora',
  'cli.flag.live': 'realiza el efecto externo de verdad (por omisión se usa el entorno de pruebas)',
  'cli.flag.reason': 'justificación que queda en el rastro de auditoría (obligatoria)',

  // --- La compuerta de mutación (`src/cli/kernel/risk.ts`) -------------
  'cli.risk.key_not_honored':
    '«{command}» acepta --idempotency-key porque su clase de riesgo la exige, pero TODAVÍA NO ' +
    'LA HONRA: {reason}. La llave «{key}» no deduplicaría nada: un reintento volvería a ' +
    'escribir. Vuelve a ejecutar SIN la llave y comprueba antes el estado del dominio que este ' +
    'comando toca (el documento, el saldo o el asiento), o repite con --dry-run para ver qué haría.',
  'cli.risk.undeclared':
    '«{command}» pide una compuerta de mutación sin haber declarado su riesgo. Toda hoja que ' +
    'muta declara con `declareRisk` junto a su registro; sin declaración no hay confirmación, ' +
    'ni marcha seca, ni rastro de auditoría que decir.',
  'cli.risk.force_needs_reason':
    '--force pasa por encima de una regla de seguridad, así que exige --reason "<por qué>". ' +
    'El motivo queda escrito en el rastro de auditoría.',
  'cli.risk.undo_needs_reason':
    '«{command}» deshace o revoca algo, así que exige --reason "<por qué>".',
  'cli.risk.gate_flags_not_honored':
    '"{command}" acepta {flags} pero su manejador todavía no las honra: ejecutaría de verdad ' +
    'mientras la bandera promete lo contrario. Se rechaza en vez de fingir. (La bandera existe ' +
    'porque la clase de riesgo la exige; el cableado del manejador es trabajo de CLI-F2.)',

  // --- La entidad activa (`src/cli/kernel/entity-context.ts`) ----------
  'cli.entity.database_unreachable':
    'No se pudo llegar a la base al resolver la entidad activa ({entity}): {detail}',
  'cli.entity.database_unreachable_remedy':
    'mnemosine doctor   (y revisa DATABASE_URL en .env)',
  'cli.entity.pinned_unresolved': 'La entidad fijada ({entity}) no se pudo resolver: {detail}',
  'cli.entity.pinned_unresolved_remedy':
    'mnemosine entity use <id|nombre>   (o `mnemosine entity unset` para soltarla)',
  'cli.entity.pin_was_kept': 'La entidad fijada se conservó.',
  'cli.entity.must_be_named':
    'Este comando cambia datos, así que no va a adivinar la entidad. Nómbrala con ' +
    '--entity <id|nombre> o fija una con `mnemosine entity use`.',

  // --- El renderizador (`src/cli/kernel/output.ts`) --------------------
  'cli.output.unknown_format': 'No existe el --format "{value}". Usa uno de: {formats}.',
  'cli.output.unknown_fields': 'Campos que no existen: {unknown}. Disponibles: {available}.',

  // --- La salida (`src/cli/kernel/exit.ts`) ----------------------------
  'cli.exit.aborted': 'Cancelado.',

  // --- La raíz y sus dos banderas globales -----------------------------
  'help.root.description':
    'Asistente contable con IA — conversa con tu contabilidad desde la terminal',
  'cli.flag.tenant_root':
    'Inquilino sobre el que operar. Precedencia: esta bandera > MNEMOSINE_TENANT > ' +
    'mnemosine.config.json. Acota TODA consulta por RLS',
  'cli.flag.locale':
    'Idioma y convenciones de lo que se IMPRIME ({locales}). Precedencia: esta bandera > ' +
    '{envVar} ({envAlias} es su alias permanente) > ~/.mnemosine/config.json > ' +
    './mnemosine.config.json > lo que diga el inquilino > {fallback}. No cambia nada de lo que ' +
    'se entrega a una autoridad',

  // --- Las hojas que `src/cli/mnemosine.ts` registra por su cuenta ------
  'help.entities.description':
    'Lista las entidades legales activas (en desuso: usa `mnemosine entity list`)',
  'help.providers.description':
    'Lista los proveedores de modelos configurados (los de fábrica + mnemosine.config.json)',
  'help.ask.description': 'Hace una sola pregunta y sale',
  'help.chat.description': 'Abre una sesión de conversación (es el comando por omisión)',
  'help.sessions.description':
    'Lista las sesiones de conversación recientes (retoma una con: mnemosine chat --resume <id>)',
  'help.drafts.description': 'Lista los borradores de póliza que creó la IA',
  'help.review.description':
    'Revisa los borradores pendientes: aprobar (crea la póliza y la contabiliza), corregir y ' +
    'aprobar, o rechazar — un rechazo puede sembrar el criterio para la próxima vez',
  'review.draft.bill_to_be_born':
    'Aprobar crea la factura del proveedor del CFDI {uuid} · emisor {issuer} ({rfc}) · método {method} · total {total}',
  'review.draft.invoice_to_be_born':
    'Aprobar crea la factura al cliente del CFDI emitido {uuid} · cliente {customer} ({rfc}) · método {method} · total {total}',
  'review.vendor.register_prompt': '¿Dar de alta al proveedor {name} (RFC {rfc})?',
  'review.vendor.not_registered':
    'No se dio de alta al proveedor: no se contabilizó nada y el borrador sigue pendiente.',
  'help.ingest.argument.files':
    'Rutas a los XML de CFDI; con --kind zip o metadata, los ZIP o archivos de metadatos descargados del SAT',
  'help.ingest.option.kind':
    'Qué son los archivos: xml (CFDI uno por uno), zip (paquete del SAT con XML: carga el censo e ingiere ' +
    'cada XML) o metadata (archivo de metadatos del SAT separado por `~`, suelto o en ZIP: sólo carga el censo)',
  // MNE-001-143 (#440): `src/cli/sat-download-commands.ts`, la descarga masiva de CFDI del SAT.
  'help.sat.download.option.entity': 'Entidad legal',
  'help.sat.download.option.user': 'Quién actúa (por omisión: el único usuario activo)',
  'help.sat.download.option.json': 'Salida legible por máquina',
  'help.sat.download.option.format': 'Formato de salida: table o json',
  'help.sat.download.argument.id': 'Solicitud de descarga: su id local o el id que le dio el SAT',
  'help.sat.download.create.description':
    'Pide al SAT los CFDI de un periodo (se niega antes de llamar si el tope de por vida de XML está agotado)',
  'help.sat.download.create.option.since': 'Primer día, AAAA-MM-DD',
  'help.sat.download.create.option.until': 'Último día, AAAA-MM-DD',
  'help.sat.download.create.option.direction': 'issued (emitidos) o received (recibidos)',
  'help.sat.download.create.option.kind':
    'metadata o xml (xml gasta una de las 2 solicitudes de por vida del periodo)',
  'help.sat.download.check.description':
    'Pregunta al SAT el estado de una solicitud y lo guarda junto con los ids de sus paquetes (el 5004 es éxito con cero filas)',
  'help.sat.download.check.option.wait': 'Seguir preguntando hasta que la solicitud deje de estar abierta',
  'help.sat.download.check.option.timeout': 'Dejar de esperar tras estos segundos',
  'help.sat.download.check.option.strict': 'Salir con error salvo que la solicitud haya terminado con paquetes',
  'help.sat.download.status.description':
    'Último estado conocido de una solicitud, leído del espejo local (no llama al SAT)',
  'help.sat.download.list.description': 'Las solicitudes de descarga de la entidad con su estado, número de CFDI y paquetes',
  'help.sat.download.list.option.status': 'Sólo este estado',
  'help.sat.download.list.option.since': 'Sólo solicitudes cuyo periodo termina en este día o después, AAAA-MM-DD',
  'help.sat.download.list.option.limit': 'Cuántas mostrar',
  'help.sat.package.description': 'Paquetes de una solicitud de descarga terminada',
  'help.sat.package.download.description':
    'Baja los paquetes de una solicitud terminada, archiva cada ZIP por bytes y con --import los carga',
  'help.sat.package.download.option.output': 'Escribe además cada ZIP en este directorio',
  'help.sat.package.download.option.package': 'Sólo este paquete de la solicitud',
  'help.sat.package.download.option.import':
    'Carga el censo y pasa los XML por la ingesta de siempre (import_source sat_download)',
  'help.sat.quota.description': 'El tope de por vida del SAT para solicitudes de XML idénticas',
  'help.sat.quota.show.description':
    'Qué periodos tienen agotadas sus 2 solicitudes de XML de por vida y a cuáles les quedan (lee el contador local)',
  'help.sat.quota.show.option.since': 'Periodos que terminan en este día o después, AAAA-MM-DD',
  'help.sat.quota.show.option.until': 'Periodos que empiezan en este día o antes, AAAA-MM-DD',
  // MNE-001-143 (#440): the runtime messages of `src/cli/sat-download-commands.ts`, by key.
  'sat.dl.bad_day':
    '{flag} debe ser un día, AAAA-MM-DD (se recibió "{value}")',
  'sat.dl.bad_format':
    '--format debe ser table o json (se recibió "{value}")',
  'sat.dl.bad_positive':
    '{flag} debe ser un entero mayor que 0 (se recibió "{value}")',
  'sat.dl.bad_direction':
    '--direction debe ser issued o received (se recibió "{value}")',
  'sat.dl.bad_kind':
    '--kind debe ser metadata o xml (se recibió "{value}")',
  'sat.dl.since_after_until':
    '--since debe ser anterior a --until',
  'sat.dl.request_not_found':
    'La solicitud de descarga {id} no existe para esta entidad',
  'sat.dl.describe':
    '{id} · {direction} {kind} del {from} al {to} · {status}{count}{packages}{error}',
  'sat.dl.describe.count':
    ' · {n} comprobante(s)',
  'sat.dl.describe.packages':
    ' · {archived}/{total} paquete(s) archivado(s)',
  'sat.dl.create.plan':
    '{direction} {kind} {start}..{end} para {entity} ({rfc})',
  'sat.dl.create.plan_left':
    ' · solicitudes XML de por vida que quedan para este periodo según el contador propio de esta entidad: {n} (el SAT cuenta por RFC y parámetros: otra entidad u otro despacho pudo gastarlas)',
  'sat.dl.create.would':
    'Se pediría al SAT {plan}',
  'sat.dl.create.not_sent':
    'No se envió: {plan}',
  'sat.dl.create.spent':
    'El tope de por vida de este periodo está agotado: una corrida real se niega antes de llamar al SAT.',
  'sat.dl.create.dry_note':
    '(simulacro: no se escribió nada y no se llamó al SAT)',
  'sat.dl.create.live_note':
    'Pedir al SAT usa la e.firma y es opt-in: vuelve a correr con --live.',
  'sat.dl.create.confirm':
    'Esto gasta una de las {limit} solicitudes XML de por vida del periodo ({plan}). Escribe "yes": ',
  'sat.dl.create.cancelled':
    'Cancelado. No se pidió nada.',
  'sat.dl.create.done':
    '{repeat}{mark} solicitud {id} · {status}{error}',
  'sat.dl.create.repeat':
    'Ya se pidió con esta llave: ',
  'sat.dl.create.follow':
    'Síguela con: mnemosine sat download check {id} --live',
  'sat.dl.check.would':
    'Se preguntaría al SAT por {request}',
  'sat.dl.check.not_asked':
    'No se preguntó al SAT por {request}',
  'sat.dl.check.dry_note':
    '(simulacro: no se llamó al SAT)',
  'sat.dl.check.live_note':
    'Preguntar al SAT usa la e.firma: vuelve a correr con --live.',
  'sat.dl.check.rate_limit':
    'Se detuvo tras {polls} consulta(s): se alcanzó el tope diario de accesos a la e.firma (quedan 0 en esta ventana de 24 h). Cada consulta usa uno y bajar los paquetes también necesita: espera a que se libere la ventana y corre check --live otra vez (los paquetes caducan 72 h después de estar listos).',
  'sat.dl.check.budget':
    'Se detuvo tras {polls} consulta(s) para reservar accesos de la e.firma para bajar los paquetes. Vuelve a correr check --live más tarde.',
  'sat.dl.check.timeout':
    'Se dejó de esperar tras {polls} consulta(s); la solicitud sigue abierta. Vuelve a correr check --live más tarde.',
  'sat.dl.list.empty':
    'No hay solicitudes de descarga.',
  'sat.dl.quota.empty':
    'No hay solicitudes XML contadas. Las de metadata no tienen tope.',
  'sat.dl.quota.spent':
    '✘ agotado (irrecuperable)',
  'sat.dl.quota.left':
    '· quedan {n}',
  'sat.dl.quota.line':
    '{state} · {direction} {from}..{to} · {made}/{limit} usadas',
  'sat.dl.package.no_data':
    'El SAT respondió que esta solicitud no tiene datos: no hay nada que bajar.',
  'sat.dl.package.rejected':
    'El SAT rechazó esta solicitud: no hay paquetes. Corrige los parámetros y pide de nuevo.',
  'sat.dl.package.expired':
    'Esta solicitud caducó en el SAT (los paquetes duran 72 h): pídela de nuevo.',
  'sat.dl.package.open':
    'La solicitud {id} está {status}: aún no tiene paquetes. Corre: mnemosine sat download check {id} --live',
  'sat.dl.package.failed':
    'La solicitud {id} está {status}: no tiene paquetes; revisa su estado con `sat download status`.',
  'sat.dl.package.no_such':
    'La solicitud {id} no tiene el paquete {package}',
  'sat.dl.package.would':
    '{lead} {missing} de {total} paquete(s); {kept} ya archivado(s){import}.',
  'sat.dl.package.would_lead':
    'Se bajarían',
  'sat.dl.package.not_lead':
    'No se bajaron:',
  'sat.dl.package.then_import':
    '; luego se cargarían con la ingesta',
  'sat.dl.package.dry_note':
    '(simulacro: no se llamó al SAT y no se escribió nada)',
  'sat.dl.package.live_note':
    'Bajar usa la e.firma y es opt-in: vuelve a correr con --live. Los paquetes caducan en el SAT 72 h después de estar listos.',
  'sat.dl.package.archived':
    '✔ {id} · {bytes} bytes · huella sha256 {sha} · {where}',
  'sat.dl.package.where_archive':
    'ya estaba archivado',
  'sat.dl.package.where_new':
    'archivado',
  'sat.dl.package.output_written':
    '  se escribió {file}',
  'sat.dl.package.output_same':
    '  {file} ya tiene estos bytes',
  'sat.dl.package.output_differs':
    '{file} ya existe con otros bytes: no se sobrescribió',
  'sat.dl.ingest.line':
    '  ingesta: {counts}',
  'sat.dl.ingest.nothing':
    'nada',
  'sat.dl.ingest.to_code':
    '{n} quedaron en la bandeja para codificar (sin proveedor de modelo, o requieren una decisión)',
  // MNE-001-096 (#312): `src/cli/ingest-census.ts`, el censo del SAT que carga `ingest --kind zip|metadata`.
  'ingest.census.bad_kind': 'se esperaba uno de {valid}',
  'ingest.census.flag_not_for_metadata':
    '{flags}: no aplica a --kind metadata, que sólo carga el censo y no ingiere nada',
  'ingest.census.no_rfc': 'La entidad no tiene RFC: el censo no puede distinguir emitidos de recibidos.',
  'ingest.census.not_zip': '{file} no es un archivo ZIP.',
  'ingest.census.bad_zip': '{file}: no se puede leer el ZIP ({detail}).',
  'ingest.census.not_metadata': '{file}: no es un archivo de metadatos del SAT (falta(n) la(s) columna(s) {columns}).',
  'ingest.census.invalid.field_count': '{found} campos, el encabezado tiene {expected}',
  'ingest.census.invalid.status': 'Estatus «{value}» no es ni 1 ni 0',
  'ingest.census.invalid.field': '{field} inválido',
  'ingest.census.invalid.xml': 'no es un CFDI legible ({detail})',
  'ingest.census.title': 'Censo del SAT ({kind})',
  'ingest.census.summary': '{total} CFDI ({issued} emitidos, {received} recibidos)',
  'ingest.census.by_month': 'por mes: {months}',
  'ingest.census.completeness':
    '{counted} cuentan para la completitud según {key} ({types}); {others} de otros tipos quedan en el censo',
  'ingest.census.counts': '{foreign} no son de esta entidad · {invalid} inválidos',
  'ingest.census.more_invalid': '… y {count} más',
  'ingest.census.loaded': 'Censo cargado de {file}: {inserted} nuevos, {refreshed} ya conocidos.',
  'ingest.census.dry_run': '(dry-run: el censo se leyó, no se cargó.)',
  // MNE-001-144 (#441): las cancelaciones del SAT en el censo llegan al espejo y a la factura;
  // MNE-001-431 (#643): y a la factura de proveedor.
  'ingest.census.marks':
    'Cancelados por el SAT: {mirror, plural, one {# CFDI marcado} other {# CFDI marcados}} en el espejo, ' +
    '{invoices, plural, one {# factura marcada como cancelada} other {# facturas marcadas como canceladas}}, ' +
    '{bills, plural, one {# factura de proveedor marcada} other {# facturas de proveedor marcadas}}.',
  'ingest.census.cancelled_booked':
    '{document} ({date}) lleva el CFDI {uuid}, que el SAT reporta cancelado. No se revirtió nada: ' +
    'su estado, su póliza y su saldo se quedan hasta que el contador decida.',
  'ingest.census.document.invoice': 'Factura {number}',
  'ingest.census.document.credit_note': 'Nota de crédito {number}',
  'ingest.census.document.bill': 'Factura de proveedor {number}',
  'help.ingest.description':
    'Ingesta por lote de CFDI (XML): reglas → clasificación por IA → borradores (o alta ' +
    'automática según los umbrales)',
  'help.lang.description':
    'Muestra o fija tu idioma: el del CLI y el de las respuestas del agente (los alias en español ' +
    'funcionan siempre)',
  'help.onboard.description':
    'Importa la contabilidad de un cliente desde un sistema externo (catálogo de cuentas + ' +
    'saldos iniciales)',
  'help.outbox.description':
    'Operaciones encoladas para sistemas contables externos: listar, revisar y ejecutar',
  'help.outbox.list.description': 'Lista las operaciones externas encoladas (por omisión, las pendientes)',
  'help.outbox.run.description':
    'Ejecuta las operaciones encoladas contra el sistema externo del cliente (el efecto real ' +
    'exige --live)',
  'help.question.description':
    'Las preguntas pendientes del agente: listar, responder (queda como precedente) o descartar',
  'help.question.list.description': 'Lista las preguntas del agente (por omisión, las pendientes)',
  'help.question.answer.description':
    'Responde una pregunta (la respuesta queda como precedente), o atiende la cola de pendientes',
  'help.login.description': 'Inicia sesión con tu proveedor de identidad (OIDC)',
  'help.logout.description': 'Borra la credencial guardada en esta máquina',
  'help.whoami.description': 'Muestra la credencial activa y hasta cuándo sirve',
  'help.subscription.description':
    'Suscripciones a eventos salientes: a quién avisamos y qué no se pudo entregar',

  // --- W0 · `src/cli/web-command.ts`, the web gateway's operator entry ---
  'help.web.description': 'El tablero en el navegador: un gateway de sólo lectura delante de la API',
  'help.web.start.description':
    'Arranca el gateway web, que guarda la sesión del navegador y reenvía lecturas a /v1; corre hasta ' +
    'Ctrl+C (en producción se usa node dist/gateway/main.js)',
  'help.web.start.port': 'Puerto en el que escucha (por omisión: GATEWAY_PORT, si no 8080)',
  'help.web.start.host': 'Dirección en la que escucha (por omisión: GATEWAY_HOST, si no 127.0.0.1)',
  'help.web.start.api_url': 'Origen de la API a la que reenvía (por omisión: GATEWAY_API_URL)',
  'help.web.start.public_origin':
    'Origen que abre el navegador, y bajo el que contesta el gateway (por omisión: GATEWAY_PUBLIC_ORIGIN)',
  'web.start.listening': 'Abre {origin} en el navegador. Ctrl+C detiene el gateway.',

  // ==== I7 · EL PILOTO: `src/cli/bank-command.ts` (issue #149) =====
  // --- Los analizadores de bandera: uso (2), no validación (4) ---------
  'receipt.withholding.unreadable':
    'No entiendo la retención "{spec}": escribe "isr:1000" o "iva:1066.67", y con varias facturas antepón el folio ("INV-2026-00042:isr:1000").',
  'receipt.withholding.which_invoice':
    'Con varias facturas, la retención "{spec}" tiene que decir de cuál es ("INV-2026-00042:{spec}").',
  'receipt.withholding.not_applied':
    'La retención "{spec}" nombra {invoice}, que no está entre las --invoice de esta aplicación.',
  'receipt.withholding.negative': 'Una retención no puede ser negativa ({amount}).',
  'receipt.withholding.cash_required':
    'El efectivo aplicado a {invoice} debe ser mayor que cero (llegó {amount}): una retención viaja con una aplicación de efectivo, nunca se aplica sola.',
  'receipt.withholding.exceeds_due':
    '{invoice} debe {due} y se intentan aplicar {settled} ({cash} cobrado + {withheld} retenido).',
  'receipt.withholding.vat_cap': '{invoice} traslada {cap} de IVA: el cliente no puede retener más que eso.',
  'receipt.withholding.isr_cap': '{invoice} tiene un subtotal de {cap}: el ISR retenido no puede pasar de ahí.',
  'receipt.withholding.booked_at_issuance':
    '{invoice} ya registró la retención del cliente ({amount}) al emitirse: su cuenta por cobrar es el neto que paga el cliente. Aplica sólo el efectivo; --withholding es para facturas cuya cuenta por cobrar se registró en bruto.',
  // MNE-001-572 (#789): el anticipo de un cheque retenido no se aplica contra IVA que nadie ha causado.
  'receipt.apply.cheque_advance_not_cashed':
    'El cobro {receipt} es un cheque que el banco no ha cobrado, y aplicarlo a {invoice} cancelaría {iva} del IVA de su anticipo, que no se causa hasta el cobro (LIVA art. 1-B, segundo párrafo). Registra primero el cobro con `mnemosine bank check reconcile --receipt {receipt}` y luego aplícalo; esto lo gobierna la clave del panel {key}. No se escribió nada.',
  'receipt.apply.cheque_advance_deferral_ppd_only':
    'La clave del panel {key} dice defer_to_cashing, que compensa el IVA del anticipo contra la parte que una factura PPD libera el día del cobro. {invoice} es una factura PUE de otro tratamiento que el cobro {receipt}: no libera ninguna parte, y aplicarla ya cancelaría {iva} de IVA que nadie ha causado (LIVA art. 1-B, segundo párrafo). Registra primero el cobro con `mnemosine bank check reconcile --receipt {receipt}` y luego aplícalo. No se escribió nada.',
  'receipt.unapply.iva_at_cashing':
    'Los {iva} de IVA que este efectivo lleva de vuelta a cuenta se causan el día en que el banco cobra el cheque (LIVA art. 1-B, segundo párrafo): registrar ese cobro con bank check reconcile --receipt los postea.',
  // MNE-001-574 (#792): desaplicar un cobro sin tratamiento deja causado el IVA de su cobro.
  'receipt.unapply.iva_kept': 'IVA que se queda causado {iva} (LIVA art. 1-B)',
  // MNE-001-585 (#792): con repark_same_month una aplicación liberada en un mes anterior deja su IVA causado.
  'receipt.unapply.iva_kept_later_month':
    'IVA que se queda causado {iva} (LIVA art. 1-B): {key} re-aparca sólo en el mes en que se liberó el IVA, y se liberó antes de {month}, en un mes que puede estar ya declarado',
  'receipt.apply.other_customer':
    '{invoice} es del cliente {invoiceCustomer} y el cobro {receipt} es del cliente {receiptCustomer}: el saldo a cuenta sólo salda facturas de su propio cliente. Registra el cobro a nombre de {invoiceCustomer}, o aplica {receipt} a una factura de {receiptCustomer}.',
  // MNE-001-460 (#623): una aplicación y una desaplicación llevan fecha.
  'receipt.apply.date_future':
    'El cobro {receipt} no se puede aplicar el {date}: es posterior a hoy ({today}) en la zona horaria de la entidad. No se aplicó nada.',
  'receipt.unapply.date_future':
    'El cobro {receipt} no se puede desaplicar el {date}: es posterior a hoy ({today}) en la zona horaria de la entidad. No se desaplicó nada.',
  'receipt.apply.date_before_last_event':
    'El último asiento del cobro {receipt} es del {since}: una aplicación fechada el {date} aplicaría su efectivo antes de que eso ocurriera. Féchala el {since} o después. No se aplicó nada.',
  'receipt.unapply.date_before_last_event':
    'El último asiento del cobro {receipt} es del {since}: una desaplicación fechada el {date} lo desharía antes de que ocurriera. Féchala el {since} o después. No se desaplicó nada.',
  'receipt.apply.date_before_invoice':
    '{invoice} es del {invoiceDate}: el efectivo aplicado el {date} la saldaría antes de que existiera la venta. Fecha la aplicación el {invoiceDate} o después. No se aplicó nada.',
  'credit_note.advance.exceeds_invoiced_advance':
    'La nota de crédito {note} aplica un anticipo de {requested}, y el cliente {customer} tiene {available} en facturas de anticipo sin aplicar. No se posteó nada. El saldo a cuenta se aplica con `receipt apply`; un anticipo registrado con una póliza se aplica con una póliza.',
  // MNE-001-489 (#692): why a received credit note waits for a person.
  'credit_note.received.refusal.not_received': 'El CFDI {note} es de {issuer} para {receiver}: la entidad no es su receptor. Sólo una nota de crédito que un proveedor le emitió a la entidad se contabiliza contra un gasto.',
  'credit_note.received.refusal.not_credit_note': 'El CFDI {note} es tipo {type} con TipoRelacion {relation}. Sólo un tipo E con TipoRelacion 01 (nota de crédito) o 03 (devolución) se contabiliza contra un gasto.',
  'credit_note.received.refusal.note_foreign_currency': 'La nota de crédito {note} está en {currency}. Una nota de crédito recibida se contabiliza sólo cuando ella y su gasto están en la moneda de la entidad; ésta espera a una persona.',
  'credit_note.received.refusal.other_taxes': 'La nota de crédito {note} trae un impuesto distinto del IVA trasladado (IEPS, un impuesto local o una retención). Espera a una persona.',
  'credit_note.received.refusal.related_bills': 'La nota de crédito {note} tiene que nombrar exactamente un gasto de esta entidad entre sus CFDI relacionados, y nombra {count}.',
  'credit_note.received.refusal.bill_foreign_currency': 'El gasto {bill} está en {currency}. La nota de crédito {note} se contabiliza sólo cuando ella y su gasto están en la moneda de la entidad; espera a una persona.',
  'credit_note.received.refusal.other_vendor': 'La nota de crédito {note} la emitió {issuer}, y el gasto {bill} es del proveedor {vendor}. Una nota de crédito sólo baja un gasto de su propio emisor.',
  'credit_note.received.refusal.bill_not_payable': 'El gasto {bill} está en "{status}". La nota de crédito {note} se contabiliza sólo contra un gasto en {payable}.',
  'credit_note.received.refusal.release_not_recorded': 'Un pago aplicado al gasto {bill} no guardó el IVA que liberó, así que no se puede saber cuánto IVA pendiente le queda al gasto. La nota de crédito {note} espera a una persona.',
  'credit_note.received.refusal.exceeds_balance': 'La nota de crédito {note} es por {total} y el gasto {bill} debe {due}. Una nota de crédito mayor que el saldo de su gasto no se contabiliza.',
  'credit_note.received.refusal.vat_out_of_proportion': 'La nota de crédito {note} trae {vat} de IVA, y en la proporción del gasto {bill} traería {expected}. Un gasto con más de una tasa de IVA no dice qué parte baja la nota; espera a una persona.',
  'credit_note.received.refusal.capitalised_line': 'El gasto {bill} tiene un renglón en una cuenta con el rol {role}. La nota de crédito {note} bajaría un activo y no un gasto; espera a una persona.',
  'credit_note.received.closed_period': 'La nota de crédito {note} tiene fecha {date}, en un periodo que está cerrado. Espera a que se conteste la política del periodo cerrado: mnemosine pending define cfdi_periodo_cerrado periodo_actual',
  'payment.apply.other_vendor':
    '{bill} es del proveedor {billVendor} y el pago {payment} es del proveedor {paymentVendor}: el saldo a cuenta sólo salda gastos de su propio proveedor. Registra el pago a nombre de {billVendor}, o aplica {payment} a un gasto de {paymentVendor}.',
  // MNE-001-458 (#623): a customer advance recorded with its IVA treatment.
  'receipt.advance.treatment_unknown':
    'No conozco el tratamiento de IVA "{value}" para un anticipo: declara uno de {allowed}.',
  // MNE-001-462 (#623): the excess of a collection left on account is an advance.
  'receipt.advance.tax_rate_needs_on_account':
    'Con una factura, --tax-rate declara el tratamiento del excedente que un cobro deja a cuenta, así que va con --on-account. Sin él el efectivo sólo liquida la factura. No se registró nada.',
  'receipt.advance.nothing_on_account':
    'Se declaró un tratamiento para el efectivo que este cobro de {amount} deja a cuenta, y no deja nada: lo aplica todo a facturas. Quita --tax-rate, o registra el importe que excede lo que deben. No se registró nada.',
  'receipt.excess.from': 'tasa de {invoices}',
  'receipt.excess.from_highest': 'tasa de {invoices}: lleva varias y se supone la más alta; --tax-rate declara otra',
  'receipt.excess.from_exempt': 'tasa de {invoices}: ninguno de sus tratamientos lleva IVA y se supone exento; --tax-rate declara otro',
  'receipt.advance.not_mexican_books':
    'Esta entidad no lleva libros mexicanos, así que un anticipo no lleva tratamiento de IVA: regístralo sin él y el importe completo va a su cuenta de anticipos de clientes.',
  'receipt.advance.cheque_held':
    'Recibido con cheque, su IVA de {iva} se causa el día en que el banco lo cobra (LIVA art. 1-B, segundo párrafo): hasta entonces el importe completo espera en anticipos de clientes, y registrar el cobro con bank check reconcile --receipt pasa el IVA al IVA trasladado ese día.',
  // MNE-001-421 (#623): the advance from the terminal.
  'receipt.advance.needs_customer':
    'Indica la factura que este dinero liquida, o el cliente que lo pagó con --customer: sin factura se registra como anticipo.',
  'receipt.advance.rate_required':
    'Un anticipo sin factura causa su IVA al cobrarse (LIVA art. 1-B), y la tasa de una venta que aún no ocurre es un dato que tú declaras, nunca un valor por omisión: agrega --tax-rate 16, 8, 0, exempt o not-subject. No se registró nada.',
  'receipt.advance.figures': 'base {base}, IVA {iva}, tasa {rate}',
  'receipt.advance.label': 'Anticipo',
  'receipt.cheque.cashed_label': 'Cheque cobrado',
  'receipt.cheque.cashed': '{date} · movimiento bancario {transaction}',
  'receipt.cheque.not_cashed': 'sin registrar todavía (`bank check reconcile --receipt`)',
  'receipt.advance.confirm':
    '¿Registrar {amount} recibidos de {customer} como anticipo sin factura{figures} en {entity}? Esto postea en el mayor.',
  // MNE-001-509 (#701): a reversed receipt says what happened to the money.
  'receipt.reverse.cause_unknown':
    'La causa «{value}» de una reversa no se conoce: declara not_collected (el dinero nunca fue tuyo) o taken_back (llegó y te lo quitaron). No se escribió nada.',
  'receipt.reverse.warning.card_not_collected':
    'Este cobro se pagó con tarjeta, y una tarjeta se paga cuando se acepta (LIVA art. 1-B): not_collected dice que el dinero nunca fue tuyo. Si llegó y el banco te lo quitó, como en un contracargo, la causa es taken_back.',
  'receipt.reverse.warning.cause_not_stated':
    'No se declaró causa, y sólo un cheque tiene una por omisión: el IVA de este cobro se queda en el mes en que se cobró hasta que se declare una causa (not_collected o taken_back) con `cobro causa registrar`.',
  'receipt.reverse.cause.stated': 'causa {cause}',
  'receipt.reverse.cause.defaulted':
    'causa not_collected, tomada por omisión: un cheque se paga el día que el banco lo cobra',
  'receipt.reverse.cause.none': 'sin causa declarada',
  // MNE-001-511 (#701): the cause of a receipt reversed with none, stated afterwards.
  'receipt.cause.not_reversed':
    'El cobro {number} está en «{status}»: la causa sólo se declara para un cobro reversado. No se escribió nada.',
  'receipt.cause.balance_transfer':
    'El cobro {number} es un traspaso de crédito de un cliente: no movió dinero, así que su reversa no tiene causa que declarar. No se escribió nada.',
  'receipt.cause.none_for_transfer': 'ninguna: un traspaso de crédito de un cliente no movió dinero',
  'receipt.cause.already_stated':
    'El cobro {number} ya tiene su causa, {cause}, declarada el {stated_at}: una causa declarada no se sobrescribe. No se escribió nada.',
  'receipt.cause.reason_required':
    'Declarar la causa de una reversa exige --reason "<por qué>": queda escrito en el rastro de auditoría.',
  'receipt.cause.would_state': 'Declararía la causa {cause} para la reversa de {number}',
  'receipt.cause.confirm':
    '¿Declarar {cause} como la causa de la reversa de {number}? Se escribe una sola vez y no se puede corregir; no postea nada en el mayor.',
  'receipt.cause.stated': '{number}: causa {cause}, declarada el {stated_at}; no se posteó nada',
  // MNE-001-605 (#809): the live allocation a reversed receipt still has, closed by a person.
  'receipt.allocation.close.not_reversed':
    'El cobro {number} está en «{status}»: así sólo se cierra la aplicación viva de un cobro reversado, porque sólo la reversa ya reabrió su factura. No se escribió nada.',
  'receipt.allocation.close.nothing_live':
    'El cobro {number} no tiene ninguna aplicación viva sobre {invoice}: no hay qué cerrar. No se escribió nada.',
  'receipt.allocation.close.after_reversal':
    'La aplicación viva de {number} sobre {invoice} se escribió después de reversar el cobro, así que la reversa nunca reabrió la factura por ella: cerrarla sola dejaría la factura corta. Repórtala. No se escribió nada.',
  'receipt.allocation.close.would_close':
    'Cerraría {count} aplicación(es) viva(s) de {number} sobre {invoice}, {amount}, con la fecha de la reversa ({closed_at}); no postea nada ni toca la factura',
  'receipt.allocation.close.confirm':
    '¿Cerrar {count} aplicación(es) viva(s) del cobro reversado {number} sobre {invoice} ({amount})? La reversa ya reabrió la factura y reflejó sus pólizas; esto sólo cierra la fila, con la fecha de la reversa, y no postea nada. No se puede deshacer.',
  'receipt.allocation.close.closed':
    '{number}: {count} aplicación(es) sobre {invoice} cerrada(s) ({amount}), con la fecha de la reversa ({closed_at}); no se posteó nada',
  'receipt.allocation.close.dry_run': 'Ensayo: el cierre sí corrió y se deshizo; no se escribió nada.',
  'receipt.allocation.close.key_unneeded': 'un reintento no encuentra ninguna aplicación viva sobre esa factura y se rechaza',
  // MNE-001-498 (#695): el saldo a cuenta de un cliente, traspasado a otro cliente.
  'receipt.transfer.reason_required':
    'Traspasar el crédito de un cliente exige --reason "<el acuerdo>": queda escrito en el rastro de auditoría y en el traspaso. No se escribió nada.',
  'receipt.transfer.amount_invalid':
    'El importe «{amount}» de un traspaso tiene que ser mayor que cero, con 4 decimales a lo más. No se escribió nada.',
  'receipt.transfer.not_mexican_books':
    'Esta entidad no lleva libros mexicanos: el traspaso de crédito de un cliente está hecho para ellos (su IVA se causa cuando el crédito salda una factura, LIVA art. 1o.-B). No se escribió nada.',
  'receipt.transfer.not_completed':
    'El cobro {receipt} está en «{status}»: sólo un cobro completado tiene saldo a cuenta que traspasar. No se escribió nada.',
  'receipt.transfer.not_functional_currency':
    'El cobro {receipt} está en {currency}: sólo se traspasa saldo a cuenta en {functional}, porque el traspaso mueve su importe en anticipos de clientes tal como está. No se escribió nada.',
  'receipt.transfer.source_is_transfer':
    'El cobro {receipt} ya es un traspaso de crédito de un cliente: no se pasa a un tercer cliente. Para corregirlo, revérsalo con `mnemosine receipt reverse {receipt} --reason "<por qué>"` y traspasa desde el cobro original. No se escribió nada.',
  'receipt.transfer.kept_caused':
    'El saldo a cuenta de {receipt} volvió de una desaplicación que mantuvo causado su IVA o su IEPS: ese impuesto se lee de las aplicaciones de este mismo cobro y no puede seguir al crédito hacia otro cliente. Aplícalo mejor a facturas de este cliente. No se escribió nada.',
  'receipt.transfer.cheque_not_cashed':
    'El cobro {receipt} es un cheque que el banco no ha cobrado: no está cobrado hasta que se cobra (LIVA art. 1-B), y una devolución tendría que deshacer un crédito con el que el otro cliente ya cuenta. Registra primero el cobro con `mnemosine bank check reconcile --receipt {receipt}`. No se escribió nada.',
  'receipt.transfer.same_customer':
    'El cobro {receipt} ya es de {customer}: un traspaso mueve el saldo a cuenta a otro cliente. No se escribió nada.',
  'receipt.transfer.exceeds_on_account':
    'El cobro {receipt} tiene {onAccount} a cuenta y se traspasarían {amount}: el saldo a cuenta no alcanza. No se escribió nada.',
  'receipt.transfer.date_future':
    'El cobro {receipt} no se puede traspasar el {date}: es posterior a hoy ({today}) en la zona horaria de la entidad. No se escribió nada.',
  'receipt.transfer.date_before_last_event':
    'El último asiento del cobro {receipt} es del {since}: un traspaso fechado el {date} cedería su efectivo antes de que eso ocurriera. Féchalo el {since} o después. No se escribió nada.',
  'receipt.reverse.has_transfer':
    'Parte del saldo a cuenta de {receipt} se traspasó a otro cliente ({transfers}): reversar el cobro dejaría ese crédito sin dinero detrás. Reversa primero el traspaso con `mnemosine receipt reverse <traspaso> --reason "<por qué>"`. No se escribió nada.',
  'receipt.reverse.transfer_applied':
    'El traspaso {receipt} está aplicado a {invoices}: reversarlo quitaría un crédito que ya las saldó. Desaplícalo primero. No se escribió nada.',
  'receipt.reverse.transfer_carries_caused':
    'El saldo a cuenta del traspaso {receipt} volvió de una desaplicación que mantuvo causado su IVA o su IEPS: reversarlo devolvería al cobro original el efectivo sin ese impuesto. Aplícalo de nuevo a facturas del cliente. No se escribió nada.',
  'receipt.reverse.transfer_cause':
    'El traspaso {receipt} no movió dinero, así que su reversa no tiene causa: córrela sin --cause. No se escribió nada.',
  'receipt.transfer.carries': 'Lleva un anticipo de base {base} e IVA {iva}, causado cuando se cobró el origen',
  'receipt.transfer.would_transfer': 'Traspasaría {amount} de {source} de {from} a {to} el {date}',
  'receipt.transfer.on_account': '{party} a cuenta: {before} → {after}',
  'receipt.transfer.confirm':
    '¿Traspasar {amount} del saldo a cuenta de {source} de {from} a {to} el {date} en {entity}? Esto postea en el mayor.',
  'receipt.transfer.recorded': '{number}: {amount} de {source} traspasados de {from} a {to} el {date} · asiento {entry}',
  // MNE-001-568 (#612): el rastro de un pago registrado, completado con su evidencia.
  'payment.trace.nothing_given':
    'Di qué completar: --check-number, --to-account, --to-bank, --to-foreign-bank o --bank. No se escribió nada.',
  'payment.trace.reason_required':
    'Completar el rastro de un pago exige --reason "<por qué>", con la evidencia de la que sale: queda escrito en el rastro de auditoría.',
  'payment.trace.too_long':
    '{flag} admite hasta {max} caracteres en el nodo de pago del archivo de pólizas del SAT, y se dieron {length}. No se escribió nada.',
  'payment.trace.not_completable':
    'El pago {number} está en «{status}»: sólo un pago completado o reversado tiene un asiento posteado cuya póliza declara su rastro. No se escribió nada.',
  'payment.trace.already_captured':
    'El pago {number} ya tiene {stored} en {flag}: sólo se completa un campo vacío, y corregir un valor capturado no es este comando. No se escribió nada.',
  'payment.trace.race': '{number} cambió mientras se completaba su rastro; no se escribió nada.',
  // MNE-001-571 (#612): el aviso al capturar es el hallazgo del generador para esa póliza.
  'payment.capture.untraced_voucher':
    'Cuando el SAT pida las pólizas del periodo, `mnemosine e-accounting voucher generate` nombrará la póliza {entry} de {number}:',
  // MNE-001-401 (#532): 999 is "N/A" in c_Banco; alone it names no bank.
  'payment.capture.foreign_code_without_name':
    '--to-bank 999 es «N/A» en el catálogo c_Banco del SAT y no nombra ningún banco. Si el banco es extranjero, da su nombre con --to-foreign-bank (la póliza le pone el 999); si es nacional, su propia clave. La póliza llevará un aviso.',
  // MNE-001-570 (#612): el rastro de un cobro registrado.
  'receipt.trace.nothing_given':
    'Di qué completar: --check-number, --payer-bank, --payer-account, --payer-foreign-bank o --bank. No se escribió nada.',
  // MNE-001-594 (#695): un traspaso de crédito de un cliente no movió dinero, así que no tiene rastro.
  'receipt.trace.balance_transfer':
    '{number} es un traspaso de crédito de un cliente desde {source}: no se movió dinero, así que no tiene cheque, banco del cliente ni cuenta bancaria que completar, y ninguna póliza los declara. El rastro va en {source}, el cobro que recibió el dinero. No se escribió nada.',
  // MNE-001-569 (#612): la cuenta bancaria que se liga después tiene que ser la que movió el asiento.
  'payment.trace.bank_no_entry':
    'El pago {number} no tiene asiento posteado: no hay renglón del mayor contra el cual cotejar una cuenta bancaria. No se escribió nada.',
  'payment.trace.bank_not_in_entry':
    'El asiento {entry} del pago {number} movió {moved}; «{account}» postea a {candidate}. Ligarla haría que la póliza declarara un banco que el mayor no movió. No se escribió nada.',
  'payment.trace.would_complete': 'Completaría {number}: {fields}',
  'payment.trace.confirm':
    '¿Completar {fields} en {number}? Sólo se llenan campos vacíos, y no se postea nada en el mayor.',
  'payment.trace.completed': '{number}: {fields} completado; no se posteó nada',
  'payment.trace.unchanged': '{number}: {fields} ya tenía ese valor; no se escribió nada para eso',
  'payment.trace.period_not_open':
    'El periodo {period} está en {status}: no cambia ninguna cifra del mayor; un archivo de pólizas generado ahora declarará este dato.',
  'payment.trace.archived_files':
    '{count, plural, one {# archivo de pólizas} other {# archivos de pólizas}} de {period} se archivaron antes de este complemento: se quedan como están, y uno generado ahora será distinto de ellos.',
  'receipt.advance.cfdi_owed':
    'no se debe: un anticipo se documenta con el CFDI de anticipo que emite el cliente (Anexo 20, Apéndice 6), no con un REP',
  'receipt.advance.invoice_already_booked':
    '{customer} tiene abierta {invoices}, y su propia póliza ya abonó anticipos de clientes: un CFDI de anticipo en libros. El dinero de ese anticipo se registra contra ella (receipt record {invoice}), no como un anticipo nuevo. Sigue sólo si éste es otro anticipo.',
  // MNE-001-422 / MNE-001-461 (#623): an advance applied to its sale's invoice cancels the IVA it caused.
  'receipt.advance.iva_cancelled': 'IVA del anticipo cancelado {iva}',
  'receipt.advance.iva_restored': 'IVA del anticipo devuelto {iva}',
  // MNE-001-573 (#789): a PUE invoice of a month before its cheque advance was cashed.
  'receipt.advance.iva_before_cashing':
    'El IVA del anticipo de {iva} cancelado en {invoice} se causa el {cashed}, el día en que el banco cobró el cheque (LIVA art. 1-B, segundo párrafo), y {invoice}, una PUE, ya lo causó en {month}: el IVA trasladado de ese mes lleva lo que correspondía al día del cobro, y esta aplicación cancela el del anticipo en su propio mes. Revisa la declaración de {month}.',
  'receipt.advance.iva_caused_twice':
    'El IVA del anticipo, {iva}, que se cancela en {invoice} también se causó en {month} por esa factura, una PUE emitida el día del anticipo o antes (LIVA art. 1-B): el IVA trasladado de ese mes lo llevó dos veces, y esta aplicación lo cancela en su propio mes. Revisa la declaración de {month}.',
  'bank.parse.date_invalid': '{flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "{value}".',
  'bank.parse.amount_invalid': '{flag} debe ser un importe decimal; llegó "{value}".',
  'bank.parse.rate_invalid': '{flag} debe ser una tasa decimal; llegó "{value}".',
  'bank.parse.rate_out_of_range':
    '{flag} va entre 0 y 1, no en porcentaje: 0.16 para el 16%, 0.0125 para el 1.25%, 0 para ' +
    'ninguna. Llegó "{value}".',
  'bank.parse.account_type_unknown':
    '--type "{value}" no es un tipo de cuenta. Los cinco son: {types}.',
  'bank.parse.account_status_unknown':
    '--status {values} no existe para una cuenta bancaria: sólo active y archived.',
  'bank.parse.transaction_status_unknown':
    '-s {values} no existe para un movimiento bancario: sólo matched y unmatched. El resto de su ' +
    'estado —de qué estado de cuenta vino, qué lo explica— se lee con `bank transaction show`.',
  'bank.parse.unmatched_contradicts_status':
    '--unmatched y `-s matched` piden lo contrario. --unmatched es el atajo de `-s unmatched`: ' +
    'pasa uno de los dos.',
  'bank.parse.direction_unknown':
    '--direction "{value}" no existe: in es dinero que entra (importe positivo) y out el que sale.',
  'bank.parse.id_list_empty': '{flag} llegó vacía: nombra al menos un identificador.',
  'bank.parse.id_list_invalid':
    '{flag} {values} no es un identificador: se esperan uuid separados por comas, como los que ' +
    'imprime `bank transaction list -q`.',
  'bank.parse.uuid_invalid': '{flag} "{value}" no es un identificador: se espera un uuid.',
  'bank.parse.matchable_type_unknown':
    '"{value}" no es un tipo cotejable. Los cinco son: {types}. Escribe <tipo>:<id>, o sólo <id> ' +
    'para una partida de póliza.',
  'bank.parse.book_item_uuid_missing':
    '--book-item "{value}" no trae un identificador válido después del tipo.',
  'bank.parse.residual_unknown':
    '--residual "{value}" no existe. keep deja el residual vivo como partida conciliatoria; ' +
    'write-off lo cancela contra la cuenta que diga --write-off-account.',
  'bank.parse.unapply_reason_required':
    '--reason es obligatorio y es un CÓDIGO, no prosa: {codes}. Una taxonomía cerrada es lo que ' +
    'permite preguntar cuántos cotejos se deshicieron por documento cancelado este trimestre; un ' +
    'campo libre contesta eso con un grep.',
  'bank.parse.item_type_unknown':
    '--type "{value}" no es un tipo de partida conciliatoria. Los seis son: {types}.',
  'bank.parse.adjustment_type_unknown':
    '--type "{value}" no es un tipo de ajuste de conciliación. Los cinco son: {types}.',
  'bank.parse.run_step_unknown':
    '--stop-at "{value}" no es un paso del pase guiado. Los cinco, en orden: {steps}. Ninguno ' +
    'llega a `approve` ni a `post`.',
  'bank.parse.session_status_one_only':
    '-s admite un estado a la vez en esta hoja (llegaron {count}): {statuses}. Sin la bandera ' +
    'salen los cuatro.',
  'bank.parse.session_status_unknown':
    '-s "{value}" no es un estado de sesión de conciliación. Los cuatro son: {statuses}.',
  'bank.parse.item_status_unknown':
    '-s {values} no existe para una partida conciliatoria: sólo open y resolved. Una partida ' +
    'resuelta dejó de explicar una diferencia y por eso no sale por omisión.',
  'bank.query.unclosed_quote': 'La consulta "{query}" abre una comilla y no la cierra.',
  'bank.query.term_unknown':
    'La consulta no conoce el término "{term}:". Los que hay son {terms}, y una palabra sin ' +
    'prefijo busca en la descripción. El resto se acota con banderas (--account, --since, ' +
    '--until, --direction, --type).',
  'bank.query.term_without_value': 'El término "{term}" no trae valor: escribe {key}:<valor>.',
  'bank.query.amount_invalid':
    '"amt:{value}" no es un importe. La forma es amt:250, amt:>1000, amt:<=99.99 o amt:-250 ' +
    '(con signo compara el importe tal cual; sin signo, la magnitud).',
  'bank.query.narrows_nothing':
    'La consulta "{query}" no acota nada. Nombra al menos un término ({terms}), o quítala para ' +
    'listar todo.',

  // --- Lo que comparten todas las hojas de la familia -------------------
  'bank.list.hit_limit':
    'Se {count, plural, one {listó # fila} other {listaron # filas}}, que es el tope de --limit: ' +
    'puede haber más. Sube --limit, o usa --all en `{command}`.',
  'bank.offset.unsupported':
    '--offset no está implementado en esta familia: la consulta ordena y acota con --limit, sin ' +
    'cursor estable. {alternative}',
  'bank.offset.narrow_accounts': 'Acota con [query], --type o --currency, o pide todo con --all.',
  'bank.offset.narrow_statements': 'Acota con --account, --since o --until.',
  'bank.offset.narrow_sessions': 'Acota con --account, --period o -s, o pide todo con --all.',
  'bank.confirm.taken_as_no': '{reason}; lo tomo como no.',
  'bank.aborted.no_changes': 'Sin cambios.',
  'bank.idempotency.hit':
    'Idempotency hit: la llave "{key}" ya consumó este acto — {what}. Nada se ejecutó otra vez; ' +
    'esto es el resultado grabado.',

  // --- bank account -----------------------------------------------------
  'bank.account.create.dry_run':
    'Ensayo: el alta se ejecutó de verdad —índice único incluido— y se deshizo. Nada quedó escrito.',
  'bank.account.show.liability': 'PASIVO',
  'bank.account.show.label.account_number': 'Número de cuenta',
  'bank.account.show.label.routing': 'Ruteo ABA',
  'bank.account.show.label.sat_bank_key': 'Clave de banco SAT',
  'bank.account.show.label.gl_account': 'Cuenta de mayor',
  'bank.account.show.label.book_balance': 'Saldo en libros',
  'bank.account.show.label.bank_balance': 'Saldo del banco',
  'bank.account.show.label.difference': 'Diferencia',
  'bank.account.show.label.last_reconciled': 'Última conciliación',
  'bank.account.show.label.status': 'Estado',
  'bank.account.show.routing_on_file': 'en archivo (cifrado)',
  'bank.account.show.gl_unmapped': 'sin mapear',
  'bank.account.show.bank_balance_never_synced': 'nunca sincronizado',
  'bank.account.show.never_reconciled': 'nunca',
  'bank.account.show.status_active': 'activa',
  'bank.account.show.status_archived': 'archivada',
  'bank.account.show.label.foreign_bank': 'Banco extranjero',
  'bank.account.show.foreign_bank_marked': 'sin residencia en México',
  'bank.account.foreign_bank.reason_required':
    '--foreign-bank y --no-foreign-bank exigen --reason "<por qué>": la marca dice si el banco reside en ' +
    'México, y el archivo de pólizas lo declara. El motivo se guarda en la bitácora, que es append-only.',
  'bank.account.foreign_bank.keeps_sat_bank_code':
    'Una cuenta de banco extranjero no tiene clave c_Banco del SAT, y esta edición la deja con {code}. ' +
    'Bórrala en la misma edición con --sat-bank-code "", o quita la marca con --no-foreign-bank --reason "<por qué>".',
  'bank.account.foreign_bank.keeps_clabe':
    'Una cuenta de banco extranjero no tiene CLABE, que sólo emite un banco residente en México, y esta ' +
    'edición la deja con una. Bórrala en la misma edición con --clabe "" --reason "<por qué>", o quita la ' +
    'marca con --no-foreign-bank --reason "<por qué>".',
  'bank.account.create.foreign_bank.sat_bank_code':
    'Una cuenta de banco extranjero no tiene clave c_Banco del SAT, y ésta se daría de alta con {code}. ' +
    'Quita --sat-bank-code, o dala de alta sin --foreign-bank si su banco reside en México.',
  'bank.account.create.foreign_bank.clabe':
    'Una cuenta de banco extranjero no tiene CLABE, que sólo emite un banco residente en México. ' +
    'Quita --clabe y da su --account-number, o dala de alta sin --foreign-bank si su banco reside en México.',
  'bank.account.create.no_sat_bank_code':
    'La cuenta queda sin clave c_Banco del SAT: el archivo de pólizas la exige para el origen y el destino de un pago. ' +
    'Captúrala con `bank account edit <cuenta> --sat-bank-code <clave>` o, si su banco no reside en México, ' +
    'márcala con `bank account edit <cuenta> --foreign-bank --reason "<por qué>"`.',
  'bank.account.foreign_bank.name_too_long':
    'El nombre del banco tiene {length} caracteres y el archivo de pólizas declara un banco extranjero en un ' +
    'atributo que admite {max}: cada uno de sus pagos deja fuera su nodo de la póliza, que se nombra, y el nombre nunca se recorta. ' +
    'Acórtalo con `bank account edit <cuenta> --bank "<nombre de hasta {max} caracteres>"`.',
  'bank.account.edit.nothing_to_change':
    'Nada que cambiar. Pasa --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift, --iban, ' +
    '--foreign-bank o --no-foreign-bank.',
  'bank.account.edit.reason_required':
    '{fields} cambia uno de los identificadores por los que sale el dinero ({sensitive}): exige ' +
    '--reason "<por qué>". El motivo se guarda en la bitácora, que es append-only.',
  'bank.account.edit.confirm': 'Vas a cambiar {fields} de "{account}". ¿Continuar?',
  'bank.account.edit.nothing_changed': 'Nada cambió: los valores ya eran esos.',
  'bank.account.edit.fields_changed': '{count, plural, one {# campo} other {# campos}}',
  'bank.account.edit.dry_run': 'Ensayo: el UPDATE corrió de verdad y se deshizo.',
  'bank.account.set.already_mapped':
    '{account} ya estaba mapeada a {gl}: nada que escribir.',
  'bank.account.set.forced':
    'FORZADO sobre {count, plural, one {# línea contabilizada} other {# líneas contabilizadas}}',

  // --- bank statement ----------------------------------------------------
  'bank.dir.unreadable': 'No se pudo leer --dir {dir}: {error}',
  'bank.dir.no_files': '--dir {dir} no tiene archivos que importar.',
  'bank.import.no_file': 'Qué archivo. Pásalo como argumento o apunta a un directorio con --dir.',
  'bank.import.counts':
    '{added, plural, one {# nueva} other {# nuevas}}, ' +
    '{duplicated, plural, one {# ya estaba} other {# ya estaban}}',
  'bank.import.findings':
    '{file}: {count, plural, one {# hallazgo} other {# hallazgos}} de integridad. Están en ' +
    'staging igual — es `bank statement check` quien sale 4.',
  'bank.import.dry_run': 'Ensayo: se parseó, se verificó y la escritura se deshizo.',
  'bank.import.staging_note':
    'Staging bancario: nada de esto está en el mayor hasta que se cotee y se concilie.',
  'bank.statement.list.status_not_applicable':
    '-s/--status no aplica a un estado de cuenta: no tiene estado de ciclo de vida. Su veredicto ' +
    'se calcula al leerlo (columna `chain`), y quien lo juzga es `bank statement check`, que sale 4.',
  'bank.statement.list.broken_chains':
    '{count, plural, one {# estado} other {# estados}} con la cadena de saldos rota. ' +
    '`bank statement check` dice cuál prueba falló y sale 4.',
  'bank.statement.show.line_count_mismatch':
    'El documento trae {document, plural, one {# línea} other {# líneas}} y la base le atribuye ' +
    '{stored}: las que faltan se dedujeron contra un estado anterior y conservan el statement_id ' +
    'de aquél.',
  'bank.statement.show.lines_omitted':
    '{count, plural, one {# línea más no se listó} other {# líneas más no se listaron}}. Sube --limit.',
  'bank.statement.check.skipped':
    '{count, plural, one {# estado más cumplía} other {# estados más cumplían}} el filtro y no ' +
    'se verificaron: la corrida tiene tope. Acota con --account o con --since.',

  // --- bank transaction · book-item · match -------------------------------
  'bank.transaction.show.no_extractors':
    'Sin extractores todavía ({fields}): lo que el banco escribió está en --raw. Los poblará ' +
    '`bank transaction apply`.',
  'bank.book_item.oldest_unseen':
    'La más antigua lleva {days, plural, one {# día} other {# días}} sin aparecer en el banco ' +
    '({entry}). Un cheque expedido y no cobrado vive aquí y nunca en el extracto.',
  'bank.match.preview.needs_target':
    'Previsualizar necesita saber sobre qué: pasa el id de un movimiento, o --account para ' +
    'recorrer los no cotejados de una cuenta.',
  'bank.match.preview.no_proposal': 'sin propuesta',
  'bank.match.preview.candidate': 'confianza {confidence} · regla {rule}',
  'bank.match.preview.label.amount': 'importe',
  'bank.match.preview.label.date': 'fecha',
  'bank.match.preview.label.description': 'descripción',
  'bank.match.preview.label.period': 'periodo',
  'bank.match.preview.label.verdict': 'veredicto',
  'bank.match.preview.amount_signal':
    '{bank} vs {candidate} · diferencia {difference} · exacto {exact} · misma dirección {sameDirection}',
  'bank.match.preview.date_signal':
    '{days, plural, one {# día} other {# días}} · dentro de ventana {withinWindow}',
  'bank.match.preview.description_signal': 'similitud {similarity}',
  'bank.match.preview.soft_signal': '(señal blanda: nunca aplica sola)',
  'bank.match.preview.would_apply': '`run` lo aplicaría',
  'bank.match.preview.not_applied': 'no se aplica',
  'bank.match.preview.summary':
    '{count, plural, one {movimiento} other {movimientos}} · {applicable} que `bank match run` aplicaría.',
  'bank.match.preview.hit_top':
    'Se previsualizaron {count}, que es el tope de --top: puede haber más.',
  'bank.match.applied': '{count, plural, one {# aplicado} other {# aplicados}}',
  'bank.match.run.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · ' +
    '{evaluated, plural, one {# evaluado} other {# evaluados}}',
  'bank.match.apply.tally':
    '· {already, plural, one {# ya lo estaba} other {# ya lo estaban}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}}',
  'bank.match.apply.stdin_empty':
    'La entrada estándar no trajo ningún id. `bank match preview -q` los escupe uno por línea.',
  'bank.match.apply.no_transactions':
    'Qué movimientos. Pásalos como argumento, o encadena `bank match preview -q | mnemosine bank ' +
    'match apply --stdin`.',
  'bank.match.apply.confirm':
    'Vas a aplicar el cotejo que el motor propone para ' +
    '{count, plural, one {# movimiento} other {# movimientos}}. ¿Continuar?',
  'bank.match.apply.no_terminal':
    'Sin cambios: no hay terminal donde confirmar (la entrada estándar es la tubería). Añade -y ' +
    'para aplicar sin preguntar.',
  'bank.match.create.write_off_declared':
    'El residual de {amount} queda DECLARADO como cancelado contra la cuenta, pero no se ' +
    'contabiliza: no hay póliza detrás todavía. Regístrala a mano o espera a F05c.',
  'bank.match.create.dry_run': 'Ensayo: el grupo se escribió de verdad y se deshizo.',
  'bank.match.unapply.confirm':
    'Vas a desaplicar el cotejo {match} y todos los de su grupo (la igualdad ' +
    'Σbanco = Σlibros + Σajustes no sobrevive a que le quiten una pata). ¿Continuar?',
  'bank.match.unapply.closed':
    '{count, plural, one {# cotejo clausurado} other {# cotejos clausurados}}',
  'bank.match.unapply.released':
    '· {transactions, plural, one {# movimiento} other {# movimientos}} y ' +
    '{items, plural, one {# partida} other {# partidas}} de vuelta al flujo · motivo {reason}',
  'bank.match.unapply.group': 'grupo {group}',
  'bank.match.unapply.closure_note':
    'Clausura, no borrado: la fila se queda en el expediente con su motivo, porque el auditor ' +
    'pregunta por qué se deshizo y una fila borrada no contesta.',
  'bank.match.unapply.dry_run': 'Ensayo: se clausuró de verdad y se deshizo.',

  // --- bank reconciliation: la aritmética de dos lados ---------------------
  'bank.reconciliation.not_observed': 'sin observar',
  'bank.reconciliation.side.bank': 'BANCO',
  'bank.reconciliation.side.books': 'LIBROS',
  'bank.reconciliation.label.statement_balance': 'saldo del extracto',
  'bank.reconciliation.label.book_balance': 'saldo de libros',
  'bank.reconciliation.label.adjusted': '= ajustado',
  'bank.reconciliation.label.variance': 'VARIACIÓN',
  'bank.reconciliation.variance_not_computed': 'NO CALCULADA',
  'bank.reconciliation.variance_missing_side':
    'No es cero: es que falta un lado. Un cero aquí significaría «nadie restó nada».',
  'bank.reconciliation.tolerance_line': 'tolerancia {tolerance} · política {policy}',
  'bank.reconciliation.counters.items_label': 'partidas',
  'bank.reconciliation.counters.items':
    '{total} · {unclassified} sin clasificar · {undated} sin fechar · ' +
    '{resolved, plural, one {# resuelta} other {# resueltas}}',
  'bank.reconciliation.counters.statement_label': 'extracto',
  'bank.reconciliation.counters.unexplained':
    '{count, plural, one {# movimiento} other {# movimientos}} sin cotejo y sin partida ({amount})',
  'bank.reconciliation.frozen.title': 'RESUMEN CONGELADO',
  'bank.reconciliation.frozen.caption': '(la aseveración, no la respuesta)',
  'bank.reconciliation.frozen.never_computed':
    'nadie ha hecho la aritmética de esta sesión: la fila guarda variance {variance} por DEFAULT',
  'bank.reconciliation.frozen.line':
    'variance {variance} · libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.frozen.computed_on': 'calculada el {date}',
  'bank.reconciliation.frozen.drifted':
    'la aritmética viva dice {live} y la sesión afirmó {frozen}: algo cambió debajo desde que se cerró.',
  'bank.reconciliation.ready_to_close': 'lista para `bank reconciliation close`.',
  'bank.reconciliation.whats_missing': 'LO QUE FALTA',
  'bank.reconciliation.session_label': 'sesión {session}',
  'bank.reconciliation.run.file_flags_without_file':
    '--format y --profile describen el archivo de --file, y no hay archivo. Pasa --file, o ' +
    'quítalas para tomar el extracto que ya esté importado.',
  'bank.reconciliation.run.dry_run':
    'Ensayo: los pasos que escriben se ejecutaron de verdad y se deshicieron.',
  'bank.reconciliation.open.summary':
    'saldo inicial {opening} · cierre de banco {closingBank} {currency} · extracto {statement}',
  'bank.reconciliation.open.continues': 'continúa {session}',
  'bank.reconciliation.open.baseline': 'parte de la línea base {balance} al {date}',
  'bank.reconciliation.open.baseline_date_without_baseline':
    '--baseline-date es la fecha de --baseline, y no hay --baseline. Pasa el saldo conciliado con --baseline, o quita --baseline-date.',
  'bank.reconciliation.open.no_arithmetic_yet':
    'La sesión nace sin aritmética (`arithmetic_computed_at` NULL): `bank reconciliation status` ' +
    'la calcula viva y `close` la firma. Nada de esto toca el mayor.',
  'bank.reconciliation.open.dry_run':
    'Ensayo: la sesión se abrió de verdad —continuidad incluida— y se deshizo.',
  'bank.reconciliation.list.variance_blank':
    '{count, plural, one {# sesión} other {# sesiones}} con la variación en blanco: nadie ha ' +
    'hecho su aritmética. La columna de la fila vale 0 por DEFAULT y por eso no se imprime.',
  'bank.reconciliation.status.needs_target':
    'Di qué sesión: `bank reconciliation status <session>`, o --account para la que esté en curso ' +
    'en esa cuenta.',
  'bank.reconciliation.status.two_ways':
    'El identificador y --account dicen lo mismo de dos maneras: da uno de los dos. Con --account ' +
    'se lee la sesión EN CURSO de esa cuenta.',
  'bank.reconciliation.status.statement_line':
    'extracto {statement} · declarado por el banco {declared} · saldo inicial {opening}',
  'bank.reconciliation.status.no_statement':
    'sin extracto atado: el saldo del banco NO se puede observar',
  'bank.reconciliation.status.items_title': 'PARTIDAS',
  'bank.reconciliation.status.adjustments_title': 'AJUSTES',
  'bank.reconciliation.status.adjustments_caption': '(borradores: nada se contabilizó solo)',

  // --- bank reconciling-item · adjustment · close · approve ----------------
  'bank.item.list.ageing':
    'La más antigua lleva {days, plural, one {# día} other {# días}}. ' +
    '{overdue, plural, one {# vencida} other {# vencidas}} y {undated} sin fecha esperada: una ' +
    'partida sin fecha no se persigue, envejece.',
  'bank.item.assign.expected_contradiction':
    '`--expected` y `--clear-expected` piden lo contrario: o se fija una fecha o se quita.',
  'bank.item.assign.nothing_to_assign':
    'No hay nada que asignar: indica al menos --owner, --expected, --clear-expected, --escalation o --note.',
  'bank.item.assign.escalation_unknown': '--escalation admite {values}; llegó "{value}".',
  'bank.adjustment.create.summary':
    '· {type} · {amount} · contrapartida {account} · banco {bankAccount} · borrador {draft}',
  'bank.adjustment.create.draft_note':
    'Es un BORRADOR: espera a `mnemosine review`. `journal_entry_id` queda NULL hasta que ' +
    '`bank reconciliation post` (F05d) lo contabilice detrás de una firma.',
  'bank.reconciliation.close.refused':
    'La sesión {session} no cierra: variación {variance}, ' +
    '{unclassified, plural, one {# partida sin clasificar} other {# partidas sin clasificar}} y ' +
    '{undated} sin fechar.',
  'bank.reconciliation.close.variance_missing_side': 'NO CALCULADA (no es cero: falta un lado)',
  'bank.reconciliation.close.what_balanced_would_claim':
    'Marcarla "balanced" con esto abierto le diría al tablero de cierre que el efectivo de esta ' +
    'cuenta está verificado contra el banco.',
  'bank.reconciliation.close.confirm':
    'Vas a firmar que la cuenta {account} cuadra con el banco al {until} (variación {variance}). ' +
    '`period-close` lo leerá como la evidencia de que el efectivo se verificó. ¿Continuar?',
  'bank.reconciliation.close.no_terminal':
    'Sin cambios: no hay terminal donde confirmar. Añade -y para cerrar sin preguntar.',
  'bank.reconciliation.close.summary':
    '· {status} · variación {variance} · banco ajustado {bankAdjusted} = libros ajustado {booksAdjusted}',
  'bank.reconciliation.close.frozen_summary':
    'resumen congelado: libros {books} · cheques {checks} · depósitos {deposits} · ' +
    'cargos {charges} · abonos {credits} · otros {other}',
  'bank.reconciliation.close.arithmetic_stamp':
    'Aritmética calculada el {date}. Balanceada NO es aprobada ni contabilizada: `approve` exige ' +
    'que el aprobador no sea el preparador, y `post` es lo que mueve el mayor.',
  'bank.reconciliation.close.dry_run': 'Ensayo: se cerró de verdad y se deshizo.',
  'bank.reconciliation.approve.title': 'LO QUE SE VA A FIRMAR',
  'bank.reconciliation.approve.label.session': 'sesión',
  'bank.reconciliation.approve.label.account': 'cuenta',
  'bank.reconciliation.approve.label.statement': 'extracto',
  'bank.reconciliation.approve.label.variance': 'variación',
  'bank.reconciliation.approve.label.members': 'miembros',
  'bank.reconciliation.approve.label.segregation': 'segregación',
  'bank.reconciliation.approve.no_statement': 'ninguno atado a la sesión',
  'bank.reconciliation.approve.variance_value': '{live} (congelada al cerrar: {frozen})',
  'bank.reconciliation.approve.members_value':
    '{items, plural, one {# partida} other {# partidas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}',
  'bank.reconciliation.approve.segregation_value': 'preparó {preparer} · política {policy}',
  'bank.reconciliation.approve.nobody_recorded': 'nadie registrado',
  'bank.reconciliation.approve.policy_default': '(por omisión)',
  'bank.reconciliation.approve.confirm':
    'Vas a FIRMAR la sesión {session} con la instantánea {hash}… ' +
    '({items, plural, one {# partida} other {# partidas}}, ' +
    '{adjustments, plural, one {# ajuste} other {# ajustes}}, variación {variance}). Volver a ' +
    'aprobarla se rechaza; retirar la firma pide `bank reconciliation reopen` y un motivo. ' +
    '¿Continuar?',
  'bank.reconciliation.approve.already_signed': 'sesión {session} ya firmada',
  'bank.reconciliation.approve.summary': '· {status} · firmada por {by} el {on}',
  'bank.reconciliation.approve.not_posted_yet':
    'Aprobada NO es contabilizada: el mayor lo mueve `bank reconciliation post`, que postea los ' +
    'ajustes que esta firma acaba de congelar.',
  'bank.reconciliation.approve.dry_run':
    'Ensayo: se firmó de verdad y se deshizo. El hash es el que quedaría.',

  'bank.reconciliation.reopen.title': 'LO QUE SE VA A REABRIR',
  'bank.reconciliation.reopen.transition': 'sesión {session} · {from} → {to} · {previous} → in_progress',
  'bank.reconciliation.reopen.reversal':
    'asiento {entry} revertido por {reversal} (nunca borrado); su ajuste vuelve a ser un borrador pendiente',
  'bank.reconciliation.reopen.withdrawn':
    'firma que se retira: {by} el {on} (la bitácora la conserva con su instantánea)',
  'bank.reconciliation.reopen.confirm':
    'Vas a REABRIR la sesión {session} y retirar su firma {hash}…' +
    '{reversals, plural, =0 {} one { Revierte # asiento contabilizado.} other { Revierte # asientos contabilizados.}} ' +
    '¿Continuar?',
  'bank.reconciliation.reopen.already_reopened': 'sesión {session} ya reabierta',
  'bank.reconciliation.reopen.summary': '· {status} · firma retirada',
  'bank.reconciliation.reopen.next':
    'Corrige lo que estaba mal y vuelve a correr `bank reconciliation close` y `approve` sobre el mismo rango.',
  'bank.reconciliation.reopen.dry_run': 'Ensayo: se reabrió de verdad y se deshizo.',

  // --- bank reconciliation post · generate --------------------------------
  'bank.reconciliation.post.already_posted': 'La sesión ya está contabilizada',
  'bank.reconciliation.post.already_posted_detail':
    '{count, plural, one {# asiento} other {# asientos}} en el libro y nada que postear.',
  'bank.reconciliation.post.already_posted_short': 'sesión {session} ya contabilizada',
  'bank.reconciliation.post.entries_title': 'ASIENTOS QUE SE VAN A CREAR',
  'bank.reconciliation.post.no_entries': 'ninguno: la sesión no tiene ajustes que contabilizar',
  'bank.reconciliation.post.adopted': 'adoptado',
  'bank.reconciliation.post.new': 'nuevo',
  'bank.reconciliation.post.entry_ref': '· póliza {entry} · borrador {draft}',
  'bank.reconciliation.post.counterpart_note':
    'contrapartida de cada uno: la que fijó `bank adjustment create` en su borrador',
  'bank.reconciliation.post.sealed_title': 'Y LO QUE SE SELLA',
  'bank.reconciliation.post.sealed_lines':
    '{count, plural, one {línea de libros} other {líneas de libros}} contra la cuenta de mayor del banco',
  'bank.reconciliation.post.sealed_matches':
    '{count, plural, one {cotejo} other {cotejos}} contra el movimiento del extracto que las explica',
  'bank.reconciliation.post.sealed_items':
    '{count, plural, one {partida conciliatoria} other {partidas conciliatorias}} que el ajuste deja sin objeto',
  'bank.reconciliation.post.confirm_noop':
    'La sesión {session} ya está contabilizada y no se va a postear nada. ¿Continuar de todos modos?',
  'bank.reconciliation.post.confirm':
    'Vas a CONTABILIZAR {entries, plural, one {# asiento nuevo} other {# asientos nuevos}} en el ' +
    'mayor de la sesión {session} y sellar {lines, plural, one {# línea} other {# líneas}} de ' +
    'libros. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.reconciliation.post.summary':
    '· {status} · {posted, plural, one {# posteado} other {# posteados}} · ' +
    '{adopted, plural, one {# adoptado} other {# adoptados}} · ' +
    '{lines, plural, one {# línea sellada} other {# líneas selladas}} · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{items, plural, one {# partida resuelta} other {# partidas resueltas}}',
  'bank.reconciliation.post.seal_note':
    'El sello dice «este renglón ya está explicado por el banco», no «esta sesión terminó»: los ' +
    'cheques en circulación y los depósitos en tránsito siguen abiertos para el cotejo del mes que viene.',
  'bank.reconciliation.post.dry_run':
    'Ensayo: se contabilizó de verdad y se deshizo. No hay póliza en el libro.',
  'bank.reconciliation.generate.no_pdf_or_xlsx':
    '--format {format} no existe todavía: el proyecto no tiene dependencia de PDF ni de XLSX y no ' +
    'se le añade una para fingir un documento que acabaría en un expediente. Lo que hay: --format ' +
    'json (el estado entero, con las dos columnas y el resumen congelado), --format md|csv|tsv ' +
    '(el estado en renglones) y la salida de texto por omisión, que es la que se imprime y se archiva.',
  'bank.reconciliation.generate.title': 'ESTADO DE CONCILIACIÓN BANCARIA',
  'bank.reconciliation.generate.items_title': 'PARTIDAS CONCILIATORIAS',
  'bank.reconciliation.generate.drafts_caption': '(borradores)',
  'bank.reconciliation.generate.prepared_by': 'preparó',
  'bank.reconciliation.generate.approved_by': 'aprobó',
  'bank.reconciliation.generate.not_closed': 'sin cerrar',
  'bank.reconciliation.generate.not_approved': 'sin aprobar',

  // --- bank fee · interest · check ------------------------------------------
  'bank.skipped.title': 'OMITIDAS',
  'bank.entry_ref': '{description} · póliza {entry}',
  'bank.entry_number': 'póliza {entry}',
  'bank.no_description': 'sin descripción',
  'bank.entry_dry_run': '(ensayo)',
  'bank.posting.dry_run': 'Ensayo: se contabilizó de verdad y se deshizo; los ids salen en null.',
  'bank.fee.post.title': 'COMISIONES',
  'bank.fee.post.nothing_to_post': 'ningún cargo que contabilizar',
  'bank.fee.post.totals': 'totales: cargo {charge} · gasto {expense} · IVA {vat}',
  'bank.fee.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# comisión} other {# comisiones}} del {from} al {to} ' +
    'en la cuenta {account}, por {total} (IVA {vat}; pasan a IVA acreditable {released}). El ' +
    'mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.fee.post.fees': '{count, plural, one {# comisión} other {# comisiones}}',
  'bank.fee.post.summary':
    '· {posted, plural, one {# contabilizada} other {# contabilizadas}} · ' +
    '{skipped, plural, one {# omitida} other {# omitidas}} · cargo {charge} · IVA {vat}',
  'bank.fee.post.vat_release_ref': 'IVA de la comisión a acreditable · póliza {entry}',
  'bank.fee.post.vat_released_note':
    'El IVA de las comisiones ({vat}) pasó de pendiente de acreditar a IVA acreditable en el mes ' +
    'del cargo. Conserva el CFDI del banco: sin él no procede el acreditamiento.',
  'bank.interest.post.title': 'INTERESES',
  'bank.interest.post.withholding': 'retención {rate}',
  'bank.interest.post.nothing_to_post': 'ningún abono que contabilizar',
  'bank.interest.post.totals': 'totales: bruto {gross} · retenido {withheld} · neto {net}',
  'bank.interest.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# abono de interés} other {# abonos de interés}} del ' +
    '{from} al {to} en la cuenta {account}: {gross} de ingreso bruto y {withheld} de ISR retenido ' +
    'a favor. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.interest.post.credits':
    '{count, plural, one {# abono de interés} other {# abonos de interés}}',
  'bank.interest.post.summary':
    '· {posted, plural, one {# contabilizado} other {# contabilizados}} · ' +
    '{skipped, plural, one {# omitido} other {# omitidos}} · bruto {gross} · retenido {withheld}',
  'bank.interest.post.withholding_note':
    'El ISR retenido queda como pago provisional A FAVOR, no como gasto: es lo que se acredita ' +
    'contra el impuesto del ejercicio.',
  'bank.check.reconcile.title': 'EL MES EN QUE CAE EL ASIENTO',
  'bank.check.reconcile.label.check': 'cheque',
  'bank.check.reconcile.label.cleared_on': 'cobrado el',
  'bank.check.reconcile.check_value': '{check} · pago {payment}',
  'bank.check.reconcile.no_number': 'sin folio',
  'bank.check.reconcile.dated_by_bank':
    '(lo fecha el banco: movimiento {transaction}, {amount})',
  'bank.check.reconcile.no_open_period': 'sin periodo abierto en esa fecha',
  'bank.check.reconcile.no_period': 'sin periodo',
  'bank.check.reconcile.why':
    'por qué: bajo la LIVA el pago con cheque se entiende efectuado el día del COBRO y no el de ' +
    'la firma, así que el IVA de este pago se acredita en ese mes.',
  'bank.check.reconcile.entry_title': 'ASIENTO',
  'bank.check.reconcile.no_vat': 'ninguno: no hay IVA que reclasificar',
  'bank.check.reconcile.total': 'total reclasificado {amount}',
  'bank.check.reconcile.confirm':
    'Vas a registrar que el banco cobró el cheque {check} el {date} y a reclasificar {amount} de ' +
    'IVA en el periodo {period}. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'bank.check.reconcile.already_cleared': 'cheque cobrado el {date}',
  'bank.check.reconcile.changed_meanwhile':
    'El pago {payment} («{status}») cambió mientras se registraba el cobro de su cheque, o no es un pago completado. No se escribió nada.',
  'bank.check.reconcile.summary':
    '· cobrado el {date} · periodo {period} · IVA reclasificado {amount}',
  'bank.check.reconcile.dry_run': 'Ensayo: se registró el cobro de verdad y se deshizo.',
  'bank.check.cashing.refused.not_a_cheque':
    'El cobro {receipt} se pagó por «{method}», no con cheque: sólo un cheque se cobra en un día posterior.',
  'bank.check.cashing.refused.not_completed':
    'El cobro {receipt} está en «{status}»: el cobro del cheque sólo se registra sobre un cobro completado.',
  'bank.check.cashing.refused.already_cashed':
    'El cheque del cobro {receipt} ya consta cobrado el {date} con el movimiento {transaction}. Un cheque se cobra una vez.',
  'bank.check.cashing.refused.credit_used':
    'El movimiento {transaction} ya es el cobro del cheque del cobro {holder}, así que no puede pagar el cobro {receipt}.',
  'bank.check.cashing.refused.other_account':
    'El movimiento {transaction} es de otra cuenta bancaria que el cobro {receipt}. Si el cheque se depositó ahí, corrige el cobro.',
  'bank.check.cashing.refused.currency_differs':
    'El movimiento {transaction} está en {creditCurrency} y el cobro {receipt} en {currency}. Aquí no se convierte.',
  'bank.check.cashing.refused.amount_differs':
    'El movimiento {transaction} es de {creditAmount} y el cobro {receipt} necesita un abono de exactamente {amount}.',
  'bank.check.cashing.refused.credit_before_receipt':
    'El movimiento {transaction} es del {date} y el cobro {receipt} del {receiptDate}: un cheque no se cobra antes de recibirse.',
  'bank.check.cashing.refused.period_closed':
    'El cobro del cheque del cobro {receipt} es del {date}, y ningún periodo abierto contiene esa fecha. Su IVA pertenece a ese mes y no se contabiliza con otra fecha: reabre antes el periodo.',
  'bank.check.cashing.note.already_released':
    'Sin asiento: el cobro ya había liberado este IVA en su propia fecha.',
  'bank.check.cashing.note.nothing_to_release':
    'Sin asiento: este cobro no tiene IVA pendiente de cobro.',
  'bank.check.cashing.note.foreign_currency':
    'Sin asiento: un cheque en moneda extranjera libera su IVA en la fecha del cobro.',
  'bank.check.cashing.refused.transaction_needed':
    'El cobro {receipt} no dice a qué cuenta bancaria entró, así que no hay dónde buscar su abono. Nombra el movimiento bancario con `--transaction`.',
  'bank.check.cashing.refused.no_credit':
    'No hay ningún abono sin usar de {amount} a partir del {date} en la cuenta bancaria del cobro {receipt}. O el banco todavía no cobra el cheque, o lo abonó por otro importe: nombra el movimiento bancario con `--transaction`.',
  'bank.check.cashing.refused.several_credits':
    'Varios abonos de {amount} podrían ser el cheque del cobro {receipt}: {candidates}. No se elige ninguno, porque el equivocado fecha su IVA en el mes equivocado. Nombra el bueno con `--transaction`.',
  'bank.check.cashing.refused.as_of_differs':
    'El movimiento bancario {transaction} es del {date}, no del {asOf}, la fecha afirmada con `--as-of` para el cobro {receipt}. El cobro del cheque lo fecha el banco: revisa que ése sea el abono que pagó el cheque.',
  'bank.check.cashing.refused.several_need_transaction':
    'Los cobros {receipt} los cobra juntos un solo abono del banco: nómbralo con `--transaction`. No se busca por su suma, que puede coincidir con el depósito de otro día.',
  'bank.check.cashing.refused.sum_differs':
    'El movimiento {transaction} es de {creditAmount} y los cobros {receipt} suman {amount}: un abono cobra varios cheques sólo cuando es exactamente su suma.',
  'bank.check.cashing.refused.credit_matched':
    'El movimiento {transaction} está ligado por el cotejo vivo {match} a {type} {matched}, que no es ninguno de los cobros {receipt} ni un renglón de banco de sus pólizas: el abono pagó otra cosa. Si ese cotejo está mal, deshazlo con `bank match unapply {match}`.',
  'bank.check.cashing.check_value': '{check} · cobro {payment}',
  'bank.check.cashing.why':
    'por qué: bajo la LIVA el precio pagado con cheque se entiende cobrado el día en que el banco lo COBRA y no ' +
    'el día en que se recibe, así que el IVA de este cobro se causa en ese mes.',
  'bank.check.reconcile.one_of':
    'Nombra exactamente un cheque: el pago a proveedor <id>, o un cobro de cliente con --receipt <ref>.',
  'bank.transaction.show.unmatched': 'sin cotejar',
  'bank.match.create.summary':
    '· banco {bank} = libros {books} + ajustes {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# cotejo} other {# cotejos}} · ' +
    '{sealed, plural, one {# partida sellada} other {# partidas selladas}}',
  // ==== fin del piloto bank (I7) ====================================
  // ==== I8 · the CLI leaves by key, one block per family (MNE-001-217, issue #262) ====
  // Same blocks, same order as en.ts.
  // ==== I8.1 · CLI leaves by key, family report (issue #263) ====

  'report.cashflow.gross_unavailable':
    'El estado en términos BRUTOS (NIF B-2 §40 / ASC 230-10-45-7) no se puede construir con estos datos, y no se devuelve el neto rotulado como bruto. Lo bruto exige cobros y pagos separados, y eso es un dato de la OPERACIÓN, no de la cuenta: el motor publica un neto por cuenta, y partirlo en su cargo y su abono no da flujos —la baja de un activo abona a valor en libros mientras el efectivo cobrado es otro importe—. La salida por omisión ya muestra cada cuenta de cada sección, que es el detalle que estos libros sí sostienen. Vuelve a correr sin --gross.',
  'report.cashflow_reconcile.derived_concept': 'Estado de flujos, neto (método {method})',
  'report.cashflow_reconcile.ledger_concept': 'Caja y bancos, variación en el mayor',
  'report.cashflow_reconcile.residue_concept': 'Residuo (derivado − real)',
  'report.cashflow_reconcile.cash_accounts':
    'Efectivo: {accounts} ({defaulted, select, yes {criterio «{criterion}», por omisión} other {criterio «{criterion}»}}) · {opening} → {closing}',
  'report.cashflow_reconcile.ties':
    'Amarra: el estado de flujos equivale al movimiento real de efectivo.',
  'report.cashflow_reconcile.suspects':
    '{count, plural, one {# sospechoso} other {# sospechosos}} — es una LISTA DE SOSPECHOSOS, no un veredicto: son movimientos de efectivo que ninguna sección del estado parece reclamar, o que puede estar contando dos veces. Verifícalos antes de tocar nada.',
  'report.cashflow_reconcile.coverage':
    'Explican {explained} del residuo {amount}; quedan {unexplained} que no explica ninguno.',
  'report.cashflow_reconcile.no_suspects':
    'Sin sospechosos que ofrecer: todo movimiento de efectivo del periodo cae en una sección del estado, así que el residuo está en CÓMO se suman, no en qué se omitió.',
  // ==== end of I8.1 ====

  // ==== I8.2 · CLI leaves by key, root family (issue #264) ====

  'root.ingest.auto_post_ignored':
    'Aviso: el auto-posteo pedido por bandera o por mnemosine.config.json se IGNORA: el panel del despacho no lo autoriza.',
  'root.ingest.auto_post_turn_on':
    'Encender es del panel (`mnemosine pending`), y exige la evidencia de sombra. Apagar sí puede ser local.',
  'root.lang.unsupported': 'Idioma no admitido «{language}». Opciones: {options}, o {languages}',
  'root.setup.run_now': '¿Configurar ahora?',
  // ==== end of I8.2 ====

  // ==== I8.3 · CLI leaves by key, family ar (issue #265) ====

  'ar.receipt.invoice_missing':
    'Indica la factura o las facturas: --invoice "INV-2026-00042:2500" (repetible), o --invoice <ref> --amount <n>.',
  'ar.receipt.invoice_without_amount':
    'La factura «{spec}» no trae importe. Con varias facturas cada una lo lleva pegado («folio:importe»); con una sola puede ir en --amount.',
  'ar.receipt.idempotency_hit':
    '↩ Reintento idempotente: la llave «{key}» ya consumó este cobro ({number}). Nada se escribió otra vez; esto es el resultado grabado.',
  'ar.receipt.no_rep': 'sin REP — obligación fiscal propia con plazo del SAT',
  'ar.receipt.retry_reallocates':
    'un reintento vuelve a repartir el saldo a cuenta y postea otro asiento',
  'ar.receipt.retry_unapplies': 'un reintento vuelve a desaplicar y postea otro espejo',
  'ar.receipt.retry_reverses': 'un reintento vuelve a postear los espejos de la reversa',
  'ar.invoice.retry_reissues': 'un reintento vuelve a emitir y postea el ingreso otra vez',
  'ar.invoice.retry_void_mirror': 'un reintento vuelve a postear el espejo de la anulación',
  'ar.invoice.delete_by_state':
    'el borrado sólo es irrepetible por estado del borrador, no por llave',
  'ar.credit_note.retry_reissues': 'un reintento vuelve a emitir la nota y postea otro asiento',
  // ==== end of I8.3 ====

  // ==== I8.4 · CLI leaves by key, family payroll (issue #266) ====

  'payroll.accrue.period_required':
    'Falta --period. El devengo de prestaciones es de un mes concreto y no se adivina del reloj: correr «el periodo actual» un día 1 a las 00:05 devengaría el mes que acaba de empezar, y el asiento no se puede borrar después (mnemosine period list enumera los periodos de la entidad).',
  'payroll.accrue.skip_already_accrued': 'ya tiene renglón vigente de este mes',
  'payroll.accrue.skip_zero_month': 'su devengo del mes es cero',
  'payroll.accrue.summary':
    '{period} ({start}..{end}) · asiento con fecha {entryDate} · {accruing, plural, one {# trabajador devenga} other {# trabajadores devengan}}, {skipped, plural, one {# se omite} other {# se omiten}} · aguinaldo {aguinaldo} · vacaciones {vacation} · prima {premium} · total {total}',
  'payroll.accrue.criteria':
    'base {baseDefaulted, select, yes {{base} (defecto)} other {{base}}} · vacaciones {vacationDefaulted, select, yes {{vacation} (defecto)} other {{vacation}}} · aguinaldo {days, plural, one {# día} other {# días}} · prima {premium}',
  'payroll.accrue.default_criteria_warning':
    'Rige al menos un defecto declarado y no una elección del despacho: entre `nominal` e `integrado` hay un 20 % de diferencia en el importe de cada mes. Se contesta con `mnemosine pending define provision_base_salarial` / `devengo_vacaciones`.',
  'payroll.accrue.entry_heading':
    'El asiento único de la corrida, {lines, plural, one {# línea} other {# líneas}}:',
  'payroll.accrue.key_entry_reversed':
    'La llave «{key}» grabó el asiento {entry}, que después se reversó. Devolver ese resultado diría que el mes está devengado cuando no lo está. Vuelve a correr con una llave nueva —es otra corrida, no un reintento— o sin --idempotency-key.',
  'payroll.accrue.idempotency_hit':
    'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió a devengar.',
  'payroll.accrue.nothing_to_accrue':
    'Nada que devengar en {period}: el mayor no se tocó y no se escribió ningún renglón de cédula.',
  'payroll.accrue.dry_run':
    'Ensayo: el mayor no se tocó y no se escribió ningún renglón de cédula.',
  'payroll.accrue.confirm':
    '¿Devengar {amount} MXN de {count, plural, one {# trabajador} other {# trabajadores}} en {period}? El mayor no admite deshacer.',
  'payroll.accrue.aborted': 'Sin cambios: el mayor no se tocó.',
  'payroll.accrue.aborted_no_terminal':
    'Sin cambios: no hay terminal donde confirmar. Añade -y para devengar sin preguntar, o --dry-run para ver la cédula completa sin escribir nada.',
  'payroll.accrue.preview_count_mismatch':
    'La vista previa enseñaba {previewed, plural, one {# trabajador} other {# trabajadores}} y la corrida devengó {processed}. Algo cambió entre mirar y postear: revisa la cédula antes de dar el mes por cerrado.',
  'payroll.accrue.preview_total_mismatch':
    'La vista previa sumaba {previewed} y la corrida devengó {posted}.',
  'payroll.accrue.done':
    '{count, plural, one {# trabajador devengado} other {# trabajadores devengados}} en {period} {hasEntry, select, yes {por {total} · asiento {entry}} other {por {total}}}.',
  'payroll.isn_rate_set.state': 'estado',
  'payroll.isn_rate_set.rate': 'tasa',
  'payroll.isn_rate_set.regime': 'régimen',
  'payroll.isn_rate_set.monthly_exemption': 'exención mensual',
  'payroll.isn_rate_set.in_force': 'vigencia',
  'payroll.isn_rate_set.legal_basis': 'fundamento',
  'payroll.isn_rate_set.table': 'tabla',
  'payroll.isn_rate_set.criterion': 'criterio',
  'payroll.isn_rate_set.reaches': 'alcanza',
  'payroll.isn_rate_set.open_ended': '(sin cierre: sigue vigente)',
  'payroll.isn_rate_set.table_note': '(catálogo, sin tenant_id: la ley es la misma)',
  'payroll.isn.policy_default': '{value} (por omisión, nadie la contestó)',
  // ==== end of I8.4 ====

  // ==== I8.5 · CLI leaves by key, family assets-inventory (issue #267) ====

  'assets.depreciation.by_unknown':
    '--by «{value}» no existe. Las cuatro dimensiones son: {dimensions} (asset es el detalle activo por activo; class y account son el resumen por clase y por destino del gasto que pide el catálogo).',
  'assets.depreciation.period_required':
    'Falta --period. La depreciación es de un mes concreto y no se adivina del reloj: correr «el periodo actual» un día 1 a las 00:05 depreciaría el mes que acaba de empezar.',
  'assets.depreciation.no_class': '(sin clase)',
  'assets.depreciation.header':
    '{period} ({start}..{end}) · libro {book} · asientos con fecha {entryDate} · huella {fingerprint}',
  'assets.depreciation.criteria':
    'base {baseDefaulted, select, yes {{base} (defecto)} other {{base}}} · convención {conventionDefaulted, select, yes {{convention} (defecto)} other {{convention}}} · {entering, plural, one {# activo entra} other {# activos entran}}, {skipped, plural, one {# se omite} other {# se omiten}}, total {total}',
  'assets.depreciation.default_criteria_warning':
    'Rige al menos un defecto declarado y no una elección del despacho. Se contesta con `mnemosine pending define base_depreciacion` / `convencion_primer_mes`.',
  'assets.depreciation.skipped_heading': 'Omitidos ({count}):',
  'assets.depreciation.missing_rows_warning':
    '{pending, plural, one {# activo se queda} other {# activos se quedan}} sin renglón de {period} y el mes debería reconocerlo. La política `depreciacion_faltante_al_cierre` vale {defaulted, select, yes {«{policy}» (defecto declarado)} other {«{policy}»}}.',
  'assets.depreciation.run_blocked':
    '{pending, plural, one {# activo} other {# activos}} sin renglón de {period}. {cause, select, strict {--strict convierte el aviso en bloqueo.} other {La política `depreciacion_faltante_al_cierre` está en «bloquear».}} `depreciation post` se negará a contabilizar hasta que se resuelvan.',
  'assets.depreciation.nothing_this_book': 'Nada que contabilizar en este periodo con este libro.',
  'assets.depreciation.plan_changed':
    'El plan aprobado en {file} ya no corresponde a lo que la corrida haría hoy, así que no se contabiliza nada: {differences}. Vuelve a correr `depreciation run`, revisa el plan nuevo y contabiliza contra ése.',
  'assets.depreciation.post_blocked':
    'No se contabiliza: {pending, plural, one {# activo se queda} other {# activos se quedan}} sin renglón de {period} y la política `depreciacion_faltante_al_cierre` está en «bloquear». Resuélvelos (captura la producción del periodo, corrige la ficha) o cambia la política con {hint}.',
  'assets.depreciation.nothing_to_post': 'Nada que contabilizar en {period}: el mayor no se tocó.',
  'assets.depreciation.entries_note':
    '{count, plural, one {# póliza de dos líneas} other {# pólizas de dos líneas}}, una por activo, no una sola de la corrida. Reversar esta corrida {count, plural, one {es # reversa} other {son # reversas}}.',
  'assets.depreciation.confirm':
    '¿Contabilizar {total} en {count, plural, one {# póliza} other {# pólizas}} del libro {book} de {period}? El mayor no admite deshacer.',
  'assets.depreciation.idempotency_hit':
    'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió a contabilizar.',
  'assets.depreciation.plan_count_mismatch':
    'El plan enseñaba {planned, plural, one {# póliza} other {# pólizas}} y la corrida hizo {processed}. El plan y el motor no coincidieron: revisa los errores antes de dar el mes por cerrado.',
  'assets.depreciation.done':
    '{count, plural, one {# póliza contabilizada} other {# pólizas contabilizadas}} en {period} (libro {book}).',
  'assets.asset.amount_invalid':
    '{flag} debe ser un importe decimal sin signo; llegó «{value}». El punto separa los decimales y la coma se ignora: 1,250,000.50 y 1250000.50 son lo mismo.',
  'assets.asset.method_unknown': '{flag} «{value}» no existe. Los seis métodos son: {methods}.',
  'assets.asset.capitalized_unknown':
    '--capitalized «{value}» no se entiende: es yes cuando el costo YA está cargado a la cuenta de activo en el mayor (el CFDI que se capitalizó), y no cuando el alta sólo registra el bien y el asiento está pendiente. No tiene valor por omisión: suponerlo duplica el activo o lo deja fuera del mayor.',
  'assets.asset.create_missing':
    'Faltan {missing}. Un activo sin clase, sin costo, sin fecha de adquisición o sin decir dónde está ya su costo no es una ficha incompleta: es una ficha que no se puede depreciar ni cuadrar contra el mayor.',
  'assets.asset.source_entry_contradiction':
    '--source-entry nombra el asiento donde YA está el costo, así que no se puede pasar junto a `--capitalized no`, que afirma lo contrario. Decide cuál de las dos es cierta.',

  // ==== end of I8.5 ====

  // ==== I8.6 · CLI leaves by key, family platform (issue #268) ====

  'platform.backup.no_manifest': '(sin manifiesto)',
  'platform.backup.schema_of': 'esquema {schema}',
  'platform.backup.manifest_line': 'manifiesto: {file}',
  'platform.backup.create.not_scoped':
    '`backup create` vuelca la instalación ENTERA con pg_dump, que no filtra filas: acotarlo a un inquilino o a una entidad es imposible por construcción, y hasta hoy la bandera se aceptaba y se ignoraba en silencio.\nPara el archivo de UN despacho: `mnemosine backup export --tenant <id>` (con `--entity <id|nombre>` para una sola sociedad).\nPara la recuperación ante desastre de la instalación completa: `backup create` sin banderas.',
  'platform.backup.create.unredacted':
    'Contiene los datos SIN REDACTAR de {tenants, plural, one {# inquilino} other {# inquilinos}}: es la instalación entera, no un despacho.',
  'platform.backup.create.one_tenant_hint': 'Para el archivo de uno solo: `mnemosine backup export --tenant <id>`.',
  'platform.backup.create.no_crypto': 'Y NO incluye el material criptográfico:',
  'platform.backup.create.crypto_detail':
    'la llave del vault y ENCRYPTION_KEY viven fuera de la base. Sin ellas, al restaurar las credenciales fiscales y los datos bancarios quedan ilegibles. Respáldalas aparte.',
  'platform.backup.create.untested_hint':
    'Y un respaldo no probado no es un respaldo: `mnemosine backup verify <archivo> --restore`.',
  'platform.backup.export.tenant_required':
    'No hay inquilino que exportar. Nómbralo con `--tenant <uuid>` o fija MNEMOSINE_TENANT.\nUn archivo que no dice de quién es no se puede custodiar, así que esto no se adivina.',
  'platform.backup.export.entity_of': '{entity} (entidad de {tenant})',
  'platform.backup.export.size':
    '({mb} MB · {rows, plural, one {# fila} other {# filas}} · {tables, plural, one {# tabla} other {# tablas}})',
  'platform.backup.export.scope_line': 'alcance: {scope} — {owner}',
  'platform.backup.export.read_as': 'leído como {role}, sujeto a RLS, en una sola instantánea REPEATABLE READ',
  'platform.backup.export.not_a_backup': 'Esto es una EXPORTACIÓN, no un respaldo: no hay camino de vuelta probado.',
  'platform.backup.export.disaster_hint': 'Para recuperación ante desastre: `mnemosine backup create` + `backup restore`.',
  'platform.backup.export.out_of_scope':
    '{count, plural, one {# tabla acotada queda} other {# tablas acotadas quedan}} fuera de este alcance; el manifiesto las nombra una por una.',
  'platform.backup.export.unredacted':
    'Lleva datos sin redactar del despacho, RFC de terceros incluidos: trátalo como tal.',
  'platform.backup.list.no_status':
    '`backup list` no tiene estado que filtrar: un respaldo es un archivo, no un documento con ciclo.',
  'platform.backup.list.not_scoped':
    '`backup list` inventaría un DIRECTORIO, y todavía no filtra por alcance: la bandera se aceptaba y se ignoraba.\nLa columna «alcance» de la salida ya dice de quién es cada archivo — inquilino, entidad o instalación completa —, así que por ahora el filtro se hace leyéndola.',
  'platform.backup.list.scope_installation':
    'instalación ({tenants, plural, one {# inquilino} other {# inquilinos}})',
  'platform.backup.list.scope_installation_unknown': 'instalación (inquilinos desconocidos)',
  'platform.backup.list.intact_yes': 'sí',
  'platform.backup.list.never_verified': 'nunca',
  'platform.backup.list.verified_on': '{date} ({findings, plural, one {# hallazgo} other {# hallazgos}})',
  'platform.backup.list.export_not_verified': 'n/a (exportación, no restaurable)',
  'platform.backup.verify.not_found': 'No se encontró el respaldo {file}',
  'platform.backup.verify.hash_ok': 'hash y manifiesto cuadran',
  'platform.backup.verify.hash_mismatch': 'el hash NO cuadra con el manifiesto',
  'platform.backup.verify.not_proof': 'Esto NO prueba que el respaldo restaure.',
  'platform.backup.verify.repeat_with_restore': 'Un respaldo no probado no es un respaldo: repite con --restore.',
  'platform.backup.verify.restored': 'restauró en una base de usar y tirar',
  'platform.backup.verify.not_restored': 'NO restauró',
  'platform.backup.verify.counts':
    '{entities, plural, one {# entidad revisada} other {# entidades revisadas}} · {findings, plural, one {# hallazgo} other {# hallazgos}}',
  'platform.backup.restore.retry_restores': 'un reintento vuelve a restaurar sobre lo ya restaurado',
  'platform.backup.restore.would_restore': 'Restauraría {file} en una base NUEVA «{database}»',
  'platform.backup.restore.nothing_written': 'No se escribe nada, y ninguna base existente se toca jamás.',
  'platform.backup.restore.confirm': '¿Crear la base «{database}» y restaurar {file} en ella?',
  'platform.backup.restore.no_terminal':
    '{question} — no hay terminal donde preguntar. Vuelve a correrlo con --yes cuando estés seguro.',
  'platform.backup.restore.done': 'restaurado en la base {database}',
  'platform.backup.restore.previous_intact':
    'La base anterior sigue intacta: apuntar la aplicación a la nueva es un acto aparte.',
  'platform.backup.restore.check_first': 'Compruébala antes: mnemosine backup verify {file} --restore',


  'platform.audit.user_not_found':
    'Usuario «{email}» en este inquilino. El rastro no se filtró: un correo que no existe devolvería cero filas y se leería como que esa persona no hizo nada.',
  'platform.audit.list.limit_invalid': '--limit debe ser un entero positivo; llegó «{value}».',
  'platform.audit.list.action_unknown':
    'Acción desconocida «{action}». El vocabulario lo fija el CHECK de audit_log (migración 001): {actions}.',
  'platform.audit.list.actor_agent_unsupported':
    'El rastro no distingue todavía al agente: `audit_log` no tiene columna de actor y cada fila se atribuye a un `user_id` humano. Filtrar por «{actor}» devolvería cero filas, que se leería como que el agente no hizo nada. Falta la columna `actor` (y `agent_session_id`) y que el puente del agente la escriba; hasta entonces, `--actor human` o sin bandera es todo lo que hay.',
  'platform.audit.list.actor_invalid': '--actor sólo admite «human», «agent» o «agent:<session>»; llegó «{actor}».',
  'platform.audit.list.object_unknown':
    'Familia de objeto desconocida «{object}». Conocidas: {families}. Para un valor exacto de la columna usa --entity-type.',
  'platform.audit.list.object_type_disjoint':
    '--object «{object}» y --entity-type «{type}» no se cruzan: la familia no contiene ese tipo. Da una de las dos.',
  'platform.audit.list.user_removed': '(usuario dado de baja)',
  'platform.audit.list.no_rows':
    'Sin filas. El rastro es del INQUILINO: `audit_log` no tiene columna de entidad legal, así que --entity sólo eligió a qué inquilino mirar.',
  'platform.audit.show.when': 'cuándo',
  'platform.audit.show.who': 'quién',
  'platform.audit.show.why': 'por qué',
  'platform.audit.show.user_unknown': '(usuario desconocido: la bitácora es de sólo agregar y sobrevive al alta)',
  'platform.audit.show.no_reason': '(sin razón registrada)',
  'platform.audit.show.no_values': 'sin valores: la fila registra el acto, no el antes y el después',
  'platform.ai.stats.header':
    'ai stats · {entity} · {drafts, plural, one {# borrador} other {# borradores}}, {decided, plural, one {# decidido} other {# decididos}}',
  'platform.ai.stats.human_intervention':
    'intervención humana {rate} ({human} aprobados + {rejected} rechazados de {decided} decididos; {policy} por política, {auto} auto-posteados)',
  'platform.ai.stats.ingest':
    'ingesta: {runs, plural, one {# corrida} other {# corridas}}, {drafts, plural, one {# borrador} other {# borradores}}{priced, select, yes {, ~${perDraft} USD por borrador (total ${total})} other {, costo no estimable (modelo sin precio)}}',
  'platform.ai.stats.latency':
    'latencia del modelo: {average} ms promedio, {p95} ms p95 ({calls, plural, one {# llamada medida} other {# llamadas medidas}})',
  'platform.ai.stats.events':
    'eventos: {suspicions, plural, one {# sospecha de inyección} other {# sospechas de inyección}}, {nudges, plural, one {# nudge de grounding} other {# nudges de grounding}}, {failovers, plural, one {# failover} other {# failovers}}',
  'platform.ai.stats.shadow':
    'sombra: {verdicts, plural, one {# veredicto} other {# veredictos}} en {days, plural, one {# día} other {# días}}, {decided, plural, one {# decidido} other {# decididos}} por humano, acuerdo {agreement} (encender «on» exige ≥{minDays} días, ≥{minDecided} decididos y ≥{minAgreement})',
  'platform.jobs.run_due.retry_reruns': 'un reintento vuelve a ejecutar los trabajos vencidos',

  // MNE-001-453 (#646): qué trabajos vencidos corre `jobs run-due` con la credencial de su operador.
  'platform.jobs.run_due.all_first_line':
    'jobs.run_due vale "all": este tic corre con tu credencial todos los trabajos vencidos de la entidad, también los que crearon otras personas.',
  'platform.jobs.run_due.skipped': '  no adoptado, no corrió: {name}  {id} · adóptalo con: mnemosine jobs adopt {id}',
  'platform.jobs.run_due.no_adopted_due': 'Ningún trabajo adoptado está vencido.',
  'platform.jobs.run_due.hint.header':
    '{count, plural, one {Este tic corrió con tu credencial # trabajo que no has adoptado:} other {Este tic corrió con tu credencial # trabajos que no has adoptado:}}',
  'platform.jobs.run_due.hint.choose':
    'Pon jobs.run_due en ~/.mnemosine/config.json: "adopted" corre sólo los trabajos que adoptaste (mnemosine jobs adopt <id>), y "all" corre todos los vencidos sin este aviso.',
  'platform.jobs.run_due.project_key_ignored':
    '{file} define jobs.run_due, que ahí no se lee: con qué credencial corre un tic lo elige cada operador, en ~/.mnemosine/config.json.',
  'platform.jobs.run_due.adoptions_unreadable': '{error} Este tic corre todos los trabajos vencidos, como sin jobs.run_due.',
  'platform.jobs.adopt.done':
    'Trabajo "{name}" adoptado. Con jobs.run_due en "adopted", jobs run-due lo corre con tu credencial. Quedó en {file}.',
  'platform.jobs.adopt.already': 'El trabajo "{name}" ya estaba adoptado ({file}).',
  'platform.jobs.adopt.not_found': 'El trabajo {id} no existe en esta entidad; no se adoptó nada.',
  'platform.jobs.adopt.id_xor_list': 'Da el id de un trabajo para adoptarlo, o --list para ver los que adoptaste.',
  'platform.jobs.adopt.list.header': 'Trabajos que adoptaste en esta entidad ({file}):',
  'platform.jobs.adopt.list.none': 'No has adoptado ningún trabajo de esta entidad. Adopta uno con: mnemosine jobs adopt <id>',
  'platform.jobs.adopt.list.gone': '(ya no es un trabajo de esta entidad)',
  'platform.jobs.adopt.list.scope':
    'jobs.run_due en {file}: {scope, select, adopted {"adopted", así que jobs run-due corre sólo éstos} all {"all", así que jobs run-due corre todos los vencidos} other {sin definir, así que jobs run-due corre todos los vencidos y nombra los que no has adoptado}}',
  'platform.jobs.unadopt.done': 'El trabajo {id} ya no está adoptado ({file}).',
  'platform.jobs.unadopt.not_adopted': 'El trabajo {id} no estaba adoptado; no cambió nada.',
  'platform.jobs.create.adopted': '  Adoptado para ti: con jobs.run_due en "adopted", tu tic lo corre.',
  'platform.jobs.create.adopt_failed':
    'El trabajo se creó, pero no se pudo adoptar para ti ({error}). Adóptalo con: mnemosine jobs adopt {id}',
  'platform.jobs.list.none': 'No hay trabajos configurados. Crea uno con `mnemosine jobs create`.',
  'platform.jobs.list.column.name': 'NOMBRE',
  'platform.jobs.list.column.kind': 'TIPO',
  'platform.jobs.list.column.schedule': 'CALENDARIO',
  'platform.jobs.list.column.enabled': 'ACTIVO',
  'platform.jobs.list.column.fails': 'FALLOS',
  'platform.jobs.list.column.next_run': 'PRÓXIMA CORRIDA',
  'platform.jobs.list.enabled': '{enabled, select, yes {sí} other {no}}',
  'platform.jobs.history.none': 'Todavía no hay corridas registradas.',
  'platform.jobs.history.column.started': 'INICIO',
  'platform.jobs.history.column.job': 'TRABAJO',
  'platform.jobs.history.column.status': 'ESTADO',
  'platform.jobs.history.column.drafts': 'BORRADORES',
  'platform.jobs.history.column.detail': 'DETALLE',
  'platform.jobs.create.done': 'Trabajo creado: {id}',
  'platform.jobs.create.summary': '{name} ({kind}) · calendario {schedule} · próxima corrida {next}',
  'platform.jobs.create.wire_tick': 'Conecta el tic: programa `mnemosine jobs run-due` en cron/launchd.',
  'platform.jobs.enable.done': 'Trabajo "{name}" habilitado · próxima corrida {next}',
  'platform.jobs.disable.done': 'Trabajo "{name}" deshabilitado.',
  'platform.jobs.run_due.key_not_applied':
    '--idempotency-key no aplica al tic: cada trabajo vencido se reclama de forma atómica, y deduplicar tics saltaría en silencio corridas legítimas.',
  'platform.jobs.run_due.none': 'Ningún trabajo está vencido.',
  'platform.jobs.run_due.would_run': 'correría: {name}  {kind}  {next}',
  'platform.jobs.run_due.next_run': 'próxima corrida {date}',
  'platform.jobs.run_due.dry_run_summary':
    '(--dry-run: {count, plural, one {# trabajo vencido} other {# trabajos vencidos}}; no se reclamó ni corrió nada)',
  'platform.jobs.run_due.sandbox':
    'sandbox: los trabajos corren sin las lecturas externas (external_pull / external_diff_trial_balance). Un cron de conciliación necesita la superficie completa: programa `mnemosine jobs run-due --live`.',
  'platform.jobs.run_due.outcome_drafts': 'borradores: {count}',
  'platform.jobs.run_due.auto_disabled':
    'El trabajo "{name}" llegó a su límite de fallos y se deshabilitó solo. Vuelve a habilitarlo con: mnemosine jobs enable {id}',
  'platform.jobs.run_due.record_failed': 'La corrida de "{name}" no se pudo registrar en el historial: {error}',
  'platform.jobs.run_due.drafts_created':
    '{count, plural, one {# borrador creado: se revisa} other {# borradores creados: se revisan}} con `mnemosine review`.',
  'help.jobs.adopt.description':
    'Adopta un trabajo: con jobs.run_due en "adopted" en ~/.mnemosine/config.json, jobs run-due corre sólo los trabajos que adoptaste',
  'help.jobs.adopt.argument.job_id': 'Id del trabajo (se omite con --list)',
  'help.jobs.adopt.option.list': 'Lista los trabajos que adoptaste en esta entidad, y el valor de jobs.run_due',
  'help.jobs.unadopt.description': 'Deja de adoptar un trabajo: con jobs.run_due en "adopted", jobs run-due ya no lo corre',
  'help.jobs.unadopt.argument.job_id': 'Id del trabajo',

  // ==== end of I8.6 ====

  // ==== I8.7 · CLI leaves by key, family fiscal-mx (issue #269) ====

  'fiscal_mx.e_accounting.unsealed.headline': 'ESTE ARCHIVO NO VA SELLADO Y NO SE PRESENTÓ NADA ANTE EL SAT.',
  'fiscal_mx.e_accounting.unsealed.two_hands':
    'Construir el archivo y firmarlo son actos distintos y de manos distintas.',
  'fiscal_mx.e_accounting.unsealed.step_review':
    'Revisa el XML: es el documento que vas a declarar, y una vez sellado ya no se toca.',
  'fiscal_mx.e_accounting.unsealed.step_seal':
    'Séllalo con la e.firma del contribuyente: fuera de este sistema o, si el despacho declaró sellar_con_custodia, con la hoja seal de esta familia. Nadie te va a pedir la e.firma por chat.',
  'fiscal_mx.e_accounting.unsealed.step_upload':
    'Comprímelo y transmítelo tú por el Buzón Tributario (Contabilidad electrónica).',
  'fiscal_mx.e_accounting.unsealed.step_acknowledgements':
    'Guarda el acuse de recepción y, después, el de aceptación o rechazo: es la única prueba de que se presentó.',
  'fiscal_mx.e_accounting.catalog.period_missing':
    'El catálogo de cuentas se presenta por mes: indica --period YYYY-MM (por ejemplo --period 2026-02). Sin él no hay Mes ni Anio que declarar en la cabecera.',
  'fiscal_mx.e_accounting.catalog.period_not_month':
    '--period «{value}» no es un mes. El CtaCatalogo declara UN mes de UN ejercicio, así que aquí sólo vale la forma YYYY-MM (2026-02). Un trimestre, un ejercicio o un rango no tienen dónde ponerse en el archivo.',
  'fiscal_mx.e_accounting.catalog.month_out_of_range':
    '--period «{value}»: el mes ha de ir de 01 a 12. El 13 es de la balanza de cierre (`balance generate --closing`), no del catálogo de cuentas.',
  'fiscal_mx.e_accounting.catalog.summary':
    'RFC {rfc} · {accounts, plural, one {# cuenta} other {# cuentas}} · {bytes, plural, one {# byte} other {# bytes}}',
  'fiscal_mx.e_accounting.catalog.policies': 'niveles {levels} · sin agrupador {ungrouped} · sellado {sealing}',
  'fiscal_mx.e_accounting.catalog.omitted': '{count, plural, one {# cuenta fuera} other {# cuentas fuera}} del archivo',
  'fiscal_mx.e_accounting.catalog.not_deliverable':
    'No se generó ningún archivo entregable. {reason, select, ungrouped {{count, plural, one {# cuenta del alcance no tiene código agrupador} other {# cuentas del alcance no tienen código agrupador}} y la política `{policy}` está en \'{value}\'. {count, plural, one {Asígnalo} other {Asígnalos}}, o cambia la política con {hint}.} other {Resuelve los hallazgos bloqueantes de arriba y vuelve a generar.}}',
  'fiscal_mx.e_accounting.balance.type_unknown':
    '--type «{value}» no existe: N es la balanza normal y C la complementaria. La de cierre no es un tipo, es --closing (va con Mes 13).',
  'fiscal_mx.e_accounting.balance.check_unknown':
    '{count, plural, one {Verificación desconocida} other {Verificaciones desconocidas}}: {unknown}. Las disponibles son: {available}.',
  'fiscal_mx.e_accounting.balance.check_empty':
    '--check no nombró ninguna verificación. Las disponibles son: {available}.',
  'fiscal_mx.e_accounting.balance.title': 'Balanza {month}/{year}',
  'fiscal_mx.e_accounting.balance.header':
    'RFC {rfc} · {closing, select, yes {TipoEnvio {type} · cierre (Mes 13)} other {TipoEnvio {type}}} · {period} {from} → {to} · {accounts, plural, one {# cuenta} other {# cuentas}}',
  'fiscal_mx.e_accounting.balance.header_policies':
    'niveles {levels} · sellado {sealing} · SaldoIni del {origin}, {firm, select, yes {firme} other {TODAVÍA PUEDE CAMBIAR (el periodo anterior sigue abierto)}}',
  'fiscal_mx.e_accounting.balance.suggested_file':
    'archivo sugerido {file} · {bytes, plural, one {# byte} other {# bytes}}',
  'fiscal_mx.e_accounting.balance.seal_hint': 'Revísalo y séllalo con {command}.',
  'fiscal_mx.e_accounting.balance.check_envelope':
    '{rfc} · balanza {month}/{year} · {period} · {accounts, plural, one {# cuenta} other {# cuentas}} · verificaciones: {checks}',
  'fiscal_mx.e_accounting.balance.check_catalog': 'catálogo de cotejo: {found, select, yes {{source}} other {ninguno}}',
  'fiscal_mx.e_accounting.balance.checks_run': 'verificaciones: {checks}',
  'fiscal_mx.e_accounting.balance.check_clean':
    'sin hallazgos: la balanza pasa {count, plural, one {la # verificación pedida} other {las # verificaciones pedidas}}.',
  'fiscal_mx.e_accounting.balance.check_summary':
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}}, {warning, plural, one {# aviso} other {# avisos}}. Un bloqueante impide generar el archivo.',
  'fiscal_mx.e_accounting.output.overwrite_question':
    '{target} ya existe. Si ese archivo ya está sellado, sobrescribirlo lo deja sin sello. ¿Lo reemplazo?',
  'fiscal_mx.e_accounting.output.kept':
    'No se escribió nada: {target} se conserva tal cual. Usa otra ruta, o --yes si de verdad quieres reemplazarlo.',

  'fiscal_mx.diot.unfiled.headline': 'ESTA DIOT NO SE PRESENTÓ Y ESTE ARCHIVO NO ES LA DECLARACIÓN.',
  'fiscal_mx.diot.unfiled.two_hands':
    'Armar la declaración y presentarla son actos distintos y de manos distintas.',
  'fiscal_mx.diot.unfiled.step_tie_out':
    'Coteja el papel de trabajo contra el movimiento del mes de la cuenta de IVA acreditable: si no cuadra al centavo, no captures — «casi cuadra» es un requerimiento dentro de un año.',
  'fiscal_mx.diot.unfiled.step_capture':
    'Captura o carga la declaración TÚ en el portal del SAT. Este binario no entra al portal, no carga la e.firma y no presenta nada.',
  'fiscal_mx.diot.unfiled.step_acknowledgement':
    'Guarda el acuse con su número de operación: es la única prueba de que se presentó.',
  'fiscal_mx.diot.unfiled.step_record':
    'Registra el acuse en el expediente del mes. Ese registro TODAVÍA NO tiene comando (`diot record` no está construido).',
  'fiscal_mx.diot.period.missing':
    'La DIOT se declara por mes: indica --period YYYY-MM (por ejemplo --period 2026-02). Sin él no hay periodo que declarar.',
  'fiscal_mx.diot.period.not_month':
    '--period «{value}» no es un mes. La DIOT es mensual (LIVA art. 32 fr. VIII), así que aquí sólo vale la forma YYYY-MM (2026-02). Un trimestre o un ejercicio no se declaran.',
  'fiscal_mx.diot.period.month_out_of_range':
    '--period «{value}»: el mes ha de ir de 01 a 12. El mes 13 es de la balanza de cierre del Anexo 24 (`e-accounting balance generate --closing`); una declaración informativa no tiene mes 13.',
  'fiscal_mx.diot.check.paid_event':
    'el suceso que la DIOT declara existe en el mayor y no libera más IVA del que hay aparcado',
  'fiscal_mx.diot.check.rate_breakdown':
    'cada gasto se reparte por tasa (16/8/0/exento) y la suma reproduce el IVA de la cabecera',
  'fiscal_mx.diot.check.exempt_base':
    'los actos exentos declaran su base, que es lo que la DIOT informa aunque no haya impuesto',
  'fiscal_mx.diot.check.third_party_identified':
    'cada tercero llega con RFC usable, o con identificación fiscal, país y nacionalidad si es extranjero',
  'fiscal_mx.diot.check.operation_type':
    'cada tercero trae un tipo de operación capturado que el catálogo 2025 admite para su tipo de tercero, no supuesto',
  'fiscal_mx.diot.check.creditable_iva_proportion':
    'todo el IVA se declara como vinculado exclusivamente a actividades gravadas sólo si el mayor no tiene ingresos exentos en el ejercicio',
  'fiscal_mx.diot.check.catalog_policy': 'las políticas de la DIOT valen algo que su propio catálogo admite',
  'fiscal_mx.diot.check.envelope':
    '{rfc} · DIOT {month}/{year} · {parties, plural, one {# tercero} other {# terceros}} · IVA acreditable pagado {amount} · verificaciones: {checks}',
  'fiscal_mx.diot.check.clean':
    'sin hallazgos: la DIOT pasa {count, plural, one {la # verificación pedida} other {las # verificaciones pedidas}}.',
  'fiscal_mx.diot.check.summary':
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}}, {warning, plural, one {# aviso} other {# avisos}}. Un bloqueante impide capturar la declaración.',
  'fiscal_mx.diot.header.summary':
    'RFC {rfc} — {name} · {from} → {to} · {parties, plural, one {# tercero} other {# terceros}} · {documents, plural, one {# documento} other {# documentos}}',
  'fiscal_mx.diot.header.basis': 'base: operaciones PAGADAS (LIVA art. 5 frac. III), no devengadas',
  'fiscal_mx.diot.header.by_default': '(omisión)',
  'fiscal_mx.diot.totals.rate_8': '8 % (frontera)',
  'fiscal_mx.diot.totals.exempt': 'exento',
  'fiscal_mx.diot.totals.other': 'otras ({label})',
  'fiscal_mx.diot.totals.creditable_paid': 'IVA acreditable pagado en el mes',
  'fiscal_mx.diot.totals.withheld': 'IVA retenido a terceros',
  'fiscal_mx.diot.totals.tie_out':
    'Cotéjalo contra el movimiento del mes de la cuenta de IVA acreditable: si no cuadra al centavo, no captures.',
  'fiscal_mx.diot.generate.not_capturable':
    '{count, plural, one {# hallazgo impide} other {# hallazgos impiden}} capturar esta DIOT tal cual. {count, plural, one {Arréglalo} other {Arréglalos}} y vuelve a armarla; `diot check --check` lista las verificaciones por nombre para atacarlas de una en una.',
  'fiscal_mx.diot.export.layout_unknown':
    '--layout «{value}» no existe. Los layouts son: {layouts} (working-paper es la conciliación por tercero que se coteja antes de capturar; sat es el archivo de lote de la autoridad).',
  'fiscal_mx.diot.export.meanwhile':
    '{message}\n\nMientras tanto: `{command}` produce la conciliación por tercero para capturar en el portal.',
  'fiscal_mx.diot.export.working_paper':
    'Layout «{layout}»: esto es un PAPEL DE TRABAJO. No se sube al portal del SAT.',
  'fiscal_mx.diot.export.written':
    'layout {layout} · {bytes, plural, one {# byte} other {# bytes}} · destino {target}',
  'fiscal_mx.diot.export.written_not_capturable':
    'El archivo se escribió, pero {count, plural, one {# hallazgo impide} other {# hallazgos impiden}} capturar la declaración tal cual.',
  'fiscal_mx.diot.export.exists':
    '{target} ya existe y no se sobrescribe sin pedirlo: usa otra ruta, o --yes. Un papel de trabajo revisado y anotado a mano no se reemplaza en silencio.',

  'fiscal_mx.cfdi.show.lines': '{count, plural, one {# concepto:} other {# conceptos:}}',
  'fiscal_mx.cfdi.status.not_in_mirror': 'CFDI {uuid} no está en el espejo de esta entidad.',
  'fiscal_mx.cfdi.status.never_checked': 'Nunca consultado: corre con --refresh para preguntarle al SAT ahora.',
  'fiscal_mx.cfdi.sync.pending':
    '{count, plural, one {# CFDI} other {# CFDI}} por consultar al SAT{mode, select, dry_run { (dry-run: nada se consultó)} other {. Corre con --live para {count, plural, one {consultarlo} other {consultarlos}} de verdad.}}',
  'fiscal_mx.cfdi.sync.done':
    '{checked, plural, one {# consultado} other {# consultados}}: {valid, plural, one {# vigente} other {# vigentes}}, {cancelled, plural, one {# cancelado} other {# cancelados}}, {not_found, plural, one {# no encontrado} other {# no encontrados}}, {errors, plural, one {# error} other {# errores}}',
  'fiscal_mx.cfdi.sync.cancelled_warning':
    '{count, plural, one {# CFDI cancelado} other {# CFDI cancelados}} por el emisor: revisa su efecto contable con cfdi list --json',
  'fiscal_mx.cfdi.explain.header': '{uuid} · tipo {type} · {direction} · caso {case} · {status}',
  'fiscal_mx.cfdi.explain.entry': 'asiento {entry}',
  'fiscal_mx.cfdi.explain.no_decisions':
    'Sin decisiones pendientes: el caso se resolvió solo con las políticas del panel.',
  'fiscal_mx.rep.missing.issued':
    '{count, plural, one {# cobro} other {# cobros}} sin REP emitido: obligación fiscal propia con plazo del SAT.',
  'fiscal_mx.rep.missing.received':
    '{count, plural, one {# pago} other {# pagos}} sin REP del proveedor: falta el comprobante que respalda el acreditamiento del IVA de {count, plural, one {ese pago} other {esos pagos}}.',
  'fiscal_mx.rep.missing.unknown_method':
    '{count, plural, one {# con método de pago desconocido (el CFDI no está en el espejo): el mayor lo trató como {method}; se lista} other {# con método de pago desconocido (el CFDI no está en el espejo): el mayor los trató como {method}; se listan}} con la duda dicha — un PUE no exige REP.',
  'fiscal_mx.rep.missing.min_amount_unreadable': '--min-amount ilegible: "{value}".',
  'fiscal_mx.rep.reconcile.would_retry':
    '{count, plural, one {# REP aparcado se reintentaría} other {# REP aparcados se reintentarían}} (dry-run: nada se tocó).',
  'fiscal_mx.rep.reconcile.done':
    '{retried, plural, one {# reintentado} other {# reintentados}}: {linked, plural, one {# ligado} other {# ligados}}, {parked, plural, one {# sigue aparcado} other {# siguen aparcados}}, {errors, plural, one {# error} other {# errores}}',

  'fiscal_mx.sat.cred.file_missing': 'El archivo {label} no existe: {file}',
  'fiscal_mx.sat.cred.file_exposed':
    'AVISO: otros usuarios del sistema pueden leer {file} (modo {mode}). Considera: chmod 600 {file}',
  'fiscal_mx.sat.cred.key_unneeded_note': '--idempotency-key no aplica aquí: {reason}.',
  'fiscal_mx.sat.cred.add.key_unneeded':
    'la custodia la guardan el consentimiento tecleado y el estado de la credencial',
  'fiscal_mx.sat.cred.add.certificate_read': 'Certificado leído',
  'fiscal_mx.sat.cred.add.certificate':
    '  tipo: {type}\n  RFC: {rfc}\n  serie: {serial}\n  vigencia: {from} → {to}\n  entidad destino: {entity} ({taxId})',
  'fiscal_mx.sat.cred.add.csd': 'Es un CSD (sello digital), no una e.firma. La descarga masiva del SAT lo rechaza.',
  'fiscal_mx.sat.cred.add.rfc_mismatch':
    'El RFC del certificado ({rfc}) no coincide con la entidad "{entity}" ({taxId}).',
  'fiscal_mx.sat.cred.add.pick_entity': 'Usa --entity para elegir la entidad correcta.',
  'fiscal_mx.sat.cred.add.expired': 'El certificado venció el {date}. Renuévalo en el SAT.',
  'fiscal_mx.sat.cred.add.dry_run':
    '(dry-run: certificado válido para esta entidad. La corrida real pide la contraseña de la llave, verifica el par y guarda el material en la bóveda. No se guardó nada.)',
  'fiscal_mx.sat.cred.add.validation_passed': 'Validación aprobada.',
  'fiscal_mx.sat.cred.add.live_needed':
    'Guardar la e.firma en la bóveda es el efecto externo real y hay que pedirlo: vuelve a correr con --live para que se te pida la contraseña y se complete el depósito.',
  'fiscal_mx.sat.cred.add.password_prompt': 'Contraseña de la llave privada (no se muestra)',
  'fiscal_mx.sat.cred.add.bad_pair': 'La llave no corresponde al certificado, o la contraseña es incorrecta.',
  'fiscal_mx.sat.cred.add.pair_verified': 'Par de llaves verificado localmente.',
  'fiscal_mx.sat.cred.add.consent_prompt':
    '¿Autorizas guardar esta e.firma? escribe "accept" para continuar (--yes no se salta esto)',
  'fiscal_mx.sat.cred.add.cancelled': 'Cancelado. No se guardó nada.',
  'fiscal_mx.sat.cred.add.registered': 'e.firma registrada para {entity}',
  'fiscal_mx.sat.cred.add.custody': 'custodia: {backend}',
  'fiscal_mx.sat.cred.add.unattended':
    'uso desatendido: {unattended, select, yes {permitido} other {prohibido}} · límite: {limit}/24h',
  'fiscal_mx.sat.cred.add.audit_hint': 'auditoría: {command}',
  'fiscal_mx.sat.cred.status.none': 'No hay credenciales registradas. Agrega una con: {command}',
  'fiscal_mx.sat.cred.status.expired': '(vencida)',
  'fiscal_mx.sat.cred.status.expires_soon':
    '(vence en {days, plural, one {# día} other {# días}} — renuévala en el SAT)',
  'fiscal_mx.sat.cred.status.expires_in': '(vence en {days, plural, one {# día} other {# días}})',
  'fiscal_mx.sat.cred.status.custody': 'serie {serial} · custodia {backend}',
  'fiscal_mx.sat.cred.status.usage':
    'desatendido: {unattended, select, yes {sí} other {no}} · límite {limit}/24h · último uso: {last}',
  'fiscal_mx.sat.cred.status.never_used': 'nunca',
  'fiscal_mx.sat.cred.status.vault': 'Bóveda: {health, select, ok {OK} other {ERROR}} — {detail}',
  'fiscal_mx.sat.cred.audit.none': 'No hay accesos registrados.',
  'fiscal_mx.sat.cred.audit.title': 'Accesos a la credencial de {entity}',
  'fiscal_mx.sat.cred.audit.mode': '{mode, select, unattended {desatendido} other {con operador}}',
  'fiscal_mx.sat.cred.revoke.key_unneeded': 'una segunda revocación se rechaza porque ya no queda credencial activa',
  'fiscal_mx.sat.cred.revoke.nothing_active':
    'No hay credencial activa que revocar; la corrida real también se negaría.',
  'fiscal_mx.sat.cred.revoke.would_revoke': 'Revocaría',
  'fiscal_mx.sat.cred.revoke.would':
    '{verb} la {type} de {entity} (serie {serial}) y destruiría criptográficamente su material en la bóveda {custody}',
  'fiscal_mx.sat.cred.revoke.custody': '(custodia: {backend})',
  'fiscal_mx.sat.cred.revoke.dry_run': '(dry-run: no se revocó ni se destruyó nada)',
  'fiscal_mx.sat.cred.revoke.about_to': 'Estás por borrar de la custodia la e.firma de {entity}.',
  'fiscal_mx.sat.cred.revoke.irreversible': 'El borrado es criptográfico e irreversible; habrá que volver a cargarla.',
  'fiscal_mx.sat.cred.revoke.confirm_prompt': 'Escribe el RFC de la entidad para confirmar',
  'fiscal_mx.sat.cred.revoke.cancelled': 'Cancelado.',
  'fiscal_mx.sat.cred.revoke.done': 'Credencial revocada y material borrado de la bóveda.',
  'fiscal_mx.sat.download.check.key_unneeded':
    'preguntar otra vez el estado no hace daño y registra el estado más reciente',
  'fiscal_mx.sat.download.package.key_unneeded':
    'un paquete ya archivado no se vuelve a descargar, y cada CFDI se deduplica por su UUID',
  'fiscal_mx.cfdi.sync.retry_reconsults': 'un reintento vuelve a consultar al SAT y reescribe el caché',
  'fiscal_mx.cfdi.post.key_unneeded':
    'un CFDI da una sola factura: una repetición encuentra su prerregistro cerrado, o una factura con su UUID, y se rechaza',

  // ==== end of I8.7 ====

  // ==== I8.8 · CLI leaves by key, family ap (issue #270) ====
  'ap.prepaid.flag.date_invalid': '{flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "{value}".',
  'ap.prepaid.flag.amount_invalid':
    '{flag} debe ser un importe decimal sin signo; llegó "{value}". El punto separa los decimales y la coma se ignora: 1,250,000.50 y 1250000.50 son lo mismo.',
  'ap.prepaid.run.period_missing':
    'Falta --period. La amortización es de un mes concreto y no se adivina del reloj: correr «el periodo actual» un día 1 a las 00:05 devengaría el mes que acaba de empezar.',
  'ap.prepaid.create.origin_missing':
    'Falta --origin. Los tres orígenes son: {origins} — el CFDI que se clasificó como anticipado (exige --source-entry), el saldo que ya estaba en la 1160 sin calendario, y el pago que se contabilizó a mano. No tiene valor por omisión: suponerlo deja el rastro apuntando a un asiento que no es.',
  'ap.prepaid.create.origin_unknown': '--origin "{value}" no existe. Los tres son: {origins}.',
  'ap.prepaid.create.convention_unknown':
    '--convention "{value}" no existe: las dos convenciones son {days} y {months} (los días que cada mes cubre, o el mes entero).',
  'ap.prepaid.create.convention_contradicts_panel':
    '--convention {requested} contradice al panel: `amortizacion_anticipados_convencion` vale "{panel}"{source, select, answered {} other { (defecto declarado, nadie ha contestado)}}, y es lo que se congela en el calendario. Esta bandera declara con qué convención crees estar dando de alta, no la elige: se cambia con {hint}.',
  'ap.prepaid.create.flags_missing':
    '{count, plural, one {Falta {flags}} other {Faltan {flags}}}. Un calendario sin importe, sin ventana de cobertura o sin decir de dónde salió el cargo no es una ficha incompleta: es una ficha que no se puede devengar ni cuadrar contra la cuenta.',
  'ap.prepaid.create.cfdi_needs_source_entry':
    '`--origin cfdi` exige `--source-entry <id>`: si el calendario nace de una factura ya contabilizada, el asiento que cargó la cuenta se conoce, y no anotarlo es perderlo para siempre.',
  'ap.prepaid.skip.unknown_convention': 'convención guardada desconocida ("{convention}")',
  'ap.prepaid.skip.not_started': 'la cobertura todavía no empieza',
  'ap.prepaid.skip.ended': 'la cobertura ya terminó',
  'ap.prepaid.skip.zero_row': 'el renglón del mes es cero',
  'ap.prepaid.skip.nothing_left': 'no queda saldo por devengar',
  'ap.prepaid.gap.warning':
    '{amount} {currency} posteados en la cuenta de pagos anticipados que ningún calendario va a devengar, en {count, plural, one {# asiento} other {# asientos}}. Ese gasto no llegará nunca al resultado. Cada asiento se adopta con `mnemosine prepaid create --origin saldo_preexistente --source-entry <id> --start <fecha> --end <fecha>`, con la ventana de cobertura que diga el documento — no se adivina: vive en la póliza, no en el CFDI.',
  'ap.prepaid.criteria.header':
    'convención {convention}{convention_source, select, answered {} other { (defecto)}} · umbral {threshold} {currency}{threshold_source, select, answered {} other { (defecto)}}',
  'ap.prepaid.criteria.default_rules':
    'Rige al menos un defecto declarado y no una elección del despacho. Se contesta con `mnemosine pending define amortizacion_anticipados_convencion` / `umbral_anticipado_mxn`.',
  'ap.prepaid.create.below_threshold':
    '{amount} queda por debajo del umbral de {threshold} {currency} (`umbral_anticipado_mxn`): el alta real se detendría por materialidad (NIF A-4). Con --force y --reason se da de alta igual y el motivo queda escrito en la fila.',
  'ap.prepaid.create.dry_run_done':
    'Ensayo: no se escribió ninguna fila. {count, plural, one {# renglón} other {# renglones}} por {amount} {currency}, convención {convention}.',
  'ap.prepaid.create.dry_run_no_backing':
    'El ensayo NO comprueba el respaldo en la cuenta —cuánto saldo posteado queda sin calendario—: esa guarda vive dentro del alta y necesita el mayor. El alta real puede rechazar por ese motivo.',
  'ap.prepaid.create.done':
    'Calendario de {count, plural, one {# renglón} other {# renglones}} dado de alta. El mayor no se tocó: el cargo ya estaba. Se devenga con `mnemosine prepaid run --period <mes>`.',
  'ap.prepaid.list.none_alive': 'No hay ningún calendario vivo en esta entidad.',
  'ap.prepaid.list.none_on_date': 'Ningún calendario cubre el {date}. Con -a se listan todos.',
  'ap.prepaid.show.unknown_convention':
    'El calendario "{description}" guarda la convención "{convention}", que no es ninguna de las declaradas ({conventions}). Ningún importe se puede calcular con ella.',
  'ap.prepaid.show.summary':
    '{description} · {total} {currency} · {convention} · origen {origin} · devengado {accrued}, queda {remaining}',
  'ap.prepaid.show.rows_are_schedule':
    'Los renglones son el calendario que la corrida seguirá, no lo ya posteado: lo posteado es el devengado de la línea anterior.',
  'ap.prepaid.show.not_found':
    'No hay ningún calendario vivo que case con "{ref}" en esta entidad. `mnemosine prepaid list -a` los enumera todos.',
  'ap.prepaid.show.ambiguous':
    '"{ref}" casa con {count} calendarios vivos: {candidates}. Nombra el id, o un trozo de descripción que sólo case con uno.',
  'ap.prepaid.run.header':
    '{period} ({from}..{to}) · asientos con fecha {date} · {entering, plural, one {# calendario entra} other {# calendarios entran}}, {skipped} se omiten, {already} ya tienen renglón de este mes · total {total}',
  'ap.prepaid.run.nothing': 'Nada que devengar en {period}: el mayor no se tocó.',
  'ap.prepaid.run.skipped_line': 'omitido {description}: {reason}',
  'ap.prepaid.run.capped':
    '{description}: el renglón teórico es {theoretical} y se topa en {amount} contra lo que queda por devengar.',
  'ap.prepaid.run.entries_note':
    '{count, plural, one {# asiento de ajuste de dos líneas} other {# asientos de ajuste de dos líneas}}, uno por calendario — no uno de la corrida. Reversar esta corrida {count, plural, one {es # reversa} other {son # reversas}}.',
  'ap.prepaid.run.dry_run_done': 'Ensayo: el mayor no se tocó y no se escribió ningún renglón.',
  'ap.prepaid.run.confirm':
    '¿Devengar {total} {currency} en {count, plural, one {# asiento} other {# asientos}} de {period}? El mayor no admite deshacer.',
  'ap.prepaid.run.aborted': 'Sin cambios: el mayor no se tocó.',
  'ap.prepaid.run.aborted_no_tty':
    'Sin cambios: no hay terminal donde confirmar. Añade -y para devengar sin preguntar, o --dry-run para ver los asientos completos sin escribir nada.',
  'ap.prepaid.run.count_mismatch':
    'La vista previa enseñaba {previewed, plural, one {# asiento} other {# asientos}} y la corrida hizo {processed}. La previa y el motor no coincidieron: revisa los errores antes de dar el mes por cerrado.',
  'ap.prepaid.run.total_mismatch': 'La vista previa sumaba {previewed} y la corrida devengó {accrued}.',
  'ap.prepaid.run.done':
    '{count, plural, one {# asiento de devengo contabilizado} other {# asientos de devengo contabilizados}} en {period} por {total}.',

  // MNE-001-228 part 1: ap reconcile, vendor and payment. Part 2 (bill) appends below.
  'ap.reconcile.date_invalid': '{flag} debe ser una fecha real en formato YYYY-MM-DD; llegó "{value}".',
  'ap.reconcile.title': 'Conciliación de CxP',
  'ap.reconcile.header': '· control {code} {name} · al {date}',
  'ap.reconcile.row.subledger': 'Subdiario (facturas abiertas)',
  'ap.reconcile.row.foreign': 'de lo cual {currency} {foreign}',
  'ap.reconcile.row.fx_revaluation': 'de lo cual revaluación cambiaria',
  'ap.reconcile.row.ledger': 'Cuenta de control (mayor)',
  'ap.reconcile.row.difference': 'Diferencia',
  'ap.reconcile.row.explained': 'Explicado por partidas',
  'ap.reconcile.row.unexplained': 'Sin explicar',
  'ap.reconcile.balanced': 'Cuadra.',
  'ap.reconcile.unbalanced':
    'Diferencia {difference} — {owner, select, none {{explained} nombrados, {unexplained} sin dueño.} other {cada peso de ella está nombrado abajo.}}',
  'ap.reconcile.items_title': 'Partidas conciliatorias',
  'ap.reconcile.items_note':
    'importe = lo que esta partida suma a (subdiario − mayor); las nombradas suman Explicado, y con la fila del residuo, Diferencia.',
  'ap.reconcile.items_rounding':
    'Los importes se redondean por partida; la columna puede diferir de Explicado por centavos.',
  'ap.reconcile.why_title': 'Por qué está cada partida',
  'ap.reconcile.no_manual_entries': 'Tampoco hay asientos manuales en la cuenta de control.',
  'ap.reconcile.capped':
    '{count, plural, one {# partida más existe y no se enumeró} other {# partidas más existen y no se enumeraron}}: el listado tiene tope por sonda. Los totales (explicado, sin explicar) sí las incluyen.',
  'ap.vendor.show.include_unknown':
    'No se puede incluir "{part}". Este comando puede incluir: {parts}. "compliance" necesita las tablas vendor_tax_profiles y vendor_compliance_checks, y "bank" la ruta de descifrado auditada — ninguna existe todavía.',
  'ap.vendor.show.disappeared': 'El proveedor {ref} desapareció mientras se leía.',
  'ap.vendor.create.no_default_tax_id_type':
    'Esta entidad está constituida en "{country}", que no tiene un tipo de identificador fiscal por omisión. Di cuál con --tax-id-type {types}.',
  'ap.vendor.create.tax_id_type_unknown': '--tax-id-type "{value}" no existe. Usa uno de: {types}.',
  'ap.vendor.create.tax_id_type_alone': 'Llegó --tax-id-type sin --tax-id.',
  'ap.vendor.create.terms_not_understood':
    'Las condiciones de pago "{terms}" no se entendieron, así que nunca podría calcularse un vencimiento con ellas. Usa "Net 30", "2/10 Net 30" o "Due on receipt".',
  'ap.vendor.create.tax_id_accepted': 'Identificador fiscal {taxId} aceptado bajo: {rule}.',
  'ap.vendor.create.no_tax_id':
    'No hay identificador fiscal registrado. Un CFDI recibido no podrá casarse con este proveedor y no podrá aparecer en una DIOT ni en un 1099.',
  'ap.vendor.edit.nothing_to_change':
    'Nada que cambiar. Pasa --name, --contact, --email, --phone o --notes. Las condiciones de pago son `vendor terms set`; los datos bancarios no se editan desde aquí.',
  'ap.vendor.edit.done': '{number} actualizado ({fields})',
  'ap.vendor.terms.nothing_to_set': 'Nada que fijar. Pasa --terms, --currency, o los dos.',
  'ap.vendor.terms.read_as':
    'Leído como: {net, select, none {sin plazo neto} other {vence {days, plural, one {# día} other {# días}} después de la fecha de la factura}}{discount, select, none {} other {, {pct}% de descuento si se paga dentro de {discountDays, plural, one {# día} other {# días}}}}.',
  'ap.payment.confirm.no_terminal':
    '{question} — no hay terminal donde preguntar. Vuelve a correrlo con --yes cuando estés seguro, o con --dry-run para ver antes el efecto.',
  'ap.payment.dry_run': 'Ensayo: no se escribió nada.',
  'ap.payment.bank_account': 'Cuenta bancaria: {name}',
  'ap.payment.entry': 'asiento {entry}',
  'ap.payment.create.not_payable':
    'La factura {bill} está en "{status}". {reason, select, paid {Ya está liquidada.} unapproved {Apruébala primero: el pasivo tiene que estar en el mayor antes de poder pagarse.} other {Sólo se pagan facturas {payable}.}}',
  'ap.payment.create.confirm':
    '¿Registrar el pago de {amount} {currency} a {bill} ({before} → {after}){bank, select, none {} other { desde {bankName}}} en {entity}? Esto contabiliza en el mayor.',
  'ap.payment.create.idempotency_hit':
    '↩ Idempotency hit: la llave "{key}" ya consumó este acto ({number}). Nada se escribió otra vez; esto es el resultado grabado.',
  'ap.payment.create.idempotency_race':
    '↩ Idempotency hit: la llave "{key}" ya consumó este pago ({number}). Nada se escribió otra vez; esto es el resultado grabado.',
  'ap.payment.create.would_record': 'Registraría {before} → {after} en {bill}',
  'ap.payment.apply.bill_missing':
    'Indica a qué gasto se aplica: --bill <ref> --amount <importe>. Repítelos para repartir entre varios.',
  'ap.payment.apply.pairs_mismatch':
    'Hay {bills} --bill y {amounts} --amount: van emparejados por posición, así que tienen que ser tantos como aquéllos.',
  'ap.payment.apply.discounts_excess': 'Hay {discounts} --discount para {bills} --bill: sobra alguno.',
  'ap.payment.apply.mode_invalid': '--mode admite "partial" o "residual"; llegó "{mode}".',
  'ap.payment.apply.retry_reapplies': 'un reintento vuelve a repartir el pago y postea otro asiento',
  'ap.payment.apply.not_applicable': 'La factura {bill} está en "{status}"; sólo se aplican pagos a facturas {payable}.',
  'ap.payment.apply.confirm':
    '¿Aplicar {count, plural, one {# documento} other {# documentos}} de {payment} en {entity}{writeOff, select, none {} other {, CONDONANDO {amount}, que dejará de deberse}}? Esto contabiliza en el mayor.',
  'ap.payment.apply.would': 'Aplicaría {payment}',
  'ap.payment.apply.on_account': 'a cuenta {before} → {after}',
  'ap.payment.apply.discount_outside_terms': 'Descuento tomado fuera de las condiciones en {bills}',
  'ap.payment.apply.discount_outside_terms_why': 'es una deducción negociada, no un pronto pago pactado.',
  'ap.payment.apply.written_off': '{amount} dejó de deberse (pago corto)',
  'ap.payment.apply.write_off_default':
    'Esa cuenta es el DEFECTO declarado, nadie la ha decidido todavía: `mnemosine pending --verbose` la muestra y `mnemosine pending define pago_corto_residual` la decide.',
  'ap.payment.apply.iva_not_credited':
    '{amount} de IVA salió de la {account} SIN acreditarse: era el impuesto de la parte que no se pagó, y bajo flujo de efectivo no se acredita lo no pagado.',
  'ap.payment.unapply.confirm':
    '¿Desaplicar {amount} de {payment} en {bill} el {date} ({before} → {after})? El efectivo vuelve a quedar a cuenta.',
  'ap.payment.unapply.idempotency_hit': '↩ Idempotency hit: la llave "{key}" ya desaplicó esto; nada se escribió otra vez.',
  'ap.payment.unapply.result': '{mode, select, dry_run {Desaplicaría {payment}} other {{payment} desaplicado}} de {bill}',
  'ap.payment.unapply.detail': '{before} → {after} · a cuenta {onAccount}',
  'ap.payment.reverse.confirm':
    '¿Reversar {payment} el {date}? {entries, plural, one {# asiento del mayor recibe su espejo} other {# asientos del mayor reciben su espejo}} y {bills, plural, one {# factura se vuelve a deber} other {# facturas se vuelven a deber}}.',
  'ap.payment.reverse.idempotency_hit': '↩ Idempotency hit: la llave "{key}" ya reversó esto; nada se escribió otra vez.',
  'ap.payment.reverse.result': '{mode, select, dry_run {Reversaría {payment}} other {{payment} reversado}}',
  'ap.payment.reverse.detail': 'el {date} · {entries}',
  // MNE-001-614: bill (the last ap leaf).
  'ap.bill.date_invalid': '{flag} debe ser una fecha AAAA-MM-DD; llegó "{value}".',
  'ap.bill.line_number_invalid': '--line debe ser un número de línea; llegó "{line}".',
  'ap.bill.dry_run': 'Ensayo: no se escribió nada.',
  'ap.bill.list.as_of_unsupported':
    '--as-of pregunta qué estaba abierto en una fecha, que es una pregunta de antigüedad que este comando no puede contestar (necesita la historia de pagos cruzada por factura). Usa --until para la fecha del documento.',
  'ap.bill.list.date_basis_invalid':
    '--date-basis {basis} no está definido para una factura: una factura tiene fecha de documento y, una vez aprobada, fecha de contabilización. Usa document o posting.',
  'ap.bill.show.disappeared': 'La factura {ref} desapareció mientras se leía.',
  'ap.bill.show.lines_title': 'Líneas',
  'ap.bill.show.journal_title': 'Póliza',
  'ap.bill.show.no_cfdi': 'Ninguno: esta factura no se capturó desde un XML.',
  'ap.bill.create.vendor_missing': '¿Qué proveedor? Pásalo como argumento o con --vendor.',
  'ap.bill.create.lines_missing': 'Una factura necesita al menos una línea: --line "account=5100;qty=1;price=1000;tax-amount=160".',
  'ap.bill.create.line_without_account': 'Cada línea necesita account=<código>: una línea sin cuenta no se puede contabilizar.',
  'ap.bill.create.line_without_price': 'La línea "account={account}" no trae price=<importe>.',
  'ap.bill.create.no_due_date':
    'No hay fecha de vencimiento, y "{terms}" no implica ninguna. Pasa --due-date, o fija con `vendor terms set` unas condiciones de las que se pueda calcular.',
  'ap.bill.create.legacy_tax_key':
    'tax= es el MONTO del IVA de la línea, no la tasa; usa tax-amount= para que quede explícito. tax= deja de aceptarse en la versión {version}.',
  'ap.bill.create.done': '· {subtotal} + {tax} IVA = {total} {currency} · vence {due}',
  'ap.bill.create.draft_note': 'Estado draft: nada está en el mayor hasta `bill approve`.',
  'ap.bill.create.file_unreadable': 'No se puede leer --from-file "{path}".',
  'ap.bill.create.file_not_json': '--from-file "{path}" no es JSON válido: {message}',
  'ap.bill.create.file_not_object': '--from-file "{path}" debe contener un objeto JSON con un arreglo "lines".',
  'ap.bill.line.set.done': '{bill} línea {line} recodificada',
  'ap.bill.approve.not_approvable':
    'La factura {bill} está en "{status}", no en {approvable}. {reason, select, posted {Ya está en el mayor; reversarla es `bill reverse`, que todavía no tiene backend.} other {Sólo se aprueba una factura que todavía se está trabajando.}}',
  'ap.bill.approve.statuses': '{list} o {last}',
  'ap.bill.approve.confirm': '¿Contabilizar {bill} ({total} {currency}) en el mayor de {entity}? Esto no se deshace.',
  'ap.bill.approve.no_terminal':
    'Esto contabiliza en el mayor y no hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, o con --dry-run para ver el asiento.',
  'ap.bill.approve.done':
    '{bill} aprobada{posted, select, entry { · asiento {entry} contabilizado el {date}} other { · sin asiento: ya estaba contabilizada}}',
  'ap.bill.approve.key_not_needed':
    'No hacía falta --idempotency-key: la aprobación ya es idempotente por el estado de la factura y su journal_entry_id.',
  'ap.bill.approve.no_entry': '{bill} no produce asiento (ya estaba contabilizada, o su total es cero).',
  'ap.bill.approve.entry_title': 'Asiento {entry} · {date}',
  'ap.bill.approve.period_closed':
    '{bill} no se puede contabilizar: {message}. Su fecha cae en un periodo cerrado o bloqueado. Reabre el periodo, o contabilízala en uno abierto cuando exista `bill edit` para mover la fecha.',
  'ap.bill.approve.missing_role': '{bill} no se puede contabilizar: {message}',
  'ap.bill.inbox.id_invalid': '"{id}" no es el id de un pre-registro (uuid). Sácalo de `bill inbox list`.',
  'ap.bill.inbox.value_unknown': '{flag} "{value}" no existe. Los valores posibles son: {values}.',
  'ap.bill.inbox.unnamed_issuer': 'emisor sin nombre',
  'ap.bill.inbox.no_rfc': 'sin RFC',
  'ap.bill.inbox.list.new_vendors':
    '{count} de {total} traen un proveedor que NO está en el catálogo (marcados «{mark}»).',
  'ap.bill.inbox.list.new_vendors_note':
    '  Contabilizarlos daría de alta la contraparte con el nombre y el RFC del XML.\n  `bill inbox run` los rechaza salvo que lleve --allow-new-vendor; la otra salida\n  es darlos de alta a mano con `vendor create`.',
  'ap.bill.inbox.edit.cost_center_needs_line': '--cost-center codifica una línea: pasa también --line <n>.',
  'ap.bill.inbox.edit.cost_center_invalid': '--cost-center debe ser el id de un centro de costo (uuid); llegó "{value}".',
  'ap.bill.inbox.edit.nothing_to_code': 'Nada que codificar: pasa --account, o --line con --account o --cost-center.',
  'ap.bill.inbox.edit.done': '{ref} {target, select, default {cuenta por omisión fijada} other {línea {line} codificada}}',
  'ap.bill.inbox.edit.uncoded':
    '· {count, plural, one {# línea sigue sin cuenta} other {# líneas siguen sin cuenta}}',
  'ap.bill.inbox.edit.post_with': 'Contabilízalo con `mnemosine bill inbox run {id}`.',
  'ap.bill.inbox.run.reason_missing': '--action reject descarta un documento: exige --reason "<por qué>".',
  'ap.bill.inbox.run.batch_missing': '--action set-batch necesita --batch <id o número de lote>.',
  'ap.bill.inbox.run.action_unknown': '--action "{value}" no existe. Usa una de: {actions}.',
  'ap.bill.inbox.run.id_and_bulk': 'Pasa un id, o --bulk con --query. Los dos a la vez no significan nada.',
  'ap.bill.inbox.run.nothing_selected': '¿Sobre qué? Pasa el id de un pre-registro, o --bulk con --query "status=ready".',
  'ap.bill.inbox.run.bulk_without_query':
    '--bulk sin --query actuaría sobre TODA la bandeja. Nombra la selección: --query "status=ready,mode=manual" (claves: {keys}).',
  'ap.bill.inbox.run.query_unparsable':
    'No se entiende --query "{spec}". Cada parte es clave=valor separada por comas: --query "status=ready,mode=manual". Claves: {keys}.',
  'ap.bill.inbox.run.query_keys_unknown':
    '{count, plural, one {Clave} other {Claves}} que --query no conoce: {unknown}. Claves: {keys}.',
  'ap.bill.inbox.run.requires_approval_invalid': 'requires-approval sólo admite true o false; llegó "{value}".',
  'ap.bill.inbox.run.query_narrows_nothing': '--query "{spec}" no acota nada. Nombra al menos un criterio.',
  'ap.bill.inbox.run.batch_not_found': 'No hay un lote de proceso "{ref}" en esta entidad.',
  'ap.bill.inbox.run.not_in_inbox': 'El pre-registro {id} no está en la bandeja de {entity}.',
  'ap.bill.inbox.run.over_cap':
    'La selección pasa de {cap} pre-registros. Un lote más grande que eso no es una orden que alguien haya revisado: acota con --query (status, mode, since, until, vendor).',
  'ap.bill.inbox.run.query_selects_none': 'La consulta "{query}" no selecciona ningún pre-registro. Nada que hacer.',
  'ap.bill.inbox.run.waiting':
    '  {count, plural, one {Hay # pre-registro} other {Hay # pre-registros}} esperando una decisión humana, que esta consulta no alcanza.',
  'ap.bill.inbox.run.waiting_note':
    '  Se ven con `bill inbox list --status draft`, y ahí están los que se pararon\n  por traer proveedor nuevo: repítelos con --query "status=draft".',
  'ap.bill.inbox.run.summary':
    '{action}: {count, plural, one {# pre-registro} other {# pre-registros}}{totals}',
  'ap.bill.inbox.run.already_posted':
    '  {count, plural, one {# ya está contabilizado y se saltará.} other {# ya están contabilizados y se saltarán.}}',
  'ap.bill.inbox.run.new_vendors':
    '  {count, plural, one {# crearía un PROVEEDOR NUEVO} other {# crearían un PROVEEDOR NUEVO}}: {vendors}',
  'ap.bill.inbox.run.new_vendor_allowed':
    '  --allow-new-vendor está puesto: se darán de alta con el nombre y el RFC del XML.',
  'ap.bill.inbox.run.new_vendor_refused':
    '  Sin --allow-new-vendor se rechazan uno a uno, con el motivo, y el resto sigue.',
  'ap.bill.inbox.run.confirm':
    '{kind, select, process {¿Contabilizar {count, plural, one {# pre-registro} other {# pre-registros}} en los libros de {entity}? Cada uno nace como factura POSTEADA con su póliza. Esto no se deshace.} other {¿Aplicar "{action}" a {count, plural, one {# pre-registro} other {# pre-registros}} de {entity}?}}',
  'ap.bill.inbox.run.no_terminal':
    'No hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, o con --dry-run para ver lo que haría.',
  'ap.bill.inbox.run.idempotency_hit':
    '↩ Idempotency hit: la llave "{key}" ya completó este acto — {ok}/{total} {action}\n  No se ejecutó nada otra vez; éste es el resultado registrado.',
  'ap.bill.inbox.run.done': '{action}: {ok} de {total}',
  'ap.bill.inbox.run.skipped': ' · {count} ya {count, plural, one {estaba} other {estaban}}',
  'ap.bill.inbox.run.failed': ' · {count} sin hacer',
  'ap.bill.inbox.run.detail.already_posted': 'ya estaba contabilizado',
  'ap.bill.inbox.run.detail.bill': 'factura {bill}',
  'ap.bill.inbox.run.detail.entry': 'póliza {entry}',
  'ap.bill.inbox.run.detail.payment': 'pago {payment}',
  'ap.bill.inbox.run.detail.posted': 'contabilizado',
  'ap.bill.inbox.run.detail.approved': 'aprobado',
  'ap.bill.inbox.run.detail.rejected': 'rechazado',
  'ap.bill.inbox.run.detail.scheduled': 'programado en el lote {batch}',
  'ap.bill.inbox.run.vanished': 'desapareció de la bandeja mientras se procesaba',
  'ap.bill.inbox.run.not_a_bill':
    'es un pre-registro de tipo "{type}", no una factura de proveedor ni su nota de crédito. `bill inbox run` sólo contabiliza gastos y las notas que los bajan; un complemento de pago emitido registraría COBROS DE CLIENTES, que no es lo que este comando dice hacer.',
  'ap.bill.inbox.run.type_unknown': 'desconocido',
  'ap.bill.inbox.run.needs_approval':
    'requiere aprobación previa y está en "{state}". Apruébalo primero: `bill inbox run <id> --action approve`.',
  'ap.bill.inbox.run.not_pending': 'no estaba pendiente de aprobación (o no requiere aprobación, o ya se rechazó)',
  'ap.bill.inbox.run.not_rejectable':
    'ya está contabilizado o ya estaba rechazado: lo contabilizado no se rechaza, se reversa',
  'ap.bill.inbox.run.not_schedulable': 'está completado o rechazado: ya no se programa',

  // ==== end of I8.8 ====

  // ==== I8.9 · CLI leaves by key, family ledger (issue #271) ====
  // MNE-001-229: batch.
  'ledger.batch.title': 'LOTE {id}',
  'ledger.batch.receipt_title': 'lote {id}',
  'ledger.batch.row': 'fila {row}',
  'ledger.batch.idempotency_hit':
    '↩ Idempotency hit: la llave "{key}" ya consumó este acto — {what}. Nada se ejecutó otra vez; esto es el resultado grabado.',
  'ledger.batch.status.one_at_a_time':
    'Un estado a la vez: el flujo del lote es corto (staged → checked → posted) y un filtro múltiple no responde ninguna pregunta que dos corridas no respondan mejor.',
  'ledger.batch.status.unknown':
    '--status "{value}" no existe en el flujo del lote. Los estados reales (045): {statuses}. El vocabulario pending|running|completed|failed|cancelled no corresponde a esta tabla.',
  'ledger.batch.check.categories_unknown':
    '--check no reconoce: {unknown}. Las categorías cerradas son {categories}. La batería completa corre siempre; el filtro sólo acota el informe.',
  'ledger.batch.list.flag_unsupported':
    '{flag} no aplica a los lotes: un lote se filtra por cuándo se preparó, con --since (created_at >= fecha). No hay rango superior ni base de fecha que elegir.',
  'ledger.batch.list.offset_unsupported':
    '--offset no está implementado en esta familia: la consulta ordena por created_at y acota con --limit, sin cursor estable. Acota con --since o sube --limit.',
  'ledger.batch.list.capped':
    '{count, plural, one {Se listó # lote} other {Se listaron # lotes}}, que es el tope de --limit: puede haber más. Sube --limit o acota con --since.',
  'ledger.batch.show.file_label': 'archivo',
  'ledger.batch.show.rows_label': 'filas',
  'ledger.batch.show.prepared_label': 'preparado',
  'ledger.batch.show.unnamed': '(sin nombre)',
  'ledger.batch.show.rows':
    '{total} total · {invalid, plural, one {# inválida} other {# inválidas}} · {posted, plural, one {# póliza} other {# pólizas}} en el mayor',
  'ledger.batch.show.prepared': '{date} por {user}',
  'ledger.batch.show.rows_title': 'FILAS',
  'ledger.batch.show.empty': 'el lote está vacío',
  'ledger.batch.show.no_parse_errors': 'ninguna fila con error de parseo',
  'ledger.batch.show.errors_by_category': 'errores de parseo por categoría:',
  'ledger.batch.check.rows_checked': '· {count, plural, one {# fila verificada} other {# filas verificadas}}',
  'ledger.batch.check.strict': ' · estricto',
  'ledger.batch.check.narrowed': ' · informe acotado a {categories}',
  'ledger.batch.check.nothing_to_show': 'ningún hallazgo que enseñar',
  'ledger.batch.check.all_valid':
    "{count, plural, one {# fila válida} other {# filas válidas}}: el lote queda '{status}'.",
  'ledger.batch.check.some_invalid':
    "{invalid, plural, one {# inválida} other {# inválidas}} y {valid, plural, one {# válida} other {# válidas}}: el lote se queda '{status}'. Corrige el archivo y reimporta, o aplica lo válido con `batch post --partial`.",
  'ledger.batch.check.hidden_blocking':
    '{count, plural, one {# hallazgo bloqueante quedó} other {# hallazgos bloqueantes quedaron}} fuera del informe por --check; el código de salida los cuenta igual.',
  'ledger.batch.post.preview': '· {count, plural, one {# póliza} other {# pólizas}} · Debe {total}{already}',
  'ledger.batch.post.already': ' · {count, plural, one {# ya estaba} other {# ya estaban}}',
  'ledger.batch.post.left_staged':
    '{count, plural, one {# fila queda en staging:} other {# filas quedan en staging:}}',
  'ledger.batch.post.confirm':
    'Vas a CONTABILIZAR {count, plural, one {# póliza} other {# pólizas}} del lote {id} por {total} (Debe){left}. El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?',
  'ledger.batch.post.confirm_left': ', dejando {count, plural, one {# fila} other {# filas}} en staging',
  'ledger.batch.post.recorded': '{count, plural, one {# póliza} other {# pólizas}} del lote {id}',
  'ledger.batch.post.receipt':
    "→ '{status}' · {posted, plural, one {# contabilizada} other {# contabilizadas}} · {already, plural, one {# ya estaba} other {# ya estaban}} · {staged} en staging · Debe {total}",
  'ledger.batch.post.dry_run':
    'Ensayo: se contabilizó de verdad y se deshizo; los folios mostrados no quedaron reservados.',
  'ledger.batch.reverse.preview': '· {count, plural, one {# espejo} other {# espejos}}{dated}',
  'ledger.batch.reverse.dated': ' con fecha {date}',
  'ledger.batch.reverse.confirm':
    'Vas a REVERSAR el lote {id}: {count, plural, one {# espejo posteado} other {# espejos posteados}}, uno por póliza, en una sola transacción. Cada póliza admite UNA reversa (041). ¿Continuar?',
  'ledger.batch.reverse.recorded': '{count, plural, one {# espejo} other {# espejos}} del lote {id}',
  'ledger.batch.reverse.receipt':
    "· {count, plural, one {# espejo} other {# espejos}} · el lote sigue '{status}': la verdad de la reversa vive en reversed_by_entry_id de cada póliza",
  'ledger.batch.reverse.dry_run': 'Ensayo: los espejos se crearon de verdad y se deshicieron; nada quedó escrito.',
  // MNE-001-229: account.
  'ledger.account.dry_run_note': ' (dry-run: nada se escribió)',
  'ledger.account.type_unknown': '--type "{value}" no existe. Usa uno de: {types}.',
  'ledger.account.normal_balance_unknown': '--normal-balance "{value}" no existe. Usa debit o credit.',
  'ledger.account.show.disappeared': 'La cuenta {code} desapareció mientras se leía.',
  'ledger.account.edit.nothing_to_change': 'Nada que cambiar. Pasa --name, --description, --subtype o --fs-category.',
  'ledger.account.edit.done': '{code} actualizada.',
  'ledger.account.archive.would_archive': '{code} se archivaría. Saldo de por vida: {balance}.',
  'ledger.account.archive.would_keep_history': ' Tiene historia posteada, que quedaría intacta.',
  'ledger.account.archive.done': '{code} archivada. Motivo: {reason}',
  'ledger.account.archive.forced': ' (con saldo vivo {balance}, forzado)',
  'ledger.account.archive.history_intact': ' La historia posteada queda intacta.',
  'ledger.account.set.would_set': '{code} fijaría: {flags}',
  'ledger.account.set.pair_unreadable': 'Par ilegible "{pair}": se espera clave=valor.',
  'ledger.account.set.key_unknown': 'Clave desconocida "{key}". Válidas: {keys}.',
  'ledger.account.set.value_unreadable': 'Valor ilegible "{value}" para {key}: usa true o false.',
  'ledger.account.balance.open_period_note':
    'Nota: beginning_balance solo se siembra en el cierre duro; en periodos abiertos lee la actividad, no el acumulado.',
  'ledger.account.role.set.would_point': 'El rol {role}{qualifier} apuntaría a {code} {name}',
  'ledger.account.role.seed.done':
    '{roles, plural, one {# rol mapeado} other {# roles mapeados}}, {accounts, plural, one {# cuenta base creada} other {# cuentas base creadas}}',
  'ledger.account.role.seed.unmapped': ' — sin mapear: {roles}',
  'ledger.account.role.sync.not_mexican': 'Esta entidad no lleva libros mexicanos: no tiene roles de retención.',
  'ledger.account.role.sync.nothing': 'Nada que cambiar.',
  'ledger.account.role.sync.done': 'aplicado y auditado; no se contabilizó ninguna póliza.',
  'ledger.account.map.year_invalid': '--year tiene que ser un ejercicio de cuatro dígitos; llegó "{value}".',
  'ledger.account.map.set.dry_run':
    '{code}: {scheme} {clear, select, yes {se limpiaría} other {sería {value}{name}}} (dry-run)',
  'ledger.account.map.import.no_pairs': 'El archivo {file} no trae pares código,valor legibles.',
  'ledger.account.map.import.done':
    '{applied}/{total} mapeos {mode, select, dry_run {aplicables} other {aplicados}} ({scheme})',
  'ledger.account.map.import.repeated': ' [repetido: resultado de la primera corrida]',
  'ledger.account.map.import.no_account': '  · {code}: no existe en el catálogo',
  'ledger.account.map.import.empty_value': '  · {code}: valor vacío, omitido',
  'ledger.account.map.check.available': 'Verificaciones disponibles: {checks}',
  'ledger.account.map.check.unknown': 'Verificación desconocida: {unknown}. Disponibles: {checks}.',
  'ledger.account.map.check.level_retired':
    '--level ya no aplica: la compuerta medía por nivel de cuenta y ése era el defecto (43 huecos sobre una entidad real, 42 de ellos cuentas sin un solo movimiento, y la cuenta movida sin agrupador fuera de la lista por estar en nivel 3). Hoy la población la fija la política agrupador_alcance_de_la_compuerta; se cambia con {hint}.',
  'ledger.account.map.check.scope':
    'alcance "{scope}", {chosen, select, panel {elegido en el panel} other {por omisión}}',
  'ledger.account.map.check.empty': '0 cuentas en el {scope}: no se comprobó nada',
  'ledger.account.map.check.complete':
    '✔ cobertura completa: {count, plural, one {# cuenta} other {# cuentas}} con {scheme} ({scope})',
  'ledger.account.map.check.gaps':
    '{gaps} de {count, plural, one {# cuenta} other {# cuentas}} sin {scheme} ({scope}): el XML de catálogo saldría incompleto',
  'ledger.account.restore.done': '{code} vuelve a estar activa.',
  // MNE-001-230: fx.
  'ledger.fx.list.status_unsupported':
    '--status no aplica aquí: un tipo de cambio publicado no tiene estado de ciclo de vida. Filtra con --pair, --source, --rate-type, --since o --until.',
  'ledger.fx.list.policy':
    'La política fuente_tipo_cambio de este despacho es "{value}"{source, select, none {, que este lector no mapea a ninguna fuente.} other { → source \'{source}\' (columna policy: ✓).}}',
  'ledger.fx.list.no_entity': 'Sin entidad activa resoluble: no se pudo señalar la fuente que la política del despacho usa.',
  'ledger.fx.show.not_found':
    'No hay tipo {from}/{to} ({type}) resoluble para {date}: ni directo, ni inverso, ni cruzado por USD. Captúralo con fx rate set.',
  'ledger.fx.show.derived': ', derivado del inverso o cruzado',
  'ledger.fx.show.inverse': 'inverso {pair} = {rate}',
  'ledger.fx.show.inverse_derived': ' (derivado)',
  'ledger.fx.show.carried':
    '⚠ arrastrado de {date}: no hay tipo del día pedido. Si necesitas el del día, captúralo con fx rate set.',
  'ledger.fx.set.source_required':
    '--source es obligatoria: di quién publicó el tipo ({sources}). DOF y FIX del mismo día son números distintos y conviven desde la migración 057.',
  'ledger.fx.set.would_set': 'Fijaría {pair} {date} = {rate}',
  'ledger.fx.set.until': ', hasta {date}',
  'ledger.fx.set.done': 'fijado como {rate}',
  'ledger.fx.publisher.dof':
    'Diario Oficial de la Federación (el fiscal del art. 20 CFF; para una operación rige el publicado el día hábil anterior)',
  'ledger.fx.publisher.banxico_fix': 'Banxico FIX vía SIE (requiere token del API SIE)',
  'ledger.fx.publisher.fed': 'Reserva Federal, H.10',
  'ledger.fx.publisher.ecb': 'Banco Central Europeo, tipos de referencia',
  'ledger.fx.download.retry_calls_again': 'un reintento vuelve a llamar al proveedor de tipos de cambio',
  'ledger.fx.download.source_required': '--source es obligatoria: {sources}.',
  'ledger.fx.download.source_unknown': '--source "{value}" desconocida. Usa una de: {sources}.',
  'ledger.fx.download.range_twice': '--as-of y --since/--until son dos maneras de decir el rango; usa una.',
  'ledger.fx.download.no_connector':
    'No existe todavía el conector de descarga: este proyecto no habla HTTP con terceros sin una credencial gobernada, y {why, select, sie {el SIE de Banxico exige un token que ningún almacén de credenciales del sistema gobierna aún} other {no hay cliente declarado para esa fuente}}. Fabricar el tipo sería el mismo pecado que el cerrojo antisimulación de los PAC impide. Hoy los caminos honestos son: fx rate set <par> <fecha> <tasa> --source {source} con el valor publicado, o fx rate import (fase 2) desde un archivo.',
  'ledger.fx.download.would_download': 'Descargaría de {publisher}',
  'ledger.fx.download.dates': 'fechas: {range}',
  'ledger.fx.download.today': '(hoy)',
  'ledger.fx.download.target':
    "destino: exchange_rates con source='{source}' (la 057 deja convivir DOF y FIX del mismo día)",
  'ledger.fx.download.will_fail': '⚠ ejecutar fallará: {reason}',
  // MNE-001-230: ledger.
  'ledger.ledger.check.passes': '✔ el mayor pasa {checks}',
  'ledger.ledger.check.blocking_checks': 'las verificaciones bloqueantes',
  'ledger.ledger.check.findings':
    '{blocking, plural, one {# hallazgo bloqueante} other {# hallazgos bloqueantes}}, {warning, plural, one {# advertencia} other {# advertencias}}',
  'ledger.ledger.stale_draft.days_unreadable': '--days ilegible: "{value}".',
  'ledger.ledger.stale_draft.found':
    '{count, plural, one {# borrador} other {# borradores}} con más de {days, plural, one {# día} other {# días}}. Se aplican con entry post, o se retiran.',
  'ledger.ledger.auxiliary.heading': '{code} {name} · {period} ({status}) · inicial {beginning}{unreliable}',
  'ledger.ledger.auxiliary.no_carry': "sin arrastre: {period} está '{status}'",
  'ledger.ledger.auxiliary.no_previous': 'sin periodo anterior: no hay acumulado que arrastrar',
  'ledger.ledger.auxiliary.totals': 'cargos {debits} · abonos {credits} · final {ending}',
  'ledger.ledger.auxiliary.drift': ' (calculado {computed}: hay deriva — corre ledger check)',
  'ledger.ledger.balance.dim_unavailable':
    '--dim aún no está disponible: las dimensiones no tienen maestro todavía (familia dimension).',
  // MNE-001-230: entry, its Spanish strings.
  'ledger.entry.preview.heading': '{number} ({status}) · {period} · delta por cuenta si se aplicara:',
  'ledger.entry.preview.no_period': 'sin periodo',
  'ledger.entry.edit.done': '{number} editada (sigue en borrador; se aplica con entry post).',
  'ledger.entry.export.done':
    '{count, plural, one {# línea exportada} other {# líneas exportadas}}. XLSX aún no: usa --format csv y ábrelo en la hoja de cálculo.',
  'ledger.entry.import.dry_run':
    '{valid, plural, one {# póliza legible} other {# pólizas legibles}}, {invalid} con error (dry-run: nada se preparó)',
  'ledger.entry.import.done':
    'lote {id}: {valid, plural, one {# póliza preparada} other {# pólizas preparadas}}, {invalid} con error',
  'ledger.entry.import.repeated': ' [repetido: lote de la primera corrida]',
  'ledger.entry.import.not_in_ledger':
    'El lote NO tocó el mayor: se valida y aplica con la familia batch (check/post); mientras, es inspeccionable por batch_id.',
  // MNE-001-230: period and year.
  'ledger.period.active_entity': '→ {entity} (entidad activa; nombra otra con --entity)',
  'ledger.period.remedy.close_again': 'Vuelve a cerrarlo con: {close}',
  'ledger.period.remedy.seal': '  y luego séllalo, que rehace su arrastre: {close} --hard',
  'ledger.period.status_unknown': '--status "{value}" desconocido. Usa uno de: {statuses}.',
  'ledger.period.year_invalid': '--year "{value}" no es un año de cuatro dígitos.',
  'ledger.period.show.overdue': ' · vencido',
  'ledger.period.show.position': 'periodo {number} del ejercicio {year} · {type}',
  'ledger.period.show.soft_closed': 'cierre suave el {date}',
  'ledger.period.show.by': ' por {email}',
  'ledger.period.show.hard_closed': 'cierre duro el {date}',
  'ledger.period.show.entries': 'Pólizas',
  'ledger.period.show.entries_total': '({count} en total)',
  'ledger.period.show.none': 'ninguna',
  'ledger.period.show.checklist': 'Lista de verificación guardada al cerrar',
  'ledger.period.open.would_open': 'Abriría {period}',
  'ledger.period.open.done': '{period} está abierto',
  'ledger.period.reopen.locked':
    "{period} está 'locked': su información ya salió del sistema y no se reabre — ni con --force. La corrección va en el periodo abierto más próximo.",
  'ledger.period.reopen.not_closed': "{period} está '{status}': reabrir es sólo para periodos cerrados.",
  'ledger.period.reopen.hard_close':
    '{period} está en hard_close: sus asientos de cierre y el arrastre de saldos quedan en pie al reabrir (el mayor no se toca). Si de verdad quieres reabrirlo, repite con --force --reason "<por qué>".',
  'ledger.period.reopen.would_reopen': 'Reabriría {period}',
  'ledger.period.reopen.dry_run':
    '(dry-run: nada se escribió; la reapertura quedaría en el rastro de auditoría)',
  'ledger.period.reopen.question': '¿Reabrir {period} ({status} → open)?',
  'ledger.period.reopen.cancelled': 'Cancelado.',
  'ledger.period.reopen.idempotency_hit':
    '↩ Idempotency hit: la llave "{key}" ya reabrió {period} (estaba {previous}). Nada se ejecutó otra vez.',
  'ledger.period.reopen.done': '{period} está abierto otra vez',
  'ledger.period.reopen.done_detail': '(estaba {previous}, por {email}; motivo registrado)',
  'ledger.period.reopen.stale':
    'Los estados financieros o declaraciones derivados de este periodo quedaron desactualizados: regéneralos después de volver a cerrarlo.',
  'ledger.period.year.status_unknown': "--status \"{value}\" desconocido. Un ejercicio está 'open' o 'closed'.",
  'ledger.period.year.one_status': "Un ejercicio está 'open' o 'closed': pasa un --status, o ninguno.",
  'ledger.period.year.not_a_year': '"{value}" no es un año de cuatro dígitos.',
  'ledger.period.year.title': 'Ejercicio {year}',
  'ledger.period.year.calendar': ' · año calendario',
  'ledger.period.year.exists':
    'El ejercicio {year} ya existe para {entity} con {count, plural, one {# periodo} other {# periodos}}. No se crearía nada.',
  'ledger.period.year.would_create': 'Crearía el ejercicio {year}',
  'ledger.period.year.would_create_detail':
    'con 12 periodos mensuales (año calendario) y el periodo de ajuste de fin de ejercicio (13); los meses ya pasados y el corriente abiertos, el resto future',
  'ledger.period.year.created': 'Ejercicio {year} creado',
  'ledger.period.year.created_detail': 'con 12 periodos mensuales y el periodo de ajuste de fin de ejercicio (13)',
  'ledger.period.year.carried':
    '  Saldos iniciales arrastrados desde {period}: {count, plural, one {# cuenta} other {# cuentas}}',
  'ledger.period.year.open_hint': '  Abre un mes futuro con: mnemosine period open <nombre>',
  // ==== end of I8.9 ====
  // ==== W1 · the browser board (issue #117) ========================
  // Same keys, same order as en.ts. The Spanish is what the board shows by
  // default (src/gateway/app/messages.ts falls back to es).
  'web.app.title': 'Tablero del despacho',
  'web.app.skip_to_content': 'Saltar al contenido',
  'web.app.not_found': 'Esa pantalla no existe.',
  'web.session.sign_in': 'Iniciar sesión',
  'web.session.sign_out': 'Cerrar sesión',
  'web.session.sign_out_failed': 'No se confirmó el cierre de sesión: tu sesión puede seguir abierta. Inténtalo de nuevo.',
  'web.session.signed_out': 'No has iniciado sesión, o tu sesión terminó.',
  'web.session.no_access':
    'Tu cuenta no puede leer esto: le faltan los permisos accounts:read y journal_entries:read.',
  'web.session.signin_failed':
    'El inicio de sesión no terminó y no se guardó ninguna sesión. Inténtalo de nuevo.',
  'web.portfolio.title': 'Cartera del despacho',
  'web.portfolio.caption':
    'Entidades que puedes leer, su periodo en curso y el trabajo que espera a una persona',
  'web.portfolio.column.entity': 'Entidad',
  'web.portfolio.column.current_period': 'Periodo en curso',
  'web.portfolio.column.ended_open_periods': 'Periodos vencidos aún abiertos',
  'web.portfolio.column.pending_drafts': 'Borradores por revisar',
  'web.portfolio.column.pending_questions': 'Preguntas pendientes',
  'web.portfolio.no_calendar': 'sin calendario',
  'web.portfolio.inactive': 'inactiva',
  'web.portfolio.empty': 'Tu token no concede ninguna entidad que se pueda leer aquí.',
  'web.portfolio.not_evaluated': 'La preparación para el cierre no se evalúa en esta pantalla.',
  'web.portfolio.as_of': 'Fecha del servidor {date}',
  'web.portfolio.fetched': 'Leído a las {time}, hace {minutes} min',
  'web.portfolio.stale': 'La actualización de las {time} falló: estas cifras son de la última lectura buena.',
  'web.portfolio.omitted': 'Ids de entidad de tu token que no dieron fila: {count}',
  'web.portfolio.refresh': 'Actualizar',
  'web.portfolio.loading': 'Leyendo la cartera…',
  'web.portfolio.legend.title': 'Qué dicen los colores',
  'web.portfolio.legend.info': 'Azul: el periodo en curso está abierto o en cierre blando.',
  'web.portfolio.legend.balanced': 'Verde: el periodo en curso tiene cierre definitivo o está bloqueado.',
  'web.portfolio.legend.pending': 'Ámbar: hay trabajo esperando a una persona.',
  'web.portfolio.legend.neutral': 'Sin color: nada en espera, o todavía sin calendario.',
  'web.period_status.future': 'futuro',
  'web.period_status.open': 'abierto',
  'web.period_status.soft_close': 'cierre blando',
  'web.period_status.hard_close': 'cierre definitivo',
  'web.period_status.locked': 'bloqueado',
  'web.entity.back': 'Volver a la cartera',
  'web.entity.loading': 'Leyendo la entidad…',
  'web.entity.not_granted': 'Tu token no concede esta entidad: sus listas no se pueden leer aquí.',
  'web.entity.drafts': 'Borradores por revisar',
  'web.entity.drafts_limit': 'La API lista como mucho los 100 borradores más recientes.',
  'web.entity.questions': 'Preguntas pendientes',
  'web.entity.periods': 'Periodos fiscales',
  'web.entity.none': 'Ninguno.',
  'web.entity.column.date': 'Fecha',
  'web.entity.column.description': 'Descripción',
  'web.entity.column.confidence': 'Confianza',
  'web.entity.column.question': 'Pregunta',
  'web.entity.column.topic': 'Tema',
  'web.entity.column.period': 'Periodo',
  'web.entity.column.status': 'Estado',
  'web.entity.column.start': 'Inicio',
  'web.entity.column.end': 'Fin',
  'web.entity.verify': 'Las mismas listas en la terminal:',
  'web.error.upstream_unavailable': 'La API no responde en este momento.',
  'web.error.session_expired': 'Tu sesión terminó. Vuelve a iniciar sesión.',
  'web.error.unexpected': 'No se pudo leer la respuesta.',
  // ==== MNE-001-018 · the Anexo 24 migration leaves ====================
  'migration.file_unreadable': 'No se pudo leer el archivo «{file}».',
  'migration.subledger_not_array': '--subledger espera un arreglo JSON de documentos abiertos.',
  'migration.chart.confirm': '¿Crear {count} cuenta(s) en {entity}?',
  'migration.opening.confirm':
    '¿Postear la apertura del ejercicio {year} al {date} (Debe {debit} · Haber {credit})? ' +
    'El mayor no admite deshacer.',
  'migration.opening.confirm_draft':
    '¿Dejar en BORRADOR la apertura del ejercicio {year} al {date} (Debe {debit} · Haber {credit})? ' +
    'No entra al mayor hasta que la apliques con `entry post`.',
  'migration.check.as_of': 'Al {date} · {comparison}',
  // ---- MNE-001-419 (#621): what --chart refuses ----
  'migration.chart_option.other_rfc':
    'El catálogo de --chart es del RFC {fileRfc} y la entidad es {entityRfc}. No se usa: el catálogo de otro ' +
    'contribuyente no puede decir qué cuentas de esta entidad son de orden.',
  'migration.chart_option.not_importable':
    'El catálogo de --chart es uno que chart import no tomaría, así que no puede decir qué cuentas son de ' +
    'orden: {findings}. Corrige el archivo en el origen y vuelve a exportarlo.',
  'migration.chart_option.hierarchy_cycle':
    'La jerarquía del catálogo de --chart se muerde la cola: {rows}. chart import rechaza este archivo y la ' +
    'apertura también: corrige el SubCtaDe en el origen.',
  'migration.check.memorandum_inside_account':
    'El origen cuelga dinero de cuentas de orden (8xx) dentro de una cuenta del mayor, así que el saldo que esa ' +
    'cuenta declara incluye dinero que queda fuera del balance: {detail}. Cada cuenta va seguida de sus filas de ' +
    'orden, con el saldo que el origen declara, y de su neto, con el cargo en positivo. No se cotejó nada: una ' +
    'apertura que lleve ese dinero saldría igual al peso con dinero de cuentas de orden dentro del balance. ' +
    'Corrige la jerarquía en el catálogo de origen (SubCtaDe) y vuelve a exportar los dos archivos; ver {doctrine}.',
  // ---- MNE-001-456 (#621): the load leaves the memorandum accounts out ----
  'migration.opening.memorandum_excluded':
    '«{account}» es cuenta de orden (8xx), por su agrupador o porque cuelga de una, y el origen le declara ' +
    '{amount}. No recibe renglón en el asiento de apertura y queda fuera del mayor: guarda este saldo con los ' +
    'papeles de trabajo de la migración; ver {doctrine}.',
  'migration.opening.memorandum_in_ledger':
    '«{account}» es cuenta de orden (8xx), por su agrupador o porque cuelga de una, y ya existe en esta ' +
    'entidad como {type}. No recibe renglón en el asiento de apertura (el origen le declara {amount}), pero ' +
    'según la doctrina ({doctrine}) no debería estar en el mayor: revísala a mano.',
  'migration.opening.memorandum_inside_account':
    'El saldo que declara «{account}» incluye dinero de cuentas de orden (8xx) que cuelga dentro de ella y no ' +
    'suma cero ahí: {rows}, neto {net} con el cargo en positivo. No se carga nada: postear ese saldo metería ' +
    'dinero de cuentas de orden al balance, y postear menos haría fallar opening-balance check. Corrige la ' +
    'jerarquía en el catálogo de origen (SubCtaDe) y vuelve a exportar los dos archivos; ver {doctrine}.',
  'migration.opening.memorandum_document':
    'El documento «{document}» cuelga de «{account}», que es cuenta de orden (8xx) y no recibe renglón en el ' +
    'asiento de apertura. Una cuenta de orden no tiene detrás una cuenta por cobrar ni por pagar: quita el ' +
    'documento del archivo de --subledger, o corrige la cuenta en el origen; ver {doctrine}.',
  'migration.opening.unknown_account_chart_hint':
    'Si es cuenta de orden (8xx), pasa el catálogo de la misma migración con --chart <file>: la carga la deja ' +
    'fuera del asiento y la nombra ({doctrine}).',
  'migration.opening.memorandum_excluded_header':
    'Cuentas de orden fuera del asiento, con el saldo que declara el origen ({doctrine}):',
  // ==== MNE-001-093 · help by key, pilot family `period` (issue #314) ====
  'help.period.description': 'Periodos contables: cuáles existen, en qué estado está cada uno y cómo abrir uno futuro',
  'help.period.list.description': 'Lista todos los periodos con su estado, sus fechas y la marca de vencido',
  'help.period.list.option.year': 'sólo los periodos de este ejercicio fiscal',
  'help.period.show.description':
    'Muestra un periodo: su estado, quién lo cerró, la lista de verificación con que se cerró y sus pólizas',
  'help.period.show.argument.name': 'nombre del periodo, AAAA-MM o id',
  'help.period.open.description': 'Abre un periodo futuro para poder capturar operaciones en él',
  'help.period.open.argument.name': 'nombre del periodo, AAAA-MM o id',
  'help.period.open.option.reason': 'por qué se abre; queda en el rastro de auditoría',
  'help.period.reopen.description':
    'Reabre un periodo cerrado para que una corrección se registre en el mes al que pertenece',
  'help.period.reopen.argument.name': 'nombre del periodo, AAAA-MM o id',
  // ==== MNE-001-093 · help by key, the families merged from main (issue #314) ====
  'help.tenant.description': 'Crea y lista los despachos (inquilinos) de esta instalación',
  'help.tenant.list.description': 'Lista los despachos de esta instalación, incluidos los archivados',
  'help.tenant.create.description': 'Crea el inquilino de un despacho nuevo, con su usuario de sistema',
  'help.tenant.create.argument.name': 'nombre del despacho',
  'help.tenant.create.option.subdomain': 'identificador único del despacho (si se omite, se deriva del nombre)',
  'help.tenant.create.option.json': 'salida en JSON',
  'help.user.description': 'Da de alta, lista y archiva los usuarios de un despacho, sin terminal',
  'help.user.list.description': 'Lista los usuarios del despacho, incluidos los archivados',
  'help.user.create.description': 'Da de alta un usuario con un rol del catálogo; la contraseña llega por stdin, por el entorno o por una pregunta oculta',
  'help.user.create.option.email': 'correo con el que el usuario entra',
  'help.user.create.option.role': 'rol de src/auth/roles.ts (owner, admin, controller, contador, revisor, auditor, viewer) o su alias',
  'help.user.create.option.password_stdin': 'lee la contraseña de stdin (nunca como argumento)',
  'help.user.create.option.json': 'salida en JSON',
  'help.user.archive.description': 'Archiva un usuario: ya no puede entrar, y nada de lo que hizo se borra',
  'help.user.archive.argument.email': 'correo del usuario que se archiva',
  'cli.rls_bypass.notice': 'Aviso: el rol «{role}» ignora row level security ({reason}); en esta sesión el aislamiento entre despachos depende sólo del código. Conecta como mnemosine_app (scripts/provision-roles.sql).',
  'help.account.role.sync.description': 'Apunta los roles de retención a las cuentas que elige withholding_accounts_layout y crea las que falten',
  'help.account.role.sync.option.dry_run': 'muestra el plan, sin escribir nada',
  // MNE-001-421 (#623): `receipt record` with no invoice records a customer advance.
  'help.receipt.record.description':
    'Registra dinero cobrado: contra una factura, liberando el IVA que retenía, o sin factura como anticipo de cliente',
  'help.receipt.record.argument.invoice':
    'folio o id de la factura; sin ella el dinero es un anticipo, y --customer dice quién lo pagó',
  'help.receipt.record.option.customer':
    'el cliente que pagó (número, nombre o id); obligatorio sin factura, y con ella debe ser el de la factura',
  'help.receipt.record.option.tax_rate':
    'tratamiento de IVA de un anticipo: 16, 8, 0, exempt (exento) o not-subject (no-objeto); sin factura es obligatorio, y con una declara el del excedente que deja --on-account; el IVA se causa al cobro',
  'help.receipt.record.option.on_account':
    'permite que el importe exceda el saldo de la factura: el excedente queda a cuenta como anticipo y causa su IVA al cobro (LIVA art. 1-B), a la tasa de --tax-rate o a la de la propia factura',
  // #611: the payer's side of the Anexo 24 payment node.
  'help.receipt.record.option.check_number':
    'número del cheque del cliente (con --method check); el XML de pólizas lo declara en el nodo Cheque',
  'help.receipt.record.option.payer_bank':
    'clave c_Banco (3 dígitos) del banco del que pagó el cliente; se valida contra la lista del SAT',
  'help.receipt.record.option.payer_account':
    'cuenta de la que pagó el cliente (en un cheque, la cuenta contra la que se giró); exige --payer-bank o --payer-foreign-bank',
  'help.receipt.record.option.payer_foreign_bank':
    'nombre completo del banco del cliente cuando es extranjero, en lugar de --payer-bank',
  // MNE-001-422 (#623): the leaf says which procedure of Apéndice 6 it covers.
  'help.receipt.apply.description':
    'Aplica el saldo a cuenta de un cobro a facturas: libera el IVA de las PPD, y un anticipo cancela el IVA que causó en vez de causarlo otra vez. Cubre el procedimiento A del Anexo 20, Apéndice 6 (la venta facturada completa); con el procedimiento B el anticipo pasa a ingresos por póliza',
  'help.receipt.apply.option.withholding':
    'lo que retuvo el cliente, que salda la factura junto con el efectivo: "isr:1000" o "iva:1066.67" (repetible); con varias facturas, "INV-2026-00042:isr:1000"',
  'help.receipt.apply.option.date':
    'día de la aplicación (AAAA-MM-DD), que fecha su asiento, la aplicación y el último cobro de la factura; por omisión, hoy en la zona horaria de la entidad',
  'help.receipt.unapply.option.date':
    'día de la desaplicación (AAAA-MM-DD), que fecha su asiento y la aplicación cerrada; por omisión, hoy en la zona horaria de la entidad',
  // MNE-001-509 (#701): the reversal states what happened to the money.
  'help.receipt.reverse.description':
    'Reversa un cobro cuyo dinero no se quedó, diciendo por qué: espeja cada asiento, reabre facturas y vuelve a aparcar el IVA',
  'help.receipt.reverse.option.cause':
    'qué pasó con el dinero: not_collected (nunca fue tuyo) o taken_back (llegó y te lo quitaron, como en un contracargo); sin ella, un cheque toma not_collected y cualquier otro método queda sin causa',
  // MNE-001-511 (#701): the cause of a reversal, stated afterwards.
  'help.receipt.cause.description': 'La causa de un cobro reversado: qué pasó con su dinero',
  'help.receipt.cause.record.description':
    'Declara la causa de un cobro que se reversó sin ella: se escribe una vez, queda auditada y no postea nada',
  'help.receipt.cause.record.argument.ref': 'número de cobro o id',
  'help.receipt.cause.record.option.cause':
    'qué pasó con el dinero: not_collected (nunca fue tuyo) o taken_back (llegó y te lo quitaron, como en un contracargo)',
  'help.receipt.cause.record.option.json': 'salida JSON',
  // MNE-001-605 (#809): the live allocation of a reversed receipt, closed by a person.
  'help.receipt.allocation.description': 'Las aplicaciones de un cobro a sus facturas',
  'help.receipt.allocation.close.description':
    'Cierra la aplicación viva que un cobro reversado aún tiene sobre una factura (ar check: orphan-application): con la fecha de la reversa, auditada, sin postear nada',
  'help.receipt.allocation.close.argument.ref': 'número de cobro o id del cobro reversado',
  'help.receipt.allocation.close.option.invoice': 'número o id de la factura que salda la aplicación viva',
  'help.receipt.allocation.close.option.reason': 'por qué se cierra: queda escrito en el rastro de auditoría',
  'help.receipt.allocation.close.option.json': 'salida JSON',
  'help.receipt.allocation.close.examples':
    '\nEjemplos:\n' +
    '  ar check nombró PMT-2026-00042 (reversed) → INV-2026-00051 116.00 en orphan-application; ver qué se cerraría:\n' +
    '    mnemosine receipt allocation close PMT-2026-00042 --invoice INV-2026-00051 --reason "Quedó viva tras su reversa" --dry-run\n' +
    '  Cerrarla; la reversa ya reabrió la factura, así que no postea nada:\n' +
    '    mnemosine receipt allocation close PMT-2026-00042 --invoice INV-2026-00051 --reason "Quedó viva tras su reversa"\n',
  // MNE-001-568 (#612): el rastro de un pago registrado, completado después.
  'help.payment.trace.description': 'El rastro de un pago registrado: su cheque, y la cuenta y el banco a donde fue el dinero',
  'help.payment.trace.record.description':
    'Completa los campos vacíos del rastro de un pago registrado con su evidencia: sólo campos vacíos, auditado, no postea nada',
  'help.payment.trace.record.argument.payment': 'número o id del pago',
  'help.payment.trace.record.option.check_number': 'número de cheque; sólo para un pago hecho con cheque',
  'help.payment.trace.record.option.to_account': 'cuenta que recibió el dinero (CtaDest de la póliza del SAT)',
  'help.payment.trace.record.option.to_bank': 'clave del banco destino en el catálogo c_Banco del SAT (3 dígitos)',
  'help.payment.trace.record.option.to_foreign_bank': 'nombre del banco destino cuando es extranjero',
  'help.payment.trace.record.option.bank': 'cuenta bancaria (nombre o id) de la que salió el pago; sólo una que postea a la cuenta del mayor que movió su asiento',
  'help.payment.trace.record.option.json': 'salida JSON',
  // MNE-001-570 (#612): el rastro de un cobro registrado, completado después.
  'help.receipt.trace.description': 'El rastro de un cobro registrado: el banco y la cuenta del cliente, su cheque y nuestra cuenta bancaria',
  'help.receipt.trace.record.description':
    'Completa los campos vacíos del rastro de un cobro registrado con su evidencia: sólo campos vacíos, auditado, no postea nada',
  'help.receipt.trace.record.argument.receipt': 'número o id del cobro',
  'help.receipt.trace.record.option.check_number': 'número de cheque; sólo para un cobro con cheque del cliente',
  'help.receipt.trace.record.option.payer_bank': 'clave c_Banco (3 dígitos) del banco del que pagó el cliente, o que emitió su cheque',
  'help.receipt.trace.record.option.payer_account': 'cuenta de la que pagó el cliente, o contra la que se giró su cheque',
  'help.receipt.trace.record.option.payer_foreign_bank': 'nombre del banco del cliente cuando es extranjero',
  'help.receipt.trace.record.option.bank': 'cuenta bancaria (nombre o id) a la que entró el dinero; sólo una que postea a la cuenta del mayor que movió su asiento',
  'help.receipt.trace.record.option.json': 'salida JSON',
  // MNE-001-498 (#695): el traspaso del saldo a cuenta de un cliente.
  'help.receipt.transfer.description': 'Un traspaso del saldo a cuenta de un cliente a otro cliente',
  'help.receipt.transfer.record.description':
    'Traspasa el saldo a cuenta de un cliente a otro cliente, según lo acordado: auditado, postea cargo y abono a anticipos de clientes, sin banco, ingreso ni IVA',
  'help.receipt.transfer.record.argument.ref': 'número o id del cobro cuyo saldo a cuenta se traspasa',
  'help.receipt.transfer.record.option.customer': 'el cliente que recibe el crédito (número, nombre o id)',
  'help.receipt.transfer.record.option.amount': 'importe a traspasar, a lo más el saldo a cuenta del cobro',
  'help.receipt.transfer.record.option.date':
    'el día acordado del traspaso (AAAA-MM-DD), que fecha su asiento; por omisión hoy en la zona horaria de la entidad',
  'help.receipt.transfer.record.option.json': 'salida JSON',
  'help.sat.download.description': 'Descarga masiva de CFDI del SAT, y el censo contra lo contabilizado',
  'help.sat.download.reconcile.description':
    'Lee el censo del SAT de un mes contra lo contabilizado: lo que falta traer, lo que se trajo y no se contabilizó, lo que el SAT canceló y los libros aún llevan, y lo que los libros llevan y el SAT no lista. Lee el censo que cargó `ingest --kind zip|metadata`; no sale al SAT. Sale con 4 cuando el mes no puede darse por completo',
  'help.sat.download.reconcile.option.period': 'mes a conciliar, como AAAA-MM',
  'sat.reconcile.bad_period': 'El periodo debe ser un mes como AAAA-MM, y "{value}" no lo es.',
  'sat.reconcile.summary':
    '{period}: {matched} cuadran · {fetch} por traer · {post} por contabilizar · {cancelled} cancelados en el SAT pero contabilizados · {surplus} contabilizados que no están en el censo ({cancelledUnbooked} cancelados y nunca contabilizados: no son faltante).',
  'sat.reconcile.not_loaded':
    'Ningún censo de CFDI {direction} cubre este mes: no está cargado, que no es lo mismo que no haber nada {direction}. Cárgalo con `ingest --kind metadata`.',
  'help.closing.fx.description': 'La moneda extranjera en el cierre',
  'help.closing.fx.revalue.description':
    'Revalúa las cuentas por cobrar, por pagar y los bancos en moneda extranjera al tipo de cierre, y lo revierte el día 1 del periodo siguiente. Va después del cierre suave; una corrida posterior postea sólo lo que se movió desde entonces',
  'help.closing.fx.revalue.argument.period': 'periodo a revaluar: 2026-08, su id o parte de su nombre',

  'closing.fx.revalue.already_run':
    '{period} ya se revaluó (corrida {sequence}) y nada se ha movido desde entonces; no se posteó nada otra vez.',
  'closing.fx.revalue.summary':
    '{period} a {rates} · utilidad {gain} · pérdida {loss} · se revierte el {reversalDate}',
  'closing.fx.revalue.no_foreign_balance': 'sin saldos en moneda extranjera',
  'closing.fx.revalue.supplement':
    'Corrida complementaria {sequence}: la diferencia es sólo lo que se movió desde las corridas anteriores de este periodo.',
  'closing.fx.revalue.dry_run': 'Marcha seca: el mayor no se tocó.',
  'closing.fx.revalue.nothing': 'Nada que revaluar: el mayor no se tocó.',
  'closing.fx.revalue.confirm':
    '¿Posteo la revaluación de {period} (utilidad {gain}, pérdida {loss}) y su espejo el {reversalDate}? El mayor no admite deshacer.',
  'closing.fx.revalue.aborted': 'No se posteó nada.',
  'closing.fx.revalue.aborted_no_tty':
    'No se posteó nada: no hay terminal donde confirmar. Añade -y, o --dry-run para verlo antes.',
  'closing.fx.revalue.posted': '✔ {entry} el {closingDate}, revertida por {reversal} el {reversalDate}.',
  'help.bill.rule.description':
    'Reglas de procesamiento del despacho: con qué se clasifica un CFDI recibido sin que intervenga el modelo',
  'help.bill.rule.create.description':
    'Crea una regla de procesamiento (condiciones → acciones) que aplicará la próxima ingesta',
  'help.bill.rule.create.option.name': 'nombre de la regla; aparece en el rastro de cada CFDI que decide',
  'help.bill.rule.create.option.when': 'repetible; deben cumplirse todas: "<campo> <operador> <valor>"',
  'help.bill.rule.create.option.then': 'repetible: "<acción>=<valor>", p. ej. set_account=6100',
  'help.bill.rule.create.option.type': 'tipo de regla: {types}',
  'help.bill.rule.create.option.priority':
    'la de menor número se evalúa primero; una coincidencia posterior prevalece sobre una anterior',
  'help.bill.rule.create.option.description': 'por qué el despacho conserva esta regla',
  'help.bill.rule.create.option.dry_run': 'valida y muestra la regla; no escribe nada',
  'help.bill.rule.create.option.json': 'salida en JSON',
  'help.bill.rule.list.description':
    'Lista las reglas de procesamiento en orden de evaluación, con cuántas veces se aplicó cada una',
  'help.bill.rule.list.option.type': 'sólo este tipo de regla: {types}',
  'help.pay_run.description':
    'Corridas de nómina de un periodo de pago: crear, calcular de bruto a neto, aprobar y contabilizar la póliza',
  'help.pay_run.create.description':
    'Crea una corrida en borrador sobre un periodo de pago; el ejercicio fiscal se toma del periodo',
  'help.pay_run.create.option.period': 'periodo de pago de la entidad activa (su id)',
  'help.pay_run.create.option.type': 'tipo de corrida: {types}',
  'help.pay_run.calculate.description':
    'Calcula de bruto a neto a cada empleado del archivo de insumos y totaliza la corrida; ' +
    'una corrida sin aprobar se puede volver a calcular, y sus recibos se rehacen',
  'help.pay_run.calculate.argument.id': 'corrida de nómina por calcular',
  'help.pay_run.calculate.option.file': 'JSON con los insumos de los empleados: un arreglo, o {shape}',
  'help.pay_run.approve.description':
    'Aprueba una corrida calculada: sella sus totales y registra el pasivo patronal; es irreversible',
  'help.pay_run.approve.argument.id': 'corrida calculada por aprobar',
  'help.pay_run.post.description':
    'Arma la póliza de nómina de una corrida aprobada y la deja en borrador para `mnemosine review`; ' +
    'con --post la contabiliza de inmediato',
  'help.pay_run.post.argument.id': 'corrida aprobada cuya póliza se arma',
  'help.pay_run.post.option.post':
    'contabiliza la póliza en el mayor de inmediato, en lugar de dejarla en borrador para revisión',
  'help.pay_schedule.description':
    'Calendarios de nómina de la entidad: la frecuencia y las fechas que siguen sus periodos de pago',
  'help.pay_schedule.create.description':
    'Crea un calendario de nómina con su frecuencia, el inicio del primer periodo y la regla del día de pago',
  'help.pay_schedule.create.option.name': 'nombre del calendario, como lo conoce el contador',
  'help.pay_schedule.create.option.frequency': 'cada cuánto paga: {frequencies}',
  'help.pay_schedule.create.option.country': 'país de la nómina del calendario',
  'help.pay_schedule.create.option.first_start': 'primer día del primer periodo (AAAA-MM-DD)',
  'help.pay_schedule.create.option.pay_day_offset': 'días después del fin de cada periodo en que se paga (0 por omisión)',
  'help.pay_schedule.list.description': 'Lista los calendarios de nómina de la entidad con su frecuencia y sus empleados',
  'help.pay_schedule.list.option.all': 'incluye los calendarios inactivos',
  'help.pay_period.description': 'Periodos de nómina de la entidad: crear los siguientes de un calendario y listarlos',
  'help.pay_period.create.description':
    'Crea los siguientes periodos de un calendario, después del último; un periodo que ya existe no se vuelve a escribir',
  'help.pay_period.create.option.schedule': 'calendario de nómina de la entidad (su id)',
  'help.pay_period.create.option.count': 'cuántos periodos crear, de 1 a {max}',
  'help.pay_period.list.description': 'Lista los periodos de nómina de la entidad con estatus, fecha de pago y ejercicio',
  'help.pay_period.list.option.status': 'sólo los periodos en este estatus: {states}',
  'help.pay_period.list.option.year': 'sólo los periodos de este ejercicio (el año de la fecha de pago)',
  'help.payslip.description': 'Recibos de una corrida: listarlos y ver uno con sus renglones',
  'help.payslip.list.description':
    'Lista los recibos de una corrida con bruto, neto y estatus de timbre; sin identificadores fiscales',
  'help.payslip.list.option.run': 'corrida cuyos recibos se listan (obligatoria)',
  'help.payslip.show.description':
    'Muestra un recibo: los totales de bruto a neto y cada percepción, deducción e impuesto',
  'help.payslip.show.argument.id': 'id del recibo (de `payslip list --run`)',
  'help.payslip.show.option.redacted': 'oculta por completo RFC, CURP y NSS, para una pantalla compartida',
  'help.imss.description': 'Obligaciones del patrón ante el IMSS: el archivo mensual del SUA',
  'help.imss.sua.description': 'El archivo de importación al SUA de un mes',
  'help.imss.sua.export.description':
    'Arma el archivo de importación al SUA de un mes con los recibos aprobados, cotejado contra el pasivo patronal',
  'help.imss.sua.export.option.period': 'mes por exportar (AAAA-MM); el SUA es mensual',
  'help.imss.sua.export.option.output': 'escribe el archivo del SUA en esta ruta (sin ella, el archivo sale por stdout)',
  'help.imss.sua.export.option.yes': 'sobrescribe el archivo de -o si ya existe',
  'help.imss.sua.export.option.dry_run': 'arma y coteja el archivo sin escribirlo ni registrar la declaración',
  // ==== MNE-001-092 · help by key, the close and control families (issue #314) ====
  'help.close.description': 'Cierre de mes: revisa lo que falta y cierra el periodo',
  'help.close.option.period':
    'Periodo a cerrar: 2026-08, su id o una parte inequívoca de su nombre (por omisión, el abierto más antiguo)',
  'help.close.option.list': 'Lista los periodos que se pueden cerrar y termina',
  'help.close.option.check': 'Sólo revisa si está listo; nunca cierra',
  'help.close.option.hard': 'Cierre definitivo (irreversible) en vez de cierre blando',
  'help.close.option.reason': 'por qué se cierra ahora; queda en la bitácora de auditoría',
  'help.close.option.json': 'salida JSON para scripts',
  'help.closing.description': 'El cierre como proceso: conducirlo, leerlo y entregar el expediente que lo prueba',
  'help.closing.preview.description':
    'Gemelo de sólo lectura del inicio del cierre: dice si el periodo puede entrar a cierre y qué falta',
  'help.closing.preview.argument.period':
    'periodo abierto: 2026-07, su id o parte de su nombre (por omisión, el abierto más antiguo)',
  'help.closing.check.description':
    'Corre el catálogo de verificaciones del cierre, o sólo las nombradas; --check sin valor lista los nombres',
  'help.closing.check.option.check': 'códigos de verificación separados por comas; sin valor, imprime los disponibles',
  'help.closing.check.option.period':
    'periodo a verificar: 2026-07, su id o parte de su nombre (por omisión, el abierto más antiguo)',
  'help.closing.explain.description':
    'Imprime los renglones que fallan en una verificación (ids, importes, fechas) y el comando exacto que lo corrige',
  'help.closing.explain.argument.code': 'código de verificación, uno de: {codes}',
  'help.closing.explain.option.limit': 'máximo de renglones con falla a imprimir',
  'help.closing.explain.option.period':
    'periodo a explicar: 2026-07, su id o parte de su nombre (por omisión, el abierto más antiguo)',
  'help.closing.run.description':
    'Conduce el cierre: provisiona, amortiza, deprecia, revalúa los saldos en moneda extranjera, verifica la lista de cierre, hace el cierre blando y el definitivo, en ese orden',
  'help.closing.run.argument.period':
    'periodo abierto: 2026-07, su id o parte de su nombre (por omisión, el abierto más antiguo)',
  'help.closing.run.option.stop_at': 'se detiene ANTES de este paso: {steps}',
  'help.closing.run.option.resume':
    'continúa la corrida abierta de este periodo; cada paso vuelve a correr y sólo contabiliza lo que falta',
  'help.closing.pack.description':
    'El expediente de un cierre: generarlo y comprobar que sus cifras se siguen reproduciendo',
  'help.closing.pack.generate.description':
    'Sella las cifras del periodo en un expediente que un tercero puede volver a correr',
  'help.closing.pack.generate.argument.period':
    'nombre del periodo, AAAA-MM o id, en cualquier estado (por omisión, el cerrado más reciente)',
  'help.closing.pack.generate.option.output':
    'escribe el expediente en esta ruta (closing_packs guarda su propia copia)',
  'help.closing.pack.verify.description':
    'Vuelve a correr un expediente contra los libros: si se emitió aquí, si sus cifras se reproducen y qué se movió exactamente',
  'help.closing.pack.verify.argument.file': 'el expediente a comprobar',
  'help.year.description': 'Ejercicios fiscales: el calendario en el que una entidad lleva sus libros',
  'help.year.list.description': 'Lista los ejercicios fiscales de la entidad con su estado y el avance de su cierre',
  'help.year.show.description': 'Muestra un ejercicio fiscal con cada uno de sus periodos y su estado',
  'help.year.show.argument.year': 'año de cuatro dígitos, p. ej. 2026',
  'help.year.create.description':
    'Crea un ejercicio fiscal: sus doce periodos mensuales y el periodo de ajustes de cierre (13)',
  'help.year.create.argument.year': 'año de cuatro dígitos, p. ej. 2027',
  'help.year.create.option.dry_run': 'muestra el calendario que se crearía; no escribe nada',
  'help.year.create.option.json': 'salida JSON',
  'help.chart.description': 'Catálogo de cuentas: traer el catálogo de un despacho',
  'help.chart.import.description':
    'Importa un XML CatalogoCuentas del Anexo 24, conservando los códigos y la jerarquía del despacho',
  'help.chart.import.option.partial': 'escribe aunque queden renglones fuera (por omisión: todo o nada)',
  'help.chart.import.option.reason': 'por qué se importa el catálogo; va a la bitácora de auditoría',
  'help.opening_balance.description':
    'Saldos iniciales migrados de la balanza de comprobación del Anexo 24 del sistema anterior',
  'help.opening_balance.import.description':
    'Contabiliza la póliza de apertura desde un XML BalanzaComprobacion del Anexo 24, el día siguiente a su corte -- irreversible',
  'help.opening_balance.import.option.subledger':
    'arreglo JSON con los documentos abiertos de las cuentas de control de clientes y proveedores',
  'help.opening_balance.import.option.chart':
    'el XML CatalogoCuentas de la misma migración: sus cuentas de orden (8xx) quedan fuera del asiento, ' +
    'nombradas con el saldo del origen',
  'help.opening_balance.import.option.reason': 'por qué se carga la apertura; va a la bitácora de auditoría',
  'help.opening_balance.check.description':
    'Compara la balanza de origen contra el mayor en el día de apertura, al peso; sale con 4 si difieren',
  'help.opening_balance.check.option.chart':
    'el XML CatalogoCuentas de la misma migración: sus cuentas de orden (8xx) quedan fuera del cuadre, ' +
    'nombradas con el saldo del origen',
  'help.ar.description':
    'Controles de cuentas por cobrar: concilia el auxiliar contra la cuenta de control y corre diagnósticos por nombre',
  'help.ar.reconcile.description':
    'Auxiliar (facturas abiertas − notas de crédito sin aplicar) contra la cuenta de control de cxc, nombrando las pólizas manuales',
  'help.ar.reconcile.option.strict': 'sale con 4 ante cualquier diferencia, por corta que sea la lista de sospechosos',
  'ar.check.cross_party_application.found':
    'el dinero de un cliente salda la factura de otro: revísalo; no se bloquea nada',
  'ar.check.cross_party_application.none': 'ninguna',
  'ar.check.orphan_application.found':
    'la aplicación de un cobro muerto sigue contando como cobrada, así que el siguiente cobro de su factura no libera su IVA. ' +
    'En un cobro reversado la reversa ya reabrió la factura y reflejó sus pólizas, así que sólo falta cerrar la fila: ' +
    'ciérrala con `receipt allocation close <cobro> --invoice <factura> --reason "<por qué>"`, que no postea nada, ' +
    'antes de volver a cobrar esa factura. En un cobro anulado o fallido, repórtala',
  'ar.check.orphan_application.none': 'ninguna',
  'help.ar.check.description':
    'Diagnósticos de cuentas por cobrar por nombre; `--check` sin valor los lista, `--check a,b` elige',
  'help.ar.check.option.check': 'diagnósticos a correr, separados por comas; --check sin valor lista la batería',
  'help.ar.check.option.strict': 'sale con 4 también ante avisos, no sólo ante hallazgos bloqueantes',
  'help.ap.description':
    'Controles de cuentas por pagar: concilia el auxiliar de proveedores contra la cuenta de control y corre las verificaciones por nombre',
  'help.ap.reconcile.description':
    'Auxiliar de proveedores (facturas abiertas) contra la cuenta de control de cxp, nombrando las partidas en conciliación',
  'help.ap.reconcile.option.as_of': 'fecha de corte de los dos lados de la conciliación (AAAA-MM-DD; por omisión, hoy)',
  'help.ap.reconcile.option.explain': 'explica en prosa cada partida en conciliación, no sólo la tabla',
  'help.ap.check.description':
    'Verificaciones de cuentas por pagar por nombre; `--check` sin valor las lista, `--check a,b` elige',
  'help.ap.check.option.check': 'verificaciones a correr, separadas por comas; --check sin valor lista la batería',
  'ap.check.title': 'Verificaciones de CxP',
  'ap.check.cancelled_cfdi_open.found':
    'facturas de proveedor abiertas cuyo CFDI recibido el SAT reporta cancelado: detén el pago hasta que el proveedor mande el CFDI que lo sustituye; ' +
    'qué significa para la deducción y el IVA lo decide el contador, y no se revirtió nada',
  'ap.check.cancelled_cfdi_open.none': 'ninguna',
  'ap.check.bill_line': '{bill} · {vendor} · {uuid} · debe {amount} {currency} · marcada el {noted}',
  'ap.check.cancelled_cfdi_paid.found':
    'facturas de proveedor pagadas cuyo CFDI recibido el SAT reporta cancelado: su deducción y su IVA acreditable descansan en un CFDI que ya no vale; ' +
    'pide al proveedor el CFDI que lo sustituye; si hay que corregir lo ya declarado lo decide el contador, y no se revirtió nada',
  'ap.check.cancelled_cfdi_paid.none': 'ninguna',
  'ap.check.paid_bill_line': '{bill} · {vendor} · {uuid} · pagó {amount} {currency} · marcada el {noted}',
  'ap.check.summary':
    '{blocking, plural, one {# bloqueante} other {# bloqueantes}} · {warnings, plural, one {# aviso} other {# avisos}}',
  'help.cashflow.description':
    'Estado de flujos de efectivo (NIF B-2 / ASC 230): armarlo y cuadrarlo contra el efectivo real',
  'help.cashflow.generate.description':
    'Arma el estado de flujos de efectivo de un periodo, con su cuadre contra el efectivo real',
  'help.cashflow.generate.option.method':
    'método con el que se arma el estado (por omisión, la política `flujo_efectivo_metodo`)',
  'help.cashflow.generate.option.gross':
    'presenta cobros y pagos brutos en vez de netos (NIF B-2 §40 / ASC 230-10-45-7); se rechaza con su razón — estos libros no lo sostienen',
  'help.cashflow.reconcile.description':
    'Concilia el estado de flujos de efectivo derivado contra el movimiento real de efectivo y equivalentes, e imprime el residuo en vez de absorberlo',
  'help.cashflow.reconcile.option.show_candidates':
    'lista los renglones de póliza que más probablemente explican el residuo (sospechosos, no un veredicto)',
  'help.depreciation.description': 'La corrida mensual de depreciación: calcularla, revisarla y luego contabilizarla',
  'help.depreciation.run.description':
    'Calcula la corrida del periodo y la muestra activo por activo — no escribe ni contabiliza nada',
  'help.depreciation.run.option.period': 'periodo a calcular: 2026-08 o cualquier parte inequívoca de su nombre',
  'help.depreciation.run.option.book': 'el libro de depreciación que crees estar corriendo; se contrasta con el panel',
  'help.depreciation.run.option.by': 'detalle o resumen: {dimensions} (asset es el detalle por activo)',
  'help.depreciation.post.description':
    'Contabiliza la corrida del periodo en el mayor — una póliza por activo, irreversible',
  'help.depreciation.post.option.period': 'periodo a contabilizar: 2026-08 o cualquier parte inequívoca de su nombre',
  'help.depreciation.post.option.book':
    'el libro de depreciación que crees estar contabilizando; se contrasta con el panel',
  'help.depreciation.post.option.file':
    'el plan aprobado (JSON de `depreciation run --format json`); se niega si las cifras cambiaron',
  'help.filing.description': 'Declaraciones de la entidad: los papeles de trabajo que las respaldan, y el registro de las presentadas',
  'help.filing.workpaper.description': 'El papel de trabajo auditable del mes, renglón por renglón',
  'help.filing.workpaper.generate.description':
    'Genera el papel de trabajo del mes: IVA e ISR provisional, centavos y pesos, con las pólizas de cada renglón',
  'help.filing.workpaper.generate.option.period': 'mes a calcular (la declaración es mensual)',
  'help.filing.workpaper.generate.option.form': 'qué cálculo incluir',
  'help.filing.workpaper.generate.option.ptu_paid': 'PTU pagada en el ejercicio (ISR), la captura una persona',
  'help.filing.workpaper.generate.option.prior_provisional':
    'ISR provisional ya pagado en el ejercicio (ISR), lo captura una persona',
  'help.filing.workpaper.generate.option.prior_balance':
    'saldo a favor de periodos anteriores (IVA) en lugar del que dan las declaraciones registradas con `filing record`; pide --prior-balance-reason',
  'help.filing.workpaper.generate.option.prior_balance_reason': 'por qué se sobrescribe el saldo a favor; se muestra en su renglón',
  'help.filing.workpaper.generate.footer':
    'Esto calcula el papel. NO presenta nada: una persona lo revisa y declara en el portal del SAT.\n' +
    '\nEjemplos:\n' +
    '  El IVA y el ISR del mes con sus dos columnas y las pólizas de cada renglón:\n' +
    '    mnemosine filing workpaper generate --period 2026-05\n' +
    '  Sólo el IVA, el papel completo (con las pólizas) como JSON en un archivo:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form iva --json -o papel-2026-05.json\n' +
    '  El ISR con la PTU pagada en el ejercicio y los pagos provisionales ya hechos:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form isr --ptu-paid 24000 --prior-provisional 15000.40\n' +
    '  El IVA con un saldo a favor que da una persona en lugar del que dan las declaraciones presentadas:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form iva --prior-balance 3000 --prior-balance-reason "declaración anterior al sistema"',
  'filing.workpaper.period_invalid': '--period "{value}" no es un mes: usa AAAA-MM (por ejemplo 2026-05).',
  'filing.workpaper.form_invalid': '--form "{value}" no se conoce: usa iva, isr o all.',
  'filing.workpaper.label_blocks': 'BLOQUEA',
  'filing.workpaper.label_warning': 'aviso',
  'filing.workpaper.not_a_filing': 'Este papel no es una declaración: no se envió nada al SAT.',
  'filing.workpaper.more_entries': '+{count} más',
  'filing.workpaper.prior_balance_override_incomplete':
    'Sobrescribir el saldo a favor de periodos anteriores pide el importe y su motivo, los dos (--prior-balance y --prior-balance-reason).',
  // ==== MNE-001-577 · filing record (issue #308, part 3/3) ====
  'help.filing.record.description':
    'Registra una declaración mensual de IVA ya presentada en el portal del SAT: su acuse, lo que quedó a cargo o a favor, su pago y los saldos que acreditó',
  'help.filing.record.option.form': 'qué declaración es: {forms} (el IVA mensual)',
  'help.filing.record.option.period': 'mes que cubre la declaración',
  'help.filing.record.option.filed_on': 'día en que se presentó (AAAA-MM-DD), después de que termina su mes',
  'help.filing.record.option.acuse': 'número de operación del acuse: así nombra el registro a esta declaración',
  'help.filing.record.option.capture_line': 'línea de captura del pago, cuando la declaración tiene algo que pagar',
  'help.filing.record.option.payable': 'importe a cargo que dejó la declaración, hasta dos decimales (0 para una declaración en ceros)',
  'help.filing.record.option.in_favor': 'saldo a favor que dejó la declaración, hasta dos decimales; nunca junto con --payable',
  'help.filing.record.option.paid': 'lo que se pagó con la línea de captura; va con --paid-on',
  'help.filing.record.option.paid_on': 'día en que se pagó (AAAA-MM-DD), el de la presentación o después; va con --paid',
  'help.filing.record.option.credit':
    'un saldo a favor anterior que esta declaración acreditó (LIVA art. 6), como el acuse de la declaración que lo dejó y el importe; repítela por cada uno',
  'help.filing.record.footer':
    'Esto registra una declaración que una persona ya presentó. No envía nada al SAT, y una declaración registrada nunca se edita: cada declaración presentada es un renglón nuevo.\n' +
    'Una complementaria no se registra aquí.\n' +
    '\nEjemplos:\n' +
    '  Ver el renglón que dejaría la declaración de julio, con su saldo a favor, sin escribir nada:\n' +
    '    mnemosine filing record --form iva --period 2026-07 --filed-on 2026-08-14 --acuse OP-0701 --in-favor 5000.00 --dry-run\n' +
    '  Agosto: 8,000.00 de IVA menos 3,000.00 acreditados de julio, 5,000.00 a cargo pagados al día siguiente:\n' +
    '    mnemosine filing record --form iva --period 2026-08 --filed-on 2026-09-15 --acuse OP-0801 --capture-line LC-0801 --payable 5000.00 --paid 5000.00 --paid-on 2026-09-16 --credit OP-0701:3000.00 --json',
  'filing.record.form_invalid': '--form "{value}" no es una declaración que este comando registre: usa {forms}. El ISR provisional todavía no se registra. No se escribió nada.',
  'filing.record.period_invalid': '--period "{value}" no es un mes: usa AAAA-MM (por ejemplo 2026-08). No se escribió nada.',
  'filing.record.date_invalid': '{flag} "{value}" no es un día real: usa AAAA-MM-DD (por ejemplo 2026-09-15). No se escribió nada.',
  'filing.record.acuse_required': 'Falta --acuse: el número de operación del acuse es como el registro nombra a una declaración. No se escribió nada.',
  'filing.record.capture_line_blank': '--capture-line está en blanco: dala, o déjala fuera cuando la declaración no tiene nada que pagar. No se escribió nada.',
  'filing.record.result_required': 'Di qué dejó la declaración: --payable <importe> o --in-favor <importe> (--payable 0 para una declaración en ceros). No se escribió nada.',
  'filing.record.result_both': 'Una declaración deja un importe a cargo o un saldo a favor, nunca los dos: da --payable o --in-favor, no ambos. No se escribió nada.',
  'filing.record.amount_invalid': '{flag} "{value}" no es un importe: usa cero o más, con a lo más dos decimales y sin separador de miles (por ejemplo 5000.00). No se escribió nada.',
  'filing.record.payment_incomplete': 'Falta {missing}: un pago dice lo que se pagó (--paid) y el día (--paid-on). No se escribió nada.',
  'filing.record.credit_invalid': '--credit "{value}" no es válido: usa <acuse>:<importe>, el acuse de la declaración anterior y el importe acreditado (por ejemplo OP-0701:3000.00). No se escribió nada.',
  'filing.record.filed_on_in_future': '--filed-on {value} es posterior a hoy ({today}): sólo se registra una declaración ya presentada. No se escribió nada.',
  'filing.record.paid_on_in_future': '--paid-on {value} es posterior a hoy ({today}): sólo se registra un pago ya hecho. No se escribió nada.',
  'filing.record.dry_run': 'Simulación: la declaración es válida y se deshizo; no se escribió nada.',
  'filing.record.recorded': 'Registrada: {acuse} es la declaración vigente de {period}. No se envió nada al SAT.',
  // ==== MNE-001-457 · annual figure record (issue #622) ====
  'help.annual.description': 'La declaración anual de la entidad: las cifras que se toman de ella ya presentada',
  'help.annual.figure.description': 'Cifras de una declaración anual presentada que los pagos provisionales necesitan',
  'help.annual.figure.record.description': 'Registra una cifra de una declaración anual presentada, con esa declaración como fuente y quién la capturó',
  'help.annual.figure.record.option.kind': 'qué cifra es: {kinds}',
  'help.annual.figure.record.option.value': 'la cifra como la dice la declaración: cero o más, hasta cuatro decimales',
  'help.annual.figure.record.option.year': 'ejercicio de la declaración anual',
  'help.annual.figure.record.option.filed_on': 'día en que se presentó la declaración, o su complementaria (AAAA-MM-DD)',
  'help.annual.figure.record.option.source': 'cómo identificas esa declaración: su número de operación',
  'help.annual.figure.record.option.updated_through': 'sólo pérdidas fiscales pendientes: el mes del INPC al que ya están actualizadas (AAAA-MM, LISR art. 57)',
  'help.annual.figure.record.footer':
    'Esto registra lo que dice una declaración presentada. No presenta nada, y la última captura de una declaración es la vigente.\n' +
    'Una declaración que no dio coeficiente no se captura: el papel usa entonces la última declaración capturada dentro de cinco años (LISR art. 14 fr. I).\n' +
    '\nEjemplos:\n' +
    '  Ver el renglón que dejaría el coeficiente de utilidad de la declaración de 2025, sin escribir nada:\n' +
    '    mnemosine annual figure record --kind profit_coefficient --value 0.0875 --year 2025 --filed-on 2026-03-20 --source "operación 000111" --dry-run\n' +
    '  Su complementaria, presentada después: una captura nueva que queda vigente, y la anterior se conserva:\n' +
    '    mnemosine annual figure record --kind profit_coefficient --value 0.0900 --year 2025 --filed-on 2026-05-02 --source "operación 000222" --json\n' +
    '  Las pérdidas fiscales pendientes de esa declaración, actualizadas a diciembre de 2025; cero también se captura:\n' +
    '    mnemosine annual figure record --kind pending_tax_losses --value 30000.00 --updated-through 2025-12 --year 2025 --filed-on 2026-03-20 --source "operación 000111"',
  'annual.figure.kind_invalid': '--kind "{value}" no es una cifra que este comando registre: usa {kinds}. No se escribió nada.',
  'annual.figure.value_invalid': '--value "{value}" no es válido: usa cero o más, con hasta quince dígitos antes del punto y cuatro decimales (por ejemplo 0.0875). No se escribió nada.',
  'annual.figure.year_invalid': '--year "{value}" no es válido: usa los cuatro dígitos del ejercicio de la declaración, de {min} a {max}. No se escribió nada.',
  'annual.figure.filed_on_invalid': '--filed-on "{value}" no es un día real: usa AAAA-MM-DD (por ejemplo 2026-03-20). No se escribió nada.',
  'annual.figure.source_required': 'Falta --source: di de qué declaración se tomó la cifra (su número de operación). No se escribió nada.',
  'annual.figure.filed_on_not_after_year': '--filed-on {value} no puede ser la fecha de presentación de la declaración de {year}: la anual se presenta después de que termina su ejercicio. No se escribió nada.',
  'annual.figure.filed_on_in_future': '--filed-on {value} es posterior a hoy ({today}): sólo se registra una declaración ya presentada. No se escribió nada.',
  'annual.figure.updated_through_required': 'Falta --updated-through: las pérdidas fiscales pendientes dicen a qué mes del INPC están actualizadas (AAAA-MM, por ejemplo 2025-12). No se escribió nada.',
  'annual.figure.updated_through_not_allowed': '--updated-through no va con --kind {kind}: sólo las pérdidas fiscales pendientes llevan mes de actualización. No se escribió nada.',
  'annual.figure.updated_through_invalid': '--updated-through "{value}" no es un mes: usa AAAA-MM (por ejemplo 2025-12). No se escribió nada.',
  'annual.figure.updated_through_after_target': '--updated-through {value} es posterior a {target}: las pérdidas de la declaración de {year} las aplican los pagos del ejercicio siguiente, que las actualizan a lo más a ese junio (LISR art. 57). No se escribió nada.',
  'annual.figure.dry_run': 'Simulación: la captura es válida; no se escribió nada.',
  'annual.figure.next': 'Sigue: `mnemosine filing workpaper generate --period <AAAA-MM> --form isr`.',
  'income_tax_input.year_out_of_range': 'El ejercicio de la declaración fuente va de {min} a {max}: {year} queda fuera.',
  'income_tax_input.filed_on_not_a_day': '"{value}" no es un día real (AAAA-MM-DD): no puede ser la fecha de presentación de la declaración.',
  'income_tax_input.value_too_large': '"{value}" no cabe: una cifra tiene a lo más quince dígitos antes del punto.',
  'filed_return.obligation_not_written': 'Por ahora sólo se registra la declaración mensual del IVA: "{value}" no lo es. No se escribió nada.',
  'filed_return.obligation_invalid': '"{value}" no es una obligación del registro de declaraciones presentadas: usa {obligations}.',
  'filed_return.period_invalid': '"{value}" no es un mes: usa AAAA-MM (por ejemplo 2026-08).',
  'filed_return.filed_on_not_a_day': 'La fecha de presentación "{value}" no es un día real: usa AAAA-MM-DD (por ejemplo 2026-09-15). No se escribió nada.',
  'filed_return.filed_before_period_ends': 'La declaración de {period} se presenta cuando termina su mes, el {earliest} o después: {value} no puede ser su fecha de presentación. No se escribió nada.',
  'filed_return.paid_on_not_a_day': 'La fecha de pago "{value}" no es un día real: usa AAAA-MM-DD (por ejemplo 2026-09-16). No se escribió nada.',
  'filed_return.paid_before_filed': 'El pago del {paidOn} es anterior a la presentación del {filedOn}: una declaración se paga con la línea de captura que da su presentación, ese día o después. No se escribió nada.',
  'filed_return.payment_incomplete': 'Un pago dice cuánto se pagó y qué día, las dos cosas. No se escribió nada.',
  'filed_return.payable_and_in_favor': 'Una declaración deja un importe a cargo o un saldo a favor, nunca los dos: {payable} a cargo y {inFavor} a favor. No se escribió nada.',
  'filed_return.amount_invalid': '"{value}" no es un importe de una declaración: usa cero o más, con a lo más dos decimales y diecisiete dígitos antes del punto (por ejemplo 5000.00). No se escribió nada.',
  'filed_return.credit_amount_not_positive': 'Un saldo acreditado es mayor que cero: quita el acreditamiento de nada. No se escribió nada.',
  'filed_return.acknowledgement_required': 'Falta el número de operación del acuse: es como el registro nombra una declaración. No se escribió nada.',
  'filed_return.capture_line_blank': 'La línea de captura está en blanco: dala, u omítela cuando la declaración no tiene nada que pagar. No se escribió nada.',
  'filed_return.credit_repeated': 'El saldo de la declaración {acknowledgement} se acredita dos veces en esta declaración: pon los dos importes en un solo acreditamiento. No se escribió nada.',
  'filed_return.credit_source_unknown': 'No hay registrada una declaración con número de operación {acknowledgement} para esta entidad y este impuesto: registra primero esa declaración y después la que acredita su saldo. No se escribió nada.',
  'filed_return.credit_source_not_earlier': 'La declaración {acknowledgement} es de {sourcePeriod}: una declaración de {period} acredita sólo saldos de meses anteriores (LIVA art. 6). No se escribió nada.',
  'filed_return.credit_source_no_balance': 'La declaración {acknowledgement} no dejó saldo a favor: no hay nada de ella que acreditar. No se escribió nada.',
  'filed_return.credit_above_available': 'A la declaración {acknowledgement} ({sourcePeriod}) le quedan {available} de su saldo a favor por acreditar, después de lo que acreditaron las declaraciones vigentes de otros meses, lo compensado y cualquier solicitud de devolución: no se pueden acreditar {requested} de ella (LIVA art. 6). No se escribió nada.',
  'filed_return.amended_below_used': 'La complementaria deja {balance} a favor en {period}, pero ya se usaron {used} de ese saldo: {credited} acreditados por las declaraciones vigentes {returns} y {compensated} compensados. Corrige primero esas declaraciones y luego registra esta (LIVA art. 6, CFF art. 32). No se escribió nada.',
  'filed_return.replaced_unknown': 'No hay registrada una declaración con número de operación {acknowledgement} para esta entidad y este impuesto: una complementaria reemplaza una ya registrada. No se escribió nada.',
  'filed_return.replaced_other_period': 'La declaración {acknowledgement} es de {replacedPeriod}: una complementaria de {period} reemplaza una declaración del mismo mes. No se escribió nada.',
  'filed_return.amended_before_replaced': 'La complementaria se presenta el {filedOn}, antes de que se presentara el {replacedFiledOn} la declaración {acknowledgement} que reemplaza: una complementaria va después (CFF art. 32). No se escribió nada.',
  'filed_return.acknowledgement_taken': 'El número de operación {acknowledgement} ya está registrado para esta entidad: cada acuse es una declaración. No se escribió nada.',
  'filed_return.original_exists': 'La declaración de {period} de este impuesto ya está registrada: otra declaración de ese mes es una complementaria, que nombra la vigente que reemplaza. No se escribió nada.',
  'filed_return.already_replaced': 'La declaración {acknowledgement} ya la reemplazó otra complementaria: una complementaria reemplaza la vigente de {period}, la última presentada. No se escribió nada.',
  'help.diot.description':
    'DIOT de México: armar el mes a partir de operaciones pagadas, verificarlo y exportar el papel de trabajo',
  'help.diot.generate.description':
    'Arma la DIOT del mes a partir de operaciones pagadas, desglosada por tercero y por tasa',
  'help.diot.generate.option.period': 'mes a declarar (la DIOT es mensual; no hay mes 13)',
  'help.diot.check.description':
    'Corre por nombre las invariantes de la DIOT: el hecho del pago, el desglose por tasa, la base exenta, el tercero y su tipo de operación',
  'help.diot.check.option.period': 'mes a verificar (la DIOT es mensual; no hay mes 13)',
  'help.diot.check.option.check': 'nombres de verificación separados por comas; sin valor, imprime los disponibles',
  'help.diot.export.description':
    'Emite el archivo de la DIOT, estable byte a byte para comparar: el papel de trabajo o el archivo de carga masiva del SAT',
  'help.diot.export.option.period': 'mes a exportar (la DIOT es mensual; no hay mes 13)',
  'help.diot.export.option.layout':
    'formato del archivo: working-paper es la conciliación por tercero; sat es el archivo de carga masiva de la autoridad',
  'help.diot.export.option.yes': 'omite la confirmación de sobrescritura cuando -o nombra un archivo existente',
  'help.diot.export.option.output':
    'escribe el archivo exportado en esta ruta (sin ella, va a la salida estándar para poder compararlo)',
  // ==== MNE-001-234 · help by key, account and ledger (issue #314) ====
  'help.account.description': 'Catálogo de cuentas: consultar, dar de alta y retirar cuentas',
  'help.account.list.description': 'Lista las cuentas, filtradas por tipo, estado, cuenta padre o texto libre',
  'help.account.list.argument.search': 'texto que se busca en el código o en el nombre de la cuenta',
  'help.account.list.option.type': 'tipo de cuenta: {types}',
  'help.entity.option.minimum_wage_zone': '{zones}: área de salario mínimo del lugar de trabajo, que topa la prima de antigüedad (LFT art. 486)',
  'help.account.list.option.parent': 'sólo las subcuentas de la cuenta con este código',
  'help.account.list.option.inactive': 'muestra las cuentas inactivas en lugar de las activas',
  'help.account.show.description':
    'Muestra una cuenta con su cuenta padre, sus banderas de gobierno y su actividad de por vida',
  'help.account.show.argument.code': 'código o id de la cuenta',
  'help.account.show.option.no_balance': 'omite la consulta de la actividad de por vida',
  'help.account.create.description': 'Da de alta una cuenta',
  'help.account.create.argument.code': 'código de la cuenta, único dentro de la entidad',
  'help.account.create.argument.name': 'nombre de la cuenta',
  'help.account.create.option.type': 'tipo de cuenta: {types}',
  'help.account.create.option.normal_balance':
    'naturaleza de la cuenta: debit (deudora) o credit (acreedora); por omisión, la que corresponde al tipo',
  'help.account.create.option.parent': 'código de la cuenta padre',
  'help.account.create.option.currency': 'restringe la cuenta a una sola moneda (3 letras)',
  'help.account.create.option.subtype': 'subtipo de la cuenta',
  'help.account.create.option.fs_category': 'categoría de estado financiero',
  'help.account.create.option.description': 'descripción',
  'help.account.create.option.header': 'una cuenta agrupadora: no acepta pólizas manuales',
  'help.account.create.option.json': 'salida en JSON',
  'help.account.create.examples':
    '\nEjemplos:\n' +
    '  {comment} Una cuenta de gasto nueva que cuelga de Gastos de Administracion (6100).\n' +
    '  {expense}\n' +
    '  {comment} Un nodo de agrupación: --header quiere decir que no acepta pólizas manuales.\n' +
    '  {header}\n',
  'help.account.edit.description':
    'Cambia el nombre, la descripción, el subtipo o la categoría de estado financiero de una cuenta',
  'help.account.edit.argument.code': 'código o id de la cuenta',
  'help.account.edit.option.name': 'nuevo nombre',
  'help.account.edit.option.description': 'nueva descripción',
  'help.account.edit.option.subtype': 'nuevo subtipo',
  'help.account.edit.option.fs_category': 'nueva categoría de estado financiero',
  'help.account.archive.description':
    'Retira una cuenta del uso activo (nunca la borra; exige saldo cero salvo con --force)',
  'help.account.archive.argument.code': 'código o id de la cuenta',
  'help.account.archive.option.dry_run': 'corre las verificaciones e informa, sin escribir nada',
  'help.account.set.description':
    'Fija las banderas de gobierno de una cuenta (quién puede contabilizar en ella, y cómo)',
  'help.account.set.argument.code': 'código o id de la cuenta',
  'help.account.set.argument.pairs': 'clave=valor: allow-manual, header, control-account, require-subsidiary, currency',
  'help.account.set.option.dry_run': 'valida e informa, sin escribir nada',
  'help.account.set.option.reason': 'por qué cambian estas banderas; queda en el rastro de auditoría',
  'help.account.balance.description': 'Saldos de una cuenta, descompuestos por periodo fiscal',
  'help.account.balance.show.description':
    'Saldo inicial, cargos, abonos y saldo final por periodo, con el estado del periodo',
  'help.account.balance.show.argument.code': 'código o id de la cuenta',
  'help.account.balance.show.option.period': 'sólo este periodo: 2026-07, su id o una parte de su nombre',
  'help.account.balance.show.option.as_of': 'sólo el periodo que contiene esta fecha (AAAA-MM-DD)',
  'help.account.role.description':
    'Roles semánticos de cuentas (cxc, banco, iva_acreditable…) que lee la contabilización automática',
  'help.account.role.list.description':
    'Cada rol y la cuenta a la que apunta, con la variante por omisión y las variantes con calificador',
  'help.account.role.list.option.role': 'sólo este rol',
  'help.account.role.list.option.qualifier': 'sólo esta variante con calificador',
  'help.account.role.set.description': 'Reapunta un rol a otra cuenta, o crea una variante con calificador',
  'help.account.role.set.argument.role': 'uno de: {roles}… (ver role list)',
  'help.account.role.set.argument.code': 'código de la cuenta a la que debe apuntar el rol',
  'help.account.role.set.option.qualifier': 'variante por contexto (NULL = el mapeo por omisión)',
  'help.account.role.set.option.note': 'por qué el rol apunta aquí',
  'help.account.role.set.option.dry_run': 'valida e informa, sin escribir nada',
  'help.account.role.seed.description':
    'Crea las cuentas base que falten y mapea cada rol sin asignar (nunca pisa una decisión manual)',
  'help.account.map.description':
    'Mapeos estatutarios por cuenta: código agrupador del SAT (Anexo 24), línea fiscal de EE. UU., NIIF',
  'help.account.map.set.description': 'Asocia la cuenta a un valor de un esquema estatutario',
  'help.account.map.set.argument.code': 'código o id de la cuenta',
  'help.account.map.set.option.scheme': 'esquema: {schemes}',
  'help.account.map.set.option.value': 'el código en ese esquema; un valor vacío borra el mapeo',
  'help.account.map.set.option.year': 'ejercicio cuyo catálogo del SAT valida el código (por omisión, el de hoy)',
  'help.account.map.set.option.dry_run': 'valida e informa, sin escribir nada',
  'help.account.map.list.description': 'Todas las cuentas activas con sus mapeos estatutarios',
  'help.account.map.list.option.scheme': 'muestra sólo la columna de este esquema',
  'help.account.map.import.description':
    'Carga masiva de un esquema estatutario desde CSV — la tarea de alta más pesada de un despacho mexicano',
  'help.account.map.import.argument.file': 'CSV: código,valor (una cuenta por línea; separador coma o punto y coma)',
  'help.account.map.import.option.scheme': 'esquema: {schemes}',
  'help.account.map.import.option.dry_run': 'lee y resuelve todo; no escribe nada',
  'help.account.map.import.option.idempotency_key':
    'llave para reintentar sin riesgo: la misma llave con el mismo archivo devuelve el primer resultado',
  'help.account.map.check.description':
    'Compuerta de cobertura previa al XML de catálogo del Anexo 24: qué cuentas todavía no tienen mapeo',
  'help.account.map.check.option.check':
    'verificaciones a correr, por nombre (disponible: coverage; un valor vacío las lista)',
  'help.account.map.check.option.scheme': 'esquema a verificar',
  'help.account.map.check.option.level': 'retirada: la compuerta ya no mide por nivel de cuenta',
  'help.account.restore.description': 'Vuelve a poner en servicio una cuenta retirada',
  'help.account.restore.argument.code': 'código o id de la cuenta',
  'help.account.restore.option.reason':
    'por qué la cuenta vuelve a estar en servicio; queda en el rastro de auditoría',
  'help.ledger.description': 'El mayor en sí: verificaciones de integridad, borradores viejos, auxiliares y saldos',
  'help.ledger.check.description':
    'Verificaciones del mayor por nombre; sin bandera corre las bloqueantes y sale con 4 si hay hallazgos',
  'help.ledger.check.option.check':
    'verificaciones a correr, separadas por comas (disponibles: {checks}; un valor vacío las lista)',
  'help.ledger.check.option.account': 'acota la verificación `balance` a una sola cuenta',
  'help.ledger.check.option.period':
    'acota la verificación `balance` a un periodo fiscal: 2026-07, su id o una parte de su nombre',
  'help.ledger.stale_draft.description': 'Pólizas en borrador que llevan demasiado tiempo sin contabilizarse',
  'help.ledger.stale_draft.list.description':
    'Borradores con más de N días — el bloqueo número uno de toda lista de verificación del cierre',
  'help.ledger.stale_draft.list.option.days': 'antigüedad mínima en días',
  'help.ledger.stale_draft.list.option.period':
    'sólo los borradores fechados en este periodo fiscal: 2026-07, su id o una parte de su nombre',
  'help.ledger.auxiliary.description':
    'Auxiliar de cuenta: saldo inicial, movimientos y saldo final — la forma XC del SAT',
  'help.ledger.auxiliary.show.description': 'Una cuenta, un periodo: saldo inicial → cada movimiento → saldo final',
  'help.ledger.auxiliary.show.option.account': 'código de la cuenta',
  'help.ledger.auxiliary.show.option.period': 'periodo fiscal: 2026-07, su id o una parte inequívoca de su nombre',
  'help.ledger.balance.description': 'El saldo de una cuenta, descompuesto por periodo, con el estado del periodo',
  'help.ledger.balance.show.description': 'Saldo inicial, cargos, abonos y saldo final de una cuenta, por periodo',
  'help.ledger.balance.show.option.account': 'código o id de la cuenta',
  'help.ledger.balance.show.option.as_of': 'sólo el periodo que contiene esta fecha (AAAA-MM-DD)',
  'help.ledger.balance.show.option.period': 'sólo este periodo: 2026-07, su id o una parte de su nombre',
  'help.ledger.balance.show.option.dim':
    'desglose por dimensión (no disponible: la familia dimension todavía no existe)',
  // ==== MNE-001-241 · help by key, employee, garnishment, isn and payroll (issue #314) ====
  'help.employee.description': 'El padrón de nómina: dar de alta a un empleado, ver un expediente, listar el padrón',
  'help.employee.create.description':
    'Da de alta a un empleado desde un archivo JSON, con sus identificadores fiscales',
  'help.employee.create.option.file': 'objeto JSON con el expediente del empleado (obligatorio)',
  'help.employee.create.option.country': 'el país cuya nómina aplica; prevalece sobre el archivo',
  'help.employee.create.option.hire_date': 'fecha de ingreso (AAAA-MM-DD); prevalece sobre el archivo',
  'help.employee.create.option.pay_schedule': 'un calendario de pago de esta entidad; prevalece sobre el archivo',
  'help.employee.create.option.dry_run': 'ejecuta la escritura real y la revierte: no se guarda nada',
  'help.employee.show.description':
    'Muestra el expediente de un empleado con los identificadores fiscales enmascarados',
  'help.employee.show.argument.employee': 'número de empleado o id',
  'help.employee.show.option.redacted':
    'oculta por completo identificadores, correo y teléfono, para una pantalla compartida',
  'help.employee.list.description':
    'Lista los empleados de la entidad, los activos por omisión, sin identificadores fiscales',
  'help.employee.list.option.country': 'sólo los empleados de este país',
  'help.garnishment.description':
    'Embargos de salario por orden judicial: registrar una orden, ver la cascada, detenerla',
  'help.garnishment.record.description':
    'Registra una orden judicial ya dictada, con su fundamento, su autoridad y sus topes',
  'help.garnishment.record.argument.employee': 'número de empleado o id contra el que va la orden',
  'help.garnishment.record.option.type': 'el tipo de orden, en el vocabulario que guarda la columna',
  'help.garnishment.record.option.amount': 'un importe fijo por periodo',
  'help.garnishment.record.option.percent_disposable':
    'un porcentaje del ingreso DISPONIBLE (bruto menos los impuestos del empleado)',
  'help.garnishment.record.option.percent_gross':
    'un porcentaje del salario BRUTO: dinero distinto del de --percent-disposable',
  'help.garnishment.record.option.priority': 'desempate DENTRO de un rango legal; no decide el rango',
  'help.garnishment.record.option.case':
    'el número de expediente judicial, único por trabajador mientras la orden está viva',
  'help.garnishment.record.option.court': 'la autoridad que dictó la orden (obligatorio)',
  'help.garnishment.record.option.payee': 'a quién se le entrega lo retenido',
  'help.garnishment.record.option.start':
    'la fecha que lleva la orden (AAAA-MM-DD); la retención empieza cuando está ACTIVA',
  'help.garnishment.record.option.exempt_amount':
    'importe exento de la IRS Pub 1494; obligatorio en un embargo fiscal, nada más lo lee',
  'help.garnishment.record.option.supports_second_family':
    '¿este trabajador mantiene a otra familia? decide un tope CCPA de 50 % o 60 %; sin valor por omisión',
  'help.garnishment.record.option.arrears_12wk':
    '¿los adeudos tienen más de doce semanas? suma cinco puntos al tope; sin valor por omisión',
  'help.garnishment.record.option.dry_run':
    'ejecuta el camino real y lo deshace: muestra la orden y la cascada a la que se sumaría',
  'help.garnishment.list.description':
    'Lista las órdenes en la secuencia en que se toma el dinero: rango legal, luego prioridad, luego fecha',
  'help.garnishment.list.argument.employee': 'acota a un trabajador, por número de empleado o id',
  'help.garnishment.list.option.type': 'sólo las órdenes de este tipo',
  'help.garnishment.archive.description':
    'Detiene la retención apagando is_active, y conserva la orden y su historia',
  'help.garnishment.archive.argument.id': 'el id de la orden, como lo imprime `garnishment list`',
  'help.garnishment.archive.option.as_of':
    'la fecha en que cesó la orden (AAAA-MM-DD), que se anota en end_date junto con la suspensión',
  'help.isn.description':
    'Impuesto estatal sobre nóminas: captura las tasas estatales con su fundamento y ve lo que debe una corrida de nómina',
  'help.isn.rate.description': 'Tasas estatales del ISN, por estado y por vigencia',
  'help.isn.rate.set.description': 'Captura una tasa estatal con su vigencia y la ley que la sustenta',
  'help.isn.rate.set.argument.state': 'clave c_Estado del SAT, como está escrita en tus trabajadores (JAL, NLE)',
  'help.isn.rate.set.argument.rate': 'la tasa, como fracción (0.03) o como porcentaje (3%)',
  'help.isn.rate.set.option.effective_from': 'primer día en que aplica esta tasa (AAAA-MM-DD)',
  'help.isn.rate.set.option.superseded_on':
    'día en que entra la siguiente tasa y ésta deja de aplicar (AAAA-MM-DD); omítela mientras sea la vigente',
  'help.isn.rate.set.option.legal_basis': 'la ley y el artículo de donde sale la tasa (obligatorio)',
  'help.isn.rate.set.option.regime': 'cómo lo cobra el estado; el motor sólo calcula tasa_plana',
  'help.isn.rate.set.option.exemption': 'importe mensual exento; sólo con --regime con_exencion',
  'help.isn.rate.set.option.dry_run': 'muestra exactamente lo que se escribiría y a quién alcanza; no escribe nada',
  'help.isn.rate.set.option.yes': 'omite la confirmación',
  'help.isn.rate.list.description': 'Las tasas estatales capturadas, con la vigente en una fecha dada marcada',
  'help.isn.rate.list.option.limit': 'máximo de renglones a devolver',
  'help.isn.rate.list.option.offset': 'salta estos renglones',
  'help.isn.rate.list.option.all': 'todas las vigencias capturadas alguna vez, no sólo la que está en vigor',
  'help.isn.rate.list.option.state': 'sólo este estado (clave c_Estado del SAT)',
  'help.isn.rate.list.option.as_of': 'qué tasa estaba vigente en esta fecha (AAAA-MM-DD; por omisión, hoy)',
  'help.isn.calculate.description':
    'El ISN de una corrida de nómina, un renglón por estado, nombrando cada tasa que falta en lugar de calcular cero',
  'help.isn.calculate.option.run': 'la corrida de nómina a calcular (obligatoria)',
  'help.isn.calculate.option.state': 'acota los renglones a un estado; los hallazgos nunca se ocultan',
  'help.payroll.description': 'Contabilidad de la nómina: el pasivo por prestaciones que nace el día trabajado',
  'help.payroll.accrue.description':
    'Registra el devengo mensual de prestaciones -- aguinaldo, vacaciones y prima vacacional, un asiento de ajuste, irreversible',
  'help.payroll.accrue.option.period': 'periodo a devengar: 2026-03, o cualquier parte inequívoca de su nombre',
  // ==== MNE-001-231 · help by key, bank account, statement and transaction (issue #314) ====
  'help.bank.description': 'Cuentas bancarias y estados de cuenta: los datos maestros y los estados importados',
  'help.bank.account.description':
    'Las cuentas bancarias como datos maestros: identificadores, moneda y el mapeo 1:1 a la cuenta de mayor',
  'help.bank.account.create.description':
    'Da de alta una cuenta bancaria y valida el dígito verificador de la CLABE, la suma de control del ruteo ' +
    'ABA, la moneda contra la cuenta de mayor y el mapeo 1:1',
  'help.bank.account.create.argument.name': 'nombre con el que se conoce esta cuenta en los libros',
  'help.bank.account.create.option.bank': 'nombre de la institución',
  'help.bank.account.create.option.gl_account':
    'cuenta de mayor a la que se mapea esta cuenta bancaria, 1:1 (código o id)',
  'help.bank.account.create.option.currency': 'código ISO de 3 letras; debe ser la moneda de la cuenta de mayor',
  'help.bank.account.create.option.type':
    'tipo de cuenta; credit-card es un PASIVO y se mapea a una cuenta de mayor de pasivo',
  'help.bank.account.create.option.clabe': 'CLABE; se guarda cifrada y sólo se muestran sus últimos 4 dígitos',
  'help.bank.account.create.option.account_number': 'número de cuenta; se guarda cifrado',
  'help.bank.account.create.option.routing_ach': 'número de ruteo ABA para ACH',
  'help.bank.account.create.option.routing_wire': 'número de ruteo ABA para transferencias (wire)',
  'help.bank.account.create.option.sat_bank_code': 'clave c_Banco del SAT; si se omite, se deriva de la CLABE',
  'help.bank.account.create.option.branch': 'sucursal',
  'help.bank.account.create.option.swift': 'código SWIFT/BIC',
  'help.bank.account.create.option.iban': 'código IBAN',
  'help.bank.account.create.option.foreign_bank':
    'el banco no reside en México: las pólizas declaran la clave c_Banco 999 y el nombre del banco; exige --reason, ' +
    'y ni --sat-bank-code ni --clabe',
  'help.bank.account.create.option.reason':
    'justificación que queda en el rastro de auditoría; obligatoria con --foreign-bank',
  'help.bank.account.create.option.dry_run': 'corre todas las validaciones y la inserción, y luego lo deshace todo',
  'help.bank.account.create.option.json': 'salida en JSON',
  'help.bank.account.list.description':
    'Lista las cuentas con su moneda, tipo, cuenta de mayor, saldo en libros y la última conciliación aprobada',
  'help.bank.account.list.argument.query': 'texto que se busca en el nombre de la cuenta o en el del banco',
  'help.bank.account.list.option.type': 'sólo las cuentas de este tipo',
  'help.bank.account.list.option.currency': 'sólo las cuentas en esta moneda',
  'help.bank.account.list.option.all_entities':
    'todas las entidades del inquilino, para una vista de conjunto del despacho; el alcance sigue acotado dentro del SQL',
  'help.bank.account.show.description':
    'Muestra una cuenta: identificadores enmascarados, clave de banco del SAT, saldo en libros contra saldo del ' +
    'banco y el ancla de la conciliación',
  'help.bank.account.show.argument.account': 'nombre o id de la cuenta',
  'help.bank.account.show.option.redacted':
    'oculta incluso los últimos 4 dígitos de los identificadores, para una pantalla compartida',
  'help.bank.account.edit.description': 'Cambia los datos maestros y registra el antes y el después campo por campo',
  'help.bank.account.edit.argument.account': 'nombre o id de la cuenta',
  'help.bank.account.edit.option.name': 'nuevo nombre de la cuenta',
  'help.bank.account.edit.option.bank': 'nuevo nombre de la institución',
  'help.bank.account.edit.option.branch': 'sucursal; un valor vacío la borra',
  'help.bank.account.edit.option.type': 'tipo de cuenta',
  'help.bank.account.edit.option.currency': 'moneda; se vuelve a verificar contra la cuenta de mayor',
  'help.bank.account.edit.option.clabe': 'CLABE; exige --reason. Un valor vacío la borra',
  'help.bank.account.edit.option.account_number': 'número de cuenta; exige --reason. Un valor vacío lo borra',
  'help.bank.account.edit.option.routing_ach': 'ruteo ABA para ACH; exige --reason. Un valor vacío lo borra',
  'help.bank.account.edit.option.routing_wire':
    'ruteo ABA para transferencias (wire); exige --reason. Un valor vacío lo borra',
  'help.bank.account.edit.option.sat_bank_code': 'clave c_Banco del SAT; un valor vacío la borra',
  'help.bank.account.edit.option.swift': 'código SWIFT/BIC; un valor vacío lo borra',
  'help.bank.account.edit.option.iban': 'código IBAN; un valor vacío lo borra',
  'help.bank.account.edit.option.foreign_bank':
    'el banco no reside en México: las pólizas declaran la clave c_Banco 999 y el nombre del banco; exige --reason',
  'help.bank.account.edit.option.no_foreign_bank': 'quita la marca de banco extranjero; exige --reason',
  'help.bank.account.edit.option.reason':
    'justificación que queda en el rastro de auditoría; obligatoria para los identificadores y la marca de banco extranjero',
  'help.bank.account.edit.option.dry_run': 'aplica el cambio y lo deshace, mostrando lo que cambiaría',
  'help.bank.account.edit.option.json': 'salida en JSON',
  'help.bank.account.set.description':
    'Escribe el mapeo 1:1 a la cuenta de mayor y rechaza el cambio si la cuenta anterior tiene pólizas contabilizadas',
  'help.bank.account.set.argument.account': 'nombre o id de la cuenta',
  'help.bank.account.set.option.gl_account': 'cuenta de mayor a la que se mapea (código o id)',
  'help.bank.account.set.option.reason': 'justificación que queda en el rastro de auditoría; la exige --force',
  'help.bank.account.set.option.dry_run': 'aplica el nuevo mapeo y lo deshace',
  'help.bank.account.set.option.json': 'salida en JSON',
  'help.bank.statement.description':
    'Los estados de cuenta como documentos: importarlos, revisarlos y verificar su integridad',
  'help.bank.statement.import.description':
    'Lee, normaliza y deja en el staging bancario un estado de cuenta, deduplicando por id nativo o por hash del ' +
    'contenido; no contabiliza NADA en el mayor',
  'help.bank.statement.import.argument.file':
    'archivos de estados de cuenta; combínalos con --dir para tomar una carpeta entera',
  'help.bank.statement.import.option.account':
    'cuenta bancaria a la que pertenecen estos estados de cuenta (nombre o id)',
  'help.bank.statement.import.option.format':
    'formato del ARCHIVO (no de la salida; para eso está --json); si se omite, se detecta por el contenido',
  'help.bank.statement.import.option.profile': 'perfil de columnas CSV con el que se lee el archivo',
  'help.bank.statement.import.option.dir': 'importa también todos los archivos de esta carpeta',
  'help.bank.statement.import.option.closing_balance':
    'saldo final que afirmas, para un formato que no lo trae (un CSV); se rechaza si el archivo dice otro',
  'help.bank.statement.import.option.dry_run':
    'lee el archivo, corre las siete verificaciones y deshace la escritura',
  'help.bank.statement.import.option.json': 'salida en JSON',
  'help.bank.statement.list.description':
    'Lista los estados de cuenta importados por cuenta y periodo, con saldo inicial y final, número de líneas y ' +
    'la cadena de saldos',
  'help.bank.statement.list.option.account': 'sólo esta cuenta bancaria (nombre o id)',
  'help.bank.statement.list.option.since':
    'estados de cuenta cuyo periodo TERMINA en esta fecha o después (AAAA-MM-DD)',
  'help.bank.statement.list.option.until':
    'estados de cuenta cuyo periodo EMPIEZA en esta fecha o antes (AAAA-MM-DD)',
  'help.bank.statement.show.description':
    'Muestra un estado de cuenta: número de secuencia electrónica, rango de fechas, hash del archivo original y ' +
    'el perfil aplicado',
  'help.bank.statement.show.argument.id': 'id del estado de cuenta',
  'help.bank.statement.show.option.lines': 'incluye las líneas del estado de cuenta',
  'help.bank.statement.show.option.limit': 'máximo de líneas a listar con --lines (por omisión, 500)',
  'help.bank.statement.check.description':
    'Corre las siete verificaciones de integridad y SALE CON 4 nombrando la que falló',
  'help.bank.statement.check.argument.id': 'un estado de cuenta; sin él, el más reciente de cada cuenta',
  'help.bank.statement.check.option.check':
    'verificaciones a correr, separadas por comas; --check sin valor las lista ({checks})',
  'help.bank.statement.check.option.all':
    'todos los estados de cuenta de la entidad, no sólo el más reciente de cada cuenta',
  'help.bank.statement.check.option.account': 'todos los estados de cuenta de esta cuenta bancaria (nombre o id)',
  'help.bank.statement.check.option.since':
    'sólo los estados de cuenta cuyo periodo termina en esta fecha o después (AAAA-MM-DD)',
  'help.bank.transaction.description':
    'Movimientos bancarios: lo que el banco dice que pasó, antes de que nadie lo explique',
  'help.bank.transaction.list.description':
    'Lista los movimientos bancarios filtrados por cuenta, rango de fechas, dirección, importe, texto, tipo y ' +
    'estado de cotejo',
  'help.bank.transaction.list.argument.query':
    'términos al estilo de hledger: desc:<texto>, amt:[>|<|>=|<=]<importe>; una palabra sin prefijo equivale a desc:',
  'help.bank.transaction.list.option.account': 'sólo esta cuenta bancaria (nombre o id)',
  'help.bank.transaction.list.option.since': 'movimientos en esta fecha o después (AAAA-MM-DD)',
  'help.bank.transaction.list.option.until': 'movimientos en esta fecha o antes (AAAA-MM-DD)',
  'help.bank.transaction.list.option.unmatched': 'sólo los movimientos sin cotejo vigente; atajo de -s unmatched',
  'help.bank.transaction.list.option.direction': 'dinero que entra (importe positivo) o que sale (importe negativo)',
  'help.bank.transaction.list.option.type': 'tipo de movimiento tal como lo clasificó el banco (no su dirección)',
  'help.bank.transaction.show.description':
    'Muestra un movimiento: la línea normalizada, el estado de cuenta del que vino y los cotejos vigentes que lo ' +
    'explican',
  'help.bank.transaction.show.argument.id': 'id del movimiento',
  'help.bank.transaction.show.option.raw':
    'incluye raw_data tal como lo publicó el banco; puede mostrar la contraparte sin enmascarar',
  'help.bank.transaction.reclassify.description':
    'Corrige qué tipo de línea es un movimiento bancario (comisión, interés, cargo, abono, ajuste); se rechaza si ' +
    'el signo no concuerda, si la línea está cotejada o si una póliza de tesorería ya la contabilizó',
  'help.bank.transaction.reclassify.argument.id': 'id del movimiento',
  'help.bank.transaction.reclassify.option.type': 'lo que la línea es en realidad',
  'help.bank.transaction.reclassify.option.reason': 'justificación que queda en el rastro de auditoría',
  'help.bank.transaction.reclassify.option.dry_run': 'corre todas las verificaciones y no escribe nada',
  'help.bank.transaction.reclassify.option.json': 'salida en JSON',
  // ==== MNE-001-232 · help by key, bank match, fee, interest, check and book-item (issue #314) ====
  'help.bank.book_item.description':
    'El otro lado: las líneas de póliza contabilizadas contra la cuenta de mayor del banco, todavía sin sellar',
  'help.bank.book_item.list.description':
    'Lista las líneas de póliza contabilizadas contra la cuenta de mayor del banco que siguen sin sellar, ' +
    'primero la más antigua, con su antigüedad',
  'help.bank.book_item.list.argument.account':
    'cuenta bancaria a cuya cuenta de mayor se contabilizaron las pólizas (nombre o id)',
  'help.bank.book_item.list.option.since': 'pólizas fechadas en este día o después (AAAA-MM-DD)',
  'help.bank.book_item.list.option.until': 'pólizas fechadas en este día o antes (AAAA-MM-DD)',
  'help.bank.book_item.list.option.over_days':
    'sólo lo que lleva MÁS de este número de días sin aparecer en el banco',
  'help.bank.match.description': 'El cotejo de un movimiento bancario contra lo que los libros ya dicen de él',
  'help.bank.match.preview.description':
    'Muestra lo que el motor propondría, con el puntaje desglosado en sus señales y el veredicto de cada ' +
    'compuerta, SIN aplicar nada',
  'help.bank.match.preview.argument.tx_id': 'un movimiento; sin él, todos los no cotejados de --account',
  'help.bank.match.preview.option.account': 'cuenta bancaria a recorrer cuando no se da el id de un movimiento',
  'help.bank.match.preview.option.since': 'movimientos en esta fecha o después (AAAA-MM-DD)',
  'help.bank.match.preview.option.until': 'movimientos en esta fecha o antes (AAAA-MM-DD)',
  'help.bank.match.preview.option.top': 'máximo de MOVIMIENTOS a previsualizar (no de candidatos por movimiento)',
  'help.bank.match.preview.option.min_confidence':
    'sube la confianza del motor que una propuesta necesita para que `run` la aplique (0..1); ' +
    'nunca por debajo del panel (cotejo_umbral_confianza)',
  'help.bank.match.preview.option.max_amount':
    'baja el techo de un cotejo automático; el panel (cotejo_monto_maximo_auto) y el piso inquebrantable ' +
    'siguen ganando',
  'help.bank.match.preview.option.rules_only':
    'una propuesta fuera de la ventana de fechas cuenta como no aplicable',
  'help.bank.match.run.description':
    'Corre el motor sobre una cuenta y un periodo, y aplica SÓLO lo que supera el umbral de confianza, ' +
    'respeta el piso de importe, cae en un periodo abierto y trae una señal dura de importe exacto',
  'help.bank.match.run.option.account': 'cuenta bancaria a recorrer (nombre o id)',
  'help.bank.match.run.option.since': 'movimientos en esta fecha o después (AAAA-MM-DD)',
  'help.bank.match.run.option.until': 'movimientos en esta fecha o antes (AAAA-MM-DD)',
  'help.bank.match.run.option.min_confidence':
    'sube la confianza del motor que una propuesta necesita para aplicarse (0..1); ' +
    'nunca por debajo del panel (cotejo_umbral_confianza)',
  'help.bank.match.run.option.max_amount':
    'baja el techo de un cotejo automático; el panel (cotejo_monto_maximo_auto) y el piso inquebrantable ' +
    'siguen ganando',
  'help.bank.match.run.option.rules_only': 'rechaza una propuesta fuera de la ventana de fechas',
  'help.bank.match.run.option.top': 'máximo de movimientos a evaluar en esta corrida',
  'help.bank.match.run.option.session': 'sesión de conciliación a la que pertenecen estos cotejos',
  'help.bank.match.run.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.match.run.option.json': 'salida en JSON',
  'help.bank.match.apply.description':
    'Aplica la propuesta del motor para los movimientos nombrados en UNA sola transacción, de forma ' +
    'idempotente y ligada a la sesión',
  'help.bank.match.apply.argument.id': 'ids de movimientos bancarios; o pásalos por --stdin',
  'help.bank.match.apply.option.stdin': 'lee los ids de la entrada estándar, separados por espacios en blanco',
  'help.bank.match.apply.option.session': 'sesión de conciliación a la que pertenecen estos cotejos',
  'help.bank.match.apply.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.match.apply.option.yes': 'omite la confirmación agrupada',
  'help.bank.match.apply.option.json': 'salida en JSON',
  'help.bank.match.create.description':
    'Construye un grupo de cotejo explícito de N movimientos bancarios contra M partidas de libros más ' +
    'ajustes, y exige Σbanco = Σlibros + Σajustes',
  'help.bank.match.create.option.account': 'cuenta bancaria a la que pertenece todo el grupo (nombre o id)',
  'help.bank.match.create.option.transaction': 'ids de movimientos bancarios separados por comas: el lado del banco',
  'help.bank.match.create.option.book_item':
    'el lado de libros, separado por comas: <id> para una línea de póliza, o <tipo>:<id> ({types})',
  'help.bank.match.create.option.adjust':
    'ajuste declarado (comisión bancaria, diferencia cambiaria); se puede repetir',
  'help.bank.match.create.option.residual': 'qué pasa con lo que sobra: dejarlo vivo, o cancelarlo contra una cuenta',
  'help.bank.match.create.option.write_off_account': 'cuenta de mayor contra la que se cancela el residual',
  'help.bank.match.create.option.session': 'sesión de conciliación a la que pertenece este grupo',
  'help.bank.match.create.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.match.create.option.json': 'salida en JSON',
  'help.bank.match.unapply.description':
    'Deshace un cotejo con un motivo tipificado y libera el sello de la partida de libros; se rehúsa si la ' +
    'sesión ya está aprobada o contabilizada, y no toca ninguna póliza contabilizada',
  'help.bank.match.unapply.argument.match_id': 'el cotejo a deshacer; todo su grupo se va con él',
  'help.bank.match.unapply.option.reason': 'motivo tipificado, obligatorio: {codes}',
  'help.bank.match.unapply.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.match.unapply.option.yes': 'omite la confirmación',
  'help.bank.match.unapply.option.json': 'salida en JSON',
  'help.bank.fee.description':
    'Las comisiones bancarias como acto contable: el cargo como gasto y su IVA pasado a acreditable en el mes ' +
    'del cargo',
  'help.bank.fee.post.description':
    'Contabiliza las comisiones bancarias del periodo a partir del estado de cuenta, una póliza por cargo, y ' +
    'pasa su IVA de pendiente de acreditar a acreditable',
  'help.bank.fee.post.argument.account': 'cuenta bancaria cuyas comisiones se contabilizan (nombre o id)',
  'help.bank.fee.post.option.period': 'mes cuyas comisiones se contabilizan',
  'help.bank.fee.post.option.iva_rate':
    'tasa de IVA que el cargo ya trae DENTRO, como fracción (0.16 para el 16%); 0 para una comisión exenta. ' +
    'Sin valor por omisión: uno aquí sería una decisión fiscal que nadie toma y nadie ve',
  'help.bank.fee.post.option.max_amount':
    'por encima de esta magnitud el cargo se omite y se le deja a una persona; es una compuerta de ' +
    'confianza, no una validación',
  'help.bank.fee.post.option.json': 'salida en JSON',
  'help.bank.interest.description':
    'Los intereses ganados sobre saldos bancarios: el ingreso por su importe BRUTO y el impuesto que retuvo ' +
    'el banco como pago provisional a favor de la entidad',
  'help.bank.interest.post.description':
    'Contabiliza los intereses del periodo como ingreso y el ISR que retuvo el banco como pago provisional ' +
    'a favor de la entidad, nunca como gasto',
  'help.bank.interest.post.argument.account': 'cuenta bancaria cuyos intereses se contabilizan (nombre o id)',
  'help.bank.interest.post.option.period': 'mes cuyos intereses se contabilizan',
  'help.bank.interest.post.option.rate':
    'tasa de RETENCIÓN de ISR que aplicó el banco, como fracción (0.0125 para el 1.25%); 0 si no retuvo ' +
    'nada. NO es la tasa de interés: el interés es el que dice el estado de cuenta',
  'help.bank.interest.post.option.json': 'salida en JSON',
  'help.bank.check.description':
    'Los cheques en papel como hecho fiscal: cuándo el banco pagó de verdad un cheque, que bajo la LIVA es ' +
    'cuando el pago se entiende efectuado',
  'help.bank.check.reconcile.description':
    'Prueba el cheque contra el movimiento bancario que lo cobró y contabiliza su IVA EN EL MES DEL COBRO: de ' +
    'pendiente de acreditar a acreditable en un pago a proveedor, de no cobrado a trasladado en un cobro de cliente',
  'help.bank.check.reconcile.argument.id': 'pago a proveedor hecho con cheque; se omite con --receipt',
  'help.bank.check.reconcile.option.receipt':
    'cobro de cliente pagado con cheque, por folio (PMT-2026-00042) o id, en lugar de <id>; sin ' +
    '--transaction el abono de su importe se busca en su cuenta bancaria desde su fecha. Se repite para ' +
    'un depósito de varios cheques: un solo abono de exactamente su suma, nombrado con --transaction',
  'help.bank.check.reconcile.option.transaction':
    'el movimiento bancario que lo pagó, nombrado a mano; obligatorio cuando coinciden varios cargos',
  'help.bank.check.reconcile.option.as_of':
    'la fecha de cobro que afirmas (AAAA-MM-DD); se CONTRASTA contra el movimiento, nunca se impone — el ' +
    'cobro lo fecha el banco',
  'help.bank.check.reconcile.option.json': 'salida en JSON',
  // ==== MNE-001-233 · help by key, bank reconciliation, reconciling-item and adjustment (issue #314) ====
  'help.bank.reconciliation.description':
    'La sesión de conciliación: la aritmética de dos lados que hace que `balanced` signifique algo',
  'help.bank.reconciliation.run.description':
    'Pase guiado del mes sobre una cuenta: estado de cuenta, motor de cotejo, sesión y partidas ' +
    'conciliatorias; SIEMPRE se detiene antes de `approve` y `post`, e imprime lo que falta',
  'help.bank.reconciliation.run.argument.account': 'cuenta bancaria a conciliar (nombre o id)',
  'help.bank.reconciliation.run.option.period': 'periodo a conciliar; o pasa --since y --until juntas',
  'help.bank.reconciliation.run.option.since': 'primer día del periodo (AAAA-MM-DD)',
  'help.bank.reconciliation.run.option.until': 'último día del periodo (AAAA-MM-DD)',
  'help.bank.reconciliation.run.option.file':
    'estado de cuenta a importar primero; sin él, se usa el que ya está importado para el periodo',
  'help.bank.reconciliation.run.option.format':
    'formato del ARCHIVO de --file (no de la salida; para eso está --json), como en `bank statement import`',
  'help.bank.reconciliation.run.option.profile': 'perfil de columnas CSV con el que se lee --file',
  'help.bank.reconciliation.run.option.min_confidence':
    'sube la confianza del motor que una propuesta necesita para aplicarse (0..1); ' +
    'nunca por debajo del panel (cotejo_umbral_confianza)',
  'help.bank.reconciliation.run.option.max_amount':
    'baja el techo de un cotejo automático; el panel (cotejo_monto_maximo_auto) y el piso inquebrantable ' +
    'siguen ganando',
  'help.bank.reconciliation.run.option.stop_at':
    'se detiene después de este paso; nunca pasa de `estado`, y nunca llega a `approve` ni a `post`',
  'help.bank.reconciliation.run.option.resume':
    'continúa la sesión ya abierta de este periodo en vez de rehusarse',
  'help.bank.reconciliation.run.option.dry_run': 'recorre el camino real y luego lo deshace',
  'help.bank.reconciliation.run.option.json': 'salida en JSON',
  'help.bank.reconciliation.open.description':
    'Abre la sesión del periodo aseverando que el saldo inicial es igual al cierre de la sesión anterior y ' +
    'rechazando los huecos y los traslapes de fechas',
  'help.bank.reconciliation.open.argument.account': 'cuenta bancaria sobre la que se abre la sesión (nombre o id)',
  'help.bank.reconciliation.open.option.period': 'periodo de la sesión; o pasa --since y --until juntas',
  'help.bank.reconciliation.open.option.since': 'primer día del periodo (AAAA-MM-DD)',
  'help.bank.reconciliation.open.option.until': 'último día del periodo (AAAA-MM-DD)',
  'help.bank.reconciliation.open.option.closing_balance':
    'saldo final que afirmas; se COMPARA contra el estado de cuenta, nunca lo sustituye',
  'help.bank.reconciliation.open.option.statement':
    'el estado de cuenta al que se ata la sesión, cuando el periodo tiene más de uno',
  'help.bank.reconciliation.open.option.baseline':
    'sólo en la primera sesión: el saldo conciliado del que parte la cuenta; se rechaza si no coincide ' +
    'con los libros a la fecha de --baseline-date',
  'help.bank.reconciliation.open.option.baseline_date':
    'fecha de --baseline (AAAA-MM-DD); por omisión, el día anterior al periodo',
  'help.bank.reconciliation.open.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.reconciliation.open.option.json': 'salida en JSON',
  'help.bank.reconciliation.list.description':
    'Lista las sesiones por cuenta, estado y periodo, con la variación CONGELADA y cuántas partidas siguen ' +
    'abiertas',
  'help.bank.reconciliation.list.option.account': 'sólo las sesiones de esta cuenta bancaria (nombre o id)',
  'help.bank.reconciliation.list.option.period': 'sesiones que se traslapan con este periodo',
  'help.bank.reconciliation.list.option.since': 'sesiones que terminan en esta fecha o después (AAAA-MM-DD)',
  'help.bank.reconciliation.list.option.until': 'sesiones que empiezan en esta fecha o antes (AAAA-MM-DD)',
  'help.bank.reconciliation.list.option.all_entities':
    'todas las entidades del inquilino, para una vista de conjunto del despacho; el alcance sigue acotado dentro del SQL',
  'help.bank.reconciliation.status.description':
    'Recalcula la variación EN VIVO e imprime el desglose de los dos lados: saldo del banco, sus partidas una ' +
    'por una, ajustado; saldo de libros, sus partidas, ajustado; y la diferencia',
  'help.bank.reconciliation.status.argument.session': 'id de la sesión; sin él, la que está en curso en --account',
  'help.bank.reconciliation.status.option.account': 'cuenta bancaria cuya sesión en curso se lee (nombre o id)',
  'help.bank.reconciliation.status.option.tolerance':
    'residuo que el cierre puede absorber; sólo vale donde la política de tolerancia admite uno',
  'help.bank.reconciliation.close.description':
    'Recalcula la aritmética completa y pasa la sesión a `balanced` SÓLO si la variación es exactamente cero ' +
    '(o queda dentro de la tolerancia de la política) y toda partida está clasificada y fechada',
  'help.bank.reconciliation.close.argument.session': 'sesión a cerrar',
  'help.bank.reconciliation.close.option.tolerance':
    'residuo que este cierre puede absorber; se rechaza si la política de tolerancia no admite uno',
  'help.bank.reconciliation.close.option.dry_run': 'lo hace todo y luego lo deshace',
  'help.bank.reconciliation.close.option.yes': 'omite la confirmación',
  'help.bank.reconciliation.close.option.json': 'salida en JSON',
  'help.bank.reconciliation.approve.description':
    'Firma la sesión exigiendo que el aprobador no sea el preparador, y congela una instantánea inmutable con ' +
    'un hash de sus miembros y de sus saldos',
  'help.bank.reconciliation.approve.argument.session': 'sesión cuadrada a firmar',
  'help.bank.reconciliation.approve.option.reason':
    'por qué se firma; queda en la sesión y en el rastro de auditoría',
  'help.bank.reconciliation.approve.option.json': 'salida en JSON',
  'help.bank.reconciliation.reopen.description':
    'Reabre una sesión aprobada o contabilizada y la regresa a in_progress, retira su firma (el rastro de ' +
    'auditoría la conserva) y revierte los asientos que contabilizó un `post`; se rechaza si la cubre un ' +
    'periodo fiscal cerrado',
  'help.bank.reconciliation.reopen.argument.session': 'sesión aprobada o contabilizada a reabrir',
  'help.bank.reconciliation.reopen.option.json': 'salida en JSON',
  'help.bank.reconciliation.post.description':
    'Contabiliza los asientos de ajuste aprobados y sella como conciliadas las líneas de libros de la sesión, ' +
    'bloqueando su edición, su cancelación y su cambio de fecha',
  'help.bank.reconciliation.post.argument.session': 'sesión aprobada a contabilizar',
  'help.bank.reconciliation.post.option.json': 'salida en JSON',
  'help.bank.reconciliation.generate.description':
    'Genera el estado de conciliación bancaria de dos lados para el expediente de auditoría: json para el ' +
    'documento entero, md/csv/tsv para el estado en renglones, texto plano para imprimir',
  'help.bank.reconciliation.generate.argument.session': 'sesión de la que se escribe el estado de conciliación',
  'help.bank.reconciling_item.description':
    'Las partidas conciliatorias como renglones: lo que explica la diferencia, con antigüedad, responsable, ' +
    'fecha esperada y escalamiento',
  'help.bank.reconciling_item.list.description':
    'Lista las partidas conciliatorias tipificadas de una sesión —cheques en circulación, depósitos en ' +
    'tránsito, cargos del banco, errores— con antigüedad, responsable, fecha esperada de liquidación y ' +
    'escalamiento',
  'help.bank.reconciling_item.list.argument.session': 'id de la sesión de conciliación',
  'help.bank.reconciling_item.list.option.type': 'sólo las partidas de este tipo: {types}',
  'help.bank.reconciling_item.list.option.over_days': 'sólo lo que lleva MÁS de este número de días desde su fecha',
  'help.bank.reconciling_item.assign.description':
    'Asigna a una partida conciliatoria un responsable, una fecha esperada de liquidación y notas',
  'help.bank.reconciling_item.assign.argument.session': 'id de la sesión de conciliación',
  'help.bank.reconciling_item.assign.argument.item': 'id de la partida conciliatoria',
  'help.bank.reconciling_item.assign.option.owner': 'quién persigue esta partida',
  'help.bank.reconciling_item.assign.option.expected': 'fecha esperada de liquidación (AAAA-MM-DD)',
  'help.bank.reconciling_item.assign.option.clear_expected': 'quita la fecha esperada en vez de fijar una',
  'help.bank.reconciling_item.assign.option.escalation': 'estado de escalamiento: {values}',
  'help.bank.reconciling_item.assign.option.note': 'nota que se guarda con la partida',
  'help.bank.reconciling_item.assign.option.json': 'salida en JSON',
  'help.bank.reconciling_item.correct.description':
    'Dice qué era de verdad una partida conciliatoria, cuando la propuesta automática se equivocó',
  'help.bank.reconciling_item.correct.argument.session': 'id de la sesión de conciliación',
  'help.bank.reconciling_item.correct.argument.item': 'id de la partida conciliatoria',
  'help.bank.reconciling_item.correct.option.type': 'lo que es en realidad: {types}',
  'help.bank.reconciling_item.correct.option.amount':
    'su nueva aportación a la conciliación; obligatoria cuando el tipo cambia de lado',
  'help.bank.reconciling_item.correct.option.json': 'salida en JSON',
  'help.bank.adjustment.description':
    'Las comisiones, el IVA, los intereses y las retenciones que una conciliación descubre, creados como ' +
    'BORRADORES',
  'help.bank.adjustment.create.description':
    'Crea la comisión, el IVA, los intereses, la retención de ISR o la corrección de un error que se encontró ' +
    'en la sesión COMO BORRADOR en espera de `mnemosine review`; nunca contabiliza nada por su cuenta',
  'help.bank.adjustment.create.argument.session': 'sesión de conciliación a la que pertenece el ajuste',
  'help.bank.adjustment.create.option.type': 'qué es el ajuste',
  'help.bank.adjustment.create.option.amount':
    'CON SIGNO según su efecto en la cuenta bancaria: negativo es lo que sale de la cuenta, positivo lo que ' +
    'entra',
  'help.bank.adjustment.create.option.gl_account':
    'cuenta de mayor de la contrapartida; obligatoria para los tipos cuyo rol contable todavía no está ' +
    'sembrado ({types})',
  'help.bank.adjustment.create.option.item': 'la partida conciliatoria que este ajuste explica',
  'help.bank.adjustment.create.option.json': 'salida en JSON',
  // ==== MNE-001-236 · help by key, invoice and customer (issue #314) ====
  'help.invoice.description':
    'Facturas de clientes: capturarlas en borrador, revisarlas, emitirlas al mayor y anularlas (aquí nunca se timbran)',
  'help.invoice.list.description': 'Lista facturas por cliente, estado, periodo o días de atraso',
  'help.invoice.list.argument.search': 'texto que se busca en el folio de la factura o en el nombre del cliente',
  'help.invoice.list.option.customer': 'sólo este cliente (número, nombre o id)',
  'help.invoice.list.option.overdue_days': 'sólo las facturas abiertas con al menos este número de días de atraso',
  'help.invoice.show.description': 'Muestra una factura con sus líneas, el efectivo aplicado y su póliza',
  'help.invoice.show.argument.ref': 'folio de la factura (INV-2026-00042) o id',
  'help.invoice.create.description':
    'Crea una factura en BORRADOR desde cero: un documento local, ni contabilizado ni timbrado',
  'help.invoice.create.option.customer': 'número, nombre o id del cliente',
  'help.invoice.create.option.line':
    'una línea: "account=4100;qty=2;price=1500;tax-rate=16;description=…". tax-rate= es una TASA en % ' +
    '(16 quiere decir 16%), no un importe. La lista de claves está abajo',
  'help.invoice.create.option.from_file': 'arreglo JSON de líneas en vez de repetir --line',
  'help.invoice.create.option.date': 'fecha de la factura (AAAA-MM-DD); por omisión, hoy',
  'help.invoice.create.option.due_date':
    'fecha de vencimiento; por omisión, la que resulta de las condiciones de pago del cliente',
  'help.invoice.create.option.currency': 'moneda de facturación; por omisión, la del cliente',
  'help.invoice.create.option.terms': 'condiciones de pago que se imprimen en el documento',
  'help.invoice.create.option.memo': 'observaciones',
  'help.invoice.create.option.po_number': 'la orden de compra del cliente contra la que se factura',
  'help.invoice.create.option.json': 'salida en JSON',
  'help.invoice.issue.description':
    'Emite una factura: contabiliza cargo a cuentas por cobrar / abono a ingresos / abono a IVA trasladado. ' +
    'No la timbra ni la entrega',
  'help.invoice.issue.argument.ref': 'folio de la factura o id',
  'help.invoice.issue.option.json': 'salida en JSON',
  'help.invoice.void.description':
    'Anula una factura local y revierte su póliza; se niega si está timbrada o cobrada',
  'help.invoice.void.argument.ref': 'folio de la factura o id',
  'help.invoice.void.option.json': 'salida en JSON',
  'help.invoice.edit.description':
    'Edita una factura en BORRADOR: fechas, observaciones o sus líneas (las emitidas se anulan o se corrigen ' +
    'con una nota de crédito, nunca se editan)',
  'help.invoice.edit.argument.ref': 'folio de la factura o id',
  'help.invoice.edit.option.line':
    'REEMPLAZA todas las líneas: "account=4100;qty=2;price=1500;tax-rate=16;…" (se puede repetir). ' +
    'La lista de claves está en invoice create --help',
  'help.invoice.edit.option.from_file': 'arreglo JSON de líneas en vez de repetir --line',
  'help.invoice.edit.option.date': 'nueva fecha de la factura (AAAA-MM-DD)',
  'help.invoice.edit.option.due_date': 'nueva fecha de vencimiento',
  'help.invoice.edit.option.memo': 'nuevas observaciones',
  'help.invoice.edit.option.po_number': 'nueva referencia de la orden de compra',
  'help.invoice.edit.option.json': 'salida en JSON',
  'help.invoice.delete.description':
    'Elimina un BORRADOR que nunca tocó el mayor; su folio queda como un hueco documentado',
  'help.invoice.delete.argument.ref': 'folio de la factura o id',
  'help.invoice.delete.option.json': 'salida en JSON',
  'help.invoice.series.description':
    'Series de folios: los contadores de los que esta entidad toma el folio de cada documento',
  'help.invoice.series.list.description': 'Lista los contadores de folios, el último folio emitido y el siguiente',
  'help.invoice.series.check.description':
    'Reporta los huecos de la serie de folios de las facturas; un hueco con rastro de auditoría está explicado, ' +
    'uno sin él es un hallazgo',
  'help.invoice.series.check.option.year': 'sólo este ejercicio fiscal de la serie',
  'help.invoice.series.check.option.strict': 'sale con 4 aunque todos los huecos estén explicados',
  'help.customer.description': 'Clientes: el archivo maestro de cuentas por cobrar, con el saldo que debe cada uno',
  'help.customer.list.description':
    'Lista los clientes con sus condiciones de pago, su estado de crédito y el saldo que deben',
  'help.customer.list.argument.query': 'texto que se busca en el nombre o en el número del cliente',
  'help.customer.list.option.overdue': 'sólo los clientes con algo vencido',
  'help.customer.list.option.balance_gt': 'sólo los clientes que deben más de este importe',
  'help.customer.list.option.inactive': 'muestra los clientes archivados en vez de los activos',
  'help.customer.show.description':
    'Muestra un cliente: perfil, identificador fiscal, crédito, saldo y documentos abiertos',
  'help.customer.show.argument.ref': 'número, nombre o id del cliente',
  'help.customer.create.description':
    'Da de alta un cliente con su identificador fiscal, sus condiciones de pago y su moneda',
  'help.customer.create.option.name': 'razón social',
  'help.customer.create.option.first_name': 'nombre de pila, para una persona física',
  'help.customer.create.option.last_name': 'apellidos, para una persona física',
  'help.customer.create.option.tax_id': 'RFC (MX), EIN (EE. UU.) o número de IVA (VAT)',
  'help.customer.create.option.tax_id_type': 'uno de: {types}; se infiere del país de la entidad',
  'help.customer.create.option.email': 'correo del contacto de facturación',
  'help.customer.create.option.phone': 'teléfono de contacto',
  'help.customer.create.option.terms': 'condiciones de pago, p. ej. "Net 30"',
  'help.customer.create.option.currency': 'moneda de facturación (3 letras)',
  'help.customer.create.option.json': 'salida en JSON',
  'help.customer.edit.description':
    'Cambia los datos comerciales y de contacto; nunca el perfil fiscal ni los datos de crédito',
  'help.customer.edit.argument.ref': 'número, nombre o id del cliente',
  'help.customer.edit.option.name': 'nueva razón social',
  'help.customer.edit.option.first_name': 'nuevo nombre de pila',
  'help.customer.edit.option.last_name': 'nuevos apellidos',
  'help.customer.edit.option.email': 'nuevo correo de facturación',
  'help.customer.edit.option.phone': 'nuevo teléfono',
  'help.customer.edit.option.terms': 'nuevas condiciones de pago',
  'help.customer.edit.option.notes': 'notas libres que se guardan con el cliente',
  'help.customer.edit.option.reason': 'justificación que queda en el rastro de auditoría',
  'help.customer.archive.description': 'Desactiva un cliente; se rechaza mientras siga debiendo algo',
  'help.customer.archive.argument.ref': 'número, nombre o id del cliente',
  'help.customer.restore.description': 'Reactiva un cliente archivado',
  'help.customer.restore.argument.ref': 'número, nombre o id del cliente',
  'help.customer.restore.option.reason': 'justificación que queda en el rastro de auditoría',
  'help.customer.tax.description':
    'El perfil fiscal contra el que se timbra el CFDI 4.0: RFC, régimen fiscal, código postal y UsoCFDI',
  'help.customer.tax.show.description':
    'Muestra el perfil fiscal y lo que falta para poder timbrarle un CFDI a este cliente',
  'help.customer.tax.show.argument.ref': 'número, nombre o id del cliente',
  'help.customer.tax.set.description':
    'Fija el RFC, el régimen fiscal, el código postal o el UsoCFDI y los valida contra los catálogos del SAT ' +
    'antes de escribir',
  'help.customer.tax.set.argument.ref': 'número, nombre o id del cliente',
  'help.customer.tax.set.option.rfc': 'el RFC (se valida su forma: {shape})',
  'help.customer.tax.set.option.tax_regime': 'código de c_RegimenFiscal: 601, 612, 626…',
  'help.customer.tax.set.option.postal_code': 'código postal del domicilio fiscal (5 dígitos)',
  'help.customer.tax.set.option.uso_cfdi': 'c_UsoCFDI por omisión: G01, G03, P01…',
  'help.customer.tax.set.option.reason': 'justificación que queda en el rastro de auditoría',
  'help.customer.tax.set.option.json': 'salida en JSON',
  'help.customer.tax.list.description':
    'El control previo a facturar: clientes cuyo perfil fiscal está incompleto o mal formado',
  'help.customer.tax.list.option.missing': 'sólo los clientes a los que hoy NO se les podría timbrar un CFDI',
  // ==== MNE-001-237 · help by key, receipt, credit-note and rep (issue #314) ====
  'help.receipt.description':
    'Cobros a clientes: registrar el dinero, aplicar el saldo a cuenta, desaplicar y reversar cheques devueltos',
  'help.receipt.record.option.amount': 'importe, en la moneda del documento',
  'help.receipt.record.option.date': 'fecha valor (AAAA-MM-DD); por omisión, hoy',
  'help.receipt.record.option.method': 'forma de pago, una de: cash, check, ach, wire, spei, credit_card, other',
  'help.receipt.record.option.bank':
    'nombre o id de la cuenta bancaria; sin ella se usa la cuenta del rol `banco` de la entidad',
  'help.receipt.record.option.reference': 'referencia bancaria o número de transferencia',
  'help.receipt.record.option.json': 'salida en JSON',
  'help.receipt.show.description':
    'Muestra un cobro: sus aplicaciones (vigentes e historial), el estado de su REP y su póliza',
  'help.receipt.show.argument.ref': 'número del cobro (PMT-2026-00042) o id',
  'help.receipt.list.description': 'Lista cobros por cliente, fecha, estado de aplicación o REP faltante',
  'help.receipt.list.option.customer': 'sólo este cliente (número, nombre o id)',
  'help.receipt.list.option.unapplied': 'sólo los cobros con un remanente a cuenta',
  'help.receipt.list.option.needs_rep': 'sólo los cobros completados sin un REP ligado',
  'help.receipt.apply.argument.ref': 'número o id del cobro',
  'help.receipt.apply.option.invoice':
    'factura con importe: "INV-2026-00042:2500" (repetible), o sólo el folio junto con --amount',
  'help.receipt.apply.option.amount': 'importe para una sola --invoice que no trae importe',
  'help.receipt.apply.option.json': 'salida en JSON',
  'help.receipt.unapply.description':
    'Desaplica un cobro de una factura como un evento NUEVO: la reabre y devuelve el dinero al saldo a cuenta',
  'help.receipt.unapply.argument.ref': 'número o id del cobro',
  'help.receipt.unapply.option.invoice': 'la factura de la que se desaplica',
  'help.receipt.unapply.option.reason': 'por qué: queda en el rastro de auditoría y en la descripción de la póliza',
  'help.receipt.unapply.option.json': 'salida en JSON',
  'help.receipt.reverse.argument.ref': 'número o id del cobro',
  'help.receipt.reverse.option.fee':
    'comisión bancaria cobrada por la devolución (aún no se admite: necesita una cuenta con el rol de comisiones)',
  'help.receipt.reverse.option.json': 'salida en JSON',
  'help.credit_note.description':
    'Notas de crédito: devoluciones, descuentos y correcciones contra la cuenta por cobrar (aquí nunca se timbran)',
  'help.credit_note.create.description':
    'Crea una nota de crédito en BORRADOR, ligada a su factura (vínculo fiscal) o suelta con un cliente explícito',
  'help.credit_note.create.option.type': 'uno de: {types}',
  'help.credit_note.create.option.amount': 'subtotal del crédito, antes de impuestos',
  'help.credit_note.create.option.tax': 'parte de impuesto (IVA) del crédito',
  'help.credit_note.create.option.invoice':
    'la factura que acredita esta nota (recomendado: de ella depende el lado del IVA)',
  'help.credit_note.create.option.customer': 'el cliente, cuando no hay factura ligada',
  'help.credit_note.create.option.relates_to': 'UUID del CFDI original, cuando la factura no está en el sistema',
  'help.credit_note.create.option.date':
    'fecha del crédito (AAAA-MM-DD); por omisión, hoy en la zona de la política zona_horaria',
  'help.credit_note.create.option.memo': 'observaciones',
  'help.credit_note.create.option.json': 'salida en JSON',
  'help.credit_note.show.description':
    'Muestra una nota de crédito con sus aplicaciones, su saldo disponible y su póliza',
  'help.credit_note.show.argument.ref': 'número de la nota de crédito (CN-2026-00042) o id',
  'help.credit_note.list.description': 'Lista notas de crédito por cliente, tipo, estado o saldo sin aplicar',
  'help.credit_note.list.option.customer': 'sólo este cliente (número, nombre o id)',
  'help.credit_note.list.option.type': 'sólo este tipo: {types}',
  'help.credit_note.list.option.open':
    'sólo las notas emitidas con saldo por aplicar (el crédito vigente del cliente)',
  'help.credit_note.issue.description':
    'Emite la nota: postea cargo a devoluciones + cargo al IVA / abono a clientes. No timbra',
  'help.credit_note.issue.argument.ref': 'número o id de la nota de crédito',
  'help.credit_note.issue.option.json': 'salida en JSON',
  'help.credit_note.apply.description':
    'Aplica una nota emitida a facturas; lo que no se aplica queda como crédito del cliente',
  'help.credit_note.apply.argument.ref': 'número o id de la nota de crédito',
  'help.credit_note.apply.option.invoice':
    'factura con importe: "INV-2026-00042:2500" (repetible), o sólo el folio junto con --amount',
  'help.credit_note.apply.option.amount': 'importe para una sola --invoice que no trae importe',
  'help.credit_note.apply.option.dry_run': 'recorre el camino real y lo revierte al final',
  'help.credit_note.apply.option.json': 'salida en JSON',
  'help.rep.description': 'Complementos de pago (REP): a qué le falta uno, y los aparcados por reintentar',
  'help.rep.missing.description': 'Pagos y cobros cuyo REP no ha llegado o no se ha emitido',
  'help.rep.missing.list.description':
    'received: facturas PPD de proveedor pagadas sin el REP del proveedor (el REP sostiene el acreditamiento del IVA); issued: nuestros cobros sin REP',
  'help.rep.missing.list.option.direction': 'received (por omisión) o issued',
  'help.rep.missing.list.option.min_amount': 'sólo los pagos de este importe o más',
  'help.rep.reconcile.description':
    'Reintenta los REP aparcados (needs_review): se puede repetir sin riesgo, y los nodos ya resueltos se saltan',
  'help.rep.reconcile.option.limit': 'máximo de REP aparcados que se reintentan',
  'help.rep.reconcile.option.dry_run': 'lista lo que se reintentaría, sin reintentar nada',
  // ==== MNE-001-238 · help by key, bill and vendor (issue #314) ====
  'help.bill.description': 'Facturas de proveedor: capturar, codificar, revisar y aprobar lo que debemos',
  'help.bill.list.description':
    'Lista las facturas de proveedor filtradas por proveedor, estado, fecha del documento, fecha contable ' +
    'o fecha de vencimiento',
  'help.bill.list.argument.search':
    'texto que se busca en el número propio, en el folio del proveedor o en el nombre del proveedor',
  'help.bill.list.option.vendor': 'sólo este proveedor (número, nombre o id)',
  'help.bill.list.option.due_before': 'sólo las facturas que vencen en esta fecha o antes (AAAA-MM-DD)',
  'help.bill.list.option.open':
    'sólo las facturas con saldo por pagar (excluye las pagadas, las anuladas y las canceladas)',
  'help.bill.show.description':
    'Muestra una factura de proveedor con sus líneas, su póliza y el CFDI del que proviene',
  'help.bill.show.argument.bill': 'número propio, folio del proveedor o id',
  'help.bill.show.option.no_lines': 'sólo el encabezado',
  'help.bill.show.option.journal': 'incluye la póliza que generó la aprobación',
  'help.bill.show.option.cfdi': 'incluye el CFDI del que proviene la factura, cuando proviene de uno',
  'help.bill.create.description': 'Captura una factura de proveedor con sus líneas y su codificación contable',
  'help.bill.create.argument.vendor': 'número, nombre o id del proveedor',
  'help.bill.create.option.vendor': 'número, nombre o id del proveedor (lo mismo que el argumento posicional)',
  'help.bill.create.option.vendor_invoice_number': 'el número o folio que el propio proveedor le dio a su factura',
  'help.bill.create.option.bill_date': 'fecha del documento (AAAA-MM-DD); por omisión, hoy',
  'help.bill.create.option.due_date':
    'fecha de vencimiento (AAAA-MM-DD); por omisión, la que resulta de las condiciones de pago del proveedor',
  'help.bill.create.option.line':
    'una línea, se puede repetir: "account=5100;qty=1;price=1000;tax-amount=160". La lista de claves está abajo',
  'help.bill.create.option.currency': 'código ISO de 3 letras; por omisión, la moneda del proveedor',
  'help.bill.create.option.terms':
    'condiciones de pago que se registran en la factura; por omisión, las del proveedor',
  'help.bill.create.option.description': 'a qué corresponde esta factura',
  'help.bill.create.option.from_file': 'lee la factura de un archivo JSON en lugar de teclearla: {shape}',
  'help.bill.create.option.json': 'salida en JSON',
  'help.bill.line.description': 'Codificación de las líneas',
  'help.bill.line.set.description': 'Recodifica una línea de una factura que todavía no está aprobada',
  'help.bill.line.set.argument.bill': 'número propio, folio del proveedor o id',
  'help.bill.line.set.option.line': 'número de la línea que se cambia',
  'help.bill.line.set.option.account': 'cuenta de gasto, por código',
  'help.bill.line.set.option.cost_center': 'id del centro de costo',
  'help.bill.line.set.option.project': 'id del proyecto',
  'help.bill.line.set.option.description': 'descripción de la línea',
  'help.bill.approve.description':
    'Aprueba una factura de proveedor y reconoce el pasivo en el mayor (cargo a gasto e IVA / abono a ' +
    'cuentas por pagar)',
  'help.bill.approve.argument.bill': 'número propio, folio del proveedor o id',
  'help.bill.approve.option.json': 'salida en JSON',
  'help.bill.inbox.description':
    'Bandeja de CFDI recibidos: pre-registros que esperan convertirse en facturas de proveedor',
  'help.bill.inbox.list.description': 'La cola de CFDI: qué llegó, de quién es y qué lo detiene',
  'help.bill.inbox.list.option.processing_mode': 'cómo debe procesarse: {modes}',
  'help.bill.inbox.list.option.requires_approval': 'sólo los que esperan una aprobación previa',
  'help.bill.inbox.list.option.vendor': 'sólo este proveedor (número, nombre o id)',
  'help.bill.inbox.edit.description':
    'Codifica a mano un pre-registro: la cuenta (y el centro de costo) de una línea, o su cuenta por omisión',
  'help.bill.inbox.edit.argument.id': 'un pre-registro, por su id',
  'help.bill.inbox.edit.option.line':
    'número de la línea que se codifica; sin él, --account es la cuenta por omisión de toda línea que no tenga una',
  'help.bill.inbox.edit.option.account':
    'cuenta de gasto, por código o id; para un CFDI que emitió esta entidad, la cuenta de ingresos',
  'help.bill.inbox.edit.option.cost_center': 'id del centro de costo de la línea de --line',
  'help.bill.inbox.run.description':
    'Convierte pre-registros en facturas de proveedor, o los aprueba, rechaza y programa en masa',
  'help.bill.inbox.run.argument.id': 'un pre-registro, por su id',
  'help.bill.inbox.run.option.action': 'qué hacer con la selección',
  'help.bill.inbox.run.option.bulk': 'actúa sobre todo lo que selecciona --query, en vez de un solo id',
  'help.bill.inbox.run.option.query': 'selección para --bulk, en pares clave=valor separados por comas: {keys}',
  'help.bill.inbox.run.option.batch':
    'lote de procesamiento en el que se programa; obligatorio con --action set-batch',
  'help.bill.inbox.run.option.allow_new_vendor':
    'autoriza dar de alta como proveedor al emisor del CFDI cuando no está en el catálogo; sin esta bandera, ' +
    'esos CFDI se rechazan',
  'help.bill.inbox.run.option.reason': 'por qué se rechaza; obligatorio con --action reject',
  'help.bill.inbox.run.option.note': 'anotación que se guarda con la aprobación',
  'help.bill.inbox.run.option.dry_run': 'calcula y muestra el efecto completo; no escribe nada',
  'help.bill.inbox.run.option.json': 'salida en JSON',
  'help.vendor.description':
    'Catálogo de proveedores: a quién le debemos, en qué condiciones de pago y con qué identificador fiscal',
  'help.vendor.list.description':
    'Lista los proveedores, filtrados por estado, por la bandera 1099 o por la falta de identificador fiscal',
  'help.vendor.list.argument.search': 'texto que se busca en la razón social o en el número del proveedor',
  'help.vendor.list.option.inactive': 'muestra los proveedores archivados en vez de los activos',
  'help.vendor.list.option.is_1099': 'sólo los proveedores marcados para una declaración informativa de EE. UU.',
  'help.vendor.list.option.no_tax_id':
    'sólo los proveedores sin identificador fiscal registrado (los que bloquean la DIOT y el 1099)',
  'help.vendor.show.description': 'Muestra un proveedor: identidad, condiciones de pago, moneda y banderas',
  'help.vendor.show.argument.vendor': 'número, nombre o id del proveedor',
  'help.vendor.show.option.include': 'secciones adicionales, separadas por comas: {parts}',
  'help.vendor.create.description':
    'Da de alta un proveedor con su identificador fiscal, sus condiciones de pago, su moneda y su cuenta de ' +
    'gasto por omisión',
  'help.vendor.create.argument.name': 'razón social',
  'help.vendor.create.option.tax_id': 'RFC (México), EIN (EE. UU.) o número de IVA (VAT)',
  'help.vendor.create.option.tax_id_type': '{types} (por omisión, según el país de la entidad)',
  'help.vendor.create.option.contact': 'persona de contacto',
  'help.vendor.create.option.email': 'correo de contacto',
  'help.vendor.create.option.phone': 'teléfono de contacto',
  'help.vendor.create.option.terms': 'condiciones de pago: "Net 30", "2/10 Net 30", "Due on receipt"',
  'help.vendor.create.option.currency': 'código ISO de 3 letras (por omisión, la moneda funcional de la entidad)',
  'help.vendor.create.option.default_account': 'cuenta de gasto por omisión, por código',
  'help.vendor.create.option.is_1099': 'marca al proveedor para una declaración informativa de EE. UU.',
  'help.vendor.create.option.json': 'salida en JSON',
  'help.vendor.edit.description':
    'Cambia los datos no bancarios ni fiscales de un proveedor, y deja un registro de auditoría',
  'help.vendor.edit.argument.vendor': 'número, nombre o id del proveedor',
  'help.vendor.edit.option.name': 'nueva razón social',
  'help.vendor.edit.option.contact': 'nueva persona de contacto',
  'help.vendor.edit.option.email': 'nuevo correo',
  'help.vendor.edit.option.phone': 'nuevo teléfono',
  'help.vendor.edit.option.notes': 'reemplaza las notas',
  'help.vendor.edit.option.reason': 'por qué se hizo el cambio; queda en el rastro de auditoría',
  'help.vendor.terms.description': 'Condiciones de pago',
  'help.vendor.terms.set.description':
    'Fija las condiciones de pago y la moneda de liquidación, validadas para que se pueda calcular una fecha ' +
    'de vencimiento',
  'help.vendor.terms.set.argument.vendor': 'número, nombre o id del proveedor',
  'help.vendor.terms.set.option.terms': 'condiciones de pago: "Net 30", "2/10 Net 30", "Due on receipt"',
  'help.vendor.terms.set.option.currency': 'código ISO de 3 letras',
  'help.vendor.terms.set.option.reason': 'por qué se hizo el cambio; queda en el rastro de auditoría',
  // ==== MNE-001-239 · help by key, payment, prepaid and tax-deposit (issue #314) ====
  'help.payment.description':
    'Pagos a proveedores: registra el dinero que ya salió del banco y liquida la factura que paga',
  'help.payment.create.description':
    'Registra un pago hecho contra una factura de proveedor y reconoce el IVA que tenía pendiente',
  'help.payment.create.argument.bill': 'número propio, folio del proveedor o id',
  'help.payment.create.option.amount': 'importe, en la moneda del documento',
  'help.payment.create.option.date': 'fecha valor (AAAA-MM-DD); por omisión, hoy',
  'help.payment.create.option.method': 'forma de pago, una de: cash, check, ach, wire, spei, credit_card, other',
  'help.payment.create.option.bank':
    'nombre o id de la cuenta bancaria; sin ella se usa la cuenta con el rol `banco` de la entidad',
  'help.payment.create.option.json': 'salida en JSON',
  'help.payment.create.option.check_number': 'número de cheque; sólo vale con --method check',
  'help.payment.create.option.to_account': 'cuenta que recibió el dinero (CtaDest de la póliza del SAT)',
  'help.payment.create.option.to_bank': 'clave del banco destino en el catálogo c_Banco del SAT (3 dígitos)',
  'help.payment.create.option.to_foreign_bank': 'nombre del banco destino cuando es extranjero',
  'help.payment.create.option.discount': 'descuento por pronto pago que se tomó',
  'help.payment.create.option.memo': 'nota que se guarda con el pago',
  'help.payment.apply.description':
    'Aplica un pago ya registrado a facturas concretas: en parcialidad, con descuento o con pago corto',
  'help.payment.apply.argument.payment': 'número o id del pago cuyo saldo a cuenta se va a aplicar',
  'help.payment.apply.option.bill':
    'factura a la que se aplica; se repite, y cada una se empareja en orden con un --amount',
  'help.payment.apply.option.amount': 'importe que se aplica a la factura de la misma posición',
  'help.payment.apply.option.discount': 'descuento por pronto pago de la factura de la misma posición',
  'help.payment.apply.option.mode': 'partial (deja abierto el resto) o residual (la cierra pagando de menos)',
  'help.payment.apply.option.short_pay_reason':
    'por qué se da de baja el saldo que no se pagó; obligatorio con --mode residual',
  'help.payment.apply.option.json': 'salida en JSON',
  'help.payment.unapply.description':
    'Desaplica un pago de una factura como un evento NUEVO y fechado: la factura vuelve a deberse y el ' +
    'dinero vuelve a quedar a cuenta',
  'help.payment.unapply.argument.payment': 'número o id del pago',
  'help.payment.unapply.option.bill': 'la factura de la que se desaplica',
  'help.payment.unapply.option.reason': 'por qué: queda en el rastro de auditoría',
  'help.payment.unapply.option.date':
    'fecha de la desaplicación, para el renglón cerrado y su póliza (AAAA-MM-DD); por omisión, hoy',
  'help.payment.unapply.option.json': 'salida en JSON',
  'help.payment.reverse.description':
    'Reversa un pago que regresó: cada póliza que contabilizó recibe su espejo fechado, y sus facturas ' +
    'vuelven a deberse',
  'help.payment.reverse.argument.payment': 'número o id del pago',
  'help.payment.reverse.option.reason': 'por qué: queda en el rastro de auditoría',
  'help.payment.reverse.option.date':
    'fecha de la reversión, para sus espejos y los renglones cerrados (AAAA-MM-DD); por omisión, hoy',
  'help.payment.reverse.option.json': 'salida en JSON',
  'help.prepaid.description': 'Pagos anticipados: el calendario que los saca de la 1160, mes a mes',
  'help.prepaid.create.description':
    'Registra el calendario de amortización de un cargo que ya está en pagos anticipados; no contabiliza nada',
  'help.prepaid.create.argument.description': 'qué cubre el pago anticipado, tal como se leerá en las pólizas',
  'help.prepaid.create.option.amount': 'importe por amortizar, en decimal',
  'help.prepaid.create.option.start': 'primer día de la cobertura (AAAA-MM-DD)',
  'help.prepaid.create.option.end': 'último día de la cobertura, incluido (AAAA-MM-DD)',
  'help.prepaid.create.option.origin': 'de dónde vino el cargo que ya está en la cuenta; no tiene valor por omisión',
  'help.prepaid.create.option.source_entry': 'la póliza que cargó la cuenta; obligatoria con --origin cfdi',
  'help.prepaid.create.option.cfdi_uuid': 'el CFDI con el que llegó este pago anticipado, para el rastro',
  'help.prepaid.create.option.vendor': 'nombre del proveedor que se guarda en el calendario',
  'help.prepaid.create.option.reference':
    'el documento al que remite: número de póliza de seguro, contrato, pedido',
  'help.prepaid.create.option.convention':
    'la convención que crees estar registrando ({conventions}); se contrasta con el panel',
  'help.prepaid.create.option.prepaid_account':
    'cuenta de pagos anticipados donde está el cargo (por omisión, la del rol `gasto_anticipado`)',
  'help.prepaid.create.option.expense_account':
    'cuenta a la que la amortización cargará cada mes (por omisión, la del rol `gasto`)',
  'help.prepaid.create.option.reason': 'por qué se rebasa el umbral; obligatorio con --force',
  'help.prepaid.create.option.dry_run': 'muestra el calendario que se registraría; no escribe nada',
  'help.prepaid.list.description':
    'Calendarios vivos con su saldo por amortizar y cuántos periodos les quedan',
  'help.prepaid.list.option.limit': 'máximo de renglones a devolver',
  'help.prepaid.list.option.offset': 'salta estos renglones',
  'help.prepaid.list.option.all':
    'todos los calendarios vivos, incluidos los que aún no empiezan y los que ya terminaron',
  'help.prepaid.list.option.as_of':
    'sólo los calendarios cuya cobertura está abierta en esta fecha (AAAA-MM-DD; por omisión, hoy)',
  'help.prepaid.show.description': 'Un calendario con su tabla periodo por periodo',
  'help.prepaid.show.argument.id_or_description':
    'el calendario: su id, o lo suficiente de su descripción para que no sea ambiguo',
  'help.prepaid.run.description':
    'Contabiliza la amortización del mes: una póliza de ajuste por calendario, irreversible',
  'help.prepaid.run.option.period': 'periodo a amortizar: 2026-08 o cualquier parte inequívoca de su nombre',
  'help.tax_deposit.description': 'Pasivos patronales por impuestos: qué se debe, a quién y para cuándo',
  'help.tax_deposit.list.description':
    'Pasivos patronales acumulados con su fecha de vencimiento y su estado, primero los que vencen antes',
  'help.tax_deposit.list.option.status': 'filtra por estado del pasivo ({states}); se puede repetir',
  'help.tax_deposit.list.option.all':
    'incluye lo que ya está saldado: también los renglones depositados y dispensados',
  'help.tax_deposit.list.option.period': 'sólo los pasivos cuyo periodo toca este mes',
  'help.tax_deposit.list.option.until': 'sólo lo que vence en esta fecha o antes (AAAA-MM-DD)',
  'help.tax_deposit.list.option.all_entities': 'todas las entidades del inquilino, no sólo la activa',
  // ==== MNE-001-240 · help by key, cfdi, e-accounting and sat (issue #314) ====
  'help.cfdi.description':
    'El espejo de CFDI: listar, inspeccionar, estatus en el SAT, el rastro del clasificador y contabilizar un CFDI emitido',
  'help.cfdi.list.description': 'El espejo, filtrado por dirección, tipo, estatus y fecha',
  'help.cfdi.list.option.direction': 'emitido, recibido o ajeno (se deriva contra el RFC de la entidad)',
  'help.cfdi.list.option.type': 'filtra por document_type, por ejemplo cfdi_ingreso, cfdi_egreso o cfdi_pago',
  'help.cfdi.show.description':
    'Un CFDI: encabezado, conceptos, impuestos y estatus en el SAT; --format xml imprime los bytes exactos',
  'help.cfdi.show.argument.uuid': 'UUID del CFDI (timbre fiscal)',
  'help.cfdi.status.description':
    'Estatus del espejo en el SAT (ConsultaCFDIService público; no interviene la e.firma)',
  'help.cfdi.status.show.description': 'Estado, EsCancelable y EstatusCancelacion según la última respuesta del SAT',
  'help.cfdi.status.show.argument.uuid': 'UUID del CFDI',
  'help.cfdi.status.show.option.refresh': 'pregunta al SAT ahora y actualiza la caché sat_* del documento',
  'help.cfdi.status.sync.description':
    'Vuelve a revisar todo el espejo contra el SAT: primero lo desactualizado o nunca consultado',
  'help.cfdi.status.sync.option.limit': 'máximo de CFDI a consultar en esta corrida',
  'help.cfdi.status.sync.option.stale_hours': 'horas tras las que una consulta queda desactualizada',
  'help.cfdi.explain.description':
    'POR QUÉ se registró como se registró: caso, hechos y decisiones que dejó el clasificador',
  'help.cfdi.explain.argument.uuid': 'UUID del CFDI',
  'help.e_accounting.description': 'Contabilidad electrónica (Anexo 24): arma el XML que espera el SAT y lo verifica',
  'help.e_accounting.catalog.description': 'El catálogo de cuentas como lo pide el SAT: CtaCatalogo 1.3',
  'help.e_accounting.catalog.generate.description':
    'Genera y archiva el XML CtaCatalogo 1.3 (NumCta, Desc, SubCtaDe, Nivel, Natur, CodAgrup) con su hash',
  'help.e_accounting.catalog.generate.option.output':
    'escribe el XML de CtaCatalogo en esta ruta (el almacén de artefactos guarda su propia copia)',
  'help.e_accounting.catalog.generate.option.period': 'mes que declara el catálogo (Mes y Anio de su encabezado)',
  'help.e_accounting.catalog.generate.option.dry_run':
    'lo construye y muestra el veredicto; no archiva nada ni escribe archivo',
  'help.e_accounting.catalog.generate.option.yes':
    'no pregunta antes de sobrescribir cuando -o nombra un archivo que ya existe',
  'help.e_accounting.balance.description':
    'La balanza de comprobación que espera el SAT: BCE 1.3, normal, complementaria o de cierre',
  'help.e_accounting.balance.generate.description':
    'Genera y archiva el XML de la balanza de comprobación del periodo (SaldoIni, Debe, Haber, SaldoFin) con su hash',
  'help.e_accounting.balance.generate.option.output':
    'escribe el XML de la Balanza en esta ruta (el almacén de artefactos guarda su propia copia)',
  'help.e_accounting.balance.generate.option.period':
    'periodo a declarar: 2026-02, su nombre o el id del periodo fiscal',
  'help.e_accounting.balance.generate.option.type': 'tipo de envío: N normal, C complementaria (pide --modified)',
  'help.e_accounting.balance.generate.option.closing':
    'la balanza de cierre, presentada como mes 13, no como otro diciembre',
  'help.e_accounting.balance.generate.option.modified':
    'fecha en que se modificó la balanza que se complementa (FechaModBal); obligatoria con --type C',
  'help.e_accounting.balance.generate.option.dry_run':
    'lo construye y muestra el veredicto; no archiva nada ni escribe archivo',
  'help.e_accounting.balance.generate.option.yes':
    'no pregunta antes de sobrescribir cuando -o nombra un archivo que ya existe',
  'help.e_accounting.balance.check.description':
    'Corre las invariantes que vuelve a correr el SAT: SaldoIni + Debe − Haber = SaldoFin según la Natur, y cada cuenta en el catálogo',
  'help.e_accounting.balance.check.option.period': 'periodo a verificar: 2026-02, su nombre o el id del periodo fiscal',
  'help.e_accounting.balance.check.option.closing': 'verifica la balanza de cierre (mes 13) en lugar de la de un mes',
  'help.e_accounting.balance.check.option.check':
    'nombres de verificaciones separados por comas; sin valor, imprime los disponibles',
  'help.sat.description': 'Servicios del SAT (credenciales de e.firma y la descarga masiva de CFDI)',
  'help.sat.cred.description': 'Credenciales fiscales (e.firma)',
  'help.sat.cred.add.description':
    'Registra la e.firma de una entidad (valida en local; guardarla en la bóveda pide --live)',
  'help.sat.cred.add.option.cer': 'Certificado .cer del SAT (DER)',
  'help.sat.cred.add.option.key': 'Llave privada .key del SAT (DER)',
  'help.sat.cred.add.option.entity': 'Entidad legal',
  'help.sat.cred.add.option.user': 'Quién otorga el consentimiento',
  'help.sat.cred.add.option.no_unattended': 'Prohíbe el uso sin un operador presente',
  'help.sat.cred.add.option.max_diario': 'Límite de accesos por 24 h',
  'help.sat.cred.status.description': 'Muestra las credenciales de la entidad y su vigencia',
  'help.sat.cred.status.option.entity': 'Entidad legal',
  'help.sat.cred.audit.description': 'Historial de accesos a la credencial (quién la usó, cuándo y para qué)',
  'help.sat.cred.audit.option.entity': 'Entidad legal',
  'help.sat.cred.audit.option.limit': 'Cuántos eventos mostrar',
  'help.sat.cred.revoke.description': 'Revoca la credencial y borra el material de la bóveda (irreversible)',
  'help.sat.cred.revoke.option.entity': 'Entidad legal',
  'help.sat.cred.revoke.option.user': 'Quién revoca',
  // ==== MNE-001-427 · help by key, report and asset (issue #314) ====
  'help.report.description': 'Estados financieros, balanza de comprobación, mayor general y antigüedad de saldos',
  'help.report.trial_balance.description': 'Balanza de comprobación',
  'help.report.trial_balance.show.description': 'Cargos, abonos y saldo final por cuenta, con las sumas iguales',
  'help.report.trial_balance.show.option.level': 'acumula hasta este nivel de cuenta como máximo (por omisión: todos los niveles)',
  'help.report.trial_balance.show.option.exclude_zero': 'omite las cuentas cuyo saldo final es exactamente cero',
  'help.report.balance_sheet.description': 'Balance general',
  'help.report.balance_sheet.show.description': 'Activo, pasivo y capital a una fecha de corte, con su signo natural',
  'help.report.income_statement.description': 'Estado de resultados',
  'help.report.income_statement.show.description': 'Ingresos, gastos y utilidad neta de un periodo',
  'help.report.general_ledger.description': 'Detalle del mayor general',
  'help.report.general_ledger.show.description': 'Los movimientos contabilizados renglón por renglón, filtrables por cuenta y fecha',
  'help.report.general_ledger.show.option.account': 'sólo una cuenta (código o id)',
  'help.report.aged_receivable.description': 'Antigüedad de saldos de clientes',
  'help.report.aged_receivable.show.description': 'Las facturas de clientes abiertas por tramo de antigüedad, con el saldo por cobrar',
  'help.report.aged_payable.description': 'Antigüedad de saldos de proveedores',
  'help.report.aged_payable.show.description': 'Las facturas de proveedores abiertas por tramo de antigüedad, con el saldo por pagar',
  'help.report.view.description': 'Las vistas materializadas de los informes (mv_trial_balance, mv_account_balance_summary)',
  'help.report.view.show.description': 'Si cada vista de informes sigue cuadrando con el mayor, y por cuánto difiere',
  'help.report.view.sync.description': 'Reconstruye desde el mayor las vistas materializadas de los informes (para todo el despacho)',
  'help.report.view.sync.option.view': 'qué vistas reconstruir (por omisión, todas: {views})',
  'help.report.view.sync.option.no_concurrently':
    'reconstruye con un bloqueo exclusivo; sólo hace falta para una vista que nunca se ha poblado',
  'help.asset.description': 'Registro de activos fijos: el libro de lo que la empresa posee y deprecia',
  'help.asset.create.description':
    'Da de alta un activo fijo con su clase, fechas, costo y cuentas; no registra ninguna póliza',
  'help.asset.create.argument.name': 'cómo se llama el activo en el registro',
  'help.asset.create.option.category': 'clase de activo: su id, o lo bastante de su nombre para no ser ambiguo',
  'help.asset.create.option.cost': 'monto original de la inversión (MOI), en decimal',
  'help.asset.create.option.acquired': 'fecha de adquisición (AAAA-MM-DD)',
  'help.asset.create.option.in_service':
    'fecha en que empieza la depreciación (AAAA-MM-DD); por omisión sale de la convención del primer mes del panel',
  'help.asset.create.option.book': 'el libro de depreciación en el que crees estar trabajando; se coteja contra el panel',
  'help.asset.create.option.capitalized':
    'si el costo YA está cargado a la cuenta de activo en el mayor; no tiene valor por omisión',
  'help.asset.create.option.source_entry': 'la póliza en la que ya está el costo, cuando se conoce',
  'help.asset.create.option.salvage': 'valor de desecho al final de su vida útil (por omisión 0)',
  'help.asset.create.option.life_years': 'vida útil en años',
  'help.asset.create.option.life_months': 'vida útil en meses; los años son los meses entre doce, redondeados hacia arriba',
  'help.asset.create.option.method': 'método de depreciación CONTABLE: {methods}',
  'help.asset.create.option.tax_method': 'método de depreciación FISCAL: {methods}',
  'help.asset.create.option.asset_account': 'cuenta del mayor en la que está el costo (por omisión, la de la clase)',
  'help.asset.create.option.accum_account': 'cuenta de depreciación acumulada (por omisión, la de la clase)',
  'help.asset.create.option.expense_account': 'cuenta de gasto por depreciación (por omisión, la de la clase)',
  'help.asset.create.option.number': 'número de activo; si se omite, sale de la serie de la entidad',
  'help.asset.create.option.description': 'qué es el activo',
  'help.asset.create.option.vendor': 'proveedor al que se le compró',
  'help.asset.create.option.serial': 'número de serie, para que el registro encuentre el bien físico',
  'help.asset.create.option.location': 'dónde está',
  'help.asset.create.option.dry_run': 'recorre el camino real y lo deshace: muestra el activo que se daría de alta',
  'help.asset.category.description': 'Clases de activo: vida útil, tasa de la LISR y las tres cuentas por omisión',
  'help.asset.category.seed.description':
    'Crea las clases de activo mexicanas que falten, con su tasa máxima de los arts. 34 y 35 de la LISR',
  // ==== MNE-001-242 · help by key, approvals, memory, pending, skills, ingest and question (issue #314) ====
  'help.approvals.description':
    'Políticas de aprobación graduadas para las escrituras en espera (once / session / always)',
  'help.approvals.list.description': 'Lista las políticas de aprobación de la entidad',
  'help.approvals.list.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.approvals.list.option.tenant': 'Inquilino (despacho)',
  'help.approvals.list.option.scope': 'Filtra por alcance ({scopes})',
  'help.approvals.list.option.all': 'Incluye las políticas revocadas',
  'help.approvals.list.option.json': 'salida en JSON',
  'help.approvals.grant.description':
    'Otorga una política de aprobación por patrón (coincidencia conservadora; el piso siempre gana)',
  'help.approvals.grant.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.approvals.grant.option.tenant': 'Inquilino (despacho)',
  'help.approvals.grant.option.scope': 'Alcance de la política ({scopes})',
  'help.approvals.grant.option.mode': 'Modo de la política ({modes})',
  'help.approvals.grant.option.kind':
    'Campo de coincidencia: tipo de candidato. En un borrador es el campo "kind" (o "entry_type") ' +
    'de su contenido y, si falta, "journal_entry"; tipos en uso hoy: journal_entry (por omisión), payroll',
  'help.approvals.grant.option.max_amount': 'Campo de coincidencia: monto máximo autorizado (cadena numérica)',
  'help.approvals.grant.option.provider': 'Campo de coincidencia: proveedor externo (p. ej., contalink)',
  'help.approvals.grant.option.operation': 'Campo de coincidencia: operación externa (p. ej., create_policy)',
  'help.approvals.grant.option.session': 'Id de la sesión que otorga (obligatorio con --mode session)',
  'help.approvals.grant.option.user':
    'Usuario que otorga (obligatorio cuando el inquilino tiene varios usuarios activos)',
  'help.approvals.revoke.description': 'Revoca una política de aprobación activa',
  'help.approvals.revoke.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.approvals.revoke.option.tenant': 'Inquilino (despacho)',
  'help.memory.description': 'Precedentes del despacho: lo que la IA aprendió y tú controlas',
  'help.memory.option.entity': 'Entidad legal',
  'help.memory.option.tenant': 'Inquilino (despacho)',
  'help.memory.option.search': 'Filtra por texto',
  'help.memory.option.all': 'Incluye los retirados',
  'help.memory.option.conflicts': 'Sólo los precedentes que se contradicen entre sí, y cómo resolverlos',
  'help.memory.option.json': 'salida en JSON',
  'help.memory.teach.description': 'Siembra un criterio del despacho sin esperar a que la IA pregunte',
  'help.memory.teach.argument.rule': 'La situación, p. ej., "facturas de Telmex"',
  'help.memory.teach.argument.criterion': 'Qué hacer, p. ej., "van a 6130 Servicios"',
  'help.memory.teach.option.user': 'Quién lo enseña',
  'help.memory.teach.option.topic': 'Tema para agrupar los precedentes',
  'help.memory.correct.description':
    'Cambia la respuesta de un precedente (la anterior se queda en el historial)',
  'help.memory.correct.argument.id': 'Id del precedente',
  'help.memory.correct.argument.answer': 'La respuesta correcta',
  'help.memory.correct.option.user': 'Quién corrige',
  'help.memory.retire.description': 'La IA deja de usar este precedente (no se borra: el historial se queda)',
  'help.memory.retire.argument.id': 'Id del precedente',
  'help.memory.retire.option.user': 'Quién lo retira',
  'help.memory.retire.option.reason': 'Por qué ya no aplica (queda en el historial del precedente)',
  'help.memory.restore.description': 'Reactiva un precedente retirado',
  'help.memory.restore.argument.id': 'Id del precedente',
  'help.pending.description': 'Lo que te toca: trabajo por resolver y decisiones de política por definir',
  'help.pending.option.entity': 'Entidad legal',
  'help.pending.option.verbose':
    'Explica cada decisión: por qué pregunto, qué hago, qué cuesta omitirla y qué dicen tus propios datos',
  'help.pending.option.all': 'Incluye las definiciones ya resueltas y descartadas',
  'help.pending.define.description': 'Define una decisión pendiente (el valor surte efecto de inmediato)',
  'help.pending.define.argument.key': 'Clave de la decisión (ver: mnemosine pending)',
  'help.pending.define.argument.value': 'Valor elegido; si se omite, se pregunta de forma interactiva',
  'help.pending.define.option.entity': 'Entidad legal',
  'help.pending.define.option.user': 'Quién la define',
  'help.pending.define.option.note': 'Nota o justificación',
  'help.pending.dismiss.description': 'Marca una definición como no aplicable (sale de la agenda)',
  'help.pending.dismiss.option.entity': 'Entidad legal',
  'help.pending.dismiss.option.user': 'Quién la descarta',
  'help.pending.dismiss.option.note': 'Por qué no aplica',
  'help.pending.reopen.description': 'Reabre una definición ya resuelta (la política cambió)',
  'help.pending.reopen.option.entity': 'Entidad legal',
  'help.skills.description': 'Habilidades del despacho: listar, revisar los cambios en espera y ver su contenido',
  'help.skills.list.description': 'Las habilidades visibles y cuántos cambios en espera aguardan revisión',
  'help.skills.list.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.skills.list.option.tenant': 'Inquilino (despacho)',
  'help.skills.list.option.json': 'salida en JSON',
  'help.skills.drafts.description':
    'Revisa los cambios de habilidades en espera: diff e informe del escáner de confianza; aprueba o rechaza',
  'help.skills.drafts.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.skills.drafts.option.tenant': 'Inquilino (despacho)',
  'help.skills.drafts.option.user': 'Quién revisa',
  'help.skills.drafts.option.accept_risk':
    'Permite aprobar los borradores que el escáner de confianza marcó (queda en el rastro de auditoría)',
  'help.skills.drafts.option.override_drift':
    'Aprueba aunque el archivo de la habilidad se haya apartado de la base del diff del borrador ' +
    '(queda en el rastro de auditoría)',
  'help.skills.drafts.option.json': 'Lista en JSON los borradores pendientes (sin revisión interactiva)',
  'help.skills.view.description': 'Imprime el SKILL.md de una habilidad',
  'help.skills.view.argument.name': 'Nombre de la habilidad',
  'help.ingest.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.ingest.option.provider': 'Proveedor del modelo (ver: mnemosine providers)',
  'help.ingest.option.model': 'Sustituye el modelo del perfil',
  'help.ingest.option.user': 'Usuario al que se atribuye la ingesta (por omisión: el único usuario activo)',
  'help.ingest.option.auto_post':
    'Activa la contabilización automática por umbrales (por omisión, todo se queda en borrador)',
  'help.ingest.option.no_auto_post':
    'Desactiva la contabilización automática aunque la configuración la tenga encendida',
  'help.ingest.option.min_confidence': 'Confianza mínima para contabilizar en automático (0-1)',
  'help.ingest.option.max_amount': 'Monto máximo que se puede contabilizar en automático',
  'help.ingest.option.retry':
    'Reprocesa los CFDI ya registrados cuyo procesamiento falló, en vez de reportarlos como duplicados',
  'help.question.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.question.option.user': 'Quién responde (por omisión: el único usuario activo del inquilino)',
  'help.question.option.list': 'Sólo lista, sin responder (obsoleta: usa `question list`)',
  'help.question.answer.argument.id':
    'id de la pregunta; omítelo para atender de forma interactiva la cola de pendientes',
  'help.question.answer.argument.answer': 'el texto de la respuesta, o el número de una opción (requiere <id>)',
  'help.question.answer.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.question.answer.option.user': 'Quién responde (por omisión: el único usuario activo del inquilino)',
  // ==== MNE-001-235 · help by key, entry (issue #314) ====
  'help.entry.description': 'Pólizas: redactar, consultar, validar, contabilizar, reversar y anular',
  'help.entry.list.description': 'Busca pólizas por texto, cuenta, fecha, importe, estado, tipo u origen',
  'help.entry.list.argument.search': 'texto a buscar en la descripción o en la referencia',
  'help.entry.list.option.type': 'tipo de póliza (se puede repetir)',
  'help.entry.list.option.source': 'auxiliar de origen: invoice, bill, payroll, manual…',
  'help.entry.list.option.account': 'sólo pólizas con una línea en esta cuenta',
  'help.entry.list.option.min_amount': 'total mínimo de cargos',
  'help.entry.list.option.max_amount': 'total máximo de cargos',
  'help.entry.show.description': 'Muestra una póliza con sus líneas, totales, periodo y la reversa ligada',
  'help.entry.show.argument.number': 'número de póliza (JE-2026-00042) o id',
  'help.entry.show.option.no_lines': 'sólo el encabezado, sin las líneas',
  'help.entry.create.description':
    'Crea una póliza — SIEMPRE como borrador; contabilizarla es un paso humano aparte',
  'help.entry.create.option.line':
    'una línea: "account=6120;debit=45000.00;description=…"; se repite por cada línea. ' +
    'La lista de claves está abajo',
  'help.entry.create.option.file': 'documento JSON con fecha, tipo, descripción y líneas',
  'help.entry.create.option.date': 'fecha de la póliza (AAAA-MM-DD); por omisión, hoy',
  'help.entry.create.option.type': 'tipo de póliza: {types} (por omisión: standard)',
  'help.entry.create.option.description': 'qué registra la póliza',
  'help.entry.create.option.reference': 'referencia externa (documento, folio, memo)',
  'help.entry.create.option.dry_run': 'valida y muestra la póliza que quedaría como borrador; no escribe nada',
  'help.entry.create.option.json': 'salida en JSON',
  'help.entry.check.description':
    'Corre las siete reglas de validación de las NIF sobre una póliza o un documento; no escribe nada',
  'help.entry.check.option.entry': 'una póliza que ya existe, por número o id',
  'help.entry.check.option.file': 'un documento JSON de una póliza que todavía no existe',
  'help.entry.line.description': 'Líneas del mayor: del saldo de una cuenta a las pólizas que lo forman',
  'help.entry.line.list.description':
    'Líneas contabilizadas de una cuenta, cada una con la póliza a la que pertenece',
  'help.entry.line.list.argument.code': 'código de cuenta',
  'help.entry.preview.description':
    'El cambio exacto que esta póliza haría en account_balances, sin tocar nada',
  'help.entry.preview.argument.number': 'número o id de la póliza',
  'help.entry.edit.description':
    'Edita una póliza en BORRADOR: descripción, referencia, nota, fecha o reemplazo de todas las líneas',
  'help.entry.edit.argument.number': 'número o id de la póliza',
  'help.entry.edit.option.description': 'nueva descripción',
  'help.entry.edit.option.reference': 'nueva referencia externa',
  'help.entry.edit.option.note': 'nueva nota',
  'help.entry.edit.option.date': 'nueva fecha de la póliza (AAAA-MM-DD)',
  'help.entry.edit.option.line':
    'REEMPLAZA todas las líneas: "account=6120;debit=45000.00;description=…" ' +
    '(la lista de claves está en entry create --help)',
  'help.entry.edit.option.file':
    'documento JSON cuya fecha, descripción, referencia y líneas reemplazan las del borrador',
  'help.entry.export.description':
    'Pólizas CON sus líneas, en plano, para auditoría o migración — sin tope de páginas',
  'help.entry.import.description':
    'Prepara un archivo de pólizas en un lote (devuelve un batch_id); NUNCA toca el mayor',
  'help.entry.import.argument.file': 'archivo de pólizas que se va a preparar',
  'help.entry.import.option.layout': 'formato del archivo: {layouts} (contpaqi/aspel/iif/sat-polizas: aún sin parser)',
  'help.entry.import.option.dry_run': 'lee el archivo e informa; no prepara nada',
  'help.entry.import.option.idempotency_key':
    'llave para reintentar sin riesgo: la misma llave con el mismo archivo devuelve el primer lote',
  'help.entry.post.description':
    'Contabiliza UNA póliza en el mayor: valida las siete reglas y luego mueve los saldos',
  'help.entry.post.argument.number': 'número o id de la póliza',
  'help.entry.post.option.json': 'salida en JSON',
  'help.entry.reverse.description':
    'Crea la póliza espejo, contabilizada y ligada a la original (NIF B-1: se corrige por reversa)',
  'help.entry.reverse.argument.number': 'la póliza CONTABILIZADA que se reversa',
  'help.entry.reverse.option.date': 'fecha de la póliza espejo (AAAA-MM-DD); por omisión, hoy',
  'help.entry.void.description':
    'Anula una póliza: un borrador queda anulado y una contabilizada recibe su espejo ligado',
  'help.entry.void.argument.number': 'número o id de la póliza',

  // ==== MNE-001-426 · help by key, batch and fx (issue #314) ====
  //
  // Same keys and order as en.ts. The categories of `batch check --check`
  // arrive in {categories} as the user types them, untranslated (I23).
  'help.batch.description':
    'Lotes de pólizas en preparación: listar, inspeccionar, verificar, contabilizar en una transacción y ' +
    'reversar como una unidad',
  'help.batch.list.description':
    'Lista los lotes con su estado, conteo de filas, pólizas contabilizadas y hash del contenido',
  'help.batch.list.option.kind': 'clase de lote (disponibles: {kinds})',
  'help.batch.show.description':
    'Un lote completo: las filas con sus pólizas generadas, los errores de lectura guardados por categoría y el ' +
    'hash del archivo',
  'help.batch.show.argument.id': 'id del lote',
  'help.batch.show.option.errors_only': 'sólo las filas que el analizador rechazó',
  'help.batch.check.description':
    'Corre las validaciones de contabilización sobre cada fila e informa cada hallazgo; sale con 4 si alguno ' +
    'bloquea',
  'help.batch.check.argument.id': 'id del lote',
  'help.batch.check.option.check':
    'categorías de hallazgo a mostrar, separadas por comas (disponibles: {categories}); la batería completa ' +
    'corre siempre',
  'help.batch.post.description':
    'Contabiliza el lote entero en una transacción; --partial aplica las filas válidas y deja las demás en ' +
    'preparación',
  'help.batch.post.argument.id': 'id del lote',
  'help.batch.post.option.partial':
    'aplica las filas válidas y deja las inválidas en preparación (acepta un lote sin verificar)',
  'help.batch.post.option.json': 'salida en JSON',
  'help.batch.reverse.description':
    'Refleja cada póliza que contabilizó el lote, como una unidad y en una transacción: un error de importación ' +
    'es del lote, no de una póliza',
  'help.batch.reverse.argument.id': 'id del lote',
  'help.batch.reverse.option.as_of': 'fecha de cada póliza espejo (AAAA-MM-DD); por omisión, hoy',
  'help.batch.reverse.option.json': 'salida en JSON',
  'help.fx.description': 'Tipos de cambio: el origen del que se convierte todo importe en moneda extranjera',
  'help.fx.rate.description': 'Tipos de cambio publicados, por par, fecha, clase y fuente',
  'help.fx.rate.list.description': 'Lista los tipos de cambio guardados, por par, fecha, clase y fuente',
  'help.fx.rate.list.option.pair': 'par de monedas, p. ej. USD/MXN',
  'help.fx.rate.list.option.since': 'límite inferior inclusivo (AAAA-MM-DD)',
  'help.fx.rate.list.option.until': 'límite superior inclusivo (AAAA-MM-DD)',
  'help.fx.rate.list.option.rate_type': 'sólo los tipos de cambio de esta clase',
  'help.fx.rate.list.option.source': 'sólo los tipos de cambio de esta fuente',
  'help.fx.rate.show.description':
    'Resuelve el tipo de cambio aplicable: directo, luego inverso, luego cruzado a través del USD',
  'help.fx.rate.show.argument.pair': 'par de monedas, p. ej. USD/MXN',
  'help.fx.rate.show.argument.date': 'fecha a la que aplica el tipo de cambio (AAAA-MM-DD)',
  'help.fx.rate.show.option.rate_type': 'clase de tipo de cambio a resolver',
  'help.fx.rate.show.option.source': 'resuelve sólo con lo que publicó esta fuente',
  'help.fx.rate.set.description': 'Registra un tipo de cambio, con la fuente que lo publicó',
  'help.fx.rate.set.argument.pair': 'par de monedas, p. ej. USD/MXN',
  'help.fx.rate.set.argument.date': 'fecha desde la que rige (AAAA-MM-DD)',
  'help.fx.rate.set.argument.rate': 'el tipo de cambio, hasta 10 decimales',
  'help.fx.rate.set.option.source': 'quién publicó el tipo de cambio (obligatoria)',
  'help.fx.rate.set.option.rate_type': 'clase de tipo de cambio',
  'help.fx.rate.set.option.until': 'último día en que el tipo de cambio sigue vigente (AAAA-MM-DD)',
  'help.fx.rate.set.option.dry_run': 'muestra lo que se registraría, sin escribir',
  'help.fx.rate.download.description':
    'Descarga el tipo de cambio del DOF o el FIX de Banxico, guardado por fuente (el mismo día difieren)',
  'help.fx.rate.download.option.source': 'de qué fuente descargar (obligatoria)',
  'help.fx.rate.download.option.as_of': 'una sola fecha a descargar (AAAA-MM-DD)',
  'help.fx.rate.download.option.since': 'límite inferior inclusivo (AAAA-MM-DD)',
  'help.fx.rate.download.option.until': 'límite superior inclusivo (AAAA-MM-DD)',
  // ==== MNE-001-243 · help by key, entity, init, onboard, lang, login, ask, chat, compact, drafts, review, sessions, prompt-size, ai, doctor and usage (issue #314) ====
  'help.entity.description': 'Elige y consulta la entidad legal sobre la que operan los comandos',
  'help.entity.list.description': 'Lista las entidades legales activas',
  'help.entity.show.description':
    'Muestra una entidad; sin argumento, la que usarían los comandos, y por qué',
  'help.entity.show.argument.id_or_name': 'entidad que se describe; omítela para la activa',
  'help.entity.use.description': 'Fija la entidad sobre la que operan los comandos que siguen',
  'help.entity.use.argument.id_or_name': 'id de la entidad, su RFC o una parte del nombre',
  'help.entity.create.description':
    'Crea una entidad legal con su catálogo de cuentas, sus roles y el mapeo de la nómina',
  'help.entity.create.argument.name': 'razón social de la empresa',
  'help.entity.create.option.tax_id': 'RFC (México) o EIN (EE. UU.)',
  'help.entity.create.option.country': 'MX o USA',
  'help.entity.create.option.currency': 'moneda funcional (por omisión, la del país)',
  'help.entity.create.option.chart': 'auto | siempre | nunca: si se siembra el catálogo base',
  'help.entity.create.option.tax_regime': 'clave de c_RegimenFiscal: 601, 612, 626…',
  'help.entity.create.option.tax_postal_code': 'código postal del domicilio fiscal (5 dígitos)',
  'help.entity.create.option.json': 'salida en JSON',
  'help.entity.edit.description':
    'Fija el régimen fiscal, el código postal fiscal o la zona de salario mínimo de una entidad',
  'help.entity.edit.argument.id_or_name': 'id de la entidad, su RFC o una parte del nombre',
  'help.entity.edit.option.tax_regime': 'clave de c_RegimenFiscal: 601, 612, 626…',
  'help.entity.edit.option.tax_postal_code': 'código postal del domicilio fiscal (5 dígitos)',
  'help.entity.edit.option.reason': 'justificación que queda en el rastro de auditoría',
  'help.entity.edit.option.json': 'salida en JSON',
  'help.entity.archive.description': 'Archiva una entidad (nunca la borra: su contabilidad tiene que sobrevivir)',
  'help.entity.archive.argument.id_or_name': 'entidad que se archiva',
  'help.entity.unset.description': 'Quita la entidad fijada; los comandos vuelven a pedir --entity',
  'help.init.description':
    'Configuración guiada: infraestructura, entidad, usuarios, proveedor de IA y tu contabilidad',
  'help.init.option.status': 'Sólo muestra el estado; no configura nada',
  'help.init.option.section': 'Configura una sola sección (language|infra|identity|users|ai|policies|import)',
  'help.init.option.yes': 'No interactivo: usa los valores por omisión y las banderas, sin preguntar nada',
  'help.init.option.tenant': 'Inquilino (despacho)',
  'help.init.option.entity': 'Nombre de la entidad legal que se crea',
  'help.init.option.rfc': 'RFC/EIN de la entidad',
  'help.init.option.country': 'MX o USA',
  'help.init.option.currency': 'Moneda funcional',
  'help.init.option.provider': 'Proveedor de IA por omisión',
  'help.init.option.model': 'Modelo del proveedor',
  'help.init.option.user': 'Correo del usuario que se crea',
  'help.onboard.option.provider': 'Sistema externo, p. ej., contalink',
  'help.onboard.option.cutoff': 'Fecha de corte: los saldos iniciales se toman a esta fecha',
  'help.onboard.option.from':
    'Inicio del periodo de la balanza remota (por omisión: el 1 de enero del año del corte)',
  'help.onboard.option.entity': 'Entidad legal de destino (id, RFC o parte del nombre)',
  'help.onboard.option.user': 'Quién la corre (por omisión: el único usuario activo del inquilino)',
  'help.onboard.option.balance_account':
    'Cuenta de cuadre si la balanza remota no suma cero (p. ej., 3200)',
  'help.onboard.option.post':
    'Contabiliza el saldo inicial de inmediato (por omisión, se queda en borrador para mnemosine review)',
  'help.onboard.option.dry_run': 'Sólo muestra el plan, sin ejecutar nada',
  'help.login.option.device': 'Usa el flujo con código de dispositivo (SSH, servidor sin navegador)',
  'help.ask.argument.question': 'La pregunta para el asistente',
  'help.ask.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.ask.option.provider': 'Proveedor del modelo (ver: mnemosine providers)',
  'help.ask.option.model': 'Sustituye el modelo del perfil',
  'help.chat.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.chat.option.provider': 'Proveedor del modelo (ver: mnemosine providers)',
  'help.chat.option.model': 'Sustituye el modelo del perfil',
  'help.chat.option.continue':
    'Retoma la última sesión de esta terminal y entidad (continúa la transcripción; el contexto ' +
    'del modelo empieza de cero)',
  'help.chat.option.resume': 'Retoma una sesión por su id (ver: mnemosine sessions)',
  'help.chat.option.no_banner': 'Omite el banner de inicio (también: MNEMOSINE_NO_BANNER=1)',
  'help.compact.description':
    'Informe de compactación, sin aplicarla, de la transcripción de una sesión (sin llamadas a la API)',
  'help.compact.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.compact.option.tenant': 'Inquilino (despacho)',
  'help.compact.option.session': 'Id de la sesión (por omisión: la más reciente)',
  'help.compact.option.keep': 'Cola reciente que se conserva intacta, en tokens',
  'help.compact.option.json': 'salida en JSON',
  'help.drafts.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.drafts.option.status': 'Estado: pending_review | approved | rejected',
  'help.review.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.review.option.user': 'Correo de quien revisa (por omisión: el primer usuario activo del inquilino)',
  'help.sessions.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.sessions.option.limit': 'Número máximo de sesiones que se muestran',
  'help.prompt_size.description':
    'Desglose, sin conexión, del prompt de sistema y los esquemas de herramientas (sin llamadas a la API)',
  'help.prompt_size.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.prompt_size.option.tenant': 'Inquilino (despacho)',
  'help.prompt_size.option.json': 'salida en JSON',
  'help.ai.description': 'Métricas y calibración del agente contable',
  'help.ai.stats.description':
    'Aprobación por tramo de confianza, desfase entre confianza y realidad, costo y eventos',
  'help.doctor.description':
    'Diagnostica la salud del sistema: base de datos, migraciones, proveedor, credenciales, aislamiento',
  'help.doctor.option.json': 'salida en JSON para scripts',
  'help.usage.description': 'Consumo de tokens y costo estimado según el registro local (sin llamadas a la API)',
  'help.usage.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.usage.option.tenant': 'Inquilino (despacho)',
  'help.usage.option.since': 'Ventana: Nd (p. ej., 7d, 30d) o AAAA-MM-DD',
  'help.usage.option.by': 'Agrupa por: {choices}',
  'help.usage.option.json': 'salida en JSON',
  // ==== MNE-001-244 · help by key, jobs, webhooks and outbox (issue #314) ====
  'help.jobs.description':
    'Tareas programadas y guardadas del agente (todo lo que producen son borradores para revisar, nunca escrituras directas)',
  'help.jobs.list.description': 'Lista los trabajos programados de esta entidad',
  'help.jobs.list.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.list.option.tenant': 'Inquilino (despacho)',
  'help.jobs.create.description': 'Crea un trabajo programado',
  'help.jobs.create.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.create.option.tenant': 'Inquilino (despacho)',
  'help.jobs.create.option.name': 'Nombre del trabajo (único por entidad)',
  'help.jobs.create.option.kind': 'Tipo de trabajo: {kinds}',
  'help.jobs.create.option.schedule': 'Expresión cron de 5 campos, p. ej., "0 2 * * *" (cada noche a las 02:00)',
  'help.jobs.create.option.max_failures': 'Se desactiva solo tras N fallas seguidas (por omisión, 3)',
  'help.jobs.create.option.user': 'Quién crea el trabajo (auditoría)',
  'help.jobs.enable.description': 'Activa un trabajo (reinicia su contador de fallas y recalcula la siguiente corrida)',
  'help.jobs.enable.argument.job_id': 'Id del trabajo',
  'help.jobs.enable.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.enable.option.tenant': 'Inquilino (despacho)',
  'help.jobs.disable.description': 'Desactiva un trabajo (sigue configurado; las corridas se detienen)',
  'help.jobs.disable.argument.job_id': 'Id del trabajo',
  'help.jobs.disable.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.disable.option.tenant': 'Inquilino (despacho)',
  'help.jobs.run_due.description':
    'Punto de entrada del tick: reclama y corre cada trabajo vencido (llámalo desde cron/launchd; --live habilita las lecturas externas)',
  'help.jobs.run_due.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.run_due.option.tenant': 'Inquilino (despacho)',
  'help.jobs.history.description': 'Bitácora de corridas (las más recientes primero)',
  'help.jobs.history.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.jobs.history.option.tenant': 'Inquilino (despacho)',
  'help.jobs.history.option.job': 'Sólo este trabajo',
  'help.jobs.history.option.limit': 'Filas que se muestran (por omisión, 20)',
  'help.webhooks.description': 'Tokens de webhook entrantes: credenciales dedicadas que despiertan a un agente lector restringido',
  'help.webhooks.create.description': 'Crea un token de webhook (el token en claro se muestra UNA vez y nunca se guarda)',
  'help.webhooks.create.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.webhooks.create.option.tenant': 'Inquilino (despacho)',
  'help.webhooks.create.option.source': 'Tipo de origen: {kinds}',
  'help.webhooks.list.description': 'Lista los tokens de webhook (nombres y uso, nunca el valor de los tokens)',
  'help.webhooks.list.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.webhooks.list.option.tenant': 'Inquilino (despacho)',
  'help.webhooks.list.option.json': 'salida en JSON',
  'help.webhooks.disable.description': 'Desactiva un token de webhook (las entregas con él empiezan a fallar con 401)',
  'help.webhooks.disable.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.webhooks.disable.option.tenant': 'Inquilino (despacho)',
  'help.webhooks.deliveries.description': 'Entregas entrantes recientes: estado, borradores creados y señales de sospecha',
  'help.webhooks.deliveries.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.webhooks.deliveries.option.tenant': 'Inquilino (despacho)',
  'help.webhooks.deliveries.option.limit': 'Filas que se muestran (1-200)',
  'help.webhooks.deliveries.option.json': 'salida en JSON',
  'help.outbox.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.outbox.option.user': 'Quién ejecuta (por omisión: el único usuario activo del inquilino)',
  'help.outbox.option.list': 'Sólo lista, sin ejecutar (obsoleto: usa `outbox list`)',
  'help.outbox.run.argument.id': 'ids de las operaciones que se ejecutan; omítelos para revisar toda la cola de forma interactiva',
  'help.outbox.run.option.entity': 'Entidad legal (id, RFC o parte del nombre)',
  'help.outbox.run.option.user': 'Quién ejecuta (por omisión: el único usuario activo del inquilino)',
  // ==== I11 · report labels (issue #153) ============================
  //
  // The names of the sections and of the twelve `fs_category` values are NOT
  // the firm's own criterion but a standard: the entity's accounting framework
  // fixes them, not the reader's language. They are translated here; they do
  // NOT go to the configuration panel.
  'report.section.assets': 'Activo',
  'report.section.liabilities': 'Pasivo',
  'report.section.equity': 'Capital contable',
  'report.section.revenue': 'Ingresos',
  'report.section.expenses': 'Gastos',
  // Both words, always. The label does not depend on the sign.
  'report.section.result_of_the_period': 'Utilidad (pérdida) del ejercicio',
  'report.category.current_assets': 'Activo circulante',
  'report.category.non_current_assets': 'Activo no circulante',
  'report.category.current_liabilities': 'Pasivo a corto plazo',
  'report.category.long_term_liabilities': 'Pasivo a largo plazo',
  'report.category.equity': 'Capital contribuido',
  'report.category.ori': 'Otros resultados integrales',
  'report.category.revenue': 'Ingresos',
  'report.category.cogs': 'Costo de ventas',
  'report.category.operating_expenses': 'Gastos de operación',
  'report.category.other_income': 'Otros ingresos',
  'report.category.other_expenses': 'Otros gastos',
  'report.category.tax': 'Impuestos',
  'report.category.other': 'Otros',
  'report.total_of': 'Total de {name}',
  'report.total_liabilities_and_equity': 'Suma del pasivo y el capital contable',
  'report.net_income': 'Utilidad neta',
  'report.balance_check': 'Activo {assets} = Pasivo + Capital {total}',
  'report.income_summary': 'Ingresos {revenue}   Gastos {expenses}   Utilidad neta {net}',

  // ==== I11 · doctor by key (MNE-001-475, issue #153) ====
  'doctor.check.permission_conflicts': 'Segregación de funciones (permisos)',
  'doctor.summary.title': 'Revisión de salud de Mnemosine',
  'doctor.summary.fail': 'Hay fallas que impiden operar. Resuélvelas en el orden en que aparecen.',
  'doctor.summary.warn': 'Opera con avisos.',
  'doctor.summary.ok': 'Todo en orden.',
  'doctor.cli_consistency.new_violations': '{count, plural, one {# violación nueva} other {# violaciones nuevas}} — {sample}',
  'doctor.cli_consistency.new_violations_fix':
    'La superficie del CLI se mantiene coherente porque cada verbo sale de una lista cerrada y cada bandera del diccionario único. ' +
    'Corrige el comando, o —si el cambio es deliberado— amplía el vocabulario en src/cli/kernel/vocabulary.ts. ' +
    'La línea base de src/cli/kernel/audit.ts NO se amplía.',
  'doctor.cli_consistency.stale':
    '{count, plural, one {# entrada de la línea base ya no se viola: bórrala} other {# entradas de la línea base ya no se violan: bórralas}}',
  'doctor.cli_consistency.inherited':
    'sin violaciones nuevas; {count, plural, one {queda # heredada} other {quedan # heredadas}} en la línea base{stale}',
  'doctor.cli_consistency.clean': 'la superficie cumple todas las reglas{stale}',
  'doctor.cli_consistency.inherited_fix':
    'Las heredadas son deuda conocida y congelada: nueve son decisiones de nombre, tres exigen retirar una forma corta ya publicada, ' +
    'y ocho piden que cuatro listados se puedan paginar.',
  'doctor.ledger_integrity.ok': 'account_balances = Σ líneas posteadas, y todo posteado tiene su rastro',
  'doctor.ledger_integrity.drift':
    '{count}{capped, select, yes {+} other {}} (cuenta, periodo) donde account_balances ≠ Σ líneas posteadas — todo reporte encima hereda la diferencia',
  'doctor.ledger_integrity.untraced':
    "{count, plural, one {# asiento posteado} other {# asientos posteados}} sin fila 'post' en audit_log — hechos sin autor",
  'doctor.ledger_integrity.fix':
    'La deriva de saldos se investiga ANTES de recalcular: desde la 041 una línea posteada no se edita, ' +
    'así que una diferencia nueva apunta al camino de escritura de account_balances, no a las líneas.',
  'doctor.permission_conflicts.ok': 'ningún usuario activo acumula permisos en conflicto',
  'doctor.permission_conflicts.fix':
    'Reparte los permisos en conflicto entre usuarios distintos, o acepta el riesgo a sabiendas ' +
    '(en un despacho unipersonal es inevitable; el maker-checker por póliza vive en el panel: segregacion_de_funciones).',
  'doctor.guarantee_triggers.unsealed':
    '{loose} de {total, plural, one {# garantía} other {# garantías}} sin sellar{off, plural, =0 {} one { (# APAGADA)} other { (# APAGADAS)}}: {list}',
  'doctor.guarantee_triggers.fix': 'ALTER TABLE <tabla> ENABLE ALWAYS TRIGGER <disparador>  — y averigua QUIÉN lo apagó y por qué',
  'doctor.guarantee_triggers.ok':
    '{count, plural, one {# garantía en ENABLE ALWAYS: ni session_replication_role la calla} other {# garantías en ENABLE ALWAYS: ni session_replication_role las calla}}',
  'doctor.bank_statements.unnamed_file': '(sin nombre)',
  'doctor.bank_statements.scope':
    '{tenants, plural, one {# inquilino revisado} other {# inquilinos revisados}}{blind, plural, =0 {} other {, # sin poder mirarse}}',
  'doctor.bank_statements.unrepaired': 'esta base registró la 051 antes de su corrección',
  'doctor.bank_statements.unique_index': 'el índice de contenido es ÚNICO y se traga movimientos legítimamente idénticos',
  'doctor.bank_statements.blind_trigger': 'el disparador no vigila content_hash, así que la huella se puede forjar a mano',
  'doctor.bank_statements.already_missing':
    'ya {lines, plural, one {falta # línea} other {faltan # líneas}} en {statements, plural, one {# extracto} other {# extractos}}: {detail}',
  'doctor.bank_statements.unrepaired_fix':
    'npm run migrate  — aplica la 072; las líneas ya perdidas hay que reimportarlas a mano, el remedio devuelve la capacidad, no el dato',
  'doctor.bank_statements.short':
    '{lines, plural, one {# línea declarada y no presente} other {# líneas declaradas y no presentes}} en {statements, plural, one {# extracto} other {# extractos}} ({scope}): {detail}',
  'doctor.bank_statements.short_fix':
    'compara antes de tocar nada: si esas líneas están en la cuenta bajo OTRO extracto de periodo traslapado, la base está sana y ' +
    'esto es el hueco declarado de la 051. Sólo si no aparecen en ninguna parte hubo pérdida, y entonces se reimporta el archivo con ' +
    'la cuenta a la vista de un humano — nunca soltando la fila de bank_statements, que es evidencia',
  'doctor.bank_statements.blind':
    'el catálogo está reparado, pero {scope}: sin poder leer sus extractos no puedo decir que estén completos',
  'doctor.bank_statements.blind_fix': 'revisa que el rol de la aplicación pueda consultar bank_statements con contexto de inquilino',
  'doctor.bank_statements.ok':
    'el índice de contenido no es único, el disparador impone la huella, y ningún extracto tiene menos líneas de las que declaró ({scope})',
  'doctor.auditor_role.missing':
    'mnemosine_auditor no existe: dar acceso a un auditor externo hoy exige prestarle credenciales de ESCRITURA sobre los libros',
  'doctor.auditor_role.missing_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (no cabe en una migración: el migrador no tiene CREATEROLE, y es a propósito)',
  'doctor.auditor_role.bypasses_rls': 'IGNORA LA RLS (BYPASSRLS): ve los libros de TODOS los inquilinos',
  'doctor.auditor_role.superuser': 'es SUPERUSUARIO',
  'doctor.auditor_role.creates_roles': 'puede crear roles',
  'doctor.auditor_role.writes': 'tiene ESCRITURA sobre {grants}',
  'doctor.auditor_role.grave_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  — el guion reafirma NOBYPASSRLS y revoca; averigua además QUIÉN se lo concedió',
  'doctor.auditor_role.login':
    'mnemosine_auditor tiene LOGIN: está pensado como paquete de privilegios que se concede a cuentas NOMINALES (una por auditor), no como cuenta compartida',
  'doctor.auditor_role.login_fix':
    'ALTER ROLE mnemosine_auditor NOLOGIN;  y emite una cuenta por persona: CREATE ROLE <auditor> LOGIN IN ROLE mnemosine_auditor',
  'doctor.auditor_role.matviews':
    'mnemosine_auditor lee {count, plural, one {# vista materializada} other {# vistas materializadas}} ({views}): ' +
    'no las filtra la RLS y las construye un rol con BYPASSRLS, así que contienen los libros de TODOS los inquilinos',
  'doctor.auditor_role.matviews_fix': "psql \"$SUPERUSER_URL\" -f scripts/rol-auditor.sql  — su bloque 4 revoca toda relkind = 'm'",
  'doctor.auditor_role.coverage_unmeasured':
    'mnemosine_auditor existe y está bien acotado, pero no se pudo medir su cobertura de tablas',
  'doctor.auditor_role.coverage_unmeasured_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (su bloque de verificación imprime los dos conteos)',
  'doctor.auditor_role.ungranted':
    'mnemosine_auditor sólo lee {readable} de las {total} tablas aisladas: ' +
    '{missing, plural, one {# tabla nació} other {# tablas nacieron}} después del último GRANT',
  'doctor.auditor_role.ungranted_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (vuelve a conceder y fija los privilegios por defecto de lo que venga)',
  'doctor.auditor_role.global_tables':
    'además {count, plural, one {# sin inquilino, que debe ser sólo referencia global} other {# sin inquilino, que deben ser sólo referencia global}} ({tables})',
  'doctor.auditor_role.ok': 'sólo lectura sobre {count} tablas aisladas, NOLOGIN y sujeto a la RLS{note}',
  // ==== end of I11 · doctor by key ====
  // ==== el periodo de prueba alojado de NVIDIA (MNE-001-448, #644 P8) ====
  'providers.trial.terms.what':
    '{profile} usa el catálogo de API alojado de NVIDIA ({host}), una prueba para desarrollo y evaluación.',
  'providers.trial.terms.records':
    'Los términos de servicio de la prueba de la API de NVIDIA le permiten registrar lo que envías y lo que vuelve, y piden no enviar datos personales: nunca le envíes la contabilidad ni los documentos de un cliente.',
  'providers.trial.terms.limits':
    'Sus endpoints pueden retirarse sin aviso. Para trabajo de clientes elige otro proveedor, o NVIDIA NIM en tu propio servidor.',
  'providers.trial.accept_default': '¿Guardar {profile} como tu proveedor por omisión con estos términos?',
  'providers.trial.not_saved': 'Términos no aceptados: {profile} no se guardó como proveedor por omisión.',
  'providers.trial.accept_session': '¿Usar {profile} en esta sesión con estos términos?',
  'providers.trial.refused.unattended':
    '{profile} está en la prueba alojada de NVIDIA ({host}), que registra lo que recibe: ingest, jobs run-due y la importación de init nunca abren una sesión ahí. Elige otro proveedor para ellos.',
  'providers.trial.refused.no_terminal':
    '{profile} está en la prueba alojada de NVIDIA ({host}), cuyos términos piden un sí en una terminal, y aquí no hay ninguna. Córrelo en una terminal o elige otro proveedor.',
  'providers.trial.refused.declined': 'Términos no aceptados: no se abrió ninguna sesión con {profile}.',
  'providers.trial.refused.not_accepted':
    '{profile} está en la prueba alojada de NVIDIA ({host}), y sus términos no se aceptaron en esta sesión. Inicia mnemosine chat --provider {profile} en una terminal para leerlos y aceptarlos.',
  // --- pay-run · corrida (MNE-001-068) -----------------------------------
  'payrun.file_invalid': 'El archivo de insumos {path} no se puede usar: {detail}. No se calculó nada.',
  'payrun.file_duplicate_employee':
    'El empleado {employee} aparece dos veces en {path}: una corrida lleva un recibo por empleado. No se calculó nada.',
  'payrun.create.period_required':
    'Falta --period: una corrida es de un periodo de pago de la entidad, y no se adivina del reloj.',
  'payrun.create.next': 'Sigue: `mnemosine pay-run calculate {id} --file <insumos.json>`.',
  'payrun.calculate.file_required':
    'Falta --file: los insumos del periodo (percepciones y deducciones) vienen de un archivo JSON.',
  'payrun.calculate.next': 'Sigue: `mnemosine pay-run approve {id} --dry-run` para ver lo que escribe aprobar.',
  'payrun.calculate.paycheck_left_the_system':
    'La corrida {id} no se puede volver a calcular: {count, plural, one {# de sus recibos ya tiene} ' +
    'other {# de sus recibos ya tienen}} un CFDI de nómina o un lote de depósito, y volver a calcular ' +
    'reemplaza todos los recibos de la corrida. No se cambió nada.',
  'payrun.calculate.changed_meanwhile': 'La corrida {id} cambió mientras se calculaba. No se escribió nada.',
  'payrun.approve.confirm':
    'Vas a APROBAR la corrida {id} ({employees, plural, one {# empleado} other {# empleados}}, ' +
    'neto {net}) y a escribir su pasivo patronal. La aprobación no se deshace. ¿Continuar?',
  'payrun.approve.aborted': 'Sin cambios: la corrida no se aprobó.',
  'payrun.approve.done': 'Corrida {id} aprobada · {status}',
  'payrun.approve.repeated': 'La corrida {id} ya se aprobó con esta llave: se muestra el resultado grabado · {status}',
  'payrun.approve.dry_run': 'Ensayo: la corrida {id} se aprobó y se deshizo; sigue en {status}.',
  // --- pay-schedule (MNE-001-403, #587) · pay-period (MNE-001-404, #613) --
  'paycalendar.value_invalid': '{flag} {value} no es válido: usa uno de {allowed}. No se escribió nada.',
  'paycalendar.number_invalid': '{flag} {value} no es válido: usa un número entero de {min} a {max}.',
  'paycalendar.schedule.name_required': 'Falta --name: un calendario de nómina necesita un nombre que el contador reconozca.',
  'paycalendar.schedule.name_too_long': '--name pasa de {max} caracteres: acórtalo. No se escribió nada.',
  'paycalendar.schedule.first_start_invalid':
    '--first-start {value} no es una fecha (AAAA-MM-DD): es el primer día del primer periodo. No se escribió nada.',
  'paycalendar.schedule.dry_run': 'Ensayo: el calendario es válido; no se escribió nada.',
  'paycalendar.schedule.next': 'Siguiente: `mnemosine pay-period create --schedule {id} --count <n> --dry-run`.',
  'paycalendar.schedule.empty': 'No hay calendarios de nómina en esta entidad.',
  'paycalendar.period.schedule_required': 'Falta --schedule: los periodos pertenecen a un calendario de nómina de la entidad.',
  'paycalendar.period.count_required': 'Falta --count: cuántos periodos crear, de 1 a {max}.',
  'paycalendar.period.dry_run':
    'Ensayo: se crearían {count, plural, one {# periodo} other {# periodos}}; no se escribió nada.',
  'paycalendar.period.done':
    '{count, plural, =0 {No se creó ningún periodo: ya existían.} one {Se creó # periodo.} other {Se crearon # periodos.}}',
  'paycalendar.period.empty': 'No hay periodos de nómina en esta entidad.',

  'prepaid.run.key_replayed':
    'Llave de idempotencia ya consumada: se devuelve el resultado grabado y no se volvió a devengar.',
  'prepaid.run.key_reversed':
    'La llave "{key}" grabó asientos que después se reversaron ({entries}). Devolver ese resultado ' +
    'diría que {period} está devengado cuando no lo está. Vuelve a correr con una llave nueva ' +
    '(es otra corrida, no un reintento) o sin --idempotency-key.',
  'prepaid.run.key_partial':
    'La llave "{key}" grabó una corrida de {period} que falló en {failed} anticipo(s), y {pending} ' +
    'anticipo(s) siguen sin devengar en {period}. Devolver ese resultado repetiría la falla sin ' +
    'volver a intentarlo. Vuelve a correr con una llave nueva (es otra corrida, no un reintento) o ' +
    'sin --idempotency-key; ahí se imprimen los errores.',
  'prepaid.run.key_busy':
    'Otra corrida con la llave "{key}" sigue trabajando. Espera a que termine y reintenta con la ' +
    'misma llave: el reintento devuelve su resultado grabado.',
  'payrun.post.confirm':
    'Vas a CONTABILIZAR la póliza de la corrida {id} (cargos {debits} = abonos {credits}) ' +
    'sin pasar por la revisión. Una póliza contabilizada sólo se deshace con una reversa. ¿Continuar?',
  'payrun.post.aborted': 'Sin cambios: la póliza no se contabilizó.',
  'payrun.post.dry_run': 'Ensayo: la póliza de la corrida {id} cuadra (cargos {debits} = abonos {credits}); no se escribió nada.',
  'payrun.post.drafted': 'La póliza de la corrida {id} quedó como borrador {draft}: apruébala con `mnemosine review`.',
  'payrun.post.posted': 'Póliza de la corrida {id} contabilizada como {number}.',
  'payrun.post.repeated': 'La póliza de la corrida {id} ya se escribió con esta llave: se muestra el resultado grabado.',
  // The law row of the employment subsidy's excess over the ISR (#600).
  'payroll.employment_subsidy.excess_rule_unknown':
    'El parámetro legal {key} vigente en la fecha de pago {payDate} vale {value} (fila en vigor desde {effectiveFrom}) ' +
    'y sólo 0 o 1 es una regla: con 1 el subsidio que excede al ISR se entrega al trabajador en efectivo, con 0 no se ' +
    'entrega nada. Corrige la fila contra su fuente oficial; ningún recibo se calcula con una parte adivinada.',

  // --- e-accounting voucher|subledger generate (MNE-001-054, #328) --------
  'help.e_accounting.voucher.description': 'Las pólizas del periodo que el SAT pide a requerimiento: PolizasPeriodo 1.3',
  'help.e_accounting.voucher.generate.description':
    'Genera y archiva el XML de pólizas del periodo con el nodo de evidencia de cada renglón (CompNal, Cheque, Transferencia, OtrMetodoPago) y su hash',
  'help.e_accounting.voucher.option.closing':
    'las pólizas del mes 13, donde caen los ajustes de cierre del ejercicio; con él, --period nombra el ejercicio (2026)',
  'help.e_accounting.voucher.option.validate_uuids': 'comprueba además la forma de cada UUID de CFDI que declaran las pólizas',
  'help.e_accounting.subledger.description': 'Los auxiliares que el SAT pide a requerimiento: de folios o de cuentas',
  'help.e_accounting.subledger.generate.description':
    'Genera y archiva el auxiliar de folios (AuxiliarFolios 1.3) o el de cuenta y subcuenta (AuxiliarCtas 1.3) con su hash',
  'help.e_accounting.subledger.option.closing':
    'el auxiliar del mes 13, donde caen los ajustes de cierre del ejercicio; con él, --period nombra el ejercicio (2026)',
  'help.e_accounting.subledger.option.kind': 'qué auxiliar: folios (de folios) o accounts (de cuenta y subcuenta); sin valor por omisión',
  'help.e_accounting.request.option.period':
    'periodo a declarar: 2026-02, su nombre o el id del periodo fiscal; con --closing, el ejercicio (2026)',
  'help.e_accounting.request.option.request_type':
    'el requerimiento al que responde el archivo (TipoSolicitud): AF acto de fiscalización, FC fiscalización compulsa, DE devolución, CO compensación; sin valor por omisión',
  'help.e_accounting.request.option.order_number': 'número de orden (NumOrden), obligatorio con AF y FC: ABC1234567/26',
  'help.e_accounting.request.option.procedure_number': 'número de trámite (NumTramite), obligatorio con DE y CO: DE202600000009',
  'help.e_accounting.request.option.dry_run': 'lo construye y muestra el veredicto; no archiva nada ni escribe archivo',
  'help.e_accounting.request.option.output': 'escribe el XML en esta ruta (el almacén de artefactos guarda su propia copia)',
  'help.e_accounting.request.option.yes': 'no pregunta antes de sobrescribir cuando -o nombra un archivo que ya existe',
  'e_accounting.request.type_missing':
    'Indica a qué requerimiento responde el archivo con --request-type ({types}). Las pólizas y los auxiliares se entregan a requerimiento, nunca de oficio, y el archivo dice a cuál responde: no hay valor por omisión.',
  'e_accounting.period.missing':
    'Indica el mes: --period YYYY-MM (o su nombre o id), o --closing para el mes 13 del ejercicio.',
  'e_accounting.subledger.kind_missing':
    'Indica qué auxiliar con --kind: folios (de folios) o accounts (de cuenta y subcuenta). No hay valor por omisión: entregar el equivocado es no contestar el requerimiento.',
  'e_accounting.subledger.kind_unknown': '--kind «{value}» no existe: usa folios o accounts.',
  'e_accounting.target.dry_run': '(ensayo: no se escribió nada)',
  'e_accounting.target.not_written': '(no se escribió: el archivo está bloqueado)',
  'e_accounting.request.type_unknown':
    'TipoSolicitud «{value}» no existe. El Anexo 24 admite {types}: AF acto de fiscalización, FC fiscalización compulsa, DE devolución, CO compensación. No hay valor por omisión.',
  'e_accounting.request.order_missing':
    'TipoSolicitud {type} exige --order-number (NumOrden): el número de la orden de la revisión que pidió este archivo.',
  'e_accounting.request.order_not_filing':
    'TipoSolicitud {type} lleva --order-number, no --procedure-number: los dos dirían que el archivo responde a la vez a una revisión y a una devolución o compensación.',
  'e_accounting.request.filing_missing':
    'TipoSolicitud {type} exige --procedure-number (NumTramite): el número del trámite de devolución o compensación al que este archivo da soporte.',
  'e_accounting.request.filing_not_order': 'TipoSolicitud {type} lleva --procedure-number, no --order-number.',
  'e_accounting.request.order_shape':
    'NumOrden «{value}» no tiene el formato del SAT: tres letras, siete dígitos, una diagonal y dos dígitos (ABC1234567/26). Con otro valor el esquema rechaza el archivo entero.',
  'e_accounting.request.filing_shape':
    'NumTramite «{value}» no tiene el formato del SAT: dos letras y doce dígitos (DE202600000009). Con otro valor el esquema rechaza el archivo entero.',
  'e_accounting.target.store': '(almacén de artefactos)',
  'e_accounting.target.label': 'destino {target}',
  'e_accounting.sealing.declared':
    'El despacho tiene declarado «{policy}» en efirma_sellado_contabilidad_electronica, y este comando no sella: el archivo sale sin Sello, noCertificado ni Certificado.',
  'e_accounting.dry_run.done': '--dry-run: no se archivó nada y no se escribió ningún archivo.',
  'e_accounting.archive.already_there':
    'Estos mismos bytes ya estaban archivados: no se creó una versión nueva. El generador es determinista.',
  'e_accounting.voucher.title': 'Pólizas {month}/{year}',
  'e_accounting.voucher.summary':
    '{vouchers, plural, one {# póliza} other {# pólizas}}, {traced} con rastro de pago · cargos {debit} · abonos {credit}',
  'e_accounting.voucher.blocked':
    'No se generó ningún archivo entregable: {blocking, plural, one {# hallazgo bloqueante} other {# hallazgos bloqueantes}} arriba, cada uno con su número de póliza. Corrígelos y vuelve a generar.',
  'e_accounting.subledger.title_folios': 'Auxiliar de folios {month}/{year}',
  'e_accounting.subledger.title_accounts': 'Auxiliar de cuentas {month}/{year}',
  'e_accounting.subledger.summary':
    '{vouchers, plural, one {# póliza} other {# pólizas}} · {lines, plural, one {# renglón} other {# renglones}}',

  'payslip.run_required': 'Falta --run: nombra la corrida cuyos recibos quieres (`pay-run create` imprimió su id).',
  'imss.sua.period_invalid': '--period "{period}": usa el mes como AAAA-MM, por ejemplo 2026-07.',
  'imss.sua.exists': '{path} ya existe y no se sobrescribe sin pedirlo: usa otra ruta, o --yes.',
  'imss.sua.tty':
    'El archivo del SUA lleva el NSS, RFC y CURP de toda la plantilla y no se imprime en una terminal: nombra un archivo con -o, o redirige stdout.',
  'imss.sua.mismatch': 'El archivo del SUA no cuadra con el pasivo patronal ya apuntado, así que no se entrega: {findings}',
  'imss.sua.finding.no_liability':
    'el archivo declara {file} de {concept} y no hay pasivo patronal apuntado en el mes contra el que cotejarlo: la cifra sale de un solo camino',
  'imss.sua.finding.mismatch': '{concept}: el archivo declara {file} y el pasivo apuntado dice {ledger}',
  'imss.sua.dry_run': 'Simulación: el archivo del SUA de {count} empleado(s) se armó y se cotejó; no se escribió archivo ni se registró nada.',
  'payslip.status_invalid': '--status {status}: usa uno de {states}.',
  'imss.sua.not_filed':
    'Archivo del SUA de {count} empleado(s) armado y registrado como declaración en borrador. No se envió nada: cárgalo en el SUA y paga.',
  // --- e-accounting catalog|balance seal · sellar (EFIRMA-4, #442) --------
  'anexo24.seal.refused_by_policy':
    'No se sella: la política {policy} está en "{value}" y el sistema sólo sella con la e.firma ' +
    'bajo "{optIn}". No se descifró nada y la bitácora de accesos no tiene fila por esto.',
  'anexo24.seal.done':
    'Sellado con la e.firma (certificado {certificate}): Sello, noCertificado y Certificado puestos, ' +
    'y el archivo valida contra el XSD del SAT.',
  'anexo24.seal.nothing_filed':
    'NO SE PRESENTÓ NADA ANTE EL SAT. El SAT no tiene servicio web para recibir este archivo: ' +
    'cárgalo tú en el portal del SAT (Contabilidad electrónica) y guarda el acuse de recepción.',
  'help.e_accounting.catalog.seal.description':
    'Sella con la e.firma de la entidad el CtaCatalogo archivado de un mes (sólo con sellar_con_custodia); no presenta nada',
  'help.e_accounting.balance.seal.description':
    'Sella con la e.firma de la entidad la balanza archivada de un periodo (sólo con sellar_con_custodia); no presenta nada',
  'help.e_accounting.seal.option.period': 'mes del archivo archivado: YYYY-MM (el ejercicio con --closing)',
  'help.e_accounting.catalog.seal.option.period': 'mes del catálogo archivado: YYYY-MM',
  'help.e_accounting.balance.check.option.type': 'tipo de envío a verificar: N normal, C complementaria (pide --modified)',
  'help.e_accounting.balance.check.option.modified': 'FechaModBal de la balanza complementaria; obligatoria con --type C',
  'anexo24.seal.not_archived':
    'No hay {document} archivado sin sellar de {period}: genéralo primero, revísalo y después séllalo.',
  'anexo24.seal.rfc_mismatch':
    'La e.firma es de {certificateRfc} y el documento declara {documentRfc}: no se sella.',
  'anexo24.seal.not_sat_serial':
    'El número de serie {serial} no es un número de certificado del SAT (20 dígitos): no puede ir en noCertificado.',
  'anexo24.seal.separator_in_attribute':
    'No se sella: {element} (cuenta {account}) tiene "|" en {attribute} ("{value}"). El Anexo 24 prohíbe "|" en ' +
    'cualquier atributo porque separa los campos de la cadena original. Corrige el valor y vuelve a generar.',
  'anexo24.seal.source_invalid':
    'No se sella: el archivo archivado no valida contra el XSD del SAT ({errors}). No se descifró nada.',
  'help.e_accounting.seal.option.type': 'tipo de envío de la balanza archivada: N normal, C complementaria',
  'help.e_accounting.seal.option.closing': 'la balanza de cierre, archivada como mes 13',
  'help.e_accounting.seal.option.output': 'escribe además el XML sellado en esta ruta',

  // ==== MNE-001-418 · help by key, cfdi post (issue #620) ====
  'help.cfdi.post.description':
    'Contabiliza en CxC un CFDI que emitió esta entidad: la factura de cliente con su UUID y su póliza',
  'help.cfdi.post.argument.uuid': 'UUID de un CFDI que emitió esta entidad, como lo imprime cfdi list',
  'help.cfdi.post.option.account': 'cuenta de ingresos, por código o id, de cada concepto sin cuenta propia',
  'help.cfdi.post.option.json': 'un renglón: número de factura, estado, saldo por cobrar, número de póliza y dry_run',
  'cfdi.lookup.same_uuid_twice':
    'El CFDI {uuid} está guardado {count} veces en esta entidad, con UUID que sólo difieren en mayúsculas y minúsculas: {stored}. ' +
    'Son un solo folio fiscal, así que no se escogió ninguno. Mientras no quede sólo uno, este CFDI no se puede leer por su UUID.',
  'cfdi.post.bad_uuid':
    '"{uuid}" no es el UUID de un CFDI. Lista los CFDI emitidos por contabilizar con: mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending',
  'cfdi.post.confirm':
    '¿Contabilizar en CxC el CFDI {uuid} ({rfc}, {total} {currency}, MetodoPago {method, select, none {ausente} other {{method}}})? No se puede deshacer.',
  'cfdi.post.no_terminal':
    '{question} No hay terminal donde preguntar: córrelo de nuevo con --yes cuando estés seguro, o con --dry-run para ver antes el efecto.',
  'cfdi.post.would_post': 'Se contabilizaría el CFDI {uuid} como {invoice} para {rfc} · póliza {entry}',
  'cfdi.post.posted': 'CFDI {uuid} contabilizado como {invoice} para {rfc} · póliza {entry} · {due} por cobrar',
  // MNE-001-431 (#643): `cfdi status sync` y `cfdi status show --refresh` informan las facturas de proveedor que marcaron.
  'cfdi.status.bills_marked':
    '{count, plural, one {# factura de proveedor que lleva un CFDI que el SAT reporta cancelado recibió la marca} ' +
    'other {# facturas de proveedor que llevan un CFDI que el SAT reporta cancelado recibieron la marca}}. ' +
    'No se revirtió nada: su estado, su póliza y su saldo se quedan hasta que el contador decida.',
  'cfdi.post.nothing_written':
    'No se escribió nada. Para codificar antes un concepto: mnemosine bill inbox edit {id} --line <n> --account <code>',
  'cfdi.post.previous_account':
    'El renglón {line} tenía {code} {name} mientras este CFDI estaba guardado como factura de proveedor: sólo es referencia, no se contabiliza.',
  'cfdi.post.next':
    '{method, select, PPD {Su IVA queda como no cobrado (2125 en el catálogo sembrado) hasta que llegue su complemento de pago (REP).{parked, select, yes { Hay complementos de pago aparcados: mnemosine rep reconcile liga el que pague esta factura.} other {}}} other {Registra su cobro con: mnemosine receipt record {invoice}}}',
  'ingest.issued_left_to_code':
    'Queda por contabilizar a mano ({reason}): lo emitió esta entidad, así que es una venta. Contabilízalo en CxC con `mnemosine cfdi post {uuid}`; `mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending` lista los que esperan',
  'ingest.received_credit_note_to_inbox':
    'Nota de crédito recibida: el modelo no la redacta. Contabilízala contra su factura con `mnemosine bill inbox run <id>`; `mnemosine bill inbox list` la muestra, y el motivo si tiene que esperar',
  'ingest.preview.route.received_credit_note':
    'nota de crédito recibida: reglas del despacho y luego la bandeja; sin borrador de la IA. La contabiliza una regla que exija este tipo de documento o, si no, `mnemosine bill inbox run`',
  'ingest.summary.issued_to_post':
    '{count} de ellos los emitió esta entidad: contabiliza cada uno en CxC con `mnemosine cfdi post <uuid>`; lístalos con `mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending`.',
  'bill.inbox.edit.issued_post_with': 'Lo emitió esta entidad: contabilízalo en CxC con `mnemosine cfdi post {uuid}`.',
  'bill.inbox.run.issued_not_a_bill':
    'es un CFDI que emitió esta entidad, una venta y no una factura de proveedor: contabilízalo en CxC con `mnemosine cfdi post {uuid}`',
  // ==== MNE-001-444 (#644): the readiness answer of a provider's credential ====
  'provider.credential.env': '{variable} definida',
  'provider.credential.helper': 'api_key_cmd',
  'provider.credential.helper_in': 'api_key_cmd en {file}',
  'provider.credential.helper_in_shared':
    'api_key_cmd en {file}, un archivo de proyecto que comparte todo el que corre mnemosine en esa carpeta',
  'provider.credential.local': 'local, sin credencial',
  'provider.credential.none': 'sin credencial configurada',
  'provider.credential.missing': 'falta {variable}',
  'provider.credential.missing_at': 'falta {variable} (se obtiene en {where})',
  'provider.credential.refused': '{variable} no es una credencial de proveedor',
  'provider.credential.folder_key':
    '{label}; {file} la define, así que esa llave le sirve a todo el que corre mnemosine en esa carpeta',
  'provider.credential.folder_empty': '{label}; el {variable}= vacío de {file} tapa ~/.mnemosine/.env',
  'provider.credential.anthropic.api_key': 'ANTHROPIC_API_KEY definida, que lee el SDK de Anthropic',
  'provider.credential.anthropic.auth_token': 'ANTHROPIC_AUTH_TOKEN definida, un token bearer que envía el SDK de Anthropic',
  'provider.credential.anthropic.custom_header': 'una línea {header} en ANTHROPIC_CUSTOM_HEADERS',
  'provider.credential.anthropic.profile': 'sesión iniciada: perfil de Anthropic {profile} en {file}',
  'provider.credential.anthropic.federation':
    'federación de identidad de cargas de trabajo (ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID y un token de identidad)',
  'provider.credential.hint.missing':
    'El proveedor {name} no tiene credencial: define {variable} en tu shell o en ~/.mnemosine/.env.',
  'provider.credential.hint.missing_at':
    'El proveedor {name} no tiene credencial: define {variable} en tu shell o en ~/.mnemosine/.env (se obtiene en {where}).',
  'provider.credential.hint.anthropic_alternative': 'O inicia sesión con `ant auth login`, o define ANTHROPIC_AUTH_TOKEN.',
  'provider.credential.hint.helper_alternative': 'O dale al perfil un api_key_cmd en ~/.mnemosine/config.json.',
  'provider.credential.hint.refused':
    'El proveedor {name} nombra {variable} en api_key_env, y no es una credencial de proveedor: nombra una variable propia que guarde la llave.',
  'provider.credential.hint.keyless':
    'El proveedor {name} no tiene credencial configurada: dale un api_key_env o un api_key_cmd. Si su endpoint no pide llave, abre el chat con --provider {name}.',
  'provider.credential.hint.init': 'Para configurarlo: mnemosine init --section ai',
  'provider.credential.anthropic_rejected': 'Define ANTHROPIC_API_KEY en tu shell o en ~/.mnemosine/.env, o corre `ant auth login`.',
  'provider.switch.kept': 'La sesión sigue en {current}.',
  'provider.switch.done': 'Proveedor cambiado a {label} ({credential}). Conversación nueva.',
  // ==== end of MNE-001-444 ====
  // ==== MNE-001-452 (#645): what a shared project file may run ====
  'provider.credential.unapproved':
    'api_key_cmd en {file}, un archivo de proyecto compartido, sin aprobar aquí: no corre hasta que lo apruebes',
  'provider.credential.unbindable':
    'api_key_cmd en {file}, un archivo de proyecto compartido, en una forma que no se puede aprobar: no corre hasta que se reescriba',
  'provider.credential.hint.unbindable':
    'El proveedor {name} corre un api_key_cmd de {file}, un archivo de proyecto compartido, en una forma que no se puede aprobar: pide a quien lo mantiene que apunte providers.{name}.api_key_cmd a un script dentro del proyecto, corrido directo o con sh/bash/node/python, o a un comando fuera de él.',
  'provider.credential.unapproved_never':
    'api_key_cmd en {file}, un archivo de proyecto compartido: "project_helpers" es "never" en ~/.mnemosine/config.json, así que no corre',
  'provider.credential.unapproved_pair':
    '{variable} definida, pero {file}, un archivo de proyecto compartido, la manda a {host}, donde su proveedor no la recibe: sin aprobar aquí',
  'provider.credential.unchecked_host': 'un host que no pudo comprobar',
  'provider.credential.folder_routing':
    '{label}; {file} define {variables}, que le sirven a todo el que corre mnemosine en esa carpeta',
  'provider.credential.hint.unapproved_pair':
    'El proveedor {name} de {file}, un archivo de proyecto compartido, mandaría {variable} a {host}: si confías ese host con ella, corre `mnemosine providers approve {name}`.',
  'provider.credential.hint.unapproved':
    'El proveedor {name} corre un api_key_cmd de {file}, un archivo de proyecto compartido, que no has aprobado: lee providers.{name}.api_key_cmd ahí y, si confías en él, corre `mnemosine providers approve {name}`.',
  'provider.credential.hint.unapproved_never':
    'El proveedor {name} corre un api_key_cmd de {file}, un archivo de proyecto compartido, y "project_helpers" es "never" en ~/.mnemosine/config.json: define el perfil en tu propio archivo.',
  'help.providers.approve.description':
    'Aprueba, sólo para ti, lo que corre o envía un perfil del mnemosine.config.json de esta carpeta (como direnv allow)',
  'help.providers.approve.argument.profile': 'el perfil, como lo nombra el archivo de proyecto',
  'help.providers.approve.footer':
    'Ejemplos:\n' +
    '  Lee primero providers.vault.api_key_cmd en ./mnemosine.config.json; luego apruébalo para ti:\n' +
    '    mnemosine providers approve vault',
  'provider.approve.builtin': '{name} es un perfil de fábrica: no hay nada que aprobar.',
  'provider.approve.own_file': '{name} viene de tu propio {file}: no hay nada que aprobar.',
  'provider.approve.nothing':
    '{name} en {file} no corre ningún api_key_cmd ni manda una llave a otro host: no hay nada que aprobar.',
  'provider.approve.pair': 'Aprobado para ti: providers.{name} en {file} puede mandar {variable} a {host}. Otro host pide otra aprobación.',
  'provider.approve.helper':
    'Aprobado para ti: el api_key_cmd de providers.{name} en {file}, para {host}. Un comando o un host distinto pide otra aprobación.',
  'provider.approve.helper_scope':
    'Corre en esta carpeta, con el ./.env de la carpeta en su entorno. Un script de este proyecto que nombre queda aprobado por su contenido; un comando que se encuentra por PATH o npx, sólo por su nombre.',
  'provider.approve.never': '"project_helpers" es "never" en ~/.mnemosine/config.json, así que sigue sin correr.',
  // ==== end of MNE-001-452 ====
  // ==== MNE-001-447 (#644): a failover walk skips a link with no credential ====
  'provider.failover.unconfigured':
    'el proveedor {from} no tiene aquí una credencial que sirva, así que se saltó (`mnemosine status` dice por qué); se prueba {to}',
  // ==== end of MNE-001-447 ====
  // ==== MNE-001-470 · the first run and init offer the other language (issue #653) ====
  'cli.lang.offer': 'Para usar Mnemosine en español: mnemosine idioma es',
  'cli.lang.step.title': 'Idioma',
  'cli.lang.step.prompt': '¿Qué idioma?',
  // ==== end of MNE-001-470 ====
  // ==== MNE-001-469 · lang names the rung that decided, and lang --unset (issue #653) ====
  'help.lang.argument.language':
    'el idioma que se fija: {choices}; sin él, muestra el idioma en efecto y qué lo decidió',
  'help.lang.option.unset':
    'quita el idioma guardado en ~/.mnemosine/config.json, para que decida de nuevo la siguiente fuente',
  'cli.lang.examples':
    '\nEjemplos:\n' +
    '  Qué idioma usan ahora el CLI y el agente, y qué lo decidió:\n' +
    '    mnemosine lang\n' +
    '  Usar español en los dos; queda guardado en ~/.mnemosine/config.json:\n' +
    '    mnemosine lang es\n' +
    '  Quitar esa elección, para que decida de nuevo la siguiente fuente:\n' +
    '    mnemosine lang --unset\n',
  'cli.lang.name.es': 'español',
  'cli.lang.name.en': 'inglés',
  'cli.lang.in_effect': 'Idioma: {language} ({locale}), el del CLI y el del agente. Lo decide {rung}.',
  'cli.lang.rung.flag': 'la bandera {flag} de esta ejecución',
  'cli.lang.rung.env': '{variable}={value} en el entorno',
  'cli.lang.rung.user_config': 'tu propia elección, guardada en {file}',
  'cli.lang.rung.project_config': 'el {file} de esta carpeta',
  'cli.lang.rung.legacy_config': 'la clave antigua «language» en {file}',
  'cli.lang.rung.entity': 'el idioma de la entidad {entity}',
  'cli.lang.rung.default': 'el valor por omisión del sistema: nada más eligió uno',
  'cli.lang.change_hint': 'Cámbialo con: mnemosine lang {choices} (o con la variable de entorno {variable})',
  'cli.lang.unset_hint': 'Quita tu elección guardada con: mnemosine lang --unset',
  'cli.lang.set': 'Idioma fijado en {language} ({locale}) para el CLI y el agente, en {file}',
  'cli.lang.quarantined': 'Tu {file} anterior no se pudo leer y se reemplazó; hay una copia en {copy}',
  'cli.lang.takes_effect': 'Surte efecto desde el siguiente comando.',
  'cli.lang.shadowed_env': '{variable}={value} está puesta y tiene prioridad: quítala para que este cambio se aplique.',
  'cli.lang.shadowed': 'Todavía no se aplica: {rung} tiene prioridad; cámbialo para que esto se aplique.',
  'cli.lang.unset.done': 'Se quitó tu elección de idioma ({keys}) de {file}.',
  'cli.lang.unset.nothing': 'No hay elección de idioma guardada en {file}; no hay nada que quitar.',
  'cli.lang.unset_with_language': '--unset no lleva idioma: quita tu elección guardada (llegó «{language}»).',
};
