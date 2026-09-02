import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(() => 'tenant-1'),
}));

// El criterio del cierre es una lectura de panel, y estas pruebas cuentan
// aritmética de flujo, no consultas de política. Se fija en su valor POR
// OMISIÓN —el estado de resultados excluye el cierre— y `predicadoSinCierre`
// se deja REAL, porque es el SQL que algunas aserciones comprueban.
vi.mock('../../../src/services/reporting/criterio-cierre.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/reporting/criterio-cierre.js')>();
  return {
    ...actual,
    criterioDeCierreEnInformes: vi.fn(async () => ({
      valor: 'estado_sin_cierre_balanza_con_cierre',
      enEstadoDeResultados: false,
      enBalanza: true,
    })),
    avisoDeCierreEnRango: vi.fn(async () => null),
  };
});

vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import {
  clasificarCuenta,
  construirIndirecto,
  descontarOperacionesSinEfectivo,
  autoComprobar,
  netoDe,
  resolverCuentasDeEfectivo,
  queryMovimientosNoEfectivo,
  politicasDeFlujo,
  getCashFlowStatement,
  type MovimientoDeCuenta,
  type LineaSinEfectivo,
} from '../../../src/services/reporting/cash-flow-service.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  mockQuery.mockReset();
  mockPolicy.mockReset();
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1] as unknown[];

/**
 * Un movimiento tal como lo entrega Postgres: el dinero, cadena; el tipo y la
 * categoría, las dos columnas con CHECK sobre las que se clasifica.
 */
const mov = (
  code: string,
  name: string,
  account_type: string,
  fs_category: string | null,
  debit: string,
  credit: string
): MovimientoDeCuenta => ({
  account_id: `id-${code}`,
  code,
  name,
  account_type,
  account_subtype: null,
  fs_category,
  debit_total: debit,
  credit_total: credit,
});

// ============================================================
// EL EJERCICIO DE ENERO, HECHO A MANO
//
// Nada aquí sale de una corrida: son las cifras de un mes escritas a mano y
// sus resultados calculados aparte. Si el motor cambia de signo o de sección,
// estas cifras dejan de cuadrar antes de que ningún estado se firme.
//
//   Ventas                 100 000 al haber
//   Gastos                  40 000 al debe
//   Depreciación (gasto)     5 000 al debe
//   Depreciación acumulada   5 000 al haber   (contra-activo: no movió dinero)
//   Clientes                30 000 al debe    (creció la cartera)
//   Proveedores             12 000 al haber   (creció el pasivo)
//   Mobiliario              20 000 al debe    (comprado con efectivo)
//   Capital social          50 000 al haber   (aportación)
//   Préstamo largo plazo     8 000 al haber
//
//   Utilidad neta  = 100 000 − 40 000 − 5 000        =  55 000
//   No monetarias  = + 5 000                         =   5 000
//   Capital trabajo= − 30 000 + 12 000               = −18 000
//   OPERACIÓN      = 55 000 + 5 000 − 18 000         =  42 000
//   INVERSIÓN      = − 20 000                        = −20 000
//   FINANCIAMIENTO = 50 000 + 8 000                  =  58 000
//   FLUJO NETO                                       =  80 000
// ============================================================

const ENERO: MovimientoDeCuenta[] = [
  mov('4100', 'Ventas', 'revenue', 'revenue', '0', '100000'),
  mov('6100', 'Gastos de Administración', 'expense', 'operating_expenses', '40000', '0'),
  mov('6140', 'Depreciación', 'expense', 'operating_expenses', '5000', '0'),
  mov('1290', 'Depreciación Acumulada', 'contra_asset', 'non_current_assets', '0', '5000'),
  mov('1120', 'Clientes', 'asset', 'current_assets', '30000', '0'),
  mov('2110', 'Proveedores', 'liability', 'current_liabilities', '0', '12000'),
  mov('1210', 'Mobiliario y Equipo', 'asset', 'non_current_assets', '20000', '0'),
  mov('3100', 'Capital Social', 'equity', 'equity', '0', '50000'),
  mov('2210', 'Préstamo Bancario a Largo Plazo', 'liability', 'long_term_liabilities', '0', '8000'),
];

