import { describe, it, expect } from 'vitest';
import {
  huellaDeCuenta,
  runStatementChecks,
  hayBloqueantes,
  STATEMENT_CHECK_NAMES,
  type ContextoVerificacion,
  type CuentaVerificable,
  type EstadoVerificable,
  type LineaVerificable,
  type VecinoEstado,
} from '../../../src/services/banking/statement-checks.js';
import {
  normalizarExtracto,
  referenciasPromovibles,
  tipoDeMovimiento,
} from '../../../src/services/banking/bank-statement-service.js';
import type { ExtractoLeido } from '../../../src/services/banking/parsers/tipos.js';
import Decimal from 'decimal.js';

/**
 * LAS SIETE PRUEBAS, SIN POSTGRES DETRÁS.
 *
 * Es la razón entera de que `statement-checks.ts` no toque la base. Cada caso
 * de aquí —el traslape de un día, el estado corto contenido dentro de uno
 * largo, el par de reversos justo en el borde de la ventana, la cadena de
 * saldos con 0.1 + 0.2— habría necesitado sembrar dos entidades, una cuenta,
 * tres estados y sus líneas para preguntar algo que es aritmética. Escritos
 * así cuestan cuatro líneas, y por eso están escritos.
 */

const CLABE = '012180001234564321';

const cuenta = (over: Partial<CuentaVerificable> = {}): CuentaVerificable => ({
  id: 'cta-1',
  nombre: 'Operativa BBVA',
  moneda: 'MXN',
  tipo: 'checking',
  ultimos4: '4321',
  huella: huellaDeCuenta(CLABE),
  ...over,
});

const linea = (fecha: string, importe: string, descripcion = 'movimiento'): LineaVerificable => ({
  fecha,
  importe,
  descripcion,
});

const estado = (over: Partial<EstadoVerificable> = {}): EstadoVerificable => ({
  id: 'est-2',
  numeroDeEstado: null,
  periodoInicio: '2026-02-01',
  periodoFin: '2026-02-28',
  saldoInicial: '1000.00',
  saldoFinal: '1000.00',
  moneda: 'MXN',
  cuentaDeclarada: null,
  lineas: [],
  lineasDeclaradas: 0,
  ...over,
});

const ctx = (over: Partial<ContextoVerificacion> = {}): ContextoVerificacion => ({
  cuenta: cuenta(),
  estado: estado(),
  vecinos: [],
  ...over,
});

/** Un vecino con los campos que las pruebas de periodo y continuidad miran. */
const vecino = (over: Partial<VecinoEstado> & { id: string }): VecinoEstado => ({
  numeroDeEstado: null,
  periodoInicio: '2026-01-01',
  periodoFin: '2026-01-31',
  saldoInicial: '0.00',
  saldoFinal: '1000.00',
  ...over,
});

const solo = (c: ContextoVerificacion, nombre: string) => runStatementChecks(c, [nombre]);

// ============================================================
// 1 · CADENA DE SALDOS
// ============================================================

