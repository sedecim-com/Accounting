import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  BASES_SALARIALES,
  CONVENCIONES_VACACIONES,
  calcularProvisionMensual,
  esBaseSalarial,
  esConvencionDeVacaciones,
  esProvisionCero,
  mesDeCalendario,
  tramosDeDevengo,
  type EntradaProvisionMensual,
} from '../../../src/services/accruals/provisions-math.js';
import {
  aFechaUtc,
  calcularFiniquito,
  factorDeIntegracion,
  salarioDiarioDesdeSbc,
} from '../../../src/services/payroll/mx/finiquito-math.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';

// ============================================================
// LA PRUEBA QUE TIENE QUE EXISTIR ANTES DEL PRIMER ASIENTO (D1)
//
// Cada caso de aquí lleva su número calculado A MANO en el comentario, como
// los del finiquito: un rango —`toBeGreaterThan(600)`— no habría delatado
// ninguno de los defectos que este módulo evita, porque los cuatro caen dentro
// del rango. El escalón del art. 76 aplicado al mes entero se equivoca en 25
// pesos sobre 900; el denominador de 365 en un año bisiesto, en 1,63 sobre
// 594; la deriva de doce redondeos independientes, en cuatro diezmilésimas. Un
// rango los deja pasar a los cuatro, y los cuatro acaban en el mayor, que es
// inmutable (041).
// ============================================================

const SD = '500'; // salario diario contratado, NO integrado
const AGUINALDO = 15; // política `dias_aguinaldo`, mínimo LFT art. 87
const PRIMA = '0.25'; // política `prima_vacacional_pct`, mínimo LFT art. 80

/** Un trabajador con antigüedad: alta el 10 de marzo de 2020. */
const veterano = {
  fecha_alta: '2020-03-10',
  salario_diario: SD,
  dias_aguinaldo_por_anio: AGUINALDO,
  prima_vacacional_pct: PRIMA,
} satisfies Omit<EntradaProvisionMensual, 'periodo'>;

const mes = (anio: number, m: number) => mesDeCalendario(anio, m);

const suma = (valores: string[]): string =>
  valores.reduce((acc, v) => acc.plus(v), new Decimal(0)).toFixed(4);

describe('el vocabulario sale del panel, no de la cabeza de nadie', () => {
  const opcionesDe = (clave: string): string[] => {
    const spec = POLICY_CATALOG.find((p) => p.key === clave);
    if (!spec) throw new Error(`El panel no declara la política ${clave}`);
    return spec.options.map((o) => o.value);
  };

  // Si el panel cambia de vocabulario y este módulo no, el motor aceptaría
  // como válido un valor que el catálogo ya no ofrece —o rechazaría uno que sí
  // ofrece— y el operador vería una corrida que falla por un valor que él
  // eligió en una lista.
  it('`provision_base_salarial` declara exactamente las bases que el módulo admite', () => {
    expect(opcionesDe('provision_base_salarial')).toEqual([...BASES_SALARIALES]);
  });

  it('`devengo_vacaciones` declara exactamente las convenciones que el módulo admite', () => {
    expect(opcionesDe('devengo_vacaciones')).toEqual([...CONVENCIONES_VACACIONES]);
  });

  it('las omisiones del módulo son las omisiones del panel', () => {
    const omision = (clave: string) => POLICY_CATALOG.find((p) => p.key === clave)?.defaultValue;
    const sinPoliticas = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 6),
    });
    expect(sinPoliticas.base_salarial).toBe(omision('provision_base_salarial'));
    expect(sinPoliticas.convencion_vacaciones).toBe(omision('devengo_vacaciones'));
  });

  it('los guardas rechazan lo que el panel no ofrece', () => {
    expect(esBaseSalarial('nominal')).toBe(true);
    expect(esBaseSalarial('sbc')).toBe(false);
    expect(esConvencionDeVacaciones('aniversario')).toBe(true);
    expect(esConvencionDeVacaciones('mensual')).toBe(false);
  });
});