describe('la aritmética del método indirecto', () => {
  it('utilidad + partidas no monetarias ± capital de trabajo, con las cifras de enero', () => {
    const f = construirIndirecto(ENERO);

    expect(f.net_income).toBe('55000.0000');
    expect(f.operating_activities.non_cash.total).toBe('5000.0000');
    expect(f.operating_activities.working_capital.total).toBe('-18000.0000');
    expect(f.operating_activities.total).toBe('42000.0000');
    expect(f.investing_activities.total).toBe('-20000.0000');
    expect(f.financing_activities.total).toBe('58000.0000');
    expect(f.net_cash_flow).toBe('80000.0000');
  });

  it('el flujo neto es EXACTAMENTE menos la suma de los netos: la identidad de la partida doble', () => {
    // Ésta es la propiedad de la que cuelga que el estado cuadre. Si alguien
    // cambia un signo de sección, la suma deja de dar y esta prueba lo dice
    // aunque los totales de arriba se hayan reajustado a mano.
    const sumaDeNetos = ENERO.reduce((s, m) => s + Number(netoDe(m).toFixed(4)), 0);
    const f = construirIndirecto(ENERO);
    expect(Number(f.net_cash_flow)).toBe(-sumaDeNetos);
    expect(sumaDeNetos).toBe(-80000);
  });

  it('el ingreso aporta en positivo y el gasto en negativo sin un signo por sección', () => {
    const f = construirIndirecto([
      mov('4100', 'Ventas', 'revenue', 'revenue', '0', '1000'),
      mov('6100', 'Gastos', 'expense', 'operating_expenses', '400', '0'),
    ]);
    expect(f.net_income).toBe('600.0000');
    expect(f.operating_activities.total).toBe('600.0000');
  });

  it('la cartera que crece RESTA y el proveedor que crece SUMA', () => {
    const f = construirIndirecto([
      mov('1120', 'Clientes', 'asset', 'current_assets', '30000', '0'),
      mov('2110', 'Proveedores', 'liability', 'current_liabilities', '0', '12000'),
    ]);
    const clientes = f.operating_activities.working_capital.lines.find((l) => l.code === '1120');
    const proveedores = f.operating_activities.working_capital.lines.find((l) => l.code === '2110');
    expect(clientes?.amount).toBe('-30000.0000');
    expect(proveedores?.amount).toBe('12000.0000');
    expect(f.operating_activities.working_capital.total).toBe('-18000.0000');
  });

  it('la depreciación no mueve el flujo neto: baja la utilidad y la partida no monetaria la devuelve', () => {
    const sinDepreciacion = construirIndirecto([
      mov('4100', 'Ventas', 'revenue', 'revenue', '0', '1000'),
    ]);
    const conDepreciacion = construirIndirecto([
      mov('4100', 'Ventas', 'revenue', 'revenue', '0', '1000'),
      mov('6140', 'Depreciación', 'expense', 'operating_expenses', '300', '0'),
      mov('1290', 'Depreciación Acumulada', 'contra_asset', 'non_current_assets', '0', '300'),
    ]);
    expect(conDepreciacion.net_income).toBe('700.0000');
    expect(conDepreciacion.operating_activities.non_cash.total).toBe('300.0000');
    expect(conDepreciacion.net_cash_flow).toBe(sinDepreciacion.net_cash_flow);
    expect(conDepreciacion.net_cash_flow).toBe('1000.0000');
  });

  it('una cuenta que se movió y volvió a su sitio no imprime renglón', () => {
    const f = construirIndirecto([mov('1120', 'Clientes', 'asset', 'current_assets', '500', '500')]);
    expect(f.operating_activities.working_capital.lines).toHaveLength(0);
    expect(f.operating_activities.working_capital.total).toBe('0.0000');
  });

  it('el dinero es cadena de cuatro decimales, nunca un número de JS', () => {
    const f = construirIndirecto([
      mov('4100', 'Ventas', 'revenue', 'revenue', '0', '0.1'),
      mov('6100', 'Gastos', 'expense', 'operating_expenses', '0.2', '0'),
    ]);
    // 0.1 y 0.2 en coma flotante dan 0.30000000000000004; con Decimal, no.
    expect(f.net_income).toBe('-0.1000');
    expect(typeof f.net_cash_flow).toBe('string');
  });
});