describe('cadena-de-saldos', () => {
  it('calla cuando el documento cuadra consigo mismo', () => {
    const c = ctx({
      estado: estado({
        saldoInicial: '1000.00',
        saldoFinal: '1150.50',
        lineas: [linea('2026-02-03', '-49.50'), linea('2026-02-10', '200.00')],
        lineasDeclaradas: 2,
      }),
    });
    expect(solo(c, 'cadena-de-saldos')).toEqual([]);
  });

  it('nombra la diferencia exacta cuando no cuadra', () => {
    const c = ctx({
      estado: estado({
        saldoInicial: '1000.00',
        saldoFinal: '1200.00',
        lineas: [linea('2026-02-03', '150.00')],
        lineasDeclaradas: 1,
      }),
    });
    const [h, ...resto] = solo(c, 'cadena-de-saldos');
    expect(resto).toEqual([]);
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('1150.00');
    expect(h.detalle).toContain('1200.00');
    expect(h.detalle).toContain('50.00');
  });

  /**
   * El caso que un `number` reprueba: 0.1 + 0.2 en coma flotante da
   * 0.30000000000000004 y esta prueba inventaría un descuadre de 4e-17.
   */
  it('suma con decimal.js y no con coma flotante', () => {
    const c = ctx({
      estado: estado({
        saldoInicial: '0',
        saldoFinal: '0.30',
        lineas: [linea('2026-02-01', '0.1'), linea('2026-02-02', '0.2')],
        lineasDeclaradas: 2,
      }),
    });
    expect(new Decimal(0.1).plus(0.2).eq('0.3')).toBe(true);
    expect(solo(c, 'cadena-de-saldos')).toEqual([]);
  });

  it('avisa —sin bloquear— cuando la base tiene menos líneas que el documento', () => {
    const c = ctx({
      estado: estado({
        saldoInicial: '0',
        saldoFinal: '0',
        lineas: [linea('2026-02-01', '100.00'), linea('2026-02-02', '-100.00')],
        lineasDeclaradas: 5,
      }),
    });
    const h = solo(c, 'cadena-de-saldos');
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(h[0].detalle).toContain('5');
    expect(h[0].detalle).toContain('2');
  });
});

// ============================================================
// 2 · CONTINUIDAD
// ============================================================

describe('continuidad', () => {
  it('no exige nada al primer estado de la cuenta', () => {
    const e = estado();
    expect(solo(ctx({ estado: e, vecinos: [vecino({ id: e.id, periodoInicio: e.periodoInicio, periodoFin: e.periodoFin })] }), 'continuidad')).toEqual([]);
  });

  it('encadena con el final del anterior', () => {
    const e = estado({ saldoInicial: '1000.00' });
    const c = ctx({
      estado: e,
      vecinos: [
        vecino({ id: 'est-1', saldoFinal: '1000.00' }),
        vecino({ id: e.id, periodoInicio: e.periodoInicio, periodoFin: e.periodoFin }),
      ],
    });
    expect(solo(c, 'continuidad')).toEqual([]);
  });

  it('delata el estado que falta cuando el saldo salta', () => {
    const e = estado({ saldoInicial: '1250.00' });
    const c = ctx({
      estado: e,
      vecinos: [
        vecino({ id: 'est-1', saldoFinal: '1000.00' }),
        vecino({ id: e.id, periodoInicio: e.periodoInicio, periodoFin: e.periodoFin }),
      ],
    });
    const [h] = solo(c, 'continuidad');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('1250.00');
    expect(h.detalle).toContain('1000.00');
    expect(h.detalle).toContain('250.00');
  });
});

// ============================================================
// 3 · HUECOS Y TRASLAPES
// ============================================================

describe('huecos-y-traslapes', () => {
  const conVecinos = (inicio: string, fin: string, previos: VecinoEstado[]) => {
    const e = estado({ periodoInicio: inicio, periodoFin: fin });
    return ctx({
      estado: e,
      vecinos: [...previos, vecino({ id: e.id, periodoInicio: inicio, periodoFin: fin })],
    });
  };

  it('calla cuando el periodo empieza justo al día siguiente', () => {
    const c = conVecinos('2026-02-01', '2026-02-28', [
      vecino({ id: 'est-1', periodoInicio: '2026-01-01', periodoFin: '2026-01-31' }),
    ]);
    expect(solo(c, 'huecos-y-traslapes')).toEqual([]);
  });

  it('cuenta los días que ningún estado cubre', () => {
    const c = conVecinos('2026-02-03', '2026-02-28', [
      vecino({ id: 'est-1', periodoInicio: '2026-01-01', periodoFin: '2026-01-31' }),
    ]);
    const [h] = solo(c, 'huecos-y-traslapes');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('2 día(s) sin estado');
  });

  it('cuenta los días que dos estados cubren dos veces', () => {
    const c = conVecinos('2026-01-28', '2026-02-28', [
      vecino({ id: 'est-1', periodoInicio: '2026-01-01', periodoFin: '2026-01-31' }),
    ]);
    const [h] = solo(c, 'huecos-y-traslapes');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('4 día(s) contados dos veces');
  });

  /**
   * La marca de agua sobre TODOS los anteriores, y no sólo sobre el inmediato:
   * un estado corto contenido dentro de uno largo dejaba al siguiente
   * denunciando un hueco de un mes que estaba cubierto.
   */
  it('no inventa un hueco cuando un estado corto vive dentro de uno largo', () => {
    const c = conVecinos('2026-04-01', '2026-04-30', [
      vecino({ id: 'largo', periodoInicio: '2026-01-01', periodoFin: '2026-03-31' }),
      vecino({ id: 'corto', periodoInicio: '2026-02-01', periodoFin: '2026-02-28' }),
    ]);
    expect(solo(c, 'huecos-y-traslapes')).toEqual([]);
  });
});

