import { v4 as uuidv4 } from 'uuid';
import { toCalendarDate } from '../../utils/calendar-date.js';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import {
  postVendorPaymentEntry,
  postCustomerPaymentEntry,
  postReceiptApplicationEntry,
  postReceiptUnapplicationEntry,
  postReceiptReversalVatEntry,
  postVendorApplicationEntry,
  postVendorUnapplicationEntry,
  postCustomerCreditTransferEntry,
  type AplicacionPosterior,
} from '../accounting/ar-ap-posting.js';
import { BALANCE_TRANSFER_METHOD, CUSTOMER_CREDIT_TRANSFER_SOURCE, cashOnAccountSql } from './cash-on-account.js';
import { voidJournalEntryInTx, reverseWithinTransaction } from '../accounting/posting.js';
import { earlyPaymentDiscount } from '../ap/bill-service.js';
import {
  functionalCurrencyOf,
  resolverTipoCambio,
  type AplicacionCambiaria,
  type ContextoCambiario,
  type DiferenciaCambiaria,
} from '../accounting/moneda-origen.js';
import {
  ivaToReclassify, entityUsesCashBasisIva, resolveInvoiceMetodoPago, issuedVatStillParked, issuedVatOfOpenBalance,
  reclassRoles,
} from '../accounting/iva-cash-basis.js';
import { iepsKeptOnAccount, iepsMovedForInvoice } from '../accounting/ieps-cash-basis.js';
import {
  ADVANCE_TREATMENTS, advanceBackOnAccount, advanceSourceNote, backAsAdvance, cancelsUncausedIva, isAdvanceTreatment, capKept, keptIvaOf, iepsTakeOf,
  coveredCashOf, restitutedByRow, restitutedOf,
  keptOnAccount, releaseDayOf, reparkSameMonth, splitAdvance, storedAdvanceTreatment, takeFromAdvance, type AdvanceSplit, type AdvanceTake,
} from './customer-advance.js';
import { treatmentOfSales } from '../fiscal/sale-sources.js';
import { NotFoundError, ValidationError, AccountingError } from '../../utils/errors.js';
import type { JournalEntry } from '../../types/index.js';
import type { TranslationKey } from '../../i18n/index.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { billsDecidedByIngestion, cashLimitFinding, type CashDeductibilityFinding } from '../ap/cash-deductibility.js';
import { getPolicy } from '../policy/policy-service.js';
import { changePolicyHint } from '../policy/policy-hint.js';
import { todayFor } from '../policy/today.js';
import { FOREIGN_BANK_CODE, officialEnumeration } from '../sat/anexo24/official-enumerations.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../xml-ingestion/received-credit-note.js';

// ============================================================
// REGISTRAR UN PAGO QUE YA OCURRIÓ.
//
// Una implementación para las tres superficies —REST, terminal y agente—,
// porque la que había vivía dentro del handler de Express y la terminal no
// tenía forma de llegar a ella. Eso importaba más de lo que parece: el pago
// es lo que LIBERA el IVA aparcado de un CFDI a crédito, así que quien
// operara por terminal nunca acreditaba el IVA que ya había pagado.
//
// EL ESTADO ES 'completed', Y ES UNA DECISIÓN, NO UN DESCUIDO.
// La columna admite draft/pending/processing/completed/failed/void y esta
// función sólo escribe 'completed'. La razón: registrar un pago es decir
// «esto ya salió de mi banco». Los otros cuatro estados pertenecen a un
// programador de pagos que NO EXISTE —el endpoint que decía programarlos se
// retiró por eso mismo— y un pago que aún no ocurrió no puede tocar el
// mayor: postearía dinero que no se ha movido. Cuando exista ese
// programador, será él quien escriba esos estados y quien decida cuándo
// pasa al mayor; hasta entonces, pedir otro estado se rechaza en voz alta
// en vez de aceptarse y no significar nada.
//
// La entidad se exige y se usa para acotar TODA lectura: un pago no puede
// aplicarse a la factura de otra entidad ni conociendo su UUID.
// ============================================================

/** Único estado que esta función escribe. Ver la nota de arriba. */
const ESTADO = 'completed';

export interface AplicacionPago {
  /** Id de la factura (cliente) o del gasto (proveedor). */
  documentId: string;
  amountApplied: string;
  discountAmount?: string;
  /**
   * MNE-001-113 · customer side only: the ISR and VAT the customer withheld
   * and remits to the SAT for us. They settle the invoice together with
   * amountApplied but are not cash of the collection.
   */
  withholdingIsr?: string;
  withholdingIva?: string;
}

export interface EntradaPago {
  entityId: string;
  /** vendor_id o customer_id según el lado. */
  counterpartyId?: string;
  paymentAmount: string;
  paymentDate: Date | string;
  paymentMethod: string;
  bankAccountId?: string | null;
  referenceNumber?: string | null;
  memo?: string | null;
  applications: AplicacionPago[];
  /** Cualquier valor distinto de 'completed' se rechaza. */
  status?: string;
  /**
   * R4 · Tipo de cambio del DÍA DEL PAGO, cuando el pago está en otra moneda
   * que la funcional de la entidad. Si se omite, se resuelve de
   * `exchange_rates` con la fuente que dicte la política
   * `fuente_tipo_cambio`; si esa fuente no tiene tasa para la fecha, el
   * registro SE DETIENE y lo dice — nunca toma otra fuente en silencio.
   * DECIMAL(19,10) como string, igual que todo tipo de cambio del sistema.
   */
  exchangeRate?: string;
  /** Moneda del pago. Si se omite, se toma la del documento y se exige que
   *  todos coincidan. */
  currencyCode?: string;
  /**
   * UUID del CFDI tipo P (REP) que documenta este pago, cuando el pago nace
   * de ingerir ese comprobante. Con el índice del nodo `Pago`, forma la
   * llave que impide contabilizar dos veces el mismo movimiento: el índice
   * único parcial de la migración 036 lo rechaza en la base, no en el código.
   */
  cfdiUuid?: string | null;
  cfdiPagoIndice?: number | null;
  /**
   * SOLO lado cliente (049): permite que las aplicaciones sumen MENOS que el
   * pago — el remanente queda a cuenta (CR anticipo_clientes, nunca colgado
   * de la cuenta de control) — e incluso que no haya ninguna (anticipo puro,
   * que entonces exige counterpartyId y moneda). El lado proveedor no lo
   * acepta: un pago nuestro sin aplicar es otra historia.
   */
  onAccount?: boolean;
  /**
   * MNE-001-458 · customer side only: the IVA treatment stated for an
   * advance with no invoice ('16', '8', '0', 'exempt' or 'not-subject'). With
   * it the receipt posts its base to anticipo_clientes and its IVA to
   * iva_trasladado, and keeps both. Without it the cash goes on account as
   * before: only the caller knows whether it is an advance.
   */
  advanceTreatment?: string;
  /**
   * MNE-001-462 · customer side only: the cash a collection leaves on account
   * (`onAccount`, beyond what it applies) is an advance and causes its IVA
   * when collected (LIVA art. 1-B). With no `advanceTreatment` stated, it
   * takes the treatment of the invoices it collects (`treatmentOfSales`).
   * Opt-in, so a caller that does not ask records as before: the terminal
   * asks, the service's other callers keep their entries.
   */
  advanceTreatmentFromInvoice?: boolean;

  // ── EL RASTRO DE PAGO QUE LA PÓLIZA DECLARA (F07d) ────────────────────
  //
  // Los cuatro campos siguientes no cambian ni un asiento: existen porque el
  // XML de pólizas del Anexo 24 exige, DENTRO de la póliza que mueve dinero,
  // de dónde salió y a dónde fue. Se capturan en el mismo acto en que se
  // registra el pago porque después no hay a quién preguntárselo: el pago ya
  // ocurrió y el que lo hizo tenía el dato delante.

  /**
   * Número del cheque. La columna `check_number` existe desde la 002 y
   * `treasury-posting` la LEE en tres sitios (:1496, :1512, :1574) para
   * nombrar el cheque que se cobró; el INSERT de este servicio la OMITÍA y
   * el comando no ofrecía bandera, así que siempre valía NULL y los tres
   * lectores caían al `payment_number`. Capacidad huérfana al revés: no es
   * que nadie la lea, es que nadie la escribía.
   */
  checkNumber?: string | null;
  /**
   * La cuenta que RECIBIÓ el dinero (CtaDest del nodo de pago). Vive en el
   * pago y no en el maestro del tercero a propósito (064): la póliza declara
   * la cuenta de ESE movimiento, y leerla del maestro haría que una póliza de
   * hace tres años cambiara de respuesta al cambiar los datos del proveedor.
   */
  cuentaDestino?: string | null;
  /** Clave del banco destino en el c_Banco, cuando es nacional. */
  bancoDestinoSat?: string | null;
  /** Nombre del banco destino, cuando es extranjero: el Anexo 24 pide NOMBRE
   *  para el extranjero y CLAVE para el nacional. Son dos campos, no uno. */
  bancoDestinoExtranjero?: string | null;

  // #611 · customer side only: where the customer's money came from. On a
  // vendor payment the origin is our bank account, so these are refused there.
  /** The account the customer paid from (CtaOri); the one a cheque is drawn on. */
  payerAccount?: string | null;
  /** c_Banco code of the customer's bank (BancoOriNal, or BanEmisNal of a cheque). */
  payerBankCode?: string | null;
  /** Name of the customer's bank when it is foreign; never together with the code. */
  payerForeignBank?: string | null;
}

/** Longitud de `banco_destino_sat` (VARCHAR(3), c_Banco de tres dígitos). */
const LARGO_CLAVE_BANCO = 3;

/**
 * El rastro de pago, comprobado ANTES de tocar la base.
 *
 * Los dos primeros rechazos duplican restricciones que la 064 ya impone. No
 * es redundancia: una violación de CHECK sale de Postgres como
 * `banco_destino_nacional_o_extranjero` y un `value too long for type
 * character varying(3)`, que no le dicen nada a quien tecleó el comando y
 * además llegan DESPUÉS de que la transacción haya hecho medio trabajo. Lo
 * que se gana aquí es el mensaje, no la seguridad — la seguridad ya estaba.
 *
 * MNE-001-568 · `payment trace record` runs it on the merged trace (what is
 * stored plus what is given), so a completion is held to the capture's rules.
 * MNE-001-569 · the national code is checked against c_Banco here, so
 * `payment create --to-bank` refuses an off-list code at capture too.
 */
export function assertRastroDePago(
  entrada: Pick<EntradaPago, 'paymentMethod' | 'checkNumber' | 'cuentaDestino' | 'bancoDestinoSat' | 'bancoDestinoExtranjero'>,
  lado: 'cliente' | 'proveedor'
): void {
  const nacional = (entrada.bancoDestinoSat ?? '').trim();
  const extranjero = (entrada.bancoDestinoExtranjero ?? '').trim();
  const cuenta = (entrada.cuentaDestino ?? '').trim();

  if (nacional !== '' && extranjero !== '') {
    throw new ValidationError(
      `El pago declara banco destino nacional («${nacional}») y extranjero («${extranjero}») a la vez. ` +
        'El Anexo 24 pide la CLAVE del catálogo para el nacional y el NOMBRE para el extranjero: ' +
        'declarar los dos afirma dos cosas incompatibles sobre el mismo movimiento, y el archivo ' +
        'las lleva tal cual a la autoridad.' +
        // #532: 999 is the code the file itself puts on a foreign bank, next to its name.
        (nacional === FOREIGN_BANK_CODE
          ? ` Un banco extranjero se da sólo con su nombre: la póliza le pone la clave ${FOREIGN_BANK_CODE} al escribirlo.`
          : '')
    );
  }
  if (nacional !== '' && nacional.length !== LARGO_CLAVE_BANCO) {
    throw new ValidationError(
      `La clave de banco destino «${nacional}» tiene ${nacional.length} caracteres y el c_Banco ` +
        `del SAT son ${LARGO_CLAVE_BANCO}. Un banco no se identifica por su nombre en este campo: ` +
        'si el banco es extranjero, dilo con el nombre en el campo de banco extranjero.'
    );
  }
  // MNE-001-569 · the list the vouchers file is judged by, as #611 checks the
  // payer's bank: a code off it would be stored and then block the month.
  if (nacional !== '' && !officialEnumeration('c_Banco').has(nacional)) {
    throw new ValidationError(
      `La clave de banco destino «${nacional}» no está en el catálogo c_Banco del SAT (tres dígitos ` +
        'de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.'
    );
  }
  // El banco sin la cuenta es media pista. En el nodo de transferencia del
  // Anexo 24 la cuenta destino es lo obligatorio y el banco lo opcional, así
  // que guardar el banco solo produce exactamente el dato que el archivo NO
  // puede usar, y lo produce con aire de estar completo.
  if (cuenta === '' && (nacional !== '' || extranjero !== '')) {
    throw new ValidationError(
      'Se indicó el banco destino y no la cuenta destino. En la póliza del Anexo 24 la cuenta ' +
        'destino es el dato obligatorio del nodo de transferencia y el banco el opcional: el banco ' +
        'solo no permite emitir el rastro y sí aparenta que el pago ya lo tiene.'
    );
  }

  // El número de cheque pertenece al cheque. Escribirlo sobre una
  // transferencia haría que la póliza emitiera un nodo `Cheque` por dinero
  // que nunca se movió con uno — y `treasury-posting` ya lo lee dando por
  // hecho que `payment_method = 'check'` (:1275).
  const cheque = (entrada.checkNumber ?? '').trim();
  if (cheque !== '' && entrada.paymentMethod !== 'check') {
    throw new ValidationError(
      `Se dio número de cheque («${cheque}») a un pago ${lado === 'cliente' ? 'cobrado' : 'hecho'} ` +
        `por «${entrada.paymentMethod}». El número de cheque identifica un cheque: sobre otro método ` +
        'la póliza del Anexo 24 declararía un cheque que no existe. Usa la referencia bancaria para ' +
        'el folio de una transferencia.'
    );
  }
}

/** The payment methods whose node declares an origin bank: Cheque and Transferencia. */
const METHODS_WITH_AN_ORIGIN_BANK = ['check', 'spei', 'wire', 'ach'];

/**
 * #611 · THE PAYER'S SIDE OF A RECEIPT'S TRACE, checked before the database
 * is touched. The code is checked against the c_Banco of the vendored XSD,
 * the list the vouchers file is judged by, so a code the SAT would reject
 * never gets stored. The lengths and the pair repeat 335's columns and CHECK
 * for the message's sake, as `assertRastroDePago` does for the destination.
 * MNE-001-570 · `receipt trace record` runs it on the merged trace.
 */
export function assertPayerTrace(
  input: Pick<EntradaPago, 'paymentMethod' | 'checkNumber' | 'payerAccount' | 'payerBankCode' | 'payerForeignBank'>,
  side: 'cliente' | 'proveedor'
): void {
  const bank = (input.payerBankCode ?? '').trim();
  const foreign = (input.payerForeignBank ?? '').trim();
  const account = (input.payerAccount ?? '').trim();
  // Cheque/@Num allows 20 characters: a longer one would make the whole
  // vouchers file fail the XSD, so the receipt that brings it is refused.
  if (side === 'cliente' && (input.checkNumber ?? '').trim().length > 20) {
    throw new ValidationError(
      `El número de cheque «${(input.checkNumber ?? '').trim()}» pasa de los 20 caracteres que admite el ` +
        'nodo Cheque de la póliza del Anexo 24.'
    );
  }
  if (bank === '' && foreign === '' && account === '') return;
  if (side === 'proveedor') {
    throw new ValidationError(
      'El banco y la cuenta del pagador sólo se capturan en un cobro. En un pago a proveedor el ' +
        'origen es nuestra cuenta bancaria (`--bank`), y su clave c_Banco vive en esa cuenta.'
    );
  }
  if (!METHODS_WITH_AN_ORIGIN_BANK.includes(input.paymentMethod)) {
    throw new ValidationError(
      `Se dio banco o cuenta del cliente a un cobro por «${input.paymentMethod}». Sólo un cheque o ` +
        'una transferencia declaran de qué banco salió el dinero en la póliza del Anexo 24.'
    );
  }
  if (bank !== '' && foreign !== '') {
    throw new ValidationError(
      `El cobro declara banco del cliente nacional («${bank}») y extranjero («${foreign}») a la vez. ` +
        `Un banco extranjero se da sólo con su nombre: la póliza le pone la clave ${FOREIGN_BANK_CODE} al escribirlo.`
    );
  }
  if (bank !== '' && !officialEnumeration('c_Banco').has(bank)) {
    throw new ValidationError(
      `La clave de banco del cliente «${bank}» no está en el catálogo c_Banco del SAT (tres dígitos ` +
        'de la lista publicada). Si el banco es extranjero, dilo con su nombre en el campo de banco extranjero.'
    );
  }
  if (account !== '' && bank === '' && foreign === '') {
    throw new ValidationError(
      'Se indicó la cuenta del cliente y no su banco. El nodo de pago de la póliza exige el banco de ' +
        'origen: la cuenta sola no permite emitirlo y sí aparenta que el cobro ya tiene su rastro.'
    );
  }
  if (account.length > 50 || foreign.length > 150) {
    throw new ValidationError(
      'La cuenta del cliente admite hasta 50 caracteres y el nombre de su banco extranjero hasta 150, ' +
        'los mismos límites del nodo de pago de la póliza.'
    );
  }
}