describe('el financiamiento se calcula — antes era la cadena 0.0000', () => {
  it('la aportación de capital y el préstamo de largo plazo entran al renglón', () => {
    const f = construirIndirecto([
      mov('3100', 'Capital Social', 'equity', 'equity', '0', '50000'),
      mov('2210', 'Préstamo Bancario', 'liability', 'long_term_liabilities', '0', '8000'),
    ]);
    expect(f.financing_activities.total).toBe('58000.0000');
    expect(f.financing_activities.lines.map((l) => l.code)).toEqual(['3100', '2210']);
  });

  it('el dividendo pagado y la amortización de la deuda salen en negativo', () => {
    const f = construirIndirecto([
      mov('3200', 'Resultado de Ejercicios Anteriores', 'equity', 'equity', '20000', '0'),
      mov('2210', 'Préstamo Bancario', 'liability', 'long_term_liabilities', '5000', '0'),
    ]);
    expect(f.financing_activities.total).toBe('-25000.0000');
  });
});

describe('la clasificación es por columnas con CHECK, no por el nombre', () => {
  it('«Clientes» y «Proveedores», en español, SÍ son capital de trabajo', () => {
    // El motor viejo preguntaba `name ILIKE '%receivable%'` contra un catálogo
    // sembrado en español: no casaba nada y el capital de trabajo salía en
    // cero, que se lee igual que «no cambió».
    expect(clasificarCuenta({ account_type: 'asset', fs_category: 'current_assets' })).toBe(
      'capital_de_trabajo'
    );
    expect(clasificarCuenta({ account_type: 'liability', fs_category: 'current_liabilities' })).toBe(
      'capital_de_trabajo'
    );
    const f = construirIndirecto([
      mov('1120', 'Clientes', 'asset', 'current_assets', '30000', '0'),
    ]);
    expect(f.operating_activities.working_capital.total).not.toBe('0.0000');
  });

  it('la depreciación acumulada es partida no monetaria y NO inversión, aunque viva en el activo no circulante', () => {
    // Por categoría caería en inversión y fingiría una entrada de efectivo por
    // la depreciación del ejercicio. El tipo gana a la categoría, y este orden
    // es lo que la prueba fija.
    expect(clasificarCuenta({ account_type: 'contra_asset', fs_category: 'non_current_assets' })).toBe(
      'no_monetario'
    );
  });

  it('capital y deuda de largo plazo son financiamiento; el activo no circulante, inversión', () => {
    expect(clasificarCuenta({ account_type: 'equity', fs_category: 'equity' })).toBe('financiamiento');
    expect(clasificarCuenta({ account_type: 'contra_equity', fs_category: 'equity' })).toBe(
      'financiamiento'
    );
    expect(clasificarCuenta({ account_type: 'liability', fs_category: 'long_term_liabilities' })).toBe(
      'financiamiento'
    );
    expect(clasificarCuenta({ account_type: 'asset', fs_category: 'non_current_assets' })).toBe(
      'inversion'
    );
  });

  it('ingreso y gasto componen la utilidad, sea cual sea su categoría', () => {
    expect(clasificarCuenta({ account_type: 'revenue', fs_category: 'other_income' })).toBe('resultado');
    expect(clasificarCuenta({ account_type: 'expense', fs_category: 'tax' })).toBe('resultado');
  });

  it('lo que no encaja NO se acomoda: cae en sin_clasificar', () => {
    // `fs_category` es nullable, y un catálogo importado puede no traerla.
    // Adivinarle la sección sería volver a inventar.
    expect(clasificarCuenta({ account_type: 'asset', fs_category: null })).toBe('sin_clasificar');
    expect(clasificarCuenta({ account_type: 'liability', fs_category: 'revenue' })).toBe(
      'sin_clasificar'
    );
  });
});

