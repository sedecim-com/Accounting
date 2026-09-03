import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import {
  checkMappingCoverageDetallada,
  checkMappingCoverage,
  setAccountMapping,
  resolverEsquema,
  MAPPING_SCHEMES,
} from '../../../src/services/accounting/account-service.js';
import {
  validarCodigoAgrupador,
  prepararValidacionAgrupador,
  sembrarCatalogoAgrupadores,
  hayCatalogoVigente,
} from '../../../src/services/accounting/sat-agrupadores.js';
import { C_CODAGRUP, rubroDe } from '../../../src/services/accounting/sat-agrupadores-catalogo.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

const ENTIDAD = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';

/** Lo que la consulta de la compuerta devuelve por fila. */
function fila(
  code: string,
  nivel: number,
  lineas: number,
  sinMapeo: boolean
): Record<string, unknown> {
  return {
    account_id: `id-${code}`,
    code,
    name: `Cuenta ${code}`,
    account_level: nivel,
    lineas_posteadas: lineas,
    sin_mapeo: sinMapeo,
  };
}

function politica(value: string, defined = false) {
  return { key: 'k', value, defined, question: 'q', rationale: null };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPolicy.mockReset();
});

// ============================================================
describe('el agrupador vive en su propia columna, no en la de la norma contable', () => {
  it("'sat-agrupador' escribe en codigo_agrupador_sat; mx_nif_code queda para las NIF", () => {
    expect(resolverEsquema('sat-agrupador')).toBe('codigo_agrupador_sat');
    // La prueba que importa: NINGÚN esquema apunta ya a mx_nif_code. Si alguien
    // vuelve a colgar el agrupador ahí, el cisma renace y esto lo caza.
    expect(Object.values(MAPPING_SCHEMES)).not.toContain('mx_nif_code');
    expect(resolverEsquema('us-tax-line')).toBe('us_gaap_code');
    expect(resolverEsquema('ifrs')).toBe('ifrs_code');
  });
});

