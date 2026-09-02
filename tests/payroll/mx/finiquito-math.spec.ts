import { describe, it, expect } from 'vitest';
import {
  aniosDeServicioCumplidos,
  aFechaUtc,
  calcularFiniquito,
  diasDelEjercicio,
  diasDeVacacionesPorAnio,
  factorDeIntegracion,
  salarioDiarioDesdeSbc,
} from '../../../src/services/payroll/mx/finiquito-math.js';

// ============================================================
// LA PRUEBA QUE FALTABA (D1a)
//
// Ninguno de los tres defectos de dinero que este módulo repara necesitaba
// Postgres para salir: los tres son aritmética. No salían porque la aritmética
// vivía dentro de `calculateFiniquito`, detrás de una conexión, y el único
// banco de pruebas que había mockeaba la consulta y comprobaba rangos
// (`toBeGreaterThan(2400)`, `toBeLessThan(2500)`) en vez de importes.
//
// Aquí cada caso lleva su número calculado A MANO en el comentario. Un rango
// no habría delatado ninguno de los tres: los tres caen dentro del rango.
// ============================================================

const SD = '500'; // salario diario de trabajo, no integrado
const AGUINALDO = 15; // política `dias_aguinaldo`, mínimo LFT art. 87
const PRIMA = '0.25'; // política `prima_vacacional_pct`, mínimo LFT art. 80

describe('LFT art. 76 — tabla de vacaciones («vacaciones dignas», 2023)', () => {
  // Doce días el primer año, +2 por año hasta 20 al quinto, y a partir del
  // sexto +2 por cada QUINQUENIO cumplido. El año es el de SERVICIO en base 1:
  // quien cumplió 12 años está en su año 13.
  const TABLA: Array<[anio: number, dias: number, tramo: string]> = [
    [1, 12, 'primer año'],
    [2, 14, '+2'],
    [3, 16, '+2'],
    [4, 18, '+2'],
    [5, 20, '+2 — tope del primer quinquenio'],
    [6, 22, '6-10'],
    [7, 22, '6-10'],
    [8, 22, '6-10'],
    [9, 22, '6-10'],
    [10, 22, '6-10'],
    [11, 24, '11-15'],
    [12, 24, '11-15'],
    [13, 24, '11-15'],
    [14, 24, '11-15'],
    [15, 24, '11-15'],
    [16, 26, '16-20'],
    [17, 26, '16-20'],
    [18, 26, '16-20'],
    [19, 26, '16-20'],
    [20, 26, '16-20'],
    [21, 28, '21-25'],
    [22, 28, '21-25'],
    [23, 28, '21-25'],
    [24, 28, '21-25'],
    [25, 28, '21-25'],
    [26, 30, '26-30'],
    [27, 30, '26-30'],
    [28, 30, '26-30'],
    [29, 30, '26-30'],
    [30, 30, '26-30'],
  ];

  it.each(TABLA)('año %i de servicio → %i días (%s)', (anio, dias) => {
    expect(diasDeVacacionesPorAnio(anio)).toBe(dias);
  });

  // EL DEFECTO, NOMBRADO. La tabla anterior contaba los quinquenios desde el
  // año 9 (`22 + Math.floor((años - 9) / 5) * 2` sobre años CUMPLIDOS), así
  // que el escalón llegaba cuatro años tarde y sólo acertaba el último año de
  // cada tramo. Éstos son los doce años de antigüedad en los que pagaba dos
  // días de menos dentro del rango publicado.
  it.each([11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 29])(
    'año %i: la tabla vieja daba dos días menos que la ley',
    (anio) => {
      const viejo = 22 + Math.floor((anio - 1 - 9) / 5) * 2;
      expect(diasDeVacacionesPorAnio(anio)).toBe(viejo + 2);
    }
  );

  it('la progresión no se corta en 30: el art. 76 no pone tope', () => {
    // «dos días por cada cinco de servicios» sigue corriendo después del año
    // 30. Recortar ahí volvería a pagar de menos.
    expect(diasDeVacacionesPorAnio(31)).toBe(32);
    expect(diasDeVacacionesPorAnio(35)).toBe(32);
    expect(diasDeVacacionesPorAnio(36)).toBe(34);
  });

  it('un año de servicio menor que 1 se trata como el primero', () => {
    expect(diasDeVacacionesPorAnio(0)).toBe(12);
    expect(diasDeVacacionesPorAnio(-3)).toBe(12);
  });
});

