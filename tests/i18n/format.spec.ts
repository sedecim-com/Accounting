// ============================================================
// EL FORMATEADOR DE I6, Y LAS DOS TRAMPAS QUE SE MIDIERON ANTES DE ESCRIBIRLO
//
// Cuatro propiedades. Las dos primeras son correccion contable disfrazada de
// presentacion, y por eso los esperados van como literales:
//
//   EL DINERO PASA POR CADENA. `Intl.NumberFormat.format()` acepta una cadena
//   decimal y la formatea exacta; el mismo importe pasado por `Number` pierde
//   la ultima cifra a partir de 2^53 centesimos. La prueba compara las dos
//   rutas sobre el mismo importe, asi que cae el dia que alguien escriba un
//   `Number(` en el camino.
//
//   LA FECHA NO SE DESPLAZA. `dateStyle` sobre un instante UTC imprime el dia
//   ANTERIOR al oeste de Greenwich. La zona se fija aqui mismo, antes de los
//   imports: en un runner en UTC el corrimiento no se ve y la prueba probaria
//   vacio, que es peor que no tenerla.
//
//   ...Y LA PRUEBA QUE DECIA CUBRIRLO SOLO EJERCITABA LA RAMA DE CADENA, que es
//   la que ya funcionaba. La rama de `Date` —la que se corria un dia— no tenia
//   ni un aserto, y por eso el defecto vivio con una prueba verde encima. Se
//   cubre abajo, en «la rama de `Date`», moviendo la zona del proceso por CINCO
//   husos (UTC, dos al este y dos al oeste) y comprobando en cada uno que el
//   cambio de zona TUVO EFECTO antes de creerse el verde.
//
//   EL DINERO NO IMPRIME «∞». La exactitud de `Intl` sobre cadenas tiene una
//   frontera de magnitud —el rango de un `double`— y encima de ella contestaba
//   «MXN∞». Un ∞ en una columna de importes parece un dato.
//
//   EL FORMATO LO FIJA LA JURISDICCION, NO EL IDIOMA (regla 5). La suite corre
//   con MNEMOSINE_LOCALE=en-US puesto por vitest.config.ts; una entidad
//   mexicana tiene que seguir leyendose en es-MX con ese entorno encima.
//
//   EL ALIAS DEPRECADO NO CAMBIA NI UN BYTE. `formatMoneyMx` se usa en cuatro
//   archivos; sus siete casos se reafirman aqui contra la implementacion nueva.
// ============================================================
process.env.TZ = 'America/Mexico_City';

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FORMAT_LOCALE,
  formatDate,
  formatLocaleFor,
  formatMoney,
  formatNumber,
} from '../../src/i18n/format.js';
import { formatMoneyMx } from '../../src/cli/kernel/output.js';
import { jurisdictionOf } from '../../src/services/jurisdiction/jurisdiction.js';

// Las jurisdicciones se construyen con la funcion de verdad y no a mano: si
// `jurisdictionOf` dejara de dar MXN a una entidad mexicana, esto tiene que
// enterarse aqui y no en produccion.
const MX = jurisdictionOf({ incorporation_country: 'MX' });
const US = jurisdictionOf({ incorporation_country: 'US' });

// El espacio que `Intl` mete entre el codigo ISO y la cifra es DURO (U+00A0),
// no el de la barra espaciadora. Se escribe con su escape para que nadie lo
// «arregle» tecleando un espacio normal y se pase media hora buscando por que.
const NBSP = '\u00A0';

describe('la zona horaria del propio spec', () => {
  it('corre en America/Mexico_City (UTC-6), donde el corrimiento de dia es visible', () => {
    // Si el runner ignorara TZ, la prueba de la fecha probaria vacio.
    expect(new Date(2026, 2, 4).getTimezoneOffset()).toBe(360);
  });
});