describe('el mes, nombrado en cadenas', () => {
  it('febrero de un bisiesto termina el 29', () => {
    expect(mesDeCalendario(2028, 2)).toEqual({
      inicio: '2028-02-01',
      fin: '2028-02-29',
    });
  });

  it('y de uno normal, el 28', () => {
    expect(mesDeCalendario(2025, 2)).toEqual({
      inicio: '2025-02-01',
      fin: '2025-02-28',
    });
  });

  it('un mes que no existe no se calcula', () => {
    expect(() => mesDeCalendario(2025, 13)).toThrow(/de 1 a 12/);
    expect(() => mesDeCalendario(2025, 0)).toThrow(/de 1 a 12/);
  });
});

describe('el mes partido por años de servicio', () => {
  const alta = aFechaUtc('2020-03-10');

  it('el mes del aniversario se parte en dos, y el escalón cambia con él', () => {
    const t = tramosDeDevengo(alta, null, aFechaUtc('2025-03-01'), aFechaUtc('2025-03-31'));
    expect(t).toHaveLength(2);
    // Del 1 al 9 sigue en su quinto año de servicio: 20 días (art. 76).
    expect(t[0].dias).toBe(9);
    expect(t[0].anio_de_servicio).toBe(5);
    expect(t[0].dias_vacaciones_del_anio).toBe(20);
    // El día 10 cumple cinco años y entra en el sexto: 22 días.
    expect(t[1].dias).toBe(22);
    expect(t[1].anio_de_servicio).toBe(6);
    expect(t[1].dias_vacaciones_del_anio).toBe(22);
    // Sin solapes ni huecos: los dos tramos SON el mes.
    expect(t[0].dias + t[1].dias).toBe(31);
    expect(t[1].inicio.getTime() - t[0].fin.getTime()).toBe(86_400_000);
  });

  it('un mes cualquiera es un solo tramo', () => {
    const t = tramosDeDevengo(alta, null, aFechaUtc('2025-06-01'), aFechaUtc('2025-06-30'));
    expect(t).toHaveLength(1);
    expect(t[0].dias).toBe(30);
    expect(t[0].anio_de_servicio).toBe(6);
  });

  it('el alta a mitad de mes recorta el tramo: sólo los días trabajados', () => {
    const t = tramosDeDevengo(
      aFechaUtc('2025-05-10'),
      null,
      aFechaUtc('2025-05-01'),
      aFechaUtc('2025-05-31')
    );
    expect(t).toHaveLength(1);
    expect(t[0].inicio.getUTCDate()).toBe(10);
    expect(t[0].dias).toBe(22); // del 10 al 31, ambos dentro
  });

  it('la baja a mitad de mes corta ahí, y ni un día después', () => {
    const t = tramosDeDevengo(
      alta,
      aFechaUtc('2025-06-15'),
      aFechaUtc('2025-06-01'),
      aFechaUtc('2025-06-30')
    );
    expect(t).toHaveLength(1);
    expect(t[0].fin.getUTCDate()).toBe(15);
    expect(t[0].dias).toBe(15);
  });

  it('alta y baja dentro del mismo mes son once días, no un mes', () => {
    const t = tramosDeDevengo(
      aFechaUtc('2025-05-10'),
      aFechaUtc('2025-05-20'),
      aFechaUtc('2025-05-01'),
      aFechaUtc('2025-05-31')
    );
    expect(t).toHaveLength(1);
    expect(t[0].dias).toBe(11);
  });

  it('sin intersección no hay tramos, y eso no es un error', () => {
    // El mes anterior al alta y el posterior a la baja: una corrida mensual
    // recorre a toda la plantilla histórica y estos dos casos son la mayoría.
    expect(
      tramosDeDevengo(
        aFechaUtc('2025-06-01'),
        null,
        aFechaUtc('2025-05-01'),
        aFechaUtc('2025-05-31')
      )
    ).toEqual([]);
    expect(
      tramosDeDevengo(
        alta,
        aFechaUtc('2025-04-30'),
        aFechaUtc('2025-05-01'),
        aFechaUtc('2025-05-31')
      )
    ).toEqual([]);
  });

  it('el año de servicio que contiene un 29 de febrero dura 366 días', () => {
    // Alta el 1 de junio de 2027: su primer año de servicio va del 2027-06-01
    // al 2028-05-31 y se come el bisiesto.
    const t = tramosDeDevengo(
      aFechaUtc('2027-06-01'),
      null,
      aFechaUtc('2028-02-01'),
      aFechaUtc('2028-02-29')
    );
    expect(t[0].dias_del_anio_de_servicio).toBe(366);
    expect(t[0].dias).toBe(29);
  });

  it('un alta del 29 de febrero cumple años el 1 de marzo en los años no bisiestos', () => {
    // Es la MISMA convención que usa el finiquito. Si divergieran, el escalón
    // cambiaría en días distintos y la diferencia sólo saldría en la baja.
    const t = tramosDeDevengo(
      aFechaUtc('2024-02-29'),
      null,
      aFechaUtc('2025-03-01'),
      aFechaUtc('2025-03-31')
    );
    expect(t).toHaveLength(1);
    expect(t[0].anio_de_servicio).toBe(2);
    expect(t[0].inicio_del_anio_de_servicio.toISOString().slice(0, 10)).toBe('2025-03-01');
  });
});

