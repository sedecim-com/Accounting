import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { requireByIdInScope, type Scope } from '../../database/scope.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { FLOOR_MAX_AUTO_POST, floorMaxAutoAmount } from '../../ai/floor.js';
import { MATCHED_ENTITY_TYPES } from '../../database/enums.js';
import { descriptionSimilarity, findBestMatch } from './matching.js';
import type { BankTransaction } from '../../types/index.js';

// ============================================================
// EL COTEJO COMO HECHO (F05b · 052)
//
// El motor de `matching.ts` lleva desde abril proponiendo pares y aplicándolos
// él mismo, sin nadie en medio. Este servicio es ese «en medio»: quien decide
// si una propuesta se convierte en aseveración, y quien la sabe deshacer.
//
// TRES INVARIANTES SOSTIENEN EL ARCHIVO ENTERO.
//
// 1. Σbanco = Σlibros + Σajustes + residual, comprobada ANTES de escribir y
//    con decimal.js. No es adorno: sin ella, «cotejar» degenera en marcar dos
//    filas como amigas. La igualdad se comprueba SIEMPRE, también en el camino
//    automático —donde el único residual admisible es cero, porque no hay
//    humano que declare qué hacer con lo que sobra—. El rechazo nombra los
//    tres números y la diferencia: un descuadre que sólo dice «no cuadra» hace
//    que alguien tenga que rehacer la resta a mano.
//
// 2. TODO MOVIMIENTO MARCADO TIENE FILA DE COTEJO VIVA. La escritura de
//    `matching.ts` hacía el UPDATE y el INSERT en dos `query()` sueltas: si el
//    segundo fallaba, el movimiento quedaba `is_matched = true` sin cotejo, o
//    sea invisible a la vez para «no cotejados» y para «cotejados». Aquí toda
//    escritura va en UNA transacción, y `crearGrupoDeCotejo` rechaza un grupo
//    en el que algún movimiento no reciba asignación: un movimiento sellado sin
//    fila que lo explique es el mismo agujero por otra puerta.
//
// 3. EL SELLO ES LA ÚNICA MUTACIÓN ADMISIBLE SOBRE UNA LÍNEA POSTEADA. La 041
//    abre exactamente tres columnas —`is_reconciled`, `reconciled_at`,
//    `reconciliation_id`— y la 052 exige por CHECK que vayan juntas o vacías.
//    Este archivo no escribe NINGUNA otra columna de `journal_entry_lines` ni
//    toca `journal_entries` en ningún camino. Si algún día un cotejo necesitara
//    cambiar otra cosa de un asiento, el diseño estaría mal: se reporta, no se
//    fuerza.
//
// LA FRONTERA. Ni `bank_transactions` ni `reconciliation_matches` tienen
// `entity_id`: cuelgan de `bank_account_id` → `bank_accounts.entity_id`. Cada
// lectura y cada escritura de aquí lleva ese JOIN DENTRO del SQL. Cero filas
// significa a la vez «no existe» y «no es tuya», y las dos devuelven lo mismo.
//
// DOS FASES, UNA TRANSACCIÓN. El motor lee por el pool (`query`), no por el
// cliente de la transacción, así que proponer DENTRO de la transacción leería
// un mundo anterior a sus propias escrituras y además retendría dos conexiones
// a la vez. Por eso `run` y `apply` PROPONEN fuera (lectura pura) y APLICAN
// dentro, revalidando bajo candado lo que la propuesta asumió. El acto sigue
// siendo atómico: lo que se escribe, se escribe entero o nada.
// ============================================================

export type TipoCotejable = (typeof MATCHED_ENTITY_TYPES)[number];

export const MODOS_RESIDUAL = ['keep', 'write-off'] as const;
export type ModoResidual = (typeof MODOS_RESIDUAL)[number];

/**
 * Los motivos de desaplicación, TIPIFICADOS y cerrados.
 *
 * La 052 pide código y no prosa («para que las causas se puedan contar, no
 * sólo leer»), y la columna admite 40 caracteres. Una taxonomía cerrada es lo
 * que permite preguntar «¿cuántos cotejos deshicimos por documento cancelado
 * este trimestre?»; un campo libre contesta esa pregunta con un grep.
 */
export const MOTIVOS_DESAPLICACION = [
  'cotejo-erroneo',
  'monto-incorrecto',
  'duplicado',
  'movimiento-reversado',
  'documento-cancelado',
  'reclasificacion',
  'error-de-captura',
] as const;
export type MotivoDesaplicacion = (typeof MOTIVOS_DESAPLICACION)[number];

/**
 * Por qué una propuesta del motor NO se aplica. Cerrado a propósito: `run`
 * omite en vez de lanzar, y una lista de omisiones sólo sirve si se puede
 * agrupar y contar.
 */
export const MOTIVOS_OMISION = [
  'sin-candidato',
  'confianza-baja',
  'monto-sobre-piso',
  'periodo-cerrado',
  'importe-no-exacto',
  'direccion-opuesta',
  'fuera-de-ventana',
  'candidato-ocupado',
  'ya-cotejado',
  'candidato-inexistente',
  /**
   * La regla que lo halló dijo que su hallazgo NO se aplica solo: lo único que
   * separa a este candidato de otro igual de plausible es el parecido del
   * texto. Es distinto de `importe-no-exacto` —ahí el importe no casaba; aquí
   * casa, pero casa también con otro—.
   */
  'solo-similitud',
] as const;
export type MotivoOmision = (typeof MOTIVOS_OMISION)[number];

/**
 * La ventana de fecha que hace DURA a una señal, en días. Es la misma que usa
 * la regla 2 del motor (`exact_amount_near_date`): no se inventa un número
 * nuevo para la misma pregunta.
 */
const VENTANA_DIAS = 3;

/** Confianza mínima por omisión de `run`, la que el motor ya usaba al cruzar. */
const CONFIANZA_POR_OMISION = 0.85;

/**
 * Cuántos movimientos se proponen como máximo de una vez. Existe porque el
 * motor hace tres consultas de candidatos POR MOVIMIENTO, y una cuenta con
 * cuarenta mil líneas sin conciliar tumbaría el proceso antes de escribir
 * nada. Lo que no puede pasar es que el tope recorte EN SILENCIO: tanto
 * `previsualizarCotejo` como `correrCotejo` dicen cuándo lo alcanzaron, para
 * que «se cotejaron 200» no se lea como «no quedaba nada más».
 */
const LIMITE_PROPUESTAS = 500;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// LA ARITMÉTICA DEL GRUPO, SIN BASE DE DATOS
//
// Todo lo que sigue hasta el siguiente separador es función pura. Está aquí
// separado porque es la parte que DECIDE si un grupo puede escribirse, y
// probarla exige exactamente cero filas sembradas: el caso del pago corto por
// comisión, el del depósito que agrupa tres cobros y el del residual de un
// centavo son tres llamadas, no tres escenarios de integración.
// ============================================================

/** Un importe que entra al grupo, FIRMADO como lo estaría en el extracto. */
export interface ImporteDeGrupo {
  id: string;
  /** Money as string. Positivo entra al banco, negativo sale. */
  importe: string;
}

/** Un ajuste declarado por quien arma el grupo: comisión, diferencia cambiaria. */
export interface AjusteDeGrupo {
  concepto: string;
  importe: string;
}

export interface CuadreDeGrupo {
  totalBanco: string;
  totalLibros: string;
  totalAjustes: string;
  /** Σbanco − Σlibros − Σajustes. Lo que sobra, con su signo. */
  diferencia: string;
  cuadra: boolean;
}

/**
 * EL SIGNO, que aquí no es un detalle sino lo que distingue un cotejo de una
 * coincidencia numérica.
 *
 * `bank_transactions.amount` viene firmado del banco —`tipoDeMovimiento` lo
 * confirma: negativo es cargo, positivo abono—. El lado de libros tiene que
 * hablar el mismo idioma o la igualdad se cumpliría cotejando un depósito
 * contra un pago, dos hechos que se anulan, y nadie lo notaría.
 *
 *   · `invoice` y `customer_payment` son dinero que ENTRA  → +1
 *   · `bill` y `vendor_payment` son dinero que SALE        → −1
 *   · `journal_entry_line` lo dice su propia naturaleza: un CARGO a la cuenta
 *     de banco es dinero que entra, un ABONO es dinero que sale. Por eso su
 *     signo no sale de aquí sino de qué columna trae importe.
 */
export function signoDe(tipo: Exclude<TipoCotejable, 'journal_entry_line'>): 1 | -1 {
  return tipo === 'invoice' || tipo === 'customer_payment' ? 1 : -1;
}

function sumar(importes: readonly string[]): Decimal {
  return importes.reduce((acc, i) => acc.plus(new Decimal(i)), new Decimal(0));
}

/**
 * Las tres sumas y la diferencia. No decide nada: sólo dice qué hay.
 *
 * Cuatro decimales en toda la salida porque cuatro son los que guarda la
 * columna. Presentarla a dos aquí fue el defecto que F05a cazó tres veces: el
 * recorte convierte un descuadre de medio centavo en un cuadre perfecto, y el
 * medio centavo reaparece en la sesión sin nadie que sepa de dónde salió.
 */
export function cuadrarGrupo(
  banco: readonly ImporteDeGrupo[],
  libros: readonly ImporteDeGrupo[],
  ajustes: readonly AjusteDeGrupo[] = []
): CuadreDeGrupo {
  const totalBanco = sumar(banco.map((b) => b.importe));
  const totalLibros = sumar(libros.map((l) => l.importe));
  const totalAjustes = sumar(ajustes.map((a) => a.importe));
  const diferencia = totalBanco.minus(totalLibros).minus(totalAjustes);

  return {
    totalBanco: totalBanco.toFixed(4),
    totalLibros: totalLibros.toFixed(4),
    totalAjustes: totalAjustes.toFixed(4),
    diferencia: diferencia.toFixed(4),
    cuadra: diferencia.isZero(),
  };
}

