import Decimal from 'decimal.js';
import { query, currentTenant } from '../../../database/connection.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { decrypt } from '../../../utils/encryption.js';
import { getPolicy } from '../../policy/policy-service.js';
import { getTrialBalance } from '../../reporting/report-service.js';
import { formatearImporte, naturDe } from './balanza-invariantes.js';
import { resolverPeriodoDeBalanza, type PeriodoDeBalanza } from './balanza-service.js';
import { archivarArtefacto, hashDelXml, type ArtefactoArchivado } from './artefactos.js';
import { importeAnexo24 } from './xml.js';
import {
  construirPolizasXml,
  nombreDelArchivoDePolizas,
  VERSION_POLIZAS,
  type Comprobante,
  type NodoDePago,
  type Poliza,
  type Solicitud,
  type Transaccion,
} from './polizas-xml.js';
import {
  construirAuxiliarCuentasXml,
  construirAuxiliarFoliosXml,
  nombreDelArchivoAuxiliar,
  VERSION_AUX_CTAS,
  VERSION_AUX_FOLIOS,
  type CuentaAuxiliar,
  type DetalleDeFolios,
  type MovimientoAuxiliar,
} from './polizas-auxiliar-xml.js';
import {
  contarHallazgos,
  correrVerificaciones,
  totalesDePolizas,
  POLIZA_CHECK_NAMES,
  type CatalogoDeBancos,
  type HallazgoPoliza,
  type PolizaCheckName,
} from './polizas-invariantes.js';

// ============================================================
// F07d · LAS PÓLIZAS Y SU RASTRO DE PAGO
//
// Las dos filas del catálogo que este archivo sirve
// (docs/cli-command-catalog.md:2066 y :2067):
//
//   `e-accounting voucher generate`   → las pólizas del periodo, con el nodo
//                                       de evidencia correcto por transacción.
//   `e-accounting subledger generate` → el auxiliar de folios o el de cuenta y
//                                       subcuenta, que el SAT pide sólo a
//                                       requerimiento.
//
// EL MÓDULO ESTÁ PARTIDO IGUAL QUE EL CATÁLOGO DE F07b: la forma del archivo
// vive en `polizas-xml.ts` / `polizas-auxiliar-xml.ts`, las verificaciones en
// `polizas-invariantes.ts` (funciones puras, sin base), y aquí sólo la E/S.
// Eso es lo que permite fijar un XML esperado carácter a carácter en una
// prueba unitaria — la única forma de defender «bytes idénticos para entradas
// idénticas».
//
// ── LO QUE ESTE TRAMO NO INVENTA ────────────────────────────────────────
//
// La fila de `voucher generate` dice que está BLOQUEADA por `cfdi link add`:
// «sin UUID, RFC de contraparte y método de pago en la línea de asiento no hay
// póliza emisible». Sigue sin haber `cfdi link add` y NO se ha añadido: no es
// de este frente. Lo que sí hay es el vínculo que el motor ya escribe —
// `journal_entries.source_type` + `source_id`—, y por ahí se resuelve el
// comprobante SIN inventar una tabla nueva:
//
//   source_type 'bill'             → bills.cfdi_uuid + el RFC del proveedor
//   source_type 'invoice'          → invoices.cfdi_uuid + el RFC del cliente
//   source_type 'vendor_payment'   → el REP del pago, si lo hay, y su RASTRO
//   source_type 'customer_payment' → ídem del lado del cobro
//
// Lo que ese camino NO alcanza —una póliza manual con un CFDI pegado a mano,
// un asiento con dos comprobantes de distinta contraparte— se queda sin nodo y
// SE DICE, con el número de póliza. Es exactamente el hueco que `cfdi link
// add` viene a tapar, y decirlo es mejor que fabricar una liga que no existe.
//
// ── LA FRONTERA DE ENTIDAD, DENTRO DEL SQL ──────────────────────────────
//
// Octava aparición en el proyecto y segunda en algo que se entrega a la
// autoridad. La lección de F07b es literal: acotar sólo por entidad deja la
// frontera en manos de RLS, y RLS no está siempre puesto —la suite de
// integración corre como superusuario a propósito—. Sin el inquilino dentro
// del SQL, generar las pólizas de una entidad ajena archivaría un artefacto
// FISCAL con el tenant_id del otro despacho y el usuario de esta sesión como
// autor.
// ============================================================

/** Lo que identifica al contribuyente en el archivo. */
interface Contribuyente {
  tenant_id: string;
  rfc: string;
  tax_id_type: string;
  name: string;
}

/**
 * El contribuyente, con el inquilino DENTRO del SQL y el RFC normalizado.
 *
 * DEUDA DECLARADA: `balanza-service.ts` tiene una gemela privada de esta
 * función, con el mismo SQL y la misma normalización. Debería vivir una sola
 * vez, y no se ha unificado en este commit porque `balanza-service.ts` es de
 * F07b, ya entregado, y este frente no lo toca. La forma correcta es subirla a
 * un módulo común del Anexo 24; queda dicho aquí para que no se descubra
 * dentro de un año como una copia que nadie recuerda haber hecho.
 *
 * La normalización del RFC no es cosmética: F07b midió que con un RFC guardado
 * con espacios o en minúsculas —`legal_entities.tax_id` no tiene CHECK— el
 * catálogo salía bien y la balanza moría culpando al dato equivocado.
 */
