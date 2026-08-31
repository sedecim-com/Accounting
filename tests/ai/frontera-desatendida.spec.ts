import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: bajo CommonJS un await de nivel superior es error de
// compilación, y los mocks capturan estas referencias al izarse.
const { getPolicyMock, fileValuesMock } = vi.hoisted(() => ({
  getPolicyMock: vi.fn(),
  fileValuesMock: vi.fn(),
}));

vi.mock('../../src/services/policy/policy-service.js', () => ({
  getPolicy: (...a: unknown[]) => getPolicyMock(...a),
}));
vi.mock('../../src/ai/providers/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, ingestFileValues: (...a: unknown[]) => fileValuesMock(...a) };
});

import { resolverUmbralesConPanel } from '../../src/ai/ingest-thresholds.js';
import { buildTools } from '../../src/ai/tools/index.js';
import { SUPERFICIE_DESATENDIDA } from '../../src/ai/tools/superficie.js';

/**
 * LA FRONTERA DE LA CORRIDA DESATENDIDA.
 *
 * Dos mitades del mismo borde. El auto-posteo decide si un asiento llega al
 * mayor SIN humano, y lo gobernaba un booleano en un json local mientras las
 * dos claves del panel no las leía nadie: el despacho contestaba y no
 * cambiaba nada — contra la regla de la casa, que manda toda bifurcación de
 * criterio contable al panel con su lector. Y la sesión desatendida recibía
 * TODAS las herramientas por omisión: hoy inofensivo (ninguna puede
 * postear), pero la primera herramienta futura habría entrado a lo
 * desatendido sin que nadie lo decidiera.
 */

const CTX = { tenantId: 't-1', entityId: 'e-1' };

const politica = (respuestas: Record<string, { value: string; defined: boolean }>) => {
  getPolicyMock.mockImplementation((_ctx: unknown, key: string) => {
    const r = respuestas[key as string];
    if (!r) throw new Error(`política inesperada: ${key}`);
    return Promise.resolve({ key, ...r, question: key, rationale: null });
  });
};

beforeEach(() => {
  getPolicyMock.mockReset();
  fileValuesMock.mockReset();
  fileValuesMock.mockReturnValue({});
});

describe('la precedencia: bandera > archivo > política > omisión', () => {
  it('sin nada, la omisión es conservadora y lo dice', async () => {
    politica({
      ingest_auto_post: { value: 'off', defined: false },
      ingest_auto_post_max_monto: { value: '10000', defined: false },
    });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.autoPost).toBe(false);
    expect(r.fuentes?.autoPost).toBe('omision');
    expect(r.fuentes?.maxAmount).toBe('omision');
  });

  it('la política del despacho enciende cuando nadie más habló', async () => {
    // Éste es el caso que antes NO funcionaba: el despacho contestaba 'on'
    // en el panel y no cambiaba nada, porque nadie leía la clave.
    politica({
      ingest_auto_post: { value: 'on', defined: true },
      ingest_auto_post_max_monto: { value: '5000', defined: true },
    });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.autoPost).toBe(true);
    expect(r.fuentes?.autoPost).toBe('politica');
    expect(r.maxAmount).toBe(5000);
    expect(r.fuentes?.maxAmount).toBe('politica');
  });

  it('el archivo del operador gana a la política en el interruptor', async () => {
    // Apagar siempre puede ser más local que encender: un operador que apagó
    // el auto-posteo en su máquina no debe verlo encendido por el panel.
    politica({
      ingest_auto_post: { value: 'on', defined: true },
      ingest_auto_post_max_monto: { value: '5000', defined: true },
    });
    fileValuesMock.mockReturnValue({ autoPost: false });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.autoPost).toBe(false);
    expect(r.fuentes?.autoPost).toBe('archivo');
  });

  it('la bandera explícita gana a todos', async () => {
    politica({
      ingest_auto_post: { value: 'off', defined: true },
      ingest_auto_post_max_monto: { value: '5000', defined: true },
    });
    fileValuesMock.mockReturnValue({ autoPost: false });
    const r = await resolverUmbralesConPanel({ autoPost: true }, CTX);
    expect(r.autoPost).toBe(true);
    expect(r.fuentes?.autoPost).toBe('bandera');
  });

  it('un valor desconocido en el panel NO enciende nada', async () => {
    // El vocabulario está cerrado al declarar y abierto al escribir: un
    // «sí» tecleado a mano no puede acabar posteando sin revisión.
    politica({
      ingest_auto_post: { value: 'sí', defined: true },
      ingest_auto_post_max_monto: { value: '10000', defined: false },
    });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.autoPost).toBe(false);
  });
});

