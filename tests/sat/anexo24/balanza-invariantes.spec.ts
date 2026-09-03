import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  BALANZA_CHECK_NAMES,
  contarHallazgos,
  correrVerificaciones,
  formatearImporte,
  importesDeclarados,
  naturDe,
  recalculoDelSat,
  verificarCuentasEnCatalogo,
  verificarNaturCoherente,
  verificarRedondeo,
  verificarSaldos,
  type CatalogoDeReferencia,
  type ContextoDeVerificacion,
  type CuentaDeBalanza,
} from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import type { DescuadreDeCuenta } from '../../../src/services/reporting/report-service.js';

// ============================================================
// F07b · LAS INVARIANTES DE LA BALANZA, SIN POSTGRES DETRÁS.
//
// Es la razón entera de que `balanza-invariantes.ts` no toque la base. Cada
// caso de aquí —la acreedora que se declara del revés, el redondeo que rompe
// una resta que cuadraba, la cuenta que la balanza declara y el catálogo no—
// habría necesitado sembrar una entidad, un ejercicio y cuatro asientos para
// preguntar algo que es aritmética y comparación de conjuntos.
//
// La aritmética CONTRA POSTGRES está en tests/integration: allí se demuestra
// que las cuatro columnas que entran aquí son las del mayor de verdad, que es
// lo único que un arnés no puede fabricar.
// ============================================================

const cuenta = (over: Partial<CuentaDeBalanza> = {}): CuentaDeBalanza => ({
  account_id: 'id-1120',
  num_cta: '1120',
  natur: 'D',
  saldo_ini_mayor: '4500.0000',
  debe: '1300.0000',
  haber: '400.0000',
  saldo_fin_mayor: '5400.0000',
  codigo_agrupador: '105.01',
  natur_del_agrupador: 'D',
  tiene_hijas: false,
  ...over,
});

/** La cuenta de ingresos del ejercicio de F07a, en la convención del mayor. */
const ventas = (over: Partial<CuentaDeBalanza> = {}): CuentaDeBalanza =>
  cuenta({
    account_id: 'id-4100',
    num_cta: '4100',
    natur: 'A',
    saldo_ini_mayor: '-7000.0000',
    debe: '0.0000',
    haber: '1300.0000',
    saldo_fin_mayor: '-8300.0000',
    codigo_agrupador: '401.01',
    natur_del_agrupador: 'A',
    ...over,
  });

const catalogoCon = (...cuentas: string[]): CatalogoDeReferencia => ({
  origen: 'artefacto_archivado',
  referencia: 'sha256-de-mentira',
  cuentas,
});

const ctx = (over: Partial<ContextoDeVerificacion> = {}): ContextoDeVerificacion => ({
  cuentas: [cuenta(), ventas()],
  descuadres: [],
  catalogo: catalogoCon('1120', '4100'),
  criterio_sellado: 'nunca_sellar_en_el_sistema',
  sellada: false,
  ...over,
});

// ============================================================
// 1 · LA NATURALEZA, QUE ES DONDE ESTÁ LA TRAMPA
// ============================================================