async function contribuyente(entityId: string): Promise<Contribuyente> {
  const inquilino = currentTenant() ?? null;
  const r = await query<Contribuyente>(
    `SELECT tenant_id, tax_id AS rfc, tax_id_type, name
       FROM legal_entities
      WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
    [entityId, inquilino]
  );
  const e = r.rows[0];
  if (!e) throw new NotFoundError('Legal entity', entityId);
  if (e.tax_id_type !== 'rfc') {
    throw new ValidationError(
      `${e.name} se identifica con «${e.tax_id_type}», no con RFC. Las pólizas del Anexo 24 las ` +
        `entrega un contribuyente mexicano ante el SAT.`
    );
  }
  return { ...e, rfc: e.rfc.trim().toUpperCase() };
}

// ------------------------------------------------------------
// LO QUE SE LEE DEL MAYOR
// ------------------------------------------------------------

interface FilaDePoliza {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  source_type: string | null;
  source_id: string | null;
}

interface FilaDeRenglon {
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  code: string;
  name: string;
  description: string | null;
  debit_amount: string | null;
  credit_amount: string | null;
}

/**
 * Las pólizas POSTEADAS del periodo, acotadas por entidad.
 *
 * Sólo `posted`: un borrador no es una póliza, es una intención, y entregar
 * intenciones a la autoridad declara movimientos que no ocurrieron. Las
 * anuladas (`void`) tampoco entran; su reversa sí, porque la reversa es un
 * asiento posteado de pleno derecho y el mayor la tiene.
 */
async function polizasDelPeriodo(
  entityId: string,
  periodo: PeriodoDeBalanza
): Promise<FilaDePoliza[]> {
  if (periodo.fiscal_period_id !== undefined) {
    const r = await query<FilaDePoliza>(
      `SELECT id, entry_number, entry_date::text AS entry_date, description,
              source_type, source_id::text AS source_id
         FROM journal_entries
        WHERE entity_id = $1 AND fiscal_period_id = $2 AND status = 'posted'
        ORDER BY entry_date, entry_number`,
      [entityId, periodo.fiscal_period_id]
    );
    return r.rows;
  }
  const r = await query<FilaDePoliza>(
    `SELECT id, entry_number, entry_date::text AS entry_date, description,
            source_type, source_id::text AS source_id
       FROM journal_entries
      WHERE entity_id = $1 AND status = 'posted'
        AND entry_date >= $2::date AND entry_date <= $3::date
      ORDER BY entry_date, entry_number`,
    [entityId, periodo.desde, periodo.hasta]
  );
  return r.rows;
}

/**
 * Los renglones, con la entidad en LAS DOS tablas.
 *
 * La cuenta se une con `a.entity_id = $1`: una línea cuya cuenta fuera de otra
 * entidad no puede entrar en este archivo. Si eso llegara a pasar, la línea
 * desaparece y la póliza queda descuadrada — y el hallazgo `poliza-cuadra` la
 * denuncia con su número, que es mejor que emitirla coja en silencio.
 */
async function renglonesDe(entityId: string, ids: readonly string[]): Promise<FilaDeRenglon[]> {
  if (ids.length === 0) return [];
  const r = await query<FilaDeRenglon>(
    `SELECT jel.journal_entry_id::text AS journal_entry_id, jel.line_number,
            jel.account_id::text AS account_id, a.code, a.name, jel.description,
            jel.debit_amount::text AS debit_amount, jel.credit_amount::text AS credit_amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.entity_id = $1
       JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $1
      WHERE jel.journal_entry_id = ANY($2::uuid[])
      ORDER BY jel.journal_entry_id, jel.line_number`,
    [entityId, [...ids]]
  );
  return r.rows;
}

/** Las cuentas de mayor por las que se mueve dinero en esta entidad. */
async function cuentasDeDinero(entityId: string): Promise<Set<string>> {
  const r = await query<{ account_id: string }>(
    `SELECT gl_account_id::text AS account_id FROM bank_accounts WHERE entity_id = $1
      UNION
     SELECT account_id::text FROM account_roles
      WHERE entity_id = $1 AND role = 'banco' AND qualifier IS NULL`,
    [entityId]
  );
  return new Set(r.rows.map((x) => x.account_id));
}

/**
 * Las cuentas de CONTROL de terceros: proveedores y clientes.
 *
 * Es de donde cuelga el comprobante, y saberlo importa. La alternativa fácil
 * —colgarlo del primer renglón que no sea de banco— habría atado el archivo al
 * ORDEN EN QUE EL MOTOR ESCRIBE LAS LÍNEAS, que no es un hecho contable: en el
 * asiento de un gasto ese primer renglón puede ser el del gasto o el del IVA
 * según cómo se arme, y una prueba que hoy pasa lo haría por casualidad.
 */
async function cuentasDeControl(entityId: string): Promise<Set<string>> {
  const r = await query<{ account_id: string }>(
    `SELECT account_id::text AS account_id FROM account_roles
      WHERE entity_id = $1 AND role IN ('cxp', 'cxc') AND qualifier IS NULL`,
    [entityId]
  );
  return new Set(r.rows.map((x) => x.account_id));
}

interface FilaDeCuentaBancaria {
  gl_account_id: string;
  sat_bank_code: string | null;
  bank_name: string;
  clabe_encrypted: string | null;
  clabe_last4: string | null;
  account_number_encrypted: string | null;
  account_number_last4: string | null;
}

/**
 * LA CUENTA DE ORIGEN, QUE ESTÁ CIFRADA.
 *
 * `CtaOri` es el número de cuenta de donde salió el dinero, y en este esquema
 * la CLABE y el número de cuenta viven cifrados (051): las superficies enseñan
 * los últimos cuatro y nada más. Aquí se DESCIFRA, y esa decisión merece
 * decirse:
 *
 *   · El archivo va a la autoridad, que es precisamente quien tiene derecho al
 *     número completo — es el dato que hace seguible la deducción.
 *   · Poner los últimos cuatro en su lugar sería PEOR que dejarlo vacío:
 *     declararía como número de cuenta algo que no lo es, y el archivo se
 *     aceptaría. Un dato falso que pasa la validación es el peor resultado.
 *   · Y si la llave no descifra —clave rotada, dato migrado—, no se sustituye
 *     por nada: el nodo sale sin CtaOri y el hallazgo lo dice.
 *
 * El número descifrado NO se devuelve al llamador ni se imprime: sólo entra al
 * XML. Quien quiera verlo, abre el archivo que va a firmar.
 */
async function cuentasBancarias(entityId: string): Promise<Map<string, FilaDeCuentaBancaria>> {
  const r = await query<FilaDeCuentaBancaria & { id: string }>(
    `SELECT id::text AS id, gl_account_id::text AS gl_account_id, sat_bank_code, bank_name,
            clabe_encrypted, clabe_last4, account_number_encrypted, account_number_last4
       FROM bank_accounts WHERE entity_id = $1`,
    [entityId]
  );
  return new Map(r.rows.map((x) => [x.id, x]));
}

/** El número de cuenta en claro, o `undefined` si no hay o no descifra. */
function numeroDeCuenta(b: FilaDeCuentaBancaria | undefined): string | undefined {
  if (!b) return undefined;
  const cifrado = b.clabe_encrypted ?? b.account_number_encrypted;
  if (cifrado === null || cifrado === undefined) return undefined;
  try {
    const claro = decrypt(cifrado).trim();
    return claro === '' ? undefined : claro;
  } catch {
    // No se adivina y no se sustituye por los últimos cuatro: ver la nota de
    // `cuentasBancarias`. El nodo saldrá sin CtaOri y el hallazgo lo nombrará.
    return undefined;
  }
}

/** El c_Banco tal como esté hoy, con la distinción que decide todo. */
async function catalogoDeBancos(): Promise<CatalogoDeBancos> {
  const r = await query<{ clave: string }>(
    `SELECT clave FROM sat_bancos WHERE vigente = true`
  );
  return { sembrado: r.rows.length > 0, claves: new Set(r.rows.map((x) => x.clave)) };
}

// ------------------------------------------------------------
// EL RASTRO DE PAGO Y LA EVIDENCIA
// ------------------------------------------------------------

interface FilaDePago {
  payment_number: string;
  payment_amount: string;
  payment_date: string;
  payment_method: string;
  currency_code: string;
  exchange_rate: string;
  bank_account_id: string | null;
  check_number: string | null;
  cuenta_destino: string | null;
  banco_destino_sat: string | null;
  banco_destino_extranjero: string | null;
  cfdi_uuid: string | null;
  /** Nombre y RFC de la contraparte, ya resueltos por el JOIN. */
  contraparte: string;
  contraparte_rfc: string | null;
}

/**
 * LOS PAGOS DEL PERIODO, EN UNA CONSULTA Y NO EN UNA POR PÓLIZA.
 *
 * La versión obvia era resolver el pago dentro del bucle de pólizas. Un mes
 * corriente son cientos o miles de asientos, y eso son cientos o miles de idas
 * a Postgres para construir UN archivo: el generador se volvería inusable justo
 * en la entidad que más lo necesita. Se leen por lote, acotados por entidad
 * DENTRO del SQL, y el bucle sólo mira el mapa.
 */
async function pagosAProveedores(
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, FilaDePago>> {
  if (ids.length === 0) return new Map();
  const r = await query<FilaDePago & { id: string }>(
    `SELECT vp.id::text AS id,
            vp.payment_number, vp.payment_amount::text AS payment_amount,
            vp.payment_date::text AS payment_date, vp.payment_method, vp.currency_code,
            vp.exchange_rate::text AS exchange_rate, vp.bank_account_id::text AS bank_account_id,
            vp.check_number, vp.cuenta_destino, vp.banco_destino_sat, vp.banco_destino_extranjero,
            vp.cfdi_uuid, v.company_name AS contraparte, v.tax_id AS contraparte_rfc
       FROM vendor_payments vp
       JOIN vendors v ON v.id = vp.vendor_id AND v.entity_id = $1
      WHERE vp.id = ANY($2::uuid[]) AND vp.entity_id = $1`,
    [entityId, [...ids]]
  );
  return new Map(r.rows.map((x) => [x.id, x]));
}

async function cobrosDeClientes(
  entityId: string,
  ids: readonly string[]
): Promise<Map<string, FilaDePago>> {
  if (ids.length === 0) return new Map();
  const r = await query<FilaDePago & { id: string }>(
    `SELECT cp.id::text AS id,
            cp.payment_number, cp.payment_amount::text AS payment_amount,
            cp.payment_date::text AS payment_date, cp.payment_method, cp.currency_code,
            cp.exchange_rate::text AS exchange_rate, cp.bank_account_id::text AS bank_account_id,
            cp.check_number, cp.cuenta_destino, cp.banco_destino_sat, cp.banco_destino_extranjero,
            cp.cfdi_uuid,
            COALESCE(c.company_name, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) AS contraparte,
            c.tax_id AS contraparte_rfc
       FROM customer_payments cp
       JOIN customers c ON c.id = cp.customer_id AND c.entity_id = $1
      WHERE cp.id = ANY($2::uuid[]) AND cp.entity_id = $1`,
    [entityId, [...ids]]
  );
  return new Map(r.rows.map((x) => [x.id, x]));
}

/** Los métodos de pago que el sistema registra, traducidos al c_MetPago. */
const METODO_A_SAT: Record<string, string> = {
  cash: '01',
  check: '02',
  spei: '03',
  wire: '03',
  ach: '03',
  credit_card: '04',
  debit_card: '28',
  other: '99',
};

interface RastroResuelto {
  pago?: NodoDePago;
  /** Por qué no se pudo construir el nodo, cuando `pago` es undefined. */
  motivo?: string;
}

/**
 * LIMPIA UN TEXTO QUE VA A UN ATRIBUTO Y DEJA CONSTANCIA SI TUVO QUE CAMBIARLO.
 *
 * Es la firma de la función `texto()` de `generarPolizas`. Viaja como
 * parámetro —en vez de que cada sitio llame a `limpiar()` por su cuenta—
 * porque lo que importa no es limpiar: es DENUNCIAR, con el número de póliza,
 * que el texto que se emite no es el que estaba guardado.
 */
type Saneador = (crudo: string, numUnIdenPol: string, campo: string) => string;

/** Cuando no hay a quién denunciarle nada (el auxiliar de folios). */
const SANEADOR_MUDO: Saneador = (crudo) => limpiar(crudo).texto;

/**
 * DE UN PAGO REGISTRADO AL NODO QUE EL ANEXO 24 DECLARA.
 *
 * Tres formas y la elección no es libre: el método del pago la fija. Un pago
 * por cheque va en `Cheque` —con su número, que es la columna que hasta este
 * commit nadie escribía—, una transferencia en `Transferencia`, y el resto en
 * `OtrMetodoPago`, que es el nodo que existe justamente para no tener que
 * mentir sobre los otros dos.
 *
 * `sentido` decide de qué lado está nuestra cuenta bancaria: en un pago sale
 * de ella (es la ORIGEN) y en un cobro entra (es la DESTINO). Tratar los dos
 * igual pondría el dinero saliendo de la cuenta del cliente hacia la nuestra
 * declarada como origen, que es el rastro exactamente al revés.
 *
 * EL TEXTO LIBRE DE ESTE NODO PASA POR EL SANEADOR, y esa es una corrección de
 * la verificación adversarial. `DesCta` y `Concepto` ya se limpiaban; `Benef`
 * salía CRUDO de `vendors.company_name`, que es texto libre de 255 caracteres
 * del mismo origen que el nombre de cuenta —un catálogo importado de Excel—.
 * Se midió: un proveedor llamado «Aceros del Bajío\nSA de CV» hacía que
 * `exigirValorDeAtributo` lanzara y MATABA la generación del mes entera, con
 * un mensaje que nombra `@Benef` y no la póliza ni al proveedor. Un archivo
 * que se cae por un dato de UNA póliza no deja ni la lista de lo que hay que
 * arreglar, que es justamente el producto de este comando.
 */
function rastroDePago(
  p: FilaDePago,
  sentido: 'sale' | 'entra',
  banco: FilaDeCuentaBancaria | undefined,
  nuestro: { nombre: string; rfc: string },
  sanear: Saneador,
  numUnIdenPol: string
): RastroResuelto {
  const monto = importeAnexo24(p.payment_amount).texto;
  const moneda = p.currency_code;
  // TipCamb sólo cuando la moneda NO es la nacional: declarar 1.0 sobre pesos
  // añade un dato que no significa nada.
  const tipCamb = moneda === 'MXN' ? undefined : new Decimal(p.exchange_rate).toString();

  // El beneficiario es QUIEN RECIBE EL DINERO, no «la contraparte». En un pago
  // a proveedor es el proveedor; en un cobro somos nosotros. Escribir siempre
  // el tercero pondría al cliente como beneficiario de un dinero que entró en
  // nuestra cuenta.
  const crudoBenef = sentido === 'sale' ? p.contraparte : nuestro.nombre;
  // El vacío NO pasa por el saneador: `limpiar('')` devuelve '-', y en el nodo
  // `OtrMetodoPago` el beneficiario es OPCIONAL — declarar «-» donde el dato
  // no consta es peor que omitirlo.
  const benef =
    crudoBenef.trim() === ''
      ? ''
      : sanear(crudoBenef, numUnIdenPol, `Benef del pago ${p.payment_number}`);
  // El RFC no se «limpia», se compacta: un espacio interior no se sustituye
  // por otro espacio, se quita. Es la misma normalización que `normalizarRfc`
  // en la DIOT, y por el mismo motivo — un RFC con un espacio guardado no es
  // otro RFC.
  const rfcBenef =
    sentido === 'sale'
      ? (p.contraparte_rfc ?? '').toUpperCase().replace(/\s+/g, '')
      : nuestro.rfc.toUpperCase().replace(/\s+/g, '');

  const crudoCuenta = numeroDeCuenta(banco);
  const nuestraCuenta =
    crudoCuenta === undefined ? undefined : crudoCuenta.replace(/\s+/g, '') || undefined;
  const nuestroBanco = (banco?.sat_bank_code ?? '').trim() || undefined;
  const cuentaCapturada = (p.cuenta_destino ?? '').replace(/\s+/g, '') || undefined;
  const bancoCapturadoNal = (p.banco_destino_sat ?? '').trim() || undefined;
  // El nombre del banco extranjero SÍ es texto libre (VARCHAR(150)) y sí
  // admite espacios interiores: va por el saneador como el beneficiario.
  const crudoBancoExt = (p.banco_destino_extranjero ?? '').trim();
  const bancoCapturadoExt =
    crudoBancoExt === ''
      ? undefined
      : sanear(crudoBancoExt, numUnIdenPol, `BancoDestExt del pago ${p.payment_number}`);

  if (p.payment_method === 'check') {
    const num = (p.check_number ?? '').trim();
    if (num === '') {
      return {
        motivo:
          `el pago ${p.payment_number} se hizo por cheque y no tiene número de cheque capturado ` +
          `(\`payment create --check-number\`); el nodo Cheque lo exige`,
      };
    }
    if (nuestraCuenta === undefined) {
      return {
        motivo:
          `el pago ${p.payment_number} es un cheque y no se pudo resolver la cuenta de origen: ` +
          `la cuenta bancaria del pago no tiene número guardado o no descifra`,
      };
    }
    // EL RFC DEL BENEFICIARIO SE COMPRUEBA, NO SE EMITE A CIEGAS. El nodo
    // `Cheque` declara @RFC como obligatorio, así que omitirlo no es opción;
    // emitir uno malformado es peor, porque el archivo se acepta y el cruce
    // que la autoridad hace contra ese RFC no encuentra a nadie. Se prefiere
    // no emitir el nodo y NOMBRAR la póliza, que es lo que hace el hallazgo.
    if (rfcDeclarable(rfcBenef) === null) {
      return {
        motivo:
          `el beneficiario del cheque ${num} tiene «${rfcBenef}» como RFC, que no tiene forma de ` +
          `RFC (12 caracteres persona moral o 13 física)`,
      };
    }
    return {
      pago: {
        clase: 'cheque',
        num,
        ...(nuestroBanco !== undefined ? { banEmisNal: nuestroBanco } : {}),
        ctaOri: nuestraCuenta,
        fecha: p.payment_date,
        benef,
        rfc: rfcBenef,
        monto,
        moneda,
        ...(tipCamb !== undefined ? { tipCamb } : {}),
      },
    };
  }

  if (p.payment_method === 'spei' || p.payment_method === 'wire' || p.payment_method === 'ach') {
    // En un pago la cuenta destino es la CAPTURADA (la del tercero); en un
    // cobro la destino es la NUESTRA y la del tercero no se conoce — y no se
    // inventa: `CtaOri` se omite, que el esquema permite.
    const ctaDest = sentido === 'sale' ? cuentaCapturada : (cuentaCapturada ?? nuestraCuenta);
    if (ctaDest === undefined) {
      return {
        motivo:
          sentido === 'sale'
            ? `el pago ${p.payment_number} es una transferencia y no tiene cuenta destino capturada ` +
              `(\`payment create --to-account\`); es el dato obligatorio del nodo Transferencia`
            : `el cobro ${p.payment_number} entró por transferencia y no se pudo resolver la cuenta ` +
              `que lo recibió: ni está capturada ni la cuenta bancaria del cobro tiene número`,
      };
    }
    if (rfcDeclarable(rfcBenef) === null) {
      return {
        motivo:
          `el beneficiario de la transferencia ${p.payment_number} tiene «${rfcBenef}» como RFC, ` +
          `que no tiene forma de RFC`,
      };
    }
    const nodo: NodoDePago = {
      clase: 'transferencia',
      ...(sentido === 'sale'
        ? {
            ...(nuestraCuenta !== undefined ? { ctaOri: nuestraCuenta } : {}),
            ...(nuestroBanco !== undefined ? { bancoOriNal: nuestroBanco } : {}),
            ...(bancoCapturadoNal !== undefined ? { bancoDestNal: bancoCapturadoNal } : {}),
            ...(bancoCapturadoExt !== undefined ? { bancoDestExt: bancoCapturadoExt } : {}),
          }
        : {
            // EL RELLENO NO PISA AL DATO CAPTURADO. En un cobro la cuenta que
            // recibe suele ser la nuestra, así que cuando nadie capturó banco
            // destino se pone el de nuestra cuenta. Lo que NO puede hacer ese
            // relleno es convivir con un banco destino EXTRANJERO capturado:
            // `exigirBancoUnico` lanza con los dos puestos y MATABA la
            // generación del mes entera. Medido con un cobro cuyo destino se
            // capturó como banco extranjero mientras nuestra cuenta tiene
            // `sat_bank_code`; el CHECK de la 064 no lo ve porque en la FILA
            // sólo hay uno de los dos — los dos se juntan aquí.
            ...(bancoCapturadoNal !== undefined
              ? { bancoDestNal: bancoCapturadoNal }
              : bancoCapturadoExt === undefined && nuestroBanco !== undefined
                ? { bancoDestNal: nuestroBanco }
                : {}),
            ...(bancoCapturadoExt !== undefined ? { bancoDestExt: bancoCapturadoExt } : {}),
          }),
      ctaDest,
      fecha: p.payment_date,
      benef,
      rfc: rfcBenef,
      monto,
      moneda,
      ...(tipCamb !== undefined ? { tipCamb } : {}),
    };
    return { pago: nodo };
  }

  // El resto —efectivo, tarjeta, «otro»— va al nodo que existe para eso. No es
  // un cajón de sastre: es el nodo con el que el Anexo 24 admite que hubo un
  // pago que no fue ni cheque ni transferencia, y llevar un pago en efectivo
  // al nodo Transferencia sería una afirmación falsa sobre cómo se movió.
  return {
    pago: {
      clase: 'otro',
      metPagoPol: METODO_A_SAT[p.payment_method] ?? '99',
      fecha: p.payment_date,
      ...(benef !== '' ? { benef } : {}),
      // Aquí @RFC sí es OPCIONAL, así que un RFC sin forma se OMITE en vez de
      // costar el nodo entero: un rastro con beneficiario y sin RFC dice más
      // que ningún rastro, y un RFC inventado no dice nada verdadero.
      ...(rfcDeclarable(rfcBenef) !== null ? { rfc: rfcBenef } : {}),
      monto,
      moneda,
      ...(tipCamb !== undefined ? { tipCamb } : {}),
    },
  };
}