describe('aguinaldo (LFT art. 87): el ejercicio en el denominador', () => {
  it('un mes entero de un trabajador de planta', () => {
    // 15 días × 500 = 7.500 al año; marzo son 31 de 365 días:
    // 7.500 × 31 / 365 = 636,9863.
    const r = calcularProvisionMensual({ ...veterano, periodo: mes(2025, 3) });
    expect(r.aguinaldo).toBe('636.9863');
    expect(r.dias_devengados).toBe(31);
  });

  it('el alta a mitad de mes devenga los días trabajados, no el mes', () => {
    // Del 10 al 31 de mayo son 22 días: 7.500 × 22 / 365 = 452,0548.
    // El mes entero habría dado 7.500 × 31 / 365 = 636,9863.
    const r = calcularProvisionMensual({
      ...veterano,
      fecha_alta: '2025-05-10',
      periodo: mes(2025, 5),
    });
    expect(r.aguinaldo).toBe('452.0548');
    expect(r.dias_devengados).toBe(22);
  });

  it('la baja a mitad de mes no devenga ni un día después', () => {
    // Del 1 al 15 de junio son 15 días: 7.500 × 15 / 365 = 308,2192.
    const r = calcularProvisionMensual({
      ...veterano,
      fecha_baja: '2025-06-15',
      periodo: mes(2025, 6),
    });
    expect(r.aguinaldo).toBe('308.2192');
    expect(r.dias_devengados).toBe(15);
  });

  it('alta y baja dentro del mismo mes: once días', () => {
    // 7.500 × 11 / 365 = 226,0274.
    const r = calcularProvisionMensual({
      ...veterano,
      fecha_alta: '2025-05-10',
      fecha_baja: '2025-05-20',
      periodo: mes(2025, 5),
    });
    expect(r.dias_devengados).toBe(11);
    expect(r.aguinaldo).toBe('226.0274');
  });

  it('EL AÑO BISIESTO cambia el denominador, y se nota', () => {
    // Febrero de 2028 son 29 días de un ejercicio de 366:
    //   7.500 × 29 / 366 = 594,2623
    // Con el 365 de siempre saldría 595,8904 — 1,63 pesos de más al mes por
    // trabajador, que es exactamente el error que un rango no delata.
    const r = calcularProvisionMensual({ ...veterano, periodo: mes(2028, 2) });
    expect(r.aguinaldo).toBe('594.2623');
    expect(new Decimal(7500).times(29).dividedBy(365).toFixed(4)).toBe('595.8904');
  });

  it('los doce meses del ejercicio suman EXACTAMENTE lo que el finiquito liquida', () => {
    // Ésta es la prueba que hace que la provisión sirva para algo: lo que se
    // provisionó de enero a diciembre tiene que EXTINGUIRSE contra el pago. Si
    // los dos motores no coinciden al centavo, la 2202 queda con un saldo que
    // nadie sabe de quién es y que ningún cierre limpia.
    const alta = '2025-07-01';
    const provisionado = suma(
      Array.from(
        { length: 12 },
        (_, i) =>
          calcularProvisionMensual({
            ...veterano,
            fecha_alta: alta,
            periodo: mes(2025, i + 1),
          }).aguinaldo
      )
    );
    const finiquito = calcularFiniquito({
      fecha_alta: alta,
      // El motivo sólo mueve la prima de antigüedad (T4a); el aguinaldo que
      // este caso compara no depende de él. `renuncia` es lo que usan las
      // demás pruebas de finiquito.
      motivo_baja: 'renuncia' as const,
      fecha_baja: '2025-12-31',
      pagado_hasta: '2025-12-31',
      salario_diario: SD,
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
    });
    // 184 días trabajados: 7.500 × 184 / 365 = 3.780,8219.
    expect(provisionado).toBe('3780.8219');
    expect(finiquito.aguinaldo_importe).toBe(provisionado);
  });
});

