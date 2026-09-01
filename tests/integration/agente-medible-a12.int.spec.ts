import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { registrarEventoAgente } from '../../src/ai/agent-events.js';
import { registrarCorridaIngesta } from '../../src/ai/ingest-runs.js';
import { recordUsage } from '../../src/ai/usage-ledger.js';
import { estadisticasDelAgente } from '../../src/ai/stats-service.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * A1–A2: EL AGENTE MEDIBLE, contra la base real.
 *
 * Siembra el rastro que los caminos de aprobación dejan de verdad
 * (review_notes de auto-post, reviewed_by 'policy:', humano, rechazo) y
 * verifica que ai stats lo reconstruye: buckets con tasa y delta,
 * intervención humana, costo por borrador desde ai_ingest_runs, duración
 * desde ai_usage y eventos desde ai_agent_events — con RLS y CHECKs de
 * las tablas nuevas de la 044 en medio.
 */

let f: Fixture;
let ctx: AgentContext;

function draftRow(confianza: string, status: string, extras: Record<string, string | null> = {}) {
  return {
    id: uuidv4(),
    status,
    ai_confidence: confianza,
    reviewed_by: extras.reviewed_by ?? null,
    review_notes: extras.review_notes ?? null,
  };
}

beforeAll(async () => {
  f = await crearInquilino('Agente medible A12');
  ctx = {
    entityId: f.entityId,
    entityName: 'Agente medible A12',
    tenantId: f.tenantId,
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'mx_nif',
    taxId: 'XAXX010101000',
  };

  // El CHECK de la 011 exige journal_entry_id en todo draft aprobado: un
  // asiento real (borrador) da el id. La unicidad de la 012 es sobre
  // journal_entries.source_id, no sobre esta FK — varios drafts de prueba
  // pueden señalarlo.
  const asiento = await createJournalEntry(
    f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'ancla para drafts aprobados',
    [
      { account_id: f.roles.banco, debit_amount: '1.00', credit_amount: null, description: 'c' },
      { account_id: f.roles.cxc, debit_amount: null, credit_amount: '1.00', description: 'a' },
    ],
    f.userId
  );

  const drafts = [
    // Bucket 0.90-0.94: 2 humano, 1 política, 1 auto, 1 rechazado, 1 pendiente.
    draftRow('0.92', 'approved', { reviewed_by: 'victor@example.test' }),
    draftRow('0.91', 'approved', { reviewed_by: 'victor@example.test' }),
    draftRow('0.93', 'approved', { reviewed_by: 'policy:11111111-1111-4111-8111-111111111111', review_notes: 'auto-approved by policy 1111 (matched pattern)' }),
    draftRow('0.94', 'approved', { reviewed_by: 'victor@example.test', review_notes: 'auto-post by threshold (confidence 0.94, amount 4060; umbral por politica)' }),
    draftRow('0.90', 'rejected', { review_notes: 'cuenta equivocada' }),
    draftRow('0.92', 'pending_review'),
    // Bucket 0.50-0.69: 1 rechazado (el modelo dudó y con razón).
    draftRow('0.60', 'rejected', { review_notes: 'no clasificable' }),
  ];
  for (const d of drafts) {
    await query(
      `INSERT INTO ai_drafts (id, tenant_id, entity_id, draft_type, status, payload,
        ai_confidence, ai_reasoning, ai_model, reviewed_by, review_notes,
        journal_entry_id)
       VALUES ($1, $2, $3, 'journal_entry', $4, '{"lines":[]}'::jsonb,
        $5, 'razonamiento de prueba', 'claude-test', $6, $7, $8)`,
      [
        d.id, f.tenantId, f.entityId, d.status, d.ai_confidence,
        d.reviewed_by, d.review_notes,
        d.status === 'approved' ? asiento.id : null,
      ]
    );
  }
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('el rastro persistido (044)', () => {
  it('una corrida de ingesta deja fila y los eventos quedan con su clase', async () => {
    const corridaId = await registrarCorridaIngesta(ctx, {
      provider: 'anthropic',
      model: 'claude-test',
      filesTotal: 3,
      counts: { rules: 1, auto_post: 0, draft: 2, blocked: 0, duplicate: 0, invalid: 0, error: 0 },
      sospechaCount: 1,
      draftsCreated: 2,
      inputTokens: 9000,
      outputTokens: 400,
      estimatedCostUsd: 0.09,
      durationMs: 5200,
      autoPostEnabled: false,
      createdBy: 'victor@example.test',
    });
    await registrarEventoAgente(ctx, {
      kind: 'sospecha', provider: 'anthropic',
      detail: { archivo: 'x.xml', campos: ['issuer name'], corrida: corridaId },
    });
    await registrarEventoAgente(ctx, {
      kind: 'failover', provider: 'anthropic', detail: { categoria: 'rate_limit', siguiente: 'hermes' },
    });

    const fila = await query<{ drafts_created: number; estimated_cost_usd: string }>(
      `SELECT drafts_created, estimated_cost_usd FROM ai_ingest_runs WHERE id = $1`,
      [corridaId]
    );
    expect(fila.rows[0].drafts_created).toBe(2);
    expect(fila.rows[0].estimated_cost_usd).toBe('0.090000');
  });

  it('ai_usage acepta y devuelve la duración; el CHECK rechaza negativos', async () => {
    await recordUsage(ctx, null, {
      provider: 'anthropic', model: 'claude-test',
      inputTokens: 1000, outputTokens: 100, durationMs: 1800,
    });
    await recordUsage(ctx, null, {
      provider: 'anthropic', model: 'claude-test',
      inputTokens: 500, outputTokens: 50, durationMs: 200,
    });
    const filas = await query<{ duration_ms: number }>(
      `SELECT duration_ms FROM ai_usage WHERE entity_id = $1 AND duration_ms IS NOT NULL ORDER BY duration_ms`,
      [f.entityId]
    );
    expect(filas.rows.map((r) => r.duration_ms)).toEqual([200, 1800]);

    await expect(
      query(`UPDATE ai_usage SET duration_ms = -1 WHERE entity_id = $1`, [f.entityId])
    ).rejects.toThrow(/check/i);
  });
});

describe('ai stats reconstruye la calibración del rastro real', () => {
  it('buckets, destinos por atribución, delta, intervención y costo por borrador', async () => {
    const est = await estadisticasDelAgente(ctx);

    const alto = est.buckets.find((b) => b.bucket === '0.90-0.94');
    expect(alto).toBeDefined();
    expect(alto!.borradores).toBe(6);
    expect(alto!.aprobados_humano).toBe(2);
    expect(alto!.aprobados_politica).toBe(1);
    expect(alto!.auto_posteados).toBe(1);
    expect(alto!.rechazados).toBe(1);
    expect(alto!.pendientes).toBe(1);
    // decididos 5, aprobados 4 → 0.800; confianza media de decididos = 0.92
    expect(alto!.tasa_aprobacion).toBe('0.800');
    expect(alto!.delta).toBe('0.120');

    const bajo = est.buckets.find((b) => b.bucket === '0.50-0.69');
    expect(bajo!.tasa_aprobacion).toBe('0.000');

    const r = est.resumen;
    // decididos 6: 2 humano + 2 rechazados → intervención 4/6
    expect(r.decididos).toBe(6);
    expect(r.tasa_intervencion_humana).toBe('0.667');
    expect(r.costo_por_borrador_usd).toBe('0.045000');
    expect(r.duracion_promedio_ms).toBe(1000);
    expect(r.eventos.sospecha).toBe(1);
    expect(r.eventos.failover).toBe(1);
    expect(r.eventos.nudge).toBe(0);
  });
});