interface FilaDeDocumento {
  cfdi_uuid: string | null;
  total: string;
  currency_code: string;
  contraparte_rfc: string | null;
}

/** Los documentos del periodo, también por lote y con la entidad en el SQL. */
async function documentosDePolizas(
  entityId: string,
  tipo: 'bill' | 'invoice',
  ids: readonly string[]
): Promise<Map<string, FilaDeDocumento>> {
  if (ids.length === 0) return new Map();
  const sql =
    tipo === 'bill'
      ? `SELECT b.id::text AS id, b.cfdi_uuid, b.total_amount::text AS total, b.currency_code,
                v.tax_id AS contraparte_rfc
           FROM bills b JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = $1
          WHERE b.id = ANY($2::uuid[]) AND b.entity_id = $1`
      : `SELECT i.id::text AS id, i.cfdi_uuid, i.total_amount::text AS total, i.currency_code,
                c.tax_id AS contraparte_rfc
           FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.entity_id = $1
          WHERE i.id = ANY($2::uuid[]) AND i.entity_id = $1`;
  const r = await query<FilaDeDocumento & { id: string }>(sql, [entityId, [...ids]]);
  return new Map(r.rows.map((x) => [x.id, x]));
}

// ------------------------------------------------------------
// LA CONSTRUCCIÓN
// ------------------------------------------------------------