/** Normaliza a NULL lo que llegó vacío: '' en la columna no es «no hay dato». */
function oNulo(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

interface DocumentoAplicado {
  id: string; numero: string; saldoAnterior: string; saldoNuevo: string;
  estado: string; moneda: string;
  /**
   * MNE-001-113 · customer side: the ISR and VAT the customer withheld that
   * this event books (or, on unapply, takes back). Absent on paths that
   * never carry a withholding.
   */
  withholdingIsr?: string;
  withholdingIva?: string;
  /**
   * MNE-001-422 · customer side: the advance's IVA this event cancels on the
   * invoice (or, on unapply, restores to 2120), and the month whose 2120
   * also carried it through a PUE invoice issued on or before the advance.
   */
  advanceIva?: string;
  advanceIvaTwiceIn?: string | null;
  /** MNE-001-573 · the advance's IVA a held cheque's cash takes and its cashing nets (`defer_to_cashing`). */
  advanceIvaDeferred?: string;
  /** MNE-001-573 · the cheque's cashing day, when the invoice's month caused the IVA the cashing causes. */
  advanceIvaCashedOn?: string | null;
}

export interface ResultadoPago {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry | null;
  /** Para disparar la atestación DESPUÉS del commit. */
  attestation: { entityId: string; entryId: string } | null;
  documentos: DocumentoAplicado[];
  /**
   * R4 · sólo pagos en moneda extranjera (hoy, sólo lado proveedor): la
   * diferencia cambiaria REALIZADA que el pago asentó, y con qué tasa.
   */
  diferenciaCambiaria?: (DiferenciaCambiaria & { tasaPago: string; fuente: string }) | null;
  /**
   * MNE-001-345 · vendor side: LISR art. 27 fr. III signals (cash above the
   * limit in force on the payment date). Informative; the entry is unchanged.
   */
  deductibilityFindings?: CashDeductibilityFinding[];
  /** MNE-001-458 · customer side: the advance treatment the receipt was recorded with, and its split. */
  advance?: AdvanceSplit | null;
  /**
   * MNE-001-421 · open invoices of the advance's customer whose own entry
   * credited `anticipo_clientes`: an advance CFDI already in the books, whose
   * cash is recorded against it. Informative; a second advance is legitimate.
   */
  advanceInvoices?: string[];
}

export interface OpcionesPago {
  /** Corre todo y revierte: sirve para la vista previa de la terminal. */
  dryRun?: boolean;
  client?: pg.PoolClient;
}

function assertEstado(status: string | undefined): void {
  if (status !== undefined && status !== ESTADO) {
    throw new AccountingError(
      'PAYMENT_STATE_UNSUPPORTED',
      `Un pago sólo puede registrarse como '${ESTADO}': mnemosine registra pagos que YA ocurrieron. ` +
        `El estado '${status}' pertenece a un programador de pagos que no existe, y un pago que no ` +
        `ha salido del banco no puede tocar el mayor.`
    );
  }
}

// `lado` decide dos cosas y ninguna es cosmética: si el descuento por pronto
// pago se acepta o se manda a la nota de crédito, y de quién es el anticipo
// cuando sobra dinero. Antes era `permiteACuenta`, una bandera que después de
// F04 los dos llamadores pasaban en `true` — un parámetro que nadie puede
// poner en `false` no es una opción, es ruido con forma de opción.
function assertAplicaciones(entrada: EntradaPago, lado: 'cliente' | 'proveedor'): void {
  const aCuenta = entrada.onAccount === true;
  if (entrada.applications.length === 0 && !aCuenta) {
    throw new ValidationError(
      'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.'
    );
  }
  if (entrada.applications.length === 0 && aCuenta && !entrada.counterpartyId) {
    throw new ValidationError(
      `Un anticipo sin documento necesita el ${lado} explícito: sin documento no hay de dónde deducirlo.`
    );
  }

  // Un documento repetido pasaba las dos validaciones y se restaba DOS veces.
  // El bucle que valida corre entero antes del que escribe, así que ambas
  // entradas comparaban contra el saldo original; el FOR UPDATE no lo impide
  // porque el candado es reentrante dentro de la misma transacción. Resultado
  // medido: amount_due en -1000, el gasto en 'paid', y el asiento cargando el
  // doble a la cuenta de control de proveedores.
  const vistos = new Set<string>();
  for (const a of entrada.applications) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en el mismo pago. ` +
          'Súmalas en una sola aplicación: repetirlo restaría su saldo dos veces.'
      );
    }
    vistos.add(a.documentId);
  }

  // EL DESCUENTO POR PRONTO PAGO, por fin cableado (F04).
  //
  // Se insertaba en payment_applications y no participaba en nada más: ni
  // reducía el saldo ni entraba en el asiento, así que el proveedor quedaba
  // debiendo el descuento para siempre. Se rechazaba en voz alta diciendo que
  // «necesita una cuenta de ingreso por descuentos en la capa de roles» — y la
  // cuenta existía desde la siembra: `devolucion_compras` (5200, contra-costo),
  // espejo exacto del 4400 con el que la nota de crédito reduce las ventas.
  // Lo que faltaba no era la cuenta: era atarla.
  //
  // Del lado CLIENTE sigue rechazado, y no por simetría perezosa: un descuento
  // que NOSOTROS concedemos a un cliente es una nota de crédito —documento
  // fiscal, con su CFDI de egreso— y no una línea suelta en el cobro. F03 le
  // construyó su camino propio.
  const conDescuento = entrada.applications.find(
    (a) => a.discountAmount !== undefined && new Decimal(a.discountAmount).greaterThan(0)
  );
  if (conDescuento && lado === 'cliente') {
    throw new ValidationError(
      'Un descuento concedido a un cliente no es una línea del cobro: es una NOTA DE CRÉDITO, ' +
        'con su documento y su CFDI de egreso. Emítela con `mnemosine credit-note create --type descuento` ' +
        'y aplícala a la factura.'
    );
  }

  // Sólo EFECTIVO: el descuento extingue pasivo pero no salió del banco, así
  // que comparar `amountApplied` contra el importe pagado sigue siendo la
  // igualdad correcta. Sumar el descuento aquí exigiría un pago mayor que el
  // que de verdad se hizo.
  const total = entrada.applications.reduce(
    (s, a) => s.plus(a.amountApplied),
    new Decimal(0)
  );
  // Exacto, no «no más de» — salvo a cuenta EXPLÍCITO (049), donde el
  // remanente va a anticipo_clientes en el asiento y no queda en el aire.
  // Aplicar de menos SIN pedirlo sigue rechazándose: el que suma mal debe
  // enterarse, no ganar un anticipo por accidente.
  if (total.greaterThan(entrada.paymentAmount)) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}: no se puede aplicar más de lo que se pagó.`
    );
  }
  if (!total.equals(entrada.paymentAmount) && !aCuenta) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}. Tienen que coincidir: lo que sobra ` +
        'quedaría cargado a la cuenta de control sin bajar de ningún auxiliar. Si el remanente ' +
        `es deliberado, dilo con onAccount (--on-account): quedará como anticipo ${
          lado === 'cliente' ? 'del cliente' : 'a proveedores'
        }.`
    );
  }
}

/** La moneda del documento tiene que ser la del pago. */
function assertMoneda(numero: string, delDocumento: string, delPago: string | undefined): void {
  const pago = delPago ?? delDocumento;
  if (delDocumento !== pago) {
    throw new ValidationError(
      `${numero} está en ${delDocumento} y el pago en ${pago}. Un importe en otra moneda ` +
        'se restaría crudo del saldo y se asentaría crudo, sin tipo de cambio.'
    );
  }
}

/**
 * R4 · The exchange context of a payment or a collection, or null when its
 * documents are in the entity's functional currency.
 *
 * assertMoneda already made the payment and its documents share a currency;
 * what is left is whether that currency is the functional one. If it is not,
 * the entry needs the rate of the PAYMENT DAY: explicit from the caller, or
 * resolved from exchange_rates with the source the `fuente_tipo_cambio`
 * policy dictates. Each document is extinguished at the rate it was born
 * with (bills.exchange_rate, or the one MNE-001-081 wrote back to the
 * invoice), so a document still carrying the 1.0 capture default was booked
 * unconverted and is refused: paying it here would invent an "exchange
 * difference" that is really the conversion that never happened.
 *
 * One reader for both sides (vendor payment and customer receipt, since
 * MNE-001-082), so the two cannot drift on which rate a day has.
 */
async function foreignCurrencyContext(
  client: pg.PoolClient,
  entrada: EntradaPago,
  documentos: DocumentoAplicado[],
  apps: AplicacionCambiaria[],
  settle: 'pagarlo' | 'cobrarlo'
): Promise<ContextoCambiario | null> {
  if (documentos.length === 0) return null;
  const funcional = await functionalCurrencyOf(client, entrada.entityId);
  const moneda = currencyOf(documentos);
  if (moneda === funcional) return null;

  for (const a of apps) {
    const th = new Decimal(a.tasaHistorica || '0');
    if (!th.greaterThan(0) || th.equals(1)) {
      throw new ValidationError(
        `${a.numero} está en ${moneda} pero su exchange_rate es ` +
          `${a.tasaHistorica} (el default de captura): se asentó sin ` +
          `convertir. Corrige el documento antes de ${settle} — la diferencia ` +
          `cambiaria se mide contra la tasa a la que el documento nació (NIF B-15).`
      );
    }
  }
  if (entrada.exchangeRate !== undefined) {
    if (!new Decimal(entrada.exchangeRate).greaterThan(0)) {
      throw new ValidationError(
        `El tipo de cambio del pago (${entrada.exchangeRate}) tiene que ser mayor que cero.`
      );
    }
    return { moneda, monedaFuncional: funcional, tasaPago: entrada.exchangeRate, fuenteTasa: 'parametro', aplicaciones: apps };
  }
  const resolved = await resolverTipoCambio(
    client,
    { tenantId: await tenantDe(client, entrada.entityId), entityId: entrada.entityId },
    { de: moneda, a: funcional, fecha: entrada.paymentDate }
  );
  return { moneda, monedaFuncional: funcional, tasaPago: resolved.tasa, fuenteTasa: resolved.fuente, aplicaciones: apps };
}

/**
 * The bank account a NEW payment names has to be this entity's and active
 * (#327). The check lives here, not in one caller, so REST and the terminal
 * fail closed alike: before it, another entity's id reached the INSERT and the
 * posting silently fell back to the default bank role, and a closed account took
 * new money movement. Zero rows means both "does not exist" and "not yours".
 */
async function assertPayableBankAccount(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string | null | undefined
): Promise<void> {
  if (!bankAccountId) return;
  const r = await client.query<{ account_name: string; is_active: boolean }>(
    'SELECT account_name, is_active FROM bank_accounts WHERE id = $1 AND entity_id = $2',
    [bankAccountId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', bankAccountId);
  if (!r.rows[0].is_active) {
    throw new ValidationError(
      `La cuenta bancaria "${r.rows[0].account_name}" está inactiva: no registra movimientos nuevos. ` +
        'Elige una cuenta activa de `bank account list`.'
    );
  }
}

// ── Proveedores ──

export async function recordVendorPayment(
  entrada: EntradaPago,
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoPago> {
  assertEstado(entrada.status);
  // F04: el lado proveedor admite pago a cuenta (anticipo, 1150) y descuento
  // por pronto pago (contra-costo, 5200) — las dos cosas que el catálogo
  // promete en `payment create --vendor` y `payment apply --discount`.
  assertAplicaciones(entrada, 'proveedor');
  assertRastroDePago(entrada, 'proveedor');
  assertPayerTrace(entrada, 'proveedor');

  const correr = async (client: pg.PoolClient): Promise<ResultadoPago> => {
    await assertPayableBankAccount(client, entrada.entityId, entrada.bankAccountId);
    const documentos: DocumentoAplicado[] = [];
    // R4 · lo que el desglose cambiario necesita de cada gasto: su tasa
    // histórica viaja junto a lo aplicado, porque cada pasivo se extingue
    // al tipo al que nació.
    const fxApps: AplicacionCambiaria[] = [];

    // Las facturas se leen ACOTADAS POR ENTIDAD y con FOR UPDATE: sin el
    // filtro, conocer el UUID bastaría para pagar el gasto de otra entidad;
    // sin el candado, dos pagos simultáneos leerían el mismo saldo.
    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; bill_number: string; amount_due: string; vendor_id: string;
        status: string; currency_code: string; exchange_rate: string;
      }>(
        `SELECT id, bill_number, amount_due, vendor_id, status, currency_code,
                exchange_rate::text AS exchange_rate
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) {
        throw new NotFoundError('Bill', app.documentId);
      }
      const bill = r.rows[0];

      // El pasivo tiene que estar en el mayor antes de pagarlo. La guarda
      // vivía sólo en el comando de la terminal, así que por REST se pagaba
      // un borrador: se restaba su saldo y se posteaba el asiento de pago
      // contra un pasivo que nadie había reconocido.
      if (!PAGABLES.includes(bill.status as (typeof PAGABLES)[number])) {
        throw new ValidationError(
          `${bill.bill_number} está en "${bill.status}" y sólo se puede pagar un gasto ` +
            `${PAGABLES.join(', ')}: su pasivo tiene que estar en el mayor primero.`
        );
      }
      assertMoneda(bill.bill_number, bill.currency_code, entrada.currencyCode);
      if (entrada.counterpartyId && entrada.counterpartyId !== bill.vendor_id) {
        throw new ValidationError(
          `${bill.bill_number} es del proveedor ${bill.vendor_id} y el pago se atribuye a ` +
            `${entrada.counterpartyId}: el pago quedaría en el auxiliar equivocado.`
        );
      }
      const aplicado = new Decimal(app.amountApplied);
      const descuento = new Decimal(app.discountAmount ?? '0');
      const saldo = new Decimal(bill.amount_due);
      // El descuento EXTINGUE pasivo igual que el efectivo: lo que el
      // proveedor deja de tener derecho a cobrar es la suma de los dos.
      const extingue = aplicado.plus(descuento);
      if (extingue.greaterThan(saldo)) {
        throw new ValidationError(
          `${bill.bill_number} debe ${saldo.toFixed(2)} y se intentan extinguir ${extingue.toFixed(2)} ` +
            `(${aplicado.toFixed(2)} de efectivo + ${descuento.toFixed(2)} de descuento).`
        );
      }
      const nuevo = saldo.minus(extingue);
      const estado = nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid';
      documentos.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2), estado,
        moneda: bill.currency_code,
      });
      fxApps.push({
        billId: bill.id,
        numero: bill.bill_number,
        aplicado: aplicado.toFixed(4),
        descuento: descuento.toFixed(4),
        tasaHistorica: bill.exchange_rate,
      });
    }

    const fx = await foreignCurrencyContext(client, entrada, documentos, fxApps, 'pagarlo');

    const vendorId = entrada.counterpartyId
      ?? (await client.query<{ vendor_id: string }>(
        `SELECT vendor_id FROM bills WHERE id = $1`, [entrada.applications[0].documentId]
      )).rows[0]?.vendor_id;
    if (!vendorId) throw new ValidationError('No se pudo determinar el proveedor del pago.');

    // T23b · EL ANTICIPO A PROVEEDOR TAMBIÉN TIENE MONEDA, Y ERA UN LITERAL.
    //
    // Sin documentos, `currencyOf(documentos)` cae a su respaldo —la cadena
    // 'MXN'—, así que TODO anticipo puro se escribía en pesos: no se le
    // preguntaba al proveedor (cuya columna nace en 'USD'), ni al llamador, ni
    // a la entidad en qué lleva sus libros. Es peor que lo que T23 corrigió del
    // lado cliente, donde la moneda al menos salía del cliente.
    //
    // Se rehúsa por la misma razón y con la misma frase: convertir exige elegir
    // tasa y FUENTE, y eso lo decide el despacho en `fuente_tipo_cambio`.
    let vendorAdvanceCurrency: string | undefined;
    if (entrada.applications.length === 0) {
      const v = await client.query<{ currency_code: string }>(
        `SELECT currency_code FROM vendors WHERE id = $1 AND entity_id = $2`,
        [vendorId, entrada.entityId]
      );
      if (v.rows.length === 0) throw new NotFoundError('Vendor', vendorId);
      vendorAdvanceCurrency = entrada.currencyCode ?? v.rows[0].currency_code;
      const functionalCurrency = await functionalCurrencyOf(client, entrada.entityId);
      if (vendorAdvanceCurrency !== functionalCurrency) {
        throw new ValidationError(
          `El anticipo viene en ${vendorAdvanceCurrency} y esta entidad lleva sus libros en ` +
            `${functionalCurrency}. No lo registro convertido porque la tasa y su fuente las decide ` +
            'el despacho en la política `fuente_tipo_cambio`, no yo; y no lo registro sin convertir ' +
            'porque asentaría una cifra de otra moneda como si fuera de ésta. Aplica el pago a un ' +
            `documento en su moneda, o registra el anticipo en ${functionalCurrency}.`
        );
      }
    }

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'vendor_payment', 'VPMT', entrada.paymentDate);
    const paymentId = uuidv4();

    await client.query(
      // reference_number y currency_code faltaban del INSERT. Lo primero
      // perdía el NumOperacion del REP —la referencia bancaria que permite
      // conciliar—; lo segundo es peor: la columna tiene DEFAULT 'USD', así
      // que todo pago a proveedor en pesos quedaba registrado como dólares.
      // El lado AR siempre los escribió; éste no, y nadie lo leía.
      // R4: exchange_rate se escribe SIEMPRE — la tasa del día en extranjera,
      // 1.0 explícito en funcional. Dejarlo al DEFAULT era indistinguible de
      // «nadie lo pensó», que es exactamente lo que era.
      // F07d: `check_number` se escribe POR FIN. Existía desde la 002 y la
      // leían tres sitios de treasury-posting; el INSERT la omitía, así que
      // los tres leían siempre NULL. Con ella entran las tres columnas de la
      // 064 — el destino del dinero, que es lo que el nodo de pago de la
      // póliza declara y de lo que antes no había ni columna.
      `INSERT INTO vendor_payments (
         id, entity_id, payment_number, vendor_id, payment_amount, currency_code,
         payment_method, reference_number, bank_account_id, payment_date, status, memo, created_by,
         cfdi_uuid, cfdi_pago_indice, exchange_rate,
         check_number, cuenta_destino, banco_destino_sat, banco_destino_extranjero
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [paymentId, entrada.entityId, paymentNumber, vendorId, entrada.paymentAmount,
       vendorAdvanceCurrency ?? currencyOf(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
       entrada.bankAccountId ?? null, entrada.paymentDate,
       ESTADO, entrada.memo ?? null, userId,
       entrada.cfdiUuid ?? null, entrada.cfdiPagoIndice ?? null,
       fx?.tasaPago ?? '1.0',
       oNulo(entrada.checkNumber), oNulo(entrada.cuentaDestino),
       oNulo(entrada.bancoDestinoSat), oNulo(entrada.bancoDestinoExtranjero)]
    );

    for (const app of entrada.applications) {
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), paymentId, app.documentId, app.amountApplied, app.discountAmount ?? 0]
      );
      // amount_paid recibe SÓLO el efectivo; el saldo baja por los dos. Un
      // descuento no es dinero cobrado: contarlo como pagado inflaría lo que
      // el proveedor recibió y descuadraría cualquier conciliación de banco.
      // MNE-001-532 · invariant 3, as the invoice twin of applyCustomerPayment;
      // GREATEST: a payment dated before another one does not move the last back.
      const settled = await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $2,
           status = CASE WHEN amount_due - $2 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = GREATEST(last_payment_date, $3::date)
         WHERE id = $4 AND entity_id = $5 AND status = ANY($6::text[]) AND amount_due >= $2`,
        [
          app.amountApplied,
          new Decimal(app.amountApplied).plus(app.discountAmount ?? '0').toFixed(4),
          entrada.paymentDate, app.documentId, entrada.entityId, [...PAGABLES],
        ]
      );
      if (settled.rowCount !== 1) {
        const bill = documentos.find((d) => d.id === app.documentId)?.numero ?? app.documentId;
        throw new AccountingError('BILL_CHANGED', { key: 'error.BILL_CHANGED', params: { bill } });
      }
    }

    // Aquí es donde se libera el IVA aparcado de los CFDI a crédito — y,
    // desde R4, donde la diferencia cambiaria realizada encuentra su cuenta.
    const entry = await postVendorPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id: entrada.entityId,
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        payment_date: entrada.paymentDate,
        bank_account_id: entrada.bankAccountId ?? null,
        journal_entry_id: null,
        // MNE-001-508: `fx` is null in the functional currency; a foreign
        // cheque keeps crediting on its payment day.
        holdsIvaUntilCashed: entrada.paymentMethod === 'check' && !fx,
      },
      userId,
      fx ?? undefined
    );

    // The difference the entry itself booked (cash, bills and the IVA gap
    // between the bill's rate and today's), so the audit trail and the
    // ledger cannot tell different stories.
    const diferencia = fx && entry?.realisedFx
      ? { ...entry.realisedFx, tasaPago: fx.tasaPago, fuente: fx.fuenteTasa }
      : null;

    // MNE-001-345 · LISR 27-III: cash above the limit IN FORCE ON THE PAYMENT
    // DATE. Only when the method is cash, so other payments never read the law.
    // A pure advance (no applications) is a cash payment on a payment date too:
    // it is judged in the vendor's currency. A bill the ingestion already asked
    // the cash question for is left out: that answer is the human decision.
    let deductibilityFindings: CashDeductibilityFinding[] = [];
    if (entrada.paymentMethod === 'cash') {
      const decided = await billsDecidedByIngestion(client, entrada.entityId, documentos.map((d) => d.id));
      const judged = documentos.filter((d) => !decided.has(d.id));
      if (documentos.length === 0 || judged.length > 0) {
        deductibilityFindings = await cashLimitFinding(client, {
          entityId: entrada.entityId,
          billNumber: documentos.length === 0 ? paymentNumber : judged.map((d) => d.numero).join(', '),
          amount: entrada.paymentAmount,
          currency: vendorAdvanceCurrency ?? currencyOf(documentos),
          onDate: toCalendarDate(entrada.paymentDate),
          source: 'vendor_payment',
          billIds: judged.map((d) => d.id),
          proposeDrafts: !opts.dryRun,
        });
      }
    }

    // R1: el pago deja su rastro propio — antes sólo el asiento derivado
    // quedaba auditado, y «quién registró el pago» no estaba en el rastro.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entrada.entityId),
      legalEntityId: entrada.entityId,
      userId,
      action: 'create',
      entityType: 'vendor_payments',
      entityId: paymentId,
      newValues: {
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        journal_entry_id: entry?.id ?? null,
        documentos: documentos.length,
        ...(deductibilityFindings.length > 0 ? { cash_over_limit_findings: deductibilityFindings.map((x) => x.code) } : {}),
        // R4 · el pago en extranjera deja en su rastro la diferencia que
        // realizó y la tasa con la que la midió: es la única huella de por
        // qué el efectivo en funcional no coincide con el pasivo extinguido.
        ...(fx && diferencia
          ? {
              moneda: fx.moneda,
              tipo_cambio_pago: fx.tasaPago,
              fuente_tipo_cambio: fx.fuenteTasa,
              diferencia_cambiaria: diferencia.montoFuncional,
              diferencia_cambiaria_tipo: diferencia.tipo,
            }
          : {}),
      },
    });

    if (opts.dryRun) {
      throw new EnsayoTerminado({
        paymentId, paymentNumber, journalEntry: entry,
        attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
        documentos,
        diferenciaCambiaria: diferencia,
        deductibilityFindings,
      });
    }

    return {
      paymentId, paymentNumber, journalEntry: entry,
      attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
      documentos,
      diferenciaCambiaria: diferencia,
      deductibilityFindings,
    };
  };

  return ejecutar(correr, opts);
}

// ── Clientes ──

