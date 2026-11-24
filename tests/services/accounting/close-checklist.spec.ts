import { describe, it, expect } from 'vitest';
import {
  CLOSE_CHECK_CODES,
  CLOSE_CHECK_ITEMS,
  severidadDeLineaSinPartida,
  severidadDelAgrupadorFaltante,
  casillaDelAgrupador,
  subledgerDeltaCheck,
  severityOfMissingAccrual,
  prepaidAmortizedCheck,
  yearMonthsSealedBox,
  yearSealNeedsSealedMonths,
  nameUnsealed,
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

describe('subledgerDeltaCheck (MNE-001-035, #98)', () => {
  const agrees = { control: '1190000.00', subledger: '1190000.00', delta: '0.00', balanced: true };
  const gap = { control: '1240000.00', subledger: '1190000.00', delta: '50000.00', balanced: false };

  it('a subledger that agrees with its control is green, and still says it would block', () => {
    const c = subledgerDeltaCheck('ar-subledger-delta', agrees);
    expect(c).toMatchObject({ codigo: 'ar-subledger-delta', is_complete: true, severity: 'blocking' });
    expect(c.details).toBeUndefined();
  });

  it('a delta is a BLOCKING finding that names both sides and the command that lists the causes', () => {
    for (const [code, command] of [
      ['ar-subledger-delta', 'ar reconcile'],
      ['ap-subledger-delta', 'ap reconcile'],
    ] as const) {
      const c = subledgerDeltaCheck(code, gap);
      expect(c.is_complete).toBe(false);
      expect(c.severity).toBe('blocking');
      expect(c.item).toBe(CLOSE_CHECK_ITEMS[code]);
      expect(c.details).toBe(
        `control 1240000.00 vs subledger 1190000.00 · delta 50000.00 (${command} lists the causes)`
      );
    }
  });

  it('without a control account it warns instead of signing a vacuous green', () => {
    const c = subledgerDeltaCheck('ap-subledger-delta', null);
    expect(c.is_complete).toBe(false);
    expect(c.severity).toBe('warning');
    expect(c.details).toContain('role cxp');
  });

  it('both codes are in the registry, with a remedy that is a mnemosine command', () => {
    for (const code of ['ar-subledger-delta', 'ap-subledger-delta'] as const) {
      expect(esCodigoDeCierre(code)).toBe(true);
      expect(REMEDIO_DE[code]).toMatch(/^mnemosine a[rp] reconcile/);
    }
  });
});

describe('severityOfMissingAccrual (MNE-001-129, #128)', () => {
  it("only the literal 'bloquear' blocks", () => {
    expect(severityOfMissingAccrual('bloquear')).toBe('blocking');
  });

  it("the panel default 'avisar', and any odd value, warn: an odd value cannot freeze a close", () => {
    expect(severityOfMissingAccrual('avisar')).toBe('warning');
    expect(severityOfMissingAccrual('')).toBe('warning');
    expect(severityOfMissingAccrual('BLOQUEAR')).toBe('warning');
  });
});

describe('prepaidAmortizedCheck (MNE-001-129, #128)', () => {
  const pending = [{ id: 'p1', description: 'Fleet insurance', remaining_amount: '12000.0000' }];
  const review = (reaction: string, rows: typeof pending) => ({
    periodo: 'Enero 2026',
    reaccion: reaction,
    reaccionDefinida: true,
    pendientes: rows,
    bloquea: reaction === 'bloquear' && rows.length > 0,
    mensaje: rows.length > 0 ? 'x' : null,
  });

  it('a schedule not run under the default is a red box that only warns, and names the command', () => {
    const c = prepaidAmortizedCheck(review('avisar', pending));
    expect(c).toMatchObject({ codigo: 'prepaid-amortized', is_complete: false, severity: 'warning' });
    expect(c.item).toBe(CLOSE_CHECK_ITEMS['prepaid-amortized']);
    expect(c.details).toBe('1 prepaid schedule(s) not amortized in Enero 2026 (prepaid run)');
  });

  it("answered 'bloquear', the same box stops the close", () => {
    expect(prepaidAmortizedCheck(review('bloquear', pending)).severity).toBe('blocking');
  });

  it('with nothing pending the box is green and still says with what weight it watches', () => {
    const c = prepaidAmortizedCheck(review('bloquear', []));
    expect(c).toMatchObject({ is_complete: true, severity: 'blocking' });
    expect(c.details).toBeUndefined();
  });

  it('the code is in the registry and its remedy is the prepaid run', () => {
    expect(esCodigoDeCierre('prepaid-amortized')).toBe(true);
    expect(REMEDIO_DE['prepaid-amortized']).toMatch(/^mnemosine prepaid run --period/);
  });
});

describe('yearMonthsSealedBox (MNE-001-661, #602)', () => {
  const december = { period_name: 'December 2025', status: 'soft_close' };
  const november = { period_name: 'November 2025', status: 'open' };

  it("only the literal 'accept_unsealed' lets a year be sealed over unsealed periods", () => {
    expect(yearSealNeedsSealedMonths('accept_unsealed')).toBe(false);
    expect(yearSealNeedsSealedMonths('require_hard_close')).toBe(true);
  });

  it('an odd panel value falls on the default: it never sweeps a year early', () => {
    expect(yearSealNeedsSealedMonths('')).toBe(true);
    expect(yearSealNeedsSealedMonths('ACCEPT_UNSEALED')).toBe(true);
    expect(yearSealNeedsSealedMonths('avisar')).toBe(true);
  });

  it('names each period with its status, in the order given', () => {
    expect(nameUnsealed([november, december])).toBe('November 2025 (open), December 2025 (soft_close)');
    expect(nameUnsealed([])).toBe('');
  });

  it('with every other period sealed the box is green, and at the seal it says it would block', () => {
    const box = yearMonthsSealedBox([], 'require_hard_close', 'soft_close');
    expect(box).toMatchObject({ codigo: 'year-months-sealed', is_complete: true, severity: 'blocking' });
    expect(box.item).toBe(CLOSE_CHECK_ITEMS['year-months-sealed']);
    expect(box.details).toBeUndefined();
  });

  it('under the default, at the seal, an unsealed period BLOCKS and is named with the policy', () => {
    const box = yearMonthsSealedBox([november, december], 'require_hard_close', 'soft_close');
    expect(box.is_complete).toBe(false);
    expect(box.severity).toBe('blocking');
    expect(box.details).toBe(
      'November 2025 (open), December 2025 (soft_close): not hard-closed. ' +
        'The fiscal year is not sealed over a period that still takes entries: hard-close each first, ' +
        'or answer the policy year_seal_with_unsealed_months'
    );
  });

  it('under the default, while the last period is still open, it only warns that the seal will be refused', () => {
    const box = yearMonthsSealedBox([december], 'require_hard_close', 'open');
    expect(box.is_complete).toBe(false);
    expect(box.severity).toBe('warning');
    expect(box.details).toBe(
      'December 2025 (soft_close): not hard-closed. ' +
        'The seal of the fiscal year will be refused until each is, or until the policy ' +
        'year_seal_with_unsealed_months accepts it'
    );
  });

  it('under accept_unsealed it warns in every state and says the firm accepts it', () => {
    for (const status of ['open', 'soft_close']) {
      const box = yearMonthsSealedBox([december], 'accept_unsealed', status);
      expect(box.is_complete).toBe(false);
      expect(box.severity).toBe('warning');
      expect(box.details).toBe(
        'December 2025 (soft_close): not hard-closed. ' +
          'The firm accepts sealing the fiscal year over them (policy year_seal_with_unsealed_months)'
      );
    }
  });

  it('the code is in the registry, with a remedy that names the hard close and the policy', () => {
    expect(esCodigoDeCierre('year-months-sealed')).toBe(true);
    expect(REMEDIO_DE['year-months-sealed']).toMatch(/^mnemosine close --period <period> --hard/);
    expect(REMEDIO_DE['year-months-sealed']).toContain('year_seal_with_unsealed_months');
  });
});