export interface OpcionesDePolizas {
  /** `--period`: nombre del periodo, 2026-02, o el id de un periodo fiscal. */
  periodo?: string;
  /** `--closing`: el periodo 13, donde caen los ajustes del ejercicio. */
  cierre?: boolean;
  /** A qué requerimiento responde el archivo. No tiene valor por omisión. */
  solicitud: Solicitud;
  /** `--validate-uuids`. */
  validarUuids?: boolean;
  /** Quién genera. Sin él NO se archiva: `generado_por` es NOT NULL. */
  generadoPor?: string;
  /** `--dry-run`: recorre el camino entero, produce el XML y no archiva. */
  dryRun?: boolean;
  /** Verificaciones a correr. Por omisión, todas. */
  checks?: readonly PolizaCheckName[];
}

export interface MetaDePolizas {
  tenant_id: string;
  entity_id: string;
  rfc: string;
  anio: number;
  mes: string;
  period_name: string;
  desde: string;
  hasta: string;
  polizas: number;
  transacciones: number;
  /** Cuántas pólizas llevan nodo de pago resuelto. */
  con_rastro: number;
  /** Valor efectivo de `efirma_sellado_contabilidad_electronica`. */
  criterio_sellado: string;
  /** SIEMPRE false. No hay camino que selle. */
  sellada: boolean;
  /** false cuando `sat_bancos` está vacío: la clave de banco no se validó. */
  bancos_sembrados: boolean;
}