describe('Factor de integración (LSS art. 27) y su inversa', () => {
  it('primer año: (365 + 15 + 12 × 0.25) / 365 = 383/365 = 1.0493…', () => {
    const fi = factorDeIntegracion({
      dias_aguinaldo: 15,
      dias_vacaciones: 12,
      prima_vacacional_pct: PRIMA,
    });
    expect(fi.toFixed(4)).toBe('1.0493');
  });

  it('año 13 (24 días de vacaciones): (365 + 15 + 6) / 365 = 386/365 = 1.0575…', () => {
    const fi = factorDeIntegracion({
      dias_aguinaldo: 15,
      dias_vacaciones: 24,
      prima_vacacional_pct: PRIMA,
    });
    expect(fi.toFixed(4)).toBe('1.0575');
  });

  it('des-integrar un SBC devuelve el salario diario del que salió', () => {
    // 500 × 386/365 = 528.7671 es el SBC de quien gana 500 al día en su año 13.
    const prestaciones = {
      dias_aguinaldo: 15,
      dias_vacaciones: 24,
      prima_vacacional_pct: PRIMA,
    };
    expect(salarioDiarioDesdeSbc('528.7671', prestaciones)).toBe('500.0000');
  });

  it('tomar el SBC como cuota diaria infla la base un 5.75 %', () => {
    // El defecto en una línea: 528.7671 contra 500.0000 son 28.7671 pesos
    // diarios de más en TODOS los conceptos del finiquito.
    const inflado = 528.7671 / 500 - 1;
    expect(inflado).toBeCloseTo(0.0575, 4);
  });
});