// ============================================================
describe('checkMappingCoverage — la población, que es donde estaba el defecto', () => {
  it('por omisión mide CUENTAS CON MOVIMIENTO, y lo pide al panel por su clave', async () => {
    mockGetPolicy.mockResolvedValue(politica('cuentas_con_movimientos'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [fila('1110', 3, 3, true), fila('5100', 2, 2, false)] });

    const r = await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');

    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: TENANT, entityId: ENTIDAD },
      'agrupador_alcance_de_la_compuerta'
    );
    expect(r.alcance).toBe('cuentas_con_movimientos');
    expect(r.alcanceElegido).toBe(false); // es el defecto, no una elección
    expect(r.poblacion).toBe(2);
    expect(r.huecos.map((h) => h.code)).toEqual(['1110']);
  });

  it('LA CUENTA MOVIDA DE NIVEL 3 SE REPORTA: el filtro de nivel ya no la esconde', async () => {
    mockGetPolicy.mockResolvedValue(politica('cuentas_con_movimientos'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [fila('1120', 3, 7, true)] });

    const huecos = await checkMappingCoverage(ENTIDAD, 'sat-agrupador', 2);

    // Con `account_level <= 2` esta cuenta era invisible pese a tener 7 líneas
    // posteadas sin agrupador: el hueco que sí impide entregar el XML.
    expect(huecos).toHaveLength(1);
    expect(huecos[0]).toMatchObject({ code: '1120', account_level: 3, lineas_posteadas: 7 });
  });

  it('LA CUENTA SIN MOVER NO SE REPORTA: 42 de 43 acusaciones eran ruido', async () => {
    mockGetPolicy.mockResolvedValue(politica('cuentas_con_movimientos'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      // La consulta ya excluye las no movidas (AND m.lineas > 0): la población
      // que vuelve son sólo las movidas.
      .mockResolvedValueOnce({ rows: [fila('6100', 2, 5, true)] });

    const r = await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');
    const sql = mockQuery.mock.calls[1][0] as string;

    expect(sql).toMatch(/m\.lineas > 0/);
    expect(sql).toMatch(/je\.status = 'posted'/);
    expect(r.huecos.every((h) => h.lineas_posteadas > 0)).toBe(true);
  });

  it('sólo cuenta lo POSTEADO y sólo de esta entidad: un borrador no obliga a mapear', async () => {
    mockGetPolicy.mockResolvedValue(politica('cuentas_con_movimientos'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [] });

    await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];

    expect(sql).toMatch(/je\.status = 'posted'/);
    // La entidad DENTRO del SQL, y en las dos tablas: ni las cuentas de otra
    // entidad ni los asientos de otra entidad entran en la medición.
    expect(sql).toMatch(/je\.entity_id = \$1/);
    expect(sql).toMatch(/a\.entity_id = \$1/);
    expect(params[0]).toBe(ENTIDAD);
  });

  it("'todas_las_de_detalle' cambia la población a las cuentas no agrupadoras", async () => {
    mockGetPolicy.mockResolvedValue(politica('todas_las_de_detalle', true));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [fila('1111', 4, 0, true)] });

    const r = await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');
    const sql = mockQuery.mock.calls[1][0] as string;

    expect(r.alcance).toBe('todas_las_de_detalle');
    expect(r.alcanceElegido).toBe(true); // contestada por el usuario
    expect(sql).toMatch(/a\.is_header = false/);
    expect(sql).not.toMatch(/m\.lineas > 0/);
    // Aquí SÍ sale la cuenta sin movimiento: es lo que el usuario pidió.
    expect(r.huecos.map((h) => h.code)).toEqual(['1111']);
  });

  it("'todas' no filtra la población en absoluto", async () => {
    mockGetPolicy.mockResolvedValue(politica('todas', true));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [fila('1000', 1, 0, true)] });

    await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');
    const sql = mockQuery.mock.calls[1][0] as string;

    expect(sql).not.toMatch(/m\.lineas > 0/);
    expect(sql).not.toMatch(/is_header = false/);
  });

  it('un valor ilegible en el panel cae al defecto en vez de romper la compuerta', async () => {
    mockGetPolicy.mockResolvedValue(politica('lo_que_sea'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador');
    expect(r.alcance).toBe('cuentas_con_movimientos');
  });

  it('el tercer parámetro numérico se acepta y NO recorta: era el defecto', async () => {
    mockGetPolicy.mockResolvedValue(politica('cuentas_con_movimientos'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [fila('1130', 3, 4, true)] });

    const huecos = await checkMappingCoverage(ENTIDAD, 'sat-agrupador', 2);
    const sql = mockQuery.mock.calls[1][0] as string;

    expect(sql).not.toMatch(/account_level <= /);
    expect(huecos.map((h) => h.code)).toEqual(['1130']);
  });

  it('acota por periodo cuando se lo piden', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fila('1110', 3, 1, true)] });

    await checkMappingCoverageDetallada(ENTIDAD, 'sat-agrupador', {
      alcance: 'cuentas_con_movimientos',
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    expect(sql).toMatch(/je\.entry_date >= \$2/);
    expect(sql).toMatch(/je\.entry_date <= \$3/);
    expect(params).toEqual([ENTIDAD, '2026-01-01', '2026-01-31']);
    // Con alcance forzado no se consulta el panel.
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('validación contra el catálogo oficial c_CodAgrup', () => {
  it('lee la política por su clave literal', async () => {
    mockGetPolicy.mockResolvedValue(politica('rechazar'));
    mockQuery.mockResolvedValueOnce({ rows: [{ hay: true }] });

    const ctx = await prepararValidacionAgrupador({ tenantId: TENANT, entityId: ENTIDAD }, '2026-05-01');

    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: TENANT, entityId: ENTIDAD },
      'agrupador_valor_fuera_de_catalogo'
    );
    expect(ctx).toEqual({ politica: 'rechazar', hayCatalogo: true, fecha: '2026-05-01' });
  });

  it('un código que existe con vigencia que cubre la fecha se acepta', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ codigo: '101.01', nombre: 'Caja y efectivo', nivel: 2 }],
    });
    const r = await validarCodigoAgrupador(
      { politica: 'rechazar', hayCatalogo: true, fecha: '2026-05-01' },
      '101.01'
    );
    expect(r.veredicto).toBe('valido');
    expect(r.accion).toBe('aceptar');
    expect(r.nombre).toBe('Caja y efectivo');
  });

  it('un código ausente se RECHAZA con la política por omisión', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await validarCodigoAgrupador(
      { politica: 'rechazar', hayCatalogo: true, fecha: '2026-05-01' },
      '999.99'
    );
    expect(r.veredicto).toBe('fuera_de_catalogo');
    expect(r.accion).toBe('rechazar');
    expect(r.aviso).toMatch(/no está en el catálogo/);
  });

  it("con la política en 'avisar' el mismo código pasa, pero avisando", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await validarCodigoAgrupador(
      { politica: 'avisar', hayCatalogo: true, fecha: '2026-05-01' },
      '999.99'
    );
    expect(r.veredicto).toBe('fuera_de_catalogo');
    expect(r.accion).toBe('aceptar_con_aviso');
  });

  it('CATÁLOGO VACÍO: avisa que no está sembrado; no acepta en silencio ni rechaza todo', async () => {
    const r = await validarCodigoAgrupador(
      { politica: 'rechazar', hayCatalogo: false, fecha: '2026-05-01' },
      '101.01'
    );
    // Aunque la política diga rechazar: no hay catálogo que pueda rechazar nada.
    expect(r.veredicto).toBe('sin_catalogo');
    expect(r.accion).toBe('aceptar_con_aviso');
    expect(r.aviso).toMatch(/catálogo del SAT no está sembrado/);
    // Y no se consultó la tabla: no hay nada que consultar.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('la vigencia entra en el SQL: el catálogo del ejercicio, no el de hoy', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await validarCodigoAgrupador(
      { politica: 'rechazar', hayCatalogo: true, fecha: '2022-06-30' },
      '101.01'
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/vigente_desde <= \$2/);
    expect(sql).toMatch(/vigente_hasta IS NULL OR vigente_hasta >= \$2/);
    expect(params).toEqual(['101.01', '2022-06-30']);
  });

  it('hayCatalogoVigente pregunta por la fecha, no por «hay filas»', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ hay: false }] });
    expect(await hayCatalogoVigente('2019-03-01')).toBe(false);
    expect(mockQuery.mock.calls[0][0]).toMatch(/vigente_desde <= \$1/);
  });
});

