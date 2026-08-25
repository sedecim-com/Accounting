import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { classifyXml, type Classification, type ProposedLine } from './cfdi-classifier.js';
import type { AccountRole } from './cfdi-taxonomy.js';

// ============================================================
// DEL VEREDICTO AL ASIENTO.
//
// El clasificador declarativo existía completo y probado, y no lo llamaba
// nadie: la ruta viva de ingesta armaba el asiento a mano y mandaba TODO
// el IVA a la 1130 «IVA Acreditable», sin mirar el método de pago. Bajo
// PPD (pago en parcialidades o diferido) el IVA no es acreditable al
// recibir la factura sino al PAGARLA, cuando llega el REP. Cada factura a
// crédito adelantaba así un acreditamiento que todavía no existía.
//
// Este módulo es la costura, y reparte el trabajo entre los dos que ya
// sabían hacerlo:
//
//   · El CLASIFICADOR decide la ESTRUCTURA FISCAL: qué caso es, si el IVA
//     va a acreditable o a pendiente de acreditar, qué retenciones hay y
//     contra qué cuenta de control.
//   · El MAPEO POR RENGLÓN —reglas del inquilino y sugerencias— decide a
//     qué cuenta de gasto va cada concepto, que es más fino que el rol
//     genérico `gasto` del clasificador.
//
// Es decir: la línea de gasto propuesta se ABRE en las del documento; las
// demás (IVA, retenciones, cuenta por pagar) se respetan tal cual. Si la
// suma de los renglones no coincide con el importe que el clasificador
// atribuyó al gasto, la apertura no se hace y queda constancia: preferimos
// una cuenta genérica correcta a un desglose que descuadra.
// ============================================================

/** Roles cuyo importe se abre en los renglones del documento. */
const ROLES_DE_GASTO = new Set<AccountRole>([
  'gasto',
  'gasto_no_deducible',
  'gasto_anticipado',
  'inventario',
  'activo_fijo',
]);

export interface RenglonDocumento {
  line_number: number;
  descripcion: string;
  importe: number;
  account_id?: string | null;
  suggested_account_id?: string | null;
  cost_center_id?: string;
}

export interface LineaAsiento {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  cost_center_id?: string;
}

export interface PlanDeAsiento {
  clasificacion: Classification;
  lineas: LineaAsiento[];
  /** Roles del clasificador sin cuenta resoluble en la entidad. */
  cuentasFaltantes: Array<{ role: AccountRole; code: string | null }>;
  /** Qué se hizo con la línea de gasto: 'abierta' | 'generica' | 'sin_gasto'. */
  desglose: 'abierta' | 'generica' | 'sin_gasto';
  avisos: string[];
}

export interface OpcionesPlan {
  entityId: string;
  entityRfc: string;
  xml: string;
  renglones: RenglonDocumento[];
  /** Cuenta de gasto por defecto cuando un renglón no trae la suya. */
  cuentaGastoPorDefecto?: string | null;
  referencia: string;
  vendorExists?: boolean;
  periodOpen?: boolean;
  satStatus?: 'vigente' | 'cancelado' | 'no_encontrado' | 'sin_validar';
  answers?: Record<string, string>;
}

