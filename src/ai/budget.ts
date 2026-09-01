import { query } from '../database/connection.js';
import { budgetFileValues } from './providers/config.js';
import type { AgentContext } from './context.js';

// ============================================================
// A3 · EL PRESUPUESTO DEL AGENTE (E5.1-e) — corta donde nace toda sesión
//
// Hasta hoy la corrida desatendida no tenía más tope que MAX_ITERATIONS
// por turno: un job en bucle podía gastar sin techo y nadie se enteraba
// hasta la factura. El presupuesto vive en el archivo del operador
// (sección budget: daily_usd / monthly_usd / on_exceed) — es una decisión
// de costo del operador, no una bifurcación contable del panel — y se
// aplica en el ÚNICO punto donde nace toda sesión (createLlmSession),
// así que jobs, ingesta, chat e init lo heredan sin código propio.
//
// La regla de la carta A3: en rutas DESATENDIDAS «solo avisa» significa
// que no hay tope — su on_exceed por omisión es 'block'; en las
// interactivas, 'warn' (hay un humano mirando la advertencia).
//
// El alcance es POR ENTIDAD (la decisión escrita del plan: la entidad es
// la unidad que el despacho factura a su cliente, y ai_usage ya se corta
// así). Fallo de base de datos al medir: ABIERTO con diagnóstico en
// warn, CERRADO en block — un tope que no puede medirse no puede fingir
// que midió.
// ============================================================

export interface BudgetLimits {
  dailyUsd?: number;
  monthlyUsd?: number;
  onExceed: 'warn' | 'block';
}

export const BUDGET_WARN_RATIO = 0.8;

export function resolveBudgetLimits(
  cwd = process.cwd(),
  opts: { unattended?: boolean } = {}
): BudgetLimits {
  const file = budgetFileValues(cwd);
  return {
    dailyUsd: file.dailyUsd,
    monthlyUsd: file.monthlyUsd,
    // La carta manda: desatendido corta por defecto; interactivo advierte.
    onExceed: file.onExceed ?? (opts.unattended ? 'block' : 'warn'),
  };
}

export interface BudgetSpend {
  dailyUsd: number;
  monthlyUsd: number;
  /** Turnos sin precio en la tabla local: el estimado va POR DEBAJO. */
  unpricedTurns: number;
}

