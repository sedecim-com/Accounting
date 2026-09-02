import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(() => 'tenant-1'),
}));

import { withTransaction } from '../../../src/database/connection.js';
import {
  CATALOGO_LISR,
  crearActivo,
  inicioDeDepreciacion,
  montosDelAlta,
  sembrarCategoriasDeActivo,
  vidaUtilCoherente,
  type DatosDeAlta,
} from '../../../src/services/assets/asset-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/utils/errors.js';
import { clienteFalso, type ReglaConsulta } from '../../helpers/fake-pg.js';

const mockTx = withTransaction as unknown as Mock;

const ENTIDAD = 'e0000000-0000-0000-0000-000000000001';
const AJENA = 'e0000000-0000-0000-0000-000000000002';
const CATEGORIA = 'c0000000-0000-0000-0000-000000000001';
const CUENTA_ACTIVO = 'a0000000-0000-0000-0000-00000000121a';
const CUENTA_ACUMULADA = 'a0000000-0000-0000-0000-00000000129a';
const CUENTA_GASTO = 'a0000000-0000-0000-0000-00000000614a';
const USUARIO = 'u0000000-0000-0000-0000-000000000001';

const categoriaBase = (over: Record<string, unknown> = {}) => ({
  id: CATEGORIA,
  name: 'Equipo de Cómputo',
  is_active: true,
  default_useful_life_years: 4,
  default_depreciation_method: 'straight_line',
  default_asset_account_id: CUENTA_ACTIVO,
  default_depreciation_account_id: CUENTA_ACUMULADA,
  default_expense_account_id: CUENTA_GASTO,
  ...over,
});

const altaMinima = (over: Partial<DatosDeAlta> = {}): DatosDeAlta => ({
  asset_name: 'Laptop de dirección',
  category_id: CATEGORIA,
  acquisition_date: '2026-03-20',
  acquisition_cost: '33333.3333',
  contabilizacion: 'ya_contabilizado',
  ...over,
});

/**
 * El arnés del alta. Ante SQL no previsto LANZA (fake-pg), así que cada regla
 * que aparece aquí es una consulta que `crearActivo` TIENE que hacer: si un
 * día dejara de acotar por entidad, la regla dejaría de casar y la prueba
 * moriría en vez de pasar en verde.
 */
function arnesDeAlta(opciones: {
  categoria?: Record<string, unknown> | null;
  cuentas?: string[];
  politicas?: Record<string, string>;
  vendors?: Record<string, unknown>[];
  fallaInsert?: { code: string };
} = {}) {
  const categoria = opciones.categoria === undefined ? categoriaBase() : opciones.categoria;
  const cuentas = opciones.cuentas ?? [CUENTA_ACTIVO, CUENTA_ACUMULADA, CUENTA_GASTO];
  const politicas = opciones.politicas ?? {};

  const reglas: ReglaConsulta[] = [
    {
      cuando: /FROM asset_categories WHERE id = \$1 AND entity_id = \$2/,
      responde: { rows: categoria === null ? [] : [categoria] },
    },
    {
      cuando: /FROM policy_decisions/,
      responde: (_sql, params) => {
        const clave = String(params[1]);
        const valor = politicas[clave];
        if (valor === undefined) return { rows: [] };
        return {
          rows: [
            {
              key: clave,
              status: 'resolved',
              resolved_value: valor,
              question: 'q',
              resolution_notes: null,
              default_value: null,
              default_rationale: null,
            },
          ],
        };
      },
    },
    {
      cuando: /FROM accounts WHERE entity_id = \$1 AND is_header = false AND id = ANY/,
      responde: { rows: cuentas.map((id) => ({ id })) },
    },
    {
      cuando: /FROM vendors WHERE id = \$1 AND entity_id = \$2/,
      responde: { rows: opciones.vendors ?? [] },
    },
    { cuando: /INSERT INTO entity_sequences/, responde: { rows: [{ value: '7' }] } },
    {
      cuando: /INSERT INTO fixed_assets/,
      responde: () => {
        if (opciones.fallaInsert) throw Object.assign(new Error('duplicado'), opciones.fallaInsert);
        return { rows: [{ id: 'af-1', asset_number: 'AF-2026-00007' }] };
      },
    },
    { cuando: /INSERT INTO audit_log/, responde: { rowCount: 1 } },
  ];

  const f = clienteFalso(reglas);
  mockTx.mockImplementation((fn: (c: unknown) => unknown) => Promise.resolve(fn(f.client)));
  return f;
}

