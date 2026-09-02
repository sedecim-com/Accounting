import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { createDraft, type DraftLine, type DraftPayload } from '../../ai/draft-service.js';
import { resolveEntity, type AgentContext } from '../../ai/context.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';
import { monto } from './reconciliation-math.js';

// ============================================================
// LOS AJUSTES DE LA CONCILIACIÓN, COMO BORRADORES (F05c · 053)
//
// La fila 1246 del catálogo lo dice en negrita: crea «como borradores» los
// asientos de comisión, IVA, intereses, retención de ISR y corrección de
// errores detectados dentro de la sesión, y «nunca contabiliza por su cuenta».
//
// ESTE ARCHIVO NO IMPORTA NI NOMBRA NADA DE `services/accounting/posting.ts`
// —ni el verbo que crea asientos ni el que los contabiliza—, y la ausencia no
// es una omisión que alguien pueda «completar»: es la promesa entera. Lo que se
// escribe es una fila en `reconciliation_adjustments` y un borrador en
// `ai_drafts` esperando a `mnemosine review`. Contabilizar es de F05d, detrás
// de una firma, y es quien rellenará `journal_entry_id` —que aquí se queda NULL
// siempre—.
//
// Los dos nombres no aparecen NI EN ESTE COMENTARIO, a propósito: la promesa se
// va a comprobar contra el código, y una comprobación honesta busca el
// identificador, no la llamada. Un archivo que explica largamente que no llama
// a algo mientras lo escribe seis veces obliga a que la comprobación se afine
// hasta dejar de comprobar. Aquí no hay que afinar nada.
//
// La promesa se sostiene sola: `createDraft` sólo INSERTA en `ai_drafts`. El
// único camino de `ai_drafts` al mayor es `approveDraft`, que exige un revisor
// humano resuelto contra `users`. Y el camino de política
// (`autoApproveDraftByPolicy`) no alcanza a estos borradores: sólo lo invoca la
// ingesta de CFDI sobre el borrador que ella misma acaba de crear, nunca barre
// lo pendiente. Aun así la confianza por omisión es media y no 1.00 —ver
// `CONFIANZA_POR_OMISION`—, porque el importe es un hecho del extracto pero la
// cuenta es un juicio, y la confianza es justo lo que una política leería.
//
// EL SIGNO, otra vez, VIVE EN EL DATO. `importe` va FIRMADO POR SU EFECTO EN LA
// CUENTA DE BANCO —positivo entra, negativo sale—, igual que
// `reconciling_items.importe` y que `bank_transactions.amount`. Con eso el
// asiento sale de una sola regla («si entra, carga banco; si sale, abona
// banco») y no de un árbol de casos por tipo que alguien tendría que recordar.
//
// PERO EL TIPO Y EL SIGNO TIENEN QUE ESTAR DE ACUERDO. Una comisión que mete
// dinero en la cuenta no es una comisión, y un interés que lo saca tampoco es
// un interés. Cuando se contradicen NO se corrige el signo en silencio: se
// rechaza. Voltear un signo por su cuenta es cómo un dato equivocado se
// convierte en un asiento correcto de una cosa que no pasó.
// ============================================================

export const TIPOS_DE_AJUSTE = ['comision', 'iva-comision', 'interes', 'isr-retenido', 'error'] as const;
export type TipoDeAjuste = (typeof TIPOS_DE_AJUSTE)[number];