export interface ResidualDeclarado {
  modo?: ModoResidual;
  cuentaWriteOff?: string | null;
}

export interface ResidualResuelto {
  residual: string;
  modo: ModoResidual;
  cuentaWriteOff: string | null;
}

/**
 * La compuerta: o el grupo cuadra, o alguien DECLARÓ qué hacer con lo que
 * sobra. No hay tercera opción, y ésa es toda la diferencia entre una
 * conciliación y una lista de parejas.
 *
 * Un descuadre sin declarar se rechaza NOMBRANDO LOS TRES NÚMEROS Y LA
 * DIFERENCIA. El mensaje que sólo dice «no cuadra» obliga a quien lo lee a
 * rehacer la resta para saber de qué lado falta, que es justo el trabajo que
 * el instrumento existe para ahorrar.
 *
 * `write-off` sin cuenta lo rechaza también el CHECK de la 052, pero llegar
 * ahí devolvería un 23514 en vez de una frase: el CHECK es la red, no la
 * puerta.
 */
export function exigirCuadre(
  cuadre: CuadreDeGrupo,
  declarado: ResidualDeclarado = {}
): ResidualResuelto {
  const diferencia = new Decimal(cuadre.diferencia);
  const modo = declarado.modo ?? 'keep';
  const cuenta = declarado.cuentaWriteOff ?? null;

  if (diferencia.isZero()) {
    // Un `write-off` sobre cero no cancela nada y deja en el expediente una
    // cuenta de cancelación que nunca se usó: se rechaza en vez de guardarse
    // como aseveración vacía.
    if (declarado.modo === 'write-off') {
      throw new ValidationError(
        'El grupo cuadra exacto (residual 0.0000): no hay nada que cancelar, ' +
        'así que --residual write-off sobra. Usa keep o quita la bandera.'
      );
    }
    return { residual: '0.0000', modo: 'keep', cuentaWriteOff: null };
  }

  if (declarado.modo === undefined) {
    throw new ValidationError(
      `El grupo no cuadra y nadie declaró qué hacer con lo que sobra. ` +
      `Banco ${cuadre.totalBanco} = Libros ${cuadre.totalLibros} + ` +
      `Ajustes ${cuadre.totalAjustes} deja una diferencia de ${cuadre.diferencia}. ` +
      `Declárala con --residual keep (queda viva como partida conciliatoria) o ` +
      `--residual write-off --write-off-account <cuenta> (se cancela contra esa cuenta), ` +
      `o corrige las partidas del grupo.`
    );
  }

  if (modo === 'write-off' && !cuenta) {
    throw new ValidationError(
      `Un residual de ${cuadre.diferencia} que se cancela necesita cuenta: ` +
      `--residual write-off exige --write-off-account. Sin ella el dinero se ` +
      `quedaría sin destino y el descuadre reaparecería en la sesión.`
    );
  }

  if (modo === 'keep' && cuenta) {
    throw new ValidationError(
      '--write-off-account sólo tiene sentido con --residual write-off: un ' +
      'residual que se conserva no se cancela contra ninguna cuenta.'
    );
  }

  return { residual: diferencia.toFixed(4), modo, cuentaWriteOff: modo === 'write-off' ? cuenta : null };
}

/** Ningún id puede entrar dos veces al mismo lado de un grupo. */
export function exigirSinRepetidos(ids: readonly string[], que: string): void {
  const vistos = new Set<string>();
  for (const id of ids) {
    if (vistos.has(id)) {
      throw new ValidationError(
        `El ${que} ${id} aparece dos veces en el grupo: su importe contaría doble y el ` +
        `grupo cuadraría afirmando el doble de lo que hay.`
      );
    }
    vistos.add(id);
  }
}

/** Una asignación concreta: este movimiento de banco contra esta partida de libros. */
export interface Asignacion {
  bancoId: string;
  librosId: string;
  /** Money as string, SIN signo: la columna `matched_amount` es una magnitud. */
  importe: string;
  /** Cierto cuando la asignación no agota ni el movimiento ni la partida. */
  parcial: boolean;
}

/**
 * El reparto N:M, que es lo que `reconciliation_matches` sabe guardar.
 *
 * La tabla es UNA FILA POR MOVIMIENTO con UN `matched_entity_id` (003:102):
 * no puede expresar «tres depósitos contra cinco facturas» de un golpe. Lo que
 * sí puede es expresar el reparto: una fila por PAREJA, con el importe que le
 * tocó y `is_partial` cuando no agota ninguno de los dos lados. Esa columna
 * lleva ahí desde la 003 esperando exactamente este caso.
 *
 * El reparto es voraz y EN EL ORDEN DADO, no proporcional: un reparto
 * proporcional produce centavos irrepetibles y nadie puede explicar de dónde
 * salió el tercer decimal de la cuarta fila. Voraz y en orden se explica con
 * el dedo sobre la pantalla.
 *
 * Trabaja sobre magnitudes; el signo ya lo comprobó `cuadrarGrupo`.
 */
export function asignarGrupo(
  banco: readonly ImporteDeGrupo[],
  libros: readonly ImporteDeGrupo[]
): Asignacion[] {
  const pendienteBanco = banco.map((b) => ({ id: b.id, resto: new Decimal(b.importe).abs() }));
  const pendienteLibros = libros.map((l) => ({ id: l.id, resto: new Decimal(l.importe).abs() }));

  const asignaciones: Asignacion[] = [];
  let i = 0;
  let j = 0;

  while (i < pendienteBanco.length && j < pendienteLibros.length) {
    const b = pendienteBanco[i];
    const l = pendienteLibros[j];
    const importe = Decimal.min(b.resto, l.resto);

    if (importe.isZero()) {
      // Un lado ya está agotado (o entró en cero): avanza el agotado sin
      // fabricar una fila de importe cero, que sería un cotejo que no coteja.
      if (b.resto.isZero()) i++;
      else j++;
      continue;
    }

    const totalBanco = new Decimal(banco[i].importe).abs();
    const totalLibros = new Decimal(libros[j].importe).abs();
    asignaciones.push({
      bancoId: b.id,
      librosId: l.id,
      importe: importe.toFixed(4),
      parcial: !importe.equals(totalBanco) || !importe.equals(totalLibros),
    });

    b.resto = b.resto.minus(importe);
    l.resto = l.resto.minus(importe);
    if (b.resto.isZero()) i++;
    if (l.resto.isZero()) j++;
  }

  return asignaciones;
}

/** Las señales observables de una pareja. No es el puntaje del motor: son los hechos. */
export interface SenalesDeCotejo {
  importeBanco: string;
  importeCandidato: string;
  diferenciaImporte: string;
  importeExacto: boolean;
  mismaDireccion: boolean;
  diasDeDiferencia: number;
  dentroDeVentana: boolean;
  similitudDescripcion: number;
  /** Falso cuando lo ÚNICO que sostiene el cotejo es el parecido del texto. */
  senalDura: boolean;
}

/**
 * LA REGLA QUE EL CATÁLOGO ESCRIBE EN NEGATIVO: «nunca aplica un cotejo cuya
 * única señal sea similitud de descripción» (fila 1225).
 *
 * Se comprueba sobre HECHOS de la pareja y no sobre qué regla del motor
 * disparó, por dos razones. La primera es que `findBestMatch` devuelve un
 * escalar de confianza y no dice qué regla lo produjo, así que inferirla del
 * número sería adivinar. La segunda es mejor: una compuerta que depende de los
 * internos del motor deja de valer el día que el motor cambia sus pesos, y
 * ésta tiene que seguir valiendo.
 *
 * La señal dura es EL IMPORTE EXACTO, en la misma dirección. La regla difusa
 * del motor absorbe hasta un 5 % de diferencia en silencio y la ponderada
 * decide con la descripción los desempates que las dos primeras reglas ya
 * habían rechazado por ambiguos: ninguna de las dos cosas debe convertirse en
 * una aseveración sin que un humano la firme.
 */
/**
 * El parecido de dos textos, con el guardia que la función del motor no trae.
 *
 * `descriptionSimilarity` compara primero por igualdad y sólo DESPUÉS descarta
 * los vacíos (matching.ts:85-86), así que dos descripciones AUSENTES le
 * puntúan 1.0: parecido perfecto entre dos nadas. El motor no lo sufre porque
 * sus tres llamadas van guardadas por `tx.description && c.description`, pero
 * la función es pública y el siguiente que la use lo pisa —esta línea lo pisó
 * y una prueba lo cazó—. Aquí importa el doble: una previsualización que
 * anuncia «similitud 1.00» sobre dos movimientos sin texto está mintiéndole a
 * quien decide.
 *
 * Se guarda desde fuera porque `matching.ts` es de otro frente. Si allí se
 * invierte el orden de esas dos líneas, este guardia sobra y se quita.
 */
function similitudDeTexto(a: string | null, b: string | null): number {
  if (!a?.trim() || !b?.trim()) return 0;
  return Math.round(descriptionSimilarity(a, b) * 100) / 100;
}

export function medirSenales(
  importeBanco: string,
  fechaBanco: Date,
  descripcionBanco: string | null,
  importeCandidato: string,
  fechaCandidato: Date,
  descripcionCandidato: string | null
): SenalesDeCotejo {
  const banco = new Decimal(importeBanco);
  const candidato = new Decimal(importeCandidato);
  const diferencia = banco.minus(candidato);

  const dias = Math.round(
    Math.abs(fechaBanco.getTime() - fechaCandidato.getTime()) / MS_POR_DIA
  );
  const importeExacto = diferencia.isZero();

  return {
    importeBanco: banco.toFixed(4),
    importeCandidato: candidato.toFixed(4),
    diferenciaImporte: diferencia.toFixed(4),
    importeExacto,
    mismaDireccion: banco.isNegative() === candidato.isNegative(),
    diasDeDiferencia: dias,
    dentroDeVentana: dias <= VENTANA_DIAS,
    similitudDescripcion: similitudDeTexto(descripcionBanco, descripcionCandidato),
    senalDura: importeExacto,
  };
}