describe('vacaciones (LFT art. 76) y prima (art. 80)', () => {
  it('el escalón es el del AÑO DE SERVICIO en curso, no el del año calendario', () => {
    // Junio de 2025, sexto año de servicio: 22 días.
    // 500 × 22 = 11.000 al año; junio son 30 de los 365 días del año de
    // servicio: 11.000 × 30 / 365 = 904,1096.
    const r = calcularProvisionMensual({ ...veterano, periodo: mes(2025, 6) });
    expect(r.tramos[0].dias_vacaciones_del_anio).toBe(22);
    expect(r.vacaciones).toBe('904.1096');
  });

  it('la prima es el porcentaje de lo devengado de vacaciones', () => {
    const r = calcularProvisionMensual({ ...veterano, periodo: mes(2025, 6) });
    expect(r.prima_vacacional).toBe(new Decimal(r.vacaciones).times(PRIMA).toFixed(4));
  });

  it('el año de servicio con 29 de febrero divide entre 366, no entre 365', () => {
    // Alta 2027-06-01: el primer año de servicio dura 366 días.
    // 500 × 12 × 29 / 366 = 475,4098... → 475,4099 por la diferencia de
    // acumulados. Con 365 en el denominador saldrían 476,7123.
    const r = calcularProvisionMensual({
      ...veterano,
      fecha_alta: '2027-06-01',
      periodo: mes(2028, 2),
    });
    expect(r.vacaciones).toBe('475.4099');
    expect(new Decimal(6000).times(29).dividedBy(365).toFixed(4)).toBe('476.7123');
  });
});

describe('EL MES DEL ANIVERSARIO SE PARTE EN DOS, y la suma es el mes entero', () => {
  const marzo = calcularProvisionMensual({
    ...veterano,
    periodo: mes(2025, 3),
  });

  it('cada tramo lleva su propio escalón del art. 76', () => {
    expect(
      marzo.tramos.map((t) => [t.dias, t.anio_de_servicio, t.dias_vacaciones_del_anio])
    ).toEqual([
      [9, 5, 20],
      [22, 6, 22],
    ]);
    // Del 1 al 9, sobre 20 días: 10.000 × 9 / 365 = 246,5753.
    expect(marzo.tramos[0].vacaciones).toBe('246.5753');
    // Del 10 al 31, sobre 22: 11.000 × 22 / 365 = 663,0137.
    expect(marzo.tramos[1].vacaciones).toBe('663.0137');
    expect(marzo.vacaciones).toBe('909.5890');
  });

  it('aplicar UN SOLO escalón a todo el mes se equivoca en las dos direcciones', () => {
    // El escalón nuevo a todo marzo: 11.000 × 31 / 365 = 934,2466 (24,66 de
    // más, regalados). El viejo a todo marzo: 10.000 × 31 / 365 = 849,3151
    // (60,27 de menos, y se los quita a quien más antigüedad tiene, otra vez
    // cada cinco años). La cuenta exacta está entre las dos.
    const soloNuevo = new Decimal(11000).times(31).dividedBy(365).toFixed(4);
    const soloViejo = new Decimal(10000).times(31).dividedBy(365).toFixed(4);
    expect(soloNuevo).toBe('934.2466');
    expect(soloViejo).toBe('849.3151');
    expect(new Decimal(marzo.vacaciones).lessThan(soloNuevo)).toBe(true);
    expect(new Decimal(marzo.vacaciones).greaterThan(soloViejo)).toBe(true);
  });

  it('LA SUMA DE LOS DOS TRAMOS ES EL MES COMPLETO, calculados por separado', () => {
    // La misma ventana partida en dos llamadas tiene que dar lo mismo que una:
    // es lo que garantiza que el reparto no invente ni pierda un centavo, y lo
    // que permite correr un mes a caballo de dos periodos fiscales sin deriva.
    const a = calcularProvisionMensual({
      ...veterano,
      periodo: { inicio: '2025-03-01', fin: '2025-03-09' },
    });
    const b = calcularProvisionMensual({
      ...veterano,
      periodo: { inicio: '2025-03-10', fin: '2025-03-31' },
    });
    expect(suma([a.aguinaldo, b.aguinaldo])).toBe(marzo.aguinaldo);
    expect(suma([a.vacaciones, b.vacaciones])).toBe(marzo.vacaciones);
    expect(suma([a.prima_vacacional, b.prima_vacacional])).toBe(marzo.prima_vacacional);
    expect(suma([a.total, b.total])).toBe(marzo.total);
  });

  it('y también partido por un día cualquiera, no sólo por el aniversario', () => {
    const junio = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 6),
    });
    const a = calcularProvisionMensual({
      ...veterano,
      periodo: { inicio: '2025-06-01', fin: '2025-06-10' },
    });
    const b = calcularProvisionMensual({
      ...veterano,
      periodo: { inicio: '2025-06-11', fin: '2025-06-30' },
    });
    expect(suma([a.total, b.total])).toBe(junio.total);
  });

  it('el total del mes es la suma de sus tres conceptos', () => {
    expect(suma([marzo.aguinaldo, marzo.vacaciones, marzo.prima_vacacional])).toBe(marzo.total);
    expect(marzo.total).toBe('1773.9725');
  });
});