export async function recordCustomerPayment(
  entrada: EntradaPago,
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoPago> {
  assertEstado(entrada.status);
  assertAplicaciones(entrada, 'cliente');
  assertRastroDePago(entrada, 'cliente');
  assertPayerTrace(entrada, 'cliente');

  const correr = async (client: pg.PoolClient): Promise<ResultadoPago> => {
    await assertPayableBankAccount(client, entrada.entityId, entrada.bankAccountId);
    const documentos: DocumentoAplicado[] = [];
    // What the exchange breakdown needs from each invoice: the rate its
    // receivable was born with travels next to what is applied.
    const fxApps: AplicacionCambiaria[] = [];

    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; invoice_number: string; amount_due: string; amount_paid: string;
        customer_id: string; currency_code: string; status: string; exchange_rate: string;
        total_amount: string;
      }>(
        `SELECT id, invoice_number, amount_due, amount_paid, customer_id, currency_code, status,
                exchange_rate::text AS exchange_rate, total_amount::text AS total_amount
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Invoice', app.documentId);

      const inv = r.rows[0];
      if (!COBRABLES.includes(inv.status as (typeof COBRABLES)[number])) {
        throw new ValidationError(
          `${inv.invoice_number} está en "${inv.status}" y sólo se puede cobrar una factura ` +
            `${COBRABLES.join(', ')}: su ingreso tiene que estar en el mayor primero.`
        );
      }
      assertMoneda(inv.invoice_number, inv.currency_code, entrada.currencyCode);
      if (entrada.counterpartyId && entrada.counterpartyId !== inv.customer_id) {
        throw new ValidationError(
          `${inv.invoice_number} es del cliente ${inv.customer_id} y el cobro se atribuye a ` +
            `${entrada.counterpartyId}: quedaría en el auxiliar equivocado.`
        );
      }
      const aplicado = new Decimal(app.amountApplied);
      const saldo = new Decimal(inv.amount_due);
      if (aplicado.greaterThan(saldo)) {
        throw new ValidationError(
          `${inv.invoice_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${aplicado.toFixed(2)}.`
        );
      }
      const nuevo = saldo.minus(aplicado);
      documentos.push({
        id: inv.id, numero: inv.invoice_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: inv.currency_code,
      });
      fxApps.push({
        billId: inv.id,
        numero: inv.invoice_number,
        aplicado: aplicado.toFixed(4),
        descuento: '0',
        tasaHistorica: inv.exchange_rate,
        priorApplied: new Decimal(inv.amount_paid).toFixed(4),
        documentTotal: new Decimal(inv.total_amount).toFixed(4),
      });
    }

    // MNE-001-082 · A FOREIGN-CURRENCY COLLECTION CONVERTS AND REALISES ITS
    // DIFFERENCE (NIF B-15), with the same reader the vendor payment uses:
    // each receivable is extinguished at the rate its invoice was born with,
    // the cash comes in at the rate of the collection day, and the gap goes
    // to utilidad_cambiaria / perdida_cambiaria.
    const fx = await foreignCurrencyContext(client, entrada, documentos, fxApps, 'cobrarlo');
    // Cash left on account in another currency is refused, not converted:
    // applying it later (`applyCustomerPayment`) and unapplying it do not
    // convert, so an advance born here would be moved later as if its dollars
    // were pesos. T23 refuses the pure foreign advance for the same reason.
    if (fx) {
      const applied = fxApps.reduce((s, a) => s.plus(a.aplicado), new Decimal(0));
      const onAccount = new Decimal(entrada.paymentAmount).minus(applied);
      if (onAccount.greaterThan(0)) {
        throw new AccountingError(
          'FX_AR_ON_ACCOUNT_NOT_WIRED',
          `El cobro en ${fx.moneda} deja ${onAccount.toFixed(2)} a cuenta del cliente. Un saldo a ` +
            'cuenta en otra moneda todavía no se puede aplicar ni desaplicar convertido, así que ' +
            `no lo registro: aplica el cobro completo a facturas en ${fx.moneda}.`
        );
      }
    }

    const customerId = entrada.counterpartyId
      ?? (await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM invoices WHERE id = $1`, [entrada.applications[0].documentId]
      )).rows[0]?.customer_id;
    if (!customerId) throw new ValidationError('No se pudo determinar el cliente del cobro.');

    // Anticipo puro (049): sin documento no hay moneda de referencia — se
    // toma la del cliente, verificando de paso que existe EN ESTA entidad.
    let advanceCurrency: string | null = null;
    if (entrada.applications.length === 0) {
      const c = await client.query<{ currency_code: string }>(
        `SELECT currency_code FROM customers WHERE id = $1 AND entity_id = $2`,
        [customerId, entrada.entityId]
      );
      if (c.rows.length === 0) throw new NotFoundError('Customer', customerId);
      advanceCurrency = entrada.currencyCode ?? c.rows[0].currency_code;

      // T23 · UN ANTICIPO NO TIENE DOCUMENTO QUE LE DÉ LA MONEDA, Y AQUÍ NADIE
      // LA COMPARABA CON LA FUNCIONAL.
      //
      // Sin factura, la moneda sale del propio cliente —o del parámetro— y se
      // escribía cruda: un anticipo de 1 000 USD contra una entidad que lleva
      // sus libros en MXN quedaba asentado como 1 000 pesos, y el asiento
      // cuadraba porque las dos patas llevaban la misma cifra equivocada.
      //
      // SE REHÚSA, NO SE CONVIERTE, y es deliberado: convertir exige elegir una
      // tasa y una FUENTE, y esa es una decisión del despacho
      // (`fuente_tipo_cambio`), no un valor por omisión que esta función pueda
      // inventarse. It is the same promise the receivables manual makes for
      // cash left on account by a foreign-currency collection
      // (FX_AR_ON_ACCOUNT_NOT_WIRED, above): nothing records dollars as pesos,
      // and the advance was the door through which that promise was not kept.
      const functionalCurrency = await functionalCurrencyOf(client, entrada.entityId);
      if (advanceCurrency !== functionalCurrency) {
        throw new ValidationError(
          `El anticipo viene en ${advanceCurrency} y esta entidad lleva sus libros en ` +
            `${functionalCurrency}. No lo registro convertido porque la tasa y su fuente ` +
            'las decide el despacho en la política `fuente_tipo_cambio`, no yo; y no lo ' +
            'registro sin convertir porque asentaría una cifra de otra moneda como si fuera ' +
            'de ésta. Aplica el cobro a un documento en su moneda, o registra el anticipo en ' +
            `${functionalCurrency}.`
        );
      }
    }

    const advance = await advanceSplitOf(client, entrada, documentos);
    const advanceInvoices = advance ? await openAdvanceInvoices(client, entrada.entityId, customerId) : [];

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'customer_payment', 'PMT', entrada.paymentDate);
    const paymentId = uuidv4();

    await client.query(
      // currency_code se omitía y la columna tiene DEFAULT 'USD': un cobro en
      // pesos quedaba registrado como dólares. Regresión de la extracción.
      // F07d: las mismas cuatro columnas que el lado proveedor. El cobro
      // también es una póliza que mueve dinero, y la 064 añadió el destino a
      // las DOS tablas: dejar el lado cliente sin escritor repetiría la
      // asimetría que la 063 acababa de corregir en las líneas del gasto.
      `INSERT INTO customer_payments (
         id, entity_id, payment_number, customer_id, payment_amount, currency_code,
         payment_method, reference_number, bank_account_id, payment_date,
         status, created_by, cfdi_uuid, cfdi_pago_indice,
         check_number, cuenta_destino, banco_destino_sat, banco_destino_extranjero, exchange_rate,
         advance_factor_type, advance_tax_rate, advance_base_amount, advance_iva_amount,
         cuenta_origen, banco_origen_sat, banco_origen_extranjero
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [paymentId, entrada.entityId, paymentNumber, customerId, entrada.paymentAmount,
       advanceCurrency ?? currencyOf(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
       entrada.bankAccountId ?? null, entrada.paymentDate, ESTADO, userId,
       entrada.cfdiUuid ?? null, entrada.cfdiPagoIndice ?? null,
       oNulo(entrada.checkNumber), oNulo(entrada.cuentaDestino),
       oNulo(entrada.bancoDestinoSat), oNulo(entrada.bancoDestinoExtranjero),
       // The rate of the collection day in foreign currency, an explicit 1.0
       // in the functional one: the column's DEFAULT cannot tell the two apart.
       fx?.tasaPago ?? '1.0',
       // MNE-001-458: born with the row (four NULLs when none was stated).
       advance?.factorType ?? null, advance?.taxRate ?? null, advance?.base ?? null, advance?.iva ?? null,
       // #611: the payer's side of the trace (335).
       oNulo(entrada.payerAccount), oNulo(entrada.payerBankCode), oNulo(entrada.payerForeignBank)]
    );

    for (const app of entrada.applications) {
      await client.query(
        // MNE-001-460: cash applied on collection is applied on the receipt's day.
        `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied, applied_on)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), paymentId, app.documentId, app.amountApplied, entrada.paymentDate]
      );
      // MNE-001-580 · invariant 3, as the twin in applyCustomerPayment; GREATEST:
      // a receipt dated before another one does not move the last payment back.
      const settled = await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = GREATEST(last_payment_date, $2::date)
         WHERE id = $3 AND entity_id = $4 AND status = ANY($5::text[]) AND amount_due >= $1`,
        [app.amountApplied, entrada.paymentDate, app.documentId, entrada.entityId, [...COBRABLES]]
      );
      if (settled.rowCount !== 1) {
        const invoice = documentos.find((d) => d.id === app.documentId)?.numero ?? app.documentId;
        throw new AccountingError('INVOICE_CHANGED', { key: 'error.INVOICE_CHANGED', params: { invoice } });
      }
    }

    const entry = await postCustomerPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id: entrada.entityId,
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        payment_date: entrada.paymentDate,
        bank_account_id: entrada.bankAccountId ?? null,
        journal_entry_id: null,
        advance_base_amount: advance?.base ?? null,
        advance_iva_amount: advance?.iva ?? null,
        advance_note: advance ? advanceSourceNote(advance) : null,
        // MNE-001-556: a new cheque has no cashing. One in another currency
        // (`fx`) keeps releasing on its receipt until its cashing can convert.
        holdsIvaUntilCashed: entrada.paymentMethod === 'check' && !fx,
      },
      userId,
      fx ?? undefined
    );

    // The difference the entry itself booked, so the audit trail and the
    // ledger cannot tell different stories.
    const fxDifference = fx && entry?.realisedFx
      ? { ...entry.realisedFx, tasaPago: fx.tasaPago, fuente: fx.fuenteTasa }
      : null;

    // R1: mismo rastro que el pago a proveedor, del lado del cobro.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entrada.entityId),
      legalEntityId: entrada.entityId,
      userId,
      action: 'create',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        journal_entry_id: entry?.id ?? null,
        documentos: documentos.length,
        ...(advance ? { advance_treatment: advance.treatment, advance_base: advance.base, advance_iva: advance.iva } : {}),
        ...(fx && fxDifference
          ? {
              moneda: fx.moneda,
              tipo_cambio_pago: fx.tasaPago,
              fuente_tipo_cambio: fx.fuenteTasa,
              diferencia_cambiaria: fxDifference.montoFuncional,
              diferencia_cambiaria_tipo: fxDifference.tipo,
            }
          : {}),
      },
    });

    const salida: ResultadoPago = {
      paymentId, paymentNumber, journalEntry: entry,
      attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
      documentos,
      diferenciaCambiaria: fxDifference,
      advance,
      ...(advanceInvoices.length > 0 ? { advanceInvoices } : {}),
    };
    if (opts.dryRun) throw new EnsayoTerminado(salida);
    return salida;
  };

  return ejecutar(correr, opts);
}

/**
 * MNE-001-458 · The advance treatment of a receipt, split into base and IVA;
 * null when none was stated or asked for.
 *
 * MNE-001-462 · With invoices, the split is of the excess the receipt leaves
 * on account, and the treatment is the one stated or, when the caller asks,
 * that of the invoices it collects. A stated treatment that finds nothing to
 * carry it or an entity off Mexican books is refused, as for an advance
 * with no invoice; one taken from the invoices is not, and the cash on
 * account then posts as before, so no invocation that worked is refused.
 *
 * MNE-001-558 · An advance by cheque keeps its split; the receipt's entry
 * holds it whole in 2150 and the recorded cashing causes its IVA.
 * MNE-001-572 · The excess of a collection by cheque too (#789): the cashing
 * reads the split stored here, and an unapply before it causes nothing.
 */
async function advanceSplitOf(
  client: pg.PoolClient,
  input: EntradaPago,
  documents: readonly DocumentoAplicado[]
): Promise<AdvanceSplit | null> {
  const stated = input.advanceTreatment;
  if (stated === undefined && !input.advanceTreatmentFromInvoice) return null;
  if (stated !== undefined && !isAdvanceTreatment(stated)) {
    const params = { value: stated, allowed: ADVANCE_TREATMENTS.join(', ') };
    throw new ValidationError({ key: 'receipt.advance.treatment_unknown', params });
  }
  const applied = input.applications.reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
  const excess = new Decimal(input.paymentAmount).minus(applied);
  if (input.applications.length > 0 && (!input.onAccount || !excess.greaterThan(0))) {
    if (stated === undefined) return null;
    throw new ValidationError({ key: 'receipt.advance.nothing_on_account', params: { amount: input.paymentAmount } });
  }
  if (!(await entityUsesCashBasisIva(client, input.entityId))) {
    if (stated === undefined) return null;
    throw new ValidationError({ key: 'receipt.advance.not_mexican_books' });
  }
  if (stated !== undefined) return splitAdvance(excess.toFixed(2), stated);
  // Read under the lock the loop above already holds on each invoice.
  const sale = await treatmentOfSales(client, input.entityId, input.applications.map((a) => a.documentId));
  const from = { invoices: documents.map((d) => d.numero).join(', '), assumed: sale.assumed };
  return { ...splitAdvance(excess.toFixed(2), sale.treatment), from };
}

/**
 * MNE-001-421 · The customer's open invoices whose own issuance entry
 * credited the `anticipo_clientes` role, as an approved advance CFDI's does.
 * Entity-scoped in the SQL, on the role account the entity itself points at.
 */
async function openAdvanceInvoices(client: pg.PoolClient, entityId: string, customerId: string): Promise<string[]> {
  const r = await client.query<{ invoice_number: string }>(
    `SELECT DISTINCT i.invoice_number
       FROM invoices i
       JOIN journal_entry_lines l ON l.journal_entry_id = i.journal_entry_id AND COALESCE(l.credit_amount, 0) > 0
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = i.entity_id
                            AND ar.qualifier IS NULL
                            AND ar.role = 'anticipo_clientes'
      WHERE i.entity_id = $1 AND i.customer_id = $2 AND i.amount_due > 0
        AND i.status IN ('sent', 'viewed', 'partially_paid', 'overdue')
      ORDER BY i.invoice_number`,
    [entityId, customerId]
  );
  return r.rows.map((x) => x.invoice_number);
}

// ── Ensayo ──

/**
 * La vista previa corre EL MISMO camino y revierte al final. Lanzar es lo
 * que garantiza el ROLLBACK: si devolviera normalmente, la transacción se
 * confirmaría y el «ensayo» habría escrito.
 */
class EnsayoTerminado extends Error {
  constructor(public readonly resultado: ResultadoPago) {
    super('dry-run');
  }
}

async function ejecutar(
  correr: (client: pg.PoolClient) => Promise<ResultadoPago>,
  opts: OpcionesPago
): Promise<ResultadoPago> {
  if (opts.client) return correr(opts.client);
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoTerminado) return e.resultado;
    throw e;
  }
}

/** Un gasto se paga cuando su pasivo ya está en el mayor. */
const PAGABLES = ['approved', 'posted', 'partially_paid'] as const;
/** Una factura se cobra cuando ya salió al cliente y su ingreso está contabilizado. */
const COBRABLES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;

/** assertMoneda ya garantizó que son todas la misma. */
function currencyOf(documentos: DocumentoAplicado[]): string {
  return documentos[0]?.moneda ?? 'MXN';
}

// ============================================================
// EL COBRO COMO HISTORIA (049 · F03)
//
// Registrar era el único evento; ahora hay cuatro: aplicar el saldo a
// cuenta (el anticipo encuentra su factura), desaplicar (la aplicación se
// clausura como evento nuevo, jamás se borra), y reversar (el cheque
// rebotó: TODO se deshace por espejo NIF B-1 y el cobro queda 'reversed' —
// ocurrió y se deshizo, que no es lo mismo que 'void').
//
// Las mismas fronteras que el registro: entidad DENTRO del SQL, FOR UPDATE
// antes de leer saldos, y el ensayo recorre el camino real y revierte.
// ============================================================

class EnsayoEvento extends Error {
  constructor(public readonly resultado: unknown) {
    super('dry-run');
  }
}

async function ejecutarEvento<T>(
  correr: (client: pg.PoolClient) => Promise<T>,
  opts: OpcionesPago
): Promise<T> {
  if (opts.client) return correr(opts.client);
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoEvento) return e.resultado as T;
    throw e;
  }
}

/**
 * The two parties of a refused application, each as «number name», to word the
 * refusal. The decision is taken before, on the ids of the two locked rows:
 * this read takes no lock and decides nothing.
 */
async function partyLabels(
  client: pg.PoolClient,
  entityId: string,
  kind: 'customer' | 'vendor',
  ids: [string, string]
): Promise<[string, string]> {
  const r = await client.query<{ id: string; number: string; name: string | null }>(
    kind === 'customer'
      ? `SELECT id, customer_number AS number,
                COALESCE(company_name, NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), '')) AS name
           FROM customers WHERE entity_id = $1 AND id = ANY($2::uuid[])`
      : `SELECT id, vendor_number AS number, company_name AS name
           FROM vendors WHERE entity_id = $1 AND id = ANY($2::uuid[])`,
    [entityId, ids]
  );
  const label = (id: string): string => {
    const party = r.rows.find((row) => row.id === id);
    return party ? [party.number, party.name].filter(Boolean).join(' ') : id;
  };
  return [label(ids[0]), label(ids[1])];
}

interface PagoVivo {
  id: string;
  payment_number: string;
  customer_id: string;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  status: string;
  cfdi_uuid: string | null;
  /** MNE-001-458: non-null when the receipt was recorded as an advance with its treatment. */
  advance_factor_type: string | null;
  /** MNE-001-458: the stated rate, a percent; null unless the factor type is 'tasa'. */
  advance_tax_rate: string | null;
  /** MNE-001-458: the advance's base and IVA as the receipt stored them; null when it carries no treatment. */
  advance_base_amount: string | null;
  advance_iva_amount: string | null;
  payment_method: string;
  /** Migration 331: the bank credit that cashed the cheque; null while it has none. */
  check_cashed_tx_id: string | null;
  check_cashed_date: string | null;
}

/**
 * MNE-001-556 · A cheque in the functional currency with no cashing recorded
 * holds its IVA (LIVA art. 1-B, second paragraph). NOTE: read from the method
 * and the cashing, never from the 0 an allocation stores: every allocation
 * that released nothing stores 0, whatever the method (MNE-001-459).
 */
async function holdsIvaUntilCashed(client: pg.PoolClient, entityId: string, receipt: PagoVivo): Promise<boolean> {
  return (
    receipt.payment_method === 'check' &&
    receipt.check_cashed_tx_id === null &&
    receipt.currency_code.trim() === (await functionalCurrencyOf(client, entityId))
  );
}

/** El cobro, acotado por entidad y con candado: la base de los tres eventos. */
async function cobroParaEscribir(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<PagoVivo> {
  const r = await client.query<PagoVivo>(
    `SELECT id, payment_number, customer_id, payment_amount, currency_code,
            payment_date, bank_account_id, journal_entry_id, status, cfdi_uuid, advance_factor_type, payment_method,
            advance_tax_rate::text AS advance_tax_rate,
            advance_base_amount::text AS advance_base_amount, advance_iva_amount::text AS advance_iva_amount,
            check_cashed_tx_id, check_cashed_date::text AS check_cashed_date
       FROM customer_payments WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [paymentId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Customer payment', paymentId);
  const pago = r.rows[0];
  if (pago.status !== ESTADO) {
    throw new ValidationError(
      `El cobro ${pago.payment_number} está en '${pago.status}': sólo un cobro 'completed' admite este evento.`
    );
  }
  return pago;
}

/**
 * MNE-001-460 · The day a later event on a receipt is dated: the one given,
 * or today in the entity's zone (`zona_horaria`, never the process clock).
 * It dates the entry, the allocation and the invoice together, so it can be
 * neither in the future nor before the receipt's last posted event: the
 * ledger would apply or undo cash before it happened. A cheque's cashing
 * (MNE-001-556) is one of those events. A hard-closed or locked period is
 * refused by posting itself.
 */
async function receiptEventDate(
  client: pg.PoolClient,
  entityId: string,
  receipt: PagoVivo,
  given: string | undefined,
  event: 'apply' | 'unapply' | 'transfer'
): Promise<string> {
  const today = await todayFor({ tenantId: await tenantDe(client, entityId), entityId }, { client });
  const date = given === undefined ? today : toCalendarDate(given);
  const params = { receipt: receipt.payment_number, date, today };
  if (date > today) {
    throw new ValidationError({ key: `receipt.${event}.date_future` as const, params }, 'date');
  }
  // MNE-001-498 · a transfer out of the receipt is one of its events: its entry is tied to the receiving row.
  const last = await client.query<{ d: string | null }>(
    `SELECT to_char(MAX(entry_date), 'YYYY-MM-DD') AS d FROM journal_entries
      WHERE entity_id = $1 AND status = 'posted'
        AND ((source_id = $2
              AND source_type IN ('customer_payment', 'receipt_application', 'receipt_unapplication', 'customer_cheque_cashing'))
          OR (source_type = '${CUSTOMER_CREDIT_TRANSFER_SOURCE}' AND source_id IN (
                SELECT t.id FROM customer_payments t WHERE t.entity_id = $1 AND t.transferred_from_payment_id = $2)))`,
    [entityId, receipt.id]
  );
  const recorded = toCalendarDate(receipt.payment_date);
  const since = last.rows[0]?.d && last.rows[0].d > recorded ? last.rows[0].d : recorded;
  if (date < since) {
    throw new ValidationError(
      { key: `receipt.${event}.date_before_last_event` as const, params: { ...params, since } },
      'date'
    );
  }
  return date;
}

/**
 * MNE-001-422 · What is left of a receipt's advance after its live
 * allocations, and the cash on account that is no advance: null when the
 * receipt carries no treatment, whose cash on account takes nothing from one.
 *
 * MNE-001-462 · On a receipt with a treatment, the cash an unapply put back
 * on account is part of the advance (`backAsAdvance`, under «no re-park»), so
 * the advance is what the receipt stored plus the cash of its closed
 * allocations that took none, and their IVA at the receipt's treatment. Its
 * cash on account is then all advance: `plain` is 0 whenever the record-time
 * cash is applied or back on account, and stays a guard, not a case.
 *
 * MNE-001-574 · On a receipt with none, the advance is the cash its unapplies
 * put back carrying the IVA they kept caused (`keptOnAccount`), and null
 * while there is none, so such a receipt behaves as before until then.
 *
 * MNE-001-590 · That cash carries the IEPS its collection caused as well
 * (`ieps`, read back from the ledger by `iepsKeptOnAccount`); 0 on a receipt
 * with a treatment.
 * MNE-001-591 · `own`: the invoices whose kept IVA a credit note capped; cash
 * applied again to one of them takes that pool first (empty with a treatment).
 *
 * MNE-001-592 (#814, decision (A)) · For both kinds, the advance IVA an
 * unapply did not restore because a credit note restituted it leaves the
 * advance, and so does the cash it covers (`coveredCashOf`): that cash is a
 * balance owed back, carrying none, so it falls into `plain`. The invoices
 * join `own`, so cash applied back to one of them takes the advance first.
 */