// ============================================================
// LO QUE SÍ TOCA LA BASE
// ============================================================

interface FilaMovimiento {
  id: string;
  bank_account_id: string;
  transaction_date: Date;
  amount: string;
  description: string | null;
  merchant_name: string | null;
  is_matched: boolean;
}

interface FilaCandidato {
  /** Firmado en la dirección del extracto. */
  importe: string;
  fecha: Date;
  descripcion: string | null;
  referencia: string | null;
  /** Sólo para `journal_entry_line`: el estado de su asiento. */
  estadoAsiento?: string;
}

/** La entidad del alcance, exigiendo que la cuenta bancaria sea suya. */
async function entidadDeLaCuenta(scope: Scope, cuentaId: string): Promise<string> {
  if (!UUID_RE.test(cuentaId)) throw new NotFoundError('Bank Account', cuentaId);
  const cuenta = await requireByIdInScope<{ entity_id: string }>(
    'bank_accounts',
    cuentaId,
    scope,
    { columns: 'entity_id' }
  );
  return cuenta.entity_id;
}

/**
 * El candidato, leído por su tipo y ACOTADO POR ENTIDAD dentro del SQL.
 *
 * Devuelve el SALDO, no el total, para facturas y gastos. Es el mismo defecto
 * que el motor tenía al proyectar `total_amount` después de filtrar por
 * `amount_due`: una factura de 1160 cobrada a medias entra al rango por sus
 * 500 pendientes y luego se compara contra 1160, así que una factura
 * parcialmente pagada —el caso más común de toda conciliación real— no podía
 * casar jamás. Aquí se lee lo que queda por cobrar, que es lo que el
 * movimiento de banco puede estar pagando.
 *
 * `cuentaBancariaId` no es opcional a propósito: una partida de libros de una
 * conciliación bancaria es una línea de LA CUENTA DE MAYOR DE ESA CUENTA, y
 * dejarlo por omisión invitaría a volver a leer cualquier línea de la entidad.
 */
async function leerCandidato(
  cliente: pg.PoolClient | null,
  entityId: string,
  tipo: TipoCotejable,
  id: string,
  cuentaBancariaId: string
): Promise<FilaCandidato | null> {
  if (!UUID_RE.test(id)) return null;
  const correr = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    cliente ? cliente.query<T>(sql, params) : query<T>(sql, params);

  if (tipo === 'journal_entry_line') {
    const r = await correr<{
      debit_amount: string | null;
      credit_amount: string | null;
      fecha: Date;
      descripcion: string | null;
      referencia: string | null;
      estado: string;
    }>(
      // LA PARTIDA TIENE QUE SER DE LA CUENTA DE MAYOR DE ESTA CUENTA BANCARIA.
      //
      // Sin el JOIN a `bank_accounts` esta lectura admitía cualquier línea
      // posteada de la entidad, y `bank match create --book-item <renta>` la
      // sellaba: una línea de gasto quedaba marcada como conciliada contra un
      // banco que nunca la mostró, y ninguna conciliación legítima podía ya
      // usarla. `listarPartidasDeLibros` —la hoja que produce los ids de
      // `--book-item`— acota exactamente así, y las dos tienen que coincidir o
      // el listado deja de predecir lo que la escritura acepta.
      //
      // La cuenta se acota TAMBIÉN por entidad aunque el llamador ya la haya
      // resuelto: la condición vive dentro del SQL y no en la memoria de quien
      // llama.
      `SELECT jel.debit_amount, jel.credit_amount, je.entry_date AS fecha,
              COALESCE(jel.description, je.description) AS descripcion,
              je.entry_number AS referencia, je.status AS estado
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN bank_accounts ba   ON ba.gl_account_id = jel.account_id
        WHERE jel.id = $1 AND je.entity_id = $2
          AND ba.id = $3 AND ba.entity_id = $2`,
      [id, entityId, cuentaBancariaId]
    );
    const fila = r.rows[0];
    if (!fila) return null;
    // Un CARGO a la cuenta de banco es dinero que entra; un ABONO, que sale.
    const importe = fila.debit_amount !== null
      ? new Decimal(fila.debit_amount)
      : new Decimal(fila.credit_amount ?? '0').negated();
    return {
      importe: importe.toFixed(4),
      fecha: new Date(fila.fecha),
      descripcion: fila.descripcion,
      referencia: fila.referencia,
      estadoAsiento: fila.estado,
    };
  }

  const fuentes: Record<Exclude<TipoCotejable, 'journal_entry_line'>, string> = {
    invoice:
      `SELECT COALESCE(amount_due, total_amount) AS importe, invoice_date AS fecha,
              description AS descripcion, invoice_number AS referencia
         FROM invoices WHERE id = $1 AND entity_id = $2`,
    bill:
      `SELECT COALESCE(amount_due, total_amount) AS importe, bill_date AS fecha,
              description AS descripcion, bill_number AS referencia
         FROM bills WHERE id = $1 AND entity_id = $2`,
    customer_payment:
      `SELECT payment_amount AS importe, payment_date AS fecha,
              memo AS descripcion, payment_number AS referencia
         FROM customer_payments WHERE id = $1 AND entity_id = $2`,
    vendor_payment:
      `SELECT payment_amount AS importe, payment_date AS fecha,
              memo AS descripcion, payment_number AS referencia
         FROM vendor_payments WHERE id = $1 AND entity_id = $2`,
  };

  const r = await correr<{
    importe: string;
    fecha: Date;
    descripcion: string | null;
    referencia: string | null;
  }>(fuentes[tipo], [id, entityId]);
  const fila = r.rows[0];
  if (!fila) return null;

  return {
    importe: new Decimal(fila.importe).abs().times(signoDe(tipo)).toFixed(4),
    fecha: new Date(fila.fecha),
    descripcion: fila.descripcion,
    referencia: fila.referencia,
  };
}

interface PeriodoDelMovimiento {
  id: string;
  status: string;
  period_name: string;
}

/**
 * El periodo fiscal que contiene la fecha. FALLA CERRADO: si no hay periodo
 * que la cubra, no hay periodo abierto, y el cotejo no entra.
 */
async function periodoDe(
  cliente: pg.PoolClient | null,
  entityId: string,
  fecha: Date
): Promise<PeriodoDelMovimiento | null> {
  const sql =
    `SELECT id, status, period_name
       FROM fiscal_periods
      WHERE entity_id = $1 AND $2::date BETWEEN start_date AND end_date
      ORDER BY period_number
      LIMIT 1`;
  const params = [entityId, fecha.toISOString().split('T')[0]];
  const r = cliente
    ? await cliente.query<PeriodoDelMovimiento>(sql, params)
    : await query<PeriodoDelMovimiento>(sql, params);
  return r.rows[0] ?? null;
}

/**
 * El candado de periodo, con dos durezas a propósito.
 *
 * El camino AUTOMÁTICO (`run`) exige `open` y nada más: el catálogo lo pide
 * literalmente, y un periodo en cierre suave está justamente en el momento en
 * que nadie quiere que una máquina le añada aseveraciones sola.
 *
 * El camino HUMANO (`apply`, `create`) sólo se rehúsa donde el mayor está
 * congelado —`hard_close` y `locked`—. Conciliar enero durante febrero con
 * enero en cierre suave es trabajo normal de un despacho, y prohibirlo
 * empujaría a la gente a reabrir periodos, que es peor.
 */
function periodoAdmite(periodo: PeriodoDelMovimiento | null, estricto: boolean): boolean {
  if (!periodo) return false;
  if (estricto) return periodo.status === 'open';
  return periodo.status !== 'hard_close' && periodo.status !== 'locked';
}

// ============================================================
// EL SELLO DE LA PARTIDA DE LIBROS
//
// Las tres columnas que la 041 deja escribir sobre una línea posteada, y que
// la 052 obliga a mover juntas. Nadie las había escrito nunca: por eso la
// misma partida se volvía a proponer para siempre.
//
// NOTA DE INTEGRACIÓN: si `matching.ts` termina exportando `sellarPartidas` /
// `liberarPartidas` con esta misma firma, bórrense estas dos e impórtense de
// allí. Viven aquí porque el sello es una ESCRITURA y `matching.ts` es el
// motor de lectura; y porque un símbolo importado que aún no existe no
// compila, y este archivo tiene que compilar hoy.
// ============================================================

/**
 * Sella las partidas con el grupo que las cotejó. Acotado por entidad DENTRO
 * del SQL vía el JOIN al asiento, que es donde vive `entity_id`.
 *
 * Idempotente respecto del MISMO grupo: volver a sellar lo que este grupo ya
 * selló no es un error. Sellar lo que selló OTRO grupo sí lo es, y se nombra.
 */
export async function sellarPartidas(
  client: pg.PoolClient,
  entityId: string,
  groupId: string,
  lineaIds: readonly string[]
): Promise<string[]> {
  if (lineaIds.length === 0) return [];

  const previas = await client.query<{ id: string; reconciliation_id: string | null }>(
    `SELECT jel.id, jel.reconciliation_id
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.id = ANY($1::uuid[]) AND je.entity_id = $2
      FOR UPDATE OF jel`,
    [[...lineaIds], entityId]
  );

  if (previas.rows.length !== lineaIds.length) {
    const vistas = new Set(previas.rows.map((f) => f.id));
    const perdidas = lineaIds.filter((id) => !vistas.has(id));
    throw new NotFoundError('Journal Entry Line', perdidas.join(', '));
  }

  const ajena = previas.rows.find(
    (f) => f.reconciliation_id !== null && f.reconciliation_id !== groupId
  );
  if (ajena) {
    throw new ConflictError(
      `La partida ${ajena.id} ya está sellada por el grupo de cotejo ` +
      `${ajena.reconciliation_id ?? ''}. Desaplica ese cotejo antes de volver a cotejarla.`
    );
  }

  const r = await client.query<{ id: string }>(
    `UPDATE journal_entry_lines jel
        SET is_reconciled = true, reconciled_at = NOW(), reconciliation_id = $1
       FROM journal_entries je
      WHERE je.id = jel.journal_entry_id
        AND jel.id = ANY($2::uuid[])
        AND je.entity_id = $3
        AND jel.reconciliation_id IS DISTINCT FROM $1
      RETURNING jel.id`,
    [groupId, [...lineaIds], entityId]
  );
  return r.rows.map((f) => f.id);
}

