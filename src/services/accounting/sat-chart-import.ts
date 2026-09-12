import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import type { PolicyContext } from '../policy/policy-service.js';
import {
  readCtaCatalogo,
  type CatalogFileRead,
  type CatalogFileRow,
  type CatalogReadFinding,
} from '../sat/anexo24/catalog-reader.js';
import {
  readAgrupador,
  accountTypeFrom,
  baseDesdeNaturaleza,
  baseOfAccountType,
  naturalezaDelTipo,
  type AgrupadorReading,
  type BaseAccountType,
} from './sat-agrupador-account-type.js';
import type { AccountType, NormalBalance } from './account-service.js';

// ============================================================
// O1 · EL ALTA DE CUENTAS DESDE EL CtaCatalogo — LA PRIMERA CAPA
//
// El onboarding de este sistema tiene cuatro capas —catálogo, balanza de
// apertura al corte, auxiliares abiertos, CFDI del ejercicio— y ésta es la
// primera. Sin ella las otras tres no tienen dónde posar un peso.
//
// Está partido en dos, igual que su espejo `catalogo-cuentas.ts`:
//
//   · `planSatChartImport` es PURO: recibe el archivo ya leído y las cuentas
//     que la entidad ya tiene, y devuelve QUÉ se crearía, qué no, y por qué.
//     No toca la base. Es lo que permite enseñar el plan antes de escribir —
//     un `--dry-run` de verdad, no una promesa— y probar cada borde sin
//     levantar un Postgres.
//   · `importSatChart` es la E/S: comprueba entidad, inquilino y RFC dentro
//     del SQL, llama al plan y escribe en una sola transacción.
//
// ── LAS TRES DECISIONES QUE HAY QUE ARGUMENTAR ──────────────────────────
//
// 1. LOS CÓDIGOS DEL CLIENTE SE RESPETAN TAL CUAL. `NumCta` entra a
//    `accounts.code` sin tocar: ni se renumera, ni se rellena con ceros, ni
//    se normaliza el separador. Es el catálogo del despacho y lo va a seguir
//    leyendo en su balanza, en sus pólizas y en sus papeles de trabajo; un
//    sistema que le cambia los números le pide que aprenda su propia
//    contabilidad otra vez. Donde este sistema necesita saber QUÉ es una
//    cuenta —el banco, el IVA— existen los ROLES, que son otro asunto y no
//    dependen del número.
//
// 2. QUIÉN GANA AL REIMPORTAR: EL SISTEMA, SIEMPRE. Una cuenta cuyo código
//    ya existe en la entidad NO se toca —ni el nombre, ni el agrupador, ni la
//    naturaleza— y sus diferencias contra el archivo se NOMBRAN en el
//    informe. El motivo es cuál de los dos errores se puede deshacer: si el
//    archivo gana, la corrección que un contador hizo a mano después de la
//    primera importación desaparece sin dejar rastro y nadie sabe que
//    existió; si gana el sistema, la diferencia sigue ahí, escrita en el
//    informe, y arreglarla es un cambio deliberado de una persona. Volver a
//    correr la importación es, además, lo que uno hace cuando la primera se
//    quedó a medias — no un acto que deba revertir el trabajo hecho entre
//    medias.
//
// 3. TODO O NADA, SALVO QUE SE PIDA LO CONTRARIO. Si alguna fila no se puede
//    crear, por omisión NO SE ESCRIBE NADA (`parcial: false`). Un catálogo a
//    medias es peor que ninguno: la balanza de apertura que viene detrás
//    cuadraría o no cuadraría por razones que nadie puede rastrear, y el
//    criterio de esta tarjeta —la balanza vieja y la nuestra iguales AL
//    PESO— dejaría de significar nada. Con `parcial: true` se escribe lo que
//    se pueda, a sabiendas y por decisión de quien migra.
//
// ── DOS COSAS QUE EL ARCHIVO NO DICE Y AQUÍ NO SE INVENTAN ──────────────
//
// `is_header` NO se deduce de tener hijos. Es tentador —una cuenta con
// subcuentas suele ser de agrupación— y tendría una consecuencia inmediata:
// el CHECK de la 001 obliga a `allow_manual_entries = false` en una cuenta
// cabecera, así que la capa siguiente, la de la balanza de apertura, no
// podría posar un saldo sobre ella. Y la balanza del Anexo 24 declara saldo
// para TODOS los niveles. Toda cuenta importada nace posteable; quien quiera
// convertir una en cabecera lo hace a propósito, con `account edit`.
//
// `fs_category` se queda en NULL. Se podría intuir del rubro —los 1xx del 100
// al 121 son circulante y del 151 en adelante fijo—, pero eso es una lectura
// NUESTRA de dónde puso el SAT cada rubro, no algo que la publicación
// declare, y `fs_category` decide en qué renglón del balance aparece la
// cuenta. Una casilla vacía se ve; una mal puesta se presenta.
// ============================================================

