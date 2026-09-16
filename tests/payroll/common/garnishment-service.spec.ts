import { describe, it, expect, vi } from 'vitest';

// La base se apaga antes de importar: todo lo que esta prueba ejercita son las
// negativas PURAS del escritor, y una negativa que necesitara Postgres para
// oírse no sería una negativa del escritor sino del esquema.
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  GARNISHMENT_TYPES,
  prepareGarnishment,
  refuseOrderWithoutAnEngine,
  requireGarnishmentType,
  requireYesNo,
  resolveAmount,
  resolveCcpaMetadata,
  type GarnishmentOrderInput,
} from '../../../src/services/payroll/common/garnishment-service.js';

// ============================================================
// LO QUE EL ESCRITOR SE NIEGA A GUARDAR, Y CON QUÉ PALABRAS
//
// Cada caso afirma la CONSECUENCIA en el mensaje y no sólo que lanzó. No es
// estilo: éste es el único sitio donde un contador aprende la diferencia entre
// «se me olvidó» y «declaré cero», y la diferencia es el cheque entero. Un
// `toThrow()` a secas dejaría pasar una reescritura que conserva la negativa y
// pierde el motivo, que es la mitad que sirve.
// ============================================================

const BASE: GarnishmentOrderInput = {
  employee_id: 'E-1042',
  type: 'child_support',
  percent_disposable: '25',
  supports_second_family: 'yes',
  arrears_over_12_weeks: 'no',
  issuing_authority: 'Travis County District Court',
  start_date: '2026-08-01',
};

describe('el vocabulario del tipo es el de la columna', () => {
  it('admite las siete que el CHECK de la 075 admite, y ninguna más', () => {
    expect([...GARNISHMENT_TYPES].sort()).toEqual(
      [
        'bankruptcy',
        'child_support',
        'creditor',
        'pension_alimenticia',
        'student_loan',
        'tax_levy_federal',
        'tax_levy_state',
      ].sort()
    );
    for (const t of GARNISHMENT_TYPES) expect(requireGarnishmentType(t)).toBe(t);
  });

  it('un tipo inventado sale como frase y no como restricción de Postgres', () => {
    expect(() => requireGarnishmentType('embargo_precautorio')).toThrow(
      /is not one of the seven the column admits/
    );
  });
});

describe('la base del importe se dice, nunca se supone', () => {
  it('sin ninguna de las tres banderas se niega, citando lo que la 075 midió', () => {
    expect(() => resolveAmount('child_support', { employee_id: 'e', type: 'child_support' })).toThrow(
      /exactly one of --amount, --percent-disposable or --percent-gross/
    );
    expect(() => resolveAmount('child_support', { employee_id: 'e', type: 'child_support' })).toThrow(
      /withholding 500 under one spelling and 0 under the other/
    );
  });

  it('con dos banderas se niega en vez de elegir una', () => {
    expect(() =>
      resolveAmount('creditor', {
        employee_id: 'e',
        type: 'creditor',
        amount: '100',
        percent_gross: '10',
      })
    ).toThrow(/--amount and --percent-gross were both given/);
  });

  it('las dos bases porcentuales son cosas distintas y las dos existen', () => {
    expect(resolveAmount('creditor', { employee_id: 'e', type: 'creditor', percent_disposable: '25' })).toEqual(
      { amount_type: 'percent_disposable', amount_value: '25.0000' }
    );
    expect(resolveAmount('creditor', { employee_id: 'e', type: 'creditor', percent_gross: '25' })).toEqual(
      { amount_type: 'percent_gross', amount_value: '25.0000' }
    );
  });

  it('un porcentaje por encima de 100 y un importe fijo de cero no son órdenes', () => {
    expect(() =>
      resolveAmount('creditor', { employee_id: 'e', type: 'creditor', percent_disposable: '120' })
    ).toThrow(/must fall in \(0, 100\]/);
    expect(() => resolveAmount('creditor', { employee_id: 'e', type: 'creditor', amount: '0' })).toThrow(
      /must be greater than zero/
    );
  });

  it('un embargo fiscal NO acepta bandera de importe, porque el motor no la leería', () => {
    expect(() =>
      resolveAmount('tax_levy_federal', {
        employee_id: 'e',
        type: 'tax_levy_federal',
        amount: '200',
      })
    ).toThrow(/takes no amount flag: --amount would be stored and never read/);
    // Y se guarda como el árbol ya lo codifica: fijo cero.
    expect(resolveAmount('tax_levy_state', { employee_id: 'e', type: 'tax_levy_state' })).toEqual({
      amount_type: 'fixed',
      amount_value: '0.0000',
    });
  });
});