/**
 * Libera el sello de todas las partidas que llevaban este grupo. Las tres
 * columnas vuelven a vaciarse JUNTAS: el CHECK `jel_sello_coherente` no
 * admite término medio, y tampoco debería.
 */
export async function liberarPartidas(
  client: pg.PoolClient,
  entityId: string,
  groupId: string
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `UPDATE journal_entry_lines jel
        SET is_reconciled = false, reconciled_at = NULL, reconciliation_id = NULL
       FROM journal_entries je
      WHERE je.id = jel.journal_entry_id
        AND jel.reconciliation_id = $1
        AND je.entity_id = $2
      RETURNING jel.id`,
    [groupId, entityId]
  );
  return r.rows.map((f) => f.id);
}

// ============================================================
// LA SESIÓN
// ============================================================

interface FilaSesion {
  id: string;
  bank_account_id: string;
  status: string;
}

/**
 * La sesión a la que se liga el cotejo, comprobando que es de la misma cuenta.
 *
 * Los dos escritores anteriores dejaban `reconciliation_session_id` en NULL
 * mientras su único lector filtraba por esa columna, así que
 * `GET /reconciliations/:id` devolvía `matches: []` SIEMPRE. Ligar la sesión
 * cuando la hay es toda la reparación que faltaba del lado de la escritura.
 */
async function sesionEscribible(
  client: pg.PoolClient,
  entityId: string,
  cuentaId: string,
  sesionId: string
): Promise<FilaSesion> {
  if (!UUID_RE.test(sesionId)) throw new NotFoundError('Reconciliation Session', sesionId);
  const r = await client.query<FilaSesion>(
    `SELECT id, bank_account_id, status
       FROM reconciliation_sessions
      WHERE id = $1 AND entity_id = $2
      FOR UPDATE`,
    [sesionId, entityId]
  );
  const sesion = r.rows[0];
  if (!sesion) throw new NotFoundError('Reconciliation Session', sesionId);

  if (sesion.bank_account_id !== cuentaId) {
    throw new ValidationError(
      `La sesión ${sesionId} concilia otra cuenta bancaria: un cotejo no puede ` +
      `pertenecer a la conciliación de una cuenta distinta de la del movimiento.`
    );
  }
  if (sesion.status === 'approved' || sesion.status === 'posted') {
    throw new ConflictError(
      `La sesión ${sesionId} está en '${sesion.status}': añadirle cotejos ahora ` +
      `reescribiría una aseveración ya firmada.`
    );
  }
  return sesion;
}

// ============================================================
// PREVISUALIZAR · fila 1224
// ============================================================

export interface PropuestaDelMotor {
  tipo: TipoCotejable;
  id: string;
  referencia: string | null;
  importe: string;
  fecha: string;
  confianza: number;
  /**
   * QUÉ REGLA DECIDIÓ, no sólo con cuánta confianza.
   *
   * `MatchResult` lo trae desde que el motor dejó de tirarlo, y sin él una
   * previsualización sólo puede decir «0.87»: un número que nadie puede
   * revisar porque no dice de dónde salió. Se proyecta tal cual —el nombre es
   * del motor y no de aquí— para que renombrar una regla se vea en la salida
   * en vez de traducirse a un sinónimo que envejece.
   */
  regla: string;
  /** El importe que el motor cotejaría, tal como lo devuelve. */
  importeCotejado: string;
}

export interface MovimientoPrevisto {
  txId: string;
  fecha: string;
  importe: string;
  descripcion: string | null;
  propuesta: PropuestaDelMotor | null;
  senales: SenalesDeCotejo | null;
  periodo: { nombre: string; estado: string } | null;
  /** Cierto si `run` lo aplicaría con las opciones dadas. */
  aplicable: boolean;
  motivo: MotivoOmision | null;
}

export interface OpcionesPrevisualizacion {
  /** La cuenta bancaria. Obligatoria salvo que se dé `txId`. */
  cuentaId?: string;
  /** Un movimiento concreto; sin él, todos los no cotejados de la cuenta. */
  txId?: string;
  desde?: string;
  hasta?: string;
  /** Cuántos movimientos como máximo. */
  top?: number;
  minConfianza?: number;
  maxMonto?: string;
  soloReglas?: boolean;
}

/**
 * Los candidatos que produciría el motor, con la descomposición de su puntaje
 * y las compuertas que `run` aplicaría, SIN ESCRIBIR NADA.
 *
 * Es la mitad de lectura del par: un agente puede invocar esto y no `run`. Por
 * eso no abre transacción, no toma candados y no llama a nada que escriba —la
 * propiedad tiene que ser evidente leyendo el cuerpo, no confiando en el
 * nombre.
 */
export async function previsualizarCotejo(
  scope: Scope,
  opts: OpcionesPrevisualizacion
): Promise<MovimientoPrevisto[]> {
  const movimientos = await movimientosParaProponer(scope, opts);
  const previstos: MovimientoPrevisto[] = [];

  for (const { entityId, tx } of movimientos) {
    previstos.push(await preverMovimiento(scope, entityId, tx, opts));
  }
  return previstos;
}

interface MovimientoConEntidad {
  entityId: string;
  cuentaId: string;
  tx: FilaMovimiento & BankTransaction;
}

/** Los movimientos a proponer: uno concreto, o los no cotejados de una cuenta. */
async function movimientosParaProponer(
  scope: Scope,
  opts: OpcionesPrevisualizacion
): Promise<MovimientoConEntidad[]> {
  if (opts.txId) {
    if (!UUID_RE.test(opts.txId)) throw new NotFoundError('Bank Transaction', opts.txId);
    // La frontera va DENTRO del SQL: el movimiento no tiene entity_id, así que
    // se acota por su cuenta. Cero filas es a la vez «no existe» y «no es tuya».
    const alcance =
      scope.kind === 'entity'
        ? { sql: 'ba.entity_id = $2', valor: scope.entityId }
        : {
          sql: 'ba.entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $2)',
          valor: scope.tenantId,
        };
    const r = await query<FilaMovimiento & BankTransaction & { entity_id: string }>(
      `SELECT bt.*, ba.entity_id
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE bt.id = $1 AND ${alcance.sql}`,
      [opts.txId, alcance.valor]
    );
    const fila = r.rows[0];
    if (!fila) throw new NotFoundError('Bank Transaction', opts.txId);
    return [{ entityId: fila.entity_id, cuentaId: fila.bank_account_id, tx: fila }];
  }

  if (!opts.cuentaId) {
    throw new ValidationError(
      'Previsualizar necesita una cuenta bancaria (--account) o un movimiento concreto.'
    );
  }
  const entityId = await entidadDeLaCuenta(scope, opts.cuentaId);
  const r = await query<FilaMovimiento & BankTransaction>(
    `SELECT bt.*
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.bank_account_id = $1 AND ba.entity_id = $2
        AND bt.is_matched = false
        AND ($3::date IS NULL OR bt.transaction_date >= $3::date)
        AND ($4::date IS NULL OR bt.transaction_date <= $4::date)
      ORDER BY bt.transaction_date, bt.id
      LIMIT $5`,
    [
      opts.cuentaId, entityId, opts.desde ?? null, opts.hasta ?? null,
      Math.min(opts.top ?? LIMITE_PROPUESTAS, LIMITE_PROPUESTAS),
    ]
  );
  return r.rows.map((tx) => ({ entityId, cuentaId: opts.cuentaId!, tx }));
}

/** La propuesta del motor para un movimiento, con sus señales y compuertas. */
async function preverMovimiento(
  scope: Scope,
  entityId: string,
  tx: FilaMovimiento & BankTransaction,
  opts: { minConfianza?: number; maxMonto?: string; soloReglas?: boolean }
): Promise<MovimientoPrevisto> {
  const fecha = new Date(tx.transaction_date);
  const base: MovimientoPrevisto = {
    txId: tx.id,
    fecha: fecha.toISOString().split('T')[0],
    importe: new Decimal(tx.amount).toFixed(4),
    descripcion: tx.description ?? null,
    propuesta: null,
    senales: null,
    periodo: null,
    aplicable: false,
    motivo: null,
  };

  if (tx.is_matched) return { ...base, motivo: 'ya-cotejado' };

  // El alcance del llamador viaja INTACTO hasta el motor: `findBestMatch` lo
  // usa para volver a acotar la cuenta por su cuenta, y fabricarle aquí un
  // alcance «equivalente» sería confiar en que las dos acotaciones coinciden.
  const cruda = await findBestMatch(tx.bank_account_id, tx, scope);
  if (!cruda) return { ...base, motivo: 'sin-candidato' };

  const tipo = cruda.match_type as TipoCotejable;
  const candidato = await leerCandidato(null, entityId, tipo, cruda.match_id, tx.bank_account_id);
  if (!candidato) return { ...base, motivo: 'candidato-inexistente' };

  const senales = medirSenales(
    tx.amount,
    fecha,
    tx.description ?? null,
    candidato.importe,
    candidato.fecha,
    candidato.descripcion
  );

  const periodo = await periodoDe(null, entityId, fecha);
  const conPropuesta: MovimientoPrevisto = {
    ...base,
    propuesta: {
      tipo,
      id: cruda.match_id,
      referencia: candidato.referencia,
      importe: candidato.importe,
      fecha: candidato.fecha.toISOString().split('T')[0],
      confianza: cruda.confidence,
      regla: cruda.rule,
      importeCotejado: cruda.matched_amount,
    },
    senales,
    periodo: periodo ? { nombre: periodo.period_name, estado: periodo.status } : null,
  };

  const motivo = compuertaDeAplicacion(
    senales,
    cruda.confidence,
    cruda.auto_applicable,
    periodo,
    opts
  );
  return { ...conPropuesta, aplicable: motivo === null, motivo };
}

