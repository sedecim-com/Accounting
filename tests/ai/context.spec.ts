import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import {
  resolveEntity,
  listEntities,
  bootstrapTenant,
  fijarInquilinoDeLaSesion,
  inquilinoDeLaSesion,
  olvidarInquilinoDeLaSesion,
  estadoDelInquilino,
} from '../../src/ai/context.js';
import { query, enterTenant } from '../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const mockEnterTenant = enterTenant as unknown as Mock;

const ENTITY_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Acme MX SA de CV',
  tenant_id: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  functional_currency: 'MXN',
  incorporation_country: 'MX',
  accounting_standard: 'mx_nif',
  tax_id: 'AME010101AAA',
};

describe('resolveEntity', () => {
  beforeEach(() => { mockQuery.mockReset(); mockEnterTenant.mockReset(); });

  it('resolves by UUID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity(ENTITY_ROW.id);
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
    expect(ctx.entityName).toBe('Acme MX SA de CV');
    expect(ctx.currency).toBe('MXN');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params).toEqual([ENTITY_ROW.id]);
  });

  it('resolves by name fragment (single match)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity('acme');
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/name ILIKE \$1/);
    expect(params).toEqual(['%acme%', 'ACME']);
  });

  it('rejects an ambiguous name with the candidate list', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ENTITY_ROW, { ...ENTITY_ROW, id: 'ffffffff-1111-2222-3333-444444444444', name: 'Acme USA Inc' }],
    });
    await expect(resolveEntity('acme')).rejects.toThrow(/ambiguous/);
  });

  it('rejects when no match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveEntity('nope')).rejects.toThrow(/No active entity matches/);
  });

  it('defaults to the single active entity when no argument', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity();
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
  });

  it('rejects with a listing when multiple entities and no argument', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ENTITY_ROW, { ...ENTITY_ROW, id: 'ffffffff-1111-2222-3333-444444444444', name: 'Acme USA Inc' }],
    });
    await expect(resolveEntity()).rejects.toThrow(/--entity/);
  });
});

describe('listEntities', () => {
  beforeEach(() => { mockQuery.mockReset(); mockEnterTenant.mockReset(); });

  it('returns active entities ordered by name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const rows = await listEntities();
    expect(rows).toHaveLength(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/is_active = true/);
    expect(sql).toMatch(/ORDER BY name/);
  });
});

describe('isolation: the tenant context is set automatically', () => {
  // La resolución del inquilino es UNA por proceso y se recuerda; sin
  // olvidarla entre pruebas, cada una heredaría la decisión de la anterior.
  beforeEach(() => {
    mockQuery.mockReset();
    mockEnterTenant.mockReset();
    olvidarInquilinoDeLaSesion();
  });

  it('resolveEntity enters the entity tenant context', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    await resolveEntity(ENTITY_ROW.id);
    // Without this, every later query would run unscoped and RLS would not filter.
    expect(mockEnterTenant).toHaveBeenCalledWith(ENTITY_ROW.tenant_id);
  });

  it('bootstrapTenant prefers the flag over the environment variable', () => {
    process.env.MNEMOSINE_TENANT = 'from-env';
    bootstrapTenant('from-flag');
    expect(mockEnterTenant).toHaveBeenCalledWith('from-flag');
    delete process.env.MNEMOSINE_TENANT;
  });

  it('bootstrapTenant uses the environment variable when there is no flag', () => {
    process.env.MNEMOSINE_TENANT = 'from-env';
    bootstrapTenant(undefined);
    expect(mockEnterTenant).toHaveBeenCalledWith('from-env');
    delete process.env.MNEMOSINE_TENANT;
  });

  it('with neither flag nor env it sets nothing: resolveEntity will do it', () => {
    delete process.env.MNEMOSINE_TENANT;
    bootstrapTenant(undefined);
    expect(mockEnterTenant).not.toHaveBeenCalled();
  });
});

