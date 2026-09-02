import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  CONVENCIONES_AMORTIZACION,
  calcularAmortizacion,
  diasDeCobertura,
  esConvencionDeAmortizacion,
  esImporteCero,
  metadatosDeAmortizacion,
  ventanasMensuales,
  type AmortizationResult,
} from '../../../src/services/accruals/amortization-math.js';

/**
 * LA ARITMÉTICA DEL DEVENGO, SIN POSTGRES DETRÁS.
 *
 * La 1160 lleva sembrada desde el principio con la descripción «se devengan
 * mes a mes» y no había tabla, ni motor, ni un solo renglón. Cada caso de aquí
 * —los trece renglones de una póliza que arranca el día 20, los mil pesos que
 * tienen que sumar mil y no 999,9999, el anticipo de un solo día— habría
 * necesitado sembrar una entidad, un catálogo de cuentas, un ejercicio con sus
 * periodos y un asiento posteado para preguntar algo que es una división.
 * Escritos así cuestan cuatro líneas, y por eso están escritos ANTES de la
 * primera fila y no después: el mayor es inmutable (041), y reparar una
 * aritmética que ya posteó deja de ser una edición.
 */

const dia = (a: number, m: number, d: number) => new Date(a, m - 1, d);

const suma = (filas: AmortizationResult[]): string =>
  filas.reduce((acc, f) => acc.plus(f.amortization_amount), new Decimal(0)).toFixed(4);

const sumaDias = (filas: AmortizationResult[]): number =>
  filas.reduce((acc, f) => acc + f.days_covered, 0);

describe('los días de una ventana, con los dos extremos dentro', () => {
  it('del 20 al 31 son doce días, no once', () => {
    expect(diasDeCobertura(dia(2026, 3, 20), dia(2026, 3, 31))).toBe(12);
  });

  it('un solo día es un día', () => {
    expect(diasDeCobertura(dia(2026, 1, 15), dia(2026, 1, 15))).toBe(1);
  });

  it('un año no bisiesto son 365 y uno bisiesto 366', () => {
    expect(diasDeCobertura(dia(2026, 1, 1), dia(2026, 12, 31))).toBe(365);
    expect(diasDeCobertura(dia(2028, 1, 1), dia(2028, 12, 31))).toBe(366);
  });

  it('cuenta bien el 29 de febrero de un bisiesto', () => {
    expect(diasDeCobertura(dia(2028, 2, 1), dia(2028, 2, 29))).toBe(29);
  });
});

describe('el reparto de la ventana en meses', () => {
  it('por días recorta la ventana REAL: el primer mes empieza el día 20', () => {
    const v = ventanasMensuales(dia(2026, 3, 20), dia(2027, 3, 19), 'proporcional_dias');
    // Trece meses tocados: marzo del primer año, once enteros, marzo del segundo.
    expect(v).toHaveLength(13);
    expect(v[0].dias).toBe(12);
    expect(v[0].cobertura_inicio.getDate()).toBe(20);
    expect(v[1].dias).toBe(30); // abril entero
    expect(v[12].dias).toBe(19);
    expect(v[12].cobertura_fin.getDate()).toBe(19);
    expect(v.reduce((a, w) => a + w.dias, 0)).toBe(365);
  });

  it('por meses completos tira la cola parcial y cada renglón cubre su mes entero', () => {
    const v = ventanasMensuales(dia(2026, 3, 20), dia(2027, 3, 19), 'meses_completos');
    expect(v).toHaveLength(12);
    // El mes de arranque devenga ENTERO, aunque la póliza empezara el día 20.
    expect(v[0].cobertura_inicio.getDate()).toBe(1);
    expect(v[0].dias).toBe(31);
    // Y el último es febrero, no el marzo parcial del año siguiente.
    expect(v[11].mes_inicio.getMonth()).toBe(1);
    expect(v[11].dias).toBe(28);
  });

  it('NO tira la cola parcial cuando es lo único que hay', () => {
    // Un anticipo del 15 al 20 de enero devenga en enero o no devenga nunca:
    // quitarle su único renglón lo dejaría en el activo para siempre, que es
    // exactamente el defecto que este módulo vino a cerrar.
    const v = ventanasMensuales(dia(2026, 1, 15), dia(2026, 1, 20), 'meses_completos');
    expect(v).toHaveLength(1);
    expect(v[0].dias).toBe(31);
  });

  it('conserva la cola cuando la cobertura termina justo el último día del mes', () => {
    const v = ventanasMensuales(dia(2026, 1, 1), dia(2026, 12, 31), 'meses_completos');
    expect(v).toHaveLength(12);
  });
});

