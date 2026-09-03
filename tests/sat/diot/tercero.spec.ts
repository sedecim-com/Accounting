import { describe, it, expect } from 'vitest';
import {
  resolverTercero,
  type PoliticasDelTercero,
  type TerceroCrudo,
} from '../../../src/services/sat/diot/tercero.js';
import { RFC_GENERICO_NACIONAL } from '../../../src/services/sat/diot/rfc.js';

// ============================================================
// F07c · EL TERCERO, Y LAS DOS POLÍTICAS QUE LO DECIDEN
//
// La prueba que importa de un panel de políticas no es que la política se
// lea: es que contestarla CAMBIE la respuesta. Cada bloque de aquí corre la
// misma fila de proveedor con los dos valores y comprueba que salen dos cosas
// distintas.
// ============================================================

const proveedor = (o: Partial<TerceroCrudo> = {}): TerceroCrudo => ({
  vendorId: 'v1',
  nombre: 'Papelería del Centro SA de CV',
  taxId: 'ABC010101AA1',
  taxIdType: 'rfc',
  tipoTercero: null,
  tipoOperacion: null,
  idFiscalExtranjero: null,
  paisResidencia: null,
  nacionalidad: null,
  ...o,
});

const POR_OMISION: PoliticasDelTercero = {
  tipoOperacionPorOmision: '85',
  terceroSinRfc: 'bloquear',
};

describe('el tipo de tercero', () => {
  it('infiere 04 de un RFC mexicano bien formado, que es la única inferencia segura', () => {
    const r = resolverTercero(proveedor(), POR_OMISION);
    expect(r.tercero).toMatchObject({ tipoTercero: '04', rfc: 'ABC010101AA1' });
    expect(r.tercero?.procedencia.tipoTercero).toBe('inferido');
  });

  it('respeta el tipo declarado por encima de la inferencia', () => {
    const r = resolverTercero(proveedor({ tipoTercero: '15' }), POR_OMISION);
    expect(r.tercero?.tipoTercero).toBe('15');
    expect(r.tercero?.procedencia.tipoTercero).toBe('declarado');
  });

  it('NO infiere 05 por la ausencia de RFC: no tener el dato no es una pista', () => {
    const r = resolverTercero(proveedor({ taxId: null }), POR_OMISION);
    expect(r.tercero).toBeNull();
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-SIN-RFC');
  });
});

describe('el tercero extranjero (05)', () => {
  const extranjero = (o: Partial<TerceroCrudo> = {}) =>
    proveedor({
      tipoTercero: '05',
      taxId: null,
      idFiscalExtranjero: 'US-99-1234567',
      paisResidencia: 'USA',
      nacionalidad: 'Estadounidense',
      ...o,
    });

  it('se declara sin RFC: la DIOT lo identifica por su identificación fiscal', () => {
    const r = resolverTercero(extranjero(), POR_OMISION);
    expect(r.tercero).toMatchObject({
      tipoTercero: '05',
      idFiscalExtranjero: 'US-99-1234567',
      paisResidencia: 'USA',
      nacionalidad: 'Estadounidense',
    });
    expect(r.tercero?.rfc).toBeUndefined();
    // Y no lo tumba la política del RFC, que es lo que pasaría si el orden
    // fuese al revés: se pregunta primero el tipo, porque decide qué se exige.
    expect(r.hallazgos.filter((h) => h.severidad === 'bloqueante')).toHaveLength(0);
  });

  it('bloquea y dice cuál de los tres datos falta', () => {
    const r = resolverTercero(extranjero({ nacionalidad: null }), POR_OMISION);
    expect(r.tercero).toBeNull();
    const h = r.hallazgos.find((x) => x.codigo === 'DIOT-EXTRANJERO-INCOMPLETO');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.mensaje).toContain('nacionalidad');
  });
});