async function advanceLeft(
  client: pg.PoolClient,
  entityId: string,
  receipt: PagoVivo,
  onAccount: Decimal
): Promise<(Omit<AdvanceTake, 'applied'> & { ieps: string; own: ReadonlySet<string> }) | null> {
  const treatment = receipt.advance_base_amount === null || receipt.advance_iva_amount === null
    ? null
    : storedAdvanceTreatment(receipt.advance_factor_type, receipt.advance_tax_rate);
  const stored = treatment === null ? { cash: '0', iva: '0' } : {
    cash: new Decimal(receipt.advance_base_amount as string).plus(receipt.advance_iva_amount as string).toFixed(4),
    iva: receipt.advance_iva_amount as string,
  };
  const back = treatment === null
    ? await keptOnAccount(client, entityId, receipt.id)
    : await advanceBackOnAccount(client, entityId, receipt.id, treatment);
  if (treatment === null && !new Decimal(back.cash).greaterThan(0)) return null;
  const restituted = (await client.query<{ invoice_id: string; iva: string; total: string; tax: string }>(
    `SELECT pa.invoice_id::text, pa.unapply_restituted_iva_amount::text AS iva,
            i.total_amount::text AS total, i.tax_amount::text AS tax
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $2
      WHERE pa.payment_id = $1 AND pa.unapplied_at IS NOT NULL AND pa.unapply_restituted_iva_amount IS NOT NULL`,
    [receipt.id, entityId]
  )).rows;
  const own = new Set<string>('own' in back ? back.own : []);
  let restitutedIva = new Decimal(0);
  let covered = new Decimal(0);
  for (const r of restituted) {
    restitutedIva = restitutedIva.plus(r.iva);
    covered = covered.plus(coveredCashOf(r.iva, r.total, r.tax));
    own.add(r.invoice_id);
  }
  const live = (await client.query<{ taken: string; cancelled: string }>(
    `SELECT (pa.advance_base_amount + pa.advance_iva_amount)::text AS taken, pa.advance_iva_amount::text AS cancelled
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
      WHERE pa.payment_id = $1 AND pa.unapplied_at IS NULL`,
    [receipt.id, entityId]
  )).rows;
  const total = Decimal.max(new Decimal(stored.cash).plus(back.cash).minus(covered), 0);
  const consumed = live.reduce((s, x) => s.plus(x.taken), new Decimal(0));
  return {
    total: total.toFixed(4),
    iva: Decimal.max(new Decimal(stored.iva).plus(back.iva).minus(restitutedIva), 0).toFixed(4),
    consumed: consumed.toFixed(4),
    cancelled: live.reduce((s, x) => s.plus(x.cancelled), new Decimal(0)).toFixed(4),
    plain: Decimal.max(onAccount.minus(total.minus(consumed)), 0).toFixed(4),
    ieps: treatment === null ? await iepsKeptOnAccount(client, entityId, receipt.id) : '0.0000',
    own,
  };
}

/** MNE-001-498 · Its cash on account: the amount less its live allocations and its live transfers out. */
async function remanenteDe(client: pg.PoolClient, entityId: string, paymentId: string): Promise<Decimal> {
  const r = await client.query<{ left: string }>(
    `SELECT ${cashOnAccountSql('cp')}::text AS left FROM customer_payments cp WHERE cp.id = $1 AND cp.entity_id = $2`,
    [paymentId, entityId]
  );
  return new Decimal(r.rows[0]?.left ?? '0');
}

/**
 * MNE-001-498 · A transfer row's own events (applying it to B's invoices,
 * unapplying, reversing it) wait for part 2, which teaches them the IVA
 * paper's date and the mirror of its entry.
 */
function refuseTransferRow(receipt: PagoVivo): void {
  if (receipt.payment_method === BALANCE_TRANSFER_METHOD) {
    throw new ValidationError({ key: 'receipt.transfer.events_in_499', params: { receipt: receipt.payment_number } });
  }
}

export interface ResultadoAplicacion {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry | null;
  attestation: { entityId: string; entryId: string } | null;
  documentos: DocumentoAplicado[];
  remanenteAnterior: string;
  remanenteNuevo: string;
}

/** MNE-001-460: a customer application also says its day, which its entry and its rows carry. */
export interface CustomerApplicationResult extends ResultadoAplicacion {
  date: string;
}

/**
 * What the invoice's own issuance entry debited to the two
 * customer-withholding roles (MNE-001-113). Non-zero means the receivable was
 * booked NET of the customer's withholding, as an invoice born from an issued
 * CFDI with retenciones is. Entity-scoped in the SQL, on the role accounts
 * the entity itself points at.
 */
async function withholdingBookedAtIssuance(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string
): Promise<Decimal> {
  const r = await client.query<{ booked: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS booked
       FROM invoices i
       JOIN journal_entry_lines l ON l.journal_entry_id = i.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = i.entity_id
                            AND ar.qualifier IS NULL
                            AND ar.role IN ('isr_retenido_a_favor', 'iva_retenido_a_favor')
      WHERE i.id = $1 AND i.entity_id = $2`,
    [invoiceId, entityId]
  );
  return new Decimal(r.rows[0]?.booked ?? '0');
}

/** The panel key `defersUncausedCancellation` reads (pending-catalog.ts). */
const ADVANCE_BY_CHECK_KEY = 'cheque_advance_before_cashing';

/**
 * MNE-001-572 (#789) · An application of a held cheque's advance that would
 * cancel IVA nobody has caused (`cancelsUncausedIva`) is refused, naming the
 * cashing that lifts it. The firm's answer to `cheque_advance_before_cashing`
 * is read only here, when a refusal is about to happen: `refuse` (the
 * default, LIVA art. 1-B, second paragraph) or `defer_to_cashing`.
 *
 * MNE-001-573 · Under `defer_to_cashing` an application to a PPD invoice goes
 * through and returns true: its entry cancels nothing, and the cashing nets
 * the advance's IVA against the share the invoice releases that day
 * (`pendingRelease`). A PUE invoice at another treatment releases no share
 * to net against, and the IVA paper counts a PUE application on its own day,
 * so it stays refused under either answer.
 */
async function defersUncausedCancellation(
  client: pg.PoolClient,
  entityId: string,
  receipt: PagoVivo,
  inv: { id: string; invoice_number: string; cfdi_uuid: string | null; terms: string | null; memo: string | null },
  iva: string
): Promise<boolean> {
  const method = await resolveInvoiceMetodoPago(client, {
    id: inv.id, entity_id: entityId, invoice_number: inv.invoice_number,
    cfdi_uuid: inv.cfdi_uuid, terms: inv.terms, memo: inv.memo,
  });
  const ppd = method.metodo === 'PPD';
  const refused = cancelsUncausedIva({
    held: true, iva, ppd,
    sale: ppd ? null : await treatmentOfSales(client, entityId, [inv.id]),
    receipt: storedAdvanceTreatment(receipt.advance_factor_type, receipt.advance_tax_rate),
  });
  if (!refused) return false;
  const params = {
    receipt: receipt.payment_number, invoice: inv.invoice_number, iva: new Decimal(iva).toFixed(2), key: ADVANCE_BY_CHECK_KEY,
  };
  const choice = await getPolicy({ tenantId: await tenantDe(client, entityId), entityId }, ADVANCE_BY_CHECK_KEY, client);
  if (choice.value === 'defer_to_cashing') {
    if (ppd) return true;
    throw new AccountingError('ADVANCE_BY_CHEQUE_NOT_CASHED', { key: 'receipt.apply.cheque_advance_deferral_ppd_only', params });
  }
  throw new AccountingError('ADVANCE_BY_CHEQUE_NOT_CASHED', { key: 'receipt.apply.cheque_advance_not_cashed', params });
}

/**
 * Aplicar saldo a cuenta de un cobro existente a una o varias facturas.
 *
 * MNE-001-460: `opts.date` (default today in the entity's zone) dates the
 * entry, each new allocation (`applied_on`) and each invoice's
 * last_payment_date, so a balance read "as of" that day sees both sides
 * move together. It is refused in the future, before the receipt's last
 * posted event and before the date of an invoice it pays.
 *
 * MNE-001-422: a receipt recorded as an advance caused its IVA when it was
 * collected (LIVA art. 1-B). The cash it applies to a PUE invoice takes its
 * share of that IVA (`takeFromAdvance`), which the entry cancels against
 * 2120 instead of causing it twice and the allocation stores
 * (`advance_base_amount`, `advance_iva_amount`, 333) for unapply to give
 * back.
 *
 * MNE-001-461: on a PPD invoice the share the cash settles still leaves 2125
 * (stored in `iva_reclass_amount`), and the advance's IVA takes its place in
 * 2120, so the entry nets the two (`postReceiptApplicationEntry`).
 */
export async function applyCustomerPayment(
  entityId: string,
  paymentId: string,
  aplicaciones: AplicacionPago[],
  userId: string,
  opts: OpcionesPago & { date?: string } = {}
): Promise<CustomerApplicationResult> {
  if (aplicaciones.length === 0) {
    throw new ValidationError('Indica a qué factura(s) se aplica el saldo a cuenta.');
  }
  const vistos = new Set<string>();
  for (const a of aplicaciones) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en la misma aplicación: súmalas en una.`
      );
    }
    vistos.add(a.documentId);
    for (const w of [a.withholdingIsr, a.withholdingIva]) {
      if (w !== undefined && new Decimal(w).isNegative()) {
        throw new ValidationError({ key: 'receipt.withholding.negative', params: { amount: w } });
      }
    }
  }

  const correr = async (client: pg.PoolClient): Promise<CustomerApplicationResult> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);
    refuseTransferRow(pago);
    const date = await receiptEventDate(client, entityId, pago, opts.date, 'apply');
    const remanente = await remanenteDe(client, entityId, paymentId);
    const advance = await advanceLeft(client, entityId, pago, remanente);
    const held = await holdsIvaUntilCashed(client, entityId, pago);
    const total = aplicaciones.reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
    if (total.greaterThan(remanente)) {
      throw new ValidationError(
        `El cobro ${pago.payment_number} tiene ${remanente.toFixed(2)} sin aplicar y se intentan ` +
          `aplicar ${total.toFixed(2)}: el saldo a cuenta no alcanza.`
      );
    }

    const documentos: DocumentoAplicado[] = [];
    const posteriores: AplicacionPosterior[] = [];
    const filas: { allocId: string; invoiceId: string }[] = [];

    for (const app of aplicaciones) {
      const r = await client.query<{
        id: string; invoice_number: string; customer_id: string; amount_due: string; status: string;
        currency_code: string; subtotal: string; tax_amount: string; total_amount: string;
        cfdi_uuid: string | null; terms: string | null; memo: string | null; invoice_date: string;
      }>(
        `SELECT id, invoice_number, customer_id, amount_due, status, currency_code,
                subtotal, tax_amount, total_amount, cfdi_uuid, terms, memo,
                to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Invoice', app.documentId);
      const inv = r.rows[0];
      // NOTE: the party speaks before status and currency (#664). Those two say
      // how to make the invoice applicable, and one of another customer never
      // is: its sale is not collected with this cash (CCF art. 2185; LIVA art. 1o.-B).
      if (inv.customer_id !== pago.customer_id) {
        const [invoiceCustomer, receiptCustomer] = await partyLabels(
          client, entityId, 'customer', [inv.customer_id, pago.customer_id]
        );
        throw new ValidationError({
          key: 'receipt.apply.other_customer',
          params: { invoice: inv.invoice_number, invoiceCustomer, receipt: pago.payment_number, receiptCustomer },
        });
      }
      if (!COBRABLES.includes(inv.status as (typeof COBRABLES)[number])) {
        throw new ValidationError(
          `${inv.invoice_number} está en "${inv.status}" y sólo se puede aplicar a una factura ` +
            `${COBRABLES.join(', ')}.`
        );
      }
      assertMoneda(inv.invoice_number, inv.currency_code, pago.currency_code);
      // MNE-001-460: cash cannot settle a sale before the sale exists.
      if (date < inv.invoice_date) {
        throw new ValidationError(
          { key: 'receipt.apply.date_before_invoice', params: { invoice: inv.invoice_number, invoiceDate: inv.invoice_date, date } },
          'date'
        );
      }
      const aplicado = new Decimal(app.amountApplied);
      // An allocation row holds cash (CHECK amount_applied > 0): a withholding
      // alone would reach Postgres as a constraint error, so say why here.
      if (!aplicado.greaterThan(0)) {
        throw new ValidationError({
          key: 'receipt.withholding.cash_required',
          params: { invoice: inv.invoice_number, amount: app.amountApplied },
        });
      }
      const isr = new Decimal(app.withholdingIsr ?? '0');
      const iva = new Decimal(app.withholdingIva ?? '0');
      // What this event takes off the invoice: the cash plus what the
      // customer withheld (MNE-001-113).
      const settled = aplicado.plus(isr).plus(iva);
      const saldo = new Decimal(inv.amount_due);
      if (settled.greaterThan(saldo)) {
        throw new ValidationError(
          settled.equals(aplicado)
            ? `${inv.invoice_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${settled.toFixed(2)}.`
            : { key: 'receipt.withholding.exceeds_due', params: {
                invoice: inv.invoice_number, due: saldo.toFixed(2), settled: settled.toFixed(2),
                cash: aplicado.toFixed(2), withheld: isr.plus(iva).toFixed(2),
              } }
        );
      }
      if (isr.plus(iva).greaterThan(0)) {
        // An invoice born from an issued CFDI with retenciones is booked NET:
        // its issuance entry already debited the two customer-withholding
        // roles (issued-invoice-approval.ts, 'withholdings by the customer').
        // Withholding it again here would count the same ISR and VAT twice
        // toward the provisional payment and the VAT return, and close AR
        // with money nobody paid.
        const atIssuance = await withholdingBookedAtIssuance(client, entityId, inv.id);
        if (atIssuance.greaterThan(0)) {
          throw new ValidationError(
            { key: 'receipt.withholding.booked_at_issuance', params: { invoice: inv.invoice_number, amount: atIssuance.toFixed(2) } }
          );
        }
      }

      // Lo aplicado (vivo) a la factura ANTES de este evento: la base del
      // objetivo acumulado del IVA, para que las parciales no deriven.
      const prev = await client.query<{ aplicado: string; isr: string; iva: string }>(
        // MNE-001-113: a withholding settled the invoice too, so it counts.
        `SELECT COALESCE(SUM(amount_applied + withholding_isr_amount + withholding_iva_amount), 0)::text AS aplicado,
                COALESCE(SUM(withholding_isr_amount), 0)::text AS isr,
                COALESCE(SUM(withholding_iva_amount), 0)::text AS iva
           FROM payment_allocations WHERE invoice_id = $1 AND unapplied_at IS NULL`,
        [app.documentId]
      );
      // The customer cannot withhold more VAT than the invoice transferred,
      // nor more ISR than its subtotal, across every live collection.
      const ivaCap = new Decimal(inv.tax_amount);
      const isrCap = new Decimal(inv.subtotal);
      if (iva.plus(prev.rows[0]?.iva ?? '0').greaterThan(ivaCap)) {
        throw new ValidationError({ key: 'receipt.withholding.vat_cap', params: { invoice: inv.invoice_number, cap: ivaCap.toFixed(2) } });
      }
      if (isr.plus(prev.rows[0]?.isr ?? '0').greaterThan(isrCap)) {
        throw new ValidationError({ key: 'receipt.withholding.isr_cap', params: { invoice: inv.invoice_number, cap: isrCap.toFixed(2) } });
      }

      // MNE-001-422: the part of the advance this cash is, and the IVA it carries.
      // MNE-001-591: cash applied again to the invoice a credit note capped is that invoice's own collected
      // consideration, so it takes the pool that carries its kept IVA first (decision (A) on #792).
      const take = advance
        ? takeFromAdvance({ ...advance, ...(advance.own.has(app.documentId) ? { plain: '0' } : {}), applied: aplicado.toFixed(4) })
        : { plain: aplicado.toFixed(4), base: '0.0000', iva: '0.0000' };
      const deferred = held && new Decimal(take.iva).greaterThan(0)
        ? await defersUncausedCancellation(client, entityId, pago, inv, take.iva)
        : false;
      const fromAdvance = new Decimal(take.base).plus(take.iva);
      // MNE-001-590: the IEPS that cash carries, caused when collected, at the pool's own ratio. A held
      // cheque releases nothing, so it takes none.
      const iepsTake = advance && !held
        ? iepsTakeOf({ left: advance.ieps, cashLeft: new Decimal(advance.total).minus(advance.consumed).toFixed(4), fromAdvance: fromAdvance.toFixed(4) })
        : '0.0000';
      let twiceIn: string | null = null;
      let cashedOn: string | null = null;
      if (advance && fromAdvance.greaterThan(0)) {
        advance.ieps = new Decimal(advance.ieps).minus(iepsTake).toFixed(4);
        advance.consumed = new Decimal(advance.consumed).plus(fromAdvance).toFixed(4);
        advance.cancelled = new Decimal(advance.cancelled).plus(take.iva).toFixed(4);
        advance.plain = new Decimal(advance.plain).minus(take.plain).toFixed(4);
        // A PUE invoice caused its IVA when it was issued (LIVA art. 1-B; CFF 29-A fr. VII b). Issued on or
        // before the advance, the advance's month carried both, and an application in a later month cancels
        // one of them there, not in the month that declared it twice. A PPD invoice parked its IVA instead:
        // the share this cash settles leaves 2125 and nets against the advance's (MNE-001-461), so no month
        // carries it twice.
        // MNE-001-573: a cheque's advance caused its IVA on the cashing day, so that is when it was received;
        // while it is held it caused none yet. A PUE invoice of a month before the cashing caused in its own
        // month the IVA that LIVA art. 1-B, second paragraph, puts on the cashing day: the application says so.
        const cashing = pago.payment_method === 'check' && pago.check_cashed_date ? toCalendarDate(pago.check_cashed_date) : null;
        const received = cashing ?? toCalendarDate(pago.payment_date);
        const twice = inv.invoice_date <= received && date.slice(0, 7) > received.slice(0, 7);
        const beforeCashing = cashing !== null && inv.invoice_date.slice(0, 7) < cashing.slice(0, 7);
        if (!held && new Decimal(take.iva).greaterThan(0) && (twice || beforeCashing)) {
          const invoiceMethod = await resolveInvoiceMetodoPago(client, {
            id: inv.id, entity_id: entityId, invoice_number: inv.invoice_number,
            cfdi_uuid: inv.cfdi_uuid, terms: inv.terms, memo: inv.memo,
          });
          if (invoiceMethod.metodo !== 'PPD') {
            twiceIn = twice ? received.slice(0, 7) : inv.invoice_date.slice(0, 7);
            cashedOn = twice ? null : cashing;
          }
        }
      }

      const allocId = uuidv4();
      await client.query(
        `INSERT INTO payment_allocations
           (id, payment_id, invoice_id, amount_applied, withholding_isr_amount, withholding_iva_amount, applied_on,
            advance_base_amount, advance_iva_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9)`,
        [allocId, paymentId, app.documentId, app.amountApplied, isr.toFixed(4), iva.toFixed(4), date, take.base, take.iva]
      );
      // GREATEST: an application dated before another collection of the
      // same invoice does not move its last payment back.
      const settledRow = await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = GREATEST(last_payment_date, $2::date)
         WHERE id = $3 AND entity_id = $4 AND status = ANY($5::text[]) AND amount_due >= $1`,
        [settled.toFixed(4), date, app.documentId, entityId, [...COBRABLES]]
      );
      if (settledRow.rowCount !== 1) {
        throw new AccountingError(
          'INVOICE_CHANGED',
          `${inv.invoice_number} changed while the collection was being applied; nothing was written.`
        );
      }

      const nuevo = saldo.minus(settled);
      documentos.push({
        id: inv.id, numero: inv.invoice_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: inv.currency_code,
        withholdingIsr: isr.toFixed(2),
        withholdingIva: iva.toFixed(2),
        advanceIva: deferred ? '0.00' : new Decimal(take.iva).toFixed(2),
        advanceIvaTwiceIn: twiceIn,
        ...(deferred ? { advanceIvaDeferred: new Decimal(take.iva).toFixed(2) } : {}),
        advanceIvaCashedOn: cashedOn,
      });
      posteriores.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        amount: aplicado.toFixed(4),
        withholdingIsr: isr.toFixed(4),
        withholdingIva: iva.toFixed(4),
        // MNE-001-573: a deferred IVA is cancelled by nothing here; the allocation stores it for the cashing.
        advanceIva: deferred ? '0' : take.iva,
        advanceIvaTwiceIn: twiceIn,
        ...(deferred ? { advanceIvaDeferred: take.iva } : {}),
        advanceIvaCashedOn: cashedOn,
        ...(new Decimal(iepsTake).greaterThan(0) ? { advanceIeps: iepsTake } : {}),
        priorApplied: prev.rows[0]?.aplicado ?? '0',
        taxAmount: inv.tax_amount,
        totalAmount: inv.total_amount,
        cfdiUuid: inv.cfdi_uuid,
        terms: inv.terms,
        memo: inv.memo,
      });
      filas.push({ allocId, invoiceId: inv.id });
    }

    const { entry, ivaPorFactura } = await postReceiptApplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
        holdsIvaUntilCashed: held,
      },
      posteriores,
      userId,
      date
    );
    // 0 included (MNE-001-459), on any entity: NULL is left to rows written
    // before anyone stored it. Invariant 3: only the live row that has not
    // recorded a release, of a receipt of this entity, and a miss is loud.
    for (const fila of filas) {
      const stored = await client.query(
        `UPDATE payment_allocations SET iva_reclass_amount = $1 WHERE id = $2
            AND unapplied_at IS NULL AND iva_reclass_amount IS NULL
            AND payment_id = (SELECT id FROM customer_payments WHERE id = $3 AND entity_id = $4)`,
        [ivaPorFactura.get(fila.invoiceId) ?? '0', fila.allocId, pago.id, entityId]
      );
      if (stored.rowCount !== 1) {
        throw new AccountingError(
          'PAYMENT_ALLOCATION_NOT_FOUND',
          `${pago.payment_number}: the allocation just written is not waiting for its released IVA, ` +
            'so the amount an unapply would re-park cannot be recorded.'
        );
      }
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        evento: 'apply',
        date,
        aplicado: total.toFixed(2),
        withholding: aplicaciones.reduce(
          (s, a) => s.plus(a.withholdingIsr ?? '0').plus(a.withholdingIva ?? '0'), new Decimal(0)
        ).toFixed(2),
        documentos: documentos.length,
        advance_iva_cancelled: posteriores.reduce((s, a) => s.plus(a.advanceIva ?? '0'), new Decimal(0)).toFixed(4),
        advance_iva_deferred: posteriores.reduce((s, a) => s.plus(a.advanceIvaDeferred ?? '0'), new Decimal(0)).toFixed(4),
        journal_entry_id: entry.id,
      },
    });

    const salida: CustomerApplicationResult = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documentos,
      remanenteAnterior: remanente.toFixed(2),
      remanenteNuevo: remanente.minus(total).toFixed(2),
      date,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