describe('el signo con que se declara cada cuenta', () => {
  it('una DEUDORA se declara tal cual sale del mayor', () => {
    expect(importesDeclarados(cuenta())).toEqual({
      SaldoIni: '4500.00',
      Debe: '1300.00',
      Haber: '400.00',
      SaldoFin: '5400.00',
    });
  });

  it('una ACREEDORA se declara EN SU NATURALEZA, no en la del mayor', () => {
    // El mayor lleva un solo eje —deudor positivo— y ahí la venta deja la
    // cuenta en −7 000. El Anexo 24 no usa ese eje: declara 7 000 al haber.
    // Publicar el −7 000 del mayor es la forma más barata de que la autoridad
    // recalcule un SaldoFin distinto del declarado.
    expect(importesDeclarados(ventas())).toEqual({
      SaldoIni: '7000.00',
      Debe: '0.00',
      Haber: '1300.00',
      SaldoFin: '8300.00',
    });
  });

  it('y NO es un abs(): la acreedora SOBREGIRADA se declara en negativo', () => {
    // Aquí es donde `abs()` y «cambiar de eje» dejan de dar la misma cifra. Un
    // pasivo con saldo deudor —un proveedor pagado de más— existe, y su
    // SaldoFin es negativo; el valor absoluto lo declararía como si debiéramos
    // esa cantidad.
    const sobregirada = ventas({
      num_cta: '2110',
      saldo_ini_mayor: '-100.0000',
      debe: '900.0000',
      haber: '0.0000',
      saldo_fin_mayor: '800.0000',
    });
    const i = importesDeclarados(sobregirada);
    expect(i).toEqual({
      SaldoIni: '100.00',
      Debe: '900.00',
      Haber: '0.00',
      SaldoFin: '-800.00',
    });
    // Y el recálculo del SAT sigue cuadrando sobre esas cifras.
    expect(recalculoDelSat(i, 'A').toFixed(2)).toBe(i.SaldoFin);
  });

  it('el recálculo respeta Natur: la misma cuenta con la otra naturaleza NO cuadra', () => {
    // Ésta es la prueba del «respetando». Con las mismas cuatro cifras, sumar
    // donde había que restar da un resultado distinto, y por eso la naturaleza
    // no es una etiqueta decorativa del catálogo.
    const i = importesDeclarados(ventas());
    expect(recalculoDelSat(i, 'A').toFixed(2)).toBe('8300.00');
    expect(recalculoDelSat(i, 'D').toFixed(2)).toBe('5700.00');
  });

  it('la naturaleza sale de normal_balance y no del tipo de cuenta', () => {
    // La depreciación acumulada es de TIPO activo y de NATURALEZA acreedora.
    // Derivarla del tipo la publicaría del revés en el balance entero.
    expect(naturDe('credit')).toBe('A');
    expect(naturDe('debit')).toBe('D');
  });
});

describe('el formato del importe', () => {
  it('son siempre dos decimales, con el punto como separador', () => {
    expect(formatearImporte('1234.5000')).toBe('1234.50');
    expect(formatearImporte('0')).toBe('0.00');
    expect(formatearImporte(new Decimal('-8300'))).toBe('-8300.00');
  });

  it('redondea mitad arriba en valor absoluto', () => {
    expect(formatearImporte('0.125')).toBe('0.13');
    expect(formatearImporte('-0.125')).toBe('-0.13');
  });

  it('un saldo casi cero NO sale como «-0.00»', () => {
    // Sale de cualquier acreedora casi saldada, valida contra el esquema y se
    // lee mal en cualquier hoja de cálculo que lo abra.
    expect(formatearImporte('-0.0010')).toBe('0.00');
    expect(formatearImporte('-0.0049')).toBe('0.00');
  });
});

// ============================================================
// 2 · `saldos` PUBLICA LO QUE F07a YA CALCULÓ
// ============================================================

describe('saldos', () => {
  const descuadre: DescuadreDeCuenta = {
    account_id: 'id-1120',
    account_code: '1120',
    esperado: '4500.0000',
    obtenido: '5400.0000',
    diferencia: '-900.0000',
  };

  it('no inventa hallazgos: sin descuadres no dice nada', () => {
    expect(verificarSaldos(ctx())).toEqual([]);
  });

  it('nombra la cuenta, su diferencia y bloquea', () => {
    const h = verificarSaldos(ctx({ descuadres: [descuadre] }));
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('blocking');
    expect(h[0].referencia).toBe('1120');
    expect(h[0].detalle).toContain('-900.0000');
    expect(h[0].detalle).toContain('deudora');
  });

  it('traduce la diferencia al signo con que la cuenta se declara', () => {
    // El preparador va a buscar esa cifra en la columna del XML, no en la del
    // mayor. Publicarla con el signo del mayor le hace buscar un +900 donde
    // hay un −900.
    const enAcreedora: DescuadreDeCuenta = {
      account_id: 'id-4100',
      account_code: '4100',
      esperado: '-7000.0000',
      obtenido: '-8300.0000',
      diferencia: '1300.0000',
    };
    const h = verificarSaldos(ctx({ descuadres: [enAcreedora] }));
    expect(h[0].detalle).toContain('7000.0000');
    expect(h[0].detalle).toContain('8300.0000');
    expect(h[0].detalle).toContain('-1300.0000');
    expect(h[0].detalle).toContain('acreedora');
  });
});

