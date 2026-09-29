import {
  clasificarRfc,
  rfcIdentificaAlTercero,
  RFC_GENERICO_NACIONAL,
  type DiagnosticoRfc,
} from './rfc.js';
import type { Hallazgo } from './hallazgos.js';

// ============================================================
// F07c · EL TERCERO QUE SE DECLARA
//
// Los primeros campos del formato, y los que la 063 le dio dónde vivir: TIPO
// DE TERCERO (04 nacional, 05 extranjero, 15 global), TIPO DE OPERACIÓN (the
// 2025 catalogue, see `TipoOperacion`) y, para el extranjero, su
// identificación fiscal, su país y su nacionalidad.
//
// TODO ES PURO. Las dos políticas que deciden aquí se LEEN en diot-service.ts
// y entran como argumento, para que la regla se pueda probar con las cuatro
// combinaciones sin sembrar una entidad — y para que quede a la vista que
// contestar la política cambia la respuesta, que es lo que el panel promete.
//
// UNA SOLA INFERENCIA, Y ES LA SEGURA: un proveedor con RFC mexicano bien
// formado es nacional (04). Lo contrario —inferir 05 porque no hay RFC— no se
// hace: el extranjero se declara con sus tres datos, y no tenerlos no es una
// pista de que lo sea, es la ausencia de la información que haría falta.
// ============================================================

export type TipoTercero = '04' | '05' | '15';
/**
 * Operation types of the 2025 DIOT catalogue (SAT instructivo de carga masiva,
 * Enero 2025, §3.1 — cited in sat-batch.ts): 02 transfer of goods, 03
 * professional services, 06 temporary use of goods, 07 import of goods or
 * services, 08 import by virtual transfer, 85 other. 87 (global operations)
 * is not stored: it follows from third-party type 15.
 */
export type TipoOperacion = '02' | '03' | '06' | '07' | '08' | '85';

const TIPOS_TERCERO: readonly string[] = ['04', '05', '15'];
const TIPOS_OPERACION: readonly string[] = ['02', '03', '06', '07', '08', '85'];

/** Operation types §3.1 accepts for each third-party type. */
export const OPERATIONS_BY_PARTY_TYPE: Readonly<Record<TipoTercero, readonly string[]>> = Object.freeze({
  '04': ['02', '03', '06', '08', '85'],
  '05': ['02', '03', '07'],
  '15': ['87'],
});

/** Values each default-operation policy may hold, besides its "block" value. */
const NATIONAL_DEFAULTS: readonly string[] = ['85', '02', '03', '06'];
const FOREIGN_DEFAULTS: readonly string[] = ['07', '03', '02'];

/** La fila de `vendors`, con lo que la 063 le añadió. */
export interface TerceroCrudo {
  vendorId: string;
  nombre: string;
  taxId: string | null;
  taxIdType: string | null;
  tipoTercero: string | null;
  tipoOperacion: string | null;
  idFiscalExtranjero: string | null;
  paisResidencia: string | null;
  nacionalidad: string | null;
}

export type Procedencia = 'declarado' | 'inferido' | 'politica';

export interface TerceroDiot {
  vendorId: string;
  nombre: string;
  tipoTercero: TipoTercero;
  tipoOperacion: TipoOperacion;
  /** Presente en el nacional (04) y en el global (15). */
  rfc?: string;
  idFiscalExtranjero?: string;
  paisResidencia?: string;
  nacionalidad?: string;
  /**
   * De dónde salió cada campo. Va al papel de trabajo: la diferencia entre un
   * 85 que el contador escribió y un 85 que puso el sistema por omisión es
   * exactamente lo que la política promete enseñar.
   */
  procedencia: { tipoTercero: Procedencia; tipoOperacion: Procedencia };
}

export interface PoliticasDelTercero {
  /** `diot_tipo_operacion_por_omision`: '85' | '03' | 'bloquear'. */
  tipoOperacionPorOmision: string;
  /** `diot_tercero_sin_rfc`: 'bloquear' | 'declarar_global'. */
  terceroSinRfc: string;
  /** `diot_default_operation_type_foreign`: '07' | '03' | '02' | 'block'. */
  foreignOperationDefault: string;
}

export interface ResolucionDeTercero {
  /** null cuando algo bloqueante impide declararlo. */
  tercero: TerceroDiot | null;
  hallazgos: Hallazgo[];
}

