import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  createDraft,
  autoApproveDraftByPolicy,
  rejectDraft,
  NoMatchingApprovalPolicyError,
} from '../../src/ai/draft-service.js';
import { registrarVeredictoSombra, concordanciaSombra } from '../../src/ai/shadow-verdicts.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { resolverUmbralesConPanel } from '../../src/ai/ingest-thresholds.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_VEREDICTOS } from '../../src/ai/floor.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * A3–A4 · EL AGENTE GOBERNADO, contra la base real:
 *   · la vía de política de punta a punta — una política otorgada aprueba
 *     el borrador que el umbral no alcanzó, con la atribución completa
 *     (policy:<id> + created_by del humano que otorgó, hash-bound);
 *   · sin política que case, NoMatchingApprovalPolicyError con nombre;
 *   · la sombra opina y la concordancia se mide sobre decisiones humanas;
 *   · resolvePolicy EXIGE la evidencia del piso antes de aceptar 'on', y
 *     el ciclo shadow → evidencia → on pasa entero.
 */

let f: Fixture;
let ctx: AgentContext;

const fecha = () => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function borrador(monto: number): Promise<string> {
  const r = await createDraft(ctx, {
    payload: {
      entry_date: fecha(),
      description: 'gobernado A3',
      // El payload del borrador es el JSON que emite el modelo: montos numéricos.
      lines: [
        { account_code: '6100', debit: monto },
        { account_code: '1110', credit: monto },
      ],
    },
    confidence: 0.7,
    reasoning: 'prueba',
    model: 'claude-test',
  });
  return r.id;
}

beforeAll(async () => {
  f = await crearInquilino('A3A4 gobernado');
  ctx = {
    entityId: f.entityId, entityName: 'A3A4 gobernado', tenantId: f.tenantId,
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('A3 · la vía de política, de punta a punta', () => {
  it('sin política otorgada: el «no casó» tiene nombre y el borrador queda pendiente', async () => {
    const draftId = await borrador(500);
    await expect(
      autoApproveDraftByPolicy(ctx, draftId, { configuredMaxAmount: 10000 })
    ).rejects.toThrow(NoMatchingApprovalPolicyError);
    const fila = await query<{ status: string }>(
      `SELECT status FROM ai_drafts WHERE id = $1`, [draftId]
    );
    expect(fila.rows[0].status).toBe('pending_review');
  });

  it('con la política otorgada: aprueba, postea y la atribución es completa', async () => {
    // created_by de la política es el EMAIL del humano: la aprobación por
    // política re-resuelve a ese usuario activo (si se fue, la política muere).
    const emailOtorgante = `it-${f.userId.slice(0, 8)}@example.test`;
    await query(
      `INSERT INTO ai_approval_policies (id, tenant_id, entity_id, scope, pattern, mode, created_by)
       VALUES ($1, $2, $3, 'draft', '{"kind":"journal_entry","max_amount":"1000"}'::jsonb, 'always', $4)`,
      [uuidv4(), f.tenantId, f.entityId, emailOtorgante]
    );
    const draftId = await borrador(500);
    const r = await autoApproveDraftByPolicy(ctx, draftId, { configuredMaxAmount: 10000 });
    expect(r.entryNumber).toMatch(/^JE-/);

    const fila = await query<{ status: string; reviewed_by: string }>(
      `SELECT status, reviewed_by FROM ai_drafts WHERE id = $1`, [draftId]
    );
    expect(fila.rows[0].status).toBe('approved');
    expect(fila.rows[0].reviewed_by).toBe(`policy:${r.policyId}`);

    const asiento = await query<{ status: string; created_by: string }>(
      `SELECT status, created_by FROM journal_entries WHERE entry_number = $1 AND entity_id = $2`,
      [r.entryNumber, f.entityId]
    );
    expect(asiento.rows[0].status).toBe('posted');
    // El created_by es el HUMANO que otorgó la política, no un fantasma.
    expect(asiento.rows[0].created_by).toBe(f.userId);
  });

  it('el patrón con tope NO autoriza por encima: 5,000 contra max_amount 1,000 no casa', async () => {
    const draftId = await borrador(5000);
    await expect(
      autoApproveDraftByPolicy(ctx, draftId, { configuredMaxAmount: 10000 })
    ).rejects.toThrow(NoMatchingApprovalPolicyError);
  });
});

describe('A4 · sombra, concordancia y la compuerta de la evidencia', () => {
  it("el panel en 'shadow' resuelve sombra:true con autoPost apagado", async () => {
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'ingest_auto_post', 'shadow', 'victor@test');
    const umbrales = await resolverUmbralesConPanel({}, ctx);
    expect(umbrales.sombra).toBe(true);
    expect(umbrales.autoPost).toBe(false);
  });

  it('la concordancia cruza veredictos contra decisiones HUMANAS, y el piso gobierna el encendido', async () => {
    // Sin evidencia: encender 'on' se rechaza con el piso en el mensaje.
    await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'ingest_auto_post');
    await expect(
      resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'ingest_auto_post', 'on', 'victor@test')
    ).rejects.toThrow(/evidencia de sombra/);

    // Construir el historial: veredictos sombra decididos por un humano,
    // repartidos en días distintos (el piso cuenta días, no filas).
    for (let i = 0; i < FLOOR_SOMBRA_VEREDICTOS; i++) {
      const draftId = await borrador(100);
      await registrarVeredictoSombra(ctx, {
        draftId, wouldAutoPost: false, motivo: 'new vendor (no match)', thresholds: {},
      });
      await rejectDraft(ctx, draftId, { userId: f.userId, email: 'victor@test' }, 'no procede');
      await query(
        `UPDATE ai_shadow_verdicts SET created_at = NOW() - ($2 || ' days')::interval WHERE draft_id = $1`,
        [draftId, String(i % FLOOR_SOMBRA_DIAS)]
      );
    }
    const c = await concordanciaSombra(ctx);
    expect(c.decididos).toBeGreaterThanOrEqual(FLOOR_SOMBRA_VEREDICTOS);
    expect(c.tasa_acuerdo).toBe('1.000'); // no habría posteado + humano rechazó = acuerdo
    expect(c.dias_con_veredictos).toBeGreaterThanOrEqual(FLOOR_SOMBRA_DIAS);

    // Con la evidencia del piso, el encendido pasa: shadow → evidencia → on.
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'ingest_auto_post', 'on', 'victor@test');
    const encendida = await query<{ resolved_value: string }>(
      `SELECT resolved_value FROM policy_decisions WHERE tenant_id = $1 AND key = 'ingest_auto_post'`,
      [f.tenantId]
    );
    expect(encendida.rows[0].resolved_value).toBe('on');
  });
});