/**
 * EL ROL CONTABLE DE LA CONTRAPARTIDA, Y LOS DOS HUECOS QUE HOY TIENE.
 *
 * `null` significa «ROLE_MAP no tiene un rol para esto», no «da igual la
 * cuenta»: con `null` este servicio EXIGE que el llamador nombre la cuenta y se
 * niega a elegir una. Sembrar roles nuevos es de F05d, y rellenar el hueco
 * apuntando a un rol vecino sería peor que dejarlo abierto:
 *
 *   · `comision` querría un rol de GASTO BANCARIO y no existe. El vecino sería
 *     `gasto` (6100, «Gastos Generales»), donde la comisión se mezclaría con
 *     todo lo demás y dejaría de poder contarse — que es justo lo que una
 *     conciliación existe para descubrir.
 *   · `interes` querría un rol de INTERÉS GANADO y no existe. El vecino sería
 *     `otros_ingresos` (4200), cuyo comentario en la taxonomía dice que está
 *     reservado a propósito al remanente de un pago corto; meterle los
 *     rendimientos del banco lo inflaría con algo de otra naturaleza.
 *
 * Los dos que SÍ existen no se inventan tampoco:
 *
 *   · `iva-comision` → `iva_acreditable` (1130) y no `iva_pendiente_acreditar`
 *     (1135). La distinción es la de `iva-cash-basis.ts`: el 1135 es donde
 *     ESPERA el IVA de un documento PPD hasta que se paga. La comisión del
 *     banco se cobra y se paga en el mismo instante —el cargo ES el pago—, así
 *     que es el caso PUE y su IVA es acreditable ya. Dejarlo en 1135 pararía
 *     ahí un IVA que nada va a venir a liberar después.
 *   · `isr-retenido` → `isr_retenido_a_favor` (1145): la retención del banco
 *     sobre los rendimientos es un saldo A FAVOR de la entidad, no un impuesto
 *     por pagar. Confundirlo con `isr_retenido_por_pagar` (2140) pondría un
 *     activo en el pasivo.
 */
export const ROL_DE_AJUSTE: Readonly<Record<TipoDeAjuste, AccountRole | null>> = Object.freeze({
  comision: null,
  'iva-comision': 'iva_acreditable',
  interes: null,
  'isr-retenido': 'isr_retenido_a_favor',
  // Un error no tiene cuenta por naturaleza: depende de qué se registró mal.
  error: null,
});

/**
 * Los roles que F05d tiene que sembrar para que `comision` e `interes` dejen de
 * exigir cuenta explícita. Se nombran aquí, en una constante que se puede
 * imprimir, en vez de en un comentario que sólo lee quien abre el archivo.
 */
export const ROLES_QUE_FALTAN: ReadonlyArray<{ tipo: TipoDeAjuste; rol: string; porque: string }> = Object.freeze([
  Object.freeze({
    tipo: 'comision' as const,
    rol: 'comision_bancaria',
    porque:
      'ROLE_MAP no tiene un rol de gasto bancario; el vecino sería `gasto` (6100), donde la ' +
      'comisión se mezcla con todo lo demás y deja de poder contarse.',
  }),
  Object.freeze({
    tipo: 'interes' as const,
    rol: 'interes_ganado',
    porque:
      'ROLE_MAP no tiene un rol de interés ganado; el vecino sería `otros_ingresos` (4200), ' +
      'reservado a propósito al remanente de un pago corto.',
  }),
]);

/**
 * Qué signo admite cada tipo, visto DESDE LA CUENTA DE BANCO.
 *
 * `null` es «cualquiera de los dos, menos cero»: un error puede haber inflado o
 * desinflado el saldo, y ése es todo el sentido de que `error` sea un tipo
 * aparte. Los otros cuatro tienen dirección por definición y por eso se
 * comprueba: el ISR retenido del banco SALE de la cuenta aunque nazca de un
 * rendimiento que entra, y quien lo capture con el signo del interés estaría
 * proponiendo un asiento al revés que cuadra igual de bien.
 */
const SIGNO_ESPERADO: Readonly<Record<TipoDeAjuste, 'entra' | 'sale' | null>> = Object.freeze({
  comision: 'sale',
  'iva-comision': 'sale',
  interes: 'entra',
  'isr-retenido': 'sale',
  error: null,
});

/**
 * La confianza con la que nace el borrador.
 *
 * No es 1.00 a propósito. El IMPORTE es un hecho —lo dice el extracto—, pero la
 * CUENTA es un juicio, y `ai_confidence` es lo que una política de aprobación
 * automática mira para decidir si algo puede postearse sin humano. Ninguna
 * política alcanza hoy a estos borradores, y aun así se deja abajo: la
 * seguridad de un tramo no debería depender de que el tramo de al lado no
 * cambie.
 */
