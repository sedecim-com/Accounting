import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  basesIsnDeCorrida,
  calcularIsn,
  contarHallazgos,
  hallazgosQueBloquean,
  vigenteEn,
  type TasaIsn,
} from '../../../src/services/payroll/mx/isn-calculator.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

// ============================================================
// EL IMPUESTO QUE FALTABA, Y LAS TRES VECES QUE SE NIEGA A INVENTARLO
//
// Estas pruebas no necesitan Postgres porque lo que vigilan no es SQL: es la
// decisión de qué hacer cuando el dato no está. La tentación en los tres casos
// —sin tasa, con régimen que no se sabe hacer, sin estado en el trabajador— es
// devolver cero, y un cero aquí no se distingue de un cálculo correcto:
// atraviesa el balance, el costo laboral y la declaración sin que nada chille.
//
// Por eso cada caso comprueba DOS cosas: que no se calculó, y que salió un
// hallazgo que NOMBRA el estado y el periodo. Comprobar sólo el importe dejaría
// pasar la versión silenciosa del mismo defecto.
// ============================================================

/** Una vigencia como la devuelve la consulta: columnas en snake_case y texto. */
function vigencia(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estado: 'JAL',
    vigencia_desde: '2026-01-01',
    vigencia_hasta: null,
    tasa: '0.030000',
    regimen: 'tasa_plana',
    exencion_mensual: null,
    fundamento: 'Ley de Hacienda del Estado de Jalisco, art. 39',
    ...over,
  };
}

const MARZO = { periodoInicio: '2026-03-01', periodoFin: '2026-03-15', fechaCausacion: '2026-03-15' };

beforeEach(() => {
  mockQuery.mockReset();
  mockPolicy.mockReset();
});

describe('sin tasa capturada no hay cero: hay un hallazgo con nombre', () => {
  it('nombra el estado y el periodo que le faltan, y no calcula nada', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const r = await calcularIsn({
      bases: [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }],
      ...MARZO,
    });

    expect(r.porEstado).toEqual([]);
    // El total NO es «cero pesos de impuesto»: es «cero pesos calculados».
    // La diferencia la sostiene el hallazgo, no el número.
    expect(r.total).toBe('0.0000');
    expect(r.hallazgos).toHaveLength(1);
    const h = r.hallazgos[0];
    expect(h.codigo).toBe('isn_sin_tasa_capturada');
    expect(h.severidad).toBe('bloqueante');
    expect(h.estado).toBe('JAL');
    expect(h.mensaje).toContain('JAL');
    expect(h.mensaje).toContain('2026-03-01 a 2026-03-15');
    expect(hallazgosQueBloquean(r.hallazgos)).toHaveLength(1);
  });

  it('distingue «no hay tasa» de «hay tasas pero ninguna cubre la fecha»', async () => {
    // Vigencia que TOCA el periodo pero termina antes de la causación: el
    // estado sí está capturado, lo que falta es el tramo. Decir «no hay tasa»
    // mandaría al contador a capturar una que ya existe.
    mockQuery.mockResolvedValue({
      rows: [vigencia({ vigencia_desde: '2025-01-01', vigencia_hasta: '2026-03-10' })],
    });

    const r = await calcularIsn({
      bases: [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }],
      ...MARZO,
    });

    expect(r.porEstado).toEqual([]);
    expect(r.hallazgos[0].codigo).toBe('isn_sin_tasa_capturada');
    expect(r.hallazgos[0].mensaje).toContain('ninguna cubre la fecha de causación 2026-03-15');
  });
});