/** Los parámetros del INSERT de la ficha, por posición. */
const paramsDelAlta = (f: ReturnType<typeof clienteFalso>): unknown[] =>
  f.consultas.find((c) => /INSERT INTO fixed_assets/.test(c.sql))?.params ?? [];

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
describe('vidaUtilCoherente', () => {
  it('con sólo los años, los meses son los años por doce', () => {
    expect(vidaUtilCoherente(10, undefined, null)).toEqual({ anios: 10, meses: 120 });
  });

  it('con sólo los meses, los años son el TECHO: los 40 meses del 30% son 4 años', () => {
    expect(vidaUtilCoherente(undefined, 40, null)).toEqual({ anios: 4, meses: 40 });
  });

  it('acepta el par que casa aunque los meses no sean múltiplo de doce', () => {
    expect(vidaUtilCoherente(4, 40, null)).toEqual({ anios: 4, meses: 40 });
  });

  it('rechaza el par que no casa: 40 meses no son 3 años', () => {
    expect(() => vidaUtilCoherente(3, 40, null)).toThrow(ValidationError);
    expect(() => vidaUtilCoherente(3, 40, null)).toThrow(/40 meses caben en 4 año/);
  });

  it('rechaza el par que miente en el otro sentido: 12 meses no son 5 años', () => {
    expect(() => vidaUtilCoherente(5, 12, null)).toThrow(ValidationError);
  });

  it('sin años ni meses, toma la vida por omisión de la categoría', () => {
    expect(vidaUtilCoherente(undefined, undefined, 20)).toEqual({ anios: 20, meses: 240 });
  });

  it('sin años, sin meses y sin defecto de categoría, exige que alguien lo diga', () => {
    expect(() => vidaUtilCoherente(undefined, undefined, null)).toThrow(
      /Ni el alta ni la categoría dicen cuánto dura/
    );
  });

  it('rechaza una vida de cero meses', () => {
    expect(() => vidaUtilCoherente(undefined, 0, null)).toThrow(ValidationError);
  });

  it('rechaza una vida fraccionaria en años', () => {
    expect(() => vidaUtilCoherente(3.5, undefined, null)).toThrow(ValidationError);
  });
});

// ============================================================
describe('montosDelAlta', () => {
  it('conserva los CUATRO decimales de la columna, no dos', () => {
    expect(montosDelAlta('33333.3333', undefined)).toEqual({
      costo: '33333.3333',
      salvamento: '0.0000',
    });
  });

  it('rechaza el costo cero', () => {
    expect(() => montosDelAlta('0', undefined)).toThrow(/mayor que cero/);
  });

  it('rechaza el costo negativo', () => {
    expect(() => montosDelAlta('-1500', undefined)).toThrow(ValidationError);
  });

  it('rechaza el costo que no es número, en vez de dejarlo llegar al INSERT', () => {
    expect(() => montosDelAlta('mil quinientos', undefined)).toThrow(/no es un número/);
  });

  it('rechaza el salvamento negativo', () => {
    expect(() => montosDelAlta('1000', '-1')).toThrow(/no puede ser negativo/);
  });

  it('rechaza el salvamento que supera el costo', () => {
    expect(() => montosDelAlta('1000', '1200')).toThrow(/no puede alcanzar ni superar el costo/);
  });

  it('rechaza el salvamento IGUAL al costo: el CHECK del esquema es estricto', () => {
    expect(() => montosDelAlta('1000', '1000')).toThrow(ValidationError);
  });

  it('acepta el salvamento por debajo del costo y lo normaliza a cuatro decimales', () => {
    expect(montosDelAlta('1000', '250.5')).toEqual({ costo: '1000.0000', salvamento: '250.5000' });
  });
});

// ============================================================
describe('inicioDeDepreciacion', () => {
  it('con mes completo arranca el día 1 del mes de la compra', () => {
    expect(inicioDeDepreciacion('2026-03-20', 'mes_completo')).toBe('2026-03-01');
  });

  it('con proporcional por días arranca el día de la compra', () => {
    expect(inicioDeDepreciacion('2026-03-20', 'proporcional_dias')).toBe('2026-03-20');
  });
});

