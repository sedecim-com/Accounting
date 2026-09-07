import { describe, it, expect } from 'vitest';
import {
  CLOSE_CHECK_CODES,
  CLOSE_CHECK_ITEMS,
  severidadDeLineaSinPartida,
  severidadDelAgrupadorFaltante,
  casillaDelAgrupador,
} from '../../../src/services/accounting/period-close.js';
import {
  REMEDIO_DE,
  esCodigoDeCierre,
  explainCloseCheck,
} from '../../../src/services/accounting/close-explain.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// F06b · EL REGISTRO DE CASILLAS — lo separable, sin base de datos.
//
// El contrato que estas pruebas congelan: cada casilla tiene un código
// kebab-case ESTABLE, una prosa y un remedio; `closing explain` valida el
// código ANTES de tocar la base; y la política de la línea de banco sin
// explicar sólo bloquea con su literal exacto.
// ============================================================

describe('el registro de códigos del cierre', () => {
  it('todo código es kebab-case: minúsculas, dígitos y guiones', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(codigo, `"${codigo}" no es kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('no hay códigos repetidos', () => {
    expect(new Set(CLOSE_CHECK_CODES).size).toBe(CLOSE_CHECK_CODES.length);
  });

  it('cada código tiene su prosa en CLOSE_CHECK_ITEMS', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(CLOSE_CHECK_ITEMS[codigo], `${codigo} sin prosa`).toBeTruthy();
    }
  });

  it('las prosas históricas no cambian: hay pruebas y renders que las buscan', () => {
    // Los cinco textos que existían antes de F06b, literales.
    expect(CLOSE_CHECK_ITEMS['entries-posted']).toBe('All journal entries posted');
    expect(CLOSE_CHECK_ITEMS['bank-reconciled']).toBe('Bank reconciliations complete');
    expect(CLOSE_CHECK_ITEMS['invoices-reviewed']).toBe('All invoices reviewed');
    expect(CLOSE_CHECK_ITEMS['depreciation-posted']).toBe('Depreciation calculated and posted');
    expect(CLOSE_CHECK_ITEMS['trial-balance']).toBe('Trial balance balanced');
    expect(CLOSE_CHECK_ITEMS['rep-parked']).toBe('Parked payment receipts (REP) resolved');
    expect(CLOSE_CHECK_ITEMS['rep-missing']).toBe('Payments in period have their REP');
  });

  it('cada código tiene remedio, y el remedio es un comando de mnemosine', () => {
    for (const codigo of CLOSE_CHECK_CODES) {
      expect(REMEDIO_DE[codigo], `${codigo} sin remedio`).toMatch(/^mnemosine /);
    }
  });

  it('esCodigoDeCierre distingue el registro de lo inventado', () => {
    expect(esCodigoDeCierre('bank-lines-unexplained')).toBe(true);
    expect(esCodigoDeCierre('bank_lines_unexplained')).toBe(false);
    expect(esCodigoDeCierre('')).toBe(false);
  });
});

describe('severidadDeLineaSinPartida', () => {
  it("sólo el literal 'bloquear_cierre' bloquea", () => {
    expect(severidadDeLineaSinPartida('bloquear_cierre')).toBe('blocking');
  });

  it('las otras dos opciones del panel avisan', () => {
    expect(severidadDeLineaSinPartida('partida_conciliatoria')).toBe('warning');
    expect(severidadDeLineaSinPartida('suspenso')).toBe('warning');
  });

  it('un valor raro del panel no puede congelar el cierre: avisa', () => {
    expect(severidadDeLineaSinPartida('lo-que-sea')).toBe('warning');
    expect(severidadDeLineaSinPartida('')).toBe('warning');
    expect(severidadDeLineaSinPartida('BLOQUEAR_CIERRE')).toBe('warning');
  });
});

describe('explainCloseCheck valida ANTES de tocar la base', () => {
  it('un código desconocido es error de uso que lista los disponibles', async () => {
    await expect(explainCloseCheck('e-1', 'p-1', 'no-existe')).rejects.toThrow(ValidationError);
    await expect(explainCloseCheck('e-1', 'p-1', 'no-existe')).rejects.toThrow(
      /previous-period-closed/
    );
  });

  it('un límite ilegible también, con el valor que llegó', async () => {
    await expect(
      explainCloseCheck('e-1', 'p-1', 'entries-posted', { limit: 0 })
    ).rejects.toThrow(ValidationError);
    await expect(
      explainCloseCheck('e-1', 'p-1', 'entries-posted', { limit: 2.5 })
    ).rejects.toThrow(/2\.5/);
  });
});

// ============================================================
// F07a · LA CASILLA DEL AGRUPADOR — el juicio, sin base de datos.
//
// Mismo patrón que F06b: lo que se prueba renglón por renglón es CUÁNDO la
// casilla está completa, con qué peso y qué dice — no la consulta que la
// alimenta. La distinción que sostiene el caso de vacuidad: cero cuentas con
// movimiento no es cobertura completa, es que no había nada que mirar.
// ============================================================

/** Una cuenta cualquiera de las que salen sin agrupador. */
function hueco(code: string, name: string): { code: string; name: string } {
  return { code, name };
}

describe('severidadDelAgrupadorFaltante', () => {
  it("sólo el literal 'bloquear' bloquea", () => {
    expect(severidadDelAgrupadorFaltante('bloquear')).toBe('blocking');
  });

  it("el defecto del panel ('avisar') deja cerrar: los libros y la presentación son dos plazos", () => {
    expect(severidadDelAgrupadorFaltante('avisar')).toBe('warning');
  });

  it('un valor raro del panel no puede congelar el cierre de un despacho: avisa', () => {
    expect(severidadDelAgrupadorFaltante('lo-que-sea')).toBe('warning');
    expect(severidadDelAgrupadorFaltante('')).toBe('warning');
    expect(severidadDelAgrupadorFaltante('BLOQUEAR')).toBe('warning');
    expect(severidadDelAgrupadorFaltante('bloquear_cierre')).toBe('warning');
  });
});

describe('casillaDelAgrupador', () => {
  it('el código y la prosa son los del registro', () => {
    const c = casillaDelAgrupador({ poblacion: 3, huecos: [] }, 'avisar', '2026-01-31');
    expect(c.codigo).toBe('sat-agrupador-missing');
    expect(c.item).toBe(CLOSE_CHECK_ITEMS['sat-agrupador-missing']);
  });

  it('con cuentas movidas y todas mapeadas, la casilla está completa y sin detalle', () => {
    const c = casillaDelAgrupador({ poblacion: 7, huecos: [] }, 'avisar', '2026-01-31');
    expect(c.is_complete).toBe(true);
    expect(c.details).toBeUndefined();
  });

  it('VACUIDAD: sin una sola cuenta movida NO da verde, y confiesa por qué', () => {
    // El defecto que las casillas de banco y depreciación ya confesaron: cero
    // universo firmaba «revisado». Nada-que-revisar no es revisado-y-bien.
    const c = casillaDelAgrupador({ poblacion: 0, huecos: [] }, 'avisar', '2026-01-31');
    expect(c.is_complete).toBe(false);
    expect(c.details).toBe('0 cuentas con movimiento posteado hasta 2026-01-31: no se pudo comprobar');
  });

  it('la fecha del detalle de vacuidad es el CORTE del periodo, no el reloj', () => {
    const c = casillaDelAgrupador({ poblacion: 0, huecos: [] }, 'avisar', '2022-06-30');
    expect(c.details).toContain('2022-06-30');
  });

  it('los huecos se NOMBRAN: un conteo manda a buscar, una lista manda a mapear', () => {
    const c = casillaDelAgrupador(
      { poblacion: 5, huecos: [hueco('1120', 'Bancos'), hueco('5100', 'Gastos generales')] },
      'avisar',
      '2026-01-31'
    );
    expect(c.is_complete).toBe(false);
    expect(c.details).toBe(
      '2 de 5 cuenta(s) con movimiento sin agrupador: 1120 Bancos; 5100 Gastos generales'
    );
  });

  it('a partir de la sexta el detalle resume con «+N», sin perder la cuenta', () => {
    const huecos = ['1110', '1120', '1130', '2110', '5100', '6100', '7100'].map((c) =>
      hueco(c, `Cuenta ${c}`)
    );
    const c = casillaDelAgrupador({ poblacion: 40, huecos }, 'avisar', '2026-01-31');
    expect(c.details).toContain('7 de 40 cuenta(s)');
    expect(c.details).toContain('1110 Cuenta 1110');
    expect(c.details).toContain('5100 Cuenta 5100');
    expect(c.details).not.toContain('6100 Cuenta 6100');
    expect(c.details).toMatch(/\(\+2\)$/);
  });

  it("con el defecto del panel la casilla se pone en rojo y NO bloquea", () => {
    const c = casillaDelAgrupador(
      { poblacion: 5, huecos: [hueco('1120', 'Bancos')] },
      'avisar',
      '2026-01-31'
    );
    expect(c.is_complete).toBe(false);
    expect(c.severity).toBe('warning');
  });

  it("contestada 'bloquear', la misma casilla detiene el cierre", () => {
    const c = casillaDelAgrupador(
      { poblacion: 5, huecos: [hueco('1120', 'Bancos')] },
      'bloquear',
      '2026-01-31'
    );
    expect(c.severity).toBe('blocking');
  });

  it('completa, la casilla sigue publicando con qué peso vigila', () => {
    // El contrato de `severity` en una casilla completa: qué pasaría si dejara
    // de estarlo. `closing check` lo imprime también en verde.
    expect(casillaDelAgrupador({ poblacion: 9, huecos: [] }, 'bloquear', '2026-01-31').severity).toBe(
      'blocking'
    );
    expect(casillaDelAgrupador({ poblacion: 9, huecos: [] }, 'avisar', '2026-01-31').severity).toBe(
      'warning'
    );
  });
});

describe('el remedio de la casilla del agrupador', () => {
  it('manda al comando que escribe el mapeo, con su esquema', () => {
    expect(REMEDIO_DE['sat-agrupador-missing']).toContain('account map set');
    expect(REMEDIO_DE['sat-agrupador-missing']).toContain('--scheme sat-agrupador');
  });

  it('el código nuevo es del registro y `closing explain` lo acepta', () => {
    expect(esCodigoDeCierre('sat-agrupador-missing')).toBe(true);
    expect(CLOSE_CHECK_CODES).toContain('sat-agrupador-missing');
  });

  it('su prosa queda congelada como las demás: el código es el contrato, la prosa el rótulo', () => {
    expect(CLOSE_CHECK_ITEMS['sat-agrupador-missing']).toBe(
      'Accounts with movement have their SAT grouping code'
    );
  });
});