export interface ResultadoDesaplicacion {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry;
  attestation: { entityId: string; entryId: string };
  documento: DocumentoAplicado;
  desaplicado: string;
  ivaReAparcado: string;
  ivaEstimado: boolean;
  /** MNE-001-460: the day of the unapply, which its entry and the closure carry. */
  date: string;
  /** #699 · The IEPS moved back to the uncollected role: exactly what this receipt had moved. */
  iepsReparked: string;
  /** MNE-001-572 · The IVA of the cash put back as an advance that the cheque's cashing will cause; 0.00 otherwise. */
  ivaAtCashing: string;
  /** MNE-001-574 · The IVA the rows' plain cash keeps caused, back on account with it (LIVA art. 1-B); 4 dp. */
  ivaKeptCaused: string;
  /**
   * MNE-001-585 · Why that IVA stays caused: `default` (`plain_receipt_unapply_iva = keep_caused`), or
   * `later_month` (`repark_same_month`, but released in an earlier month); null when nothing is kept.
   */
  keptBecause: 'default' | 'later_month' | null;
}

/** The panel key `keptUnderPolicy` reads (pending-catalog.ts). */
const PLAIN_UNAPPLY_KEY = 'plain_receipt_unapply_iva';

/**
 * MNE-001-585 (#792, part 2/3) · What the rows of a plain receipt's unapply
 * keep caused once the firm's answer to `plain_receipt_unapply_iva` is read,
 * only here and only when some row would keep IVA. `keep_caused` (the
 * default, LIVA arts. 1-B and 7) keeps them; `repark_same_month` re-parks each
 * row released in the calendar month of the unapply (`reparkSameMonth`). A
 * held cheque released nothing, so it is never re-parked.
 */
async function keptUnderPolicy(
  client: pg.PoolClient,
  entityId: string,
  payment: PagoVivo,
  rows: readonly { applied_on: string | null }[],
  kept: string[],
  date: string,
  held: boolean
): Promise<{ kept: string[]; because: ResultadoDesaplicacion['keptBecause'] }> {
  if (!kept.some((k) => new Decimal(k).greaterThan(0))) return { kept, because: null };
  const choice = held ? null : await getPolicy({ tenantId: await tenantDe(client, entityId), entityId }, PLAIN_UNAPPLY_KEY, client);
  if (choice?.value !== 'repark_same_month') return { kept, because: 'default' };
  const dates = {
    paymentDate: toCalendarDate(payment.payment_date), paymentMethod: payment.payment_method,
    checkCashedOn: payment.check_cashed_date ? toCalendarDate(payment.check_cashed_date) : null,
  };
  const keyed = reparkSameMonth(kept, rows.map((r) => releaseDayOf(r.applied_on, dates)), date);
  return { kept: keyed.kept, because: keyed.laterMonth ? 'later_month' : null };
}

/**
 * MNE-001-581 · Of the IVA `released` by the allocations about to end
 * (`ending`), what does not go back to 2125: after a credit note linked to
 * the invoice, 2125 must end at the IVA of the balance owed again
 * (`issuedVatOfOpenBalance`, LIVA arts. 1-B and 7), so the re-park is what
 * takes it there from what it holds now, never more than was released, and
 * the rest stays in 2120, where the note already restituted it. With no note,
 * or nothing released, nothing is kept: the unapply is as it was.
 */
async function keptAfterNotes(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string,
  released: Decimal,
  ending: readonly string[]
): Promise<{ amount: Decimal; notes: string; carries: string }> {
  const none = { amount: new Decimal(0), notes: '', carries: '0' };
  if (!released.greaterThan(0)) return none;
  const open = await issuedVatOfOpenBalance(client, entityId, invoiceId, { ending });
  if (!open.hasNote) return none;
  const parked = new Decimal((await issuedVatStillParked(client, entityId, invoiceId)).parked);
  const back = Decimal.min(released, Decimal.max(new Decimal(open.target).minus(parked), 0));
  return { amount: released.minus(back), notes: open.noteNumbers, carries: open.target };
}

/**
 * Desaplicar un cobro de una factura: la aplicación se CLAUSURA (nunca se
 * borra), la factura reabre y el crédito vuelve a estar a cuenta. El IVA que
 * la aplicación liberó se re-aparca por el importe exacto que guardó su fila.
 *
 * MNE-001-517: a row that stored no IVA is estimated pro-rata only when the
 * invoice is PPD and the entity keeps cash-basis IVA books. A PUE invoice
 * and an entity off Mexican books parked nothing, so nothing is re-parked.
 *
 * MNE-001-460: `args.date` (default today in the entity's zone) dates the
 * closure (`unapplied_at`) and the entry, so a balance read "as of" that day
 * sees both sides move together, as `payment unapply` does on the vendor
 * side. It is refused in the future and before the receipt's last posted
 * event: the ledger would undo an application before it happened.
 *
 * MNE-001-422: the advance's IVA the rows cancelled goes back to 2120, as
 * they stored it: the cash is back on account as the advance it was.
 *
 * MNE-001-461: on a PPD invoice that IVA stays caused in place of the share
 * the rows released, which goes back to 2125 because the invoice is owed
 * again; `ivaReAparcado` is only what leaves 2120, 0 when the two are equal.
 *
 * MNE-001-574 (#792): on a receipt with no treatment, the share a row's plain
 * cash released stays caused too (LIVA art. 1-B; the owner's «Mantener
 * causado» of 19 Nov 2026, #623): the cash goes back to 2150 for its base,
 * the row stores what it kept (`unapply_kept_iva_amount`), and a later
 * application nets it (`keptOnAccount`). The IEPS stays caused with it;
 * MNE-001-590: the invoice's share goes back to 2181 all the same, and the
 * cash carries it (`iepsKeptOnAccount`), so the application nets it too.
 * MNE-001-585: under `plain_receipt_unapply_iva = repark_same_month` a row
 * released in the month of the unapply re-parks instead (`keptUnderPolicy`).
 *
 * MNE-001-581: after a credit note linked to the invoice, what goes back to
 * 2125 is only what brings it to the IVA of the balance owed again; the rest
 * of the release stays in 2120, where the note restituted it (`keptAfterNotes`).
 *
 * The two together (#792, decision (A)): the note's restitution stands (LIVA
 * art. 7), so the cash keeps caused at most what went back to 2125, net of
 * the IVA its taken advance carries (`capKept`); the cash the note covers is
 * a balance owed back, not consideration, and carries none.
 *
 * MNE-001-592 (#814): the same holds for cash that carried an advance's IVA,
 * on a receipt with a treatment or from a plain receipt's pool: the advance
 * IVA that goes back to 2120 loses what the note restituted (`restitutedOf`),
 * each row stores its share (`unapply_restituted_iva_amount`, 342), and the
 * advance leaves it with the cash it covers (`advanceLeft`).
 */