// ============================================================
describe('crearActivo · la frontera de entidad', () => {
  it('busca la categoría acotada por entity_id DENTRO del SQL', async () => {
    const f = arnesDeAlta();
    await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    const consulta = f.consultas.find((c) => /FROM asset_categories/.test(c.sql));
    expect(consulta?.sql).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
    expect(consulta?.params).toEqual([CATEGORIA, ENTIDAD]);
  });

  it('la categoría de otra entidad es indistinguible de la que no existe', async () => {
    arnesDeAlta({ categoria: null });
    await expect(crearActivo(AJENA, altaMinima(), USUARIO)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('comprueba las tres cuentas contra el catálogo de la entidad, en el SQL', async () => {
    const f = arnesDeAlta();
    await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    const consulta = f.consultas.find((c) => /FROM accounts/.test(c.sql));
    expect(consulta?.sql).toMatch(/entity_id = \$1 AND is_header = false/);
    expect(consulta?.params[0]).toBe(ENTIDAD);
  });

  it('rechaza la cuenta que no está en el catálogo de la entidad, nombrando el campo', async () => {
    // El catálogo devuelve sólo dos de las tres: la de gasto es ajena.
    arnesDeAlta({ cuentas: [CUENTA_ACTIVO, CUENTA_ACUMULADA] });
    await expect(crearActivo(ENTIDAD, altaMinima(), USUARIO)).rejects.toThrow(
      /depreciation_expense_account_id/
    );
  });

  it('rechaza el proveedor de otra entidad', async () => {
    arnesDeAlta({ vendors: [] });
    await expect(
      crearActivo(ENTIDAD, altaMinima({ vendor_id: 'v0000000-0000-0000-0000-000000000001' }), USUARIO)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ============================================================
describe('crearActivo · lo que valida que el esquema no puede', () => {
  it('rechaza la categoría dada de baja', async () => {
    arnesDeAlta({ categoria: categoriaBase({ is_active: false }) });
    await expect(crearActivo(ENTIDAD, altaMinima(), USUARIO)).rejects.toThrow(/está dada de baja/);
  });

  it('rechaza el nombre vacío', async () => {
    arnesDeAlta();
    await expect(crearActivo(ENTIDAD, altaMinima({ asset_name: '   ' }), USUARIO)).rejects.toThrow(
      /necesita nombre/
    );
  });

  it('rechaza la fecha que no viene como YYYY-MM-DD', async () => {
    arnesDeAlta();
    await expect(
      crearActivo(ENTIDAD, altaMinima({ acquisition_date: '20/03/2026' }), USUARIO)
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('rechaza el arranque EXPLÍCITO anterior a la adquisición', async () => {
    arnesDeAlta();
    await expect(
      crearActivo(ENTIDAD, altaMinima({ depreciation_start_date: '2026-02-01' }), USUARIO)
    ).rejects.toThrow(/antes de la adquisición/);
  });

  it('acepta el arranque explícito posterior a la adquisición', async () => {
    const f = arnesDeAlta();
    const r = await crearActivo(
      ENTIDAD,
      altaMinima({ depreciation_start_date: '2026-04-01' }),
      USUARIO
    );
    expect(r.depreciation_start_date).toBe('2026-04-01');
    expect(paramsDelAlta(f)[14]).toBe('2026-04-01');
  });

  it('exige la cuenta que ni el alta ni la categoría traen', async () => {
    arnesDeAlta({ categoria: categoriaBase({ default_asset_account_id: null }) });
    await expect(crearActivo(ENTIDAD, altaMinima(), USUARIO)).rejects.toThrow(
      /Faltan cuentas para el activo \(asset_account_id\)/
    );
  });

  it('traduce el choque de folio duplicado a un conflicto legible', async () => {
    arnesDeAlta({ fallaInsert: { code: '23505' } });
    await expect(
      crearActivo(ENTIDAD, altaMinima({ asset_number: 'AF-2026-00007' }), USUARIO)
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ============================================================
describe('crearActivo · lo que escribe', () => {
  it('el valor en libros arranca en el costo y la acumulada en cero', async () => {
    const f = arnesDeAlta();
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.current_book_value).toBe('33333.3333');
    // $7 costo y $16 valor en libros son el mismo importe, con los cuatro
    // decimales intactos.
    expect(paramsDelAlta(f)[6]).toBe('33333.3333');
    expect(paramsDelAlta(f)[15]).toBe('33333.3333');
    expect(f.consultas.find((c) => /INSERT INTO fixed_assets/.test(c.sql))?.sql).toMatch(
      /accumulated_depreciation/
    );
  });

  it('deja rastro de auditoría en la MISMA transacción que la ficha', async () => {
    const f = arnesDeAlta();
    await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(f.coincidencias(/INSERT INTO audit_log/)).toHaveLength(1);
  });

  it('NO postea: el alta no toca el mayor por ninguno de los dos caminos', async () => {
    const f = arnesDeAlta();
    await crearActivo(ENTIDAD, altaMinima({ contabilizacion: 'sin_contabilizar' }), USUARIO);
    expect(f.coincidencias(/INSERT INTO journal_entries/)).toHaveLength(0);
    expect(f.coincidencias(/INSERT INTO journal_entry_lines/)).toHaveLength(0);
  });

  it('avisa del cargo que falta cuando el costo NO está en el mayor', async () => {
    arnesDeAlta();
    const r = await crearActivo(
      ENTIDAD,
      altaMinima({ contabilizacion: 'sin_contabilizar' }),
      USUARIO
    );
    expect(r.avisos.some((a) => /NO está en el mayor/.test(a))).toBe(true);
  });

  it('no avisa de cargo faltante cuando el CFDI ya capitalizó el importe', async () => {
    arnesDeAlta();
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.avisos.some((a) => /NO está en el mayor/.test(a))).toBe(false);
  });
});

// ============================================================
describe('crearActivo · los dos criterios que se leen del panel', () => {
  it('con base_depreciacion sin contestar rige el método CONTABLE', async () => {
    const f = arnesDeAlta();
    const r = await crearActivo(
      ENTIDAD,
      altaMinima({
        book_depreciation_method: 'declining_balance_200' as DatosDeAlta['book_depreciation_method'],
        tax_depreciation_method: 'straight_line' as DatosDeAlta['tax_depreciation_method'],
      }),
      USUARIO
    );
    expect(r.depreciation_method).toBe('declining_balance_200');
    // $12 es la columna que lee el motor; $13 y $14 conservan los dos.
    expect(paramsDelAlta(f)[11]).toBe('declining_balance_200');
    expect(paramsDelAlta(f)[12]).toBe('declining_balance_200');
    expect(paramsDelAlta(f)[13]).toBe('straight_line');
  });

  it('con base_depreciacion = tasa_lisr rige el método FISCAL', async () => {
    const f = arnesDeAlta({ politicas: { base_depreciacion: 'tasa_lisr' } });
    const r = await crearActivo(
      ENTIDAD,
      altaMinima({
        book_depreciation_method: 'declining_balance_200' as DatosDeAlta['book_depreciation_method'],
        tax_depreciation_method: 'straight_line' as DatosDeAlta['tax_depreciation_method'],
      }),
      USUARIO
    );
    expect(r.depreciation_method).toBe('straight_line');
    expect(paramsDelAlta(f)[11]).toBe('straight_line');
  });

  it('lee las dos políticas DENTRO de la transacción del alta', async () => {
    const f = arnesDeAlta();
    await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    const claves = f.coincidencias(/FROM policy_decisions/).map((c) => c.params[1]);
    expect(claves).toContain('base_depreciacion');
    expect(claves).toContain('convencion_primer_mes');
  });

  it('con la convención por omisión el arranque se normaliza al día 1 del mes', async () => {
    arnesDeAlta();
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.politicas.convencion_primer_mes).toBe('mes_completo');
    expect(r.depreciation_start_date).toBe('2026-03-01');
  });

  it('con proporcional_dias el arranque es el día de la compra', async () => {
    arnesDeAlta({ politicas: { convencion_primer_mes: 'proporcional_dias' } });
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.depreciation_start_date).toBe('2026-03-20');
  });

  it('dice cuándo el criterio es un defecto y no una elección del despacho', async () => {
    arnesDeAlta();
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.avisos.some((a) => /base_depreciacion/.test(a))).toBe(true);
  });

  it('calla cuando el despacho ya contestó', async () => {
    arnesDeAlta({
      politicas: { base_depreciacion: 'tasa_lisr', convencion_primer_mes: 'mes_completo' },
    });
    const r = await crearActivo(ENTIDAD, altaMinima(), USUARIO);
    expect(r.avisos).toEqual([]);
  });
});

// ============================================================
describe('sembrarCategoriasDeActivo', () => {
  function arnesDeSiembra(existentes: string[], codigos: string[]) {
    const f = clienteFalso([
      {
        cuando: /SELECT name FROM asset_categories WHERE entity_id = \$1/,
        responde: { rows: existentes.map((name) => ({ name })) },
      },
      {
        cuando: /FROM accounts WHERE entity_id = \$1 AND is_header = false AND code = ANY/,
        responde: { rows: codigos.map((code) => ({ code, id: `id-${code}` })) },
      },
      { cuando: /INSERT INTO asset_categories/, responde: { rowCount: 1 } },
    ]);
    mockTx.mockImplementation((fn: (c: unknown) => unknown) => Promise.resolve(fn(f.client)));
    return f;
  }

  it('siembra las seis categorías del catálogo en una entidad virgen', async () => {
    arnesDeSiembra([], ['1210', '1220', '1230', '1290', '6140']);
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    expect(r.creadas).toHaveLength(CATALOGO_LISR.length);
    expect(r.yaExistian).toEqual([]);
  });

  it('cita el artículo de la LISR en cada categoría que crea', async () => {
    arnesDeSiembra([], ['1210', '1220', '1230', '1290', '6140']);
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    expect(r.creadas.every((c) => /LISR art\. 3[45]/.test(c))).toBe(true);
  });

  it('es idempotente: no reinserta lo que ya está', async () => {
    const f = arnesDeSiembra(['Equipo de Cómputo'], ['1210', '1220', '1230', '1290', '6140']);
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    expect(r.yaExistian).toEqual(['Equipo de Cómputo']);
    expect(f.coincidencias(/INSERT INTO asset_categories/)).toHaveLength(CATALOGO_LISR.length - 1);
  });

  it('no pisa nada cuando ya están todas', async () => {
    const f = arnesDeSiembra(
      CATALOGO_LISR.map((e) => e.nombre),
      ['1210', '1220', '1230', '1290', '6140']
    );
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    expect(r.creadas).toEqual([]);
    expect(f.coincidencias(/INSERT INTO asset_categories/)).toHaveLength(0);
  });

  it('lee lo existente acotado por entidad', async () => {
    const f = arnesDeSiembra([], ['1210', '1220', '1230', '1290', '6140']);
    await sembrarCategoriasDeActivo(ENTIDAD);
    expect(f.consultas[0].sql).toMatch(/FROM asset_categories WHERE entity_id = \$1/);
    expect(f.consultas[0].params).toEqual([ENTIDAD]);
  });

  it('reporta las categorías que se quedan sin cuenta de activo', async () => {
    arnesDeSiembra([], ['1210', '1220', '1230', '1290', '6140']);
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    // Edificios, Maquinaria y Herramental no tienen cuenta en el catálogo base.
    expect(r.sinCuentaDeActivo).toEqual([
      'Edificios y Construcciones',
      'Maquinaria y Equipo',
      'Herramientas, Dados, Troqueles, Moldes y Matrices',
    ]);
  });

  it('reporta las cuentas de depreciación ausentes en vez de sembrar en silencio', async () => {
    arnesDeSiembra([], ['1210', '1220', '1230']);
    const r = await sembrarCategoriasDeActivo(ENTIDAD);
    expect(r.cuentasFaltantes).toEqual(['1290', '6140']);
  });

  it('nunca apunta una categoría a una cuenta de encabezado', async () => {
    const f = arnesDeSiembra([], ['1210', '1220', '1230', '1290', '6140']);
    await sembrarCategoriasDeActivo(ENTIDAD);
    const consulta = f.consultas.find((c) => /FROM accounts/.test(c.sql));
    expect(consulta?.sql).toMatch(/is_header = false/);
  });
});