export const CONFIANZA_POR_OMISION = 0.5;

/** Quién produjo el borrador, para `ai_drafts.ai_model`. No hay modelo: hay una resta. */
const PRODUCTOR = 'mnemosine/bank-reconciliation';

export interface EntradaDeAjuste {
  tipo: TipoDeAjuste;
  /**
   * Código de la cuenta de contrapartida. Si falta, se resuelve por el rol de
   * `ROL_DE_AJUSTE`; con rol `null` es obligatoria.
   */
  cuenta?: string;
  /** Dinero como CADENA, FIRMADO por su efecto en la cuenta de banco. */
  importe: string;
}

export interface OpcionesDeAjuste {
  /** Evita resolver la entidad otra vez. Tiene que ser la MISMA que `entityId`. */
  ctx?: AgentContext;
  /** La partida conciliatoria que este ajuste explica. */
  reconcilingItemId?: string;
  /** Fecha del asiento propuesto. Por omisión, el cierre del periodo de la sesión. */
  fecha?: string;
  descripcion?: string;
  confianza?: number;
}

export interface AjusteCreado {
  id: string;
  tipo: TipoDeAjuste;
  /** El importe firmado, tal como quedó en la fila. */
  importe: string;
  cuenta: string;
  cuentaDeBanco: string;
  draftId: string;
  /** SIEMPRE null aquí. Lo rellena F05d al contabilizar. */
  journalEntryId: null;
  /** El asiento que el borrador propone, para poder enseñarlo sin releerlo. */
  lineas: DraftLine[];
}

/** El sentido del asiento y su magnitud, sin base de datos detrás. */
export interface DireccionDelAjuste {
  /** `true` si el asiento CARGA la cuenta de banco, o sea si entra dinero. */
  bancoDebita: boolean;
  /** Valor absoluto, con los decimales que la columna guarda. */
  magnitud: string;
}

/**
 * Lee un importe firmado y dice hacia dónde va el asiento, rechazando lo que no
 * concuerda con el tipo.
 *
 * Es función pura y separada del INSERT a propósito: los cuatro casos de signo
 * —comisión que sale, interés que entra, ISR que sale, error en cualquiera de
 * los dos sentidos— se prueban en cuatro llamadas y no en cuatro escenarios de
 * integración.
 */
export function direccionDeAjuste(tipo: TipoDeAjuste, importeFirmado: string): DireccionDelAjuste {
  if (!(TIPOS_DE_AJUSTE as readonly string[]).includes(tipo)) {
    throw new ValidationError(
      `Tipo de ajuste desconocido "${String(tipo)}". Los admitidos son: ${TIPOS_DE_AJUSTE.join(', ')}.`
    );
  }

  let d: Decimal;
  try {
    d = new Decimal(importeFirmado);
  } catch {
    throw new ValidationError(`Importe ilegible para el ajuste: "${importeFirmado}".`);
  }
  if (!d.isFinite()) {
    throw new ValidationError(`Importe no finito para el ajuste: "${importeFirmado}".`);
  }
  // Un ajuste de cero no ajusta nada, y un borrador de cero no puede ni
  // postearse (`validateDraftPayload` exige importes positivos por línea).
  // Rechazarlo aquí da el mensaje que explica por qué, en vez del genérico.
  if (d.isZero()) {
    throw new ValidationError(
      `El importe de un ajuste de conciliación no puede ser cero: un asiento de cero no corrige ` +
        `ninguna diferencia y el motor no lo admitiría.`
    );
  }

  const esperado = SIGNO_ESPERADO[tipo];
  const entra = d.isPositive();
  if (esperado !== null && (esperado === 'entra') !== entra) {
    throw new ValidationError(
      `El ajuste "${tipo}" ${esperado === 'entra' ? 'mete' : 'saca'} dinero de la cuenta, así que su ` +
        `importe tiene que ser ${esperado === 'entra' ? 'positivo' : 'negativo'}; llegó ${monto(d)}. ` +
        `El signo NO se voltea aquí: si de verdad el movimiento va al revés, no es un "${tipo}" ` +
        `—probablemente sea "error"—.`
    );
  }

  return { bancoDebita: entra, magnitud: monto(d.abs()) };
}