describe('DOCE MESES SUMAN EL ANUAL, sin centavos sueltos', () => {
  // El caso está elegido para que NO divida exacto: 15 días sobre 100 pesos
  // son 1.500 al año y 1.500/365 = 4,109589041... periódico.
  const empleado = {
    fecha_alta: '2024-01-01',
    salario_diario: '100',
    dias_aguinaldo_por_anio: AGUINALDO,
    prima_vacacional_pct: PRIMA,
  } satisfies Omit<EntradaProvisionMensual, 'periodo'>;

  const meses = Array.from({ length: 12 }, (_, i) =>
    calcularProvisionMensual({ ...empleado, periodo: mes(2025, i + 1) })
  );

  it('el aguinaldo del ejercicio da 1.500,0000 exactos', () => {
    expect(suma(meses.map((m) => m.aguinaldo))).toBe('1500.0000');
  });

  it('y doce divisiones independientes NO lo dan: derivan cuatro diezmilésimas', () => {
    // Ésta es la prueba de que la de arriba no es trivial. 1.500 × días/365
    // redondeado doce veces suma 1.500,0004: cuatro diezmilésimas que no son de
    // nadie y que se quedan vivas en la 2202 hasta que alguien las castigue a
    // mano. Es el mismo defecto que la depreciación reparó posteando
    // 2.777,7778 treinta y seis veces para acabar en 100.000,0008.
    const ingenuo = suma(
      Array.from({ length: 12 }, (_, i) => {
        const dias = new Date(Date.UTC(2025, i + 1, 0)).getUTCDate();
        return new Decimal(1500).times(dias).dividedBy(365).toDecimalPlaces(4).toFixed(4);
      })
    );
    expect(ingenuo).toBe('1500.0004');
    expect(ingenuo).not.toBe(suma(meses.map((m) => m.aguinaldo)));
  });

  it('las vacaciones del año de servicio dan su tabla exacta', () => {
    // 2025 es entero el segundo año de servicio (alta el 1 de enero de 2024):
    // 14 días × 100 = 1.400,0000. Y la prima, 350,0000.
    expect(suma(meses.map((m) => m.vacaciones))).toBe('1400.0000');
    expect(suma(meses.map((m) => m.prima_vacacional))).toBe('350.0000');
  });

  it('la exactitud sobrevive a un aniversario a mitad de mes', () => {
    // El quinto año de servicio del veterano va del 2024-03-10 al 2025-03-09 y
    // cruza trece meses de calendario. Sumando SÓLO los tramos de ese año de
    // servicio, el total tiene que ser su tabla completa: 20 × 500 = 10.000.
    const dentro: string[] = [];
    for (const [anio, m] of [
      [2024, 3],
      [2024, 4],
      [2024, 5],
      [2024, 6],
      [2024, 7],
      [2024, 8],
      [2024, 9],
      [2024, 10],
      [2024, 11],
      [2024, 12],
      [2025, 1],
      [2025, 2],
      [2025, 3],
    ] as const) {
      for (const t of calcularProvisionMensual({
        ...veterano,
        periodo: mes(anio, m),
      }).tramos) {
        if (t.anio_de_servicio === 5) dentro.push(t.vacaciones);
      }
    }
    expect(suma(dentro)).toBe('10000.0000');
  });
});

