import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import {
  construirCatalogoCuentas,
  generarCatalogoCuentas,
  estadoDelAgrupador,
  finDeMes,
  type CuentaParaCatalogo,
  type EntradaCatalogo,
} from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

// ============================================================
// F07b · EL CATÁLOGO DE CUENTAS
// ============================================================

const cuenta = (p: Partial<CuentaParaCatalogo> & { code: string }): CuentaParaCatalogo => ({
  name: p.name ?? `Cuenta ${p.code}`,
  account_level: p.account_level ?? 1,
  parent_code: p.parent_code ?? null,
  // `in` y no `??`: el caso interesante es justamente el null explícito —la
  // cuenta SIN agrupador—, y `?? '100'` se lo tragaba y le ponía uno.
  codigo_agrupador_sat: 'codigo_agrupador_sat' in p ? (p.codigo_agrupador_sat ?? null) : '100',
  normal_balance: p.normal_balance ?? 'debit',
  account_type: p.account_type ?? 'asset',
  lineas_posteadas: p.lineas_posteadas ?? 0,
  naturaleza_agrupador: p.naturaleza_agrupador ?? null,
  estado_agrupador: p.estado_agrupador ?? 'valido',
  code: p.code,
});

const entrada = (
  cuentas: CuentaParaCatalogo[],
  politicas?: Partial<EntradaCatalogo['politicas']>
): EntradaCatalogo => ({
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: 1,
  cuentas,
  politicas: {
    niveles: politicas?.niveles ?? 'jerarquia_completa',
    sinAgrupador: politicas?.sinAgrupador ?? 'bloquear',
    sellado: politicas?.sellado ?? 'nunca_sellar_en_el_sistema',
  },
});

/** El caso pequeño que se fija carácter a carácter. */
const TRES_CUENTAS = [
  cuenta({ code: '100', name: 'Activo', account_level: 1, codigo_agrupador_sat: '100' }),
  cuenta({
    // La descripción llega con un salto y espacios repetidos, como llega de
    // un pegado desde Excel: el constructor RECHAZA el salto, así que el
    // generador lo limpia y lo denuncia.
    code: '100-01',
    name: 'Caja \n y  efectivo',
    account_level: 2,
    parent_code: '100',
    codigo_agrupador_sat: '101.01',
    lineas_posteadas: 3,
  }),
  cuenta({
    code: '200',
    name: 'Proveedores & Cía',
    account_level: 1,
    codigo_agrupador_sat: '201',
    normal_balance: 'credit',
    account_type: 'liability',
    lineas_posteadas: 1,
  }),
];

const XML_ESPERADO =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas"' +
  ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
  ' xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas' +
  ' http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd"' +
  ' Version="1.3" RFC="AAA010101AAA" Mes="01" Anio="2026">\n' +
  '  <catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="Activo" Nivel="1" Natur="D"/>\n' +
  '  <catalogocuentas:Ctas CodAgrup="101.01" NumCta="100-01" Desc="Caja y efectivo" SubCtaDe="100" Nivel="2" Natur="D"/>\n' +
  '  <catalogocuentas:Ctas CodAgrup="201" NumCta="200" Desc="Proveedores &amp; Cía" Nivel="1" Natur="A"/>\n' +
  '</catalogocuentas:Catalogo>\n';