describe('Aguinaldo proporcional (LFT art. 87) — la fecha de alta cuenta', () => {
  const finiquitoAlCierre = (alta: string) =>
    calcularFiniquito({
      fecha_alta: alta,
      fecha_baja: '2026-12-31',
      pagado_hasta: '2026-12-31',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });

  it('alta en enero: el año entero, 15 días exactos', () => {
    // 2026-01-01 a 2026-12-31 inclusive = 365 días. 15 × 365/365 = 15.0000.
    // 15 × 500 = 7 500.0000
    const r = finiquitoAlCierre('2026-01-01');
    expect(r.aguinaldo_dias_trabajados).toBe(365);
    expect(r.aguinaldo_dias).toBe('15.0000');
    expect(r.aguinaldo_importe).toBe('7500.0000');
  });

  it('alta en julio: 184 días, poco más de medio aguinaldo', () => {
    // 2026-07-01 a 2026-12-31 inclusive = 31+31+30+31+30+31 = 184 días.
    // 15 × 184/365 = 2 760/365 = 7.5616438356… → 7.5616 días
    // 7.5616438356… × 500 = 3 780.8219178… → 3 780.8219
    //
    // EL DEFECTO: el cálculo anterior arrancaba en el 1 de enero pasara lo
    // que pasara, así que este trabajador cobraba 15 × 364/365 = 14.96 días —
    // casi el doble— por un aguinaldo que no devengó.
    const r = finiquitoAlCierre('2026-07-01');
    expect(r.aguinaldo_dias_trabajados).toBe(184);
    expect(r.aguinaldo_dias).toBe('7.5616');
    expect(r.aguinaldo_importe).toBe('3780.8219');
  });

  it('alta en diciembre: 31 días, un aguinaldo de un mes', () => {
    // 2026-12-01 a 2026-12-31 inclusive = 31 días.
    // 15 × 31/365 = 465/365 = 1.2739726027… → 1.2740 días
    // 1.2739726027… × 500 = 636.9863013… → 636.9863
    const r = finiquitoAlCierre('2026-12-01');
    expect(r.aguinaldo_dias_trabajados).toBe(31);
    expect(r.aguinaldo_dias).toBe('1.2740');
    expect(r.aguinaldo_importe).toBe('636.9863');
  });

  it('alta de un ejercicio anterior: el prorrateo arranca el 1 de enero', () => {
    // El alta de 2020 queda fuera del ejercicio 2026, así que el devengo
    // corre del 1 de enero: 365 días, aguinaldo completo.
    const r = finiquitoAlCierre('2020-03-05');
    expect(r.aguinaldo_dias_trabajados).toBe(365);
    expect(r.aguinaldo_dias).toBe('15.0000');
  });

  it('los días se cuentan INCLUSIVE: el 31 de diciembre también se trabajó', () => {
    // La resta a secas daba 364 y se comía un día de aguinaldo en TODOS los
    // finiquitos: 15/365 × 500 = 20.5479 pesos por trabajador.
    const r = finiquitoAlCierre('2020-03-05');
    expect(r.aguinaldo_dias_trabajados).toBe(365);
    const conElDefecto = (15 * 364) / 365;
    expect(Number(r.aguinaldo_dias) - conElDefecto).toBeCloseTo(15 / 365, 6);
  });

  it('un ejercicio bisiesto se divide entre 366, no entre 365', () => {
    // 2024 tiene 366 días. Dividir entre 365 daría 15.0411 días de aguinaldo
    // a quien trabajó el año completo: más que el año entero.
    expect(diasDelEjercicio(2024)).toBe(366);
    expect(diasDelEjercicio(2026)).toBe(365);
    expect(diasDelEjercicio(2100)).toBe(365); // secular no bisiesto
    expect(diasDelEjercicio(2000)).toBe(366); // divisible entre 400

    const r = calcularFiniquito({
      fecha_alta: '2020-01-01',
      fecha_baja: '2024-12-31',
      pagado_hasta: '2024-12-31',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    expect(r.aguinaldo_dias_trabajados).toBe(366);
    expect(r.aguinaldo_dias).toBe('15.0000');
  });

  it('los días de aguinaldo salen del parámetro, no de un 15 clavado', () => {
    const r = calcularFiniquito({
      fecha_alta: '2026-01-01',
      fecha_baja: '2026-12-31',
      pagado_hasta: '2026-12-31',
      salario_diario: SD,
      dias_aguinaldo_por_anio: 30, // el despacho contestó «un mes»
      prima_vacacional_pct: PRIMA,
    });
    expect(r.aguinaldo_dias).toBe('30.0000');
    expect(r.aguinaldo_importe).toBe('15000.0000');
  });
});

describe('Antigüedad y prima vacacional (LFT arts. 79 y 80)', () => {
  it('la antigüedad se cuenta por aniversario, no dividiendo días entre 365', () => {
    const alta = aFechaUtc('2014-07-16');
    // Un día antes del aniversario todavía son 11 años cumplidos.
    expect(aniosDeServicioCumplidos(alta, aFechaUtc('2026-07-15'))).toBe(11);
    expect(aniosDeServicioCumplidos(alta, aFechaUtc('2026-07-16'))).toBe(12);
    expect(aniosDeServicioCumplidos(alta, aFechaUtc('2014-07-16'))).toBe(0);
  });

  it('la prima se prorratea sobre el AÑO DE SERVICIO, no sobre el calendario', () => {
    // Alta 2014-07-16, baja 2026-09-30: último aniversario 2026-07-16.
    // Del 16 de julio al 30 de septiembre inclusive = 16 + 31 + 30 = 77 días.
    // Año 13 de servicio → 24 días (art. 76).
    // 24 × 77/365 = 1 848/365 = 5.0630136986… → 5.0630 días
    // 5.0630136986… × 500 × 0.25 = 632.8767123… → 632.8767
    //
    // El cálculo anterior usaba los días corridos desde el 1 de enero (272),
    // que para un alta de julio no mide nada: 22 × 272/365 = 16.39 días.
    const r = calcularFiniquito({
      fecha_alta: '2014-07-16',
      fecha_baja: '2026-09-30',
      pagado_hasta: '2026-09-15',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    expect(r.anio_de_servicio_en_curso).toBe(13);
    expect(r.dias_vacaciones_del_anio).toBe(24);
    expect(r.prima_vacacional_dias).toBe('5.0630');
    expect(r.prima_vacacional_importe).toBe('632.8767');
  });

  it('el porcentaje de prima sale del parámetro, no de un 0.25 clavado', () => {
    const base = {
      fecha_alta: '2014-07-16',
      fecha_baja: '2026-09-30',
      pagado_hasta: '2026-09-15',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
    };
    const alMinimo = calcularFiniquito({ ...base, prima_vacacional_pct: '0.25' });
    const alDoble = calcularFiniquito({ ...base, prima_vacacional_pct: '0.50' });
    // 632.8767 × 2 = 1 265.7534
    expect(alMinimo.prima_vacacional_importe).toBe('632.8767');
    expect(alDoble.prima_vacacional_importe).toBe('1265.7534');
  });

  it('la tabla vieja pagaba 52.74 pesos menos de prima en este mismo caso', () => {
    // Mismo trabajador, misma base: la única diferencia son los días del
    // art. 76 (24 los de la ley, 22 los que devolvía la tabla vieja).
    // 22 × 77/365 × 500 × 0.25 = 580.1370 contra 632.8767 → 52.7397 de menos.
    const conLaLey = 632.8767;
    const conLaTablaVieja = (22 * 77 * 500 * 0.25) / 365;
    expect(conLaTablaVieja).toBeCloseTo(580.137, 3);
    expect(conLaLey - conLaTablaVieja).toBeCloseTo(52.7397, 3);
  });
});

describe('El dinero es cadena de cuatro decimales, nunca float', () => {
  const CUATRO_DECIMALES = /^-?\d+\.\d{4}$/;

  it('cada importe del desglose sale con cuatro decimales', () => {
    const r = calcularFiniquito({
      fecha_alta: '2014-07-16',
      fecha_baja: '2026-09-30',
      pagado_hasta: '2026-09-15',
      salario_diario: '333.3333',
      dias_vacaciones_pendientes: 7,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    for (const importe of [
      r.salario_pendiente_importe,
      r.aguinaldo_importe,
      r.prima_vacacional_importe,
      r.vacaciones_pendientes_importe,
      r.total,
      r.salario_diario,
      r.aguinaldo_dias,
      r.prima_vacacional_dias,
    ]) {
      expect(importe).toMatch(CUATRO_DECIMALES);
    }
  });

  it('el total es la suma EXACTA de los cuatro conceptos que se enseñan', () => {
    // Con `float` esto fallaba por céntimos y nadie lo miraba: la prueba
    // anterior comparaba el total con `toBeCloseTo(..., 1)`.
    const r = calcularFiniquito({
      fecha_alta: '2019-02-11',
      fecha_baja: '2026-08-07',
      pagado_hasta: '2026-07-31',
      salario_diario: '287.6543',
      dias_vacaciones_pendientes: 3,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    const suma = [
      r.salario_pendiente_importe,
      r.aguinaldo_importe,
      r.prima_vacacional_importe,
      r.vacaciones_pendientes_importe,
    ]
      .map((s) => Math.round(Number(s) * 10000))
      .reduce((a, b) => a + b, 0);
    expect(Math.round(Number(r.total) * 10000)).toBe(suma);
  });
});

describe('El caso realista: 12 años de antigüedad y alta a mitad de año', () => {
  // Alta 2014-07-16, baja 2026-09-30, última nómina al 15 de septiembre.
  // Salario diario de 500.00 (SBC 528.7671, que es lo que el cálculo anterior
  // usaba como cuota diaria).
  const r = calcularFiniquito({
    fecha_alta: '2014-07-16',
    fecha_baja: '2026-09-30',
    pagado_hasta: '2026-09-15',
    salario_diario: SD,
    dias_vacaciones_pendientes: 0,
    dias_aguinaldo_por_anio: AGUINALDO,
    prima_vacacional_pct: PRIMA,
  });

  it('12 años cumplidos, año 13 en curso, 24 días de vacaciones', () => {
    expect(r.antiguedad_anios_cumplidos).toBe(12);
    expect(r.anio_de_servicio_en_curso).toBe(13);
    expect(r.dias_vacaciones_del_anio).toBe(24); // la tabla vieja decía 22
  });

  it('salarios pendientes: 15 días × 500 = 7 500.0000', () => {
    // Del 16 al 30 de septiembre. Con el SBC eran 15 × 528.7671 = 7 931.5065.
    expect(r.salario_pendiente_dias).toBe(15);
    expect(r.salario_pendiente_importe).toBe('7500.0000');
  });

  it('aguinaldo: 273 días del ejercicio → 11.2192 días → 5 609.5890', () => {
    // 1 de enero a 30 de septiembre inclusive = 31+28+31+30+31+30+31+31+30 = 273.
    // 15 × 273/365 = 4 095/365 = 11.2191780822… → 11.2192 días
    // 11.2191780822… × 500 = 5 609.5890411… → 5 609.5890
    expect(r.aguinaldo_dias_trabajados).toBe(273);
    expect(r.aguinaldo_dias).toBe('11.2192');
    expect(r.aguinaldo_importe).toBe('5609.5890');
  });

  it('prima vacacional: 77 días del año 13 → 5.0630 días → 632.8767', () => {
    expect(r.prima_vacacional_dias).toBe('5.0630');
    expect(r.prima_vacacional_importe).toBe('632.8767');
  });

  it('total 13 742.4657 contra los 16 009.33 que pagaba el cálculo anterior', () => {
    // 7 500.0000 + 5 609.5890 + 632.8767 + 0 = 13 742.4657
    //
    // El desglose de la diferencia (−2 266.86), concepto por concepto:
    //   salario  7 931.51 → 7 500.00  (−431.51)  base inflada por el SBC
    //   aguinaldo 5 910.60 → 5 609.59 (−301.01)  base inflada, un día más de devengo
    //   prima     2 167.22 →   632.88 (−1 534.34) base calendario en vez de aniversario
    // De los tres defectos, sólo la tabla del art. 76 pagaba de MENOS
    // (+52.74 en este caso); los otros dos pagaban de más sobre una base que
    // no era la del art. 84.
    expect(r.total).toBe('13742.4657');
  });
});

describe('Bordes', () => {
  it('una baja anterior al alta no devenga nada', () => {
    const r = calcularFiniquito({
      fecha_alta: '2026-06-01',
      fecha_baja: '2026-01-15',
      pagado_hasta: '2026-01-01',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    expect(r.aguinaldo_dias_trabajados).toBe(0);
    expect(r.aguinaldo_importe).toBe('0.0000');
    expect(r.prima_vacacional_importe).toBe('0.0000');
  });

  it('si la última nómina va más allá de la baja, no hay salario negativo', () => {
    const r = calcularFiniquito({
      fecha_alta: '2024-01-01',
      fecha_baja: '2026-01-01',
      pagado_hasta: '2026-01-15',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    expect(r.salario_pendiente_dias).toBe(0);
    expect(r.salario_pendiente_importe).toBe('0.0000');
  });

  it('un `Date` de Postgres se lee por su día local, no por su UTC', () => {
    // El driver construye la columna DATE a medianoche LOCAL. Leerla con
    // getUTC* corre la fecha un día en cualquier huso al oeste de Greenwich.
    const comoDate = new Date(2026, 6, 1); // 1 de julio de 2026, local
    const r = calcularFiniquito({
      fecha_alta: comoDate,
      fecha_baja: '2026-12-31',
      pagado_hasta: '2026-12-31',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    expect(r.aguinaldo_dias_trabajados).toBe(184);
  });

  it('las vacaciones pendientes de años cumplidos se pagan a salario diario', () => {
    const r = calcularFiniquito({
      fecha_alta: '2014-07-16',
      fecha_baja: '2026-07-16', // justo el aniversario: 24 días recién devengados
      pagado_hasta: '2026-07-16',
      salario_diario: SD,
      dias_vacaciones_pendientes: 24,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    // 24 × 500 = 12 000.0000
    expect(r.vacaciones_pendientes_importe).toBe('12000.0000');
  });
});