describe('LA CONVENCIÓN DE VACACIONES ES DE PRESENTACIÓN, NO DE IMPORTE', () => {
  const empleado = {
    fecha_alta: '2024-01-01',
    // Un salario que no divide en redondo, para que el reparto tenga que
    // decidir dónde cae el resto.
    salario_diario: '333.33',
    dias_aguinaldo_por_anio: AGUINALDO,
    prima_vacacional_pct: PRIMA,
  } satisfies Omit<EntradaProvisionMensual, 'periodo'>;

  const doceMeses = (convencion: 'proporcional' | 'aniversario') =>
    Array.from({ length: 12 }, (_, i) =>
      calcularProvisionMensual({
        ...empleado,
        periodo: mes(2024, i + 1),
        convencion_vacaciones: convencion,
      })
    );

  // EL TÍTULO DICE «AÑO DE SERVICIO» Y NO «DOCE MESES», y la diferencia no es
  // pedante: este caso usa un alta del 1 de enero, el ÚNICO en que el año de
  // servicio coincide con el calendario. Sobre un año calendario y un alta de
  // julio las dos convenciones reparten distinto —difieren en CUÁNDO, no en
  // cuánto—, así que prometer «doce meses» haría creer que la igualdad vale
  // para cualquier alta. Lo señaló el verificador adversario del tramo.
  it('las dos suman LO MISMO sobre el año de servicio — la prueba de que la bifurcación es honesta', () => {
    // El año de servicio 1 son exactamente los doce meses de 2024, y su tabla
    // son 12 días: 12 × 333,33 = 3.999,96 por las dos vías.
    const p = doceMeses('proporcional');
    const a = doceMeses('aniversario');
    expect(suma(p.map((m) => m.vacaciones))).toBe('3999.9600');
    expect(suma(a.map((m) => m.vacaciones))).toBe('3999.9600');
    expect(suma(p.map((m) => m.prima_vacacional))).toBe(suma(a.map((m) => m.prima_vacacional)));
  });

  it('pero once meses de los doce dicen cosas distintas', () => {
    const a = doceMeses('aniversario');
    // Cero de enero a noviembre y el año entero en diciembre, que es el mes en
    // que el año de servicio queda cumplido.
    expect(a.slice(0, 11).map((m) => m.vacaciones)).toEqual(Array(11).fill('0.0000'));
    expect(a[11].vacaciones).toBe('3999.9600');
    // La proporcional, en cambio, reparte los doce meses.
    const p = doceMeses('proporcional');
    expect(p.every((m) => new Decimal(m.vacaciones).greaterThan(0))).toBe(true);
  });

  it('el aguinaldo NO depende de la convención: la política es sólo de vacaciones', () => {
    const p = doceMeses('proporcional');
    const a = doceMeses('aniversario');
    expect(p.map((m) => m.aguinaldo)).toEqual(a.map((m) => m.aguinaldo));
  });

  it('con el aniversario a mitad de mes, el reconocimiento cae en el tramo que cumple el año', () => {
    // El quinto año del veterano se cumple el 9 de marzo de 2025: 20 × 500.
    const r = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 3),
      convencion_vacaciones: 'aniversario',
    });
    expect(r.tramos[0].vacaciones).toBe('10000.0000');
    expect(r.tramos[1].vacaciones).toBe('0.0000'); // el sexto año aún no se cumple
  });

  it('quien se va antes de cumplir el año no provisiona nada bajo `aniversario`', () => {
    // Consecuencia DECLARADA de la convención, no un descuido: el derecho del
    // art. 76 no se ha consolidado. El finiquito sí pagará la parte
    // proporcional (art. 79), y por eso el panel trae `proporcional` por
    // omisión, que es lo que pide la NIF D-3.
    const aniv = calcularProvisionMensual({
      ...veterano,
      fecha_baja: '2025-06-15',
      periodo: mes(2025, 6),
      convencion_vacaciones: 'aniversario',
    });
    const prop = calcularProvisionMensual({
      ...veterano,
      fecha_baja: '2025-06-15',
      periodo: mes(2025, 6),
    });
    expect(aniv.vacaciones).toBe('0.0000');
    expect(prop.vacaciones).toBe('452.0548'); // 11.000 × 15 / 365
    // Y el aguinaldo es el mismo por las dos vías.
    expect(aniv.aguinaldo).toBe(prop.aguinaldo);
  });
});