/**
 * EL PUNTO DONDE 19,4 SE ENCUENTRA CON UN ASIENTO DE DOS DECIMALES.
 *
 * `reconciliation_adjustments.importe` es DECIMAL(19,4), pero un borrador
 * postea a dos decimales: `validateDraftPayload` valida el importe REDONDEADO y
 * `canonicalDraftHash` normaliza a dos antes de firmar el contenido. Un
 * 19.7520 quedaría en la fila con cuatro decimales y postearía 19.75, y a
 * partir de ahí la fila y su asiento afirmarían cantidades distintas sobre el
 * mismo hecho — que es EXACTAMENTE el defecto que F05a cazó, el que hacía que
 * dos verbos contestaran cosas distintas sobre el mismo documento.
 *
 * Así que no se redondea: se RECHAZA, nombrando los dos números. Perder un
 * diezmilésimo en silencio es la forma barata; que el descuadre aparezca meses
 * después en la conciliación de otro es el precio.
 */
function exigirImportePosteable(magnitud: string, tipo: TipoDeAjuste): number {
  const d = new Decimal(magnitud);
  const redondeado = d.toDecimalPlaces(2);
  if (!redondeado.equals(d)) {
    throw new ValidationError(
      `El ajuste "${tipo}" trae ${d.toFixed(4)}, que no cabe en un asiento de dos decimales: ` +
        `postearía ${redondeado.toFixed(2)} y la fila de la conciliación seguiría diciendo ` +
        `${d.toFixed(4)}. No se redondea por su cuenta —las dos cifras acabarían contradiciéndose—: ` +
        `captura el importe con el que se va a contabilizar.`
    );
  }
  return redondeado.toNumber();
}

/**
 * Las dos líneas del asiento propuesto.
 *
 * Función pura: la contrapartida y el banco, en el orden que impone la
 * dirección. No hay más casos que ése —ni por tipo, ni por rol—, y que no los
 * haya es lo que hace que el asiento no pueda salir invertido para un tipo y
 * derecho para otro.
 */
export function lineasDelAjuste(
  direccion: DireccionDelAjuste,
  cuentaContraparte: string,
  cuentaDeBanco: string,
  tipo: TipoDeAjuste,
  descripcion: string
): DraftLine[] {
  const importe = exigirImportePosteable(direccion.magnitud, tipo);
  return direccion.bancoDebita
    ? [
        { account_code: cuentaDeBanco, debit: importe, description: descripcion },
        { account_code: cuentaContraparte, credit: importe, description: descripcion },
      ]
    : [
        { account_code: cuentaContraparte, debit: importe, description: descripcion },
        { account_code: cuentaDeBanco, credit: importe, description: descripcion },
      ];
}

interface FilaSesionParaAjuste {
  id: string;
  bank_account_id: string;
  end_date: string;
  status: string;
  closed_at: string | null;
  cuenta_de_banco: string | null;
  nombre_de_cuenta: string;
}

/**
 * La cuenta de contrapartida: la que dijo el llamador, o la del rol.
 *
 * Cuando no hay ninguna de las dos, el error NOMBRA EL ROL QUE FALTA y por qué
 * no se eligió una parecida. Es la diferencia entre «no se pudo» y «no se
 * quiso»: un rol sin sembrar es trabajo con nombre para F05d, y una cuenta
 * inventada es un asiento que nadie va a revisar dos veces.
 */