export interface PolizasGeneradas {
  xml: string;
  hash: string;
  bytes: number;
  nombre: string;
  meta: MetaDePolizas;
  hallazgos: HallazgoPoliza[];
  conteo: { blocking: number; warning: number };
  /** false si hay un hallazgo que bloquea. El XML se construye igual. */
  puedeEntregarse: boolean;
  totales: { debe: string; haber: string };
  /** null en ensayo, sin autor, o cuando no se puede entregar. */
  artefacto: ArtefactoArchivado | null;
  notaDeSellado: string;
}

const NOTA_SIN_SELLAR =
  'El archivo sale SIN SELLAR y NADA se ha presentado ante el SAT. La e.firma es el contribuyente ' +
  'firmando, no el software: construir el archivo y firmarlo son actos distintos y de manos distintas.';

/** Lo que se leyó del mayor, ya montado, para que las dos salidas lo compartan. */
interface Lectura {
  e: Contribuyente;
  periodo: PeriodoDeBalanza;
  filas: FilaDePoliza[];
  renglones: Map<string, FilaDeRenglon[]>;
  dinero: Set<string>;
  control: Set<string>;
  bancos: Map<string, FilaDeCuentaBancaria>;
  catalogoBancos: CatalogoDeBancos;
  /** El soporte de cada póliza, ya resuelto por lote y no una consulta por fila. */
  gastos: Map<string, FilaDeDocumento>;
  facturas: Map<string, FilaDeDocumento>;
  pagos: Map<string, FilaDePago>;
  cobros: Map<string, FilaDePago>;
}

/** Los `source_id` de las pólizas cuyo origen es de un tipo dado. */
function origenes(filas: readonly FilaDePoliza[], tipo: string): string[] {
  // Con un bucle y no con filter+map: `filter` no estrecha `source_id` de
  // `string | null`, así que la versión corta necesitaba un `as string` — una
  // aserción que sólo calla al compilador y que sobreviviría al día en que
  // alguien borrara la condición.
  const ids: string[] = [];
  for (const f of filas) {
    if (f.source_type === tipo && f.source_id !== null) ids.push(f.source_id);
  }
  return ids;
}

async function leer(entityId: string, opts: OpcionesDePolizas): Promise<Lectura> {
  const e = await contribuyente(entityId);
  const periodo = await resolverPeriodoDeBalanza(entityId, {
    ...(opts.periodo !== undefined ? { periodo: opts.periodo } : {}),
    ...(opts.cierre === true ? { cierre: true } : {}),
  });
  const filas = await polizasDelPeriodo(entityId, periodo);
  const lineas = await renglonesDe(entityId, filas.map((f) => f.id));
  const renglones = new Map<string, FilaDeRenglon[]>();
  for (const l of lineas) {
    const lista = renglones.get(l.journal_entry_id) ?? [];
    lista.push(l);
    renglones.set(l.journal_entry_id, lista);
  }
  const [dinero, control, bancos, catalogoBancos, gastos, facturas, pagos, cobros] =
    await Promise.all([
      cuentasDeDinero(entityId),
      cuentasDeControl(entityId),
      cuentasBancarias(entityId),
      catalogoDeBancos(),
      documentosDePolizas(entityId, 'bill', origenes(filas, 'bill')),
      documentosDePolizas(entityId, 'invoice', origenes(filas, 'invoice')),
      pagosAProveedores(entityId, origenes(filas, 'vendor_payment')),
      cobrosDeClientes(entityId, origenes(filas, 'customer_payment')),
    ]);
  return {
    e, periodo, filas, renglones, dinero, control, bancos, catalogoBancos,
    gastos, facturas, pagos, cobros,
  };
}

/** El comprobante y el rastro de una póliza, resueltos por su origen. */
interface Soporte {
  comprobantes: Comprobante[];
  pago?: NodoDePago;
  motivoSinRastro?: string;
  /**
   * El CFDI existe y su RFC de contraparte NO SIRVE para declararlo, así que
   * el nodo de comprobante se queda fuera. Es la explicación, para que la
   * póliza aparezca por su número en vez de perder el comprobante en silencio.
   */
  motivoSinComprobante?: string;
}

/**
 * EL RFC QUE EL COMPROBANTE PUEDE LLEVAR.
 *
 * Es el mismo patrón que `polizas-xml.ts` exige en `CompNal/@RFC`, comprobado
 * AQUÍ y no allí, y la diferencia es todo el arreglo: allí LANZA, y la
 * verificación adversarial midió que un solo proveedor con un RFC de once
 * caracteres —`vendors.tax_id` es VARCHAR(50) SIN CHECK, lo dice la cabecera
 * de `diot/rfc.ts`— MATABA la generación del mes entera. El comando cuyo
 * producto es «la lista de lo que le falta a estas pólizas» no puede morirse
 * por una fila: se queda sin ESE nodo y se nombra la póliza.
 *
 * La comparación con la DIOT no es retórica: con el mismo dato, la DIOT emite
 * `DIOT-SIN-RFC` nombrando al proveedor y sigue con los demás.
 */
const RFC_DE_COMPROBANTE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

function rfcDeclarable(crudo: string | null): string | null {
  const rfc = (crudo ?? '').toUpperCase().replace(/\s+/g, '');
  return RFC_DE_COMPROBANTE.test(rfc) ? rfc : null;
}