describe('el tope del archivo sólo gana si es MÁS estricto', () => {
  it('el operador puede bajar la exposición de su máquina', async () => {
    politica({
      ingest_auto_post: { value: 'on', defined: true },
      ingest_auto_post_max_monto: { value: '50000', defined: true },
    });
    fileValuesMock.mockReturnValue({ maxAmount: 8000 });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.maxAmount).toBe(8000);
    expect(r.fuentes?.maxAmount).toBe('archivo');
  });

  it('pero no puede subirla por encima de lo que el despacho contestó', async () => {
    // Invertiría quién responde por la contabilidad: el panel es del
    // despacho; el json, de una máquina.
    politica({
      ingest_auto_post: { value: 'on', defined: true },
      ingest_auto_post_max_monto: { value: '5000', defined: true },
    });
    fileValuesMock.mockReturnValue({ maxAmount: 50000 });
    const r = await resolverUmbralesConPanel({}, CTX);
    expect(r.maxAmount, 'el tope laxo del json no debe pisar el estricto del panel').toBe(5000);
    expect(r.fuentes?.maxAmount).toBe('politica');
  });
});

describe('la superficie desatendida es nombrada y falla cerrado', () => {
  const ctx = {
    entityId: 'e', entityName: 'E', tenantId: 't', currency: 'MXN',
    country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  const deps = { model: 'm' } as never;

  it('la lista nombra herramientas que existen, todas', () => {
    // Si esto falla, alguien renombró una herramienta sin tocar la lista: la
    // superficie declarada ya no sería la real, y eso debe romper aquí y no
    // descubrirse en una corrida nocturna.
    expect(() => buildTools(ctx as never, deps, SUPERFICIE_DESATENDIDA)).not.toThrow();
  });

  it('con la lista, la sesión recibe exactamente esos nombres', () => {
    const todas = buildTools(ctx as never, deps);
    const recortadas = buildTools(ctx as never, deps, SUPERFICIE_DESATENDIDA);
    expect(recortadas.map((t) => t.name).sort()).toEqual([...SUPERFICIE_DESATENDIDA].sort());
    // Hoy la lista es la superficie completa a propósito: el commit que la
    // introduce no cambia comportamiento, cambia quién decide el futuro.
    expect(recortadas.length).toBe(todas.length);
  });

  it('una herramienta nueva NO entra a lo desatendido por sí sola', () => {
    const todas = buildTools(ctx as never, deps).map((t) => t.name);
    const sinUna = SUPERFICIE_DESATENDIDA.filter((n) => n !== 'draft_journal_entry');
    const recortadas = buildTools(ctx as never, deps, sinUna).map((t) => t.name);
    expect(todas).toContain('draft_journal_entry');
    expect(recortadas, 'lo que no está en la lista no viaja').not.toContain('draft_journal_entry');
  });

  it('un nombre fantasma en la lista LANZA en vez de filtrar en silencio', () => {
    expect(() =>
      buildTools(ctx as never, deps, [...SUPERFICIE_DESATENDIDA, 'herramienta_renombrada'])
    ).toThrow(/no existen/);
  });
});
