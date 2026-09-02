import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  calcularAritmetica,
  monto,
  tipoPorOmisionDeLibros,
  tipoPorOmisionDeMovimiento,
  LADO_DE,
  TIPOS_DE_PARTIDA,
  type EntradaAritmetica,
  type PartidaParaAritmetica,
} from '../../../src/services/banking/reconciliation-math.js';
import { ValidationError } from '../../../src/utils/errors.js';

/**
 * LA ARITMÉTICA DE DOS LADOS, SIN POSTGRES DETRÁS.
 *
 * Es la razón entera de que `reconciliation-math.ts` no toque la base. Cada
 * caso de aquí —el mes que cuadra con tres partidas, el interés de 0.1250 que
 * no se puede recortar, el cheque de signo invertido, y sobre todo el de «todo
 * en cero porque nadie calculó nada»— habría necesitado sembrar dos entidades,
 * una cuenta, un extracto, un puñado de pólizas y una sesión para preguntar
 * algo que es una resta. Escritos así cuestan cuatro líneas, y por eso están
 * escritos: el caso incómodo es exactamente el que no se escribe cuando cuesta
 * media hora sembrarlo.
 */

const partida = (
  tipo: PartidaParaAritmetica['tipo'],
  importe: string,
  over: Partial<PartidaParaAritmetica> = {}
): PartidaParaAritmetica => ({
  tipo,
  importe,
  fechaEsperada: '2026-09-15',
  ...over,
});

const entrada = (over: Partial<EntradaAritmetica> = {}): EntradaAritmetica => ({
  saldoBanco: '10000.00',
  saldoLibros: '9900.00',
  partidas: [],
  ...over,
});

describe('calcularAritmetica · el mes que cuadra', () => {
  /**
   * El caso canónico, con números que se pueden verificar a mano:
   *   banco  10 000 − 800 (cheque) + 500 (depósito) = 9 700
   *   libros  9 900 − 200 (comisión)                = 9 700
   */
  const mesQueCuadra = entrada({
    partidas: [
      partida('cheque-en-circulacion', '-800.00'),
      partida('deposito-en-transito', '500.00'),
      partida('cargo-del-banco', '-200.00'),
    ],
  });

  it('ajusta cada lado con SUS partidas y la variación da cero', () => {
    const a = calcularAritmetica(mesQueCuadra);

    expect(a.banco.saldo).toBe('10000.00');
    expect(a.banco.ajustado).toBe('9700.00');
    expect(a.libros.saldo).toBe('9900.00');
    expect(a.libros.ajustado).toBe('9700.00');
    expect(a.variacion).toBe('0.00');
    expect(a.cuadra).toBe(true);
    expect(a.reparos).toEqual([]);
  });

  it('el desglose reparte las partidas por lado y no las mezcla', () => {
    const a = calcularAritmetica(mesQueCuadra);

    expect(a.banco.partidas).toEqual([
      { tipo: 'cheque-en-circulacion', importe: '-800.00' },
      { tipo: 'deposito-en-transito', importe: '500.00' },
    ]);
    expect(a.libros.partidas).toEqual([{ tipo: 'cargo-del-banco', importe: '-200.00' }]);
  });

  it('suma varias partidas del mismo tipo en un solo renglón del desglose', () => {
    const a = calcularAritmetica(
      entrada({
        saldoLibros: '9900.00',
        partidas: [
          partida('cheque-en-circulacion', '-500.00'),
          partida('cheque-en-circulacion', '-300.00'),
          partida('deposito-en-transito', '500.00'),
          partida('cargo-del-banco', '-200.00'),
        ],
      })
    );

    expect(a.banco.partidas).toContainEqual({ tipo: 'cheque-en-circulacion', importe: '-800.00' });
    expect(a.variacion).toBe('0.00');
    expect(a.cuadra).toBe(true);
  });
});