// ============================================================
// EL CANDIDATO QUE TODAVÍA NO ESTÁ EN LA BASE
//
// El import corre las siete pruebas ANTES de escribir, así que el estado bajo
// examen no aparece entre sus vecinos. Buscar su posición por índice devolvía
// −1 y trataba la historia entera como anterior: rellenar un mes viejo entre
// dos que ya estaban denunciaba un traslape y un salto de saldo inventados.
// ============================================================

describe('un estado intercalado que aún no existe en la base', () => {
  const historia = [
    vecino({ id: 'enero', periodoInicio: '2026-01-01', periodoFin: '2026-01-31', saldoFinal: '1000.00' }),
    vecino({
      id: 'marzo', periodoInicio: '2026-03-01', periodoFin: '2026-03-31',
      saldoInicial: '2000.00', saldoFinal: '3000.00',
    }),
  ];
  const candidato = ctx({
    estado: estado({
      id: 'todavia-sin-fila',
      periodoInicio: '2026-02-01',
      periodoFin: '2026-02-28',
      saldoInicial: '1000.00',
      saldoFinal: '2000.00',
    }),
    vecinos: historia,
  });

  it('encadena con el de enero y no con el de marzo', () => {
    expect(solo(candidato, 'continuidad')).toEqual([]);
  });

  it('no denuncia traslape con un periodo que viene después', () => {
    expect(solo(candidato, 'huecos-y-traslapes')).toEqual([]);
  });

  it('responde lo mismo una vez que ya tiene fila', () => {
    const yaGuardado = ctx({
      estado: candidato.estado,
      vecinos: [
        ...historia,
        vecino({
          id: candidato.estado.id, periodoInicio: '2026-02-01', periodoFin: '2026-02-28',
          saldoInicial: '1000.00', saldoFinal: '2000.00',
        }),
      ],
    });
    expect(runStatementChecks(yaGuardado, ['continuidad', 'huecos-y-traslapes'])).toEqual([]);
  });
});

// ============================================================
// 4 · IDENTIDAD
// ============================================================