// ============================================================
// LA FRONTERA DE INQUILINO, DEL LADO DE LA BIBLIOTECA
//
// Cada prueba de este bloque es una medición hecha sobre el binario antes de
// existir el arreglo. La de abajo es la que importa: `mnemosine entity list
// --tenant <ceros>` devolvía las TRES entidades del inquilino del .env,
// código 0 y sin un aviso. Se pidió el despacho B y salió la balanza del A.
// ============================================================
describe('el inquilino de la invocación', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockEnterTenant.mockReset();
    olvidarInquilinoDeLaSesion();
    delete process.env.MNEMOSINE_TENANT;
  });

  it('la ausencia de bandera NO degrada lo que la raíz decidió', () => {
    process.env.MNEMOSINE_TENANT = 'del-entorno';
    fijarInquilinoDeLaSesion('de-la-bandera');
    mockEnterTenant.mockReset();

    // Esto es LITERALMENTE lo que hacen las 81 hojas: `opts.tenant` vale
    // undefined porque la raíz se quedó con la forma larga. Antes esa llamada
    // era una orden de usar el entorno y PISABA la bandera.
    bootstrapTenant(undefined);

    expect(mockEnterTenant).toHaveBeenCalledWith('de-la-bandera');
    expect(mockEnterTenant).not.toHaveBeenCalledWith('del-entorno');
    expect(inquilinoDeLaSesion()).toMatchObject({
      tenantId: 'de-la-bandera',
      origen: 'bandera',
      entornoIgnorado: 'del-entorno',
    });
  });

  it('ochenta y una llamadas seguidas sin bandera siguen sin degradarlo', () => {
    process.env.MNEMOSINE_TENANT = 'del-entorno';
    fijarInquilinoDeLaSesion('de-la-bandera');
    mockEnterTenant.mockReset();
    for (let i = 0; i < 81; i++) bootstrapTenant(undefined);
    const entradas = mockEnterTenant.mock.calls as [string][];
    expect(new Set(entradas.map((c) => c[0]))).toEqual(new Set(['de-la-bandera']));
  });

  it('la precedencia publicada, entera: bandera > entorno > config', () => {
    process.env.MNEMOSINE_TENANT = 'del-entorno';
    expect(fijarInquilinoDeLaSesion('de-la-bandera', 'de-config')).toMatchObject({
      tenantId: 'de-la-bandera', origen: 'bandera',
    });
    olvidarInquilinoDeLaSesion();
    expect(fijarInquilinoDeLaSesion(undefined, 'de-config')).toMatchObject({
      tenantId: 'del-entorno', origen: 'entorno',
    });
    olvidarInquilinoDeLaSesion();
    delete process.env.MNEMOSINE_TENANT;
    expect(fijarInquilinoDeLaSesion(undefined, 'de-config')).toMatchObject({
      tenantId: 'de-config', origen: 'config',
    });
    olvidarInquilinoDeLaSesion();
    expect(fijarInquilinoDeLaSesion(undefined, undefined)).toEqual({ origen: 'ninguno' });
  });

  it('una hoja que SÍ recibe el valor (la forma corta -t) manda sobre la raíz', () => {
    fijarInquilinoDeLaSesion('de-la-raiz');
    mockEnterTenant.mockReset();
    bootstrapTenant('de-la-hoja');
    expect(mockEnterTenant).toHaveBeenCalledWith('de-la-hoja');
    expect(inquilinoDeLaSesion().tenantId).toBe('de-la-hoja');
  });

  it('una cadena vacía o de espacios no es un inquilino', () => {
    process.env.MNEMOSINE_TENANT = 'del-entorno';
    expect(fijarInquilinoDeLaSesion('   ')).toMatchObject({
      tenantId: 'del-entorno', origen: 'entorno',
    });
  });

  it('sin nada que fijar no se toca el contexto: resolveEntity lo pondrá', () => {
    fijarInquilinoDeLaSesion(undefined);
    mockEnterTenant.mockReset();
    bootstrapTenant(undefined);
    expect(mockEnterTenant).not.toHaveBeenCalled();
  });

  it('estadoDelInquilino distingue inexistente de inactivo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await estadoDelInquilino('t1')).toBe('inexistente');
    mockQuery.mockResolvedValueOnce({ rows: [{ is_active: false }] });
    expect(await estadoDelInquilino('t1')).toBe('inactivo');
    mockQuery.mockResolvedValueOnce({ rows: [{ is_active: true }] });
    expect(await estadoDelInquilino('t1')).toBe('activo');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM tenants WHERE id = \$1/);
    expect(params).toEqual(['t1']);
  });

  it('un despliegue que no deja leer `tenants` no acusa: se calla', async () => {
    // Fail-open A PROPÓSITO, y sólo aquí: negarle SELECT sobre `tenants` a
    // este rol no puede convertirse en «tu inquilino no existe». El
    // aislamiento lo sigue haciendo RLS; esto es el aviso, no la puerta.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' }));
    expect(await estadoDelInquilino('t1')).toBe('indeterminable');
    // Un motivo DESCONOCIDO sí se propaga. El ejemplar importa: aquí decía
    // `08006`, que es `connection_failure` —o sea, justo una de las familias
    // que TIENE que callarse (ver la prueba siguiente)—, así que afirmaba el
    // principio correcto con el caso equivocado. Se usa un error de sintaxis,
    // que es lo que de verdad nadie debe tragarse.
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42601' }));
    await expect(estadoDelInquilino('t1')).rejects.toThrow('boom');
  });

  it('una base INALCANZABLE tampoco acusa, ni cambia el desenlace de lo que observa', async () => {
    // Este chequeo corre en el gancho, antes de que la hoja valide sus propios
    // argumentos. Si dejara escapar el fallo de conexión, `usage --since 7w`
    // —un error de USO, que debe salir 2 sin tocar la base— saldría 1 por no
    // poder conectar. Un instrumento de aviso no puede cambiar el código de
    // salida de lo que está mirando.
    const boom = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    vi.mocked(query).mockRejectedValueOnce(boom);
    expect(await estadoDelInquilino('t1')).toBe('indeterminable');
    // Y un motivo DESCONOCIDO sí se propaga: tragárselo dejaría el aviso mudo
    // para siempre sin que nadie se entere.
    vi.mocked(query).mockRejectedValueOnce(new Error('syntax error at or near'));
    await expect(estadoDelInquilino('t1')).rejects.toThrow(/syntax error/);
  });
});