/**
 * Las compuertas de `run`, todas en un sitio para que previsualizar y aplicar
 * no puedan discrepar. Devuelve el PRIMER motivo por el que no se aplica, o
 * null si pasa todas.
 */
function compuertaDeAplicacion(
  senales: SenalesDeCotejo,
  confianza: number,
  autoAplicable: boolean,
  periodo: PeriodoDelMovimiento | null,
  opts: { minConfianza?: number; maxMonto?: string; soloReglas?: boolean }
): MotivoOmision | null {
  if (confianza < (opts.minConfianza ?? CONFIANZA_POR_OMISION)) return 'confianza-baja';

  // EL PISO DE MONTO. `floorMaxAutoAmount` combina el tope configurado con el
  // del código por Math.min: una configuración no puede subirlo. El tope es
  // una constante de política y el importe es dinero, así que la comparación
  // ocurre en Decimal y no al revés.
  const tope = new Decimal(floorMaxAutoAmount(
    opts.maxMonto !== undefined ? new Decimal(opts.maxMonto).toNumber() : FLOOR_MAX_AUTO_POST
  ));
  if (new Decimal(senales.importeBanco).abs().greaterThan(tope)) return 'monto-sobre-piso';

  if (!periodoAdmite(periodo, true)) return 'periodo-cerrado';
  if (!senales.mismaDireccion) return 'direccion-opuesta';
  // La regla del catálogo, dicha en positivo: sin importe exacto no hay señal
  // dura, y sin señal dura lo único que sostiene el cotejo es el texto.
  if (!senales.senalDura) return 'importe-no-exacto';

  // Y EL VETO DE LA REGLA, QUE ESTE ARCHIVO TIRABA A LA BASURA.
  //
  // `senalDura` se mide sobre la PAREJA y no puede ver a los demás candidatos,
  // así que dice «importe exacto» también cuando hay otro candidato con el
  // mismo importe exacto. La regla sí los ve: con dos facturas de 500.00 del
  // mismo día, las reglas 1 y 2 se rehúsan por ambiguas y la 3 nombra a la que
  // se parece en el texto marcándola `auto_applicable = false` —justamente
  // porque lo único que la separa de la otra es la descripción—. Esa bandera
  // estaba en `MatchResult` y NADIE la leía aquí: el cotejo se aplicaba solo,
  // decidido por el parecido del texto, que es lo que la fila 1225 prohíbe
  // literalmente. Ningún umbral configurado levanta este veto: se propone, se
  // muestra y se espera a que un humano lo firme.
  if (!autoAplicable) return 'solo-similitud';

  if (opts.soloReglas && !senales.dentroDeVentana) return 'fuera-de-ventana';

  return null;
}

// ============================================================
// APLICAR · filas 1225 y 1226
// ============================================================

export interface ContextoCotejo {
  userId: string;
  /** Recorre el camino real y lo revierte. */
  dryRun?: boolean;
}

export interface AplicacionHecha {
  matchId: string;
  groupId: string;
  txId: string;
  tipo: TipoCotejable;
  entidadId: string;
  importe: string;
  confianza: number | null;
  /** Cierto cuando además se escribió el sello del lado de libros. */
  selloEscrito: boolean;
}

export interface ResultadoAplicacion {
  aplicados: AplicacionHecha[];
  /** Los que ya tenían este mismo cotejo vivo: la segunda pasada no crea otro. */
  yaAplicados: Array<{ txId: string; matchId: string }>;
  omitidos: Array<{ txId: string; motivo: MotivoOmision }>;
  dryRun: boolean;
}

/** Centinela: la única salida de una transacción con el trabajo hecho y deshecho. */
class EnsayoCotejo<T> extends Error {
  constructor(readonly resultado: T) {
    super('dry run');
    this.name = 'EnsayoCotejo';
  }
}

async function ejecutarActo<T>(correr: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoCotejo) return e.resultado as T;
    throw e;
  }
}

export interface OpcionesCorrida extends OpcionesPrevisualizacion {
  cuentaId: string;
  sesionId?: string;
}

export type ResultadoCorrida = ResultadoAplicacion & {
  evaluados: number;
  /**
   * Cierto cuando quedaron movimientos sin evaluar por el tope de la corrida.
   * Sin este dato, «se cotejaron 500» se leería como «ya no queda nada».
   */
  truncado: boolean;
};

/**
 * `bank match run`: el motor sobre una cuenta y un periodo, aplicando SÓLO lo
 * que supera el umbral, respeta el piso de monto, cae en periodo abierto y
 * trae una señal dura además del parecido del texto.
 *
 * Propone fuera de la transacción y aplica dentro, revalidando bajo candado:
 * entre la propuesta y la escritura el mundo pudo cambiar, y una propuesta
 * caducada no debe convertirse en un cotejo.
 */
export async function correrCotejo(
  scope: Scope,
  opts: OpcionesCorrida,
  ctx: ContextoCotejo
): Promise<ResultadoCorrida> {
  const entityId = await entidadDeLaCuenta(scope, opts.cuentaId);
  const previstos = await previsualizarCotejo(scope, opts);

  const aplicables = previstos.filter((p) => p.aplicable && p.propuesta);
  const omitidos = previstos
    .filter((p) => !p.aplicable)
    .map((p) => ({ txId: p.txId, motivo: p.motivo ?? 'sin-candidato' }));

  const resultado = await escribirCotejos(
    entityId,
    opts.cuentaId,
    aplicables,
    { sesionId: opts.sesionId, origen: 'motor', estricto: true },
    ctx
  );

  return {
    ...resultado,
    evaluados: previstos.length,
    truncado: previstos.length >= Math.min(opts.top ?? LIMITE_PROPUESTAS, LIMITE_PROPUESTAS),
    omitidos: [...omitidos, ...resultado.omitidos],
  };
}

export interface OpcionesAplicacionExplicita {
  sesionId?: string;
  minConfianza?: number;
  maxMonto?: string;
}

/**
 * `bank match apply`: los movimientos que el llamador nombró, en UNA SOLA
 * TRANSACCIÓN, de forma IDEMPOTENTE y ligados a la sesión.
 *
 * Aplica la propuesta del motor para cada id. Mantiene la prohibición del
 * catálogo —ningún cotejo sostenido sólo por el parecido del texto— incluso
 * con un humano confirmando: la bandera que sobreescribe esa regla es
 * `bank match approve --force`, con su permiso propio, y no existe todavía.
 */
export async function aplicarCotejos(
  scope: Scope,
  txIds: readonly string[],
  ctx: ContextoCotejo,
  opts: OpcionesAplicacionExplicita = {}
): Promise<ResultadoAplicacion> {
  if (txIds.length === 0) {
    throw new ValidationError('Aplicar necesita al menos un movimiento: no hay nada que cotejar.');
  }

  const previstos: MovimientoPrevisto[] = [];
  let entityId: string | null = null;
  let cuentaId: string | null = null;

  for (const txId of txIds) {
    const movimientos = await movimientosParaProponer(scope, { txId });
    const mov = movimientos[0];
    if (entityId === null) {
      entityId = mov.entityId;
      cuentaId = mov.cuentaId;
    } else if (mov.cuentaId !== cuentaId) {
      throw new ValidationError(
        'Todos los movimientos de un mismo `apply` tienen que ser de la misma cuenta ' +
        'bancaria: una sola transacción no puede ligarse a dos conciliaciones.'
      );
    }
    previstos.push(
      await preverMovimiento(scope, mov.entityId, mov.tx, { ...opts, soloReglas: false })
    );
  }

  const aplicables = previstos.filter((p) => p.aplicable && p.propuesta);

  // IDEMPOTENCIA VISIBLE. Aplicar dos veces no crea dos cotejos —eso ya lo
  // impide la comprobación bajo candado—, pero la segunda vuelta tiene además
  // que DECIRLO nombrando el cotejo que ya existe. Un «omitido: ya-cotejado»
  // sin id obliga a quien reintenta a ir a buscarlo, y es exactamente el caso
  // en el que un reintento automático necesita saber que no hizo falta.
  const yaAplicados: Array<{ txId: string; matchId: string }> = [];
  const omitidos: Array<{ txId: string; motivo: MotivoOmision }> = [];
  for (const p of previstos) {
    if (p.aplicable) continue;
    if (p.motivo === 'ya-cotejado') {
      const vivo = await movimientoOcupado(null, entityId!, p.txId);
      if (vivo) {
        yaAplicados.push({ txId: p.txId, matchId: vivo });
        continue;
      }
    }
    omitidos.push({ txId: p.txId, motivo: p.motivo ?? 'sin-candidato' });
  }

  const resultado = await escribirCotejos(
    entityId!,
    cuentaId!,
    aplicables,
    { sesionId: opts.sesionId, origen: 'motor', estricto: false },
    ctx
  );
  return {
    ...resultado,
    yaAplicados: [...yaAplicados, ...resultado.yaAplicados],
    omitidos: [...omitidos, ...resultado.omitidos],
  };
}

/**
 * La escritura común de `run` y `apply`: un grupo 1:1 por movimiento, todos en
 * la misma transacción.
 *
 * Cada aplicación crea SU GRUPO aunque sea de una línea contra una. No es
 * ceremonia: `journal_entry_lines.reconciliation_id` apunta al grupo que selló
 * la partida (052), así que un cotejo sin grupo dejaría el sello apuntando a
 * nada. Y como el grupo guarda las tres sumas, la igualdad queda comprobada
 * también en el camino automático, donde el único residual admisible es cero.
 */