describe('identidad', () => {
  it('acepta la CLABE completa de la propia cuenta', () => {
    const c = ctx({ estado: estado({ cuentaDeclarada: '0121 8000 1234 5643 21' }) });
    expect(solo(c, 'identidad')).toEqual([]);
  });

  it('bloquea el extracto de otra cuenta aunque el banco sea el mismo', () => {
    const c = ctx({ estado: estado({ cuentaDeclarada: '012180009999999999' }) });
    const [h] = solo(c, 'identidad');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('otra cuenta');
  });

  it('nunca repite entero el identificador ajeno en el mensaje', () => {
    const ajena = '012180009999999999';
    const c = ctx({ estado: estado({ cuentaDeclarada: ajena }) });
    expect(solo(c, 'identidad')[0].detalle).not.toContain(ajena);
  });

  it('compara por la cola cuando el archivo viene enmascarado', () => {
    expect(solo(ctx({ estado: estado({ cuentaDeclarada: '**** **** 4321' }) }), 'identidad')).toEqual([]);
    const [h] = solo(ctx({ estado: estado({ cuentaDeclarada: '**** **** 9999' }) }), 'identidad');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('…9999');
  });

  it('avisa —sin bloquear— cuando no consta qué cuenta declaró el archivo', () => {
    const [h] = solo(ctx(), 'identidad');
    expect(h.severity).toBe('warning');
    expect(hayBloqueantes([h])).toBe(false);
  });

  it('avisa cuando la cuenta no tiene identificador registrado contra el cual comparar', () => {
    const c = ctx({
      cuenta: cuenta({ ultimos4: null, huella: null }),
      estado: estado({ cuentaDeclarada: '**** 4321' }),
    });
    const [h] = solo(c, 'identidad');
    expect(h.severity).toBe('warning');
    expect(h.detalle).toContain('no tiene identificador registrado');
  });
});

// ============================================================
// 5 · MONEDA
// ============================================================

describe('moneda', () => {
  it('bloquea el extracto en otra divisa', () => {
    const [h] = solo(ctx({ estado: estado({ moneda: 'USD' }) }), 'moneda');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('USD');
    expect(h.detalle).toContain('MXN');
  });

  it('no distingue mayúsculas de minúsculas: el código es el mismo', () => {
    expect(solo(ctx({ estado: estado({ moneda: 'mxn' }) }), 'moneda')).toEqual([]);
  });
});

// ============================================================
// 6 · SECUENCIA
// ============================================================

describe('secuencia', () => {
  const conNumeros = (previo: string | null, actual: string | null) => {
    const e = estado({ numeroDeEstado: actual });
    return ctx({
      estado: e,
      vecinos: [
        vecino({ id: 'est-1', numeroDeEstado: previo }),
        vecino({ id: e.id, numeroDeEstado: actual, periodoInicio: e.periodoInicio, periodoFin: e.periodoFin }),
      ],
    });
  };

  it('acepta el consecutivo', () => {
    expect(solo(conNumeros('7', '8'), 'secuencia')).toEqual([]);
  });

  /** El caso que ninguna otra prueba ve: las fechas encadenan y falta el 8. */
  it('delata el estado faltante aunque las fechas no dejen hueco', () => {
    const [h] = solo(conNumeros('7', '9'), 'secuencia');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('falta(n) 1');
    expect(h.detalle).toContain('aunque las fechas no dejen hueco');
    // Y las fechas, en efecto, encadenan.
    expect(solo(conNumeros('7', '9'), 'huecos-y-traslapes')).toEqual([]);
  });

  it('no aplica cuando el banco no publica número', () => {
    expect(solo(conNumeros(null, null), 'secuencia')).toEqual([]);
    expect(solo(conNumeros('7', null), 'secuencia')).toEqual([]);
  });

  it('no compara series distintas: 2025-12 → 2026-01 no es un salto', () => {
    expect(solo(conNumeros('2025-12', '2026-01'), 'secuencia')).toEqual([]);
  });

  it('respeta el prefijo cuando la serie sí es la misma', () => {
    expect(solo(conNumeros('2026-07', '2026-08'), 'secuencia')).toEqual([]);
    expect(solo(conNumeros('2026-07', '2026-09'), 'secuencia')[0].severity).toBe('blocking');
  });

  it('señala la numeración que no avanza', () => {
    const [h] = solo(conNumeros('9', '9'), 'secuencia');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('no avanza');
  });
});

// ============================================================
// 7 · REVERSOS
// ============================================================

