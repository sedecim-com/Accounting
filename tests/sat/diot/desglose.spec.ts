import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  acumuladoDelDocumento,
  baseDelDesglose,
  clasificarRenglon,
  desglosarDocumento,
  desgloseCero,
  ivaDelDesglose,
  porcionDelDocumento,
  repartirProporcional,
  sumarDesgloses,
  type PorcionPagada,
  type RenglonDeGasto,
} from '../../../src/services/sat/diot/desglose.js';

// ============================================================
// F07c · EL DESGLOSE POR TASA, SIN POSTGRES
//
// Todo lo de aquí es aritmética y clasificación, y por eso no hay una entidad
// sembrada en el archivo. Lo que sí necesita la base —que el IVA que entra
// como «pagado» sea el que el mayor movió de verdad— está en
// tests/integration/f07c-*.
// ============================================================

const renglon = (o: Partial<RenglonDeGasto> = {}): RenglonDeGasto => ({
  tipoFactor: 'tasa',
  tasa: '16.00',
  valorActos: null,
  importe: '1000.0000',
  iva: '160.0000',
  ...o,
});

const pagoCompleto = (total: string): PorcionPagada => ({
  aplicadoPrevio: '0',
  aplicadoAhora: total,
  totalDocumento: total,
});

describe('clasificarRenglon', () => {
  it('manda cada tasa declarada a su casilla', () => {
    expect(clasificarRenglon(renglon({ tasa: '16.00' })).clave).toBe('tasa16');
    expect(clasificarRenglon(renglon({ tasa: '8.00', iva: '80.0000' })).clave).toBe('tasa8');
    expect(clasificarRenglon(renglon({ tasa: '0.00', iva: '0.0000' })).clave).toBe('tasa0');
  });

  it('el EXENTO va a su casilla y no al 0 %, que es otra cosa', () => {
    // Los dos llevan cero de impuesto. Sin `tipo_factor` serían el mismo
    // renglón, que es justo lo que la 063 vino a arreglar.
    expect(clasificarRenglon(renglon({ tipoFactor: 'exento', tasa: null, iva: '0.0000' })).clave)
      .toBe('exento');
    expect(clasificarRenglon(renglon({ tipoFactor: 'tasa', tasa: '0.00', iva: '0.0000' })).clave)
      .toBe('tasa0');
  });

  it('una tasa fuera del catálogo NUNCA se pliega al 16 %', () => {
    const c = clasificarRenglon(renglon({ tasa: '11.00', iva: '110.0000' }));
    expect(c.clave).toBe('otras:11.00');
    expect(c.etiqueta).toBe('11.00');
  });

  it('el 8 % de la región fronteriza tiene casilla propia', () => {
    // El paso 5 de la lista de comprobación de la casa: «verify they are not
    // mixed into the 16% bucket». Es la comprobación entera.
    const c = clasificarRenglon(renglon({ tasa: '8.00', iva: '80.0000' }));
    expect(c.clave).toBe('tasa8');
    expect(c.clave).not.toBe('tasa16');
  });

  it('mide la tasa cuando bill_lines.tax_rate viene NULL (todo lo anterior a la 063)', () => {
    const c = clasificarRenglon(renglon({ tasa: null, importe: '1000.0000', iva: '160.0000' }));
    expect(c).toMatchObject({ clave: 'tasa16', medida: true });
  });

  it('la medición tolera el redondeo a centavos del CFDI', () => {
    // 33.33 × 16 % = 5.3328, y el comprobante declara 5.33.
    const c = clasificarRenglon(renglon({ tasa: null, importe: '33.3300', iva: '5.3300' }));
    expect(c).toMatchObject({ clave: 'tasa16', medida: true });
  });

  it('lo que no reproduce ninguna tasa del catálogo se nombra, no se acomoda', () => {
    const c = clasificarRenglon(renglon({ tasa: null, importe: '1000.0000', iva: '123.4500' }));
    expect(c.clave).toBe('otras:12.35');
    expect(c.medida).toBe(true);
  });

  it('el tipo de factor «cuota» no es del IVA y se nombra aparte', () => {
    expect(clasificarRenglon(renglon({ tipoFactor: 'cuota' })).etiqueta).toBe('cuota');
  });
});