// ============================================================
// 3 · `redondeo`: EL INVARIANTE SOBRE LAS CIFRAS DEL ARCHIVO
// ============================================================

describe('redondeo', () => {
  it('cuatro cifras que cuadran en el mayor y NO cuadran ya redondeadas', () => {
    // 0.0050 + 0.0050 − 0 = 0.0100 es exacto en el libro. Redondeado:
    // 0.01 + 0.01 − 0 = 0.02, y el archivo declararía SaldoFin 0.01.
    // La autoridad rehace la resta sobre lo PRESENTADO.
    const c = cuenta({
      saldo_ini_mayor: '0.0050',
      debe: '0.0050',
      haber: '0.0000',
      saldo_fin_mayor: '0.0100',
    });
    const esperado = new Decimal(c.saldo_ini_mayor).plus(c.debe).minus(c.haber);
    expect(esperado.toFixed(4)).toBe('0.0100'); // cuadra en el mayor

    const h = verificarRedondeo(ctx({ cuentas: [c] }));
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('blocking');
    expect(h[0].detalle).toContain('0.02');
    expect(h[0].detalle).toContain('0.01');
  });

  it('la misma trampa en una ACREEDORA, con la resta del otro lado', () => {
    const c = ventas({
      saldo_ini_mayor: '-0.0050',
      debe: '0.0000',
      haber: '0.0050',
      saldo_fin_mayor: '-0.0100',
    });
    const h = verificarRedondeo(ctx({ cuentas: [c] }));
    expect(h).toHaveLength(1);
    expect(h[0].referencia).toBe('4100');
  });

  it('no vuelve a acusar lo que `saldos` ya acusó', () => {
    // Si la cuenta ya falla en el mayor, repetirla aquí cuenta dos veces el
    // mismo defecto y el preparador arregla uno creyendo que arregló los dos.
    const rota = cuenta({ saldo_fin_mayor: '9999.0000' });
    const conDescuadre = ctx({
      cuentas: [rota],
      descuadres: [
        {
          account_id: rota.account_id,
          account_code: rota.num_cta,
          esperado: '5400.0000',
          obtenido: '9999.0000',
          diferencia: '-4599.0000',
        },
      ],
    });
    expect(verificarRedondeo(conDescuadre)).toEqual([]);
    expect(verificarSaldos(conDescuadre)).toHaveLength(1);
  });

  it('una balanza sana no produce ningún hallazgo de redondeo', () => {
    expect(verificarRedondeo(ctx())).toEqual([]);
  });
});

// ============================================================
// 4 · EL COTEJO CRUZADO, QUE ES EL ERROR MÁS CARO
// ============================================================

describe('cuentas-en-catalogo', () => {
  it('señala la cuenta que la balanza declara y el catálogo no', () => {
    const h = verificarCuentasEnCatalogo(ctx({ catalogo: catalogoCon('1120') }));
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('blocking');
    expect(h[0].referencia).toBe('4100');
  });

  it('SIN catálogo NO pasa en limpio: bloquea', () => {
    // Una comprobación que no pudo mirar no es una comprobación limpia, y ésta
    // es la que decide si el envío se acepta.
    const h = verificarCuentasEnCatalogo(ctx({ catalogo: null }));
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('blocking');
    expect(h[0].referencia).toBe('');
    expect(h[0].detalle).toContain('no hay catálogo');
  });

  it('dice POR QUÉ falta la cuenta cuando el criterio la omitió', () => {
    const h = verificarCuentasEnCatalogo(
      ctx({
        catalogo: {
          origen: 'plan_de_cuentas',
          cuentas: ['1120'],
          criterio_niveles: 'jerarquia_completa',
          criterio_sin_agrupador: 'omitir_y_avisar',
          sin_agrupador: ['4100'],
        },
      })
    );
    const falta = h.find((x) => x.referencia === '4100');
    expect(falta?.detalle).toContain('omitir_y_avisar');
  });

  it('cotejar contra el plan de cuentas de HOY se advierte, no se calla', () => {
    const h = verificarCuentasEnCatalogo(
      ctx({
        catalogo: {
          origen: 'plan_de_cuentas',
          cuentas: ['1120', '4100'],
          criterio_niveles: 'jerarquia_completa',
        },
      })
    );
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(h[0].detalle).toContain('no contra un catálogo');
  });

  it('contra un artefacto archivado que las tiene todas, calla', () => {
    expect(verificarCuentasEnCatalogo(ctx())).toEqual([]);
  });
});