export async function unapplyCustomerPayment(
  entityId: string,
  paymentId: string,
  args: { invoiceId: string; reason: string; date?: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoDesaplicacion> {
  const correr = async (client: pg.PoolClient): Promise<ResultadoDesaplicacion> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);
    refuseTransferRow(pago);
    // MNE-001-082: a foreign-currency collection now exists, and its unapply
    // entry would move the applied dollars between cxc and anticipo_clientes
    // as if they were pesos. Refused, like the vendor side, until it converts.
    if (pago.currency_code !== (await functionalCurrencyOf(client, entityId))) {
      throw new ValidationError(
        `${pago.payment_number} is in ${pago.currency_code}: unapplying a foreign-currency collection ` +
          'needs the rate of each leg, which its allocations do not store.'
      );
    }
    const date = await receiptEventDate(client, entityId, pago, args.date, 'unapply');

    const inv = await client.query<{
      id: string; invoice_number: string; amount_due: string; amount_paid: string;
      currency_code: string; tax_amount: string; total_amount: string;
      cfdi_uuid: string | null; terms: string | null; memo: string | null;
    }>(
      `SELECT id, invoice_number, amount_due, amount_paid, currency_code, tax_amount, total_amount,
              cfdi_uuid, terms, memo
         FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [args.invoiceId, entityId]
    );
    if (inv.rows.length === 0) throw new NotFoundError('Invoice', args.invoiceId);
    const factura = inv.rows[0];

    const vivas = await client.query<{
      id: string; amount_applied: string; iva_reclass_amount: string | null; isr: string; iva: string; advance_iva: string;
      plain: string; applied_on: string | null;
    }>(
      `SELECT id, amount_applied::text, iva_reclass_amount::text, applied_on::text,
              withholding_isr_amount::text AS isr, withholding_iva_amount::text AS iva,
              advance_iva_amount::text AS advance_iva,
              (amount_applied - advance_base_amount - advance_iva_amount)::text AS plain
         FROM payment_allocations
        WHERE payment_id = $1 AND invoice_id = $2 AND unapplied_at IS NULL
        FOR UPDATE`,
      [paymentId, args.invoiceId]
    );
    if (vivas.rows.length === 0) {
      throw new ValidationError(
        `El cobro ${pago.payment_number} no tiene ninguna aplicación viva sobre ${factura.invoice_number}: ` +
          'no hay qué desaplicar.'
      );
    }

    const total = vivas.rows.reduce((s, r) => s.plus(r.amount_applied), new Decimal(0));
    // MNE-001-113: the withholding closed part of the invoice too, so it
    // reopens with the cash and leaves its role accounts.
    const withheldIsr = vivas.rows.reduce((s, r) => s.plus(r.isr), new Decimal(0));
    const withheldIva = vivas.rows.reduce((s, r) => s.plus(r.iva), new Decimal(0));
    const reopened = total.plus(withheldIsr).plus(withheldIva);
    // MNE-001-422: the advance's IVA these rows cancelled goes back to 2120, read from what they stored.
    // MNE-001-462: on a receipt with a treatment, the cash they took that was no advance goes back as one
    // too, its IVA at the receipt's treatment (`backAsAdvance`, «no re-park»); a receipt with none keeps its own (below).
    // MNE-001-572: while a cheque is held that IVA is not caused yet (LIVA art. 1-B, second paragraph):
    // the cash goes back whole to 2150, and the cashing causes it (`advanceBackOnAccount`).
    const treatment = storedAdvanceTreatment(pago.advance_factor_type, pago.advance_tax_rate);
    const putBackIva = treatment === null ? '0' : backAsAdvance(vivas.rows.map((r) => r.plain), treatment).iva;
    const held = await holdsIvaUntilCashed(client, entityId, pago);
    const backIva = held ? '0' : putBackIva;
    // MNE-001-573: a held cheque's rows on a PPD invoice cancelled no IVA (`defer_to_cashing`; part 1 refuses
    // them otherwise), so nothing goes back to 2120 for them: the cashing nets what they keep.
    const taken = vivas.rows.reduce((s, r) => s.plus(r.advance_iva), new Decimal(0));
    const deferredBack = held && taken.greaterThan(0) && (await resolveInvoiceMetodoPago(client, {
      id: factura.id, entity_id: entityId, invoice_number: factura.invoice_number,
      cfdi_uuid: factura.cfdi_uuid, terms: factura.terms, memo: factura.memo,
    })).metodo === 'PPD';
    const advanceIva = (deferredBack ? new Decimal(0) : taken).plus(backIva);
    // MNE-001-574: a receipt with none keeps each row's caused share instead (`keptIvaOf`). A held
    // cheque released nothing, so it keeps nothing here.
    const keptByRow = vivas.rows.map((r) =>
      treatment === null && !held ? keptIvaOf({ amount: r.amount_applied, plain: r.plain, released: r.iva_reclass_amount }) : '0.0000'
    );
    const conIva = vivas.rows.filter((r) => r.iva_reclass_amount !== null);
    const sinIva = vivas.rows.filter((r) => r.iva_reclass_amount === null);
    const ivaExacto = conIva.reduce((s, r) => s.plus(r.iva_reclass_amount as string), new Decimal(0));
    // A row with no stored IVA (written before MNE-001-459 stored 0 on every
    // new row) is estimated pro-rata, and the entry says so. Only a PPD
    // invoice on cash-basis books parked IVA (LIVA art. 1o.-B); the books are
    // read first, so an entity off Mexican books never reads a MetodoPago.
    // Stored IVA is a fact of the ledger and is never gated.
    const parksIva =
      sinIva.length > 0 &&
      (await entityUsesCashBasisIva(client, entityId)) &&
      (await resolveInvoiceMetodoPago(client, {
        id: factura.id, entity_id: entityId, invoice_number: factura.invoice_number,
        cfdi_uuid: factura.cfdi_uuid, terms: factura.terms, memo: factura.memo,
      })).metodo === 'PPD';
    const montoSinIva = sinIva.reduce((s, r) => s.plus(r.amount_applied), new Decimal(0));
    const ivaEstimadoParte = parksIva && montoSinIva.greaterThan(0)
      ? new Decimal(
          ivaToReclassify({
            ivaTotal: factura.tax_amount,
            documentTotal: factura.total_amount,
            priorApplied: '0',
            appliedNow: montoSinIva.toFixed(4),
          })
        )
      : new Decimal(0);
    const estimado = sinIva.length > 0 && ivaEstimadoParte.greaterThan(0);
    // MNE-001-461: what leaves 2120 for 2125. Cash that carried an advance's
    // IVA goes back on account as that advance, its IVA still caused (LIVA
    // art. 1-B; the owner's «no re-park» of 17 Nov 2026, #623): the share
    // back in 2125 takes the advance's IVA, and only what exceeds it, when
    // the invoice's rate is above the advance's, leaves 2120.
    const released = ivaExacto.plus(ivaEstimadoParte);
    // MNE-001-581: after a credit note, only what brings the invoice's 2125 to
    // the IVA of the balance it is owed again; the rest stays in 2120, where
    // the note already restituted it (LIVA art. 7). With no note, all of it.
    const noteKept = await keptAfterNotes(client, entityId, factura.id, released, vivas.rows.map((r) => r.id));
    // MNE-001-592 (decision (A) on #792): the advance's IVA the note restituted is not caused again either (LIVA
    // art. 7); the cash keeps only the rest (`restitutedOf`), and each row stores its share, by the advance IVA it
    // carried back, so the advance it returns to leaves that IVA and the cash it covers (`advanceLeft`).
    const restitution = restitutedOf(advanceIva, released, noteKept.amount);
    const backInParked = new Decimal(restitution.back);
    const advanceKept = new Decimal(restitution.kept);
    const restitutedRows = restitutedByRow(
      vivas.rows.map((r) => new Decimal(deferredBack ? 0 : r.advance_iva)
        .plus(treatment === null || held ? 0 : backAsAdvance([r.plain], treatment).iva).toFixed(4)),
      restitution.restituted
    );
    // MNE-001-574 with 581 (decision (A) on #792): the plain cash keeps caused no more than what goes back to
    // 2125 beyond its taken advance's IVA; what the note restituted is not caused again.
    // MNE-001-585: the firm may re-park instead, only in the month the IVA was released (`keptUnderPolicy`).
    const { kept, because: keptBecause } = await keptUnderPolicy(
      client, entityId, pago, vivas.rows, capKept(keptByRow, Decimal.max(backInParked.minus(advanceKept), 0).toFixed(4)), date, held
    );
    const keptIva = kept.reduce((s, k) => s.plus(k), new Decimal(0));
    const stillCaused = advanceKept.plus(keptIva);
    const reparked = stillCaused.greaterThan(0) ? Decimal.max(backInParked.minus(stillCaused), 0) : backInParked;
    // #699 · The IEPS this receipt moved for the invoice, read back from the
    // tagged lines of its unreversed entries before the rows close: exact,
    // net of an earlier unapply, and zero where nothing was parked.
    // MNE-001-574: on a receipt with no treatment it stays caused with the IVA, whether the rows kept it or
    // took it from cash already back on account (LIEPS art. 5o.-C).
    const iepsStays = treatment === null && stillCaused.greaterThan(0);
    const iepsMoved = iepsStays ? new Decimal(0) : await iepsMovedForInvoice(client, entityId, factura.id, paymentId);
    // MNE-001-590: what stays caused goes back to 2181 all the same, because the invoice is owed again, and the
    // cash back on account carries it (LIEPS art. 10), so a later application nets it instead of causing it again.
    const iepsKept = iepsStays ? await iepsMovedForInvoice(client, entityId, factura.id, paymentId) : new Decimal(0);

    // Invariant 3: the live rows read above, of a receipt of this entity, and
    // every one of them; a miss is loud.
    const closed = await client.query(
      `UPDATE payment_allocations pa
          SET unapplied_at = $1::date, unapplied_by = $2, unapply_reason = $3, unapply_kept_iva_amount = k.kept,
              unapply_restituted_iva_amount = k.restituted
         FROM unnest($4::uuid[], $7::numeric[], $8::numeric[]) AS k(id, kept, restituted)
        WHERE pa.id = k.id AND pa.unapplied_at IS NULL
          AND pa.payment_id = (SELECT id FROM customer_payments WHERE id = $5 AND entity_id = $6)`,
      [
        date, userId, args.reason, vivas.rows.map((r) => r.id), paymentId, entityId,
        kept.map((k) => (new Decimal(k).greaterThan(0) ? k : null)),
        restitutedRows.map((r) => (new Decimal(r).greaterThan(0) ? r : null)),
      ]
    );
    if (closed.rowCount !== vivas.rows.length) {
      throw new AccountingError(
        'UNAPPLY_RACE',
        `${pago.payment_number} on ${factura.invoice_number} changed while it was being unapplied; nothing was written.`
      );
    }
    const reopenedRow = await client.query(
      `UPDATE invoices SET
         amount_paid = amount_paid - $1,
         amount_due  = amount_due + $1,
         status = CASE WHEN amount_paid - $1 <= 0 THEN 'sent' ELSE 'partially_paid' END
       WHERE id = $2 AND entity_id = $3 AND amount_paid >= $1`,
      [reopened.toFixed(4), args.invoiceId, entityId]
    );
    if (reopenedRow.rowCount !== 1) {
      throw new AccountingError(
        'INVOICE_CHANGED',
        `${factura.invoice_number} has less paid than this collection settled on it; nothing was written.`
      );
    }

    const entry = await postReceiptUnapplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
      },
      {
        invoiceNumber: factura.invoice_number,
        amount: total.toFixed(4),
        withholdingIsr: withheldIsr.toFixed(4),
        withholdingIva: withheldIva.toFixed(4),
        ivaReclass: estimado ? null : backInParked.toFixed(4),
        ivaEstimado: backInParked.toFixed(4),
        advanceIva: advanceKept.toFixed(4),
        keptIva: keptIva.toFixed(4),
        date,
        ...(noteKept.amount.greaterThan(0)
          ? { ivaKept: {
              amount: noteKept.amount.toFixed(4), notes: noteKept.notes, carries: noteKept.carries, restituted: restitution.restituted,
            } }
          : {}),
        ...(iepsMoved.greaterThan(0)
          ? { ieps: { invoiceId: factura.id, invoiceNumber: factura.invoice_number, amount: iepsMoved.toFixed(4) } }
          : {}),
        ...(iepsKept.greaterThan(0)
          ? { iepsKept: { invoiceId: factura.id, invoiceNumber: factura.invoice_number, amount: iepsKept.toFixed(4) } }
          : {}),
      },
      userId
    );

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        evento: 'unapply',
        invoice: factura.invoice_number,
        date,
        desaplicado: total.toFixed(2),
        advance_iva_restored: advanceKept.toFixed(4),
        advance_iva_restituted: restitution.restituted,
        iva_kept_caused: keptIva.toFixed(4),
        ...(iepsMoved.greaterThan(0) ? { ieps_reparked: iepsMoved.toFixed(4) } : {}),
        ...(iepsKept.greaterThan(0) ? { ieps_kept_caused: iepsKept.toFixed(4) } : {}),
        journal_entry_id: entry.id,
      },
      reason: args.reason,
    });

    const salida: ResultadoDesaplicacion = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documento: {
        id: factura.id, numero: factura.invoice_number,
        saldoAnterior: new Decimal(factura.amount_due).toFixed(2),
        saldoNuevo: new Decimal(factura.amount_due).plus(reopened).toFixed(2),
        estado: new Decimal(factura.amount_paid).minus(reopened).lessThanOrEqualTo(0) ? 'sent' : 'partially_paid',
        moneda: factura.currency_code,
        withholdingIsr: withheldIsr.toFixed(2),
        withholdingIva: withheldIva.toFixed(2),
        advanceIva: advanceKept.toFixed(2),
      },
      desaplicado: total.toFixed(2),
      ivaReAparcado: reparked.toFixed(4),
      ivaEstimado: estimado,
      date,
      iepsReparked: iepsMoved.toFixed(4),
      ivaAtCashing: new Decimal(held ? putBackIva : '0').toFixed(2),
      ivaKeptCaused: keptIva.toFixed(4),
      keptBecause: keptIva.greaterThan(0) ? keptBecause : null,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

export interface ResultadoReversa {
  paymentId: string;
  paymentNumber: string;
  reversals: { entryNumber: string; of: string }[];
  attestations: { entityId: string; entryId: string }[];
  documentosReabiertos: DocumentoAplicado[];
  /** MNE-001-509: the cause the receipt keeps; null when none was stated and the method has no default. */
  cause: ReversalCause | null;
  /** True when nobody stated the cause and the receipt took the one a cheque has. */
  causeDefaulted: boolean;
  /** Keys of what the accountant should read before confirming; the dry run returns the same. */
  warnings: TranslationKey[];
}

/**
 * MNE-001-509: what happened to the money of a reversed receipt. It never
 * became the firm's, so it never caused the IVA (LIVA art. 1-B); or it
 * arrived and was taken back, which leaves the IVA only by a restitution
 * (LIVA art. 7). A fact of each receipt that a person states, so there is
 * no policy key for it.
 */
export const REVERSAL_CAUSES = ['not_collected', 'taken_back'] as const;
export type ReversalCause = (typeof REVERSAL_CAUSES)[number];

/**
 * What a reversal writes on each mirror and on each closed allocation. A
 * ledger description and a stored value: English, and never translated.
 */
function reversalNote(cause: ReversalCause | null, reason: string): string {
  const what = cause === null ? 'cause not stated' : cause.replace('_', ' ');
  return `Reversed (${what}): ${reason}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CobroDetalle {
  id: string;
  payment_number: string;
  customer_id: string;
  customer_name: string | null;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  payment_method: string;
  reference_number: string | null;
  status: string;
  journal_entry_number: string | null;
  /** REP: el UUID del CFDI tipo P que documenta este cobro, si ya se ligó. */
  cfdi_uuid: string | null;
  cfdi_pago_indice: number | null;
  reversed_at: Date | null;
  /** MNE-001-509: what happened to the money of a reversed receipt, and when that was stated. */
  reversal_cause: string | null;
  reversal_cause_stated_at: Date | null;
  unapplied_amount: string;
  /** MNE-001-421: the advance a receipt was recorded as: its base, its treatment ('16', 'exempt'…) and its IVA; nulls when none. */
  advance_base: string | null;
  advance_tax_rate: string | null;
  advance_iva: string | null;
  /** MNE-001-556: the day the bank cashed the cheque and the credit that paid it (migration 331); nulls while it has none. */
  check_cashed_date: string | null;
  check_cashed_tx_id: string | null;
  aplicaciones: {
    invoice_number: string;
    amount_applied: string;
    /** MNE-001-113: the customer's withholding that settled the invoice with the cash. */
    withholding_isr_amount: string;
    withholding_iva_amount: string;
    iva_reclass_amount: string | null;
    /** MNE-001-422: the advance's IVA this allocation cancelled instead of causing it again. */
    advance_iva_amount: string;
    viva: boolean;
    /** MNE-001-460: the day the cash was applied; for a row written before migration 332, the receipt's date. */
    applied_on: string;
    unapplied_at: Date | null;
    unapply_reason: string | null;
  }[];
}

/** El cobro por folio o id, con sus aplicaciones (vivas e historia) y su REP. */
export async function getCustomerPayment(entityId: string, ref: string): Promise<CobroDetalle> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('A receipt reference is required.');
  const porId = UUID_RE.test(trimmed);
  const base = await query<{
    id: string; payment_number: string; customer_id: string; customer_name: string | null;
    payment_amount: string; currency_code: string; payment_date: Date; payment_method: string;
    reference_number: string | null; status: string; journal_entry_number: string | null;
    cfdi_uuid: string | null; cfdi_pago_indice: number | null; reversed_at: Date | null;
    reversal_cause: string | null; reversal_cause_stated_at: Date | null;
    advance_factor_type: string | null; advance_tax_rate: string | null;
    advance_base_amount: string | null; advance_iva_amount: string | null;
    check_cashed_date: string | null; check_cashed_tx_id: string | null; on_account: string;
  }>(
    `SELECT cp.id, cp.payment_number, cp.customer_id, COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name,
            cp.payment_amount::text, cp.currency_code, cp.payment_date, cp.payment_method,
            cp.reference_number, cp.status, je.entry_number AS journal_entry_number,
            cp.cfdi_uuid, cp.cfdi_pago_indice, cp.reversed_at, cp.reversal_cause, cp.reversal_cause_stated_at,
            cp.advance_factor_type, cp.advance_tax_rate::text, cp.advance_base_amount::text, cp.advance_iva_amount::text,
            cp.check_cashed_date::text AS check_cashed_date, cp.check_cashed_tx_id,
            ${cashOnAccountSql('cp')}::text AS on_account
       FROM customer_payments cp
       LEFT JOIN customers cu ON cu.id = cp.customer_id
       LEFT JOIN journal_entries je ON je.id = cp.journal_entry_id
      WHERE cp.${porId ? 'id' : 'payment_number'} = $1 AND cp.entity_id = $2`,
    [trimmed, entityId]
  );
  if (base.rows.length === 0) throw new NotFoundError('Customer payment', trimmed);
  const pago = base.rows[0];

  const apps = await query<{
    invoice_number: string; amount_applied: string; iva_reclass_amount: string | null;
    withholding_isr_amount: string; withholding_iva_amount: string; advance_iva_amount: string;
    applied_on: string; unapplied_at: Date | null; unapply_reason: string | null;
  }>(
    `SELECT i.invoice_number, pa.amount_applied::text, pa.iva_reclass_amount::text,
            pa.withholding_isr_amount::text, pa.withholding_iva_amount::text, pa.advance_iva_amount::text,
            to_char(COALESCE(pa.applied_on, cp.payment_date), 'YYYY-MM-DD') AS applied_on,
            pa.unapplied_at, pa.unapply_reason
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $2
      WHERE pa.payment_id = $1
      ORDER BY pa.created_at`,
    [pago.id, entityId]
  );

  return {
    id: pago.id,
    payment_number: pago.payment_number,
    customer_id: pago.customer_id,
    customer_name: pago.customer_name,
    payment_amount: new Decimal(pago.payment_amount).toFixed(2),
    currency_code: pago.currency_code,
    payment_date: pago.payment_date,
    payment_method: pago.payment_method,
    reference_number: pago.reference_number,
    status: pago.status,
    journal_entry_number: pago.journal_entry_number,
    cfdi_uuid: pago.cfdi_uuid,
    cfdi_pago_indice: pago.cfdi_pago_indice,
    reversed_at: pago.reversed_at,
    reversal_cause: pago.reversal_cause,
    reversal_cause_stated_at: pago.reversal_cause_stated_at,
    unapplied_amount: pago.status === ESTADO ? new Decimal(pago.on_account).toFixed(2) : '0.00',
    advance_base: pago.advance_base_amount === null ? null : new Decimal(pago.advance_base_amount).toFixed(2),
    advance_tax_rate: storedAdvanceTreatment(pago.advance_factor_type, pago.advance_tax_rate),
    advance_iva: pago.advance_iva_amount === null ? null : new Decimal(pago.advance_iva_amount).toFixed(2),
    check_cashed_date: pago.check_cashed_date,
    check_cashed_tx_id: pago.check_cashed_tx_id,
    aplicaciones: apps.rows.map((a) => ({
      invoice_number: a.invoice_number,
      amount_applied: new Decimal(a.amount_applied).toFixed(2),
      // MNE-001-113: what the customer withheld settled the invoice with the cash.
      withholding_isr_amount: new Decimal(a.withholding_isr_amount).toFixed(2),
      withholding_iva_amount: new Decimal(a.withholding_iva_amount).toFixed(2),
      iva_reclass_amount: a.iva_reclass_amount,
      advance_iva_amount: new Decimal(a.advance_iva_amount).toFixed(2),
      viva: a.unapplied_at === null,
      applied_on: a.applied_on,
      unapplied_at: a.unapplied_at,
      unapply_reason: a.unapply_reason,
    })),
  };
}

export interface FiltroCobros {
  customerId?: string;
  since?: string;
  until?: string;
  /** Sólo cobros con saldo sin aplicar. */
  unapplied?: boolean;
  /** Sólo cobros completados sin REP ligado (obligación fiscal propia). */
  needsRep?: boolean;
  limit?: number;
  offset?: number;
}

export interface CobroResumen {
  id: string;
  payment_number: string;
  customer_name: string | null;
  payment_date: Date;
  payment_amount: string;
  applied_amount: string;
  unapplied_amount: string;
  currency_code: string;
  status: string;
  has_rep: boolean;
}

export async function listCustomerPayments(
  entityId: string,
  filtro: FiltroCobros = {}
): Promise<{ rows: CobroResumen[]; total: number }> {
  const params: unknown[] = [entityId];
  const where: string[] = ['cp.entity_id = $1'];
  if (filtro.customerId) {
    params.push(filtro.customerId);
    where.push(`cp.customer_id = $${params.length}`);
  }
  if (filtro.since) {
    params.push(filtro.since);
    where.push(`cp.payment_date >= $${params.length}`);
  }
  if (filtro.until) {
    params.push(filtro.until);
    where.push(`cp.payment_date <= $${params.length}`);
  }
  if (filtro.needsRep) {
    where.push(`cp.cfdi_uuid IS NULL AND cp.status = 'completed'`);
    // MNE-001-421: a receipt that is all advance owes the advance CFDI the client issues, never a REP.
    where.push(`(cp.advance_base_amount IS NULL OR cp.advance_base_amount + cp.advance_iva_amount <> cp.payment_amount)`);
  }
  if (filtro.unapplied) {
    where.push(`cp.status = 'completed' AND ${cashOnAccountSql('cp')} > 0`);
  }

  const sql = `
    SELECT cp.id, cp.payment_number, COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name, cp.payment_date,
           cp.payment_amount::text, COALESCE(ap.aplicado, 0)::text AS applied_amount,
           ${cashOnAccountSql('cp')}::text AS on_account,
           cp.currency_code, cp.status, (cp.cfdi_uuid IS NOT NULL) AS has_rep,
           COUNT(*) OVER()::int AS total
      FROM customer_payments cp
      LEFT JOIN customers cu ON cu.id = cp.customer_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount_applied) AS aplicado
          FROM payment_allocations pa
         WHERE pa.payment_id = cp.id AND pa.unapplied_at IS NULL
      ) ap ON true
     WHERE ${where.join(' AND ')}
     ORDER BY cp.payment_date DESC, cp.payment_number DESC
     LIMIT ${Math.max(1, Math.min(filtro.limit ?? 50, 500))} OFFSET ${Math.max(0, filtro.offset ?? 0)}`;

  const r = await query<{
    id: string; payment_number: string; customer_name: string | null; payment_date: Date;
    payment_amount: string; applied_amount: string; on_account: string; currency_code: string; status: string;
    has_rep: boolean; total: number;
  }>(sql, params);
  return {
    total: r.rows[0]?.total ?? 0,
    rows: r.rows.map((row) => ({
      id: row.id,
      payment_number: row.payment_number,
      customer_name: row.customer_name,
      payment_date: row.payment_date,
      payment_amount: new Decimal(row.payment_amount).toFixed(2),
      applied_amount: new Decimal(row.applied_amount).toFixed(2),
      unapplied_amount: row.status === ESTADO ? new Decimal(row.on_account).toFixed(2) : '0.00',
      currency_code: row.currency_code,
      status: row.status,
      has_rep: row.has_rep,
    })),
  };
}

/**
 * MNE-001-581 · What a reversal's mirrors would put back into 2125 that no
 * reopened balance carries. The mirrors put back `M`, the net 2125 debit of
 * the entries they mirror, which also holds what an earlier unapply of this
 * receipt kept in 2120 after a note. Each invoice the reversal reopens takes
 * back what an unapply would (`keptAfterNotes`); the rest is the correction,
 * and only after a credit note linked to an invoice this receipt allocated
 * to. NOTE: a live allocation that stored no release (before MNE-001-459)
 * leaves `M` unexplained, so nothing is corrected and the reversal is as it
 * was: the conservative side.
 */
async function vatKeptByReversal(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string,
  entryIds: readonly string[]
): Promise<{ amount: Decimal; notes: string }> {
  const none = { amount: new Decimal(0), notes: '' };
  const rows = await client.query<{ id: string; invoice_id: string; live: boolean; released: string | null }>(
    `SELECT pa.id, pa.invoice_id, pa.unapplied_at IS NULL AS live, pa.iva_reclass_amount::text AS released
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
      WHERE pa.payment_id = $2`,
    [entityId, paymentId]
  );
  const live = rows.rows.filter((r) => r.live);
  if (rows.rows.length === 0 || live.some((r) => r.released === null)) return none;
  let back = new Decimal(0);
  const notes = new Set<string>();
  for (const invoiceId of new Set(rows.rows.map((r) => r.invoice_id))) {
    const mine = live.filter((r) => r.invoice_id === invoiceId);
    const released = mine.reduce((sum, r) => sum.plus(r.released as string), new Decimal(0));
    const open = await issuedVatOfOpenBalance(client, entityId, invoiceId);
    if (open.hasNote) for (const n of open.noteNumbers.split(', ')) notes.add(n);
    back = back.plus(released.minus((await keptAfterNotes(client, entityId, invoiceId, released, mine.map((r) => r.id))).amount));
  }
  if (notes.size === 0) return none;
  const { from } = reclassRoles('issued');
  const { rows: [m] } = await client.query<{ moved: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS moved
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $1
       JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = $1
                            AND ar.role = $3 AND ar.qualifier IS NULL
      WHERE je.id = ANY($2::uuid[])`,
    [entityId, [...entryIds], from]
  );
  return { amount: Decimal.max(new Decimal(m.moved).minus(back), 0), notes: [...notes].sort().join(', ') };
}

/**
 * Reversal of a receipt whose money did not stay: every entry of the receipt
 * (the original and the later applications and unapplications) gets its NIF
 * B-1 mirror, the invoices reopen, the live allocations are closed with the
 * note, and the receipt ends 'reversed': it happened and was undone, which
 * is not 'void'. The receipt keeps the cause (MNE-001-509): `not_collected`
 * or `taken_back`, stated by the caller. With none stated, a cheque takes
 * `not_collected`, because it is paid the day the bank cashes it (LIVA art.
 * 1-B); any other method is reversed with no cause until a person states one.
 *
 * MNE-001-581: after a credit note, the mirrors put back into 2125 more than
 * the reopened balances carry; one entry of the reversal's own takes the rest
 * out again (`vatKeptByReversal`, `postReceiptReversalVatEntry`).
 */
export async function reverseCustomerPayment(
  entityId: string,
  paymentId: string,
  args: { reason: string; cause?: string; feeAmount?: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoReversa> {
  const stated = args.cause;
  if (stated !== undefined && !(REVERSAL_CAUSES as readonly string[]).includes(stated)) {
    throw new ValidationError({ key: 'receipt.reverse.cause_unknown', params: { value: stated } });
  }
  if (args.feeAmount !== undefined && new Decimal(args.feeAmount).greaterThan(0)) {
    // El mismo trato que el descuento por pronto pago: reconocer la comisión
    // exige una cuenta con rol que la capa semántica aún no tiene, y sin
    // ella el cargo iría a una cuenta adivinada. Se rechaza en voz alta.
    throw new ValidationError(
      'La comisión por devolución todavía no se puede registrar: necesita una cuenta con rol de ' +
        'comisiones bancarias en la capa semántica. Reversa el cobro sin --fee y registra la ' +
        'comisión como asiento manual mientras tanto.'
    );
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoReversa> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);
    refuseTransferRow(pago);
    // MNE-001-498 · its credit given to another customer stays given until that transfer is undone (part 2).
    const out = await client.query<{ payment_number: string }>(
      `SELECT payment_number FROM customer_payments
        WHERE entity_id = $1 AND transferred_from_payment_id = $2 AND status = '${ESTADO}' ORDER BY payment_number`,
      [entityId, paymentId]
    );
    if (out.rows.length > 0) {
      throw new ValidationError({
        key: 'receipt.reverse.has_transfer',
        params: { receipt: pago.payment_number, transfers: out.rows.map((r) => r.payment_number).join(', ') },
      });
    }
    const causeDefaulted = stated === undefined && pago.payment_method === 'check';
    const cause = causeDefaulted ? 'not_collected' : ((stated as ReversalCause | undefined) ?? null);
    const warnings: TranslationKey[] = [];
    // A card is paid when it is accepted (LIVA art. 1-B), not when it settles.
    if (cause === 'not_collected' && ['credit_card', 'debit_card'].includes(pago.payment_method)) {
      warnings.push('receipt.reverse.warning.card_not_collected');
    }
    // The no-cause warning is about the IVA paper, which only Mexican books have.
    if (cause === null && (await entityUsesCashBasisIva(client, entityId))) {
      warnings.push('receipt.reverse.warning.cause_not_stated');
    }
    const note = reversalNote(cause, args.reason);

    // Todos los asientos posteados del cobro: el original y los eventos.
    const asientos = await client.query<{ id: string; entry_number: string; source_type: string }>(
      `SELECT id, entry_number, source_type FROM journal_entries
        WHERE entity_id = $1 AND status = 'posted' AND reversed_by_entry_id IS NULL
          AND ((source_type = 'customer_payment' AND source_id = $2)
            -- MNE-001-556: the cashing's release is the receipt's too, or a reversed cheque would leave its IVA caused.
            OR (source_type IN ('receipt_application', 'receipt_unapplication', 'customer_cheque_cashing') AND source_id = $2))
        ORDER BY created_at`,
      [entityId, paymentId]
    );
    // MNE-001-581: read before the mirrors, from the entries they mirror.
    const kept = await vatKeptByReversal(client, entityId, paymentId, asientos.rows.map((je) => je.id));

    const reversals: ResultadoReversa['reversals'] = [];
    const attestations: ResultadoReversa['attestations'] = [];
    for (const je of asientos.rows) {
      const { reversal } = await voidJournalEntryInTx(client, je.id, userId, note);
      if (reversal) {
        reversals.push({ entryNumber: reversal.entry_number, of: je.entry_number });
        attestations.push({ entityId, entryId: reversal.id });
      }
    }

    // Las facturas reabren por lo VIVO que este cobro les tenía aplicado.
    // The withholding reopens too (MNE-001-113): the mirror took it off 1145/1146.
    // MNE-001-584: row by row, of a receipt of this entity, locked; summed per invoice here.
    const vivas = await client.query<{ id: string; invoice_id: string; total: string }>(
      `SELECT pa.id, pa.invoice_id,
              (pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)::text AS total
         FROM payment_allocations pa
        WHERE pa.payment_id = (SELECT id FROM customer_payments WHERE id = $1 AND entity_id = $2)
          AND pa.unapplied_at IS NULL
        ORDER BY pa.invoice_id, pa.id
          FOR UPDATE`,
      [paymentId, entityId]
    );
    const byInvoice = new Map<string, Decimal>();
    for (const r of vivas.rows) {
      byInvoice.set(r.invoice_id, (byInvoice.get(r.invoice_id) ?? new Decimal(0)).plus(r.total));
    }
    const documentosReabiertos: DocumentoAplicado[] = [];
    for (const [invoiceId, sum] of byInvoice) {
      const fila = { invoice_id: invoiceId, total: sum.toFixed(4) };
      const inv = await client.query<{
        id: string; invoice_number: string; amount_due: string; amount_paid: string; currency_code: string;
      }>(
        `SELECT id, invoice_number, amount_due, amount_paid, currency_code
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [fila.invoice_id, entityId]
      );
      if (inv.rows.length === 0) continue;
      const factura = inv.rows[0];
      // MNE-001-580 · invariant 3, as the unapply path's reopening.
      const reopened = await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid - $1,
           amount_due  = amount_due + $1,
           status = CASE WHEN amount_paid - $1 <= 0 THEN 'sent' ELSE 'partially_paid' END
         WHERE id = $2 AND entity_id = $3 AND amount_paid >= $1`,
        [fila.total, fila.invoice_id, entityId]
      );
      if (reopened.rowCount !== 1) {
        throw new AccountingError('INVOICE_CHANGED', {
          key: 'error.INVOICE_CHANGED', params: { invoice: factura.invoice_number },
        });
      }
      documentosReabiertos.push({
        id: factura.id, numero: factura.invoice_number,
        saldoAnterior: new Decimal(factura.amount_due).toFixed(2),
        saldoNuevo: new Decimal(factura.amount_due).plus(fila.total).toFixed(2),
        estado: new Decimal(factura.amount_paid).minus(fila.total).lessThanOrEqualTo(0) ? 'sent' : 'partially_paid',
        moneda: factura.currency_code,
      });
    }
    // Invariant 3: the live rows read above, of a receipt of this entity, and
    // every one of them; a miss refuses the whole reversal (MNE-001-584).
    const closed = await client.query(
      `UPDATE payment_allocations
          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2
        WHERE id = ANY($3::uuid[]) AND unapplied_at IS NULL
          AND payment_id = (SELECT id FROM customer_payments WHERE id = $4 AND entity_id = $5)`,
      [userId, note, vivas.rows.map((r) => r.id), paymentId, entityId]
    );
    if (closed.rowCount !== vivas.rows.length) {
      throw new AccountingError('REVERSE_RACE', `${pago.payment_number} changed while it was being reversed; nothing was written.`);
    }
    if (kept.amount.greaterThan('0.005')) {
      const correction = await postReceiptReversalVatEntry(
        client, { id: paymentId, entity_id: entityId, payment_number: pago.payment_number },
        kept.amount.toFixed(4), kept.notes, userId
      );
      attestations.push({ entityId, entryId: correction.id });
    }

    // The write that carries the cause: entity, state and one row, or nothing (invariant 3).
    const written = await client.query(
      `UPDATE customer_payments SET status = 'reversed', reversed_at = NOW(),
              reversal_cause = $3::varchar,
              reversal_cause_stated_at = CASE WHEN $3::varchar IS NULL THEN NULL ELSE NOW() END
        WHERE id = $1 AND entity_id = $2 AND status = '${ESTADO}'`,
      [paymentId, entityId, cause]
    );
    if (written.rowCount !== 1) {
      throw new AccountingError('REVERSE_RACE', `${pago.payment_number} changed while it was being reversed; nothing was written.`);
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      oldValues: { status: ESTADO },
      newValues: {
        evento: 'reverse',
        status: 'reversed',
        reversal_cause: cause,
        asientos_reversados: reversals.length,
        facturas_reabiertas: documentosReabiertos.length,
      },
      reason: args.reason,
    });

    const salida: ResultadoReversa = {
      paymentId, paymentNumber: pago.payment_number, reversals, attestations, documentosReabiertos,
      cause, causeDefaulted, warnings,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

export interface StatedReversalCause {
  paymentId: string;
  paymentNumber: string;
  cause: ReversalCause;
  /** The instant of the statement; later than `reversedAt`, which is how a reader tells a later statement. */
  statedAt: Date;
  reversedAt: Date | null;
  /** Keys of what the accountant should read before confirming; the dry run returns the same. */
  warnings: TranslationKey[];
}

/**
 * MNE-001-511: states afterwards the cause of a receipt that was reversed
 * with none. The cause is written once, with the instant of the statement,
 * and audited with its reason; nothing posts, and what the reversal already
 * wrote (its mirrors, its closed allocations, `reversed_at`) is left as it
 * is. A receipt that is not reversed, or that already has a cause, is
 * refused: a stated cause is never overwritten.
 */
export async function stateReversalCause(
  entityId: string,
  paymentId: string,
  args: { cause: string; reason: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<StatedReversalCause> {
  if (!(REVERSAL_CAUSES as readonly string[]).includes(args.cause)) {
    throw new ValidationError({ key: 'receipt.reverse.cause_unknown', params: { value: args.cause } });
  }
  const cause = args.cause as ReversalCause;

  const run = async (client: pg.PoolClient): Promise<StatedReversalCause> => {
    // Its own locked read: `cobroParaEscribir` refuses every receipt that is not 'completed'.
    const found = await client.query<{
      payment_number: string; status: string; payment_method: string;
      reversed_at: Date | null; reversal_cause: string | null; reversal_cause_stated_at: Date | null;
    }>(
      `SELECT payment_number, status, payment_method, reversed_at, reversal_cause, reversal_cause_stated_at
         FROM customer_payments WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [paymentId, entityId]
    );
    if (found.rows.length === 0) throw new NotFoundError('Customer payment', paymentId);
    const row = found.rows[0];
    if (row.status !== 'reversed') {
      throw new ValidationError({
        key: 'receipt.cause.not_reversed', params: { number: row.payment_number, status: row.status },
      });
    }
    if (row.reversal_cause !== null) {
      throw new ValidationError({
        key: 'receipt.cause.already_stated',
        params: {
          number: row.payment_number, cause: row.reversal_cause,
          stated_at: row.reversal_cause_stated_at?.toISOString() ?? '',
        },
      });
    }
    const warnings: TranslationKey[] = [];
    // A card is paid when it is accepted (LIVA art. 1-B), not when it settles.
    if (cause === 'not_collected' && ['credit_card', 'debit_card'].includes(row.payment_method)) {
      warnings.push('receipt.reverse.warning.card_not_collected');
    }

    // Entity, state, no cause yet, and one row, or nothing (invariant 3).
    const written = await client.query<{ reversal_cause_stated_at: Date }>(
      `UPDATE customer_payments SET reversal_cause = $3, reversal_cause_stated_at = NOW()
        WHERE id = $1 AND entity_id = $2 AND status = 'reversed' AND reversal_cause IS NULL
        RETURNING reversal_cause_stated_at`,
      [paymentId, entityId, cause]
    );
    if (written.rowCount !== 1) {
      throw new AccountingError('REVERSAL_CAUSE_RACE', `${row.payment_number} changed while its cause was being stated; nothing was written.`);
    }
    const statedAt = written.rows[0].reversal_cause_stated_at;

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      oldValues: { reversal_cause: null },
      newValues: {
        evento: 'state_reversal_cause',
        reversal_cause: cause,
        reversal_cause_stated_at: statedAt,
        reversed_at: row.reversed_at,
      },
      reason: args.reason,
    });

    const result: StatedReversalCause = {
      paymentId, paymentNumber: row.payment_number, cause, statedAt, reversedAt: row.reversed_at, warnings,
    };
    if (opts.dryRun) throw new EnsayoEvento(result);
    return result;
  };

  return ejecutarEvento(run, opts);
}