// ============================================================
describe('setAccountMapping — la validación va ANTES del UPDATE', () => {
  it('no escribe nada cuando el código está fuera de catálogo', async () => {
    mockGetPolicy.mockResolvedValue(politica('rechazar'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ entity_id: ENTIDAD, tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] }) // hayCatalogoVigente
      .mockResolvedValueOnce({ rows: [] }); // buscarAgrupador: no está

    await expect(
      setAccountMapping('cuenta-1', 'sat-agrupador', 'INVENTADO', 'u1')
    ).rejects.toThrow(/no está en el catálogo/);

    // Tres lecturas y ni un UPDATE.
    expect(mockQuery.mock.calls).toHaveLength(3);
    expect(mockQuery.mock.calls.every(([sql]) => !/UPDATE accounts/.test(sql as string))).toBe(true);
  });

  it('escribe en codigo_agrupador_sat cuando el código es válido', async () => {
    mockGetPolicy.mockResolvedValue(politica('rechazar'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ entity_id: ENTIDAD, tenant_id: TENANT }] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] })
      .mockResolvedValueOnce({ rows: [{ codigo: '102.01', nombre: 'Bancos nacionales', nivel: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'cuenta-1' }] });

    await setAccountMapping('cuenta-1', 'sat-agrupador', '102.01', 'u1');

    const [sql, params] = mockQuery.mock.calls[3] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE accounts SET codigo_agrupador_sat = \$1/);
    expect(sql).not.toMatch(/mx_nif_code/);
    expect(params).toEqual(['102.01', 'u1', 'cuenta-1']);
  });

  it('limpiar el mapeo (null) no se valida: borrar no puede estar fuera de catálogo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'cuenta-1' }] });
    await setAccountMapping('cuenta-1', 'sat-agrupador', null, 'u1');
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });

  it('los otros esquemas no pasan por el catálogo del SAT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'cuenta-1' }] });
    await setAccountMapping('cuenta-1', 'us-tax-line', 'LO-QUE-SEA', 'u1');
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/us_gaap_code = \$1/);
    expect(mockGetPolicy).not.toHaveBeenCalled();
  });
});

