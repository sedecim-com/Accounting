import { describe, it, expect, vi } from 'vitest';
import { createLlmSessionWithFailover } from '../../../src/ai/providers/index.js';
import { SUPERFICIE_DESATENDIDA_SANDBOX, SUPERFICIE_DESATENDIDA } from '../../../src/ai/tools/superficie.js';
import type { AgentContext } from '../../../src/ai/context.js';

// ============================================================
// LA COSTURA DEL FAILOVER REENVÍA LO QUE RECIBE.
//
// `createLlmSessionWithFailover` re-empaquetaba las opciones enumerando cuatro
// campos a mano, y `herramientas` no estaba entre ellos. Medido ejecutando
// buildTools: la corrida desatendida pasa SUPERFICIE_DESATENDIDA_SANDBOX —23
// herramientas— y al constructor llegaba `undefined`, así que recibía las 25.
// Las dos de más son `external_pull` y `external_diff_trial_balance`: lecturas
// contra el sistema del cliente CON SU CREDENCIAL. `jobs run-due` sin `--live`
// tenía el brazo externo igualmente, y la compuerta de S0.3 quedaba derrotada
// por un literal.
//
// Esta prueba ejerce la costura DE LADO A LADO —el doble verifica el argumento
// con el que fue llamado, no responde lo mismo pase lo que pase— porque probar
// el callee por su cuenta y el caller contra un doble sordo es exactamente
// cómo esto sobrevivió.
// ============================================================

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'E', currency: 'MXN' } as unknown as AgentContext;

function espiaDeSesion() {
  const vistas: Array<Record<string, unknown>> = [];
  const factory = vi.fn(async (_p: unknown, _c: unknown, _cb: unknown, opts: Record<string, unknown>) => {
    vistas.push(opts);
    return { label: 'doble', runTurn: async () => ({ text: '' }) } as never;
  });
  return { vistas, factory };
}

describe('el failover reenvía las opciones de sesión que recibe', () => {
  it.each([
    ['la superficie del sandbox', SUPERFICIE_DESATENDIDA_SANDBOX],
    ['la superficie desatendida completa', SUPERFICIE_DESATENDIDA],
  ])('%s llega ENTERA al constructor de la sesión', async (_n, superficie) => {
    const { vistas, factory } = espiaDeSesion();
    await createLlmSessionWithFailover(undefined, CTX, {}, {
      herramientas: superficie,
      grounding: { enabled: false },
      sessionFactory: factory,
    } as never);
    expect(vistas, 'el constructor no llegó a llamarse: lo de abajo probaría sobre nada').toHaveLength(1);
    expect(
      vistas[0].herramientas,
      'el failover se comió la superficie nombrada: buildTools devolvería TODAS las herramientas, ' +
        'incluido el brazo externo que la compuerta --live decide'
    ).toEqual(superficie);
  });

  it('y no se come ninguno de los otros campos que la corrida desatendida usa', async () => {
    const { vistas, factory } = espiaDeSesion();
    const onBudgetWarning = vi.fn();
    await createLlmSessionWithFailover(undefined, CTX, {}, {
      herramientas: SUPERFICIE_DESATENDIDA_SANDBOX,
      grounding: { enabled: false },
      compaction: { thresholdTokens: 4242 },
      onBudgetWarning,
      sessionFactory: factory,
    } as never);
    const vista = vistas[0];
    // `grounding.enabled === false` es lo que IDENTIFICA la ruta desatendida
    // aguas abajo: perderlo no es cosmético, la convierte en atendida.
    expect(vista.grounding, 'se perdió grounding: la corrida dejaría de reconocerse como desatendida').toEqual({ enabled: false });
    expect(vista.compaction).toEqual({ thresholdTokens: 4242 });
    expect(vista.onBudgetWarning).toBe(onBudgetWarning);
  });

  it('las opciones PROPIAS del failover no se cuelan a la sesión', async () => {
    const { vistas, factory } = espiaDeSesion();
    await createLlmSessionWithFailover(undefined, CTX, {}, {
      herramientas: SUPERFICIE_DESATENDIDA_SANDBOX,
      model: 'un-modelo',
      onFailover: () => {},
      sessionFactory: factory,
    } as never);
    for (const propia of ['model', 'onFailover', 'sessionFactory', 'cooldowns']) {
      expect(vistas[0], `${propia} es del failover y no debe viajar a la sesión`).not.toHaveProperty(propia);
    }
  });
});