async function cuentaDeLaContrapartida(
  entityId: string,
  tipo: TipoDeAjuste,
  cuenta?: string
): Promise<string> {
  if (cuenta !== undefined && cuenta.trim() !== '') return cuenta.trim();

  const rol = ROL_DE_AJUSTE[tipo];
  if (rol === null) {
    const hueco = ROLES_QUE_FALTAN.find((r) => r.tipo === tipo);
    throw new ValidationError(
      hueco
        ? `El ajuste "${tipo}" no tiene rol contable que resolver: falta sembrar "${hueco.rol}". ` +
            `${hueco.porque} Indica la cuenta con la que quieres proponerlo.`
        : `El ajuste "${tipo}" no tiene una cuenta que se pueda deducir —depende de qué se ` +
            `registró mal—. Indica la cuenta.`
    );
  }

  const r = await query<{ code: string }>(
    `SELECT a.code
       FROM account_roles ar
       JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role = $2 AND ar.qualifier IS NULL
      LIMIT 1`,
    [entityId, rol]
  );
  if (r.rows.length === 0) {
    throw new ValidationError(
      `El ajuste "${tipo}" se apoya en el rol contable "${rol}", que esta entidad no tiene mapeado. ` +
        `Apúntalo con \`mnemosine account role set ${rol} <cuenta>\` o indica la cuenta aquí.`
    );
  }
  return r.rows[0].code;
}

/**
 * Crea un ajuste de conciliación: la fila que lo ata a la sesión y el BORRADOR
 * que lo materializa. Nunca un asiento.
 *
 * EL ORDEN —borrador primero, fila después— ESTÁ ELEGIDO POR CUÁL FALLO DUELE
 * MENOS. `createDraft` escribe por el pool y no admite el `client` de una
 * transacción, así que los dos escritos no pueden ser atómicos sin duplicar
 * aquí el INSERT de `ai_drafts`, que es de otro dueño. De los dos huérfanos
 * posibles:
 *
 *   · fila sin borrador: un ajuste que la sesión cuenta y que nada va a
 *     contabilizar nunca. Silencioso, y descuadra al cerrar.
 *   · borrador sin fila: un pendiente de más en `mnemosine review`, con su
 *     descripción diciendo de qué sesión salió. Visible, y se rechaza.
 *
 * Se elige el segundo, y si ocurre el error lo dice con el id del borrador para
 * que se pueda rechazar en vez de quedar rondando.
 */
