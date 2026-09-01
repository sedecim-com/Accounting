import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { registrarEventoAgente } from '../../src/ai/agent-events.js';
import { registrarCorridaIngesta } from '../../src/ai/ingest-runs.js';
import { recordUsage } from '../../src/ai/usage-ledger.js';
import { estadisticasDelAgente } from '../../src/ai/stats-service.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('registrarEventoAgente', () => {
  it('inserta el evento con su clase, proveedor y detalle serializado', async () => {
    await registrarEventoAgente(CTX, {
      kind: 'failover',
      provider: 'anthropic',
      detail: { categoria: 'rate_limit', siguiente: 'hermes' },
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_agent_events/);
    expect(params.slice(1, 5)).toEqual([CTX.tenantId, CTX.entityId, 'failover', 'anthropic']);
    expect(JSON.parse(params[5])).toEqual({ categoria: 'rate_limit', siguiente: 'hermes' });
  });

  it('sin proveedor ni detalle: NULL y objeto vacío, nunca undefined al driver', async () => {
    await registrarEventoAgente(CTX, { kind: 'nudge' });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[4]).toBeNull();
    expect(params[5]).toBe('{}');
  });
});

describe('registrarCorridaIngesta', () => {
  const CORRIDA = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    filesTotal: 4,
    counts: { rules: 1, auto_post: 0, draft: 2, blocked: 1, duplicate: 0, invalid: 0, error: 0 },
    sospechaCount: 1,
    draftsCreated: 2,
    inputTokens: 12345,
    outputTokens: 678,
    estimatedCostUsd: 0.0421,
    durationMs: 8100,
    autoPostEnabled: false,
    createdBy: 'victor@example.test',
  };

  it('una corrida deja una fila con los counts por estatus y el consumo', async () => {
    await registrarCorridaIngesta(CTX, CORRIDA);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_ingest_runs/);
    // counts en el orden del INSERT: rules, auto_post, draft, blocked, duplicate, invalid, error
    expect(params.slice(6, 13)).toEqual([1, 0, 2, 1, 0, 0, 0]);
    expect(params[13]).toBe(1); // sospecha_count
    expect(params[14]).toBe(2); // drafts_created
    expect(params[17]).toBe('0.042100'); // costo con 6 decimales, como ai_usage
  });

  it('costo null viaja como NULL: «modelo sin precio» no es «costó cero»', async () => {
    await registrarCorridaIngesta(CTX, { ...CORRIDA, estimatedCostUsd: null });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[17]).toBeNull();
  });
});

describe('recordUsage con duración (A2)', () => {
  it('persiste duration_ms cuando el runner lo midió', async () => {
    await recordUsage(CTX, null, {
      provider: 'anthropic', model: 'claude-opus-5',
      inputTokens: 100, outputTokens: 50, durationMs: 1234.9,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/duration_ms/);
    expect(params[11]).toBe(1234); // truncado a entero
  });

  it('sin medición (o con basura) la columna queda NULL, jamás un cero falso', async () => {
    await recordUsage(CTX, null, {
      provider: 'anthropic', model: 'claude-opus-5', inputTokens: 1, outputTokens: 1,
    });
    expect(mockQuery.mock.calls[0][1][11]).toBeNull();
    mockQuery.mockClear();
    await recordUsage(CTX, null, {
      provider: 'anthropic', model: 'claude-opus-5',
      inputTokens: 1, outputTokens: 1, durationMs: -5,
    });
    expect(mockQuery.mock.calls[0][1][11]).toBeNull();
  });
});

describe('estadisticasDelAgente', () => {
  it('arma buckets con tasa y delta, y el resumen con intervención y costo por borrador', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            bucket: '0.90-0.94', borradores: 10, rechazados: 2, pendientes: 2,
            auto_posteados: 1, aprobados_politica: 1, aprobados_humano: 4,
            confianza_decididos: '0.92',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ corridas: 3, borradores: 10, costo_total: '0.500000', sospechas: 2 }],
      })
      .mockResolvedValueOnce({ rows: [{ llamadas: 20, promedio: '1500', p95: '4000' }] })
      .mockResolvedValueOnce({
        rows: [
          { kind: 'sospecha', n: 2 },
          { kind: 'failover', n: 1 },
        ],
      });

    const est = await estadisticasDelAgente(CTX);
    const b = est.buckets[0];
    // decididos = 8; aprobados = 6 → tasa 0.750; delta = 0.92 − 0.75
    expect(b.tasa_aprobacion).toBe('0.750');
    expect(b.delta).toBe('0.170');

    const r = est.resumen;
    // intervención humana = (4 aprobados humano + 2 rechazados) / 8 decididos
    expect(r.tasa_intervencion_humana).toBe('0.750');
    expect(r.costo_por_borrador_usd).toBe('0.050000');
    expect(r.duracion_p95_ms).toBe(4000);
    // sospechas SOLO de eventos (2): el sospecha_count de las corridas es el
    // mismo hecho agregado — sumarlo lo contaría doble.
    expect(r.eventos).toEqual({ sospecha: 2, nudge: 0, failover: 1 });
  });

  it('sin decisiones no hay tasa ni delta: guiones honestos, no divisiones entre cero', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          bucket: '0.95-1.00', borradores: 3, rechazados: 0, pendientes: 3,
          auto_posteados: 0, aprobados_politica: 0, aprobados_humano: 0,
          confianza_decididos: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ corridas: 0, borradores: 0, costo_total: null, sospechas: 0 }] })
      .mockResolvedValueOnce({ rows: [{ llamadas: 0, promedio: null, p95: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const est = await estadisticasDelAgente(CTX);
    expect(est.buckets[0].tasa_aprobacion).toBeNull();
    expect(est.buckets[0].delta).toBeNull();
    expect(est.resumen.tasa_intervencion_humana).toBeNull();
    expect(est.resumen.costo_por_borrador_usd).toBeNull();
    expect(est.resumen.duracion_promedio_ms).toBeNull();
  });
});