describe('el arranque a mitad de mes', () => {
  const alta = { importe: '120000.0000', inicio: dia(2026, 3, 20), fin: dia(2027, 3, 19) };

  it('por días, el primer mes cobra sólo los doce días que cubre', () => {
    const filas = calcularAmortizacion({ ...alta, convencion: 'proporcional_dias' });
    expect(filas).toHaveLength(13);
    // 120.000 × 12/365 = 3.945,2054794…
    expect(filas[0].amortization_amount).toBe('3945.2055');
    expect(filas[0].days_covered).toBe(12);
    // Y un mes entero de por medio: 120.000 × 30/365.
    expect(filas[1].amortization_amount).toBe('9863.0137');
    expect(suma(filas)).toBe('120000.0000');
  });

  it('por meses completos, el mes de arranque devenga entero y son doce renglones', () => {
    const filas = calcularAmortizacion({ ...alta, convencion: 'meses_completos' });
    expect(filas).toHaveLength(12);
    expect(filas.every((f) => f.amortization_amount === '10000.0000')).toBe(true);
    expect(suma(filas)).toBe('120000.0000');
  });

  it('las dos convenciones reparten el MISMO total: sólo cambia qué mes carga cada peso', () => {
    const porDias = calcularAmortizacion({ ...alta, convencion: 'proporcional_dias' });
    const porMeses = calcularAmortizacion({ ...alta, convencion: 'meses_completos' });
    expect(suma(porDias)).toBe(suma(porMeses));
    // Lo que cambia es dónde cae el gasto, y cambia de verdad.
    expect(porDias[0].amortization_amount).not.toBe(porMeses[0].amortization_amount);
    expect(porDias).toHaveLength(porMeses.length + 1);
  });

  it('por días, la convención por defecto es la proporcional (NIF A-2)', () => {
    const conDefecto = calcularAmortizacion(alta);
    const explicita = calcularAmortizacion({ ...alta, convencion: 'proporcional_dias' });
    expect(conDefecto).toEqual(explicita);
  });
});

describe('un año exacto', () => {
  it('del 1 de enero al 31 de diciembre son doce renglones y ninguno parcial', () => {
    const filas = calcularAmortizacion({
      importe: '120000.0000',
      inicio: dia(2026, 1, 1),
      fin: dia(2026, 12, 31),
      convencion: 'proporcional_dias',
    });
    expect(filas).toHaveLength(12);
    expect(sumaDias(filas)).toBe(365);
    // Enero tiene 31 de 365 días: 120.000 × 31/365 = 10.191,7808219…
    expect(filas[0].amortization_amount).toBe('10191.7808');
    // Febrero, 28: menos gasto en febrero que en enero. Es la diferencia
    // entera entre las dos convenciones, vista en dos renglones.
    expect(filas[1].amortization_amount).toBe('9205.4795');
    expect(suma(filas)).toBe('120000.0000');
  });

  it('por meses completos, doce renglones idénticos', () => {
    const filas = calcularAmortizacion({
      importe: '120000.0000',
      inicio: dia(2026, 1, 1),
      fin: dia(2026, 12, 31),
      convencion: 'meses_completos',
    });
    expect(filas.map((f) => f.amortization_amount)).toEqual(Array(12).fill('10000.0000'));
  });

  it('un año bisiesto reparte sobre 366 días', () => {
    const filas = calcularAmortizacion({
      importe: '366000.0000',
      inicio: dia(2028, 1, 1),
      fin: dia(2028, 12, 31),
      convencion: 'proporcional_dias',
    });
    expect(sumaDias(filas)).toBe(366);
    // Mil pesos por día: febrero de 2028 tiene 29.
    expect(filas[1].amortization_amount).toBe('29000.0000');
    expect(suma(filas)).toBe('366000.0000');
  });
});

describe('un periodo de un solo día', () => {
  it('produce UN renglón que se lleva el importe entero', () => {
    const filas = calcularAmortizacion({
      importe: '5000.0000',
      inicio: dia(2026, 1, 15),
      fin: dia(2026, 1, 15),
      convencion: 'proporcional_dias',
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].amortization_amount).toBe('5000.0000');
    expect(filas[0].days_covered).toBe(1);
    expect(filas[0].remaining_balance).toBe('0.0000');
    expect(filas[0].indice_calendario).toBe(0);
  });

  it('también con la convención de meses completos, que no puede tirar su único renglón', () => {
    const filas = calcularAmortizacion({
      importe: '5000.0000',
      inicio: dia(2026, 1, 15),
      fin: dia(2026, 1, 15),
      convencion: 'meses_completos',
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].amortization_amount).toBe('5000.0000');
  });
});