describe('el dinero pasa por cadena o no pasa', () => {
  it('formatea exacto un importe que `Number` ya no puede representar', () => {
    const exact = formatMoney('12345678901234567.89', { jurisdiction: MX, display: 'plain' });
    expect(exact).toBe('12,345,678,901,234,567.89');

    // La misma cifra por la ruta prohibida, para que la prueba diga QUE se
    // rompe y no solo que algo cambio: `Number` la redondea a ...568.00.
    const viaFloat = new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number('12345678901234567.89'));
    expect(viaFloat).toBe('12,345,678,901,234,568.00');
    expect(exact).not.toBe(viaFloat);
  });

  it('conserva las cifras altas del ejemplo de la casa (2^53 centesimos y mas)', () => {
    expect(formatMoney('90071992547409919.0150', { jurisdiction: MX, display: 'plain' })).toBe(
      '90,071,992,547,409,919.02'
    );
  });

  it('la firma no admite un `number`, que es donde nacia el redondeo', () => {
    // @ts-expect-error un importe numerico ya perdio precision antes de llegar.
    formatMoney(12345678901234567.89, { jurisdiction: MX });
  });

  it('redondea half-up sobre la magnitud, con acarreo que cruza el punto', () => {
    const mx = { jurisdiction: MX, display: 'plain' } as const;
    expect(formatMoney('999.9950', mx)).toBe('1,000.00');
    expect(formatMoney('-1234567.8950', mx)).toBe('-1,234,567.90');
  });

  it('no imprime menos-cero: un menos delante de un cero es ilegible en una balanza', () => {
    expect(formatMoney('-0.0040', { jurisdiction: MX, display: 'plain' })).toBe('0.00');
  });

  it('lo que no es una cadena decimal de almacenamiento sale como entro', () => {
    // Sin la guarda, `Intl` no falla: contesta «NaN» o «0.00», y un «NaN» en la
    // columna de importes parece un dato.
    const mx = { jurisdiction: MX, display: 'plain' } as const;
    expect(formatMoney('abc', mx)).toBe('abc');
    expect(formatMoney('', mx)).toBe('');
    expect(formatMoney('1,234.00', mx)).toBe('1,234.00'); // ya formateado: no se re-formatea
    expect(formatMoney('1e3', mx)).toBe('1e3');
  });

  it('rechaza un codigo de moneda mal formado en vez de dejar que `Intl` lance RangeError', () => {
    expect(() => formatMoney('100.00', { jurisdiction: MX, currency: 'PESOS' })).toThrow(
      /ISO 4217/
    );
  });
});