function tipoOperacionDe(
  crudo: TerceroCrudo,
  partyType: TipoTercero,
  politicas: PoliticasDelTercero,
  hallazgos: Hallazgo[]
): { valor: TipoOperacion; procedencia: Procedencia } | null {
  const foreign = partyType === '05';
  // Global (15) is written as 87 whatever is stored; it borrows the national
  // policy only so the working paper has something to show.
  const allowed = OPERATIONS_BY_PARTY_TYPE[foreign ? '05' : '04'];
  const declarado = (crudo.tipoOperacion ?? '').trim();
  if (TIPOS_OPERACION.includes(declarado)) {
    if (partyType !== '15' && !allowed.includes(declarado)) {
      // Caught while building, not when the batch file is written: the fix is
      // in the vendor record, and `diot check` must already say so.
      hallazgos.push({
        codigo: 'DIOT-OPERATION-TYPE-NOT-ALLOWED',
        severidad: 'bloqueante',
        vendorId: crudo.vendorId,
        mensaje:
          `El proveedor ${crudo.nombre} es tercero ${partyType} y tiene capturado el tipo de ` +
          `operación ${declarado}, que el catálogo 2025 de la DIOT no admite para ese tipo de ` +
          `tercero (§3.1: ${allowed.join(', ')}). Corrige el tipo de operación del proveedor.`,
      });
      return null;
    }
    return { valor: declarado as TipoOperacion, procedencia: 'declarado' };
  }

  const key = foreign ? 'diot_default_operation_type_foreign' : 'diot_tipo_operacion_por_omision';
  const politica = (foreign ? politicas.foreignOperationDefault : politicas.tipoOperacionPorOmision).trim();
  const defaults = foreign ? FOREIGN_DEFAULTS : NATIONAL_DEFAULTS;
  if (politica === (foreign ? 'block' : 'bloquear')) {
    hallazgos.push({
      codigo: 'DIOT-TIPO-OPERACION-SIN-DECLARAR',
      severidad: 'bloqueante',
      politica: key,
      vendorId: crudo.vendorId,
      mensaje:
        `El proveedor ${crudo.nombre} no tiene tipo de operación declarado y la política ` +
        `pide no suponer ninguno. Es un dato del PROVEEDOR, no de la factura: se captura una ` +
        `vez y vale para todos los meses.`,
    });
    return null;
  }
  if (!defaults.includes(politica)) {
    hallazgos.push({
      codigo: 'DIOT-POLITICA-FUERA-DE-CATALOGO',
      severidad: 'bloqueante',
      politica: key,
      vendorId: crudo.vendorId,
      mensaje:
        `La política ${key} vale "${politica}", que no es ${defaults.join(', ')}. ` +
        `Se prefiere detenerse a inventar una equivalencia: el catálogo lo fija la autoridad.`,
    });
    return null;
  }

  hallazgos.push({
    codigo: 'DIOT-TIPO-OPERACION-POR-OMISION',
    severidad: 'aviso',
    politica: key,
    vendorId: crudo.vendorId,
    mensaje:
      `El proveedor ${crudo.nombre} se declara con tipo de operación ${politica} por omisión: ` +
      `no lo tiene capturado. Afínalo si su operación es otra de las que admite el catálogo ` +
      `(§3.1: ${allowed.join(', ')}).`,
  });
  return { valor: politica as TipoOperacion, procedencia: 'politica' };
}

function resolverExtranjero(crudo: TerceroCrudo, hallazgos: Hallazgo[]): boolean {
  const faltan: string[] = [];
  if (!(crudo.idFiscalExtranjero ?? '').trim()) faltan.push('número de identificación fiscal');
  if (!(crudo.paisResidencia ?? '').trim()) faltan.push('país de residencia');
  if (!(crudo.nacionalidad ?? '').trim()) faltan.push('nacionalidad');
  if (faltan.length === 0) return true;

  hallazgos.push({
    codigo: 'DIOT-EXTRANJERO-INCOMPLETO',
    severidad: 'bloqueante',
    vendorId: crudo.vendorId,
    mensaje:
      `El proveedor ${crudo.nombre} se declara como tercero extranjero (05) y le falta: ` +
      `${faltan.join(', ')}. El formato pide los tres, y una fila de tipo 05 incompleta la ` +
      `rechaza la autoridad al recibir el archivo, cuando el plazo ya corrió.`,
  });
  return false;
}

/**
 * El tercero, resuelto, o la razón por la que no se puede declarar.
 *
 * EL ORDEN IMPORTA: primero el tipo de tercero, porque decide qué se le exige.
 * A un extranjero no se le pide RFC —la DIOT lo identifica por su
 * identificación fiscal—, así que empezar por el RFC habría bloqueado al
 * proveedor extranjero mejor capturado del expediente.
 */