describe('repartirProporcional', () => {
  it('la suma de las partes es EXACTAMENTE el total, con residuo y todo', () => {
    // 100 entre tres pesos iguales: 33.3333 tres veces son 99.9999.
    const r = repartirProporcional('100.0000', [
      { clave: 'a', peso: '1' },
      { clave: 'b', peso: '1' },
      { clave: 'c', peso: '1' },
    ]);
    const suma = [...r.values()].reduce((a, v) => a.plus(v), new Decimal(0));
    expect(suma.toFixed(4)).toBe('100.0000');
  });

  it('el residuo cae en la casilla de mayor peso, siempre en la misma', () => {
    const uno = repartirProporcional('10.0000', [
      { clave: 'chica', peso: '1' },
      { clave: 'grande', peso: '2' },
    ]);
    const otro = repartirProporcional('10.0000', [
      { clave: 'chica', peso: '1' },
      { clave: 'grande', peso: '2' },
    ]);
    expect(uno.get('grande')).toBe(otro.get('grande'));
    expect(new Decimal(uno.get('chica')!).plus(uno.get('grande')!).toFixed(4)).toBe('10.0000');
  });

  it('sin pesos positivos no reparte nada, en vez de dividir entre cero', () => {
    const r = repartirProporcional('10.0000', [{ clave: 'a', peso: '0' }]);
    expect(r.get('a')).toBe('0.0000');
  });
});

describe('porcionDelDocumento', () => {
  it('telescopa: la suma de los tramos reproduce el total exacto', () => {
    const total = '1160.0000';
    const base = '1000.0000';
    const tramos = ['400.0000', '400.0000', '360.0000'];
    let previo = new Decimal(0);
    let suma = new Decimal(0);
    for (const t of tramos) {
      suma = suma.plus(
        porcionDelDocumento(base, {
          aplicadoPrevio: previo.toFixed(4),
          aplicadoAhora: t,
          totalDocumento: total,
        })
      );
      previo = previo.plus(t);
    }
    expect(suma.toFixed(4)).toBe('1000.0000');
  });

  it('convierte a moneda funcional con la tasa histórica del documento', () => {
    const p: PorcionPagada = {
      aplicadoPrevio: '0',
      aplicadoAhora: '116.0000',
      totalDocumento: '116.0000',
      tasaCambio: '20.0000',
    };
    expect(porcionDelDocumento('100.0000', p)).toBe('2000.0000');
  });

  it('en moneda extranjera también telescopa: se restan acumulados, no tramos', () => {
    // Es la corrección de R4. Convertir cada tramo y redondear por separado
    // acumulaba diezmilésimos de más y dejaba la 1135 en negativo.
    const total = '1160.0000';
    const tasa = '17.1234';
    let previo = new Decimal(0);
    let suma = new Decimal(0);
    for (const t of ['333.0000', '333.0000', '494.0000']) {
      suma = suma.plus(
        porcionDelDocumento('160.0000', {
          aplicadoPrevio: previo.toFixed(4),
          aplicadoAhora: t,
          totalDocumento: total,
          tasaCambio: tasa,
        })
      );
      previo = previo.plus(t);
    }
    expect(suma.toFixed(4)).toBe(acumuladoDelDocumento('160.0000', total, total, tasa));
  });

  it('prorratea el IVA RETENIDO igual que todo lo demás', () => {
    // La retención vive en el CFDI completo; en un gasto pagado a medias sólo
    // se ha enterado la mitad. Que use el mismo repartidor es lo que impide
    // que la base vaya al 50 % y la retención al 100 %.
    const mitad = porcionDelDocumento('80.0000', {
      aplicadoPrevio: '0',
      aplicadoAhora: '580.0000',
      totalDocumento: '1160.0000',
    });
    expect(mitad).toBe('40.0000');
  });
});