/** Por qué una fila del archivo no llegó a ser cuenta. */
export type SkipReason =
  /** `SubCtaDe` no está en el archivo ni entre las cuentas de la entidad. */
  | 'padre_ausente'
  /** El padre tampoco se pudo crear, así que el hijo no tiene de dónde colgar. */
  | 'padre_omitido'
  /** La cadena de `SubCtaDe` se muerde la cola. */
  | 'jerarquia_ciclica'
  /** Ni el agrupador ni el padre dicen de qué es la cuenta. */
  | 'sin_tipo_deducible'
  /** Cuenta de orden: este esquema no tiene casilla para ella. */
  | 'cuentas_de_orden';

/** De dónde salió el `account_type` con el que la cuenta va a nacer. */
export type TypeOrigin =
  /** El rubro del agrupador lo dijo. */
  | 'agrupador'
  /** El rubro admitía los dos signos (700) y la naturaleza desempató. */
  | 'agrupador_y_naturaleza'
  /** El agrupador no servía y la cuenta hereda el tipo de su padre. */
  | 'padre';

/** Una cuenta de la entidad tal como está HOY. El plan se calcula contra esto. */
export interface ExistingAccountRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  account_level: number;
  codigo_agrupador_sat: string | null;
}

export interface PlannedAccount {
  fila: number;
  code: string;
  name: string;
  /** El código del padre al que se enganchará, o `null` si nace de raíz. */
  parentCode: string | null;
  /** true si ese padre ya vive en la entidad y no viene en este archivo. */
  parentYaExistia: boolean;
  codAgrup: string;
  accountType: AccountType;
  base: BaseAccountType;
  normalBalance: NormalBalance;
  /** El `Nivel` que el archivo declara. */
  nivelDeclarado: number;
  /** La profundidad que la jerarquía produce de verdad. */
  nivelEfectivo: number;
  agrupador: AgrupadorReading;
  origenDelTipo: TypeOrigin;
}

export interface SkippedRow {
  fila: number;
  code: string;
  motivo: SkipReason;
  detalle: string;
}

/** Una diferencia entre lo que el archivo dice y lo que la entidad tiene. */
export interface Divergence {
  campo: 'name' | 'codigo_agrupador_sat' | 'normal_balance';
  enElArchivo: string;
  enElSistema: string;
}

export interface ExistingMatch {
  fila: number;
  code: string;
  id: string;
  divergencias: readonly Divergence[];
}

export interface ChartImportPlan {
  /** En orden de dependencia: el padre SIEMPRE antes que el hijo. */
  aCrear: readonly PlannedAccount[];
  yaExistian: readonly ExistingMatch[];
  omitidas: readonly SkippedRow[];
  findings: readonly CatalogReadFinding[];
  /** false si el archivo trae un defecto que impide importar nada. */
  puedeImportarse: boolean;
  /** true cuando toda fila del archivo o se crea o ya estaba. */
  completa: boolean;
}

function finding(
  regla: string,
  severidad: 'bloquea' | 'aviso',
  fila: number | undefined,
  numCta: string | undefined,
  mensaje: string
): CatalogReadFinding {
  return {
    regla,
    severidad,
    ...(fila === undefined ? {} : { fila }),
    ...(numCta === undefined ? {} : { numCta }),
    mensaje,
  };
}

/**
 * Ordena las filas por dependencia y devuelve las que forman ciclo.
 *
 * EL ORDEN DEL ARCHIVO NO SIRVE, y no es una hipótesis: el generador de este
 * mismo repositorio ordena por código —`100-01` antes que `100-02`, sí, pero
 * también antes que un padre que se llamara `900`—, y un exportador ajeno
 * ordena por lo que le convenga. `accounts.parent_id` es una clave foránea a
 * la propia tabla: el padre tiene que estar insertado ANTES.
 *
 * NO HACE FALTA CONTAR GRADOS DE ENTRADA. `SubCtaDe` es uno solo: cada fila
 * tiene A LO SUMO UN padre, así que el grafo es un bosque más, si acaso,
 * algún ciclo. Basta con salir de las raíces y bajar. Y lo que sobra ES la
 * respuesta: lo que no se alcanza desde ninguna raíz es exactamente lo que
 * cuelga de un ciclo, con nombre y apellido, que es lo que hay que decir.
 */