describe('diot_tercero_sin_rfc · contestarla cambia el resultado', () => {
  const rotos: Array<[string, Partial<TerceroCrudo>]> = [
    ['vacío', { taxId: null }],
    ['malformado', { taxId: 'ABC01' }],
    ['genérico', { taxId: RFC_GENERICO_NACIONAL }],
  ];

  it.each(rotos)('bloquear: con el RFC %s se niega y nombra al proveedor', (_caso, campos) => {
    const r = resolverTercero(proveedor(campos), { ...POR_OMISION, terceroSinRfc: 'bloquear' });
    expect(r.tercero).toBeNull();
    const h = r.hallazgos.find((x) => x.codigo === 'DIOT-SIN-RFC');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.politica).toBe('diot_tercero_sin_rfc');
    expect(h?.mensaje).toContain('Papelería del Centro');
  });

  it.each(rotos)('declarar_global: con el RFC %s lo declara como 15 y avisa', (_caso, campos) => {
    const r = resolverTercero(proveedor(campos), {
      ...POR_OMISION,
      terceroSinRfc: 'declarar_global',
    });
    expect(r.tercero).toMatchObject({ tipoTercero: '15', rfc: RFC_GENERICO_NACIONAL });
    expect(r.tercero?.procedencia.tipoTercero).toBe('politica');
    const h = r.hallazgos.find((x) => x.codigo === 'DIOT-SIN-RFC-DECLARADO-GLOBAL');
    expect(h?.severidad).toBe('aviso');
    expect(h?.mensaje).toContain('contraparte identificable');
  });

  it('el genérico es el caso que el sistema NO veía: tiene forma de RFC', () => {
    const r = resolverTercero(proveedor({ taxId: RFC_GENERICO_NACIONAL }), POR_OMISION);
    expect(r.tercero).toBeNull();
  });

  it('avisa cuando un tercero global (15) arrastra el RFC real de un proveedor', () => {
    const r = resolverTercero(proveedor({ tipoTercero: '15' }), POR_OMISION);
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-GLOBAL-CON-RFC');
    expect(r.tercero?.rfc).toBe(RFC_GENERICO_NACIONAL);
  });
});

describe('diot_tipo_operacion_por_omision · contestarla cambia el resultado', () => {
  it('85: lo declara con el cajón del catálogo y lo lista', () => {
    const r = resolverTercero(proveedor(), { ...POR_OMISION, tipoOperacionPorOmision: '85' });
    expect(r.tercero?.tipoOperacion).toBe('85');
    expect(r.tercero?.procedencia.tipoOperacion).toBe('politica');
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-TIPO-OPERACION-POR-OMISION');
  });

  it('03: la misma fila sale con otro tipo', () => {
    const r = resolverTercero(proveedor(), { ...POR_OMISION, tipoOperacionPorOmision: '03' });
    expect(r.tercero?.tipoOperacion).toBe('03');
  });

  it('bloquear: se niega y explica que es un dato del proveedor, no de la factura', () => {
    const r = resolverTercero(proveedor(), { ...POR_OMISION, tipoOperacionPorOmision: 'bloquear' });
    expect(r.tercero).toBeNull();
    const h = r.hallazgos.find((x) => x.codigo === 'DIOT-TIPO-OPERACION-SIN-DECLARAR');
    expect(h?.severidad).toBe('bloqueante');
  });

  it('el tipo capturado gana sobre la política, y sin aviso', () => {
    const r = resolverTercero(proveedor({ tipoOperacion: '06' }), POR_OMISION);
    expect(r.tercero).toMatchObject({ tipoOperacion: '06' });
    expect(r.tercero?.procedencia.tipoOperacion).toBe('declarado');
    expect(r.hallazgos.map((h) => h.codigo)).not.toContain('DIOT-TIPO-OPERACION-POR-OMISION');
  });

  it('un valor de política fuera del catálogo se detiene, no se traduce', () => {
    const r = resolverTercero(proveedor(), { ...POR_OMISION, tipoOperacionPorOmision: '99' });
    expect(r.tercero).toBeNull();
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-POLITICA-FUERA-DE-CATALOGO');
  });
});