describe('la tasa se busca por estado Y por fecha, nunca «la última»', () => {
  it('elige la vigencia que cubre la causación, aunque haya otra posterior', async () => {
    // Las dos tocan el periodo porque el congreso movió la tasa a mitad de mes.
    // «La última capturada» daría 4%; la que rige el 5 de marzo es la de 3%.
    mockQuery.mockResolvedValue({
      rows: [
        vigencia({ vigencia_desde: '2025-01-01', vigencia_hasta: '2026-03-10', tasa: '0.030000' }),
        vigencia({ vigencia_desde: '2026-03-10', tasa: '0.040000' }),
      ],
    });

    const r = await calcularIsn({
      bases: [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }],
      periodoInicio: '2026-03-01',
      periodoFin: '2026-03-15',
      fechaCausacion: '2026-03-05',
    });

    expect(r.porEstado).toHaveLength(1);
    expect(r.porEstado[0].tasa).toBe('0.030000');
    expect(r.porEstado[0].importe).toBe('3000.0000');
    // Y el cambio de tasa dentro del periodo se DICE, aunque no se parta la base.
    expect(contarHallazgos(r.hallazgos)).toEqual({ bloqueante: 0, aviso: 1 });
    expect(r.hallazgos[0].codigo).toBe('isn_tasa_cambia_dentro_del_periodo');
  });

  it('la consulta acota por el intervalo SEMIABIERTO que impone el disparador de la 067', async () => {
    mockQuery.mockResolvedValue({ rows: [vigencia()] });
    await calcularIsn({ bases: [{ estado: 'JAL', base: '1', trabajadores: 1 }], ...MARZO });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // [desde, hasta): con la convención contraria, el día en que una tasa
    // cierra y la siguiente abre devolvería DOS filas para esa fecha.
    expect(sql).toContain('vigencia_desde <= $3::date');
    expect(sql).toContain('vigencia_hasta > $2::date');
    expect(params).toEqual(['JAL', '2026-03-01', '2026-03-15']);
  });

  it('vigenteEn trata el día de cierre como del tramo SIGUIENTE', () => {
    const tasas: TasaIsn[] = [
      {
        estado: 'JAL', vigenciaDesde: '2025-01-01', vigenciaHasta: '2026-01-01',
        tasa: '0.020000', regimen: 'tasa_plana', exencionMensual: null, fundamento: 'x',
      },
      {
        estado: 'JAL', vigenciaDesde: '2026-01-01', vigenciaHasta: null,
        tasa: '0.030000', regimen: 'tasa_plana', exencionMensual: null, fundamento: 'y',
      },
    ];
    expect(vigenteEn(tasas, '2025-12-31')?.tasa).toBe('0.020000');
    expect(vigenteEn(tasas, '2026-01-01')?.tasa).toBe('0.030000');
    expect(vigenteEn(tasas, '2024-12-31')).toBeUndefined();
  });
});

describe('un régimen que el motor no sabe calcular se niega, no se aproxima', () => {
  it('el escalonado no se cobra como si fuera tasa plana', async () => {
    mockQuery.mockResolvedValue({ rows: [vigencia({ regimen: 'escalonado' })] });

    const r = await calcularIsn({
      bases: [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }],
      ...MARZO,
    });

    expect(r.porEstado).toEqual([]);
    expect(r.total).toBe('0.0000');
    expect(r.hallazgos[0].codigo).toBe('isn_regimen_no_soportado');
    expect(r.hallazgos[0].severidad).toBe('bloqueante');
    expect(r.hallazgos[0].mensaje).toContain('escalonado');
    expect(r.hallazgos[0].mensaje).toContain('JAL');
  });

  it('el de exención tampoco: repartir una franquicia mensual sobre una quincena exime de más', async () => {
    mockQuery.mockResolvedValue({
      rows: [vigencia({ regimen: 'con_exencion', exencion_mensual: '5000.0000' })],
    });

    const r = await calcularIsn({
      bases: [{ estado: 'JAL', base: '100000.0000', trabajadores: 7 }],
      ...MARZO,
    });

    expect(r.porEstado).toEqual([]);
    expect(r.hallazgos[0].codigo).toBe('isn_regimen_no_soportado');
    expect(r.hallazgos[0].mensaje).toContain('5000.0000');
  });
});

describe('el trabajador sin estado tiene impuesto: lo que falta es dónde', () => {
  it('sale como hallazgo bloqueante y no se suma a ningún estado', async () => {
    mockQuery.mockResolvedValue({ rows: [vigencia()] });

    const r = await calcularIsn({
      bases: [
        { estado: null, base: '40000.0000', trabajadores: 2 },
        { estado: 'JAL', base: '60000.0000', trabajadores: 3 },
      ],
      ...MARZO,
    });

    expect(r.porEstado).toHaveLength(1);
    expect(r.porEstado[0].estado).toBe('JAL');
    // Los 40 000 sin estado NO se repartieron ni se colaron en Jalisco.
    expect(r.porEstado[0].base).toBe('60000.0000');
    expect(r.total).toBe('1800.0000');
    const h = r.hallazgos.find((x) => x.codigo === 'isn_sin_estado_en_el_trabajador');
    expect(h?.severidad).toBe('bloqueante');
    expect(h?.mensaje).toContain('2 recibo(s)');
  });
});