// ============================================================
describe('la siembra del c_CodAgrup', () => {
  it('siembra la lista oficial completa, con vigencia y sin duplicar', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: C_CODAGRUP.length });
    const r = await sembrarCatalogoAgrupadores();

    expect(r.ofrecidos).toBe(C_CODAGRUP.length);
    expect(r.insertados).toBe(C_CODAGRUP.length);
    expect(r.vigencia).toBe('2026-01-01');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(codigo, vigente_desde\) DO NOTHING/);
    expect((params[0] as string[])[0]).toBe('100');
    // El padre se deriva del código y viaja a la columna de jerarquía.
    const codigos = params[0] as string[];
    const padres = params[3] as (string | null)[];
    expect(padres[codigos.indexOf('102.01')]).toBe('102');
    expect(padres[codigos.indexOf('102')]).toBeNull();
  });

  it('la segunda corrida no inserta: la siembra es idempotente', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await sembrarCatalogoAgrupadores();
    expect(r.insertados).toBe(0);
    expect(r.yaEstaban).toBe(C_CODAGRUP.length);
  });
});

// ============================================================
describe('el catálogo oficial como dato: integridad de la extracción', () => {
  it('no hay códigos repetidos', () => {
    const vistos = new Set(C_CODAGRUP.map((a) => a.codigo));
    expect(vistos.size).toBe(C_CODAGRUP.length);
  });

  it('toda subcuenta cuelga de un rubro que existe', () => {
    const rubros = new Set(C_CODAGRUP.filter((a) => a.nivel === 1).map((a) => a.codigo));
    const huerfanas = C_CODAGRUP.filter((a) => a.nivel === 2 && !rubros.has(rubroDe(a.codigo) ?? ''));
    expect(huerfanas).toEqual([]);
  });

  it('el nivel concuerda con la forma del código: 100 es rubro, 100.01 es subcuenta', () => {
    const incoherentes = C_CODAGRUP.filter(
      (a) => a.nivel !== (a.codigo.includes('.') ? 2 : 1)
    );
    expect(incoherentes).toEqual([]);
  });

  it('trae los anclajes que un catálogo mexicano usa a diario', () => {
    const m = new Map(C_CODAGRUP.map((a) => [a.codigo, a.nombre]));
    // Verificados contra el Anexo 24 de la RMF 2026 (DOF 13/01/2026).
    expect(m.get('101')).toBe('Caja');
    expect(m.get('102')).toBe('Bancos');
    expect(m.get('105')).toBe('Clientes');
    expect(m.get('118')).toBe('Impuestos acreditables pagados');
    expect(m.get('201')).toBe('Proveedores');
    expect(m.get('208')).toBe('Impuestos trasladados cobrados');
    expect(m.get('301')).toBe('Capital social');
    expect(m.get('401')).toBe('Ingresos');
    expect(m.get('501')).toBe('Costo de venta y/o servicio');
    expect(m.get('601')).toBe('Gastos generales');
  });

  it('el catálogo es grande de verdad: no es una lista de juguete', () => {
    expect(C_CODAGRUP.length).toBeGreaterThan(1000);
    expect(C_CODAGRUP.filter((a) => a.nivel === 1).length).toBeGreaterThan(100);
  });
});