describe('los topes de la CCPA se capturan o no hay orden', () => {
  it('un embargo fiscal sin su exención se niega, nombrando el cheque entero', () => {
    expect(() =>
      resolveCcpaMetadata('tax_levy_federal', { employee_id: 'e', type: 'tax_levy_federal' })
    ).toThrow(/withholds 100 % of disposable earnings/);
  });

  it('y con ella la guarda como cadena, que es lo que el motor lee de vuelta', () => {
    expect(
      resolveCcpaMetadata('tax_levy_federal', {
        employee_id: 'e',
        type: 'tax_levy_federal',
        exempt_amount: '462.50',
      })
    ).toEqual({ exempt_amount: '462.5000' });
  });

  it('una exención de CERO se niega: es el mismo cheque entero que no declararla', () => {
    // El motor hace `Math.max(0, disponible - exención)`, así que cero y
    // ausente producen la MISMA fila: 100 % del disponible con `cap_applied`
    // en null. La negativa de arriba dice exactamente eso; sin esta, la
    // bandera la contradecía.
    for (const zero of ['0', '0.00', '0.0000']) {
      expect(() =>
        resolveCcpaMetadata('tax_levy_state', {
          employee_id: 'e',
          type: 'tax_levy_state',
          exempt_amount: zero,
        })
      ).toThrow(/is the same order as one with no exemption at all/);
    }
    // Y un céntimo ya es una exención declarada, que es otra cosa.
    expect(
      resolveCcpaMetadata('tax_levy_state', {
        employee_id: 'e',
        type: 'tax_levy_state',
        exempt_amount: '0.01',
      })
    ).toEqual({ exempt_amount: '0.0100' });
  });

  it('una manutención sin la segunda familia se niega, y dice los diez puntos', () => {
    expect(() =>
      resolveCcpaMetadata('child_support', {
        employee_id: 'e',
        type: 'child_support',
        arrears_over_12_weeks: 'no',
      })
    ).toThrow(/decides a CCPA ceiling of 50 % or 60 % of disposable earnings/);
  });

  it('una manutención sin los atrasos se niega, y dice los cinco puntos', () => {
    expect(() =>
      resolveCcpaMetadata('child_support', {
        employee_id: 'e',
        type: 'child_support',
        supports_second_family: 'yes',
      })
    ).toThrow(/add five points to the CCPA ceiling/);
  });

  it('«no lo dije» y «no» son palabras distintas: no hay valor por omisión', () => {
    expect(requireYesNo('--x', 'no', 'why')).toBe(false);
    expect(requireYesNo('--x', 'yes', 'why')).toBe(true);
    expect(() => requireYesNo('--x', undefined, 'why')).toThrow(/has no default/);
    expect(() => requireYesNo('--x', 'false', 'why')).toThrow(/must be answered yes or no/);
  });

  it('la exención de un levy no se cuela en una orden que no la lee', () => {
    expect(() =>
      resolveCcpaMetadata('creditor', {
        employee_id: 'e',
        type: 'creditor',
        exempt_amount: '100',
      })
    ).toThrow(/has no use for it and the engine would never read it/);
  });
});

describe('la orden que hoy no puede retener no se da de alta', () => {
  it('la pensión alimenticia mexicana se niega, y la razón es la que el árbol sostiene', () => {
    // NO se dice que el motor «no la conozca»: la conoce —está en su unión de
    // tipos y `behaviourOf` la mapea a manutención—. Lo que la deja en cero es
    // la compuerta de país del orquestador, y lo que haría mal la aritmética
    // si se levantara es que los topes son de la CCPA y no de la LFT.
    expect(() => refuseOrderWithoutAnEngine('pension_alimenticia', 'MX')).toThrow(
      /CCPA Title III caps \(50\/55\/60\/65 % of disposable earnings\), which are US statute/
    );
    expect(() => refuseOrderWithoutAnEngine('pension_alimenticia', 'MX')).toThrow(
      /no Mexican garnishment ceiling exists in legal_parameters/
    );
  });

  it('y la negativa de la pensión nombra LOS DOS desenlaces, porque también se dispara para un estadounidense', () => {
    // El tipo se comprueba ANTES que el país, así que esta frase tiene que
    // ser cierta de los dos lados. La primera redacción cerraba con «una fila
    // que no retiene nada», que es falso justo en el caso que la prueba de
    // integración fija: contra un empleado de EE. UU. la compuerta se abre,
    // `behaviourOf` la trata como manutención y la fila SÍ retiene —con los
    // porcentajes de la CCPA que la propia frase acaba de citar—.
    expect(() => refuseOrderWithoutAnEngine('pension_alimenticia', 'US')).toThrow(
      /either withhold under a foreign statute's caps .* or withhold nothing at all/
    );
    expect(() => refuseOrderWithoutAnEngine('pension_alimenticia', 'US')).toThrow(
      /neither of those is the order the judge wrote/
    );
  });

  it('ningún tipo se da de alta contra un empleado que no es de nómina estadounidense', () => {
    expect(() => refuseOrderWithoutAnEngine('child_support', 'MX')).toThrow(
      /the garnishment cascade runs only for US employees/
    );
    expect(() => refuseOrderWithoutAnEngine('child_support', 'MX')).toThrow(
      /would change no paycheck, silently/
    );
  });

  it('contra un empleado estadounidense no se niega nada', () => {
    expect(() => refuseOrderWithoutAnEngine('child_support', 'US')).not.toThrow();
    expect(() => refuseOrderWithoutAnEngine('tax_levy_federal', 'US')).not.toThrow();
  });
});