function ordenarPorDependencia(rows: readonly CatalogFileRow[]): {
  orden: CatalogFileRow[];
  ciclo: CatalogFileRow[];
} {
  const porCodigo = new Map(rows.map((r) => [r.numCta, r]));
  const hijos = new Map<string, CatalogFileRow[]>();
  const orden: CatalogFileRow[] = [];

  for (const r of rows) {
    // Sólo cuenta como dependencia el padre que viene EN EL ARCHIVO. Uno que
    // ya vive en la entidad no impone orden: está insertado desde antes.
    //
    // La cuenta que se declara padre de SÍ MISMA cae aquí como hija suya, no
    // como raíz: es un ciclo de uno y tiene que salir por donde salen los
    // ciclos. Tratarla como raíz haría que el informe dijera «padre ausente»
    // de un padre que está en la misma fila.
    if (r.subCtaDe !== null && porCodigo.has(r.subCtaDe)) {
      const lista = hijos.get(r.subCtaDe) ?? [];
      lista.push(r);
      hijos.set(r.subCtaDe, lista);
    } else {
      orden.push(r);
    }
  }

  // `orden` crece mientras se recorre: cada hijo entra justo detrás de su
  // padre, y como el padre es único ninguno entra dos veces.
  for (let i = 0; i < orden.length; i++) {
    for (const hijo of hijos.get(orden[i].numCta) ?? []) orden.push(hijo);
  }

  const colocadas = new Set(orden.map((r) => r.numCta));
  return { orden, ciclo: rows.filter((r) => !colocadas.has(r.numCta)) };
}

/**
 * Qué se crearía y qué no. Función pura: mismas entradas, mismo plan.
 */