describe('calcularAritmetica · el signo de cada tipo', () => {
  /**
   * El signo vive en el DATO, no en el lector: la única cosa que el tipo
   * decide es a QUÉ LADO se suma. Estos seis casos fijan ese mapa, porque es
   * lo que un refactor descuidado convertiría en un árbol de `if` que un día
   * se desincroniza.
   */
  const soloUna = (p: PartidaParaAritmetica): ReturnType<typeof calcularAritmetica> =>
    calcularAritmetica(entrada({ saldoBanco: '1000.00', saldoLibros: '1000.00', partidas: [p] }));

  it('el cheque en circulación RESTA del saldo del banco', () => {
    const a = soloUna(partida('cheque-en-circulacion', '-250.00'));
    expect(a.banco.ajustado).toBe('750.00');
    expect(a.libros.ajustado).toBe('1000.00');
    expect(a.variacion).toBe('-250.00');
  });

  it('el depósito en tránsito SUMA al saldo del banco', () => {
    const a = soloUna(partida('deposito-en-transito', '250.00'));
    expect(a.banco.ajustado).toBe('1250.00');
    expect(a.variacion).toBe('250.00');
  });

  it('el cargo del banco RESTA del saldo de libros', () => {
    const a = soloUna(partida('cargo-del-banco', '-40.00'));
    expect(a.libros.ajustado).toBe('960.00');
    expect(a.banco.ajustado).toBe('1000.00');
    expect(a.variacion).toBe('40.00');
  });

  it('el abono del banco SUMA al saldo de libros', () => {
    const a = soloUna(partida('abono-del-banco', '15.50'));
    expect(a.libros.ajustado).toBe('1015.50');
    expect(a.variacion).toBe('-15.50');
  });

  it('el error del banco corrige el lado del BANCO, con el signo que traiga', () => {
    expect(soloUna(partida('error-del-banco', '-77.00')).banco.ajustado).toBe('923.00');
    expect(soloUna(partida('error-del-banco', '77.00')).banco.ajustado).toBe('1077.00');
  });

  it('el error de libros corrige el lado de LIBROS, con el signo que traiga', () => {
    expect(soloUna(partida('error-de-libros', '-77.00')).libros.ajustado).toBe('923.00');
    expect(soloUna(partida('error-de-libros', '77.00')).libros.ajustado).toBe('1077.00');
  });

  it('el mapa de lados cubre los seis tipos del CHECK de la 053, sin huecos', () => {
    for (const t of TIPOS_DE_PARTIDA) {
      expect(LADO_DE[t]).toMatch(/^(banco|libros)$/);
    }
    expect(Object.keys(LADO_DE).sort()).toEqual([...TIPOS_DE_PARTIDA].sort());
  });

  it('clasifica por omisión un movimiento del extracto y una línea de libros por su signo', () => {
    expect(tipoPorOmisionDeMovimiento('-350.00')).toBe('cargo-del-banco');
    expect(tipoPorOmisionDeMovimiento('12.75')).toBe('abono-del-banco');
    expect(tipoPorOmisionDeLibros('-900.00')).toBe('cheque-en-circulacion');
    expect(tipoPorOmisionDeLibros('900.00')).toBe('deposito-en-transito');
  });
});

describe('calcularAritmetica · la variación distinta de cero', () => {
  it('no cuadra por un solo centavo, y lo dice con los tres números', () => {
    const a = calcularAritmetica(
      entrada({ saldoBanco: '10000.00', saldoLibros: '9999.99', partidas: [] })
    );

    expect(a.variacion).toBe('0.01');
    expect(a.cuadra).toBe(false);
    const reparo = a.reparos.find((r) => r.codigo === 'variacion-fuera-de-tolerancia');
    expect(reparo).toBeDefined();
    expect(reparo?.detalle).toContain('10000.00');
    expect(reparo?.detalle).toContain('9999.99');
    expect(reparo?.detalle).toContain('0.01');
  });

  it('con `cero_exacto` (tolerancia por omisión) un centavo NO pasa', () => {
    const a = calcularAritmetica(entrada({ saldoLibros: '9900.01', partidas: [] }));
    expect(a.tolerancia).toBe('0.00');
    expect(a.cuadra).toBe(false);
  });

  it('con tolerancia declarada, el residual por debajo cuadra y el de encima no', () => {
    const dentro = calcularAritmetica(
      entrada({ saldoBanco: '100.00', saldoLibros: '99.95', tolerancia: '0.05' })
    );
    expect(dentro.cuadra).toBe(true);
    expect(dentro.variacion).toBe('0.05');
    expect(dentro.reparos).toEqual([]);

    const fuera = calcularAritmetica(
      entrada({ saldoBanco: '100.00', saldoLibros: '99.94', tolerancia: '0.05' })
    );
    expect(fuera.cuadra).toBe(false);
    expect(fuera.reparos.map((r) => r.codigo)).toContain('variacion-fuera-de-tolerancia');
  });

  it('la tolerancia se toma en valor absoluto y sirve en los dos sentidos', () => {
    const negativa = calcularAritmetica(
      entrada({ saldoBanco: '99.95', saldoLibros: '100.00', tolerancia: '0.05' })
    );
    expect(negativa.variacion).toBe('-0.05');
    expect(negativa.cuadra).toBe(true);
  });
});