describe('lo que la fila exige, aunque el esquema lo deje pasar', () => {
  it('sin autoridad emisora no hay orden, aunque la columna sea nulable', () => {
    expect(() => prepareGarnishment({ ...BASE, issuing_authority: '   ' })).toThrow(/--court is required/);
  });

  it('una fecha que no existe no se corre al mes siguiente en silencio', () => {
    expect(() => prepareGarnishment({ ...BASE, start_date: '2026-02-31' })).toThrow(
      /must be a real date in YYYY-MM-DD form/
    );
    expect(() => prepareGarnishment({ ...BASE, start_date: undefined })).toThrow(/--start/);
  });

  it('una orden completa se prepara con el vocabulario persistido y sus topes escritos', () => {
    const prepared = prepareGarnishment({ ...BASE, case_number: '2026-DF-004417', payee_name: 'Texas SDU' });
    expect(prepared).toEqual({
      garnishment_type: 'child_support',
      amount_type: 'percent_disposable',
      amount_value: '25.0000',
      priority: 100,
      case_number: '2026-DF-004417',
      issuing_authority: 'Travis County District Court',
      payee_name: 'Texas SDU',
      start_date: '2026-08-01',
      metadata: { supports_second_family: true, arrears_over_12_weeks: false },
    });
  });

  it('la prioridad por omisión es la de la columna, y una negativa no es prioridad', () => {
    expect(prepareGarnishment(BASE).priority).toBe(100);
    expect(() => prepareGarnishment({ ...BASE, priority: -1 })).toThrow(/whole number of 0 or more/);
  });

  it('una fecha de inicio FUTURA se niega: nada en el sistema la espera', () => {
    // La fila se escribe `is_active = true` y el motor filtra sólo por esa
    // bandera; `start_date` sólo desempata dentro de un rango. Una orden que
    // un juez fechó para dentro de nueve meses, dada de alta hoy, retiene en
    // la SIGUIENTE corrida. La ayuda de la bandera ya lo advertía y aceptaba
    // la fecha igual, que es un aviso y no una valla.
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect(() => prepareGarnishment({ ...BASE, start_date: nextYear })).toThrow(
      /is in the future and nothing in this system waits for it/
    );
    // Hoy sí, que es el borde y no el caso feliz.
    const today = new Date().toISOString().slice(0, 10);
    expect(prepareGarnishment({ ...BASE, start_date: today }).start_date).toBe(today);
    // Y el reloj es un parámetro, para que la prueba no caduque ni dependa
    // del huso de quien la corre.
    expect(() => prepareGarnishment({ ...BASE, start_date: '2026-08-02' }, { today: '2026-08-01' })).toThrow(
      /--start 2026-08-02 is in the future/
    );
  });

  it('lo que no cabe en la columna se niega con el nombre de la bandera, no con un 22001', () => {
    // `case_number VARCHAR(50)`, `issuing_authority VARCHAR(200)`,
    // `payee_name VARCHAR(200)` (008:432-434). Sin esto Postgres contesta
    // «value too long for type character varying(50)», que no lleva
    // `statusCode` y sale por el código de fallo genérico: el mismo que una
    // conexión caída, por una errata.
    expect(() => prepareGarnishment({ ...BASE, case_number: 'X'.repeat(51) })).toThrow(
      /--case is 51 characters and the column holds 50/
    );
    expect(() => prepareGarnishment({ ...BASE, payee_name: 'Y'.repeat(201) })).toThrow(
      /--payee is 201 characters and the column holds 200/
    );
    expect(() => prepareGarnishment({ ...BASE, issuing_authority: 'Z'.repeat(201) })).toThrow(
      /--court is 201 characters and the column holds 200/
    );
    // El borde exacto sí cabe.
    expect(prepareGarnishment({ ...BASE, case_number: 'X'.repeat(50) }).case_number).toHaveLength(50);
  });
});