// ============================================================
// LA FRONTERA DE `Intl`, QUE IMPRIMIA «MXN∞»
//
// Medido antes de la guarda: `formatMoney('1'.repeat(320) + '.00')` daba
// «MXN∞». No es que los digitos pasen por float —301 digitos distintos entran y
// salen iguales, y eso se afirma abajo—; es que el estandar acota la MAGNITUD
// al rango de un `double` y encima de ella contesta ±∞. Con datos de un
// despacho no se alcanza (el PIB mundial en centavos tiene 17 digitos), pero un
// «∞» en una columna de importes se lee como un dato, igual que el «NaN» del
// que este modulo ya se defendia.
// ============================================================
describe('el dinero no imprime «∞»: la frontera de magnitud de `Intl`', () => {
  const mx = { jurisdiction: MX, display: 'plain' } as const;

  it('el importe que daba «MXN∞» sale ahora como entro', () => {
    const huge = '1'.repeat(320) + '.00';
    expect(formatMoney(huge)).toBe(huge);
    expect(formatMoney(huge)).not.toContain('∞');

    // La ruta ingenua, para que la prueba documente el defecto y no solo lo
    // evite: sin guarda, la misma cadena por `Intl` da «∞» pelado.
    const ingenua = new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    } as Intl.NumberFormatOptions).format(huge as unknown as number);
    expect(ingenua).toBe('∞');
  });

  it('ningun largo entre 300 y 330 digitos imprime «∞», con signo o sin el', () => {
    for (let digits = 300; digits <= 330; digits++) {
      const magnitude = '9'.repeat(digits) + '.0050';
      expect(formatMoney(magnitude, mx)).not.toContain('∞');
      expect(formatMoney(`-${magnitude}`, mx)).not.toContain('∞');
    }
  });

  it('la raya esta en 308 digitos enteros: debajo se formatea exacto, encima sale crudo', () => {
    const safe = '9'.repeat(308);
    expect(formatMoney(`${safe}.00`, mx).replace(/,/g, '')).toBe(`${safe}.00`);

    const over = '9'.repeat(309);
    expect(formatMoney(`${over}.00`, mx)).toBe(`${over}.00`); // crudo, sin agrupar

    // Por que 308 y no 309: con 309 digitos el resultado depende de los
    // PRIMEROS, porque el limite real es el `double` maximo (~1.797e308) y no
    // un numero redondo de digitos. Esa constante no se escribe en un modulo de
    // dinero, asi que la raya se pone un digito antes, donde la cuenta es de
    // cadenas.
    const naive = (s: string): string =>
      new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 } as Intl.NumberFormatOptions)
        .format(s as unknown as number);
    expect(naive(`1${'0'.repeat(308)}`)).not.toContain('∞');
    expect(naive(`2${'0'.repeat(308)}`)).toBe('∞');
  });

  it('el signo y los ceros a la izquierda no cuentan como digitos', () => {
    const body = '1'.repeat(300);
    const padded = `-${'0'.repeat(50)}${body}.00`;
    // 350 caracteres, 300 digitos significativos: cabe, y se formatea.
    expect(formatMoney(padded, mx).replace(/[,]/g, '')).toBe(`-${body}.00`);
  });

  it('los digitos NO pasan por float: 301 digitos distintos entran y salen iguales', () => {
    const digits = '1234567890'.repeat(30) + '7';
    expect(digits).toHaveLength(301);
    expect(formatMoney(`${digits}.55`, mx).replace(/,/g, '')).toBe(`${digits}.55`);
  });

  it('una fraccion larguisima no desborda: la guarda solo mira la parte entera', () => {
    expect(formatMoney(`0.${'1'.repeat(2000)}`, mx)).toBe('0.11');
  });

  it('formatNumber tiene la misma frontera y la misma salida', () => {
    const huge = '1'.repeat(320);
    expect(formatNumber(huge, { jurisdiction: MX })).toBe(huge);
    expect(formatNumber(huge, { jurisdiction: MX })).not.toContain('∞');
  });
});

// ============================================================
// DOS RAZONES ESCRITAS QUE ESTABAN MEDIDAS AL REVES
//
// Los docstrings de `format.ts` afirmaban dos cosas falsas. Una razon escrita
// que no se sostiene es peor que ninguna: la siguiente persona la cree y decide
// con ella. Se corrigieron alla y se fijan aqui, para que la prosa no pueda
// volver a alejarse de lo medido sin que algo se ponga rojo.
// ============================================================
describe('las dos razones que el modulo tenia escritas al reves', () => {
  it('`new Intl.NumberFormat(\'zzz\')` NO lanza: cae al locale de la MAQUINA, en silencio', () => {
    // Lo que decia el docstring: «lanza RangeError». No lanza.
    expect(() => new Intl.NumberFormat('zzz')).not.toThrow();
    const fallback = new Intl.NumberFormat('zzz').resolvedOptions().locale;
    expect(fallback).not.toBe('zzz');
    // Y no cae en un locale fijo: cae en el DEL HOST, que es lo que hace
    // irreproducible la salida entre el portatil del contador y el servidor.
    // Se compara contra el propio host y no contra 'en-US', que aqui seria un
    // aserto verde por casualidad.
    expect(fallback).toBe(new Intl.NumberFormat().resolvedOptions().locale);

    // La que SI lanza es la mal formada, que es la errata plausible de una
    // bandera: guion bajo, dos cifras, la cadena vacia.
    for (const malformed of ['es_MX', '12', '']) {
      expect(() => new Intl.NumberFormat(malformed)).toThrow(RangeError);
    }
  });

  it('el simbolo del peso y el del dolar NO son el mismo en es-MX', () => {
    // Lo que decia el docstring: «son EL MISMO en es-MX». No lo son.
    expect(formatMoney('1234.50', { locale: 'es-MX', currency: 'MXN', display: 'symbol' })).toBe(
      '$1,234.50'
    );
    expect(formatMoney('1234.50', { locale: 'es-MX', currency: 'USD', display: 'symbol' })).toBe(
      `USD${NBSP}1,234.50`
    );

    // Lo que SI pasa, que es la razon de verdad para no usar `'symbol'` por
    // omision: el `$` a secas se lo queda la moneda LOCAL de cada locale, asi
    // que la misma cadena significa pesos o dolares segun la entidad.
    expect(formatMoney('1234.50', { locale: 'en-US', currency: 'USD', display: 'symbol' })).toBe(
      '$1,234.50'
    );
    expect(formatMoney('1234.50', { locale: 'en-US', currency: 'MXN', display: 'symbol' })).toBe(
      'MX$1,234.50'
    );
  });
});