describe('la suma tiene que cuadrar al centavo (el defecto C, aquí antes de que ocurra)', () => {
  it('mil pesos en tres meses: 333,3333 · 333,3333 · 333,3334', () => {
    // Sin tapón, tres veces 333,3333 dan 999,9999 y falta una diezmilésima
    // que no es de nadie. Con tapón, el resto cae en el último renglón, una
    // sola vez, y se ve.
    const filas = calcularAmortizacion({
      importe: '1000.0000',
      inicio: dia(2026, 1, 1),
      fin: dia(2026, 3, 31),
      convencion: 'meses_completos',
    });
    expect(filas.map((f) => f.amortization_amount)).toEqual([
      '333.3333',
      '333.3333',
      '333.3334',
    ]);
    expect(suma(filas)).toBe('1000.0000');
  });

  it('cien pesos por días sobre un trimestre: el resto cae en el último renglón', () => {
    const filas = calcularAmortizacion({
      importe: '100.0000',
      inicio: dia(2026, 1, 1),
      fin: dia(2026, 3, 31),
      convencion: 'proporcional_dias',
    });
    expect(filas.map((f) => f.amortization_amount)).toEqual(['34.4444', '31.1111', '34.4445']);
    expect(suma(filas)).toBe('100.0000');
  });

  it('cuadra al centavo en las dos convenciones y en importes que no se dividen bien', () => {
    const importes = ['1000.0000', '999.9999', '7.0000', '123456.7891', '0.0003'];
    const ventanas: Array<[Date, Date]> = [
      [dia(2026, 1, 1), dia(2026, 12, 31)],
      [dia(2026, 3, 20), dia(2027, 3, 19)],
      [dia(2026, 2, 14), dia(2026, 8, 13)],
      [dia(2026, 11, 30), dia(2027, 1, 1)],
    ];
    for (const importe of importes) {
      for (const [inicio, fin] of ventanas) {
        for (const convencion of CONVENCIONES_AMORTIZACION) {
          const filas = calcularAmortizacion({ importe, inicio, fin, convencion });
          expect(suma(filas), `${importe} ${convencion}`).toBe(new Decimal(importe).toFixed(4));
          // Y ningún renglón negativo por el camino: la 059 lo prohíbe con un
          // CHECK, y aquí se comprueba antes de que Postgres tenga que hacerlo.
          expect(filas.every((f) => new Decimal(f.amortization_amount).greaterThanOrEqualTo(0))).toBe(
            true
          );
        }
      }
    }
  });

  it('el acumulado y el saldo restante cierran renglón a renglón', () => {
    const filas = calcularAmortizacion({
      importe: '50000.0000',
      inicio: dia(2026, 5, 10),
      fin: dia(2027, 5, 9),
      convencion: 'proporcional_dias',
    });
    let acumulado = new Decimal(0);
    for (const f of filas) {
      acumulado = acumulado.plus(f.amortization_amount);
      expect(f.accumulated_amortization).toBe(acumulado.toFixed(4));
      expect(f.remaining_balance).toBe(new Decimal('50000').minus(acumulado).toFixed(4));
    }
    expect(filas[filas.length - 1].remaining_balance).toBe('0.0000');
  });
});

describe('el índice del calendario indexa el calendario', () => {
  it('cada renglón está en la posición que dice su índice', () => {
    const filas = calcularAmortizacion({
      importe: '120000.0000',
      inicio: dia(2026, 3, 20),
      fin: dia(2027, 3, 19),
      convencion: 'proporcional_dias',
    });
    filas.forEach((f, i) => {
      expect(f.indice_calendario).toBe(i);
      expect(f.period_number).toBe(i + 1);
    });
    // Y los meses avanzan de uno en uno, sin repetir febrero como hacía el
    // índice que dividía milisegundos entre 30,44 días.
    expect(filas.map((f) => f.period_start_date.getMonth())).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2,
    ]);
    expect(filas[0].period_start_date.getFullYear()).toBe(2026);
    expect(filas[12].period_start_date.getFullYear()).toBe(2027);
  });

  it('el último día del mes es el último día del mes, también en febrero', () => {
    const filas = calcularAmortizacion({
      importe: '3000.0000',
      inicio: dia(2026, 1, 1),
      fin: dia(2026, 3, 31),
      convencion: 'proporcional_dias',
    });
    expect(filas[1].period_end_date.getDate()).toBe(28);
    expect(filas[2].period_end_date.getDate()).toBe(31);
  });
});