describe('reversos', () => {
  it('reporta el par opuesto sin bloquear nunca', () => {
    const c = ctx({
      estado: estado({
        saldoInicial: '0',
        saldoFinal: '0',
        lineas: [linea('2026-02-03', '-1500.00', 'Cargo TDD'), linea('2026-02-05', '1500.00', 'Devolución')],
        lineasDeclaradas: 2,
      }),
    });
    const h = solo(c, 'reversos');
    expect(h).toHaveLength(1);
    expect(h[0].severity).toBe('warning');
    expect(hayBloqueantes(h)).toBe(false);
    expect(h[0].detalle).toContain('1500.0000');
    expect(h[0].detalle).toContain('2 día(s) aparte');
  });

  it('no empareja dos movimientos del mismo signo', () => {
    const c = ctx({
      estado: estado({
        lineas: [linea('2026-02-03', '-1500.00'), linea('2026-02-05', '-1500.00')],
        lineasDeclaradas: 2,
      }),
    });
    expect(solo(c, 'reversos')).toEqual([]);
  });

  it('respeta la ventana de días', () => {
    const lejos = ctx({
      estado: estado({
        lineas: [linea('2026-02-01', '-800.00'), linea('2026-02-20', '800.00')],
        lineasDeclaradas: 2,
      }),
    });
    expect(solo(lejos, 'reversos')).toEqual([]);
    expect(runStatementChecks(lejos, ['reversos'], { diasReverso: 30 })).toHaveLength(1);
  });

  it('no usa la misma línea en dos pares', () => {
    const c = ctx({
      estado: estado({
        lineas: [
          linea('2026-02-01', '100.00'),
          linea('2026-02-02', '-100.00'),
          linea('2026-02-03', '-100.00'),
        ],
        lineasDeclaradas: 3,
      }),
    });
    expect(solo(c, 'reversos')).toHaveLength(1);
  });

  it('un importe de cero no tiene contrario', () => {
    const c = ctx({
      estado: estado({
        lineas: [linea('2026-02-01', '0.00'), linea('2026-02-02', '-0.00')],
        lineasDeclaradas: 2,
      }),
    });
    expect(solo(c, 'reversos')).toEqual([]);
  });
});

// ============================================================
// EL REGISTRO DE PRUEBAS
// ============================================================

describe('el registro de las siete', () => {
  it('sin nombres corren las siete', () => {
    expect(STATEMENT_CHECK_NAMES).toHaveLength(7);
    const e = estado({
      numeroDeEstado: '9',
      periodoInicio: '2026-02-05',
      saldoInicial: '1250.00',
      saldoFinal: '9999.00',
      moneda: 'USD',
      cuentaDeclarada: '012180009999999999',
      lineas: [linea('2026-02-06', '-10.00', 'cargo'), linea('2026-02-07', '10.00', 'reverso')],
      lineasDeclaradas: 2,
    });
    const c = ctx({
      estado: e,
      vecinos: [
        vecino({ id: 'est-1', numeroDeEstado: '7', saldoFinal: '1000.00' }),
        vecino({ id: e.id, numeroDeEstado: '9', periodoInicio: e.periodoInicio, periodoFin: e.periodoFin }),
      ],
    });
    const rotas = new Set(runStatementChecks(c).map((h) => h.check));
    expect([...rotas].sort()).toEqual([...STATEMENT_CHECK_NAMES].sort());
  });

  it('--check corre exactamente las pedidas', () => {
    const c = ctx({ estado: estado({ moneda: 'USD', saldoFinal: '5.00' }) });
    expect(runStatementChecks(c, ['moneda']).map((h) => h.check)).toEqual(['moneda']);
  });

  it('un nombre desconocido se rechaza nombrando los disponibles', () => {
    expect(() => runStatementChecks(ctx(), ['cadena'])).toThrowError(/Verificación desconocida: cadena/);
  });

  it('una fecha ilegible se rechaza en vez de comparar cadenas al azar', () => {
    expect(() => runStatementChecks(ctx({ estado: estado({ periodoInicio: '01/02/2026' }) }))).toThrowError(
      /Fecha ilegible/
    );
  });
});

// ============================================================
// LAS DOS DECISIONES PURAS DEL IMPORTADOR
// ============================================================