export async function currentSpend(ctx: AgentContext): Promise<BudgetSpend> {
  const r = await query<{ daily: string; monthly: string; unpriced: number }>(
    `SELECT COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::text AS daily,
            COALESCE(SUM(estimated_cost_usd), 0)::text AS monthly,
            COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced
       FROM ai_usage
      WHERE entity_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [ctx.entityId]
  );
  const fila = r.rows[0];
  return {
    dailyUsd: Number(fila.daily),
    monthlyUsd: Number(fila.monthly),
    unpricedTurns: fila.unpriced,
  };
}

export type BudgetState = 'ok' | 'warn' | 'exceeded';

export interface BudgetStatus {
  state: BudgetState;
  window: 'daily' | 'monthly' | null;
  spentUsd: number;
  limitUsd: number | null;
  unpricedTurns: number;
  message: string | null;
}

export function evaluateBudget(spend: BudgetSpend, limits: BudgetLimits): BudgetStatus {
  const ventanas: Array<{ window: 'daily' | 'monthly'; spent: number; limit?: number }> = [
    { window: 'daily', spent: spend.dailyUsd, limit: limits.dailyUsd },
    { window: 'monthly', spent: spend.monthlyUsd, limit: limits.monthlyUsd },
  ];
  const nota =
    spend.unpricedTurns > 0
      ? ` (${spend.unpricedTurns} turno(s) sin precio en la tabla local: el estimado va por debajo)`
      : '';

  for (const v of ventanas) {
    if (v.limit !== undefined && v.spent >= v.limit) {
      return {
        state: 'exceeded', window: v.window, spentUsd: v.spent, limitUsd: v.limit,
        unpricedTurns: spend.unpricedTurns,
        message: `Presupuesto ${v.window === 'daily' ? 'diario' : 'mensual'} agotado: ` +
          `$${v.spent.toFixed(4)} de $${v.limit} USD${nota}`,
      };
    }
  }
  for (const v of ventanas) {
    if (v.limit !== undefined && v.spent >= v.limit * BUDGET_WARN_RATIO) {
      return {
        state: 'warn', window: v.window, spentUsd: v.spent, limitUsd: v.limit,
        unpricedTurns: spend.unpricedTurns,
        message: `Presupuesto ${v.window === 'daily' ? 'diario' : 'mensual'} al ` +
          `${Math.round((v.spent / v.limit) * 100)}%: $${v.spent.toFixed(4)} de $${v.limit} USD${nota}`,
      };
    }
  }
  return {
    state: 'ok', window: null,
    spentUsd: spend.monthlyUsd, limitUsd: limits.monthlyUsd ?? null,
    unpricedTurns: spend.unpricedTurns, message: null,
  };
}

export class BudgetExceededError extends Error {
  readonly code = 'AI_BUDGET_EXCEEDED';
}

/**
 * Vive lo que vive la sesión: acumula en memoria el costo de cada llamada
 * y recalcula sin volver a la base — un cruce a MITAD de sesión también
 * corta (check() al entrar a cada turno).
 */
export class BudgetGuard {
  private extraUsd = 0;

  constructor(
    private readonly base: BudgetStatus,
    private readonly limits: BudgetLimits,
    private readonly baseSpend: BudgetSpend
  ) {}

  addSpend(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.extraUsd += usd;
  }

  get status(): BudgetStatus {
    if (this.extraUsd === 0) return this.base;
    return evaluateBudget(
      {
        dailyUsd: this.baseSpend.dailyUsd + this.extraUsd,
        monthlyUsd: this.baseSpend.monthlyUsd + this.extraUsd,
        unpricedTurns: this.baseSpend.unpricedTurns,
      },
      this.limits
    );
  }

  check(): void {
    const s = this.status;
    if (s.state === 'exceeded' && this.limits.onExceed === 'block') {
      throw new BudgetExceededError(
        `${s.message ?? 'Presupuesto agotado'}. Sube el límite en mnemosine.config.json (budget) o espera la ventana siguiente.`
      );
    }
  }
}

/**
 * La compuerta completa: resuelve límites, mide, evalúa y devuelve el
 * guardián. SIN sección budget no se consulta gasto alguno (opt-in).
 */
export async function assertWithinBudget(
  ctx: AgentContext,
  cwd = process.cwd(),
  opts: { unattended?: boolean } = {}
): Promise<{ guard: BudgetGuard; limits: BudgetLimits }> {
  const limits = resolveBudgetLimits(cwd, opts);
  if (limits.dailyUsd === undefined && limits.monthlyUsd === undefined) {
    const vacio: BudgetSpend = { dailyUsd: 0, monthlyUsd: 0, unpricedTurns: 0 };
    return { guard: new BudgetGuard(evaluateBudget(vacio, limits), limits, vacio), limits };
  }
  let spend: BudgetSpend;
  try {
    spend = await currentSpend(ctx);
  } catch (err) {
    if (limits.onExceed === 'block') {
      // Cerrado: un tope que no puede medirse no finge que midió.
      throw new BudgetExceededError(
        `No se pudo medir el gasto del presupuesto (${(err as Error).message}) y on_exceed es block: la sesión no arranca sin medición.`
      );
    }
    spend = { dailyUsd: 0, monthlyUsd: 0, unpricedTurns: 0 };
    const status = evaluateBudget(spend, limits);
    status.message = `AVISO: el gasto no pudo medirse (${(err as Error).message}); el presupuesto corre a ciegas esta sesión.`;
    return { guard: new BudgetGuard(status, limits, spend), limits };
  }
  const guard = new BudgetGuard(evaluateBudget(spend, limits), limits, spend);
  guard.check();
  return { guard, limits };
}