async function escribirCotejos(
  entityId: string,
  cuentaId: string,
  aplicables: readonly MovimientoPrevisto[],
  cfg: { sesionId?: string; origen: 'manual' | 'motor'; estricto: boolean },
  ctx: ContextoCotejo
): Promise<ResultadoAplicacion> {
  if (aplicables.length === 0) {
    return { aplicados: [], yaAplicados: [], omitidos: [], dryRun: ctx.dryRun === true };
  }

  return ejecutarActo(async (client) => {
    if (cfg.sesionId) await sesionEscribible(client, entityId, cuentaId, cfg.sesionId);

    const aplicados: AplicacionHecha[] = [];
    const yaAplicados: Array<{ txId: string; matchId: string }> = [];
    const omitidos: Array<{ txId: string; motivo: MotivoOmision }> = [];

    for (const previsto of aplicables) {
      const propuesta = previsto.propuesta;
      if (!propuesta) continue;

      const movimiento = await movimientoBajoCandado(client, entityId, previsto.txId);
      if (!movimiento) {
        omitidos.push({ txId: previsto.txId, motivo: 'ya-cotejado' });
        continue;
      }

      // LA CUENTA DEL GRUPO TIENE QUE SER LA DEL MOVIMIENTO, y aquí no se
      // comprobaba. `marcarMovimientos` ata su UPDATE a `bank_account_id`, así
      // que con una cuenta que no es la suya el movimiento NO se marcaba —cero
      // filas, en silencio— mientras el grupo y el cotejo sí quedaban escritos:
      // un cotejo vivo sobre un movimiento que sigue diciendo «sin cotejar», o
      // sea el invariante 2 roto por la puerta contraria, y el movimiento
      // volvería a proponerse y a cotejarse otra vez. `crearGrupoDeCotejo` ya
      // se defendía de esto (su lado de banco lo comprueba movimiento a
      // movimiento); este camino no.
      if (movimiento.bank_account_id !== cuentaId) {
        throw new ValidationError(
          `El movimiento ${movimiento.id} es de otra cuenta bancaria que la del grupo ` +
          `(${cuentaId}): un cotejo no puede quedar colgado de una cuenta que no es la suya.`
        );
      }

      // IDEMPOTENCIA. Bajo el candado del movimiento, y viendo también las
      // filas que esta misma transacción acaba de insertar: aplicar dos veces
      // el mismo candidato no crea dos cotejos.
      const vivo = await cotejoVivo(client, entityId, previsto.txId, propuesta.tipo, propuesta.id);
      if (vivo) {
        yaAplicados.push({ txId: previsto.txId, matchId: vivo });
        continue;
      }

      // El candidato pudo haberlo consumido otro movimiento —de otra corrida o
      // de una vuelta anterior de este mismo bucle—. El motor lee por el pool y
      // no ve lo que esta transacción escribió; esta consulta sí.
      const ocupado = await candidatoOcupado(client, entityId, propuesta.tipo, propuesta.id);
      if (ocupado) {
        omitidos.push({ txId: previsto.txId, motivo: 'candidato-ocupado' });
        continue;
      }

      const periodo = await periodoDe(client, entityId, new Date(movimiento.transaction_date));
      if (!periodoAdmite(periodo, cfg.estricto)) {
        omitidos.push({ txId: previsto.txId, motivo: 'periodo-cerrado' });
        continue;
      }

      const banco: ImporteDeGrupo[] = [{ id: movimiento.id, importe: movimiento.amount }];
      const libros: ImporteDeGrupo[] = [{ id: propuesta.id, importe: propuesta.importe }];
      const cuadre = cuadrarGrupo(banco, libros, []);
      // Sin humano que declare el residual, el único admisible es cero. Un
      // descuadre aquí significa que el mundo cambió entre proponer y escribir.
      if (!cuadre.cuadra) {
        omitidos.push({ txId: previsto.txId, motivo: 'importe-no-exacto' });
        continue;
      }
      const residual = exigirCuadre(cuadre, {});

      const groupId = await insertarGrupo(client, {
        entityId,
        cuentaId,
        sesionId: cfg.sesionId ?? null,
        cuadre,
        residual,
        origen: cfg.origen,
        userId: ctx.userId,
      });

      const matchId = await insertarCotejo(client, {
        groupId,
        sesionId: cfg.sesionId ?? null,
        txId: movimiento.id,
        tipo: propuesta.tipo,
        entidadId: propuesta.id,
        importe: new Decimal(propuesta.importe).abs().toFixed(4),
        confianza: propuesta.confianza,
        parcial: false,
        matchType: cfg.origen === 'motor' ? 'automatic' : 'manual',
        userId: ctx.userId,
      });

      await marcarMovimientos(client, cuentaId, [movimiento.id], propuesta.confianza, ctx.userId);

      const selladas = propuesta.tipo === 'journal_entry_line'
        ? await sellarPartidas(client, entityId, groupId, [propuesta.id])
        : [];

      aplicados.push({
        matchId,
        groupId,
        txId: movimiento.id,
        tipo: propuesta.tipo,
        entidadId: propuesta.id,
        importe: new Decimal(propuesta.importe).abs().toFixed(4),
        confianza: propuesta.confianza,
        selloEscrito: selladas.length > 0,
      });
    }

    if (aplicados.length > 0) {
      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, entityId),
        userId: ctx.userId,
        action: 'create',
        entityType: 'reconciliation_matches',
        entityId: cuentaId,
        newValues: {
          evento: cfg.origen === 'motor' ? 'match-run' : 'match-apply',
          aplicados: aplicados.length,
          grupos: aplicados.map((a) => a.groupId),
          sesion: cfg.sesionId ?? null,
          ensayo: ctx.dryRun === true,
        },
      });
    }

    const salida: ResultadoAplicacion = {
      aplicados,
      yaAplicados,
      omitidos,
      dryRun: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoCotejo(salida);
    return salida;
  });
}

// ============================================================
// CREAR EL GRUPO EXPLÍCITO · fila 1227
// ============================================================

export interface ReferenciaDeLibros {
  /** Por omisión `journal_entry_line`: «M partidas de libros» es eso. */
  tipo?: TipoCotejable;
  id: string;
}

export interface EntradaGrupo {
  cuentaId: string;
  /** Ids de `bank_transactions`. */
  banco: readonly string[];
  libros: readonly ReferenciaDeLibros[];
  ajustes?: readonly AjusteDeGrupo[];
  residual?: ModoResidual;
  cuentaWriteOff?: string | null;
  sesionId?: string;
}

export interface ResultadoGrupo {
  groupId: string;
  cuadre: CuadreDeGrupo;
  residual: string;
  residualMode: ModoResidual;
  cuentaWriteOff: string | null;
  cotejos: Array<{
    matchId: string;
    txId: string;
    tipo: TipoCotejable;
    entidadId: string;
    importe: string;
    parcial: boolean;
  }>;
  partidasSelladas: string[];
  dryRun: boolean;
}

/**
 * `bank match create`: N líneas de banco contra M partidas de libros más
 * ajustes, EXIGIENDO Σbanco = Σlibros + Σajustes.
 *
 * Es el camino del caso real que el 1:1 no sabe expresar: la parcialidad, el
 * depósito que agrupa tres cobros, el pago corto por comisión. Y es el único
 * camino donde el residual puede no ser cero, porque es el único donde hay
 * alguien que declara qué hacer con él.
 */