// ============================================================
// MNE-001-498 · A CUSTOMER'S CASH ON ACCOUNT, TRANSFERRED TO ANOTHER
//
// The entity owes A the cash A left on account; A assigns that credit to B
// (CCF art. 2029) and the entity's recorded agreement stands for the notice
// (art. 2038). B gets a credit row of its own, linked to A's receipt, and the
// transfer posts its own entry on the agreed day (RCFF art. 33 B fr. I).
// Nothing is collected, returned or caused: B's IVA is caused when the credit
// settles B's invoice, which is part 2 (MNE-001-499), so part 1 moves only
// cash on account that carries no advance treatment.
// ============================================================

export interface CustomerCreditTransferArgs {
  /** The receiving customer, B, by id. */
  customerId: string;
  amount: string;
  /** The agreed day (YYYY-MM-DD); default today in the entity's zone. */
  date?: string;
  /** The agreement: required, and the reason of the audit row. */
  reason: string;
}

export interface CustomerCreditTransfer {
  transferId: string;
  transferNumber: string;
  sourceId: string;
  sourceNumber: string;
  /** Each customer as «number name». */
  fromCustomer: string;
  toCustomer: string;
  amount: string;
  date: string;
  journalEntry: JournalEntry;
  attestation: { entityId: string; entryId: string };
  /** The entry's lines, by account code: what the dry run shows. */
  lines: { account: string; debit: string; credit: string; description: string }[];
  /** The source receipt's cash on account, before and after. */
  sourceOnAccount: { before: string; after: string };
  /** B's cash on account across its receipts, before and after. */
  customerOnAccount: { before: string; after: string };
}

/**
 * Transfers `args.amount` of the receipt `sourceId`'s cash on account to the
 * customer `args.customerId`. Everything is refused, by its key, before any
 * write; the dry run walks the real path and rolls back, leaving no row,
 * entry, audit row or number behind.
 */
export async function transferCustomerCredit(
  entityId: string,
  sourceId: string,
  args: CustomerCreditTransferArgs,
  userId: string,
  opts: OpcionesPago = {}
): Promise<CustomerCreditTransfer> {
  const reason = args.reason.trim();
  if (reason === '') throw new ValidationError({ key: 'receipt.transfer.reason_required' }, 'reason');
  const amount = (args.amount ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(amount) || !new Decimal(amount).greaterThan(0)) {
    throw new ValidationError({ key: 'receipt.transfer.amount_invalid', params: { amount } }, 'amount');
  }

  const run = async (client: pg.PoolClient): Promise<CustomerCreditTransfer> => {
    if (!(await entityUsesCashBasisIva(client, entityId))) {
      throw new ValidationError({ key: 'receipt.transfer.not_mexican_books' });
    }
    // Keyed here, before the locked read refuses it in prose.
    const state = await client.query<{ payment_number: string; status: string }>(
      'SELECT payment_number, status FROM customer_payments WHERE id = $1 AND entity_id = $2',
      [sourceId, entityId]
    );
    if (state.rows[0] && state.rows[0].status !== ESTADO) {
      const params = { receipt: state.rows[0].payment_number, status: state.rows[0].status };
      throw new ValidationError({ key: 'receipt.transfer.not_completed', params });
    }
    const source = await cobroParaEscribir(client, entityId, sourceId);
    const receipt = source.payment_number;
    const functional = await functionalCurrencyOf(client, entityId);
    if (source.currency_code.trim() !== functional) {
      const params = { receipt, currency: source.currency_code.trim(), functional };
      throw new ValidationError({ key: 'receipt.transfer.not_functional_currency', params });
    }
    if (source.payment_method === BALANCE_TRANSFER_METHOD) {
      throw new ValidationError({ key: 'receipt.transfer.source_is_transfer', params: { receipt } });
    }
    if (source.advance_base_amount !== null || source.advance_factor_type !== null) {
      throw new ValidationError({ key: 'receipt.transfer.advance_in_499', params: { receipt } });
    }
    if (source.payment_method === 'check' && source.check_cashed_tx_id === null) {
      throw new ValidationError({ key: 'receipt.transfer.cheque_not_cashed', params: { receipt } });
    }
    const target = await client.query<{ id: string }>(
      'SELECT id FROM customers WHERE id = $1 AND entity_id = $2 FOR SHARE',
      [args.customerId, entityId]
    );
    if (target.rows.length === 0) throw new NotFoundError('Customer', args.customerId);
    const [fromCustomer, toCustomer] = await partyLabels(client, entityId, 'customer', [source.customer_id, args.customerId]);
    if (args.customerId === source.customer_id) {
      throw new ValidationError({ key: 'receipt.transfer.same_customer', params: { receipt, customer: fromCustomer } });
    }
    const left = await remanenteDe(client, entityId, sourceId);
    if (new Decimal(amount).greaterThan(left)) {
      const params = { receipt, amount: new Decimal(amount).toFixed(2), onAccount: left.toFixed(2) };
      throw new ValidationError({ key: 'receipt.transfer.exceeds_on_account', params }, 'amount');
    }
    // MNE-001-574 · cash an unapply put back on account keeping its IVA caused
    // is an advance with its IVA caused as well (`keptOnAccount`): moving it
    // splits base and IVA, which is part 2's (MNE-001-499).
    const kept = await advanceLeft(client, entityId, source, left);
    if (kept !== null && new Decimal(kept.total).minus(kept.consumed).greaterThan(0)) {
      throw new ValidationError({ key: 'receipt.transfer.advance_in_499', params: { receipt } });
    }
    const date = await receiptEventDate(client, entityId, source, args.date, 'transfer');
    const held = await client.query<{ left: string }>(
      `SELECT COALESCE(SUM(${cashOnAccountSql('cp')}), 0)::text AS left
         FROM customer_payments cp WHERE cp.entity_id = $1 AND cp.customer_id = $2 AND cp.status = '${ESTADO}'`,
      [entityId, args.customerId]
    );
    const before = new Decimal(held.rows[0]?.left ?? '0');

    const transferNumber = await nextEntityNumber(client, entityId, 'customer_balance_transfer', 'TRF', date);
    const transferId = uuidv4();
    await client.query(
      `INSERT INTO customer_payments (
         id, entity_id, payment_number, customer_id, payment_amount, currency_code, exchange_rate,
         payment_method, bank_account_id, payment_date, status, created_by, memo,
         transferred_from_payment_id, transfer_reason
       ) VALUES ($1, $2, $3, $4, $5, $6, '1.0', $7, NULL, $8, $9, $10, $11, $12, $13)`,
      [transferId, entityId, transferNumber, args.customerId, amount, source.currency_code.trim(),
       BALANCE_TRANSFER_METHOD, date, ESTADO, userId,
       `Credit of ${fromCustomer} on ${receipt}, transferred to ${toCustomer}`, sourceId, reason]
    );
    const entry = await postCustomerCreditTransferEntry(
      client,
      {
        id: transferId, entity_id: entityId, transfer_number: transferNumber, source_number: receipt,
        from_customer: fromCustomer, to_customer: toCustomer, amount, date,
      },
      userId
    );
    const lines = await client.query<{ account: string; debit: string; credit: string; description: string }>(
      `SELECT a.code AS account, COALESCE(l.debit_amount, 0)::text AS debit, COALESCE(l.credit_amount, 0)::text AS credit,
              COALESCE(l.description, '') AS description
         FROM journal_entry_lines l
         JOIN journal_entries je ON je.id = l.journal_entry_id AND je.entity_id = $2
         JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
      [entry.id, entityId]
    );
    const shown = new Decimal(amount).toFixed(2);

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'create',
      entityType: 'customer_payments',
      entityId: transferId,
      newValues: {
        evento: 'transfer',
        transfer_number: transferNumber,
        source_number: receipt,
        source_id: sourceId,
        from_customer: fromCustomer,
        to_customer: toCustomer,
        amount: shown,
        date,
        journal_entry_id: entry.id,
      },
      reason,
    });

    const result: CustomerCreditTransfer = {
      transferId, transferNumber, sourceId, sourceNumber: receipt, fromCustomer, toCustomer,
      amount: shown, date, journalEntry: entry, attestation: { entityId, entryId: entry.id },
      lines: lines.rows.map((l) => ({
        account: l.account, debit: new Decimal(l.debit).toFixed(2), credit: new Decimal(l.credit).toFixed(2),
        description: l.description,
      })),
      sourceOnAccount: { before: left.toFixed(2), after: left.minus(amount).toFixed(2) },
      customerOnAccount: { before: before.toFixed(2), after: before.plus(amount).toFixed(2) },
    };
    if (opts.dryRun) throw new EnsayoEvento(result);
    return result;
  };

  return ejecutarEvento(run, opts);
}

// ============================================================
// APLICAR UN PAGO YA HECHO (050 · F04)
//
// El espejo de `applyCustomerPayment`, y la fila del catálogo que decía
// «Aplica un pago existente a facturas concretas, con parcial, residual o
// pago corto documentado». Hasta hoy el único momento en que un pago podía
// tocar un gasto era el de registrarlo: si el dinero salía antes de saber a
// qué gasto iba —una transferencia global a un proveedor con seis facturas
// abiertas, lo normal en una tesorería real— no había forma de repartirlo
// después. El remanente vivía como anticipo a proveedores y ahí se quedaba.
//
// LO QUE SE MUEVE Y LO QUE NO. El efectivo NO se toca: ya salió del banco
// cuando se registró el pago, y volver a acreditar el banco lo contaría dos
// veces. Lo que se mueve es el DERECHO: del anticipo (1150) a la cuenta de
// control de proveedores (2110), más el IVA acreditable que cada gasto PPD
// libera por la parte que este evento paga.
// ============================================================

interface PagoProveedorVivo {
  id: string;
  payment_number: string;
  vendor_id: string;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  status: string;
  payment_method: string;
  check_cleared_tx_id: string | null;
}

/** El pago, acotado por entidad y con candado. */
async function pagoProveedorParaEscribir(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<PagoProveedorVivo> {
  const r = await client.query<PagoProveedorVivo>(
    `SELECT id, payment_number, vendor_id, payment_amount, currency_code,
            payment_date, bank_account_id, journal_entry_id, status,
            payment_method, check_cleared_tx_id
       FROM vendor_payments WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [paymentId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Vendor payment', paymentId);
  const pago = r.rows[0];
  if (pago.status !== ESTADO) {
    throw new ValidationError(
      `El pago ${pago.payment_number} está en '${pago.status}': sólo un pago 'completed' admite este evento.`
    );
  }
  return pago;
}

/**
 * What is left of the payment to apply. Live applications only (105): an
 * unapplied row gave its cash back on account. The same filter lives in
 * postVendorPaymentEntry, or the remainder and the entry would stop talking
 * about the same payment.
 */
async function remanenteDeVendorPago(
  client: pg.PoolClient,
  paymentId: string,
  paymentAmount: string
): Promise<Decimal> {
  const r = await client.query<{ aplicado: string }>(
    `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
       FROM payment_applications WHERE payment_id = $1 AND unapplied_at IS NULL`,
    [paymentId]
  );
  return new Decimal(paymentAmount).minus(r.rows[0]?.aplicado ?? '0');
}

export interface OpcionesAplicacionProveedor extends OpcionesPago {
  /**
   * `partial` (omisión): se aplica de menos y el gasto SIGUE ABIERTO por la
   * diferencia. `residual`: el gasto se cierra aunque se pague de menos, y lo
   * que queda deja de deberse — un pago corto.
   */
  modo?: 'partial' | 'residual';
  /** Obligatorio con `residual`: por qué se renuncia a cobrar el resto. */
  shortPayReason?: string;
}

export interface ResultadoAplicacionProveedor extends ResultadoAplicacion {
  /** Saldo que dejó de deberse por pago corto, y a qué cuenta fue. */
  condonado: string;
  cuentaCondonacion: 'devolucion_compras' | 'otros_ingresos' | null;
  /** IVA que salió de 1135 sin llegar a acreditarse. Cero salvo PPD condonado. */
  ivaNoAcreditable: string;
  politicaDefinida: boolean;
  /**
   * Gastos en los que se tomó un descuento que sus CONDICIONES no otorgaban
   * —sin términos de pronto pago, o fuera de la ventana—. No es un error: un
   * proveedor concede deducciones fuera de contrato todos los días. Pero es
   * otra cosa que un `2/10 net 30` ejercido en plazo, y quien firma los libros
   * merece saber cuál de las dos está viendo.
   */
  descuentosFueraDeTerminos: string[];
}

/** Aplicar el saldo a cuenta de un pago existente a uno o varios gastos. */
export async function applyVendorPayment(
  entityId: string,
  paymentId: string,
  aplicaciones: AplicacionPago[],
  userId: string,
  opts: OpcionesAplicacionProveedor = {}
): Promise<ResultadoAplicacionProveedor> {
  if (aplicaciones.length === 0) {
    throw new ValidationError('Indica a qué gasto(s) se aplica el saldo a cuenta.');
  }
  const vistos = new Set<string>();
  for (const a of aplicaciones) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en la misma aplicación: súmalas en una.`
      );
    }
    vistos.add(a.documentId);
  }

  const residual = opts.modo === 'residual';
  if (residual && !opts.shortPayReason?.trim()) {
    throw new ValidationError(
      'Cerrar un gasto pagando de menos borra un pasivo que sí se debía: di por qué ' +
        'con --short-pay-reason. Sin motivo escrito, el auditor sólo ve un saldo que ' +
        'desapareció.'
    );
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoAplicacionProveedor> => {
    const pago = await pagoProveedorParaEscribir(client, entityId, paymentId);
    const remanente = await remanenteDeVendorPago(client, paymentId, pago.payment_amount);

    // LA CUENTA DEL PAGO CORTO NO LA ELIGE ESTE CÓDIGO. A dónde va el saldo
    // que deja de deberse es criterio del despacho —menos costo, u otro
    // ingreso— y hasta puede estar prohibido. Se lee del panel; mientras
    // nadie lo defina, rige el defecto declarado y se dice que es el defecto.
    const tenantId = await tenantDe(client, entityId);
    const politica = residual
      ? await getPolicy({ tenantId, entityId }, 'pago_corto_residual')
      : null;
    if (politica?.value === 'prohibir') {
      throw new ValidationError(
        'La política `pago_corto_residual` de este despacho está en "prohibir": ningún gasto ' +
          'se cierra pagando de menos. Pide al proveedor la nota de crédito y aplícala, o ' +
          `cambia la política con ${changePolicyHint('pago_corto_residual')}.`
      );
    }
    const cuentaCondonacion =
      politica === null
        ? null
        : politica.value === 'otros_ingresos'
          ? ('otros_ingresos' as const)
          : ('devolucion_compras' as const);
    // Sólo el EFECTIVO consume remanente. El descuento extingue pasivo sin
    // salir del banco, así que un pago de 980 puede saldar un gasto de 1000
    // con 20 de descuento: lo que no puede es repartir 1000 de efectivo.
    const total = aplicaciones.reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
    if (total.greaterThan(remanente)) {
      throw new ValidationError(
        `El pago ${pago.payment_number} tiene ${remanente.toFixed(2)} sin aplicar y se intentan ` +
          `aplicar ${total.toFixed(2)}: el saldo a cuenta no alcanza.`
      );
    }

    const documentos: DocumentoAplicado[] = [];
    const posteriores: AplicacionPosterior[] = [];
    const filas: { allocId: string; billId: string }[] = [];
    let condonadoTotal = new Decimal(0);
    const fueraDeTerminos: string[] = [];

    for (const app of aplicaciones) {
      const r = await client.query<{
        id: string; bill_number: string; vendor_id: string; amount_due: string; status: string;
        currency_code: string; tax_amount: string; total_amount: string;
        cfdi_uuid: string | null; terms: string | null; memo: string | null;
        bill_date: Date;
      }>(
        `SELECT id, bill_number, vendor_id, amount_due, status, currency_code,
                tax_amount, total_amount, cfdi_uuid, terms, memo, bill_date
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Bill', app.documentId);
      const bill = r.rows[0];
      // NOTE: the party speaks first, before status, currency and the discount
      // (#664): the VAT of another vendor's bill is not paid with this cash
      // (LIVA art. 5o. fr. III), and the DIOT reports by vendor.
      if (bill.vendor_id !== pago.vendor_id) {
        const [billVendor, paymentVendor] = await partyLabels(
          client, entityId, 'vendor', [bill.vendor_id, pago.vendor_id]
        );
        throw new ValidationError({
          key: 'payment.apply.other_vendor',
          params: { bill: bill.bill_number, billVendor, payment: pago.payment_number, paymentVendor },
        });
      }
      if (!PAGABLES.includes(bill.status as (typeof PAGABLES)[number])) {
        throw new ValidationError(
          `${bill.bill_number} está en "${bill.status}" y sólo se puede aplicar a un gasto ` +
            `${PAGABLES.join(', ')}.`
        );
      }
      assertMoneda(bill.bill_number, bill.currency_code, pago.currency_code);

      const aplicado = new Decimal(app.amountApplied);
      const descuento = new Decimal(app.discountAmount ?? '0');
      const extingue = aplicado.plus(descuento);
      const saldo = new Decimal(bill.amount_due);
      if (extingue.greaterThan(saldo)) {
        throw new ValidationError(
          `${bill.bill_number} debe ${saldo.toFixed(2)} y se intentan extinguir ${extingue.toFixed(2)} ` +
            `(${aplicado.toFixed(2)} de efectivo + ${descuento.toFixed(2)} de descuento).`
        );
      }
      // ── EL DESCUENTO, CONTRA LO QUE LAS CONDICIONES OTORGAN ──────────
      //
      // `earlyPaymentDiscount` sabe leer un `2/10 net 30` y decir cuánto da
      // derecho a descontar quien paga en tal fecha. Llevaba desde que se
      // retiró el programador de pagos sin un solo llamador —la deuda que el
      // plan mandaba «cablear o retirar»— mientras el descuento se aceptaba
      // a ojo. Aquí es donde vuelve a servir: tomar MÁS de lo que las
      // condiciones conceden no es un descuento, es pagar de menos, y para
      // eso está `--mode residual`, que exige motivo escrito.
      if (descuento.greaterThan(0)) {
        const derecho = earlyPaymentDiscount(
          { amount_due: bill.amount_due, bill_date: bill.bill_date, terms: bill.terms },
          // #241 · El día del pago se LEE, no se reinterpreta: `payment_date` es
          // DATE y pg lo entrega a medianoche local. Este día decide si el
          // descuento por pronto pago sigue vigente.
          toCalendarDate(pago.payment_date)
        );
        if (derecho.applied && descuento.greaterThan(derecho.discountAmount)) {
          throw new ValidationError(
            `${bill.bill_number} concede ${new Decimal(derecho.discountAmount).toFixed(2)} de ` +
              `descuento por pronto pago ("${bill.terms}") y se están tomando ` +
              `${descuento.toFixed(2)}. La diferencia no es descuento: es pagar de menos. ` +
              'Si es deliberado, dilo con --mode residual --short-pay-reason.'
          );
        }
        // Sin condiciones de pronto pago, o fuera de la ventana, el descuento
        // es una deducción NEGOCIADA. Se admite y se reporta como tal.
        if (!derecho.applied) fueraDeTerminos.push(bill.bill_number);
      }

      // Lo que sobra tras el efectivo y el descuento. En modo `residual` deja
      // de deberse aquí mismo; en `partial` sigue vivo y el gasto queda abierto.
      const condonado = residual ? saldo.minus(extingue) : new Decimal(0);
      const baja = extingue.plus(condonado);
      condonadoTotal = condonadoTotal.plus(condonado);

      // Lo aplicado al gasto ANTES de este evento: la base del objetivo
      // acumulado del IVA, para que las parciales no deriven.
      const prev = await client.query<{ aplicado: string }>(
        `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
           FROM payment_applications WHERE bill_id = $1 AND unapplied_at IS NULL`,
        [app.documentId]
      );

      const allocId = uuidv4();
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [allocId, paymentId, app.documentId, app.amountApplied, descuento.toFixed(4)]
      );
      // amount_paid recibe SÓLO el efectivo; el saldo baja por los tres —
      // efectivo, descuento y condonación. Un descuento no es dinero cobrado
      // y una condonación menos aún: contarlos como pagados inflaría lo que
      // el proveedor recibió y descuadraría la conciliación de banco.
      // MNE-001-532 · invariant 3, as the invoice twin of applyCustomerPayment.
      const settled = await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $2,
           status = CASE WHEN amount_due - $2 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = GREATEST(last_payment_date, $3::date)
         WHERE id = $4 AND entity_id = $5 AND status = ANY($6::text[]) AND amount_due >= $2`,
        [app.amountApplied, baja.toFixed(4), new Date(), app.documentId, entityId, [...PAGABLES]]
      );
      if (settled.rowCount !== 1) {
        throw new AccountingError('BILL_CHANGED', { key: 'error.BILL_CHANGED', params: { bill: bill.bill_number } });
      }

      const nuevo = saldo.minus(baja);
      documentos.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: bill.currency_code,
      });
      posteriores.push({
        invoiceId: bill.id,
        invoiceNumber: bill.bill_number,
        amount: aplicado.toFixed(4),
        discount: descuento.toFixed(4),
        closes: nuevo.lessThanOrEqualTo(0),
        writeOff: condonado.toFixed(4),
        priorApplied: prev.rows[0]?.aplicado ?? '0',
        taxAmount: bill.tax_amount,
        totalAmount: bill.total_amount,
        cfdiUuid: bill.cfdi_uuid,
        terms: bill.terms,
        memo: bill.memo,
      });
      filas.push({ allocId, billId: bill.id });
    }

    const { entry, ivaPorGasto, ivaNoAcreditablePorGasto, discountVatByBill } = await postVendorApplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
        // MNE-001-508: a cheque not cashed yet credits no IVA; its cashing does.
        holdsIvaUntilCashed:
          pago.payment_method === 'check' && pago.check_cleared_tx_id === null &&
          pago.currency_code === (await functionalCurrencyOf(client, entityId)),
      },
      posteriores,
      userId,
      cuentaCondonacion ?? undefined
    );
    // 0 included (105, and 341 for the discount's VAT): NULL is left to rows
    // written before anyone stored it.
    for (const fila of filas) {
      await client.query(
        `UPDATE payment_applications SET iva_reclass_amount = $1, discount_iva_amount = $2 WHERE id = $3`,
        [ivaPorGasto.get(fila.billId) ?? '0', discountVatByBill.get(fila.billId) ?? '0', fila.allocId]
      );
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'vendor_payments',
      entityId: paymentId,
      newValues: {
        evento: 'apply',
        aplicado: total.toFixed(2),
        documentos: documentos.length,
        journal_entry_id: entry.id,
        // El pago corto se anota en la bitácora CON SU MOTIVO: es la única
        // huella de por qué un pasivo dejó de existir sin haberse pagado.
        ...(condonadoTotal.greaterThan(0)
          ? {
              condonado: condonadoTotal.toFixed(2),
              cuenta_condonacion: cuentaCondonacion,
              short_pay_reason: opts.shortPayReason,
              politica_definida: politica?.defined ?? false,
            }
          : {}),
      },
    });

    const salida: ResultadoAplicacionProveedor = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documentos,
      remanenteAnterior: remanente.toFixed(2),
      remanenteNuevo: remanente.minus(total).toFixed(2),
      condonado: condonadoTotal.toFixed(2),
      cuentaCondonacion: condonadoTotal.greaterThan(0) ? cuentaCondonacion : null,
      ivaNoAcreditable: [...ivaNoAcreditablePorGasto.values()]
        .reduce((s2, v) => s2.plus(v), new Decimal(0))
        .toFixed(2),
      politicaDefinida: politica?.defined ?? false,
      descuentosFueraDeTerminos: fueraDeTerminos,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

/**
 * An undo cannot be dated before the payment's last posted event: the ledger
 * would undo it before it happened. A cheque's cashing entry
 * (`bank_check_clearing`, MNE-001-508) is one of those events.
 */
async function assertAfterLastEvent(
  client: pg.PoolClient,
  entityId: string,
  vp: PagoProveedorVivo,
  date: string,
  what: string
): Promise<void> {
  const last = await client.query<{ d: string | null }>(
    `SELECT to_char(MAX(entry_date), 'YYYY-MM-DD') AS d FROM journal_entries
      WHERE entity_id = $1 AND source_id = $2 AND status = 'posted'
        AND source_type IN ('vendor_payment', 'vendor_application', 'vendor_unapplication', 'bank_check_clearing')`,
    [entityId, vp.id]
  );
  const since = last.rows[0]?.d ?? toCalendarDate(vp.payment_date);
  if (date < since) {
    throw new ValidationError(
      `${vp.payment_number} was last posted on ${since}: ${what} dated ${date} would undo it before it happened.`,
      'date'
    );
  }
}

/**
 * What the bill's live applications and its received credit notes explain.
 * Anything else that stopped being owed was written off by a short pay, and no
 * row says how much of it which payment carried, its account or its IVA: an
 * undo would have to guess.
 *
 * MNE-001-582 (#814): a received credit note lowers `amount_due` and not
 * `amount_paid` (`postReceivedCreditNote`), so its payable debit is explained
 * too: the note's posted, unreversed entry, whose source is the bill. Without
 * it, every bill with a note read as closed short and its payments could not
 * be unapplied or reversed, a bounced transfer included.
 *
 * The VAT over-credit census reads it too (MNE-001-562).
 */
export async function writtenOffOf(
  client: pg.PoolClient,
  entityId: string,
  bill: { id: string; total_amount: string; amount_due: string }
): Promise<Decimal> {
  const explained = await client.query<{ s: string }>(
    `SELECT (COALESCE((SELECT SUM(pa.amount_applied + COALESCE(pa.discount_amount, 0))
                         FROM payment_applications pa
                         JOIN bills b ON b.id = pa.bill_id AND b.entity_id = $2
                        WHERE pa.bill_id = $1 AND pa.unapplied_at IS NULL), 0)
           + COALESCE((SELECT SUM(l.debit_amount)
                         FROM journal_entries je
                         JOIN journal_entry_lines l ON l.journal_entry_id = je.id
                         JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = $2
                                              AND ar.role = 'cxp' AND ar.qualifier IS NULL
                        WHERE je.entity_id = $2 AND je.source_type = $3 AND je.source_id = $1
                          AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL), 0))::text AS s`,
    [bill.id, entityId, VENDOR_CREDIT_NOTE_SOURCE]
  );
  return new Decimal(bill.total_amount).minus(explained.rows[0].s).minus(bill.amount_due);
}

async function assertNotClosedShort(
  client: pg.PoolClient,
  entityId: string,
  bill: { id: string; bill_number: string; total_amount: string; amount_due: string },
  what: string
): Promise<void> {
  const writtenOff = await writtenOffOf(client, entityId, bill);
  if (writtenOff.abs().greaterThanOrEqualTo('0.01')) {
    throw new ValidationError(
      `${bill.bill_number} was closed short (${writtenOff.toFixed(2)} written off): the write-off, its ` +
        `account and its IVA are stored nowhere, so ${what} cannot give them back exactly.`
    );
  }
}

export interface VendorUnapplyResult {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry;
  attestation: { entityId: string; entryId: string };
  document: DocumentoAplicado;
  unapplied: string;
  discountReturned: string;
  ivaReparked: string;
  date: string;
  remainingOnAccount: string;
}

/**
 * Unapply a vendor payment from one bill, as a NEW dated event (#98 ·
 * MNE-001-037): the live applications are CLOSED (never deleted), the bill is
 * owed again, the cash goes back on account and the discount and IVA they
 * took are given back from what their rows stored.
 *
 * `date` (default today) dates both the closure and the entry, so a balance
 * read "as of" that day sees the two sides move together. It cannot precede
 * the payment's last posted event: the ledger would undo an application
 * before it happened.
 *
 * It refuses what it cannot undo exactly, rather than guess:
 *   - a bill closed short (`--mode residual`): the written-off balance, its
 *     account and its IVA are stored in no row, so nothing can give them back;
 *   - a payment in another currency: the rows are in document currency and
 *     the rates of each leg are not on them;
 *   - a pre-105 row of a cash-basis entity: it never recorded the IVA it
 *     released.
 */
export async function unapplyVendorPayment(
  entityId: string,
  paymentId: string,
  args: { billId: string; reason: string; date?: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<VendorUnapplyResult> {
  const reason = args.reason.trim();
  if (!reason) throw new ValidationError('Say why the application is undone: the reason goes to the audit trail.');
  const today = toCalendarDate(new Date());
  const date = args.date === undefined ? today : toCalendarDate(args.date);
  if (date > today) throw new ValidationError(`An unapply cannot be dated in the future (${date}).`, 'date');

  const run = async (client: pg.PoolClient): Promise<VendorUnapplyResult> => {
    const vp = await pagoProveedorParaEscribir(client, entityId, paymentId);
    if (vp.currency_code !== (await functionalCurrencyOf(client, entityId))) {
      throw new ValidationError(
        `${vp.payment_number} is in ${vp.currency_code}: unapplying a foreign-currency payment ` +
          'needs the rate of each leg, which its applications do not store.'
      );
    }
    await assertAfterLastEvent(client, entityId, vp, date, 'an unapply');

    const b = await client.query<{
      id: string; bill_number: string; amount_due: string; total_amount: string; currency_code: string;
    }>(
      `SELECT id, bill_number, amount_due::text, total_amount::text, currency_code
         FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [args.billId, entityId]
    );
    if (b.rows.length === 0) throw new NotFoundError('Bill', args.billId);
    const bill = b.rows[0];

    const live = await client.query<{
      id: string; amount_applied: string; discount_amount: string; iva_reclass_amount: string | null;
      discount_iva_amount: string;
    }>(
      `SELECT id, amount_applied::text, COALESCE(discount_amount, 0)::text AS discount_amount,
              iva_reclass_amount::text, COALESCE(discount_iva_amount, 0)::text AS discount_iva_amount
         FROM payment_applications
        WHERE payment_id = $1 AND bill_id = $2 AND unapplied_at IS NULL
        FOR UPDATE`,
      [paymentId, args.billId]
    );
    if (live.rows.length === 0) {
      throw new ValidationError(
        `${vp.payment_number} has no live application on ${bill.bill_number}: there is nothing to unapply.`
      );
    }

    await assertNotClosedShort(client, entityId, bill, 'an unapply');
    if (live.rows.some((r) => r.iva_reclass_amount === null) && (await entityUsesCashBasisIva(client, entityId))) {
      throw new ValidationError(
        `The application of ${vp.payment_number} on ${bill.bill_number} predates migration 105 and did ` +
          'not record the IVA it released: re-parking it would be a guess.'
      );
    }

    const amount = live.rows.reduce((s, r) => s.plus(r.amount_applied), new Decimal(0));
    const discount = live.rows.reduce((s, r) => s.plus(r.discount_amount), new Decimal(0));
    // NOTE: MNE-001-582 (#814). The whole stored release goes back, with no
    // cap like the issued side's (MNE-001-581): a received note never exceeds
    // what the bill owes (`refusalOf`) and takes its VAT from 1135 first, so
    // this re-park leaves 1135 at the VAT of the balance owed again.
    const iva = live.rows.reduce((s, r) => s.plus(r.iva_reclass_amount ?? '0'), new Decimal(0));
    // MNE-001-597: the discount's VAT that left 1135 goes back to it; a row
    // written before 341 stores NULL, read as 0, because its VAT never left.
    const discountIva = live.rows.reduce((s, r) => s.plus(r.discount_iva_amount), new Decimal(0));
    const ids = live.rows.map((r) => r.id);
    const reopened = amount.plus(discount);

    // Invariant 3: the entity scope inside the same statement (MNE-001-584).
    const closed = await client.query(
      `UPDATE payment_applications
          SET unapplied_at = $1::date, unapplied_by = $2, unapply_reason = $3
        WHERE id = ANY($4::uuid[]) AND unapplied_at IS NULL
          AND payment_id = (SELECT id FROM vendor_payments WHERE id = $5 AND entity_id = $6)`,
      [date, userId, reason, ids, paymentId, entityId]
    );
    const reopen = await client.query(
      `UPDATE bills SET
         amount_paid = amount_paid - $1,
         amount_due  = amount_due + $2,
         status = CASE WHEN amount_due + $2 >= total_amount THEN 'approved' ELSE 'partially_paid' END
       WHERE id = $3 AND entity_id = $4 AND status IN ('paid', 'partially_paid')`,
      [amount.toFixed(4), reopened.toFixed(4), args.billId, entityId]
    );
    if (closed.rowCount !== ids.length || reopen.rowCount !== 1) {
      throw new AccountingError(
        'UNAPPLY_RACE',
        `${vp.payment_number} on ${bill.bill_number} changed while it was being unapplied; nothing was written.`
      );
    }

    const entry = await postVendorUnapplicationEntry(
      client,
      {
        id: vp.id, entity_id: entityId, payment_number: vp.payment_number,
        payment_amount: vp.payment_amount, payment_date: vp.payment_date,
        bank_account_id: vp.bank_account_id, journal_entry_id: null,
      },
      {
        billNumber: bill.bill_number, amount: amount.toFixed(4), discount: discount.toFixed(4),
        discountIva: discountIva.toFixed(4), iva: iva.toFixed(4), date,
      },
      userId
    );
    const remaining = await remanenteDeVendorPago(client, paymentId, vp.payment_amount);

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'vendor_payments',
      entityId: paymentId,
      newValues: {
        evento: 'unapply', bill: bill.bill_number, date,
        unapplied: amount.toFixed(2), discount: discount.toFixed(2), journal_entry_id: entry.id,
      },
      reason,
    });

    const newDue = new Decimal(bill.amount_due).plus(reopened);
    const result: VendorUnapplyResult = {
      paymentId, paymentNumber: vp.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      document: {
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: new Decimal(bill.amount_due).toFixed(2),
        saldoNuevo: newDue.toFixed(2),
        estado: newDue.greaterThanOrEqualTo(bill.total_amount) ? 'approved' : 'partially_paid',
        moneda: bill.currency_code,
      },
      unapplied: amount.toFixed(2),
      discountReturned: discount.toFixed(2),
      ivaReparked: iva.toFixed(2),
      date,
      remainingOnAccount: remaining.toFixed(2),
    };
    if (opts.dryRun) throw new EnsayoEvento(result);
    return result;
  };

  return ejecutarEvento(run, opts);
}