describe('lo que se niega a calcular', () => {
  it('una cobertura que termina antes de empezar', () => {
    expect(() =>
      calcularAmortizacion({
        importe: '1000.0000',
        inicio: dia(2026, 6, 1),
        fin: dia(2026, 5, 31),
      })
    ).toThrow(/no puede terminar antes de empezar/);
  });

  it('un importe de cero', () => {
    expect(() =>
      calcularAmortizacion({ importe: '0', inicio: dia(2026, 1, 1), fin: dia(2026, 12, 31) })
    ).toThrow(/importe positivo/);
  });

  it('un importe negativo, que sería una nota de crédito disfrazada', () => {
    expect(() =>
      calcularAmortizacion({ importe: '-500', inicio: dia(2026, 1, 1), fin: dia(2026, 12, 31) })
    ).toThrow(/reversa/);
  });
});

describe('el vocabulario de la convención', () => {
  it('reconoce las dos del panel y rechaza cualquier otra', () => {
    expect(esConvencionDeAmortizacion('proporcional_dias')).toBe(true);
    expect(esConvencionDeAmortizacion('meses_completos')).toBe(true);
    // La política hermana de la depreciación dice `mes_completo` en singular:
    // es el error de tecleo más fácil de cometer entre estos dos módulos, y
    // tiene que rebotar en vez de elegir un recorte en silencio.
    expect(esConvencionDeAmortizacion('mes_completo')).toBe(false);
    expect(esConvencionDeAmortizacion('')).toBe(false);
  });
});

describe('lo que queda escrito de cada renglón', () => {
  it('anota la convención congelada, la del panel, y si coinciden', () => {
    const m = metadatosDeAmortizacion({
      convencion: 'proporcional_dias',
      convencionDelPanel: 'meses_completos',
      convencionDefinida: true,
      indice: 3,
      periodos: 13,
      diasCubiertos: 30,
      importeTotal: '120000.0000',
      cobertura: { inicio: dia(2026, 3, 20), fin: dia(2027, 3, 19) },
    });
    expect(m.convencion).toBe('proporcional_dias');
    expect(m.cobertura_inicio).toBe('2026-03-20');
    expect(m.cobertura_fin).toBe('2027-03-19');
    const politicas = m.politicas as Record<string, Record<string, unknown>>;
    expect(politicas.amortizacion_anticipados_convencion.coincide).toBe(false);
    expect(politicas.amortizacion_anticipados_convencion.valor_del_panel).toBe('meses_completos');
  });

  it('sólo anota el tope por saldo cuando lo hubo', () => {
    const base = {
      convencion: 'proporcional_dias' as const,
      convencionDelPanel: 'proporcional_dias' as const,
      convencionDefinida: false,
      indice: 0,
      periodos: 12,
      diasCubiertos: 31,
      importeTotal: '1200.0000',
      cobertura: { inicio: dia(2026, 1, 1), fin: dia(2026, 12, 31) },
    };
    expect(metadatosDeAmortizacion(base)).not.toHaveProperty('topado_por_saldo_restante');
    expect(metadatosDeAmortizacion({ ...base, topadoPorSaldo: '100.0000' })).toHaveProperty(
      'topado_por_saldo_restante',
      '100.0000'
    );
  });

  it('la fecha se imprime por componentes LOCALES, no por el día UTC', () => {
    // Con `toISOString`, la medianoche local del 1 de enero en un huso al este
    // de Greenwich se imprime como el 31 de diciembre del año anterior.
    const m = metadatosDeAmortizacion({
      convencion: 'meses_completos',
      convencionDelPanel: 'meses_completos',
      convencionDefinida: true,
      indice: 0,
      periodos: 1,
      diasCubiertos: 31,
      importeTotal: '10.0000',
      cobertura: { inicio: dia(2026, 1, 1), fin: dia(2026, 1, 31) },
    });
    expect(m.cobertura_inicio).toBe('2026-01-01');
  });
});

describe('el importe que no mueve nada', () => {
  it('reconoce el cero escrito de las cuatro maneras', () => {
    expect(esImporteCero('0')).toBe(true);
    expect(esImporteCero('0.0000')).toBe(true);
    expect(esImporteCero('-0')).toBe(true);
    expect(esImporteCero('0.0001')).toBe(false);
  });
});