export async function crearGrupoDeCotejo(
  scope: Scope,
  entrada: EntradaGrupo,
  ctx: ContextoCotejo
): Promise<ResultadoGrupo> {
  const entityId = await entidadDeLaCuenta(scope, entrada.cuentaId);

  if (entrada.banco.length === 0) {
    throw new ValidationError('Un grupo de cotejo necesita al menos un movimiento de banco.');
  }
  if (entrada.libros.length === 0) {
    throw new ValidationError('Un grupo de cotejo necesita al menos una partida de libros.');
  }

  // Un id repetido en un lado suma su importe DOS VECES, y el grupo cuadraría
  // afirmando el doble de lo que existe. La igualdad no puede defenderse de
  // esto sola: para ella dos veces el mismo movimiento son dos movimientos.
  exigirSinRepetidos(entrada.banco, 'movimiento de banco');
  exigirSinRepetidos(entrada.libros.map((l) => l.id), 'partida de libros');

  return ejecutarActo(async (client) => {
    if (entrada.sesionId) {
      await sesionEscribible(client, entityId, entrada.cuentaId, entrada.sesionId);
    }

    // ── El lado de banco, bajo candado y acotado por su cuenta ──
    const banco: ImporteDeGrupo[] = [];
    for (const txId of entrada.banco) {
      const mov = await movimientoBajoCandado(client, entityId, txId, { exigir: true });
      if (!mov) throw new NotFoundError('Bank Transaction', txId);
      if (mov.bank_account_id !== entrada.cuentaId) {
        throw new ValidationError(
          `El movimiento ${txId} pertenece a otra cuenta bancaria: un grupo de cotejo ` +
          `no puede cruzar dos cuentas.`
        );
      }
      const periodo = await periodoDe(client, entityId, new Date(mov.transaction_date));
      if (!periodoAdmite(periodo, false)) {
        throw new ConflictError(
          `El movimiento ${txId} cae en un periodo '${periodo?.status ?? 'inexistente'}': ` +
          `no se cotejan movimientos de un periodo cerrado con llave.`
        );
      }
      // Un movimiento con cotejo vivo entrando a un grupo nuevo afirmaría dos
      // veces el mismo dinero, cada vez contra un documento distinto.
      const cotejado = await movimientoOcupado(client, entityId, mov.id);
      if (cotejado) {
        throw new ConflictError(
          `El movimiento ${txId} ya tiene el cotejo vivo ${cotejado}: desaplícalo antes de ` +
          `meterlo en un grupo nuevo, o el mismo dinero quedaría cotejado dos veces.`
        );
      }
      banco.push({ id: mov.id, importe: new Decimal(mov.amount).toFixed(4) });
    }

    // ── El lado de libros ──
    const libros: ImporteDeGrupo[] = [];
    const tipos = new Map<string, TipoCotejable>();
    for (const ref of entrada.libros) {
      const tipo = ref.tipo ?? 'journal_entry_line';
      const candidato = await leerCandidato(client, entityId, tipo, ref.id, entrada.cuentaId);
      if (!candidato) throw new NotFoundError(tipo, ref.id);
      // Conciliar contra un BORRADOR es aseverar sobre algo que todavía puede
      // cambiar de cuenta o de importe. El sello se pone sobre hechos.
      if (candidato.estadoAsiento !== undefined && candidato.estadoAsiento !== 'posted') {
        throw new ValidationError(
          `La partida ${ref.id} pertenece a un asiento en '${candidato.estadoAsiento}': ` +
          `sólo se coteja contra asientos contabilizados.`
        );
      }
      if (await candidatoOcupado(client, entityId, tipo, ref.id)) {
        throw new ConflictError(
          `La partida ${ref.id} ya está cotejada: desaplica ese cotejo antes de incluirla ` +
          `en un grupo nuevo.`
        );
      }
      libros.push({ id: ref.id, importe: candidato.importe });
      tipos.set(ref.id, tipo);
    }

    // ── La igualdad, ANTES de escribir nada ──
    const cuadre = cuadrarGrupo(banco, libros, entrada.ajustes ?? []);
    const residual = exigirCuadre(cuadre, {
      modo: entrada.residual,
      cuentaWriteOff: entrada.cuentaWriteOff,
    });
    if (residual.modo === 'write-off' && residual.cuentaWriteOff) {
      await exigirCuentaDeMayor(client, entityId, residual.cuentaWriteOff);
    }

    // Los dos lados tienen que apuntar en la misma dirección o la igualdad se
    // cumpliría cotejando un depósito contra un pago.
    const direccionBanco = new Decimal(cuadre.totalBanco).isNegative();
    const direccionLibros = new Decimal(cuadre.totalLibros).isNegative();
    if (!new Decimal(cuadre.totalLibros).isZero() && direccionBanco !== direccionLibros) {
      throw new ValidationError(
        `El grupo suma ${cuadre.totalBanco} de banco contra ${cuadre.totalLibros} de libros: ` +
        `los dos lados apuntan en direcciones opuestas, así que el grupo cotejaría una ` +
        `entrada de dinero contra una salida.`
      );
    }

    const asignaciones = asignarGrupo(banco, libros);
    // INVARIANTE 2. Un movimiento que se marca cotejado sin fila que lo explique
    // queda invisible a la vez para «no cotejados» y para «cotejados»: es el
    // agujero que la escritura en dos pasos abría, y aquí se cierra antes de
    // escribir en vez de después de descubrirlo.
    const conAsignacion = new Set(asignaciones.map((a) => a.bancoId));
    const huerfano = banco.find((b) => !conAsignacion.has(b.id));
    if (huerfano) {
      throw new ValidationError(
        `El movimiento ${huerfano.id} no recibe ninguna partida de libros: los ajustes y ` +
        `el residual lo absorben entero, así que quedaría marcado como cotejado sin nada ` +
        `que lo explique. Sácalo del grupo o dale una partida.`
      );
    }

    // Y EL INVARIANTE 2 TIENE DOS LADOS. El de arriba sólo miraba el banco, y
    // el sello se pone sobre LIBROS: `sellarPartidas` sella todas las partidas
    // del grupo, reciban asignación o no. Con Σbanco 400 = Σlibros 600 +
    // Σajustes −200 la igualdad se cumple, el reparto voraz da los 400 enteros
    // a la primera partida y la segunda —la de 100— quedaba SELLADA SIN NINGÚN
    // COTEJO que la explique: `bank book-item list` deja de mostrarla (filtra
    // `is_reconciled = false`), la ficha del movimiento no la nombra, y la
    // única forma de recuperarla es desaplicar un grupo del que no consta que
    // formara parte. Es el mismo agujero de arriba con los papeles cambiados.
    const librosAsignados = new Set(asignaciones.map((a) => a.librosId));
    const partidaHuerfana = libros.find((l) => !librosAsignados.has(l.id));
    if (partidaHuerfana) {
      throw new ValidationError(
        `La partida ${partidaHuerfana.id} no recibe ningún movimiento de banco: los ajustes ` +
        `y el residual la absorben entera, así que quedaría sellada sin cotejo que la ` +
        `explique. Sácala del grupo, o mete el movimiento de banco que la cubre.`
      );
    }

    const groupId = await insertarGrupo(client, {
      entityId,
      cuentaId: entrada.cuentaId,
      sesionId: entrada.sesionId ?? null,
      cuadre,
      residual,
      origen: 'manual',
      userId: ctx.userId,
    });

    const cotejos: ResultadoGrupo['cotejos'] = [];
    for (const asignacion of asignaciones) {
      const tipo = tipos.get(asignacion.librosId) ?? 'journal_entry_line';
      const matchId = await insertarCotejo(client, {
        groupId,
        sesionId: entrada.sesionId ?? null,
        txId: asignacion.bancoId,
        tipo,
        entidadId: asignacion.librosId,
        importe: asignacion.importe,
        confianza: null,
        parcial: asignacion.parcial,
        matchType: 'manual',
        userId: ctx.userId,
      });
      cotejos.push({
        matchId,
        txId: asignacion.bancoId,
        tipo,
        entidadId: asignacion.librosId,
        importe: asignacion.importe,
        parcial: asignacion.parcial,
      });
    }

    await marcarMovimientos(client, entrada.cuentaId, banco.map((b) => b.id), null, ctx.userId);

    const partidas = [...tipos.entries()]
      .filter(([, tipo]) => tipo === 'journal_entry_line')
      .map(([id]) => id);
    const partidasSelladas = await sellarPartidas(client, entityId, groupId, partidas);

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId: ctx.userId,
      action: 'create',
      entityType: 'reconciliation_match_groups',
      entityId: groupId,
      newValues: {
        evento: 'match-create',
        total_banco: cuadre.totalBanco,
        total_libros: cuadre.totalLibros,
        total_ajustes: cuadre.totalAjustes,
        residual: residual.residual,
        residual_mode: residual.modo,
        movimientos: banco.length,
        partidas: libros.length,
        sesion: entrada.sesionId ?? null,
        ensayo: ctx.dryRun === true,
      },
    });

    const salida: ResultadoGrupo = {
      groupId,
      cuadre,
      residual: residual.residual,
      residualMode: residual.modo,
      cuentaWriteOff: residual.cuentaWriteOff,
      cotejos,
      partidasSelladas,
      dryRun: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoCotejo(salida);
    return salida;
  });
}

// ============================================================
// DESAPLICAR · fila 1228
// ============================================================

export interface ResultadoDesaplicacion {
  groupId: string | null;
  /** Los cotejos clausurados. Ninguna fila se borra: se les pone fecha de muerte. */
  cotejos: string[];
  movimientosLiberados: string[];
  partidasLiberadas: string[];
  motivo: MotivoDesaplicacion;
  dryRun: boolean;
}

/**
 * `bank match unapply`: DESAPLICAR CLAUSURA, NO BORRA.
 *
 * Un cotejo deshecho es historia del expediente: el auditor pregunta por qué
 * se deshizo, y una fila borrada no contesta. Se escriben `unapplied_at`,
 * `unapplied_by` y `unapply_reason`, y la fila se queda donde estaba.
 *
 * SE REHÚSA SI LA SESIÓN ESTÁ `approved` O `posted`: deshacer un cotejo de una
 * sesión firmada es reescribir una aseveración ya hecha, y eso no se corrige
 * borrando sino con una sesión nueva.
 *
 * ARRASTRA AL GRUPO ENTERO. Si el cotejo pertenece a un grupo, la clausura
 * alcanza a todos sus cotejos vivos: la igualdad Σbanco = Σlibros + Σajustes
 * no sobrevive a que le quiten una pata, y dejar el grupo cojo guardaría en la
 * base una aseveración que ya no es cierta.
 *
 * Del lado de libros sólo se tocan las tres columnas del sello. NINGUNA PÓLIZA
 * CONTABILIZADA se modifica: no hay en todo este archivo una escritura sobre
 * `journal_entries` ni sobre ninguna otra columna de `journal_entry_lines`.
 */