describe('CtaCatalogo 1.3', () => {
  describe('el XML, carácter a carácter', () => {
    it('sale exactamente así', () => {
      const r = construirCatalogoCuentas(entrada(TRES_CUENTAS));
      expect(r.xml).toBe(XML_ESPERADO);
    });

    it('el hash es el SHA-256 de esos bytes UTF-8 y no de otra cosa', () => {
      const r = construirCatalogoCuentas(entrada(TRES_CUENTAS));
      expect(r.hash).toBe(createHash('sha256').update(Buffer.from(XML_ESPERADO, 'utf8')).digest('hex'));
      expect(r.bytes).toBe(Buffer.byteLength(XML_ESPERADO, 'utf8'));
    });

    it('bytes idénticos para entradas idénticas, y el orden NO depende de la intercalación de la base', () => {
      // Se ordena en la función pura y no con ORDER BY: con lc_collate en
      // es_MX.UTF-8 y en C, el mismo catálogo saldría en orden distinto y los
      // «bytes idénticos» dependerían de cómo se instaló el servidor.
      const alReves = [...TRES_CUENTAS].reverse();
      expect(construirCatalogoCuentas(entrada(alReves)).xml).toBe(XML_ESPERADO);
    });

    it('denuncia la descripción que tuvo que limpiar en vez de cambiarla en silencio', () => {
      const r = construirCatalogoCuentas(entrada(TRES_CUENTAS));
      const aviso = r.hallazgos.find((h) => h.regla === 'CAT-DESC-NORMALIZADA');
      expect(aviso?.numCta).toBe('100-01');
      expect(aviso?.severidad).toBe('aviso');
    });
  });

  describe('la e.firma: se construye y se para ahí', () => {
    it('con el defecto, el archivo sale SIN SELLAR y el resultado lo dice', () => {
      const r = construirCatalogoCuentas(entrada(TRES_CUENTAS));
      expect(r.sellado).toBe(false);
      expect(r.notaDeSellado).toContain('SIN SELLAR');
      expect(r.xml).not.toContain('Sello');
      expect(r.xml).not.toContain('Certificado');
    });

    it('aunque el despacho haya declarado sellar con custodia, generate NO sella', () => {
      // Construir el archivo y firmarlo son actos distintos y de manos
      // distintas. Sellar vive en `catalog file`, y no está construido.
      const r = construirCatalogoCuentas(entrada(TRES_CUENTAS, { sellado: 'sellar_con_custodia' }));
      expect(r.sellado).toBe(false);
      expect(r.notaDeSellado).toContain('NO SELLA');
      expect(r.xml).not.toContain('Sello');
    });
  });

  describe('anexo24_cuenta_sin_agrupador', () => {
    const conHueco = [
      cuenta({ code: '100', name: 'Activo', codigo_agrupador_sat: null, estado_agrupador: 'sin_agrupador' }),
      cuenta({ code: '100-01', name: 'Caja', account_level: 2, parent_code: '100', codigo_agrupador_sat: '101.01' }),
    ];

    it('con el defecto `bloquear`, se niega a generar y NOMBRA las cuentas', () => {
      const r = construirCatalogoCuentas(entrada(conHueco, { sinAgrupador: 'bloquear' }));
      expect(r.xml).toBeNull();
      expect(r.puedeEntregarse).toBe(false);
      const bloqueo = r.hallazgos.find((h) => h.regla === 'CAT-SIN-AGRUPADOR-BLOQUEA');
      expect(bloqueo?.severidad).toBe('bloquea');
      expect(bloqueo?.mensaje).toContain('100 Activo');
      expect(r.sinAgrupador).toEqual([{ code: '100', name: 'Activo' }]);
    });

    it('con `omitir_y_avisar` las deja fuera, y si eso rompe la jerarquía el archivo NO se puede entregar', () => {
      // Ésta es la consecuencia honesta de la opción: omitir al padre deja al
      // hijo declarando Nivel 2 sin un SubCtaDe que resuelva dentro del
      // archivo. No se inventa un padre ni se degrada el nivel en silencio:
      // se genera, y la regla de coherencia dice exactamente qué se rompió.
      const r = construirCatalogoCuentas(entrada(conHueco, { sinAgrupador: 'omitir_y_avisar' }));
      expect(r.xml).not.toBeNull();
      expect(r.omitidas).toContainEqual({ code: '100', name: 'Activo', motivo: 'sin_agrupador' });
      expect(r.hallazgos.some((h) => h.regla === 'CAT-SIN-AGRUPADOR-OMITIDAS')).toBe(true);
      const huerfana = r.hallazgos.find((h) => h.regla === 'CAT-HUERFANA');
      expect(huerfana?.numCta).toBe('100-01');
      expect(r.puedeEntregarse).toBe(false);
    });
  });

  describe('anexo24_niveles_a_presentar', () => {
    const arbol = [
      cuenta({ code: '100', account_level: 1 }),
      cuenta({ code: '100-01', account_level: 2, parent_code: '100' }),
      cuenta({ code: '100-01-001', account_level: 3, parent_code: '100-01', lineas_posteadas: 5 }),
      cuenta({ code: '900', account_level: 1 }),
    ];

    it('`jerarquia_completa` (el defecto) mete el árbol entero', () => {
      const r = construirCatalogoCuentas(entrada(arbol));
      expect(r.filas.map((f) => f.NumCta)).toEqual(['100', '100-01', '100-01-001', '900']);
      expect(r.puedeEntregarse).toBe(true);
    });

    it('`hasta_nivel_2` recorta el tercer nivel y lo apunta como omitido', () => {
      const r = construirCatalogoCuentas(entrada(arbol, { niveles: 'hasta_nivel_2' }));
      expect(r.filas.map((f) => f.NumCta)).toEqual(['100', '100-01', '900']);
      expect(r.omitidas).toContainEqual({
        code: '100-01-001',
        name: 'Cuenta 100-01-001',
        motivo: 'fuera_del_alcance_de_niveles',
      });
    });

    it('`las_que_se_mueven` arrastra la cadena ENTERA de padres, no un salto', () => {
      // Sin los dos ascendientes, el SubCtaDe del nivel 3 apuntaría a una
      // cuenta que el archivo no declara.
      const r = construirCatalogoCuentas(entrada(arbol, { niveles: 'las_que_se_mueven' }));
      expect(r.filas.map((f) => f.NumCta)).toEqual(['100', '100-01', '100-01-001']);
      expect(r.filas.find((f) => f.NumCta === '100-01-001')?.SubCtaDe).toBe('100-01');
      expect(r.puedeEntregarse).toBe(true);
    });

    it('un valor de política desconocido se comporta como el defecto y no recorta el archivo', () => {
      const r = construirCatalogoCuentas(entrada(arbol, { niveles: 'algo_que_nadie_escribió' }));
      expect(r.filas).toHaveLength(4);
    });
  });

  describe('la naturaleza', () => {
    it('sale de lo que el esquema ya sabe de la cuenta: debit → D, credit → A', () => {
      const r = construirCatalogoCuentas(
        entrada([
          cuenta({ code: '100', normal_balance: 'debit' }),
          cuenta({ code: '200', normal_balance: 'credit', account_type: 'liability' }),
        ])
      );
      expect(r.filas.map((f) => f.Natur)).toEqual(['D', 'A']);
    });

    it('BLOQUEA cuando contradice la naturaleza que el catálogo del SAT espera del agrupador', () => {
      // Pasa el XSD y lo rechaza la validación de fondo: el peor sitio donde
      // enterarse. Hoy no puede saltar contra el catálogo sembrado porque
      // F07a dejó `naturaleza` en NULL en las 1060 filas —la tabla que el SAT
      // publica no la trae—, así que se inyecta aquí para fijar la conducta.
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', normal_balance: 'debit', naturaleza_agrupador: 'A' })])
      );
      const h = r.hallazgos.find((x) => x.regla === 'CAT-NATUR-CONTRA-AGRUPADOR');
      expect(h?.severidad).toBe('bloquea');
      expect(h?.numCta).toBe('100');
      expect(r.puedeEntregarse).toBe(false);
    });

    it('no dice nada cuando el agrupador SÍ trae naturaleza y coincide', () => {
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', normal_balance: 'debit', naturaleza_agrupador: 'D' })])
      );
      expect(r.hallazgos.some((h) => h.regla === 'CAT-NATUR-CONTRA-AGRUPADOR')).toBe(false);
    });

    it('avisa cuando el tipo de cuenta implica la naturaleza contraria', () => {
      // Ésta sí tiene datos hoy: `contra_asset` con saldo normal deudor.
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '119', account_type: 'contra_asset', normal_balance: 'debit' })])
      );
      const h = r.hallazgos.find((x) => x.regla === 'CAT-NATUR-CONTRA-TIPO');
      expect(h?.severidad).toBe('aviso');
      expect(r.filas[0].Natur).toBe('D');
      expect(r.puedeEntregarse).toBe(true);
    });
  });

  describe('el agrupador contra el c_CodAgrup', () => {
    it('BLOQUEA el agrupador que no está en el catálogo vigente', () => {
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', codigo_agrupador_sat: '999.99', estado_agrupador: 'fuera_de_catalogo' })])
      );
      expect(r.hallazgos.find((h) => h.regla === 'CAT-AGRUPADOR-FUERA-DE-CATALOGO')?.severidad).toBe('bloquea');
    });

    it('sólo AVISA cuando no hay catálogo sembrado, y nombra la causa real', () => {
      // Mismo criterio que F07a: rechazar contra un catálogo ausente es
      // inventarse una respuesta, y además con el mensaje equivocado.
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', codigo_agrupador_sat: '100', estado_agrupador: 'sin_catalogo' })])
      );
      const h = r.hallazgos.find((x) => x.regla === 'CAT-AGRUPADOR-SIN-CATALOGO');
      expect(h?.severidad).toBe('aviso');
      expect(h?.mensaje).toContain('no hay');
      expect(r.puedeEntregarse).toBe(true);
    });

    it('estadoDelAgrupador separa «sin código» de «sin catálogo»', () => {
      expect(estadoDelAgrupador(null, false, true)).toBe('sin_agrupador');
      expect(estadoDelAgrupador('  ', false, true)).toBe('sin_agrupador');
      expect(estadoDelAgrupador('100', false, false)).toBe('sin_catalogo');
      expect(estadoDelAgrupador('100', false, true)).toBe('fuera_de_catalogo');
      expect(estadoDelAgrupador('100', true, true)).toBe('valido');
    });
  });

  describe('las reglas de coherencia', () => {
    it('caza el NumCta duplicado, que hace ambigua toda referencia posterior', () => {
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', name: 'Uno' }), cuenta({ code: '100', name: 'Otro' })])
      );
      expect(r.hallazgos.find((h) => h.regla === 'CAT-NUMCTA-DUPLICADO')?.severidad).toBe('bloquea');
    });

    it('caza el nivel que no encaja con el del padre', () => {
      const r = construirCatalogoCuentas(
        entrada([
          cuenta({ code: '100', account_level: 1 }),
          cuenta({ code: '100-01', account_level: 3, parent_code: '100' }),
        ])
      );
      expect(r.hallazgos.find((h) => h.regla === 'CAT-NIVEL-DEL-PADRE')?.severidad).toBe('bloquea');
    });

    it('caza el RFC que no es un RFC', () => {
      const e = { ...entrada([cuenta({ code: '100' })]), rfc: 'NO-SOY-UN-RFC' };
      expect(construirCatalogoCuentas(e).hallazgos.find((h) => h.regla === 'CAT-RFC')?.severidad).toBe('bloquea');
    });

    it('un catálogo sin ni una cuenta bloquea, en vez de salir vacío con cara de correcto', () => {
      const r = construirCatalogoCuentas(entrada([]));
      expect(r.hallazgos.find((h) => h.regla === 'CAT-VACIO')?.severidad).toBe('bloquea');
      expect(r.puedeEntregarse).toBe(false);
    });

    it('las facetas que no se pudieron verificar contra el XSD real salen como AVISO, nunca bloquean', () => {
      const r = construirCatalogoCuentas(
        entrada([cuenta({ code: '100', name: 'x'.repeat(300), codigo_agrupador_sat: 'RARO' })])
      );
      const conjeturas = r.hallazgos.filter((h) => h.procedencia === 'faceta_no_verificada');
      expect(conjeturas.length).toBeGreaterThan(0);
      expect(conjeturas.every((h) => h.severidad === 'aviso')).toBe(true);
      expect(r.puedeEntregarse).toBe(true);
    });
  });

  describe('finDeMes', () => {
    it('da el último día real del mes, incluido febrero bisiesto', () => {
      expect(finDeMes(2026, 1)).toBe('2026-01-31');
      expect(finDeMes(2026, 2)).toBe('2026-02-28');
      expect(finDeMes(2024, 2)).toBe('2024-02-29');
      expect(finDeMes(2026, 12)).toBe('2026-12-31');
    });
  });
});