function soporteDe(f: FilaDePoliza, L: Lectura, sanear: Saneador = SANEADOR_MUDO): Soporte {
  const nuestro = { nombre: L.e.name, rfc: L.e.rfc };

  if (f.source_type === 'bill' || f.source_type === 'invoice') {
    if (f.source_id === null) return { comprobantes: [] };
    const doc =
      f.source_type === 'bill' ? L.gastos.get(f.source_id) : L.facturas.get(f.source_id);
    if (!doc || doc.cfdi_uuid === null) return { comprobantes: [] };
    const rfc = rfcDeclarable(doc.contraparte_rfc);
    if (rfc === null) {
      return {
        comprobantes: [],
        motivoSinComprobante:
          `el ${f.source_type === 'bill' ? 'gasto' : 'la factura'} trae el CFDI ` +
          `${doc.cfdi_uuid} y el RFC de la contraparte es «${(doc.contraparte_rfc ?? '').trim()}», ` +
          `que no tiene forma de RFC. El comprobante NO se declara: la autoridad cruza ese RFC ` +
          `contra las declaraciones del tercero, y uno mal formado no encuentra nada. Corrige el ` +
          `RFC del tercero y vuelve a generar.`,
      };
    }
    return {
      comprobantes: [
        {
          clase: 'nacional',
          uuid: doc.cfdi_uuid,
          rfc,
          montoTotal: importeAnexo24(doc.total).texto,
          ...(doc.currency_code !== 'MXN' ? { moneda: doc.currency_code } : {}),
        },
      ],
    };
  }

  if (f.source_type === 'vendor_payment' || f.source_type === 'customer_payment') {
    if (f.source_id === null) {
      return { comprobantes: [], motivoSinRastro: 'el asiento dice venir de un pago y no dice de cuál' };
    }
    const p =
      f.source_type === 'vendor_payment'
        ? L.pagos.get(f.source_id)
        : L.cobros.get(f.source_id);
    if (!p) {
      return {
        comprobantes: [],
        motivoSinRastro: `el pago ${f.source_id} del que dice venir el asiento no existe en esta entidad`,
      };
    }
    const banco = p.bank_account_id !== null ? L.bancos.get(p.bank_account_id) : undefined;
    const rastro = rastroDePago(
      p,
      f.source_type === 'vendor_payment' ? 'sale' : 'entra',
      banco,
      nuestro,
      sanear,
      f.entry_number
    );
    const comprobantes: Comprobante[] = [];
    const rfc = rfcDeclarable(p.contraparte_rfc);
    let motivoSinComprobante: string | undefined;
    if (p.cfdi_uuid !== null && rfc !== null) {
      // El REP: el CFDI de pago que documenta este movimiento. Los CFDI de las
      // facturas que el pago liquida NO se repiten aquí — se declaran en la
      // póliza de cada factura, que es donde nacieron.
      comprobantes.push({
        clase: 'nacional',
        uuid: p.cfdi_uuid,
        rfc,
        montoTotal: importeAnexo24(p.payment_amount).texto,
        ...(p.currency_code !== 'MXN' ? { moneda: p.currency_code } : {}),
      });
    } else if (p.cfdi_uuid !== null) {
      motivoSinComprobante =
        `el pago ${p.payment_number} trae el REP ${p.cfdi_uuid} y el RFC de la contraparte es ` +
        `«${(p.contraparte_rfc ?? '').trim()}», que no tiene forma de RFC. El comprobante de pago ` +
        `NO se declara.`;
    }
    return {
      comprobantes,
      ...(rastro.pago !== undefined ? { pago: rastro.pago } : {}),
      ...(rastro.motivo !== undefined ? { motivoSinRastro: rastro.motivo } : {}),
      ...(motivoSinComprobante !== undefined ? { motivoSinComprobante } : {}),
    };
  }

  return { comprobantes: [] };
}

/**
 * `e-accounting voucher generate` · las pólizas del periodo.
 *
 * NO LANZA ante un hallazgo bloqueante: devuelve el XML construido con
 * `puedeEntregarse: false` y la lista entera. Es el criterio del catálogo de
 * F07b y no el de la balanza, y aquí importa más: el hallazgo típico de este
 * archivo es «a estas nueve pólizas les falta el rastro», y esa lista es el
 * producto. Un `throw` la habría convertido en una cadena de texto.
 *
 * Sí lanza cuando la petición es imposible —la entidad no existe, no es del
 * inquilino, no tiene RFC, el periodo no es un mes—: eso no es un hallazgo del
 * archivo, es un error de uso.
 */