describe('desglosarDocumento', () => {
  const doc = { documentId: 'b1', documentNumber: 'BILL-001' };

  it('reparte el 16 %, el 0 % y lo exento en tres casillas distintas', () => {
    const r = desglosarDocumento({
      ...doc,
      renglones: [
        renglon({ tasa: '16.00', importe: '1000.0000', iva: '160.0000' }),
        renglon({ tasa: '0.00', importe: '500.0000', iva: '0.0000' }),
        renglon({ tipoFactor: 'exento', tasa: null, importe: '300.0000', iva: '0.0000', valorActos: '300.0000' }),
      ],
      ivaCabecera: '160.0000',
      ivaPagado: '160.0000',
      porcion: pagoCompleto('1960.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos.filter((h) => h.severidad === 'bloqueante')).toHaveLength(0);
    expect(r.desglose.tasa16).toEqual({ base: '1000.0000', iva: '160.0000' });
    expect(r.desglose.tasa0).toEqual({ base: '500.0000', iva: '0.0000' });
    expect(r.desglose.exento).toEqual({ base: '300.0000', iva: '0.0000' });
    expect(ivaDelDesglose(r.desglose)).toBe('160.0000');
    expect(baseDelDesglose(r.desglose)).toBe('1800.0000');
  });

  it('la suma de las casillas es lo que el MAYOR movió, no lo que la tasa daría', () => {
    // El mayor sólo liberó 100 de los 160 del documento (tope de lo aparcado,
    // por ejemplo). Las casillas dicen cómo se compone ese 100, y suman 100.
    const r = desglosarDocumento({
      ...doc,
      renglones: [
        renglon({ tasa: '16.00', importe: '1000.0000', iva: '160.0000' }),
        renglon({ tasa: '8.00', importe: '1000.0000', iva: '80.0000' }),
      ],
      ivaCabecera: '240.0000',
      ivaPagado: '100.0000',
      porcion: pagoCompleto('2240.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(ivaDelDesglose(r.desglose)).toBe('100.0000');
    expect(r.desglose.tasa16.iva).toBe('66.6667');
    expect(r.desglose.tasa8.iva).toBe('33.3333');
  });

  it('un pago parcial prorratea la base y no sólo el impuesto', () => {
    const r = desglosarDocumento({
      ...doc,
      renglones: [renglon({ tasa: '16.00', importe: '1000.0000', iva: '160.0000' })],
      ivaCabecera: '160.0000',
      ivaPagado: '80.0000',
      porcion: { aplicadoPrevio: '0', aplicadoAhora: '580.0000', totalDocumento: '1160.0000' },
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.desglose.tasa16).toEqual({ base: '500.0000', iva: '80.0000' });
  });

  it('BLOQUEA cuando la cabecera y los renglones no dicen el mismo IVA', () => {
    // El importe acreditado sale de la cabecera y el reparto de los
    // renglones: con esa diferencia el desglose es una ficción bien formada.
    const r = desglosarDocumento({
      ...doc,
      renglones: [renglon({ iva: '160.0000' })],
      ivaCabecera: '190.0000',
      ivaPagado: '190.0000',
      porcion: pagoCompleto('1190.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-IVA-CABECERA');
    expect(ivaDelDesglose(r.desglose)).toBe('0.0000');
  });

  it('BLOQUEA un renglón exento que trae impuesto', () => {
    const r = desglosarDocumento({
      ...doc,
      renglones: [renglon({ tipoFactor: 'exento', tasa: null, iva: '160.0000', valorActos: '1000.0000' })],
      ivaCabecera: '160.0000',
      ivaPagado: '160.0000',
      porcion: pagoCompleto('1160.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-EXENTO-CON-IVA');
  });

  describe('la base exenta que el documento no trajo · diot_iva_exento_y_base', () => {
    const entrada = (politica: 'exigir_base' | 'derivar_del_subtotal' | 'omitir_y_avisar') => ({
      ...doc,
      renglones: [
        renglon({ tipoFactor: 'exento', tasa: null, importe: '300.0000', iva: '0.0000', valorActos: null }),
      ],
      ivaCabecera: '0.0000',
      ivaPagado: '0.0000',
      porcion: pagoCompleto('300.0000'),
      politicaBaseExenta: politica,
    });

    it('exigir_base: se niega y nombra el documento', () => {
      const r = desglosarDocumento(entrada('exigir_base'));
      const h = r.hallazgos.find((x) => x.codigo === 'DIOT-BASE-EXENTA-DESCONOCIDA');
      expect(h?.severidad).toBe('bloqueante');
      expect(h?.mensaje).toContain('BILL-001');
      expect(r.desglose.exento.base).toBe('0.0000');
    });

    it('derivar_del_subtotal: la declara y avisa de que la derivó', () => {
      const r = desglosarDocumento(entrada('derivar_del_subtotal'));
      expect(r.desglose.exento.base).toBe('300.0000');
      expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-BASE-EXENTA-DERIVADA');
      expect(r.hallazgos.every((h) => h.severidad === 'aviso')).toBe(true);
    });

    it('omitir_y_avisar: la deja fuera y dice cuánto falta', () => {
      const r = desglosarDocumento(entrada('omitir_y_avisar'));
      expect(r.desglose.exento.base).toBe('0.0000');
      expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-BASE-EXENTA-OMITIDA');
    });

    it('las tres políticas dan tres resultados distintos', () => {
      const bases = (['exigir_base', 'derivar_del_subtotal', 'omitir_y_avisar'] as const).map(
        (p) => desglosarDocumento(entrada(p))
      );
      expect(new Set(bases.map((b) => b.hallazgos[0]?.codigo)).size).toBe(3);
    });
  });

  it('avisa cuando la tasa se midió, para que nadie firme sin saberlo', () => {
    const r = desglosarDocumento({
      ...doc,
      renglones: [renglon({ tasa: null, importe: '1000.0000', iva: '160.0000' })],
      ivaCabecera: '160.0000',
      ivaPagado: '160.0000',
      porcion: pagoCompleto('1160.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-TASA-MEDIDA');
    expect(r.desglose.tasa16.iva).toBe('160.0000');
  });
});

describe('sumarDesgloses', () => {
  it('suma casilla por casilla y une las tasas fuera de catálogo por etiqueta', () => {
    const uno = desglosarDocumento({
      documentId: 'a',
      documentNumber: 'A',
      renglones: [renglon({ tasa: '11.00', importe: '100.0000', iva: '11.0000' })],
      ivaCabecera: '11.0000',
      ivaPagado: '11.0000',
      porcion: pagoCompleto('111.0000'),
      politicaBaseExenta: 'exigir_base',
    }).desglose;
    const suma = sumarDesgloses(sumarDesgloses(desgloseCero(), uno), uno);
    expect(suma.otras).toHaveLength(1);
    expect(suma.otras[0]).toEqual({ etiqueta: '11.00', base: '200.0000', iva: '22.0000' });
  });
});

describe('el hueco por el que se escaparía el amarre', () => {
  it('BLOQUEA una cabecera con IVA cuando ningún renglón trae impuesto', () => {
    // Por debajo del centavo la comprobación general con tolerancia lo dejaba
    // pasar, y el reparto lo tiraba: no hay peso positivo entre el que
    // repartirlo. El total declarado quedaba por debajo del movimiento de
    // 1130 por la cantidad exacta que nadie va a buscar.
    const r = desglosarDocumento({
      documentId: 'b9',
      documentNumber: 'BILL-009',
      renglones: [renglon({ tipoFactor: 'exento', tasa: null, iva: '0.0000', valorActos: '100.0000' })],
      ivaCabecera: '0.0050',
      ivaPagado: '0.0050',
      porcion: pagoCompleto('100.0050'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('DIOT-IVA-CABECERA');
  });

  it('un documento sin nada de IVA por los dos lados sigue siendo declarable', () => {
    const r = desglosarDocumento({
      documentId: 'b10',
      documentNumber: 'BILL-010',
      renglones: [renglon({ tipoFactor: 'exento', tasa: null, iva: '0.0000', valorActos: '100.0000' })],
      ivaCabecera: '0.0000',
      ivaPagado: '0.0000',
      porcion: pagoCompleto('100.0000'),
      politicaBaseExenta: 'exigir_base',
    });
    expect(r.hallazgos).toHaveLength(0);
    expect(r.desglose.exento.base).toBe('100.0000');
  });
});