describe('generarCatalogoCuentas (la envoltura de E/S)', () => {
  const ctx = { tenantId: 'inq-1', entityId: 'ent-1' };
  const opts = { entityId: 'ent-1', anio: 2026, mes: 1, userId: 'usr-1' };

  const politicaPorOmision = (key: string): { key: string; value: string; defined: boolean } => ({
    key,
    value:
      key === 'anexo24_niveles_a_presentar'
        ? 'jerarquia_completa'
        : key === 'anexo24_cuenta_sin_agrupador'
          ? 'bloquear'
          : 'nunca_sellar_en_el_sistema',
    defined: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPolicy.mockImplementation((_c: unknown, key: string) => Promise.resolve(politicaPorOmision(key)));
  });

  const filaCuenta = {
    code: '100',
    name: 'Activo',
    account_level: 1,
    parent_code: null,
    codigo_agrupador_sat: '100',
    normal_balance: 'debit',
    account_type: 'asset',
    lineas_posteadas: 2,
    naturaleza_agrupador: null,
    agrupador_en_catalogo: true,
  };

  it('lee las TRES políticas con su clave literal', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [filaCuenta] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'art-1', generado_en: '2026-02-01T00:00:00Z' }] });

    await generarCatalogoCuentas(ctx, opts);

    const claves = mockGetPolicy.mock.calls.map((c) => c[1] as string);
    expect(claves).toContain('anexo24_niveles_a_presentar');
    expect(claves).toContain('anexo24_cuenta_sin_agrupador');
    expect(claves).toContain('efirma_sellado_contabilidad_electronica');
  });

  it('acota la entidad DENTRO del SQL, con el inquilino en el WHERE', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [filaCuenta] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'art-1', generado_en: '2026-02-01T00:00:00Z' }] });

    await generarCatalogoCuentas(ctx, opts);

    const [sqlEntidad, paramsEntidad] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sqlEntidad).toContain('tenant_id = $2');
    expect(paramsEntidad).toEqual(['ent-1', 'inq-1']);

    const [sqlCuentas, paramsCuentas] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sqlCuentas).toContain('a.entity_id = $1');
    expect(sqlCuentas).toContain('je.entity_id = $1');
    expect(sqlCuentas).toContain('p.entity_id = $1');
    expect(paramsCuentas).toEqual(['ent-1', '2026-01-31']);
  });

  it('archiva el artefacto con sellado=false y la política que regía al generar', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [filaCuenta] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'art-1', generado_en: '2026-02-01T00:00:00Z' }] });

    const r = await generarCatalogoCuentas(ctx, opts);

    expect(r.artefacto?.id).toBe('art-1');
    expect(r.artefacto?.yaExistia).toBe(false);
    const [sqlInsert, paramsInsert] = mockQuery.mock.calls[3] as [string, unknown[]];
    expect(sqlInsert).toContain('INSERT INTO sat_anexo24_artefactos');
    expect(sqlInsert).toContain('false');
    expect(paramsInsert).toContain('nunca_sellar_en_el_sistema');
    expect(paramsInsert[9]).toBe(r.hash);
  });

  it('con --dry-run construye y NO escribe', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [filaCuenta] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] });

    const r = await generarCatalogoCuentas(ctx, { ...opts, dryRun: true });

    expect(r.xml).not.toBeNull();
    expect(r.artefacto).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('NO archiva cuando hay un hallazgo que bloquea', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [{ ...filaCuenta, codigo_agrupador_sat: null }] })
      .mockResolvedValueOnce({ rows: [{ hay: true }] });

    const r = await generarCatalogoCuentas(ctx, opts);

    expect(r.puedeEntregarse).toBe(false);
    expect(r.xml).toBeNull();
    expect(r.artefacto).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('rehúsa una entidad que no está identificada con RFC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tax_id: '12-3456789', tax_id_type: 'ein', name: 'Acme Inc' }] });
    await expect(generarCatalogoCuentas(ctx, opts)).rejects.toThrow(/RFC/);
  });

  it('rehúsa una entidad que no es de este inquilino', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(generarCatalogoCuentas(ctx, opts)).rejects.toThrow(ValidationError);
  });

  it('rehúsa el mes 13, que es de la balanza de cierre y no del catálogo', async () => {
    await expect(generarCatalogoCuentas(ctx, { ...opts, mes: 13 })).rejects.toThrow(/13/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rehúsa un ejercicio imposible con un mensaje, no con una violación de restricción en crudo', async () => {
    // Sin esta puerta, el año saldría del validador como simple AVISO —el
    // límite superior no se pudo verificar contra el XSD— y reventaría al
    // archivar contra el CHECK de la migración 062.
    await expect(generarCatalogoCuentas(ctx, { ...opts, anio: 20226 })).rejects.toThrow(/2015/);
    await expect(generarCatalogoCuentas(ctx, { ...opts, anio: 2014 })).rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