describe('el formato lo fija la jurisdiccion, no el idioma del usuario (regla 5)', () => {
  it('la suite corre con MNEMOSINE_LOCALE=en-US encima, que es lo que hace valida la prueba', () => {
    // Puesto por vitest.config.ts a proposito. Si desapareciera, las dos
    // pruebas de abajo pasarian por casualidad.
    expect(process.env.MNEMOSINE_LOCALE).toBe('en-US');
  });

  it('una entidad mexicana se lee en es-MX aunque el usuario haya pedido en-US', () => {
    // Las cifras de es-MX y en-US son identicas —las dos agrupan con coma—, asi
    // que la que discrimina es la FECHA: es-MX dice «4 mar 2026» y en-US «Mar 4».
    expect(formatDate('2026-03-04', { jurisdiction: MX })).toBe('4 mar 2026');
    expect(formatMoney('12458930.55', { jurisdiction: MX })).toBe(`MXN${NBSP}12,458,930.55`);
  });

  it('una entidad estadounidense se lee en en-US y en dolares', () => {
    expect(formatDate('2026-03-04', { jurisdiction: US })).toBe('Mar 4, 2026');
    expect(formatMoney('12458930.55', { jurisdiction: US })).toBe(`USD${NBSP}12,458,930.55`);
  });

  it('formatLocaleFor traduce las dos autoridades fiscales del producto', () => {
    expect(formatLocaleFor(MX)).toBe('es-MX');
    expect(formatLocaleFor(US)).toBe('en-US');
  });

  it('sin jurisdiccion cae en es-MX, la regla de la casa', () => {
    expect(DEFAULT_FORMAT_LOCALE).toBe('es-MX');
    expect(formatDate('2026-03-04')).toBe('4 mar 2026');
    expect(formatMoney('1234.50')).toBe(`MXN${NBSP}1,234.50`);
  });

  it('el codigo ISO es el valor por omision, y el simbolo hay que pedirlo', () => {
    // El simbolo del peso y el del dolar son EL MISMO en es-MX: entre dos
    // monedas, «$1,234.50» no dice cual.
    expect(formatMoney('1234.50', { jurisdiction: MX, display: 'symbol' })).toBe('$1,234.50');
    expect(formatMoney('1234.50', { jurisdiction: US, currency: 'MXN', display: 'symbol' })).toBe(
      'MX$1,234.50'
    );
  });

  it('el locale explicito gana, y con el llegan los otros separadores', () => {
    // No es una jurisdiccion del producto; es la prueba de que el separador NO
    // esta escrito a mano en ningun sitio, que es lo que dejaba falsas a las dos
    // regex de importes.
    expect(formatMoney('1234567.89', { locale: 'pt-BR', display: 'plain' })).toBe('1.234.567,89');
  });
});