export function resolverTercero(
  crudo: TerceroCrudo,
  politicas: PoliticasDelTercero
): ResolucionDeTercero {
  const hallazgos: Hallazgo[] = [];
  const diag: DiagnosticoRfc = clasificarRfc(crudo.taxId);
  const declarado = (crudo.tipoTercero ?? '').trim();

  let tipoTercero: TipoTercero | null = TIPOS_TERCERO.includes(declarado)
    ? (declarado as TipoTercero)
    : null;
  let procedenciaTipo: Procedencia = tipoTercero === null ? 'inferido' : 'declarado';

  // La única inferencia: RFC mexicano bien formado ⇒ nacional.
  if (tipoTercero === null && rfcIdentificaAlTercero(diag)) tipoTercero = '04';

  let rfc: string | undefined;

  if (tipoTercero === '05') {
    if (!resolverExtranjero(crudo, hallazgos)) return { tercero: null, hallazgos };
  } else if (tipoTercero === '15') {
    // El 15 DECLARADO es legítimo: operaciones con el público en general. Lo
    // que no puede pasar es que arrastre el RFC real de un proveedor, porque
    // entonces el archivo dice dos cosas incompatibles a la vez.
    if (rfcIdentificaAlTercero(diag)) {
      hallazgos.push({
        codigo: 'DIOT-GLOBAL-CON-RFC',
        severidad: 'aviso',
        vendorId: crudo.vendorId,
        mensaje:
          `El proveedor ${crudo.nombre} está marcado como tercero global (15) y tiene el RFC ` +
          `${diag.rfc} en el expediente. El 15 declara operaciones sin contraparte ` +
          `identificable: se declara con el genérico ${RFC_GENERICO_NACIONAL} y su RFC real no ` +
          `viaja. Revisa si el tipo de tercero es el correcto.`,
      });
    }
    rfc = RFC_GENERICO_NACIONAL;
  } else {
    // Nacional, declarado o inferido — y también el caso en que no se pudo
    // inferir nada, que es siempre por culpa del RFC y aquí se resuelve.
    if (rfcIdentificaAlTercero(diag)) {
      tipoTercero = '04';
      rfc = diag.rfc;
    } else if (politicas.terceroSinRfc.trim() === 'declarar_global') {
      tipoTercero = '15';
      procedenciaTipo = 'politica';
      rfc = RFC_GENERICO_NACIONAL;
      hallazgos.push({
        codigo: 'DIOT-SIN-RFC-DECLARADO-GLOBAL',
        severidad: 'aviso',
        politica: 'diot_tercero_sin_rfc',
        vendorId: crudo.vendorId,
        mensaje:
          `El proveedor ${crudo.nombre} ${diag.motivo}, y por política se declara como tercero ` +
          `global (15) con el genérico ${RFC_GENERICO_NACIONAL}. La declaración dirá que esas ` +
          `compras no tuvieron contraparte identificable, y la autoridad lo cruza contra lo que ` +
          `ese proveedor declaró por su lado.`,
      });
    } else {
      hallazgos.push({
        codigo: 'DIOT-SIN-RFC',
        severidad: 'bloqueante',
        politica: 'diot_tercero_sin_rfc',
        vendorId: crudo.vendorId,
        mensaje:
          `El proveedor ${crudo.nombre} ${diag.motivo}. Sin RFC que lo identifique no se puede ` +
          `declarar como tercero nacional, y el tipo 15 es para el público en general, no un ` +
          `cajón para proveedores cuyo RFC nadie capturó.`,
      });
      return { tercero: null, hallazgos };
    }
  }

  if (tipoTercero === null) return { tercero: null, hallazgos };
  const operacion = tipoOperacionDe(crudo, tipoTercero, politicas, hallazgos);
  if (operacion === null) return { tercero: null, hallazgos };

  return {
    tercero: {
      vendorId: crudo.vendorId,
      nombre: crudo.nombre,
      tipoTercero,
      tipoOperacion: operacion.valor,
      ...(rfc !== undefined ? { rfc } : {}),
      ...(tipoTercero === '05'
        ? {
            idFiscalExtranjero: (crudo.idFiscalExtranjero ?? '').trim(),
            paisResidencia: (crudo.paisResidencia ?? '').trim(),
            nacionalidad: (crudo.nacionalidad ?? '').trim(),
          }
        : {}),
      procedencia: { tipoTercero: procedenciaTipo, tipoOperacion: operacion.procedencia },
    },
    hallazgos,
  };
}