describe('la base salarial también es un parámetro', () => {
  it('`nominal` usa el salario contratado tal cual', () => {
    const r = calcularProvisionMensual({ ...veterano, periodo: mes(2025, 6) });
    expect(r.tramos[0].base_diaria).toBe('500.0000');
  });

  it('`integrado` usa el factor que ya existe, con los días de vacaciones del TRAMO', () => {
    // Sexto año: 22 días de vacaciones.
    //   FI = (365 + 15 + 22 × 0,25) / 365 = 385,5 / 365 = 1,0561643836
    //   500 × FI = 528,0822
    const factor = factorDeIntegracion({
      dias_aguinaldo: AGUINALDO,
      dias_vacaciones: 22,
      prima_vacacional_pct: PRIMA,
    });
    const r = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 6),
      base_salarial: 'integrado',
    });
    expect(r.tramos[0].base_diaria).toBe(new Decimal(500).times(factor).toFixed(4));
    expect(r.tramos[0].base_diaria).toBe('528.0822');
    // 528,0822 × 15 × 30 / 365 = 651,0603
    expect(r.aguinaldo).toBe('651.0603');
  });

  it('el integrado provisiona MÁS que el nominal, que es de lo que trata la política', () => {
    const nominal = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 6),
    });
    const integrado = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 6),
      base_salarial: 'integrado',
    });
    expect(new Decimal(integrado.total).greaterThan(nominal.total)).toBe(true);
  });

  it('en el mes del aniversario el factor cambia con el escalón, tramo a tramo', () => {
    const r = calcularProvisionMensual({
      ...veterano,
      periodo: mes(2025, 3),
      base_salarial: 'integrado',
    });
    const fi = (dias: number) =>
      new Decimal(500)
        .times(
          factorDeIntegracion({
            dias_aguinaldo: AGUINALDO,
            dias_vacaciones: dias,
            prima_vacacional_pct: PRIMA,
          })
        )
        .toFixed(4);
    expect(r.tramos[0].base_diaria).toBe(fi(20));
    expect(r.tramos[1].base_diaria).toBe(fi(22));
    expect(r.tramos[0].base_diaria).not.toBe(r.tramos[1].base_diaria);
  });

  it('si el despacho tiene el SBC capturado, ése manda para el integrado', () => {
    const r = calcularProvisionMensual({
      fecha_alta: '2020-03-10',
      sbc: '600',
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
      periodo: mes(2025, 6),
      base_salarial: 'integrado',
    });
    expect(r.tramos[0].base_diaria).toBe('600.0000');
  });

  it('y el nominal se reconstruye des-integrando el SBC, sin cobrar aguinaldo sobre el aguinaldo', () => {
    const prestaciones = {
      dias_aguinaldo: AGUINALDO,
      dias_vacaciones: 22,
      prima_vacacional_pct: PRIMA,
    };
    const r = calcularProvisionMensual({
      fecha_alta: '2020-03-10',
      sbc: '528.0822',
      dias_aguinaldo_por_anio: AGUINALDO,
      prima_vacacional_pct: PRIMA,
      periodo: mes(2025, 6),
    });
    expect(r.tramos[0].base_diaria).toBe(salarioDiarioDesdeSbc('528.0822', prestaciones));
    // Y cierra el círculo: des-integrar el integrado devuelve el contratado.
    expect(r.tramos[0].base_diaria).toBe('500.0000');
  });
});