export async function crearAjuste(
  entityId: string,
  sessionId: string,
  entrada: EntradaDeAjuste,
  userId: string,
  opts: OpcionesDeAjuste = {}
): Promise<AjusteCreado> {
  const direccion = direccionDeAjuste(entrada.tipo, entrada.importe);

  const ses = await query<FilaSesionParaAjuste>(
    // La sesión, su cuenta y el código de la cuenta de mayor del banco en una
    // sola lectura, acotada por entidad en los DOS extremos del JOIN: la
    // sesión la lleva y la cuenta bancaria también, y el vínculo entre la
    // cuenta y el plan es `gl_account_id`.
    `SELECT s.id,
            s.bank_account_id,
            to_char(s.end_date,'YYYY-MM-DD')  AS end_date,
            s.status,
            to_char(s.closed_at,'YYYY-MM-DD') AS closed_at,
            a.code                            AS cuenta_de_banco,
            ba.account_name                   AS nombre_de_cuenta
       FROM reconciliation_sessions s
       JOIN bank_accounts ba ON ba.id = s.bank_account_id
       LEFT JOIN accounts a  ON a.id = ba.gl_account_id AND a.entity_id = s.entity_id
      WHERE s.id = $1 AND s.entity_id = $2 AND ba.entity_id = $2`,
    [sessionId, entityId]
  );
  if (ses.rows.length === 0) throw new NotFoundError('Reconciliation Session', sessionId);
  const sesion = ses.rows[0];

  if (sesion.status !== 'in_progress' || sesion.closed_at !== null) {
    throw new ConflictError(
      `La sesión ${sessionId} está en estado "${sesion.status}": no admite ajustes nuevos. ` +
        `Sus cifras son el resumen congelado al cerrar, y un ajuste posterior las contradiría.`
    );
  }
  if (sesion.cuenta_de_banco === null) {
    // `gl_account_id` es NOT NULL, así que llegar aquí significa que apunta a
    // una cuenta de OTRA entidad: no es un dato que falte, es uno que miente.
    throw new ValidationError(
      `La cuenta bancaria "${sesion.nombre_de_cuenta}" apunta a una cuenta de mayor que no ` +
        `pertenece a esta entidad. No se propone ningún asiento contra ella.`
    );
  }

  // LA PARTIDA QUE EL AJUSTE EXPLICA, ACOTADA POR ENTIDAD Y POR SESIÓN DENTRO
  // DEL SQL.
  //
  // `reconciling_item_id` entraba tal cual al INSERT, y la foránea de la 053
  // sólo prueba que la fila existe EN ALGUNA entidad: con el id de una partida
  // de la entidad hermana, el ajuste se creaba y quedaba una fila de A
  // apuntando a los libros de B. No filtraba nada hoy —nadie la sigue a través
  // de la frontera— y ésa es exactamente la forma en que las dos fugas
  // anteriores de este módulo llegaron a producción: un vínculo que todavía no
  // se lee. Comprobado contra Postgres con `crearEntidadHermana`.
  //
  // Se exige también que sea de ESTA sesión: un ajuste explica una partida de
  // la conciliación en la que nace, y un vínculo a otra sesión haría que
  // `listarAjustes` enseñara una referencia que su propia sesión no puede
  // resolver.
  if (opts.reconcilingItemId !== undefined) {
    const ri = await query<{ id: string }>(
      `SELECT ri.id
         FROM reconciling_items ri
         JOIN reconciliation_sessions s ON s.id = ri.reconciliation_session_id
        WHERE ri.id = $1
          AND ri.entity_id = $2
          AND s.entity_id = $2
          AND ri.reconciliation_session_id = $3`,
      [opts.reconcilingItemId, entityId, sessionId]
    );
    if (ri.rows.length === 0) {
      // 404 y no 403, como el resto del sistema: quien no es dueño no
      // distingue una partida ajena de una inexistente.
      throw new NotFoundError('Reconciling Item', opts.reconcilingItemId);
    }
  }

  const cuenta = await cuentaDeLaContrapartida(entityId, entrada.tipo, entrada.cuenta);
  if (cuenta === sesion.cuenta_de_banco) {
    throw new ValidationError(
      `La contrapartida del ajuste no puede ser la propia cuenta de banco (${cuenta}): el asiento ` +
        `se cargaría y se abonaría a sí mismo y no movería ningún saldo.`
    );
  }

  const descripcion =
    opts.descripcion ??
    `Conciliación bancaria ${sesion.end_date} · ${sesion.nombre_de_cuenta} · ${entrada.tipo}`;
  const lineas = lineasDelAjuste(direccion, cuenta, sesion.cuenta_de_banco, entrada.tipo, descripcion);

  const ctx = opts.ctx ?? (await resolveEntity(entityId));
  if (ctx.entityId !== entityId) {
    throw new ValidationError(
      `El contexto recibido es de la entidad ${ctx.entityId} y el ajuste es de ${entityId}. ` +
        `No se cruza: el borrador acabaría en los libros de otro.`
    );
  }

  const payload: DraftPayload = {
    entry_date: opts.fecha ?? sesion.end_date,
    description: descripcion,
    // La referencia ata el borrador a su sesión desde dentro del payload, que
    // es lo único que `mnemosine review` enseña. Sin ella, quien revisa ve un
    // asiento de comisión sin saber de qué conciliación salió.
    reference: `recon:${sessionId}`,
    lines: lineas,
  };

  const draft = await createDraft(ctx, {
    payload,
    confidence: opts.confianza ?? CONFIANZA_POR_OMISION,
    reasoning:
      `Ajuste de conciliación bancaria (${entrada.tipo}) detectado en la sesión ${sessionId}. ` +
      `El importe sale del extracto; la cuenta ${cuenta} es una propuesta y por eso esto es un ` +
      `borrador: la conciliación no contabiliza por su cuenta.`,
    model: PRODUCTOR,
  });

  const id = uuidv4();
  try {
    await query(
      // `journal_entry_id` NO SE PASA. No es que se pase null: no aparece en la
      // sentencia, para que ningún cambio futuro en este archivo pueda
      // rellenarlo por descuido. Lo rellena F05d.
      `INSERT INTO reconciliation_adjustments
         (id, entity_id, reconciliation_session_id, reconciling_item_id,
          tipo, importe, draft_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        entityId,
        sessionId,
        opts.reconcilingItemId ?? null,
        entrada.tipo,
        // Firmado, como llegó: la fila conserva la dirección aunque el asiento
        // la exprese con débitos y créditos.
        monto(new Decimal(entrada.importe)),
        draft.id,
        userId,
      ]
    );
  } catch (err) {
    throw new ConflictError(
      `El borrador ${draft.id} se creó pero el ajuste no pudo registrarse en la sesión ` +
        `${sessionId}: ${(err as Error).message}. Recházalo con \`mnemosine review reject ` +
        `${draft.id}\` para que no quede pendiente sin dueño.`
    );
  }

  return {
    id,
    tipo: entrada.tipo,
    importe: monto(new Decimal(entrada.importe)),
    cuenta,
    cuentaDeBanco: sesion.cuenta_de_banco,
    draftId: draft.id,
    journalEntryId: null,
    lineas,
  };
}