describe('el activo comprado a crédito no es una salida de efectivo', () => {
  // El motor viejo sacaba la inversión de la tabla `fixed_assets`: toda alta
  // del periodo se publicaba como salida de efectivo, la hubiera pagado o no.
  const brutos: MovimientoDeCuenta[] = [
    mov('1210', 'Mobiliario y Equipo', 'asset', 'non_current_assets', '20000', '0'),
    mov('2110', 'Proveedores', 'liability', 'current_liabilities', '0', '8000'),
  ];
  const aCredito: LineaSinEfectivo[] = [
    {
      entry_id: 'e1',
      entry_number: 'JE-0001',
      entry_date: '2026-01-15',
      description: 'Equipo comprado a crédito',
      account_id: 'id-1210',
      code: '1210',
      name: 'Mobiliario y Equipo',
      debit_total: '8000',
      credit_total: '0',
    },
    {
      entry_id: 'e1',
      entry_number: 'JE-0001',
      entry_date: '2026-01-15',
      description: 'Equipo comprado a crédito',
      account_id: 'id-2110',
      code: '2110',
      name: 'Proveedores',
      debit_total: '0',
      credit_total: '8000',
    },
  ];

  it('se descuenta del renglón de inversión y se revela aparte', () => {
    const { movimientos, operaciones } = descontarOperacionesSinEfectivo(brutos, aCredito);
    const f = construirIndirecto(movimientos);

    // 20 000 de altas, 8 000 a crédito: sólo 12 000 salieron del banco.
    expect(f.investing_activities.total).toBe('-12000.0000');
    // Y el aumento del proveedor que financió el equipo tampoco infla la
    // operación: el asiento se fue ENTERO, no sólo su mitad.
    expect(f.operating_activities.working_capital.total).toBe('0.0000');
    expect(operaciones).toHaveLength(1);
    expect(operaciones[0].entry_number).toBe('JE-0001');
    expect(operaciones[0].amount).toBe('8000.0000');
  });

  it('sacar el asiento entero deja intacto el amarre contra el efectivo', () => {
    // Un asiento está balanceado por CHECK de tabla, así que la suma de sus
    // aportes es cero: quitarlo no puede mover el Δefectivo. Aquí se
    // comprueba sobre la identidad, que es de donde sale el amarre: el neto
    // publicado sigue siendo −Σ(netos) de lo que QUEDÓ.
    const { movimientos } = descontarOperacionesSinEfectivo(brutos, aCredito);
    const f = construirIndirecto(movimientos);
    const sumaDeNetos = movimientos.reduce((s, m) => s + Number(netoDe(m).toFixed(4)), 0);
    expect(Number(f.net_cash_flow)).toBe(-sumaDeNetos);
    expect(f.net_cash_flow).toBe('-12000.0000');
    expect(autoComprobar(f).ties).toBe(true);
  });

  it('la depreciación del mes NO se excluye: se cancela sola dentro de la operación', () => {
    // Es la otra mitad de la regla. La depreciación tampoco mueve efectivo,
    // pero vive entera dentro de operación (baja la utilidad, la devuelve la
    // partida no monetaria); sacarla dejaría la utilidad neta sin su ajuste.
    const conDepreciacion = [
      ...brutos,
      mov('6140', 'Depreciación', 'expense', 'operating_expenses', '300', '0'),
      mov('1290', 'Depreciación Acumulada', 'contra_asset', 'non_current_assets', '0', '300'),
    ];
    const { movimientos } = descontarOperacionesSinEfectivo(conDepreciacion, aCredito);
    const f = construirIndirecto(movimientos);
    expect(f.net_income).toBe('-300.0000');
    expect(f.operating_activities.non_cash.total).toBe('300.0000');
    expect(f.operating_activities.total).toBe('0.0000');
  });
});