export function planSatChartImport(
  lectura: CatalogFileRead,
  existentes: readonly ExistingAccountRow[]
): ChartImportPlan {
  const findings: CatalogReadFinding[] = [...lectura.findings];

  if (!lectura.puedeImportarse) {
    // No se planea sobre un archivo que ya se sabe que no se puede importar:
    // el plan diría qué cuentas nacerían de unas filas que no se van a leer,
    // y eso es una promesa que nadie va a cumplir.
    return {
      aCrear: [],
      yaExistian: [],
      omitidas: [],
      findings,
      puedeImportarse: false,
      completa: false,
    };
  }

  const porCodigoExistente = new Map(existentes.map((e) => [e.code, e]));
  const { orden, ciclo } = ordenarPorDependencia(lectura.rows);

  if (ciclo.length > 0) {
    // Se devuelve AQUÍ, sin plan. Un ciclo no deja fuera sólo a sus miembros:
    // deja el archivo sin un orden en el que insertarlo, y presentar un plan
    // de creación junto a un veredicto de «no se puede importar» invita a que
    // alguien ejecute la mitad de arriba.
    findings.push(
      finding(
        'IMP-CICLO',
        'bloquea',
        undefined,
        undefined,
        `La jerarquía del archivo se muerde la cola: ${ciclo
          .map((r) => `"${r.numCta}" (fila ${r.fila}) cuelga de "${r.subCtaDe ?? ''}"`)
          .join('; ')}. Ninguna de esas cuentas puede insertarse antes que su padre porque cada una ` +
          `es antepasada de sí misma. No se importa nada: arregla el SubCtaDe en el origen.`
      )
    );
    return {
      aCrear: [],
      yaExistian: [],
      omitidas: ciclo.map((r) => ({
        fila: r.fila,
        code: r.numCta,
        motivo: 'jerarquia_ciclica' as const,
        detalle: `SubCtaDe="${r.subCtaDe ?? ''}"`,
      })),
      findings,
      puedeImportarse: false,
      completa: false,
    };
  }

  const omitidas: SkippedRow[] = [];
  const aCrear: PlannedAccount[] = [];
  const yaExistian: ExistingMatch[] = [];
  /** El tipo base con el que cada código quedará, para que sus hijos hereden. */
  const baseResuelta = new Map<string, BaseAccountType>();
  /** La profundidad efectiva de cada código, ya sea nueva o preexistente. */
  const nivelResuelto = new Map<string, number>();
  const descartadas = new Set<string>();

  for (const e of existentes) {
    const base = baseOfAccountType(e.account_type);
    if (base !== null) baseResuelta.set(e.code, base);
    nivelResuelto.set(e.code, e.account_level);
  }

  for (const r of orden) {
    const yaEsta = porCodigoExistente.get(r.numCta);
    if (yaEsta !== undefined) {
      const divergencias: Divergence[] = [];
      if (yaEsta.name !== r.desc) {
        divergencias.push({ campo: 'name', enElArchivo: r.desc, enElSistema: yaEsta.name });
      }
      const agrupadorSistema = yaEsta.codigo_agrupador_sat ?? '';
      if (agrupadorSistema !== r.codAgrup) {
        divergencias.push({
          campo: 'codigo_agrupador_sat',
          enElArchivo: r.codAgrup,
          enElSistema: agrupadorSistema,
        });
      }
      const naturSistema = yaEsta.normal_balance === 'debit' ? 'D' : 'A';
      if (naturSistema !== r.natur) {
        divergencias.push({
          campo: 'normal_balance',
          enElArchivo: r.natur === 'D' ? 'debit' : 'credit',
          enElSistema: yaEsta.normal_balance,
        });
      }
      yaExistian.push({ fila: r.fila, code: r.numCta, id: yaEsta.id, divergencias });

      if (divergencias.length > 0) {
        findings.push(
          finding(
            'IMP-YA-EXISTIA-DISTINTA',
            'aviso',
            r.fila,
            r.numCta,
            `"${r.numCta}" ya existe en la entidad y NO se toca, pero el archivo la describe de otra ` +
              `manera: ${divergencias
                .map((d) => `${d.campo} archivo="${d.enElArchivo}" sistema="${d.enElSistema}"`)
                .join('; ')}. Gana lo que ya está: una reimportación no puede borrar la corrección ` +
              `que alguien hizo a mano. Si la buena es la del archivo, cámbiala a propósito.`
          )
        );
      }
      continue;
    }

    // ── EL PADRE ────────────────────────────────────────────────────────
    let parentCode: string | null = null;
    let parentYaExistia = false;
    let nivelDelPadre = 0;
    if (r.subCtaDe !== null) {
      if (descartadas.has(r.subCtaDe)) {
        descartadas.add(r.numCta);
        omitidas.push({
          fila: r.fila,
          code: r.numCta,
          motivo: 'padre_omitido',
          detalle: `SubCtaDe="${r.subCtaDe}"`,
        });
        findings.push(
          finding(
            'IMP-PADRE-OMITIDO',
            'aviso',
            r.fila,
            r.numCta,
            `"${r.numCta}" cuelga de "${r.subCtaDe}", que tampoco se pudo crear, así que se queda ` +
              `fuera con él. Arreglar el padre arregla a toda su descendencia de una vez.`
          )
        );
        continue;
      }
      // `nivelResuelto` es el superconjunto: lleva toda cuenta que existe o
      // que se va a crear, incluida la que existe con un tipo que este módulo
      // no sabe traducir (ésa está aquí y NO en `baseResuelta`, que es justo
      // lo que hace que sus hijos caigan en «sin tipo deducible» en vez de
      // heredar un tipo inventado).
      const nivelPadre = nivelResuelto.get(r.subCtaDe);
      if (nivelPadre === undefined) {
        descartadas.add(r.numCta);
        omitidas.push({
          fila: r.fila,
          code: r.numCta,
          motivo: 'padre_ausente',
          detalle: `SubCtaDe="${r.subCtaDe}"`,
        });
        findings.push(
          finding(
            'IMP-PADRE-AUSENTE',
            'aviso',
            r.fila,
            r.numCta,
            `"${r.numCta}" declara SubCtaDe="${r.subCtaDe}", que no está en el archivo ni entre las ` +
              `cuentas de la entidad. La referencia no resuelve contra nada, así que la cuenta no se ` +
              `crea: colgarla de la raíz cambiaría la jerarquía que el SAT lee.`
          )
        );
        continue;
      }
      parentCode = r.subCtaDe;
      parentYaExistia = porCodigoExistente.has(r.subCtaDe);
      nivelDelPadre = nivelPadre;
    }

    // ── EL TIPO ─────────────────────────────────────────────────────────
    const agrupador = readAgrupador(r.codAgrup);
    let base: BaseAccountType | null = null;
    let origenDelTipo: TypeOrigin = 'agrupador';

    if (agrupador.verdict === 'cuentas_de_orden') {
      // NO hereda del padre a propósito: heredar metería una cuenta de orden
      // en el balance, que es justo lo que se está evitando.
      descartadas.add(r.numCta);
      omitidas.push({
        fila: r.fila,
        code: r.numCta,
        motivo: 'cuentas_de_orden',
        detalle: `CodAgrup="${r.codAgrup}" (${agrupador.rubroNombre ?? ''})`,
      });
      findings.push(
        finding(
          'IMP-CUENTAS-DE-ORDEN',
          'aviso',
          r.fila,
          r.numCta,
          `"${r.numCta}" tiene agrupador ${r.codAgrup} (${agrupador.rubroNombre ?? 'cuentas de orden'}), ` +
            `que es una cuenta de ORDEN: de memoria, fuera del balance y en pareja con su ` +
            `contracuenta. Este esquema sólo tiene activo, pasivo, capital, ingreso y gasto, así que ` +
            `no hay casilla honesta donde ponerla; meterla en cualquiera sumaría al balance dinero ` +
            `que no existe. Se queda fuera y se dice.`
        )
      );
      continue;
    }

    if (agrupador.verdict === 'oficial' && agrupador.base !== null) {
      base = agrupador.base;
    } else if (agrupador.verdict === 'oficial_ambiguo') {
      base = baseDesdeNaturaleza(r.natur);
      origenDelTipo = 'agrupador_y_naturaleza';
      findings.push(
        finding(
          'IMP-RUBRO-AMBIGUO',
          'aviso',
          r.fila,
          r.numCta,
          `El agrupador ${r.codAgrup} (${agrupador.rubroNombre ?? ''}) cubre gasto e ingreso a la vez, ` +
            `así que el tipo se toma de la naturaleza declarada (${r.natur}) y la cuenta nace como ` +
            `${base === 'expense' ? 'gasto' : 'ingreso'}. Mapéala a 701/702/703/704 para que no ` +
            `dependa de eso.`
        )
      );
    } else {
      // Agrupador ausente, fuera de catálogo o sin regla: no se inventa. Lo
      // único que puede decir de qué es esta cuenta es su sitio en la
      // jerarquía, que lo declara el propio archivo.
      const heredado = parentCode === null ? undefined : baseResuelta.get(parentCode);
      if (heredado === undefined) {
        descartadas.add(r.numCta);
        omitidas.push({
          fila: r.fila,
          code: r.numCta,
          motivo: 'sin_tipo_deducible',
          detalle:
            agrupador.verdict === 'ausente'
              ? 'sin CodAgrup y sin padre del que heredar'
              : `CodAgrup="${r.codAgrup}" fuera del c_CodAgrup y sin padre del que heredar`,
        });
        findings.push(
          finding(
            'IMP-SIN-TIPO',
            'aviso',
            r.fila,
            r.numCta,
            `"${r.numCta}" no se crea: el XML no dice si es activo, pasivo, capital, ingreso o gasto, ` +
              `y aquí no hay de dónde deducirlo. ${
                agrupador.verdict === 'ausente'
                  ? 'No trae CodAgrup'
                  : `Su agrupador "${r.codAgrup}" no está en el c_CodAgrup del árbol`
              } y no cuelga de ninguna cuenta cuyo tipo se conozca. Mapéale un agrupador o dale un ` +
              `padre y vuelve a importar.`
          )
        );
        continue;
      }
      base = heredado;
      origenDelTipo = 'padre';
      findings.push(
        finding(
          'IMP-TIPO-HEREDADO',
          'aviso',
          r.fila,
          r.numCta,
          `"${r.numCta}" nace como ${heredado} porque lo hereda de su padre "${parentCode ?? ''}": ` +
            `${
              agrupador.verdict === 'ausente'
                ? 'la fila no trae CodAgrup'
                : `su agrupador "${r.codAgrup}" no está en el c_CodAgrup del árbol`
            }. La cuenta entra, pero NO se podrá declarar al SAT hasta que se le mapee un agrupador.`
        )
      );
    }

    const accountType = accountTypeFrom(base, r.natur);
    const normalBalance: NormalBalance = r.natur === 'D' ? 'debit' : 'credit';

    // ── EL NIVEL, QUE LO DECIDE LA JERARQUÍA Y NO EL ARCHIVO ────────────
    //
    // `accounts.account_level` NO se inserta: lo calcula el disparador
    // `compute_account_full_code` de la 001 a partir de `parent_id`. Así que
    // el `Nivel` del XML no es un dato que se guarde, es una AFIRMACIÓN que
    // se puede contrastar — y cuando no coincide, lo que quedará en la base
    // es lo que diga la jerarquía. Decirlo aquí evita la conversación de
    // «pero si el archivo decía 3».
    const nivelEfectivo = parentCode === null ? 1 : nivelDelPadre + 1;

    aCrear.push({
      fila: r.fila,
      code: r.numCta,
      name: r.desc,
      parentCode,
      parentYaExistia,
      codAgrup: r.codAgrup,
      accountType,
      base,
      normalBalance,
      nivelDeclarado: r.nivel,
      nivelEfectivo,
      agrupador,
      origenDelTipo,
    });
    baseResuelta.set(r.numCta, base);
    nivelResuelto.set(r.numCta, nivelEfectivo);

    if (nivelEfectivo !== r.nivel) {
      findings.push(
        finding(
          'IMP-NIVEL-DISCREPA',
          'aviso',
          r.fila,
          r.numCta,
          `"${r.numCta}" declara Nivel ${r.nivel} y la jerarquía del archivo la deja en el ` +
            `${nivelEfectivo}${parentCode === null ? ' (no cuelga de nadie)' : ` (bajo "${parentCode}")`}. ` +
            `Manda la jerarquía: account_level lo calcula el disparador de la base desde el padre, no ` +
            `se inserta. Si el Nivel del archivo es el bueno, falta un SubCtaDe.`
        )
      );
    }

    if (naturalezaDelTipo(accountType) !== r.natur) {
      findings.push(
        finding(
          'IMP-NATUR-CONTRA-TIPO',
          'aviso',
          r.fila,
          r.numCta,
          `"${r.numCta}" entra como ${accountType} con saldo normal ${normalBalance}, y ese tipo ` +
            `implica naturaleza ${naturalezaDelTipo(accountType)}. Se respeta la del archivo porque es ` +
            `la que hace que la balanza cuadre —es el caso de las devoluciones sobre ingresos y sobre ` +
            `compras, que este esquema no tiene cómo tipar aparte—, y se dice para que nadie lo ` +
            `descubra en el primer estado financiero.`
        )
      );
    }
  }

  return {
    aCrear,
    yaExistian,
    omitidas,
    findings,
    puedeImportarse: findings.every((f) => f.severidad !== 'bloquea'),
    completa: omitidas.length === 0,
  };
}