describe('la fecha no se desplaza un dia', () => {
  it('la RAMA DE CADENA: 2026-03-04 se imprime como el 4, no como el 3', () => {
    // Ojo con lo que esta prueba prueba y lo que NO: solo la rama de cadena.
    // Con este titulo se creyo durante todo I6 que cubria el corrimiento
    // entero, y la rama de `Date` —la unica que se corria— no tenia asertos.
    // Esa esta abajo, en «la rama de `Date`».
    expect(formatDate('2026-03-04', { jurisdiction: MX, style: 'medium' })).toBe('4 mar 2026');

    // La ruta ingenua, para que la prueba documente el defecto y no solo lo
    // evite: `dateStyle` sin fijar la zona resta las seis horas de CDMX.
    const ingenua = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(
      new Date('2026-03-04T00:00:00Z')
    );
    expect(ingenua).toBe('3 mar 2026');
  });

  it('un Date a medianoche LOCAL —lo que entrega node-postgres— conserva su dia', () => {
    // El 31 de enero a las 20:00 en CDMX ya es 1 de febrero en UTC: la poliza
    // cruzaba el corte de periodo al imprimirse.
    const closingNight = new Date(2026, 0, 31, 20, 0, 0);
    expect(formatDate(closingNight, { jurisdiction: MX, style: 'iso' })).toBe('2026-01-31');
    expect(formatDate(closingNight, { jurisdiction: MX, style: 'medium' })).toBe('31 ene 2026');
  });

  it('los cuatro estilos, con el mes nombrado donde el orden seria ambiguo', () => {
    const options = { jurisdiction: MX } as const;
    expect(formatDate('2026-03-04', { ...options, style: 'iso' })).toBe('2026-03-04');
    expect(formatDate('2026-03-04', { ...options, style: 'short' })).toBe('04/03/26');
    expect(formatDate('2026-03-04', { ...options, style: 'medium' })).toBe('4 mar 2026');
    expect(formatDate('2026-03-04', { ...options, style: 'long' })).toBe('4 de marzo de 2026');
  });

  it('una cadena ISO con hora trae la fecha ya decidida: se recorta, no se reinterpreta', () => {
    expect(formatDate('2026-01-31T20:00:00.000Z', { jurisdiction: MX, style: 'iso' })).toBe(
      '2026-01-31'
    );
  });

  it('lo que no es una fecha reconocible sale como entro, sin lanzar', () => {
    expect(formatDate('sin fecha', { jurisdiction: MX })).toBe('sin fecha');
    expect(formatDate(new Date('no es fecha'), { jurisdiction: MX })).toBe('');
  });
});