describe('calcularAritmetica · EL CASO QUE ESTE TRAMO EXISTE PARA IMPEDIR', () => {
  /**
   * «Las columnas conservaban su DEFAULT 0 y la sesión reportaba variance 0 —
   * un cero que significa "nadie restó nada", mostrado como "la cuenta
   * cuadra".» Aquí eso no se puede expresar: el saldo no observado es `null`,
   * la variación resultante es `null`, y `cuadra` es falso.
   */
  it('sin extracto atado no hay variación: null, y NO cuadra', () => {
    const a = calcularAritmetica(entrada({ saldoBanco: null, saldoLibros: null, partidas: [] }));

    expect(a.banco.saldo).toBeNull();
    expect(a.banco.ajustado).toBeNull();
    expect(a.libros.ajustado).toBeNull();
    expect(a.variacion).toBeNull();
    expect(a.cuadra).toBe(false);
    expect(a.reparos.map((r) => r.codigo)).toContain('saldo-no-observado');
  });

  it('un solo lado sin observar tampoco produce variación: no se rellena con cero', () => {
    const sinBanco = calcularAritmetica(entrada({ saldoBanco: null, saldoLibros: '0.00' }));
    expect(sinBanco.variacion).toBeNull();
    expect(sinBanco.cuadra).toBe(false);

    const sinLibros = calcularAritmetica(entrada({ saldoBanco: '0.00', saldoLibros: null }));
    expect(sinLibros.variacion).toBeNull();
    expect(sinLibros.cuadra).toBe(false);
  });

  it('«no se restó» y «se restó y dio cero» son estados DISTINTOS y distinguibles', () => {
    const nadieResto = calcularAritmetica(entrada({ saldoBanco: null, saldoLibros: null }));
    const seRestoYDioCero = calcularAritmetica(entrada({ saldoBanco: '0.00', saldoLibros: '0.00' }));

    expect(nadieResto.variacion).toBeNull();
    expect(nadieResto.cuadra).toBe(false);

    expect(seRestoYDioCero.variacion).toBe('0.00');
    expect(seRestoYDioCero.cuadra).toBe(true);
    expect(seRestoYDioCero.reparos).toEqual([]);

    // El defecto histórico era que estos dos casos daban EL MISMO número.
    expect(nadieResto.variacion).not.toBe(seRestoYDioCero.variacion);
  });

  it('una cuenta dormida en ceros SÍ cuadra: cero observado es un cuadre legítimo', () => {
    const a = calcularAritmetica(entrada({ saldoBanco: '0.00', saldoLibros: '0.00' }));
    expect(a.cuadra).toBe(true);
  });
});

describe('calcularAritmetica · clasificadas y fechadas', () => {
  it('la partida sin tipo no suma a ningún lado, y cuenta en sinClasificar', () => {
    const a = calcularAritmetica(
      entrada({
        saldoBanco: '1000.00',
        saldoLibros: '1000.00',
        partidas: [partida(null, '-500.00')],
      })
    );

    expect(a.banco.ajustado).toBe('1000.00');
    expect(a.libros.ajustado).toBe('1000.00');
    expect(a.variacion).toBe('0.00');
    // Cuadra la resta, y aun así hay reparo: no es lo mismo cuadrar que cerrar.
    expect(a.cuadra).toBe(true);
    expect(a.sinClasificar).toBe(1);
    expect(a.reparos.map((r) => r.codigo)).toContain('partida-sin-clasificar');
  });

  it('cuenta las partidas abiertas sin fecha esperada, clasificadas o no', () => {
    const a = calcularAritmetica(
      entrada({
        partidas: [
          partida('cheque-en-circulacion', '-800.00', { fechaEsperada: null }),
          partida('deposito-en-transito', '500.00'),
          partida('cargo-del-banco', '-200.00', { fechaEsperada: undefined }),
        ],
      })
    );

    expect(a.sinFechar).toBe(2);
    expect(a.variacion).toBe('0.00');
    expect(a.reparos.map((r) => r.codigo)).toContain('partida-sin-fechar');
  });

  it('los movimientos del extracto sin explicar entran en sinClasificar con su reparo', () => {
    const a = calcularAritmetica(entrada({ movimientosSinExplicar: 3, saldoLibros: '10000.00' }));

    expect(a.sinClasificar).toBe(3);
    expect(a.cuadra).toBe(true);
    expect(a.reparos.map((r) => r.codigo)).toEqual(['linea-de-banco-sin-explicar']);
  });

  it('la partida resuelta se excluye de la suma, y su exclusión se cuenta', () => {
    const a = calcularAritmetica(
      entrada({
        saldoBanco: '1000.00',
        saldoLibros: '1000.00',
        partidas: [
          partida('cheque-en-circulacion', '-800.00', { resuelta: true }),
          partida('cargo-del-banco', '-40.00', { resuelta: true, fechaEsperada: null }),
        ],
      })
    );

    expect(a.banco.ajustado).toBe('1000.00');
    expect(a.libros.ajustado).toBe('1000.00');
    expect(a.resueltas).toBe(2);
    // Resuelta y sin fecha no es un reparo: ya no se persigue.
    expect(a.sinFechar).toBe(0);
    expect(a.reparos).toEqual([]);
  });
});