// ============================================================
// LA ENVOLTURA DE E/S
// ============================================================

export interface ImportSatChartOptions {
  entityId: string;
  /** El texto del CtaCatalogo, tal como salió del sistema de origen. */
  xml: string;
  userId: string;
  /** Corre todo y NO escribe. */
  dryRun?: boolean;
  /**
   * Escribir aunque alguna fila se quede fuera. Por omisión NO: un catálogo a
   * medias hace irrastreable el cuadre de la balanza que viene detrás.
   */
  parcial?: boolean;
  /** Por qué se importa. Va a `audit_log.reason` de cada cuenta creada. */
  reason?: string | null;
}

export interface SatChartImportReport extends ChartImportPlan {
  entityId: string;
  /** El RFC de la entidad, que es el que el archivo tuvo que traer. */
  rfc: string;
  /** Ejercicio y mes que declara el archivo. */
  anio: string;
  mes: string;
  dryRun: boolean;
  /** Cuántos nodos `Ctas` traía el archivo, defectuosos incluidos. */
  filasLeidas: number;
  /** Los códigos que se escribieron de verdad. Vacío en dry-run. */
  creadas: readonly string[];
  /** Cuántas de las filas legibles traen un agrupador del c_CodAgrup. */
  conAgrupadorValido: number;
  /** Las que no, con el motivo. Es la lista que el encargo pide nombrar. */
  sinAgrupadorValido: readonly {
    fila: number;
    code: string;
    codAgrup: string;
    motivo: AgrupadorReading['verdict'];
  }[];
  /** false cuando se rehusó escribir; el motivo está en `findings`/`omitidas`. */
  escrito: boolean;
}