export interface AjusteDeSesion {
  id: string;
  tipo: TipoDeAjuste;
  importe: string;
  reconcilingItemId: string | null;
  draftId: string | null;
  /** El estado del borrador: es la prueba, fila a fila, de que nada se posteó solo. */
  estadoDelBorrador: string | null;
  journalEntryId: string | null;
  creadoEl: string;
  creadoPor: string;
}

interface FilaAjuste {
  id: string;
  tipo: string;
  importe: string;
  reconciling_item_id: string | null;
  draft_id: string | null;
  estado_del_borrador: string | null;
  journal_entry_id: string | null;
  creado_el: string;
  created_by: string;
}

/**
 * Los ajustes de una sesión, con el estado de su borrador al lado.
 *
 * Que `estadoDelBorrador` y `journalEntryId` viajen juntos es deliberado:
 * mientras el segundo sea null y el primero diga `pending_review`, la promesa
 * de la fila 1246 se puede COMPROBAR mirando la salida, no leyendo el código.
 */
export async function listarAjustes(entityId: string, sessionId: string): Promise<AjusteDeSesion[]> {
  const r = await query<FilaAjuste>(
    `SELECT ra.id,
            ra.tipo,
            ra.importe::text AS importe,
            ra.reconciling_item_id,
            ra.draft_id,
            d.status         AS estado_del_borrador,
            ra.journal_entry_id,
            to_char(ra.created_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS creado_el,
            ra.created_by
       FROM reconciliation_adjustments ra
       JOIN reconciliation_sessions s ON s.id = ra.reconciliation_session_id
       LEFT JOIN ai_drafts d ON d.id = ra.draft_id AND d.entity_id = ra.entity_id
      WHERE ra.entity_id = $1
        AND s.entity_id = $1
        AND s.id = $2
      ORDER BY ra.created_at ASC`,
    [entityId, sessionId]
  );

  return r.rows.map((f) => ({
    id: f.id,
    tipo: f.tipo as TipoDeAjuste,
    importe: monto(new Decimal(f.importe)),
    reconcilingItemId: f.reconciling_item_id,
    draftId: f.draft_id,
    estadoDelBorrador: f.estado_del_borrador,
    journalEntryId: f.journal_entry_id,
    creadoEl: f.creado_el,
    creadoPor: f.created_by,
  }));
}