// ============================================================
// LA RAMA DE `Date`, QUE ES LA QUE SE CORRIA UN DIA
//
// Medido en este arbol ANTES del arreglo, con TZ=America/Mexico_City:
//
//     formatDate('2026-12-31T00:00:00Z')            -> 2026-12-31
//     formatDate(new Date('2026-12-31T00:00:00Z'))  -> 2026-12-30
//
// El mismo instante, dos dias, segun entrara como cadena o como `Date`; y en
// fin de anio, el EJERCICIO equivocado. La causa es que un `Date` es un
// INSTANTE y de un instante no sale un dia sin decir en que zona se mira.
// `formatDate` lo decide ahora con `instantZone`, y esto lo comprueba en cinco
// husos: uno en el meridiano, dos al este y dos al oeste.
//
// LA ZONA SE MUEVE DE VERDAD, Y SE COMPRUEBA QUE SE MOVIO. `process.env.TZ` en
// caliente solo sirve si el runtime rehace su cache de fechas; si no lo
// hiciera, los cinco husos serian el mismo y las pruebas de abajo pasarian en
// verde sin probar nada —exactamente el fallo que dejo vivo el defecto—. Por
// eso `inTimeZone` afirma el offset ANTES de correr el cuerpo.
// ============================================================
describe('la rama de `Date`: un instante no es un dia hasta que se dice donde se mira', () => {
  // La que fija la cabecera de este archivo, y a la que se vuelve siempre.
  const SPEC_TZ = 'America/Mexico_City';

  // El offset se afirma sobre el 15 de enero a proposito: ninguno de los cinco
  // husos cambia de hora en esa fecha, asi que el numero no depende del anio.
  const ZONES = [
    { tz: 'UTC', offset: 0 },
    { tz: 'Asia/Tokyo', offset: -540 },
    { tz: 'Pacific/Kiritimati', offset: -840 },
    { tz: 'America/Mexico_City', offset: 360 },
    { tz: 'America/Los_Angeles', offset: 480 },
  ] as const;

  function inTimeZone(tz: string, offset: number, body: () => void): void {
    process.env.TZ = tz;
    try {
      expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(offset);
      body();
    } finally {
      process.env.TZ = SPEC_TZ;
    }
  }

  it('el arnes cambia la zona de verdad: cinco husos, cinco offsets distintos', () => {
    const measured = ZONES.map(({ tz, offset }) => {
      let seen = -1;
      inTimeZone(tz, offset, () => {
        seen = new Date(2026, 0, 15).getTimezoneOffset();
      });
      return seen;
    });
    expect(measured).toEqual([0, -540, -840, 360, 480]);
    expect(new Set(measured).size).toBe(5);
    expect(process.env.TZ).toBe(SPEC_TZ); // y se devuelve la zona al salir
  });

  it('un instante UTC DECLARADO da el mismo dia en los cinco husos', () => {
    for (const { tz, offset } of ZONES) {
      inTimeZone(tz, offset, () => {
        const instant = new Date('2026-03-04T00:00:00Z');
        const options = { jurisdiction: MX, instantZone: 'UTC' } as const;
        expect(formatDate(instant, { ...options, style: 'iso' })).toBe('2026-03-04');
        expect(formatDate(instant, { ...options, style: 'medium' })).toBe('4 mar 2026');
      });
    }
  });

  it('fin de mes y fin de anio declarados: ni el corte de periodo ni el ejercicio se mueven', () => {
    // Los dos cortes que cuestan dinero. Antes del arreglo, 2026-01-31Z salia
    // «2026-01-30» en CDMX (la poliza cambia de periodo) y 2026-12-31Z salia
    // «2026-12-30» (cambia de EJERCICIO).
    for (const { tz, offset } of ZONES) {
      inTimeZone(tz, offset, () => {
        const iso = { jurisdiction: MX, style: 'iso', instantZone: 'UTC' } as const;
        expect(formatDate(new Date('2026-01-31T00:00:00Z'), iso)).toBe('2026-01-31');
        expect(formatDate(new Date('2026-12-31T00:00:00Z'), iso)).toBe('2026-12-31');
        // El ultimo instante del ejercicio, no solo su medianoche.
        expect(formatDate(new Date('2026-12-31T23:59:59.999Z'), iso)).toBe('2026-12-31');
        // Y el primero del siguiente, para que la raya se vea por los dos lados.
        expect(formatDate(new Date('2027-01-01T00:00:00Z'), iso)).toBe('2027-01-01');
      });
    }
  });

  it('el `Date` declarado y la cadena contestan LO MISMO, que era la contradiccion', () => {
    for (const { tz, offset } of ZONES) {
      inTimeZone(tz, offset, () => {
        for (const day of ['2026-03-04', '2026-01-31', '2026-12-31', '2026-02-28']) {
          expect(formatDate(new Date(`${day}T00:00:00Z`), {
            jurisdiction: MX,
            style: 'iso',
            instantZone: 'UTC',
          })).toBe(formatDate(day, { jurisdiction: MX, style: 'iso' }));
        }
      });
    }
  });

  it('un `Date` a medianoche LOCAL —lo que entrega node-postgres— conserva su dia en los cinco husos', () => {
    // Sin `setTypeParser`, el driver devuelve una columna DATE como `Date` a
    // medianoche LOCAL; por eso la omision es `'local'` y no `'UTC'`. Leerlo en
    // UTC devolveria el dia anterior al oeste, que es el defecto de siempre por
    // el otro lado.
    for (const { tz, offset } of ZONES) {
      inTimeZone(tz, offset, () => {
        const options = { jurisdiction: MX, style: 'iso' } as const;
        expect(formatDate(new Date(2026, 0, 31), options)).toBe('2026-01-31');
        expect(formatDate(new Date(2026, 11, 31), options)).toBe('2026-12-31');
        // La poliza de las 20:00 del 31 de enero, que en UTC ya es febrero.
        expect(formatDate(new Date(2026, 0, 31, 20, 0, 0), options)).toBe('2026-01-31');
      });
    }
  });

  it('la cadena no mira `instantZone` ni la zona del proceso: trae el dia escrito', () => {
    for (const { tz, offset } of ZONES) {
      inTimeZone(tz, offset, () => {
        const mx = { jurisdiction: MX, style: 'iso' } as const;
        expect(formatDate('2026-12-31', mx)).toBe('2026-12-31');
        expect(formatDate('2026-12-31', { ...mx, instantZone: 'UTC' })).toBe('2026-12-31');
        // Con hora y `Z` tambien se recorta, no se reproyecta: es la misma
        // regla que `dateOnly` en src/cli/kernel/output.ts, y si las dos
        // leyeran distinto la misma poliza saldria con dos fechas en pantalla.
        expect(formatDate('2026-12-31T23:00:00.000Z', mx)).toBe('2026-12-31');
      });
    }
  });

  // ============================================================
  // LO QUE SIGUE SIN PODERSE, FIJADO CON UN ASERTO
  //
  // Un `Date` no recuerda como lo construyeron, asi que un instante UTC pasado
  // SIN declarar la zona sigue imprimiendo el dia anterior al oeste. Eso no se
  // arreglo —no tiene arreglo desde dentro de esta funcion— y aqui esta escrito
  // como aserto en vez de como promesa, para que nadie vuelva a documentar lo
  // contrario sin que se ponga rojo.
  // ============================================================
  it('SIN declarar, un instante UTC se sigue corriendo al oeste: medido, no prometido', () => {
    inTimeZone('America/Mexico_City', 360, () => {
      expect(formatDate(new Date('2026-12-31T00:00:00Z'), { jurisdiction: MX, style: 'iso' })).toBe(
        '2026-12-30'
      );
    });
    inTimeZone('Asia/Tokyo', -540, () => {
      expect(formatDate(new Date('2026-12-31T00:00:00Z'), { jurisdiction: MX, style: 'iso' })).toBe(
        '2026-12-31'
      );
    });
  });
});