describe('referenciasPromovibles', () => {
  /**
   * `bank_transaction_id` lleva un UNIQUE por cuenta: una referencia repetida
   * ahí haría desaparecer la segunda línea en silencio.
   */
  it('sólo promueve las referencias que aparecen una vez en el archivo', () => {
    const set = referenciasPromovibles([
      { referencia: 'FITID-1' },
      { referencia: 'CHEQUE-100' },
      { referencia: 'CHEQUE-100' },
      { referencia: '   ' },
      {},
    ]);
    expect(set.has('FITID-1')).toBe(true);
    expect(set.has('CHEQUE-100')).toBe(false);
    expect(set.size).toBe(1);
  });
});

describe('tipoDeMovimiento', () => {
  it('deriva del signo cuando el banco no usa nuestro vocabulario', () => {
    expect(tipoDeMovimiento(new Decimal('-100'), 'DBIT')).toBe('debit');
    expect(tipoDeMovimiento(new Decimal('100'), 'T20')).toBe('credit');
    expect(tipoDeMovimiento(new Decimal('0'))).toBe('adjustment');
  });

  it('respeta el tipo declarado cuando sí es uno de los cinco del CHECK', () => {
    expect(tipoDeMovimiento(new Decimal('-100'), 'fee')).toBe('fee');
    expect(tipoDeMovimiento(new Decimal('100'), 'Interest')).toBe('interest');
  });
});

// ============================================================
// LA NORMALIZACIÓN DEL DOCUMENTO
//
// Los dos saldos son NOT NULL en la tabla y casi ningún CSV los publica, así
// que aquí se decide de dónde salen. Es la parte del import que más se parece
// a una opinión, y por eso es la que más falta hacía poder ejercitar sin base.
// ============================================================

const CUENTA_MXN = { currency_code: 'MXN', account_type: 'checking' };

const leido = (over: Partial<ExtractoLeido> = {}): ExtractoLeido => ({
  formato: 'csv',
  lineas: [
    { fecha: '2026-02-03', importe: '-49.50', descripcion: 'Comisión', crudo: {} },
    { fecha: '2026-02-10', importe: '200.00', descripcion: 'Depósito', crudo: {} },
  ],
  avisos: [],
  ...over,
});