export async function generarPolizas(
  entityId: string,
  opts: OpcionesDePolizas
): Promise<PolizasGeneradas> {
  const L = await leer(entityId, opts);
  const criterioSellado = await selladoDe(entityId, L.e.tenant_id);

  const polizas: Poliza[] = [];
  const sinRastro: { numUnIdenPol: string; motivo: string }[] = [];
  const sinComprobante: { numUnIdenPol: string; motivo: string }[] = [];
  const normalizados: { numUnIdenPol: string; campo: string; texto: string }[] = [];
  let conRastro = 0;

  /** Limpia y, si tuvo que cambiar algo, lo apunta para que salga en un aviso. */
  const texto = (crudo: string, numUnIdenPol: string, campo: string): string => {
    const r = limpiar(crudo);
    if (r.cambiado) normalizados.push({ numUnIdenPol, campo, texto: r.texto });
    return r.texto;
  };

  for (const f of L.filas) {
    const lineas = L.renglones.get(f.id) ?? [];
    // El saneador viaja al soporte: el texto libre del nodo de pago —el
    // beneficiario, el nombre del banco extranjero— se limpia por el MISMO
    // camino que `DesCta` y `Concepto`, y por tanto se denuncia igual.
    const soporte = soporteDe(f, L, texto);
    if (soporte.motivoSinComprobante !== undefined) {
      sinComprobante.push({ numUnIdenPol: f.entry_number, motivo: soporte.motivoSinComprobante });
    }
    const mueveDinero = lineas.some((l) => L.dinero.has(l.account_id));

    // DÓNDE CUELGA CADA NODO, y por qué ahí:
    //   · el comprobante, del renglón de la cuenta de CONTROL (la contraparte),
    //     que es la que el documento mueve;
    //   · el pago, del renglón de la CUENTA DE DINERO, que es la que el
    //     movimiento bancario mueve.
    // Colgar los dos del primer renglón habría sido más fácil y habría atado
    // el archivo al orden en que el motor escribe las líneas, que no es un
    // hecho contable.
    const iDinero = lineas.findIndex((l) => L.dinero.has(l.account_id));
    // El renglón de control es el de la cuenta de proveedores o clientes. Si el
    // asiento no toca ninguna —un gasto pagado de contado, un ajuste—, cae al
    // primer renglón que no sea de dinero, y eso ES una convención: se escribe
    // aquí en vez de dejarla implícita en el orden de las líneas.
    const iRol = lineas.findIndex((l) => L.control.has(l.account_id));
    const iControl = iRol >= 0 ? iRol : lineas.findIndex((l) => !L.dinero.has(l.account_id));

    const transacciones: Transaccion[] = lineas.map((l, i) => {
      const debe = importeAnexo24(l.debit_amount ?? '0').texto;
      const haber = importeAnexo24(l.credit_amount ?? '0').texto;
      const comprobantes = i === iControl ? soporte.comprobantes : [];
      const pagos = i === iDinero && soporte.pago !== undefined ? [soporte.pago] : [];
      return {
        numCta: l.code,
        // El nombre de la cuenta también se limpia: un catálogo importado de
        // Excel trae saltos de línea, y el constructor rechaza el atributo
        // entero. Es el mismo caso que el `Desc` del catálogo de F07b.
        desCta: texto(l.name, f.entry_number, `DesCta de ${l.code}`),
        concepto: texto(
          l.description ?? f.description ?? f.entry_number,
          f.entry_number,
          `Concepto del renglón ${l.line_number}`
        ),
        debe,
        haber,
        ...(comprobantes.length > 0 ? { comprobantes } : {}),
        ...(pagos.length > 0 ? { pagos } : {}),
      };
    });

    if (mueveDinero) {
      if (soporte.pago !== undefined && iDinero >= 0) {
        conRastro++;
      } else {
        sinRastro.push({
          numUnIdenPol: f.entry_number,
          motivo:
            soporte.motivoSinRastro ??
            `el asiento toca una cuenta de banco y no viene de ningún pago registrado ` +
              `(source_type ${f.source_type ?? 'nulo'}), así que no hay de dónde sacar la cuenta ` +
              `origen, el banco ni el beneficiario sin inventarlos`,
        });
      }
    }

    polizas.push({
      numUnIdenPol: f.entry_number,
      fecha: f.entry_date,
      concepto: texto(f.description ?? f.entry_number, f.entry_number, 'Concepto de la póliza'),
      transacciones,
    });
  }

  const hallazgos = correrVerificaciones(
    {
      polizas,
      sinRastro,
      sinComprobante,
      bancos: L.catalogoBancos,
      validarUuids: opts.validarUuids === true,
      normalizados,
    },
    opts.checks ?? POLIZA_CHECK_NAMES
  );
  const conteo = contarHallazgos(hallazgos);
  const puedeEntregarse = conteo.blocking === 0;

  const xml = construirPolizasXml({
    rfc: L.e.rfc,
    anio: L.periodo.anio,
    mes: L.periodo.mes,
    solicitud: opts.solicitud,
    polizas,
  });

  const meta: MetaDePolizas = {
    tenant_id: L.e.tenant_id,
    entity_id: entityId,
    rfc: L.e.rfc,
    anio: L.periodo.anio,
    mes: L.periodo.mes,
    period_name: L.periodo.period_name,
    desde: L.periodo.desde,
    hasta: L.periodo.hasta,
    polizas: polizas.length,
    transacciones: polizas.reduce((a, p) => a + p.transacciones.length, 0),
    con_rastro: conRastro,
    criterio_sellado: criterioSellado,
    sellada: false,
    bancos_sembrados: L.catalogoBancos.sembrado,
  };

  const artefacto = await archivarSiProcede(
    { entityId, meta, xml, hallazgos, puedeEntregarse, opts },
    'poliza',
    VERSION_POLIZAS
  );

  return {
    xml,
    hash: hashDelXml(xml),
    bytes: Buffer.byteLength(xml, 'utf8'),
    nombre: nombreDelArchivoDePolizas({ rfc: L.e.rfc, anio: L.periodo.anio, mes: L.periodo.mes }),
    meta,
    hallazgos,
    conteo,
    puedeEntregarse,
    totales: totalesDePolizas(polizas),
    artefacto,
    notaDeSellado: NOTA_SIN_SELLAR,
  };
}

// ------------------------------------------------------------
// LOS DOS AUXILIARES
// ------------------------------------------------------------

export type ClaseDeAuxiliar = 'folios' | 'accounts';

export interface AuxiliarGenerado {
  clase: ClaseDeAuxiliar;
  xml: string;
  hash: string;
  bytes: number;
  nombre: string;
  meta: MetaDePolizas;
  artefacto: ArtefactoArchivado | null;
  notaDeSellado: string;
}

/**
 * `e-accounting subledger generate --kind folios|accounts`.
 *
 * LA FILA DEL CATÁLOGO, LITERAL: «Genera el auxiliar de folios de comprobantes
 * o el auxiliar de cuenta y subcuenta, que el SAT pide sólo a requerimiento».
 * Son dos archivos distintos y `--kind` elige cuál; no hay valor por omisión
 * porque entregar el auxiliar equivocado a un requerimiento es no contestarlo.
 *
 * COMPARTE CON LAS PÓLIZAS TODO LO QUE DE VERDAD ES LO MISMO: la lectura del
 * mayor (`leer`), la cabecera de solicitud, el nodo de comprobante y el
 * serializador. Ver la cabecera de `polizas-auxiliar-xml.ts`.
 */
export async function generarAuxiliar(
  entityId: string,
  clase: ClaseDeAuxiliar,
  opts: OpcionesDePolizas
): Promise<AuxiliarGenerado> {
  const L = await leer(entityId, opts);
  const criterioSellado = await selladoDe(entityId, L.e.tenant_id);

  const base = {
    rfc: L.e.rfc,
    anio: L.periodo.anio,
    mes: L.periodo.mes,
    solicitud: opts.solicitud,
  };

  let xml: string;
  let polizasContadas = 0;
  let transacciones = 0;

  if (clase === 'folios') {
    const detalles: DetalleDeFolios[] = [];
    for (const f of L.filas) {
      const soporte = soporteDe(f, L);
      // Sólo las pólizas CON comprobante. Una sin él no se omite por comodidad:
      // el auxiliar de folios relaciona folios, y un nodo vacío no relaciona
      // nada — el vacío ya lo denuncia `voucher generate`, que es su sitio.
      if (soporte.comprobantes.length === 0) continue;
      detalles.push({
        numUnIdenPol: f.entry_number,
        fecha: f.entry_date,
        comprobantes: soporte.comprobantes,
      });
    }
    polizasContadas = detalles.length;
    transacciones = detalles.reduce((a, d) => a + d.comprobantes.length, 0);
    xml = construirAuxiliarFoliosXml({ ...base, detalles });
  } else {
    const cuentas = await cuentasDelAuxiliar(entityId, L);
    polizasContadas = L.filas.length;
    transacciones = cuentas.reduce((a, c) => a + c.movimientos.length, 0);
    xml = construirAuxiliarCuentasXml({ ...base, cuentas });
  }

  const meta: MetaDePolizas = {
    tenant_id: L.e.tenant_id,
    entity_id: entityId,
    rfc: L.e.rfc,
    anio: L.periodo.anio,
    mes: L.periodo.mes,
    period_name: L.periodo.period_name,
    desde: L.periodo.desde,
    hasta: L.periodo.hasta,
    polizas: polizasContadas,
    transacciones,
    con_rastro: 0,
    criterio_sellado: criterioSellado,
    sellada: false,
    bancos_sembrados: L.catalogoBancos.sembrado,
  };

  const artefacto = await archivarSiProcede(
    { entityId, meta, xml, hallazgos: [], puedeEntregarse: true, opts },
    clase === 'folios' ? 'auxiliar_folios' : 'auxiliar_cuentas',
    clase === 'folios' ? VERSION_AUX_FOLIOS : VERSION_AUX_CTAS
  );

  return {
    clase,
    xml,
    hash: hashDelXml(xml),
    bytes: Buffer.byteLength(xml, 'utf8'),
    nombre: nombreDelArchivoAuxiliar(base, clase),
    meta,
    artefacto,
    notaDeSellado: NOTA_SIN_SELLAR,
  };
}