describe('un renglón por estado, y el dinero con cuatro decimales', () => {
  it('no agrega los estados en un solo importe', async () => {
    mockQuery.mockImplementation((_sql: string, params: unknown[]) =>
      Promise.resolve({
        rows: [
          params[0] === 'JAL'
            ? vigencia({ tasa: '0.030000' })
            : vigencia({ estado: 'NLE', tasa: '0.020000', fundamento: 'Ley de Hacienda de N.L.' }),
        ],
      })
    );

    const r = await calcularIsn({
      bases: [
        { estado: 'JAL', base: '100000.0000', trabajadores: 4 },
        { estado: 'NLE', base: '50000.0000', trabajadores: 2 },
      ],
      ...MARZO,
    });

    expect(r.porEstado.map((x) => [x.estado, x.importe])).toEqual([
      ['JAL', '3000.0000'],
      ['NLE', '1000.0000'],
    ]);
    expect(r.total).toBe('4000.0000');
  });

  it('multiplica en decimal, no en coma flotante', async () => {
    mockQuery.mockResolvedValue({ rows: [vigencia({ tasa: '0.030000' })] });

    const r = await calcularIsn({
      bases: [{ estado: 'jal ', base: '12345.6789', trabajadores: 1 }],
      ...MARZO,
    });

    // 12345.6789 × 0.03 = 370.370367 → 370.3704 a cuatro decimales.
    expect(r.porEstado[0].importe).toBe('370.3704');
    // Y la clave llega normalizada, para que ' jal ' y 'JAL' sean el mismo estado.
    expect(r.porEstado[0].estado).toBe('JAL');
  });
});

describe('quién decide el estado que causa: la política, no el motor', () => {
  it('con la omisión agrupa por el centro de trabajo del trabajador', async () => {
    mockPolicy.mockResolvedValue({
      key: 'isn_estado_que_causa', value: 'centro_de_trabajo', defined: false,
      question: '', rationale: null,
    });
    mockQuery.mockResolvedValue({
      rows: [{ estado: 'JAL', base: '1000', trabajadores: 2 }],
    });

    const r = await basesIsnDeCorrida({ tenantId: 't1', entityId: 'e1', payRunId: 'pr1' });

    expect(r.criterio).toBe('centro_de_trabajo');
    // Una política sin contestar NO es una decisión del despacho, y el
    // resultado lo dice para que el reporte no la presente como tal.
    expect(r.criterioDefinido).toBe(false);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('e.work_state');
    expect(sql).not.toContain('le.state_province');
    // Las dos fronteras van DENTRO del SQL, no en un if.
    expect(sql).toContain('p.tenant_id = $1');
    expect(sql).toContain('e.entity_id = $3');
    expect(params).toEqual(['t1', 'pr1', 'e1']);
  });

  it('con domicilio_fiscal agrupa por el estado de la entidad', async () => {
    mockPolicy.mockResolvedValue({
      key: 'isn_estado_que_causa', value: 'domicilio_fiscal', defined: true,
      question: '', rationale: null,
    });
    mockQuery.mockResolvedValue({ rows: [{ estado: 'CMX', base: '1000', trabajadores: 2 }] });

    const r = await basesIsnDeCorrida({ tenantId: 't1', entityId: 'e1', payRunId: 'pr1' });

    expect(r.criterio).toBe('domicilio_fiscal');
    expect(r.criterioDefinido).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toContain('le.state_province');
  });

  it('un estado en blanco viaja como null, no como el estado ""', async () => {
    mockPolicy.mockResolvedValue({
      key: 'isn_estado_que_causa', value: 'centro_de_trabajo', defined: false,
      question: '', rationale: null,
    });
    mockQuery.mockResolvedValue({ rows: [{ estado: '', base: '1000', trabajadores: 1 }] });

    const r = await basesIsnDeCorrida({ tenantId: 't1', entityId: 'e1', payRunId: 'pr1' });
    expect(r.bases).toEqual([{ estado: null, base: '1000', trabajadores: 1 }]);
  });
});