describe('lo que no se calcula', () => {
  it('un salario NEGATIVO se rechaza: un devengo negativo abona el resultado', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        salario_diario: '-500',
        periodo: mes(2025, 6),
      })
    ).toThrow(/no puede ser negativo/);
  });

  it('un salario CERO devuelve cero, sin parar la corrida de los demás', () => {
    // Un permiso sin goce o una ficha a medio capturar es un renglón en cero
    // que se ve en la cédula; parar el cierre de doscientos trabajadores por
    // una ficha en blanco es peor.
    const r = calcularProvisionMensual({
      ...veterano,
      salario_diario: '0',
      periodo: mes(2025, 6),
    });
    expect(r.total).toBe('0.0000');
    expect(esProvisionCero(r)).toBe(true);
    // Pero los días SÍ se devengaron: el cero es del importe, no del tiempo.
    expect(r.dias_devengados).toBe(30);
    expect(r.tramos).toHaveLength(1);
  });

  it('sin ningún salario no hay base, y una base inventada es un pasivo inventado', () => {
    expect(() =>
      calcularProvisionMensual({
        fecha_alta: '2020-03-10',
        dias_aguinaldo_por_anio: AGUINALDO,
        prima_vacacional_pct: PRIMA,
        periodo: mes(2025, 6),
      })
    ).toThrow(/necesita un salario/);
  });

  it('un salario que no es un número se rechaza con su nombre', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        salario_diario: 'quinientos',
        periodo: mes(2025, 6),
      })
    ).toThrow(/salario_diario tiene que ser un número/);
  });

  it('un salario infinito o un dato que no es número tampoco calculan', () => {
    // `Decimal` acepta 'Infinity' y 'NaN' sin protestar —son valores legítimos
    // suyos— y los propaga hasta el importe: una provisión de `Infinity` pasa
    // el redondeo a cuatro decimales y llega a la columna como una cadena que
    // Postgres rechaza a mitad de la corrida, con la transacción ya abierta.
    // Se paran aquí, donde el mensaje todavía puede decir de qué campo se
    // trata.
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        salario_diario: 'Infinity',
        periodo: mes(2025, 6),
      })
    ).toThrow(/salario_diario tiene que ser finito/);
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        dias_aguinaldo_por_anio: Number.NaN,
        periodo: mes(2025, 6),
      })
    ).toThrow(/dias_aguinaldo_por_anio tiene que ser finito/);
  });

  it('días de aguinaldo o prima negativos se rechazan igual', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        dias_aguinaldo_por_anio: -15,
        periodo: mes(2025, 6),
      })
    ).toThrow(/dias_aguinaldo_por_anio no puede ser negativo/);
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        prima_vacacional_pct: '-0.25',
        periodo: mes(2025, 6),
      })
    ).toThrow(/prima_vacacional_pct no puede ser negativo/);
  });

  it('una baja anterior al alta se rechaza en vez de devengar al revés', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        fecha_baja: '2019-01-01',
        periodo: mes(2025, 6),
      })
    ).toThrow(/anterior al alta/);
  });

  it('un periodo invertido se rechaza', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        periodo: { inicio: '2025-06-30', fin: '2025-06-01' },
      })
    ).toThrow(/no puede terminar antes de empezar/);
  });

  it('un periodo a caballo de dos ejercicios se rechaza: tendría dos denominadores', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        periodo: { inicio: '2025-12-01', fin: '2026-01-31' },
      })
    ).toThrow(/cruza el fin de ejercicio/);
  });

  it('una base o una convención que el panel no ofrece no calculan nada', () => {
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        periodo: mes(2025, 6),
        base_salarial: 'sbc' as never,
      })
    ).toThrow(/Base salarial desconocida/);
    expect(() =>
      calcularProvisionMensual({
        ...veterano,
        periodo: mes(2025, 6),
        convencion_vacaciones: 'mensual' as never,
      })
    ).toThrow(/Convención de devengo de vacaciones desconocida/);
  });

  it('un mes sin relación laboral devuelve cero, y no un error', () => {
    const r = calcularProvisionMensual({
      ...veterano,
      fecha_alta: '2025-07-01',
      periodo: mes(2025, 6),
    });
    expect(r.dias_devengados).toBe(0);
    expect(r.tramos).toEqual([]);
    expect(r.total).toBe('0.0000');
    expect(esProvisionCero(r)).toBe(true);
  });
});