describe('calcularAritmetica · el dinero es cadena y decimal.js', () => {
  it('NO recorta a dos decimales lo que la columna guarda con cuatro', () => {
    // Dos intereses de 0.1250. Recortados a la salida serían 0.13 + 0.13 =
    // 0.26 contra un abono real de 0.25: un centavo denunciado que no falta.
    const a = calcularAritmetica(
      entrada({
        saldoBanco: '1000.0000',
        saldoLibros: '999.7500',
        partidas: [
          partida('abono-del-banco', '0.1250'),
          partida('abono-del-banco', '0.1250'),
        ],
      })
    );

    expect(a.libros.partidas).toEqual([{ tipo: 'abono-del-banco', importe: '0.25' }]);
    expect(a.libros.ajustado).toBe('1000.00');
    expect(a.variacion).toBe('0.00');
    expect(a.cuadra).toBe(true);
  });

  it('conserva el cuarto decimal cuando el dato de verdad lo trae', () => {
    const a = calcularAritmetica(
      entrada({
        saldoBanco: '1000.0000',
        saldoLibros: '1000.0000',
        partidas: [partida('cargo-del-banco', '-0.1250')],
      })
    );

    expect(a.libros.ajustado).toBe('999.8750');
    expect(a.variacion).toBe('0.1250');
    expect(a.cuadra).toBe(false);
  });

  it('sobrevive a 0.1 + 0.2, donde la coma flotante no', () => {
    const a = calcularAritmetica(
      entrada({
        saldoBanco: '0.30',
        saldoLibros: '0.00',
        partidas: [partida('cargo-del-banco', '0.10'), partida('cargo-del-banco', '0.20')],
      })
    );

    expect(a.libros.ajustado).toBe('0.30');
    expect(a.variacion).toBe('0.00');
    expect(a.cuadra).toBe(true);
    // Y la comprobación de que el atajo ingenuo sí falla.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('monto conserva dos decimales como mínimo y cuatro cuando los hay', () => {
    expect(monto(new Decimal('5'))).toBe('5.00');
    expect(monto(new Decimal('5.1'))).toBe('5.10');
    expect(monto(new Decimal('5.125'))).toBe('5.1250');
  });
});

describe('calcularAritmetica · lo que rechaza en vez de dejar pasar', () => {
  it('rechaza un importe ilegible en vez de tratarlo como cero', () => {
    expect(() =>
      calcularAritmetica(entrada({ partidas: [partida('cargo-del-banco', '')] }))
    ).toThrow(ValidationError);
    expect(() =>
      calcularAritmetica(entrada({ partidas: [partida('cargo-del-banco', 'n/a')] }))
    ).toThrow(ValidationError);
  });

  it('rechaza un saldo ilegible: un saldo vacío no es un saldo de cero', () => {
    expect(() => calcularAritmetica(entrada({ saldoBanco: '' }))).toThrow(ValidationError);
  });

  it('rechaza un tipo que el CHECK de la 053 no admite, sin esconderlo en un conteo', () => {
    const inventada = { tipo: 'cheque-perdido', importe: '-1.00' } as unknown as PartidaParaAritmetica;
    expect(() => calcularAritmetica(entrada({ partidas: [inventada] }))).toThrow(
      /Tipo de partida conciliatoria desconocido/
    );
  });
});