export interface VendorReverseResult {
  paymentId: string;
  paymentNumber: string;
  date: string;
  /** Each entry of the payment and the mirror that undoes it. */
  reversals: { entryNumber: string; of: string }[];
  attestations: { entityId: string; entryId: string }[];
  /** The bills owed again, by what this payment still had applied to them. */
  documents: DocumentoAplicado[];
}

/**
 * Reverse a vendor payment (#98 · MNE-001-128): the transfer came back, so
 * the payment itself is undone, not only its applications (that is
 * `unapplyVendorPayment`, where the cash stays on account).
 *
 * Every posted entry of the payment (the payment, and each later application
 * and unapplication) gets its NIF B-1 mirror dated `date`: the mirror is
 * exact by construction, IVA and exchange legs included, so nothing is
 * re-derived. The bills reopen by what the LIVE applications carried
 * (amount plus discount); those rows are closed on the same date, never
 * deleted, and the payment turns 'reversed' (118) with that date.
 *
 * `date` (default today) cannot be in the future nor before the payment's
 * last posted event. A bill closed short is refused, as `payment unapply`
 * refuses it: the mirror would give the write-off back to the ledger while no
 * row says how much of it to give back to the bill.
 */
export async function reverseVendorPayment(
  entityId: string,
  paymentId: string,
  args: { reason: string; date?: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<VendorReverseResult> {
  const reason = args.reason.trim();
  if (!reason) throw new ValidationError('Say why the payment is reversed: the reason goes to the audit trail.');
  const today = toCalendarDate(new Date());
  const date = args.date === undefined ? today : toCalendarDate(args.date);
  if (date > today) throw new ValidationError(`A reversal cannot be dated in the future (${date}).`, 'date');

  const run = async (client: pg.PoolClient): Promise<VendorReverseResult> => {
    const vp = await pagoProveedorParaEscribir(client, entityId, paymentId);
    await assertAfterLastEvent(client, entityId, vp, date, 'a reversal');

    const live = await client.query<{
      id: string; bill_id: string; amount_applied: string; discount_amount: string;
    }>(
      `SELECT id, bill_id, amount_applied::text, COALESCE(discount_amount, 0)::text AS discount_amount
         FROM payment_applications
        WHERE payment_id = $1 AND unapplied_at IS NULL
        ORDER BY bill_id
        FOR UPDATE`,
      [paymentId]
    );
    const byBill = new Map<string, { amount: Decimal; discount: Decimal }>();
    for (const r of live.rows) {
      const acc = byBill.get(r.bill_id) ?? { amount: new Decimal(0), discount: new Decimal(0) };
      byBill.set(r.bill_id, { amount: acc.amount.plus(r.amount_applied), discount: acc.discount.plus(r.discount_amount) });
    }

    const documents: DocumentoAplicado[] = [];
    for (const [billId, { amount, discount }] of byBill) {
      const b = await client.query<{
        id: string; bill_number: string; amount_due: string; total_amount: string; currency_code: string;
      }>(
        `SELECT id, bill_number, amount_due::text, total_amount::text, currency_code
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [billId, entityId]
      );
      const bill = b.rows[0];
      await assertNotClosedShort(client, entityId, bill, 'a reversal');
      const reopened = amount.plus(discount);
      const reopen = await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid - $1,
           amount_due  = amount_due + $2,
           status = CASE WHEN amount_due + $2 >= total_amount THEN 'approved' ELSE 'partially_paid' END
         WHERE id = $3 AND entity_id = $4 AND status IN ('paid', 'partially_paid')`,
        [amount.toFixed(4), reopened.toFixed(4), billId, entityId]
      );
      if (reopen.rowCount !== 1) {
        throw new AccountingError('REVERSE_RACE', `${bill.bill_number} changed while ${vp.payment_number} was being reversed; nothing was written.`);
      }
      const newDue = new Decimal(bill.amount_due).plus(reopened);
      documents.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: new Decimal(bill.amount_due).toFixed(2),
        saldoNuevo: newDue.toFixed(2),
        estado: newDue.greaterThanOrEqualTo(bill.total_amount) ? 'approved' : 'partially_paid',
        moneda: bill.currency_code,
      });
    }

    // Invariant 3: the entity scope inside the same statement (MNE-001-584).
    const closed = await client.query(
      `UPDATE payment_applications
          SET unapplied_at = $1::date, unapplied_by = $2, unapply_reason = $3
        WHERE id = ANY($4::uuid[]) AND unapplied_at IS NULL
          AND payment_id = (SELECT id FROM vendor_payments WHERE id = $5 AND entity_id = $6)`,
      [date, userId, `Reversed: ${reason}`, live.rows.map((r) => r.id), paymentId, entityId]
    );
    const marked = await client.query(
      `UPDATE vendor_payments SET status = 'reversed', reversed_at = $1::date, updated_at = NOW()
        WHERE id = $2 AND entity_id = $3 AND status = $4`,
      [date, paymentId, entityId, ESTADO]
    );
    if (closed.rowCount !== live.rows.length || marked.rowCount !== 1) {
      throw new AccountingError('REVERSE_RACE', `${vp.payment_number} changed while it was being reversed; nothing was written.`);
    }

    // Every posted event of the payment not yet mirrored, oldest first, the
    // cashing of a cheque included: reversed, it leaves nothing in 1130.
    // FOR UPDATE because reverseWithinTransaction expects the caller to hold it.
    const entries = await client.query<JournalEntry>(
      `SELECT * FROM journal_entries
        WHERE entity_id = $1 AND source_id = $2 AND status = 'posted' AND reversed_by_entry_id IS NULL
          AND source_type IN ('vendor_payment', 'vendor_application', 'vendor_unapplication', 'bank_check_clearing')
        ORDER BY created_at
        FOR UPDATE`,
      [entityId, paymentId]
    );
    const reversals: VendorReverseResult['reversals'] = [];
    const attestations: VendorReverseResult['attestations'] = [];
    for (const je of entries.rows) {
      const mirror = await reverseWithinTransaction(
        client, je, userId, `Reversal of ${je.entry_number}: ${reason}`, date
      );
      reversals.push({ entryNumber: mirror.entry_number, of: je.entry_number });
      attestations.push({ entityId, entryId: mirror.id });
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'update',
      entityType: 'vendor_payments',
      entityId: paymentId,
      oldValues: { status: ESTADO },
      newValues: {
        evento: 'reverse', status: 'reversed', date,
        entries_reversed: reversals.length, bills_reopened: documents.map((d) => d.numero),
      },
      reason,
    });

    const result: VendorReverseResult = {
      paymentId, paymentNumber: vp.payment_number, date, reversals, attestations, documents,
    };
    if (opts.dryRun) throw new EnsayoEvento(result);
    return result;
  };

  return ejecutarEvento(run, opts);
}