describe('el residuo se imprime, no se absorbe', () => {
  const sinCategoria = mov('9999', 'Cuenta Importada', 'asset', null, '7000', '0');

  it('lo que no se supo clasificar queda FUERA del flujo neto', () => {
    const f = construirIndirecto([...ENERO, sinCategoria]);
    // Los 80 000 de enero no se contaminan con la cuenta que nadie clasificó.
    expect(f.net_cash_flow).toBe('80000.0000');
    expect(f.unclassified.total).toBe('-7000.0000');
    expect(f.unclassified.lines).toHaveLength(1);
  });

  it('el estado sabe que no puede cuadrar, y por cuánto, antes de mirar el banco', () => {
    const f = construirIndirecto([...ENERO, sinCategoria]);
    const a = autoComprobar(f);
    // El efectivo real se movió 7 000 menos que lo que el estado publica, y
    // eso se sabe SIN consultar el mayor: lo dice la cuenta sin clasificar.
    expect(a.ties).toBe(false);
    expect(a.unclassified_total).toBe('-7000.0000');
    expect(a.candidates.map((l) => l.code)).toEqual(['9999']);
    expect(a.note).toContain('cannot tie');
  });

  it('cuando todo cae en una sección, cuadra por construcción', () => {
    const a = autoComprobar(construirIndirecto(ENERO));
    expect(a.ties).toBe(true);
    expect(a.unclassified_total).toBe('0.0000');
    expect(a.candidates).toHaveLength(0);
    expect(a.note).toContain('ties to cash by construction');
  });
});

describe('qué cuentas son efectivo', () => {
  it('las resuelve por el rol banco, por la cuenta bancaria atada, y por el ÁRBOL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'id-1111', code: '1111', name: 'Banco' }] });
    await resolverCuentasDeEfectivo(ENTITY, 'rol');

    const s = sql(0);
    expect(s).toContain('account_roles');
    expect(s).toContain("ar.role = 'banco'");
    expect(s).toContain('bank_accounts');
    // El rol apunta a 1110 «Caja y Bancos», que es la MADRE de 1111/1112/1115,
    // donde de verdad caen los movimientos. Sin la recursiva, el conjunto de
    // efectivo se queda sin movimiento y el estado entero se va al residuo.
    expect(s).toContain('WITH RECURSIVE');
    expect(s).toContain('h.parent_id = t.id');
    // Y la frontera de entidad va dentro del SQL, también en el paso recursivo.
    expect(s).toContain('h.entity_id = $1');
    expect(params(0)).toEqual([ENTITY]);
  });

  it('no queda ni un ILIKE de nombre en la resolución', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'id-1111', code: '1111', name: 'Banco' }] });
    await resolverCuentasDeEfectivo(ENTITY, 'rol');
    expect(sql(0).toLowerCase()).not.toContain('ilike');
  });

  it('falla cerrado cuando no hay efectivo identificable, y dice cómo mapearlo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolverCuentasDeEfectivo(ENTITY, 'rol')).rejects.toThrow(ValidationError);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolverCuentasDeEfectivo(ENTITY, 'rol')).rejects.toThrow(
      /account role set banco/
    );
  });

  it('«lista» falla cerrado: no hay dónde guardar la lista todavía', async () => {
    // Aceptarla sería el criterio por rol con otro nombre.
    await expect(resolverCuentasDeEfectivo(ENTITY, 'lista')).rejects.toThrow(
      /cashflow category set/
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('«subtipo» falla cerrado si ninguna cuenta declara el subtipo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolverCuentasDeEfectivo(ENTITY, 'subtipo')).rejects.toThrow(ValidationError);
  });
});