/**
 * Lee el archivo, planea y escribe.
 *
 * LANZA cuando la petición es imposible —la entidad no existe o no es de este
 * inquilino, no tiene RFC, el archivo no es un CtaCatalogo, o el RFC del
 * archivo es de otro contribuyente—. Eso no es un hallazgo del catálogo: es
 * el acto equivocado, y dejarlo pasar con un informe en amarillo sería
 * dejarle a alguien la contabilidad de un tercero dentro de su entidad.
 *
 * NO lanza por lo demás: devuelve el informe con `escrito: false` y todo
 * nombrado. Quien decide el código de salida es el CLI, que además tiene que
 * poder imprimir esto en JSON.
 */
export async function importSatChart(
  ctx: PolicyContext,
  opts: ImportSatChartOptions
): Promise<SatChartImportReport> {
  // La entidad y el inquilino, en el mismo SQL: el inquilino ACOTA, no
  // ordena. Un id de entidad de otro inquilino no devuelve fila y no hay
  // rama del código donde eso se confunda con «no existe».
  const entidad = await query<{ tax_id: string; tax_id_type: string; name: string }>(
    `SELECT tax_id, tax_id_type, name
       FROM legal_entities
      WHERE id = $1 AND tenant_id = $2`,
    [opts.entityId, ctx.tenantId]
  );
  const fila = entidad.rows[0];
  if (fila === undefined) {
    throw new ValidationError(`La entidad ${opts.entityId} no existe en este inquilino.`);
  }
  if (fila.tax_id_type !== 'rfc') {
    throw new ValidationError(
      `"${fila.name}" está identificada con ${fila.tax_id_type.toUpperCase()} y no con RFC: el ` +
        `CtaCatalogo del Anexo 24 es un archivo mexicano y sólo se puede cotejar contra un RFC.`
    );
  }
  const rfc = fila.tax_id.trim().toUpperCase();

  const lectura = readCtaCatalogo(opts.xml);

  if (lectura.header.rfc !== rfc) {
    throw new ValidationError(
      `El archivo es del RFC ${lectura.header.rfc} y "${fila.name}" es ${rfc}. No se importa: cargar ` +
        `el catálogo de otro contribuyente mezcla dos contabilidades en una entidad, y separarlas ` +
        `después exige saber cuál era cuál cuenta por cuenta.`
    );
  }

  const existentes = await query<ExistingAccountRow>(
    `SELECT id, code, name, account_type, normal_balance, account_level, codigo_agrupador_sat
       FROM accounts
      WHERE entity_id = $1`,
    [opts.entityId]
  );

  const plan = planSatChartImport(lectura, existentes.rows);

  const legibles = lectura.rows.length;
  const sinAgrupadorValido = lectura.rows
    .map((r) => ({ r, lectura: readAgrupador(r.codAgrup) }))
    .filter((x) => x.lectura.verdict !== 'oficial' && x.lectura.verdict !== 'oficial_ambiguo')
    .map((x) => ({
      fila: x.r.fila,
      code: x.r.numCta,
      codAgrup: x.r.codAgrup,
      motivo: x.lectura.verdict,
    }));

  const base: SatChartImportReport = {
    ...plan,
    entityId: opts.entityId,
    rfc,
    anio: lectura.header.anio,
    mes: lectura.header.mes,
    dryRun: opts.dryRun === true,
    filasLeidas: lectura.rowsLeidas,
    creadas: [],
    conAgrupadorValido: legibles - sinAgrupadorValido.length,
    sinAgrupadorValido,
    escrito: false,
  };

  if (!plan.puedeImportarse) return base;
  if (!plan.completa && opts.parcial !== true) {
    return {
      ...base,
      findings: [
        ...plan.findings,
        finding(
          'IMP-INCOMPLETO',
          'bloquea',
          undefined,
          undefined,
          `No se escribe nada: ${plan.omitidas.length} de ${lectura.rows.length} cuentas del archivo ` +
            `no se pueden crear (${[...new Set(plan.omitidas.map((o) => o.motivo))].join(', ')}). Un ` +
            `catálogo a medias hace que la balanza de apertura cuadre o descuadre por razones que ` +
            `nadie puede rastrear, y el criterio de esta migración es que cuadre AL PESO. Arregla lo ` +
            `nombrado, o vuelve a correr con --parcial a sabiendas.`
        ),
      ],
      puedeImportarse: false,
    };
  }
  if (opts.dryRun === true) return base;
  if (plan.aCrear.length === 0) return { ...base, escrito: true };

  const creadas = await withTransaction(async (client) => {
    const tenantId = await tenantDe(client, opts.entityId);
    const porCodigo = new Map(existentes.rows.map((e) => [e.code, e.id]));
    const escritas: string[] = [];

    for (const c of plan.aCrear) {
      // El id del padre NUNCA se deja en null «por si acaso»: colgar de la
      // raíz una cuenta que el archivo declara hija cambia la jerarquía que
      // el SAT lee, y lo haría en silencio. Si faltara, revienta y la
      // transacción entera se deshace. No es alcanzable —el orden garantiza
      // que el padre pasó por aquí antes, y el guardián de abajo garantiza
      // que dejó su id—, y por eso mismo un `?? null` aquí sería una puerta
      // abierta a un fallo que nadie volvería a mirar.
      let parentId: string | null = null;
      if (c.parentCode !== null) {
        const idPadre = porCodigo.get(c.parentCode);
        if (idPadre === undefined) {
          throw new ValidationError(
            `No se pudo resolver el padre "${c.parentCode}" de la cuenta "${c.code}" al escribir. ` +
              `Se deshace la importación: media jerarquía es peor que ninguna.`
          );
        }
        parentId = idPadre;
      }
      const id = uuidv4();
      const res = await client.query<{ id: string }>(
        `INSERT INTO accounts (
           id, code, name, account_type, normal_balance, codigo_agrupador_sat,
           parent_id, entity_id, allow_manual_entries, is_header, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,false,$9)
         -- La idempotencia es de la BASE, no de la lectura previa: entre el
         -- SELECT de existentes y este INSERT cabe otra importación. El
         -- índice UNIQUE(code, entity_id) es lo único que no se puede
         -- adelantar nadie.
         ON CONFLICT (code, entity_id) DO NOTHING
         RETURNING id`,
        [
          id,
          c.code,
          c.name,
          c.accountType,
          c.normalBalance,
          // Se guarda TAL CUAL, incluso el que no está en el c_CodAgrup: es
          // el mapeo que el cliente tenía, y borrarlo por no reconocerlo
          // perdería el único dato con el que se le puede corregir. Cadena
          // vacía se guarda como NULL, que es lo que la columna significa.
          c.codAgrup === '' ? null : c.codAgrup,
          parentId,
          opts.entityId,
          opts.userId,
        ]
      );
      // Si otra transacción ganó la carrera, RETURNING viene vacío: se relee
      // para que los hijos encuentren a su padre igualmente.
      const idReal =
        res.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            'SELECT id FROM accounts WHERE code = $1 AND entity_id = $2',
            [c.code, opts.entityId]
          )
        ).rows[0]?.id;
      if (idReal === undefined) {
        // Ni se insertó ni existe: otra corrida la creó y la borró mientras
        // ésta escribía. Sus hijos se quedarían sin padre y acabarían en la
        // raíz, así que se deshace todo en vez de dejar un catálogo con la
        // jerarquía cambiada y nadie enterado.
        throw new ValidationError(
          `La cuenta "${c.code}" ni se insertó ni se pudo releer: otra escritura la creó y la ` +
            `retiró mientras ésta corría. Se deshace la importación entera; vuelve a correrla.`
        );
      }
      porCodigo.set(c.code, idReal);
      if (res.rows[0]?.id === undefined) continue;

      escritas.push(c.code);
      // G3: una cuenta es el destino del dinero, y crearla deja rastro. El
      // rastro va en la MISMA transacción que el hecho; con `query()` saldría
      // por otra conexión y un fallo entre ambos dejaría uno sin el otro.
      await registrarAuditoria(client, {
        tenantId,
        userId: opts.userId,
        action: 'create',
        entityType: 'account',
        entityId: idReal,
        oldValues: null,
        newValues: {
          code: c.code,
          name: c.name,
          account_type: c.accountType,
          normal_balance: c.normalBalance,
          codigo_agrupador_sat: c.codAgrup === '' ? null : c.codAgrup,
          parent_code: c.parentCode,
          origen: `xml-sat:CtaCatalogo:${base.anio}-${base.mes}`,
        },
        reason: opts.reason ?? null,
      });
    }
    return escritas;
  });

  return { ...base, creadas, escrito: true };
}

