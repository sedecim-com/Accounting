import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// La política se lee por el mismo lector que el resto del sistema; aquí se
// mockea ESE lector y no la base, para que la prueba diga algo sobre cómo
// consume este módulo la respuesta —y sobre qué hace cuando no la hay—.
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import {
  aplicarSubsidioAlEmpleo,
  leerRegistroDelSubsidio,
  notaDelSubsidioEntregado,
  CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
} from '../../../src/services/payroll/mx/subsidio-entregado.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockGetPolicy = getPolicy as unknown as Mock;

describe('el subsidio al empleo repartido entre lo que netea y lo que se entrega', () => {
  it('netea contra el ISR cuando el ISR alcanza a absorberlo', () => {
    // ISR 800, subsidio 300 → se retienen 500 y no sale efectivo.
    const r = aplicarSubsidioAlEmpleo(800, 300);
    expect(r.isrRetenido).toBe('500.0000');
    expect(r.entregadoEnEfectivo).toBe('0.0000');
  });

  it('ENTREGA la diferencia cuando el subsidio supera al ISR', () => {
    // EL DEFECTO EN UNA LÍNEA. Con `Math.max(0, isr - sub)` esto devolvía
    // sólo el 0 del ISR y los 248.05 del trabajador desaparecían del recibo.
    const r = aplicarSubsidioAlEmpleo(158.57, 406.62);
    expect(r.isrRetenido).toBe('0.0000');
    expect(r.entregadoEnEfectivo).toBe('248.0500');
  });

  it('no retiene ni entrega nada cuando coinciden al centavo', () => {
    const r = aplicarSubsidioAlEmpleo(406.62, 406.62);
    expect(r.isrRetenido).toBe('0.0000');
    expect(r.entregadoEnEfectivo).toBe('0.0000');
  });

  it('nunca devuelve un importe negativo por ninguna de las dos vías', () => {
    for (const [isr, sub] of [[0, 0], [0, 500], [500, 0], [1.23, 4.56]] as const) {
      const r = aplicarSubsidioAlEmpleo(isr, sub);
      expect(Number(r.isrRetenido)).toBeGreaterThanOrEqual(0);
      expect(Number(r.entregadoEnEfectivo)).toBeGreaterThanOrEqual(0);
    }
  });

  it('resta en decimal y no en coma flotante', () => {
    // 0.1 + 0.2 en `number` da 0.30000000000000004; la resta equivalente
    // sobre importes de nómina es la que decide si alguien cobra un centavo
    // de más o de menos, todos los periodos, para siempre.
    const r = aplicarSubsidioAlEmpleo(0.1, 0.3);
    expect(r.entregadoEnEfectivo).toBe('0.2000');
    const r2 = aplicarSubsidioAlEmpleo(1000.05, 1000.1);
    expect(r2.entregadoEnEfectivo).toBe('0.0500');
  });

  it('trata un subsidio negativo como cero en vez de convertirlo en retención', () => {
    const r = aplicarSubsidioAlEmpleo(100, -50);
    expect(r.isrRetenido).toBe('100.0000');
    expect(r.entregadoEnEfectivo).toBe('0.0000');
  });
});

describe('dónde se registra el efectivo entregado', () => {
  beforeEach(() => mockGetPolicy.mockReset());

  it('lee la política del panel por su clave', async () => {
    mockGetPolicy.mockResolvedValueOnce({
      key: CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      value: 'gasto_del_patron',
      defined: true,
      question: 'q',
      rationale: null,
    });
    const r = await leerRegistroDelSubsidio({ tenantId: 't1', entityId: 'e1' });
    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: 't1', entityId: 'e1' },
      CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      undefined
    );
    expect(r.valor).toBe('gasto_del_patron');
    expect(r.decididoPorElDespacho).toBe(true);
  });

  it('NO presenta el valor de omisión como criterio del despacho', async () => {
    // `getPolicy` devuelve el default con defined:false cuando nadie contestó.
    // Confundir eso con una decisión es cómo un sistema acaba diciendo «tu
    // despacho eligió esto» sobre algo que nadie eligió.
    mockGetPolicy.mockResolvedValueOnce({
      key: CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      value: 'cuenta_por_cobrar_fisco',
      defined: false,
      question: 'q',
      rationale: null,
    });
    const r = await leerRegistroDelSubsidio({ tenantId: 't1' });
    expect(r.valor).toBe('cuenta_por_cobrar_fisco');
    expect(r.decididoPorElDespacho).toBe(false);
    expect(notaDelSubsidioEntregado(r)).toMatch(/sigue sin contestar/);
    expect(notaDelSubsidioEntregado(r)).not.toMatch(/criterio del despacho/);
  });

  it('nombra el destino contable de cada respuesta en la nota del renglón', () => {
    expect(
      notaDelSubsidioEntregado({ valor: 'cuenta_por_cobrar_fisco', decididoPorElDespacho: true })
    ).toMatch(/cuenta por cobrar al fisco/);
    expect(
      notaDelSubsidioEntregado({ valor: 'gasto_del_patron', decididoPorElDespacho: true })
    ).toMatch(/gasto del patrón/);
  });

  it('se niega ante un valor de política que no entiende, en vez de elegir uno', async () => {
    mockGetPolicy.mockResolvedValueOnce({
      key: CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      value: 'lo_que_sea',
      defined: true,
      question: 'q',
      rationale: null,
    });
    await expect(leerRegistroDelSubsidio({ tenantId: 't1' })).rejects.toThrow(
      /SUBSIDIO_REGISTRO_DESCONOCIDO|lo_que_sea/
    );
  });

  it('lee dentro de la transacción del llamador cuando le pasan su cliente', async () => {
    mockGetPolicy.mockResolvedValueOnce({
      key: CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      value: 'cuenta_por_cobrar_fisco',
      defined: true,
      question: 'q',
      rationale: null,
    });
    const cliente = { query: vi.fn() } as never;
    await leerRegistroDelSubsidio({ tenantId: 't1' }, cliente);
    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: 't1' },
      CLAVE_POLITICA_SUBSIDIO_ENTREGADO,
      cliente
    );
  });
});