describe('la consulta del movimiento', () => {
  it('excluye el efectivo, respeta el par (jel JOIN je) y acota la entidad en el SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryMovimientosNoEfectivo(ENTITY, {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      cashAccountIds: ['id-1111'],
    });

    const s = sql(0);
    expect(s).toContain('JOIN (journal_entry_lines jel JOIN journal_entries je');
    expect(s).toContain("je.status = 'posted'");
    expect(s).toContain('a.entity_id = $1');
    expect(s).toContain('NOT (a.id = ANY($4::uuid[]))');
    // El criterio del cierre es el del estado de resultados: la primera línea
    // del indirecto es la utilidad neta y las dos tienen que salir de los
    // mismos asientos.
    expect(s).toContain('NOT (je.entry_type');
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-01-31', ['id-1111']]);
  });

  it('no clasifica por nombre: ni un ILIKE en la consulta del movimiento', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryMovimientosNoEfectivo(ENTITY, {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      cashAccountIds: [],
    });
    expect(sql(0).toLowerCase()).not.toContain('ilike');
    expect(sql(0)).not.toContain('fixed_assets');
  });
});

describe('las tres políticas tienen lector', () => {
  it('lee las tres claves del panel', async () => {
    mockPolicy.mockImplementation(async (_ctx: unknown, key: string) => ({
      key,
      value: { flujo_efectivo_metodo: 'indirecto', flujo_efectivo_cuentas_de_efectivo: 'rol', flujo_efectivo_descuadre: 'avisar' }[key],
      defined: false,
      question: '',
      rationale: null,
    }));
    const p = await politicasDeFlujo(ENTITY);
    const leidas = mockPolicy.mock.calls.map((c) => c[1] as string).sort();
    expect(leidas).toEqual([
      'flujo_efectivo_cuentas_de_efectivo',
      'flujo_efectivo_descuadre',
      'flujo_efectivo_metodo',
    ]);
    expect(p).toEqual({ metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'avisar' });
  });

  it('un valor que el panel no reconoce cae al defecto declarado', async () => {
    mockPolicy.mockResolvedValue({ key: 'x', value: 'ni idea', defined: false, question: '', rationale: null });
    expect(await politicasDeFlujo(ENTITY)).toEqual({
      metodo: 'indirecto',
      cuentasDeEfectivo: 'rol',
      descuadre: 'avisar',
    });
  });
});

describe('el método directo falla cerrado', () => {
  const conPolitica = (metodo: string) => {
    mockPolicy.mockImplementation(async (_ctx: unknown, key: string) => ({
      key,
      value: key === 'flujo_efectivo_metodo' ? metodo : { flujo_efectivo_cuentas_de_efectivo: 'rol', flujo_efectivo_descuadre: 'avisar' }[key],
      defined: true,
      question: '',
      rationale: null,
    }));
  };

  it('jamás devuelve el indirecto rotulado como directo', async () => {
    conPolitica('directo');
    // El defecto de hoy: `method` se aceptaba, se devolvía y no cambiaba un
    // número. Ahora se niega, diciendo qué falta.
    await expect(
      getCashFlowStatement(ENTITY, { startDate: '2026-01-01', endDate: '2026-01-31' })
    ).rejects.toThrow(/no se puede construir/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('el motivo que da es el que se puede arreglar: falta el concepto del movimiento', async () => {
    conPolitica('directo');
    await expect(
      getCashFlowStatement(ENTITY, { startDate: '2026-01-01', endDate: '2026-01-31' })
    ).rejects.toThrow(/POR CONCEPTO/);
  });

  it('el --method del CLI pesa sobre la política, y falla igual', async () => {
    conPolitica('indirecto');
    await expect(
      getCashFlowStatement(ENTITY, {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        metodo: 'directo',
      })
    ).rejects.toThrow(ValidationError);
  });
});
