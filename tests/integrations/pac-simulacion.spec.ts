import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { configFalso } = vi.hoisted(() => ({
  configFalso: { env: 'development' as string },
}));

vi.mock('../../src/config/index.js', () => ({ config: configFalso }));

import {
  assertPuedeTimbrar,
  estadoParaPersistir,
  simulacionPermitida,
  type ResultadoTimbre,
} from '../../src/services/integrations/mexico/pac/simulacion.js';

const TIMBRE: ResultadoTimbre = {
  uuid: '00000000-0000-0000-0000-000000000001',
  xml_timbrado: '<xml/>',
  cadena_original: '||',
  fecha_timbrado: new Date('2026-08-25'),
  no_certificado_sat: '00001000000500000000',
  sello_sat: 'sello',
};

const ENV_ORIGINAL = process.env.CFDI_PERMITIR_SIMULACION;

beforeEach(() => {
  configFalso.env = 'development';
  delete process.env.CFDI_PERMITIR_SIMULACION;
});

afterEach(() => {
  if (ENV_ORIGINAL === undefined) delete process.env.CFDI_PERMITIR_SIMULACION;
  else process.env.CFDI_PERMITIR_SIMULACION = ENV_ORIGINAL;
});

describe('cerrojo antisimulación del timbrado', () => {
  it('un adaptador simulado NO puede timbrar por omisión', () => {
    expect(() => assertPuedeTimbrar('finkok', true)).toThrow(/es una simulación/);
  });

  it('el mensaje explica la consecuencia, no solo el error', () => {
    try {
      assertPuedeTimbrar('finkok', true);
      throw new Error('debió lanzar');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/la autoridad desconoce/);
      expect(msg).toMatch(/CFDI_PERMITIR_SIMULACION/);
    }
  });

  it('un adaptador real timbra sin restricción', () => {
    expect(() => assertPuedeTimbrar('pac-real', false)).not.toThrow();
  });

  it('con la bandera explícita, fuera de producción, se permite', () => {
    process.env.CFDI_PERMITIR_SIMULACION = 'true';
    expect(simulacionPermitida()).toBe(true);
    expect(() => assertPuedeTimbrar('finkok', true)).not.toThrow();
  });

  it('en PRODUCCIÓN la bandera no sirve: no hay forma de habilitarlo', () => {
    configFalso.env = 'production';
    process.env.CFDI_PERMITIR_SIMULACION = 'true';
    expect(simulacionPermitida()).toBe(false);
    expect(() => assertPuedeTimbrar('finkok', true)).toThrow(/En producción no se puede habilitar/);
  });
});

describe('estado con que se persiste el folio', () => {
  it('un timbre real se guarda como stamped, sin nota', () => {
    expect(estadoParaPersistir(TIMBRE)).toEqual({ cfdi_status: 'stamped', nota: null });
  });

  it('un folio simulado NUNCA se guarda como stamped', () => {
    const r = estadoParaPersistir({ ...TIMBRE, simulado: true });
    expect(r.cfdi_status).not.toBe('stamped');
    expect(r.cfdi_status).toBe('failed');
    expect(r.nota).toMatch(/SIMULADO/);
  });

  it('la nota dice que el SAT no lo emitió', () => {
    expect(estadoParaPersistir({ ...TIMBRE, simulado: true }).nota).toMatch(/no emitido por el SAT/);
  });
});

describe('los tres adaptadores se declaran simulados', () => {
  it('ninguno pretende ser real mientras fabrique el sello', async () => {
    const { finkokAdapter } = await import('../../src/services/integrations/mexico/pac/finkok-adapter.js');
    const { swSapienAdapter } = await import('../../src/services/integrations/mexico/pac/sw-sapien-adapter.js');
    const { edicomAdapter } = await import('../../src/services/integrations/mexico/pac/edicom-adapter.js');
    for (const a of [finkokAdapter, swSapienAdapter, edicomAdapter]) {
      expect(a.simulado, `${a.providerId} debe declararse simulado`).toBe(true);
    }
  });
});