/**
 * Las cuentas del auxiliar, con su saldo inicial y final.
 *
 * LOS SALDOS NO SE VUELVEN A CALCULAR: salen de `getTrialBalance`, que es la
 * misma función que alimenta la balanza de F07b, y el SIGNO se resuelve con
 * `formatearImporte` y `naturDe`, que son las de `balanza-invariantes`. Repetir
 * aquí la resta de saldos habría sido la enésima copia — y, peor, una copia con
 * la trampa dentro: el mayor lleva la cuenta acreedora en negativo y el Anexo
 * 24 la declara en su propia naturaleza. Un `abs()` da la misma cifra por la
 * razón equivocada y falla justo en la acreedora sobregirada.
 */
async function cuentasDelAuxiliar(entityId: string, L: Lectura): Promise<CuentaAuxiliar[]> {
  const tb = await getTrialBalance(entityId, {
    ...(L.periodo.fiscal_period_id !== undefined
      ? { fiscalPeriodId: L.periodo.fiscal_period_id }
      : { sinceDate: L.periodo.desde, untilDate: L.periodo.hasta }),
  });

  // La naturaleza NO viene en la balanza y se pide aparte, de `normal_balance`
  // y no de `account_type`: una `contra_asset` —la depreciación acumulada— es
  // de tipo activo y de naturaleza ACREEDORA, y derivarla del tipo la
  // publicaría del revés. Es la nota de `naturDe` en balanza-invariantes.
  const nb = await query<{ account_id: string; normal_balance: string }>(
    `SELECT id::text AS account_id, normal_balance FROM accounts WHERE entity_id = $1`,
    [entityId]
  );
  const naturPorCuenta = new Map(nb.rows.map((r) => [r.account_id, naturDe(r.normal_balance)]));

  const saldos = new Map<string, { ini: string; fin: string; code: string; name: string }>();
  for (const r of tb.rows) {
    saldos.set(r.account_id, {
      ini: r.beginning_balance ?? '0',
      fin: r.final_balance ?? r.ending_balance,
      code: r.account_code,
      name: r.account_name,
    });
  }

  // Los movimientos, por cuenta, en el orden en que el mayor los tiene.
  const porCuenta = new Map<string, MovimientoAuxiliar[]>();
  const nombres = new Map<string, { code: string; name: string }>();
  for (const f of L.filas) {
    for (const l of L.renglones.get(f.id) ?? []) {
      const lista = porCuenta.get(l.account_id) ?? [];
      lista.push({
        fecha: f.entry_date,
        numUnIdenPol: f.entry_number,
        concepto: limpiar(l.description ?? f.description ?? f.entry_number).texto,
        debe: importeAnexo24(l.debit_amount ?? '0').texto,
        haber: importeAnexo24(l.credit_amount ?? '0').texto,
      });
      porCuenta.set(l.account_id, lista);
      nombres.set(l.account_id, { code: l.code, name: l.name });
    }
  }

  const cuentas: CuentaAuxiliar[] = [];
  for (const [accountId, movimientos] of porCuenta) {
    const s = saldos.get(accountId);
    const n = nombres.get(accountId);
    if (!n) continue;
    const signo = (naturPorCuenta.get(accountId) ?? 'D') === 'A' ? -1 : 1;
    cuentas.push({
      numCta: n.code,
      desCta: limpiar(n.name).texto,
      saldoIni: formatearImporte(new Decimal(s?.ini ?? '0').times(signo)),
      saldoFin: formatearImporte(new Decimal(s?.fin ?? '0').times(signo)),
      movimientos,
    });
  }
  // Por NumCta: el orden de las filas es parte de los bytes, y los bytes son lo
  // que un humano compara contra la entrega del mes pasado.
  cuentas.sort((a, b) => (a.numCta < b.numCta ? -1 : a.numCta > b.numCta ? 1 : 0));
  return cuentas;
}

// ------------------------------------------------------------
// LO COMÚN
// ------------------------------------------------------------

/**
 * El criterio de sellado. Se lee con su clave literal dentro de la llamada,
 * que es lo que E1.3 mide y lo que hace que contestar el panel cambie algo:
 * el valor viaja al artefacto, para que dentro de seis meses nadie tenga que
 * adivinar si aquel archivo iba firmado.
 */
async function selladoDe(entityId: string, tenantId: string): Promise<string> {
  // El contexto lleva SIEMPRE la entidad, no sólo el inquilino: dos sociedades
  // del mismo despacho pueden haber contestado distinto sobre su e.firma. Es
  // el mismo criterio que `contextoDePolitica` en balanza-service.
  const ctx = { tenantId: currentTenant() ?? tenantId, entityId };
  return (await getPolicy(ctx, 'efirma_sellado_contabilidad_electronica')).value;
}

async function archivarSiProcede(
  a: {
    entityId: string;
    meta: MetaDePolizas;
    xml: string;
    hallazgos: readonly HallazgoPoliza[];
    puedeEntregarse: boolean;
    opts: OpcionesDePolizas;
  },
  tipo: 'poliza' | 'auxiliar_folios' | 'auxiliar_cuentas',
  version: string
): Promise<ArtefactoArchivado | null> {
  const generadoPor = a.opts.dryRun === true ? undefined : a.opts.generadoPor;
  if (generadoPor === undefined || !a.puedeEntregarse) return null;
  return archivarArtefacto({
    tenantId: a.meta.tenant_id,
    entityId: a.entityId,
    tipo,
    version,
    rfc: a.meta.rfc,
    anio: a.meta.anio,
    mes: Number(a.meta.mes),
    tipoEnvio: 'N',
    xml: a.xml,
    politicaSellado: a.meta.criterio_sellado,
    hallazgos: a.hallazgos,
    generadoPor,
  });
}

/**
 * Deja el texto en condiciones de viajar en un atributo, Y DICE SI LO CAMBIÓ.
 *
 * `exigirValorDeAtributo` (xml.ts) RECHAZA el salto de línea, y con razón: la
 * normalización de XML 1.0 lo convertiría en espacio a espaldas del
 * contribuyente. Pero un concepto de asiento con salto de línea es un dato
 * normal —se teclea en un editor, o se pega desde Excel—, así que se limpia
 * ANTES en vez de dejar que el archivo entero muera por una póliza.
 *
 * Devolver `cambiado` no es un detalle: es lo que permite DENUNCIARLO, que es
 * el criterio exacto de `CAT-DESC-NORMALIZADA` en el catálogo de F07b. Limpiar
 * en silencio entrega un texto que el contribuyente nunca escribió.
 *
 * El texto vacío sale como `-`: un atributo obligatorio vacío invalida el
 * nodo, y un guion se ve.
 */
function limpiar(texto: string): { texto: string; cambiado: boolean } {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio === '') return { texto: '-', cambiado: texto !== '-' };
  return { texto: limpio, cambiado: limpio !== texto };
}