describe('normalizarExtracto', () => {
  it('respeta los dos saldos cuando el archivo los publica', () => {
    const n = normalizarExtracto(
      leido({
        saldoInicial: '1000', saldoFinal: '1150.50', moneda: 'MXN',
        periodoInicio: '2026-02-01', periodoFin: '2026-02-28',
      }),
      CUENTA_MXN,
      null,
      {}
    );
    expect(n.saldoInicial).toBe('1000.0000');
    expect(n.saldoFinal).toBe('1150.5000');
    expect(n.avisos).toEqual([]);
  });

  /** La defensa contra el archivo truncado: se rechaza ANTES de escribir. */
  it('rechaza cuando --closing-balance contradice al archivo', () => {
    expect(() =>
      normalizarExtracto(leido({ saldoInicial: '1000', saldoFinal: '1150.50' }), CUENTA_MXN, null, {
        saldoFinalEsperado: '9000',
      })
    ).toThrowError(/1150.50 y --closing-balance afirma 9000.00/);
  });

  /**
   * El archivo cortado a la mitad parsea perfecto: sus líneas cuadran con un
   * saldo final que ya no es el del banco. Afirmarlo convierte el silencio en
   * un hallazgo de `cadena-de-saldos`.
   */
  it('con --closing-balance el archivo truncado deja de cuadrar', () => {
    const n = normalizarExtracto(leido({ saldoInicial: '1000' }), CUENTA_MXN, null, {
      saldoFinalEsperado: '5000',
    });
    expect(n.saldoFinal).toBe('5000.0000');
    const c = ctx({
      estado: estado({
        saldoInicial: n.saldoInicial,
        saldoFinal: n.saldoFinal,
        lineas: [linea('2026-02-03', '-49.50'), linea('2026-02-10', '200.00')],
        lineasDeclaradas: 2,
      }),
    });
    const [h] = solo(c, 'cadena-de-saldos');
    expect(h.severity).toBe('blocking');
    expect(h.detalle).toContain('3849.50');
  });

  it('arrastra el saldo inicial del estado anterior y lo dice', () => {
    const n = normalizarExtracto(leido({ saldoFinal: '1150.50' }), CUENTA_MXN, '1000.0000', {});
    expect(n.saldoInicial).toBe('1000.0000');
    expect(n.avisos.join(' ')).toContain('estado anterior');
  });

  it('deriva el inicial del final afirmado cuando no hay estado anterior', () => {
    const n = normalizarExtracto(leido(), CUENTA_MXN, null, { saldoFinalEsperado: '1150.50' });
    expect(n.saldoInicial).toBe('1000.0000');
    expect(n.avisos.join(' ')).toContain('se dedujo del final menos las líneas');
  });

  it('se niega cuando no hay ningún saldo del que agarrarse', () => {
    expect(() => normalizarExtracto(leido(), CUENTA_MXN, null, {})).toThrowError(/--closing-balance/);
  });

  /** Un saldo final deducido cuadra por construcción, y callarlo sería mentir. */
  it('avisa que la cadena cuadrará por construcción si dedujo el final', () => {
    const n = normalizarExtracto(leido({ saldoInicial: '1000' }), CUENTA_MXN, null, {});
    expect(n.saldoFinal).toBe('1150.5000');
    expect(n.avisos.join(' ')).toContain('no prueba nada');
  });

  it('deduce el periodo de las fechas de las líneas y lo dice', () => {
    const n = normalizarExtracto(leido({ saldoInicial: '0' }), CUENTA_MXN, null, {});
    expect(n.periodoInicio).toBe('2026-02-03');
    expect(n.periodoFin).toBe('2026-02-10');
    expect(n.avisos.join(' ')).toContain('no declara el periodo');
  });

  it('sin periodo y sin líneas no hay documento que guardar', () => {
    expect(() =>
      normalizarExtracto(leido({ lineas: [], saldoInicial: '0', saldoFinal: '0' }), CUENTA_MXN, null, {})
    ).toThrowError(/no hay estado de cuenta que guardar/);
  });

  it('asume la moneda de la cuenta y lo dice', () => {
    const n = normalizarExtracto(leido({ saldoInicial: '0' }), CUENTA_MXN, null, {});
    expect(n.moneda).toBe('MXN');
    expect(n.avisos.join(' ')).toContain('no declara moneda');
  });

  it('avisa que la caja chica se concilia contra arqueo', () => {
    const n = normalizarExtracto(leido({ saldoInicial: '0' }), { currency_code: 'MXN', account_type: 'petty-cash' }, null, {});
    expect(n.avisos.join(' ')).toContain('arqueo');
  });

  /**
   * El tipo dice que no puede pasar; el CHECK de la 051 no admite más que diez
   * formatos y un lector futuro sí puede devolver un undécimo. La prueba miente
   * al compilador a propósito para ejercitar la guarda que existe por eso.
   */
  it('rechaza un formato que source_format no admite', () => {
    const raro = { ...leido({ saldoInicial: '0' }), formato: 'pdf' } as unknown as ExtractoLeido;
    expect(() => normalizarExtracto(raro, CUENTA_MXN, null, {})).toThrowError(/source_format no admite/);
  });

  it('conserva los avisos del lector y añade los suyos', () => {
    const n = normalizarExtracto(
      leido({ saldoInicial: '0', avisos: ['fila 7 ilegible, se omitió'] }),
      CUENTA_MXN,
      null,
      {}
    );
    expect(n.avisos[0]).toBe('fila 7 ilegible, se omitió');
    expect(n.avisos.length).toBeGreaterThan(1);
  });
});
