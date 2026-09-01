import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../src/ai/providers/config.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/ai/providers/config.js')>()),
  budgetFileValues: (...a: unknown[]) => budgetFileValuesMock(...a),
}));

const { budgetFileValuesMock } = vi.hoisted(() => ({
  budgetFileValuesMock: vi.fn(() => ({} as Record<string, unknown>)),
}));

import {
  evaluateBudget,
  resolveBudgetLimits,
  assertWithinBudget,
  BudgetExceededError,
  BUDGET_WARN_RATIO,
} from '../../src/ai/budget.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'e1', entityName: 'Acme', tenantId: 't1',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AAA010101AAA',
};

beforeEach(() => {
  mockQuery.mockReset();
  budgetFileValuesMock.mockReset();
  budgetFileValuesMock.mockReturnValue({});
});

describe('resolveBudgetLimits — el default lo decide la ruta', () => {
  it("desatendido corta por defecto («solo avisa» significa que no hay tope); interactivo advierte", () => {
    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20 });
    expect(resolveBudgetLimits(undefined, { unattended: true }).onExceed).toBe('block');
    expect(resolveBudgetLimits(undefined, { unattended: false }).onExceed).toBe('warn');
  });

  it('el archivo del operador gana sobre el default de la ruta', () => {
    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20, onExceed: 'warn' });
    expect(resolveBudgetLimits(undefined, { unattended: true }).onExceed).toBe('warn');
  });
});

describe('evaluateBudget', () => {
  it('exceeded al tocar el límite; la ventana diaria dispara primero', () => {
    const s = evaluateBudget(
      { dailyUsd: 5, monthlyUsd: 21, unpricedTurns: 0 },
      { dailyUsd: 5, monthlyUsd: 100, onExceed: 'block' }
    );
    expect(s.state).toBe('exceeded');
    expect(s.window).toBe('daily');
  });

  it('warn al 80% del límite, con el gasto y la ventana en el mensaje', () => {
    const s = evaluateBudget(
      { dailyUsd: 0, monthlyUsd: 17, unpricedTurns: 5 },
      { monthlyUsd: 20, onExceed: 'warn' }
    );
    expect(s.state).toBe('warn');
    expect(BUDGET_WARN_RATIO).toBe(0.8);
    expect(s.message).toMatch(/85%/);
    // Los turnos sin precio se DICEN: el estimado va por debajo.
    expect(s.message).toMatch(/5 turno/);
  });

  it('sin límites definidos, siempre ok (opt-in)', () => {
    const s = evaluateBudget({ dailyUsd: 999, monthlyUsd: 9999, unpricedTurns: 0 }, { onExceed: 'block' });
    expect(s.state).toBe('ok');
  });
});

describe('assertWithinBudget', () => {
  it('sin sección budget NO consulta gasto alguno', async () => {
    await assertWithinBudget(CTX);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('block con el gasto por encima falla ANTES de llamar a nadie', async () => {
    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20 });
    mockQuery.mockResolvedValueOnce({ rows: [{ daily: '0', monthly: '21', unpriced: 0 }] });
    await expect(assertWithinBudget(CTX, undefined, { unattended: true }))
      .rejects.toThrow(BudgetExceededError);
  });

  it('un cruce a MITAD de sesión corta en el siguiente turno, sin volver a la base', async () => {
    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20, onExceed: 'block' });
    mockQuery.mockResolvedValueOnce({ rows: [{ daily: '0', monthly: '15', unpriced: 0 }] });
    const { guard } = await assertWithinBudget(CTX);
    expect(() => guard.check()).not.toThrow();
    guard.addSpend(6); // 15 + 6 = 21 > 20
    expect(() => guard.check()).toThrow(BudgetExceededError);
    expect(mockQuery).toHaveBeenCalledTimes(1); // ninguna consulta extra
  });

  it('base caída: ABIERTO con diagnóstico en warn, CERRADO en block', async () => {
    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20, onExceed: 'warn' });
    mockQuery.mockRejectedValueOnce(new Error('se cayó'));
    const { guard } = await assertWithinBudget(CTX);
    expect(guard.status.message).toMatch(/no pudo medirse/);
    expect(() => guard.check()).not.toThrow();

    budgetFileValuesMock.mockReturnValue({ monthlyUsd: 20, onExceed: 'block' });
    mockQuery.mockRejectedValueOnce(new Error('se cayó'));
    await expect(assertWithinBudget(CTX)).rejects.toThrow(/sin medición/);
  });
});