/**
 * El informe en texto. Quien migra necesita saber qué entró y qué no ANTES de
 * confiar en el sistema, y el que lo lee está mirando una terminal.
 */
export function renderSatChartImportReport(r: SatChartImportReport): string {
  const l: string[] = [];
  l.push(`Catálogo del SAT · RFC ${r.rfc} · ejercicio ${r.anio}-${r.mes}`);
  l.push(
    `  ${r.filasLeidas} filas en el archivo · ${r.creadas.length} cuentas creadas · ` +
      `${r.yaExistian.length} ya existían · ${r.omitidas.length} fuera`
  );
  l.push(
    `  Agrupador: ${r.conAgrupadorValido} con código del c_CodAgrup · ` +
      `${r.sinAgrupadorValido.length} sin él`
  );
  if (!r.escrito) {
    l.push(r.dryRun ? '  NADA ESCRITO: es un ensayo (--dry-run).' : '  NADA ESCRITO: ver los hallazgos.');
  }
  if (r.sinAgrupadorValido.length > 0) {
    l.push('  Sin agrupador válido:');
    for (const s of r.sinAgrupadorValido) {
      l.push(`    fila ${s.fila} · ${s.code} · ${s.codAgrup === '' ? '(vacío)' : s.codAgrup} · ${s.motivo}`);
    }
  }
  if (r.omitidas.length > 0) {
    l.push('  No entraron:');
    for (const o of r.omitidas) {
      l.push(`    fila ${o.fila} · ${o.code} · ${o.motivo} · ${o.detalle}`);
    }
  }
  if (r.findings.length > 0) {
    l.push('  Hallazgos:');
    for (const f of r.findings) {
      const donde = f.fila === undefined ? '' : ` fila ${f.fila}`;
      l.push(`    [${f.severidad}] ${f.regla}${donde}: ${f.mensaje}`);
    }
  }
  return l.join('\n');
}