/** Códigos de cuenta → id, dentro de la entidad. */
async function resolverCuentas(
  entityId: string,
  codigos: string[]
): Promise<Map<string, string>> {
  if (codigos.length === 0) return new Map();
  const r = await query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE entity_id = $1 AND code = ANY($2::text[])`,
    [entityId, [...new Set(codigos)]]
  );
  return new Map(r.rows.map((x) => [x.code, x.id]));
}

export async function planearAsiento(opts: OpcionesPlan): Promise<PlanDeAsiento> {
  const clasificacion = await classifyXml(opts.xml, {
    entityId: opts.entityId,
    entityRfc: opts.entityRfc,
    vendorExists: opts.vendorExists,
    periodOpen: opts.periodOpen,
    satStatus: opts.satStatus,
    answers: opts.answers,
  });

  const avisos = [...clasificacion.warnings];
  const cuentasFaltantes: Array<{ role: AccountRole; code: string | null }> = [];

  if (clasificacion.lines.length === 0) {
    return {
      clasificacion, lineas: [], cuentasFaltantes,
      desglose: 'sin_gasto', avisos,
    };
  }

  const porCodigo = await resolverCuentas(
    opts.entityId,
    clasificacion.lines.map((l) => l.accountCode).filter((c): c is string => c !== null)
  );

  // ── ¿Se puede abrir la línea de gasto en los renglones del documento?
  const lineasGasto = clasificacion.lines.filter((l) => ROLES_DE_GASTO.has(l.role));
  const importeGasto = lineasGasto.reduce(
    (s, l) => s.plus(l.debit ?? 0).minus(l.credit ?? 0),
    new Decimal(0)
  );
  const sumaRenglones = opts.renglones.reduce((s, r) => s.plus(r.importe), new Decimal(0));

  let desglose: PlanDeAsiento['desglose'] = 'sin_gasto';
  if (lineasGasto.length > 0) {
    const cuadra = importeGasto.minus(sumaRenglones).abs().lessThanOrEqualTo('0.01');
    const todosConCuenta = opts.renglones.every(
      (r) => r.account_id || r.suggested_account_id || opts.cuentaGastoPorDefecto
    );
    if (opts.renglones.length > 0 && cuadra && todosConCuenta) {
      desglose = 'abierta';
    } else {
      desglose = 'generica';
      if (opts.renglones.length > 0 && !cuadra) {
        avisos.push(
          `El desglose por renglón no coincide con el gasto del CFDI ` +
            `(renglones ${sumaRenglones.toFixed(2)} vs ${importeGasto.toFixed(2)}): ` +
            `el asiento usa la cuenta genérica del rol para no descuadrar.`
        );
      }
      if (opts.renglones.length > 0 && !todosConCuenta) {
        avisos.push(
          'Hay renglones sin cuenta asignada ni sugerida: el asiento usa la cuenta ' +
            'genérica del rol en vez de un desglose incompleto.'
        );
      }
    }
  }

  const lineas: LineaAsiento[] = [];
  for (const propuesta of clasificacion.lines) {
    if (desglose === 'abierta' && ROLES_DE_GASTO.has(propuesta.role)) {
      // La línea de gasto se abre en los renglones del documento; cada uno
      // conserva su cuenta y su centro de costo.
      for (const r of opts.renglones) {
        const cuenta = r.account_id || r.suggested_account_id || opts.cuentaGastoPorDefecto;
        lineas.push({
          account_id: cuenta as string,
          debit_amount: new Decimal(r.importe).toFixed(4),
          credit_amount: null,
          description: r.descripcion,
          ...(r.cost_center_id ? { cost_center_id: r.cost_center_id } : {}),
        });
      }
      continue;
    }
    const linea = aLineaDeAsiento(propuesta, porCodigo, opts.referencia);
    if (!linea) {
      cuentasFaltantes.push({ role: propuesta.role, code: propuesta.accountCode });
      continue;
    }
    lineas.push(linea);
  }

  return { clasificacion, lineas, cuentasFaltantes, desglose, avisos };
}

function aLineaDeAsiento(
  propuesta: ProposedLine,
  porCodigo: Map<string, string>,
  referencia: string
): LineaAsiento | null {
  const id = propuesta.accountCode ? porCodigo.get(propuesta.accountCode) : undefined;
  if (!id) return null;
  return {
    account_id: id,
    debit_amount: propuesta.debit === null ? null : new Decimal(propuesta.debit).toFixed(4),
    credit_amount: propuesta.credit === null ? null : new Decimal(propuesta.credit).toFixed(4),
    description: `${propuesta.description} — ${referencia}`,
  };
}

/**
 * ¿El plan se puede contabilizar sin intervención?
 *
 * Se exige un veredicto 'ready' Y que todas las cuentas resolvieran: un rol
 * mapeado a un código que la entidad no tiene produce un asiento incompleto,
 * y un asiento incompleto no descuadra por casualidad —descuadra siempre—.
 */
export function planContabilizable(plan: PlanDeAsiento): { ok: boolean; motivo: string } {
  if (plan.clasificacion.verdict !== 'ready') {
    return { ok: false, motivo: plan.clasificacion.reason };
  }
  if (plan.cuentasFaltantes.length > 0) {
    const faltan = plan.cuentasFaltantes
      .map((c) => `${c.role}${c.code ? ` (${c.code})` : ''}`)
      .join(', ');
    return {
      ok: false,
      motivo:
        `La entidad no tiene cuenta para: ${faltan}. ` +
        `Siembra la contabilidad con: mnemosine init --section identity`,
    };
  }
  const cargos = plan.lineas.reduce((s, l) => s.plus(l.debit_amount ?? 0), new Decimal(0));
  const abonos = plan.lineas.reduce((s, l) => s.plus(l.credit_amount ?? 0), new Decimal(0));
  if (!cargos.equals(abonos)) {
    return {
      ok: false,
      motivo: `El asiento propuesto no cuadra: cargos ${cargos.toFixed(2)} vs abonos ${abonos.toFixed(2)}.`,
    };
  }
  return { ok: true, motivo: plan.clasificacion.reason };
}