export async function desaplicarCotejo(
  scope: Scope,
  matchId: string,
  ctx: ContextoCotejo & { motivo: MotivoDesaplicacion }
): Promise<ResultadoDesaplicacion> {
  if (!MOTIVOS_DESAPLICACION.includes(ctx.motivo)) {
    throw new ValidationError(
      `Motivo de desaplicación desconocido: '${ctx.motivo}'. Los admitidos son ` +
      `${MOTIVOS_DESAPLICACION.join(', ')}. El motivo es un código y no prosa libre ` +
      `porque las causas tienen que poder contarse, no sólo leerse.`
    );
  }
  if (!UUID_RE.test(matchId)) throw new NotFoundError('Reconciliation Match', matchId);

  return ejecutarActo(async (client) => {
    const alcance =
      scope.kind === 'entity'
        ? { sql: 'ba.entity_id = $2', valor: scope.entityId }
        : {
          sql: 'ba.entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $2)',
          valor: scope.tenantId,
        };

    // La frontera DENTRO del SQL: el cotejo no tiene entity_id, cuelga del
    // movimiento y éste de la cuenta.
    const r = await client.query<{
      id: string;
      group_id: string | null;
      reconciliation_session_id: string | null;
      bank_transaction_id: string;
      bank_account_id: string;
      entity_id: string;
      unapplied_at: Date | null;
    }>(
      `SELECT rm.id, rm.group_id, rm.reconciliation_session_id, rm.bank_transaction_id,
              bt.bank_account_id, ba.entity_id, rm.unapplied_at
         FROM reconciliation_matches rm
         JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE rm.id = $1 AND ${alcance.sql}
        FOR UPDATE OF rm`,
      [matchId, alcance.valor]
    );
    const cotejo = r.rows[0];
    if (!cotejo) throw new NotFoundError('Reconciliation Match', matchId);
    if (cotejo.unapplied_at !== null) {
      throw new ConflictError(
        `El cotejo ${matchId} ya se desaplicó: deshacer lo ya deshecho no es un acto, ` +
        `y su fila sigue en el expediente con su motivo.`
      );
    }

    const entityId = cotejo.entity_id;
    const groupId = cotejo.group_id;

    await exigirSesionNoFirmada(client, entityId, cotejo.reconciliation_session_id);
    if (groupId) await exigirSesionDelGrupoNoFirmada(client, entityId, groupId);

    // Todos los cotejos vivos alcanzados: los del grupo, o éste solo.
    const alcanzados = groupId
      ? await client.query<{ id: string; bank_transaction_id: string }>(
        `SELECT rm.id, rm.bank_transaction_id
             FROM reconciliation_matches rm
             JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
             JOIN bank_accounts ba ON ba.id = bt.bank_account_id
            WHERE rm.group_id = $1 AND rm.unapplied_at IS NULL AND ba.entity_id = $2
            FOR UPDATE OF rm`,
        [groupId, entityId]
      )
      : { rows: [{ id: cotejo.id, bank_transaction_id: cotejo.bank_transaction_id }] };

    const ids = alcanzados.rows.map((f) => f.id);
    await client.query(
      `UPDATE reconciliation_matches
          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2
        WHERE id = ANY($3::uuid[]) AND unapplied_at IS NULL`,
      [ctx.userId, ctx.motivo, ids]
    );

    // El sello del lado de libros se libera por GRUPO, que es a quien apunta
    // `reconciliation_id`. Sin grupo no hubo sello que liberar.
    const partidasLiberadas = groupId ? await liberarPartidas(client, entityId, groupId) : [];

    // Un movimiento vuelve a «no cotejado» sólo si NINGÚN cotejo vivo le queda.
    const txIds = [...new Set(alcanzados.rows.map((f) => f.bank_transaction_id))];
    const liberados = await client.query<{ id: string }>(
      `UPDATE bank_transactions bt
          SET is_matched = false, matched_at = NULL, matched_by = NULL, confidence_score = NULL
         FROM bank_accounts ba
        WHERE ba.id = bt.bank_account_id
          AND bt.id = ANY($1::uuid[])
          AND ba.entity_id = $2
          AND NOT EXISTS (
                SELECT 1 FROM reconciliation_matches rm
                 WHERE rm.bank_transaction_id = bt.id AND rm.unapplied_at IS NULL)
        RETURNING bt.id`,
      [txIds, entityId]
    );

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId: ctx.userId,
      action: 'update',
      entityType: 'reconciliation_matches',
      entityId: matchId,
      newValues: {
        evento: 'match-unapply',
        grupo: groupId,
        cotejos: ids,
        partidas_liberadas: partidasLiberadas.length,
        ensayo: ctx.dryRun === true,
      },
      reason: ctx.motivo,
    });

    const salida: ResultadoDesaplicacion = {
      groupId,
      cotejos: ids,
      movimientosLiberados: liberados.rows.map((f) => f.id),
      partidasLiberadas,
      motivo: ctx.motivo,
      dryRun: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoCotejo(salida);
    return salida;
  });
}

async function exigirSesionNoFirmada(
  client: pg.PoolClient,
  entityId: string,
  sesionId: string | null
): Promise<void> {
  if (!sesionId) return;
  const r = await client.query<{ status: string }>(
    `SELECT status FROM reconciliation_sessions WHERE id = $1 AND entity_id = $2`,
    [sesionId, entityId]
  );
  const estado = r.rows[0]?.status;
  if (estado === 'approved' || estado === 'posted') {
    throw new ConflictError(
      `La sesión ${sesionId} está en '${estado}': deshacer un cotejo suyo reescribiría ` +
      `una aseveración ya firmada. Corrígela con una sesión nueva, no borrando ésta.`
    );
  }
}

async function exigirSesionDelGrupoNoFirmada(
  client: pg.PoolClient,
  entityId: string,
  groupId: string
): Promise<void> {
  const r = await client.query<{ reconciliation_session_id: string | null }>(
    `SELECT reconciliation_session_id FROM reconciliation_match_groups
      WHERE id = $1 AND entity_id = $2`,
    [groupId, entityId]
  );
  await exigirSesionNoFirmada(client, entityId, r.rows[0]?.reconciliation_session_id ?? null);
}

// ============================================================
// ESCRITURAS ELEMENTALES
// ============================================================

/**
 * El movimiento bajo candado y acotado por su cuenta. Sin `exigir`, devuelve
 * null cuando ya está cotejado: el llamador lo trata como omisión y no como
 * error, que es lo que una corrida necesita.
 */
async function movimientoBajoCandado(
  client: pg.PoolClient,
  entityId: string,
  txId: string,
  opts: { exigir?: boolean } = {}
): Promise<FilaMovimiento | null> {
  if (!UUID_RE.test(txId)) {
    if (opts.exigir) throw new NotFoundError('Bank Transaction', txId);
    return null;
  }
  const r = await client.query<FilaMovimiento>(
    `SELECT bt.id, bt.bank_account_id, bt.transaction_date, bt.amount, bt.description,
            bt.merchant_name, bt.is_matched
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.id = $1 AND ba.entity_id = $2
      FOR UPDATE OF bt`,
    [txId, entityId]
  );
  const fila = r.rows[0];
  if (!fila) {
    if (opts.exigir) throw new NotFoundError('Bank Transaction', txId);
    return null;
  }
  if (fila.is_matched && !opts.exigir) return null;
  return fila;
}

async function cotejoVivo(
  client: pg.PoolClient,
  entityId: string,
  txId: string,
  tipo: TipoCotejable,
  entidadId: string
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT rm.id
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE rm.bank_transaction_id = $1
        AND rm.matched_entity_type = $2 AND rm.matched_entity_id = $3
        AND rm.unapplied_at IS NULL AND ba.entity_id = $4
      LIMIT 1`,
    [txId, tipo, entidadId, entityId]
  );
  return r.rows[0]?.id ?? null;
}

/** El cotejo vivo que ya tiene este movimiento, si lo tiene. */
async function movimientoOcupado(
  client: pg.PoolClient | null,
  entityId: string,
  txId: string
): Promise<string | null> {
  const sql =
    `SELECT rm.id
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE rm.bank_transaction_id = $1
        AND rm.unapplied_at IS NULL AND ba.entity_id = $2
      LIMIT 1`;
  const r = client
    ? await client.query<{ id: string }>(sql, [txId, entityId])
    : await query<{ id: string }>(sql, [txId, entityId]);
  return r.rows[0]?.id ?? null;
}

async function candidatoOcupado(
  client: pg.PoolClient,
  entityId: string,
  tipo: TipoCotejable,
  entidadId: string
): Promise<boolean> {
  const r = await client.query<{ id: string }>(
    `SELECT rm.id
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE rm.matched_entity_type = $1 AND rm.matched_entity_id = $2
        AND rm.unapplied_at IS NULL AND ba.entity_id = $3
      LIMIT 1`,
    [tipo, entidadId, entityId]
  );
  return r.rows.length > 0;
}

interface EntradaGrupoFila {
  entityId: string;
  cuentaId: string;
  sesionId: string | null;
  cuadre: CuadreDeGrupo;
  residual: ResidualResuelto;
  origen: 'manual' | 'motor';
  userId: string;
}

async function insertarGrupo(client: pg.PoolClient, e: EntradaGrupoFila): Promise<string> {
  const id = uuidv4();
  await client.query(
    `INSERT INTO reconciliation_match_groups (
       id, entity_id, bank_account_id, reconciliation_session_id,
       total_banco, total_libros, total_ajustes,
       residual, residual_mode, write_off_account_id, origen, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id, e.entityId, e.cuentaId, e.sesionId,
      e.cuadre.totalBanco, e.cuadre.totalLibros, e.cuadre.totalAjustes,
      e.residual.residual, e.residual.modo, e.residual.cuentaWriteOff,
      e.origen, e.userId,
    ]
  );
  return id;
}

interface EntradaCotejoFila {
  groupId: string;
  sesionId: string | null;
  txId: string;
  tipo: TipoCotejable;
  entidadId: string;
  importe: string;
  confianza: number | null;
  parcial: boolean;
  matchType: 'automatic' | 'manual';
  userId: string;
}

async function insertarCotejo(client: pg.PoolClient, e: EntradaCotejoFila): Promise<string> {
  const id = uuidv4();
  await client.query(
    `INSERT INTO reconciliation_matches (
       id, reconciliation_session_id, bank_transaction_id, match_type,
       matched_entity_type, matched_entity_id, matched_amount,
       confidence_score, is_partial, matched_by, group_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, e.sesionId, e.txId, e.matchType,
      e.tipo, e.entidadId, e.importe,
      e.confianza, e.parcial, e.userId, e.groupId,
    ]
  );
  return id;
}

/**
 * El UPDATE lleva `bank_account_id` además del id: la pertenencia de la cuenta
 * ya está probada, así que atarlo a ella deja la escritura acotada por
 * construcción y no por que el SELECT de arriba haya filtrado bien.
 */
async function marcarMovimientos(
  client: pg.PoolClient,
  cuentaId: string,
  txIds: readonly string[],
  confianza: number | null,
  userId: string
): Promise<void> {
  if (txIds.length === 0) return;
  await client.query(
    `UPDATE bank_transactions
        SET is_matched = true, matched_at = NOW(), matched_by = $1, confidence_score = $2
      WHERE id = ANY($3::uuid[]) AND bank_account_id = $4`,
    [userId, confianza, [...txIds], cuentaId]
  );
}

/** La cuenta de mayor contra la que se cancela el residual, acotada por entidad. */
async function exigirCuentaDeMayor(
  client: pg.PoolClient,
  entityId: string,
  cuentaId: string
): Promise<void> {
  if (!UUID_RE.test(cuentaId)) throw new NotFoundError('Account', cuentaId);
  const r = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE id = $1 AND entity_id = $2 AND is_active = true`,
    [cuentaId, entityId]
  );
  if (r.rows.length === 0) {
    throw new NotFoundError('Account', cuentaId);
  }
}