// ============================================================
// 5 · LA NATURALEZA DE LA CUENTA Y LA DE SU AGRUPADOR
// ============================================================

describe('natur-coherente', () => {
  it('una cuenta deudora con agrupador acreedor se avisa, no se bloquea', () => {
    // Pasa el esquema y la rechaza la validación de fondo. La balanza en sí
    // sigue cuadrando: lo que está mal es el mapeo, y lo arregla el catálogo.
    const h = verificarNaturCoherente(
      ctx({ cuentas: [cuenta({ natur_del_agrupador: 'A' })] })
    );
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(h[0].detalle).toContain('DEUDORA');
    expect(h[0].detalle).toContain('ACREEDOR');
  });

  it('sin agrupador vigente no se inventa una incoherencia', () => {
    expect(
      verificarNaturCoherente(ctx({ cuentas: [cuenta({ natur_del_agrupador: null })] }))
    ).toEqual([]);
  });
});

// ============================================================
// 6 · EL SELLO, QUE NO SE PONE AQUÍ
// ============================================================

describe('sin-sello', () => {
  it('con el criterio por omisión, un archivo sin sello ES el producto', () => {
    const h = correrVerificaciones(ctx(), ['sin-sello']);
    expect(h).toEqual([]);
  });

  it('con «sellar_con_custodia» se dice que este tramo no sella', () => {
    const h = correrVerificaciones(ctx({ criterio_sellado: 'sellar_con_custodia' }), ['sin-sello']);
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(h[0].detalle).toContain('no carga ninguna llave privada');
  });
});

// ============================================================
// 7 · LA BATERÍA Y SU CONTEO
// ============================================================

describe('la batería', () => {
  it('corre exactamente las que se nombran, en el orden publicado', () => {
    const h = correrVerificaciones(ctx({ catalogo: null }), ['saldos']);
    expect(h).toEqual([]); // `cuentas-en-catalogo` no se pidió
    expect(BALANZA_CHECK_NAMES).toContain('cuentas-en-catalogo');
  });

  it('el conteo habla el vocabulario del contrato de códigos de salida', () => {
    const h = correrVerificaciones(
      ctx({
        catalogo: catalogoCon('1120'),
        criterio_sellado: 'sellar_con_custodia',
      })
    );
    const conteo = contarHallazgos(h);
    expect(conteo.blocking).toBe(1); // 4100 no está en el catálogo
    expect(conteo.warning).toBe(1); // el sello pactado que no se pone
  });

  it('una balanza sana no produce ningún hallazgo', () => {
    expect(correrVerificaciones(ctx())).toEqual([]);
  });

  it('una cuenta de mayor con hijas en ceros se avisa', () => {
    const mayor = cuenta({
      account_id: 'id-1100',
      num_cta: '1100',
      saldo_ini_mayor: '0',
      debe: '0',
      haber: '0',
      saldo_fin_mayor: '0',
      tiene_hijas: true,
    });
    const h = correrVerificaciones(
      ctx({ cuentas: [mayor], catalogo: catalogoCon('1100') }),
      ['mayor-sin-agregar']
    );
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(h[0].detalle).toContain('1100');
  });
});