describe('formatNumber: cantidades que no son dinero', () => {
  it('una cadena larga tambien se formatea exacta', () => {
    expect(
      formatNumber('12345678901234567', { jurisdiction: MX, maximumFractionDigits: 0 })
    ).toBe('12,345,678,901,234,567');
  });

  it('acepta un `number` porque un conteo lo es', () => {
    expect(formatNumber(1234, { jurisdiction: MX })).toBe('1,234');
  });

  it('respeta los decimales pedidos', () => {
    expect(
      formatNumber('3.14159', { jurisdiction: MX, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    ).toBe('3.14');
  });

  it('deja el agrupamiento al locale, y en es-MX eso SI agrupa un ano', () => {
    // Documentado como trampa en el propio modulo: un ano no es una cantidad y
    // no debe pasar por aqui.
    expect(formatNumber(2026, { jurisdiction: MX })).toBe('2,026');
  });

  it('lo que no es numero sale como entro', () => {
    expect(formatNumber('N/D', { jurisdiction: MX })).toBe('N/D');
  });
});

describe('formatMoneyMx queda deprecado pero no cambia ni un byte', () => {
  it('los siete casos de su prueba original, contra la implementacion nueva', () => {
    expect(formatMoneyMx('12458930.5500')).toBe('12,458,930.55');
    expect(formatMoneyMx('-1234567.8950')).toBe('-1,234,567.90');
    expect(formatMoneyMx('999.9950')).toBe('1,000.00');
    expect(formatMoneyMx('0.0000')).toBe('0.00');
    expect(formatMoneyMx('-0.0040')).toBe('0.00');
    expect(formatMoneyMx('1000')).toBe('1,000.00');
    expect(formatMoneyMx('90071992547409919.0150')).toBe('90,071,992,547,409,919.02');
  });

  it('es exactamente el mexicano de `formatMoney` sin marca de moneda', () => {
    expect(formatMoneyMx('12458930.5500')).toBe(
      formatMoney('12458930.5500', { jurisdiction: MX, display: 'plain', fractionDigits: 2 })
    );
  });

  // ============================================================
  // LA PRUEBA QUE DE VERDAD CIERRA EL CAMBIO DE MECANISMO
  //
  // Los siete literales de arriba comprueban siete puntos. Lo que hay que
  // demostrar es OTRA cosa: que la implementacion nueva contesta lo MISMO que
  // la vieja en todo el dominio, no en los casos que a alguien se le ocurrieron.
  // Asi que la vieja se conserva aqui —copiada literal del commit anterior, con
  // su acarreo BigInt— y se corren las dos contra el mismo lote.
  //
  // El lote es DETERMINISTA (un generador congruencial con semilla fija) para
  // que un rojo se pueda reproducir. Con aleatoriedad de verdad, el caso que
  // falla se pierde al reintentar.
  // ============================================================
  const previousImplementation = (value: string): string => {
    const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value);
    if (!m) return value;
    const sign = m[1];
    let intDigits = m[2];
    const fracRaw = m[3] ?? '';
    let frac = (fracRaw + '00').slice(0, 2);
    if (fracRaw.length > 2 && fracRaw.charCodeAt(2) >= 0x35) {
      const bumped = (BigInt(intDigits + frac) + 1n)
        .toString()
        .padStart(intDigits.length + 2, '0');
      intDigits = bumped.slice(0, -2);
      frac = bumped.slice(-2);
    }
    const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = `${grouped}.${frac}`;
    return sign && out !== '0.00' ? `-${out}` : out;
  };

  it('coincide con la implementacion anterior en 5 000 importes generados', () => {
    let seed = 20260908;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const amounts: string[] = [
      // Los ceros que Postgres SI produce, fijos y no sorteados.
      '0', '0.0', '0.00', '0.0000', '-0', '-0.0000', '0.005', '-0.005', '0.4999',
    ];
    for (let i = 0; i < 5000; i++) {
      // Sin ceros a la izquierda: `numeric` de Postgres no los emite, y son el
      // UNICO punto donde las dos implementaciones difieren (la vieja imprimia
      // «0,865,504.00» por '0865504'; la nueva normaliza a «865,504.00»). Es
      // una diferencia hacia lo correcto sobre una entrada que la base no puede
      // producir, y se deja escrita aqui para que no se descubra dos veces.
      let digits = String(1 + nextInt(9));
      const length = 1 + nextInt(22);
      for (let d = 1; d < length; d++) digits += nextInt(10);
      const fractionLength = nextInt(7);
      let fraction = '';
      for (let d = 0; d < fractionLength; d++) fraction += nextInt(10);
      amounts.push(
        `${nextInt(10) < 3 ? '-' : ''}${digits}${fractionLength > 0 ? `.${fraction}` : ''}`
      );
    }
    const differing = amounts.filter((a) => formatMoneyMx(a) !== previousImplementation(a));
    expect(differing).toEqual([]);
  });

  it('el unico cambio de conducta es el cero a la izquierda, que la base no produce', () => {
    expect(previousImplementation('0865504')).toBe('0,865,504.00');
    expect(formatMoneyMx('0865504')).toBe('865,504.00');
  });

  it('agrupa los millares aunque el CLDR de manana decida que no', () => {
    // `useGrouping: 'always'` esta puesto por esto: con `'auto'`, agrupar 1000 lo
    // decide `minimumGroupingDigits` del CLDR —es-MX lo agrupa hoy, es-ES no—, y
    // debajo hay cuatro archivos con un contrato de bytes.
    expect(formatMoneyMx('1000')).toBe('1,000.00');
    expect(formatMoney('1000', { locale: 'es-ES', display: 'plain', fractionDigits: 2 })).toBe(
      '1.000,00'
    );
  });
});
