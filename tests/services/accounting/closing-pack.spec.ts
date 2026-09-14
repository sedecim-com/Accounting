import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  differences,
  parseClosingPack,
  sealOf,
  verdictFindings,
  CLOSING_PACK_SCHEMA_VERSION,
  type PackVerdict,
  type SealedBody,
} from '../../../src/services/accounting/closing-pack.js';

/**
 * A6 · EL SELLO Y SU FORMA CANÓNICA, SIN BASE DE DATOS.
 *
 * Lo que se prueba aquí es exactamente lo que hace que un expediente pueda
 * volver a correrse: que DOS CUERPOS IGUALES SELLEN IGUAL aunque sus claves
 * vengan en otro orden, y que dos cuerpos distintos sellen distinto. Sin eso,
 * `closing pack verify` acusaría deriva donde sólo hubo otro orden de claves
 * —y un instrumento que grita sin motivo se apaga— o callaría ante una cifra
 * cambiada, que es peor.
 *
 * La aritmética del sello no se recompone con las funciones del módulo: los
 * hashes van LITERALES, calculados fuera. Una prueba que vuelve a hashear con
 * `sealOf` para compararse consigo misma pasa en verde aunque `sealOf` haga
 * cualquier cosa.
 */

const CUERPO: SealedBody = {
  schema_version: CLOSING_PACK_SCHEMA_VERSION,
  entity: { id: '11111111-1111-4111-8111-111111111111', name: 'Acme SA de CV', tax_id: 'AAA010101AAA' },
  period: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'July 2026',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
  },
  as_of: '2026-07-31',
  criteria: {
    informes_asientos_de_cierre: 'incluir',
    informes_cuentas_archivadas: 'retirar_cuando_no_tiene_nada',
  },
  figures: {
    trial_balance: [
      {
        account_code: '1110',
        account_name: 'Bancos',
        account_type: 'asset',
        debit: '1000.0000',
        credit: '0.0000',
        balance: '1000.0000',
      },
    ],
    totals: { debit: '1000.0000', credit: '1000.0000', balanced: true },
    period_activity: [
      { source_type: 'depreciation', entries: 1, debit: '500.0000', credit: '500.0000' },
    ],
  },
};

describe('canonicalJson', () => {
  it('ordena las claves, de modo que el mismo dato sale igual escrito al revés', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('ordena también las claves anidadas', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('NO reordena los arreglos: su orden es significado, y lo fija la consulta', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omite las claves ausentes en vez de escribirlas como undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('no deja espacios: dos formatos del mismo dato sellarían distinto', () => {
    expect(canonicalJson(CUERPO)).not.toMatch(/\n| {2}/);
  });
});

describe('sealOf', () => {
  it('es estable: el mismo cuerpo, dos veces, el mismo sello', () => {
    expect(sealOf(CUERPO)).toBe(sealOf(structuredClone(CUERPO)));
  });

  it('no depende del orden en que se escribieron las claves', () => {
    const alReves = {
      figures: CUERPO.figures,
      criteria: CUERPO.criteria,
      as_of: CUERPO.as_of,
      period: CUERPO.period,
      entity: CUERPO.entity,
      schema_version: CUERPO.schema_version,
    } as SealedBody;
    expect(sealOf(alReves)).toBe(sealOf(CUERPO));
  });

  it('cambia cuando cambia UN centavo de UNA cuenta', () => {
    const movido = structuredClone(CUERPO);
    movido.figures.trial_balance[0].debit = '1000.0001';
    expect(sealOf(movido)).not.toBe(sealOf(CUERPO));
  });

  it('cambia cuando cambia el criterio del panel, aunque las cifras no', () => {
    const otroPanel = structuredClone(CUERPO);
    otroPanel.criteria.informes_asientos_de_cierre = 'excluir';
    expect(sealOf(otroPanel)).not.toBe(sealOf(CUERPO));
  });

  it('cambia cuando cambia la fecha de corte', () => {
    const otroCorte = structuredClone(CUERPO);
    otroCorte.as_of = '2026-08-31';
    expect(sealOf(otroCorte)).not.toBe(sealOf(CUERPO));
  });

  it('es un SHA-256 en hexadecimal minúsculo, que es lo que el CHECK de la 082 exige', () => {
    expect(sealOf(CUERPO)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('differences', () => {
  const cuenta = (code: string, debit: string) => ({
    account_code: code,
    account_name: `Cuenta ${code}`,
    account_type: 'asset',
    debit,
    credit: '0.0000',
    balance: debit,
  });

  it('no encuentra ninguna entre dos cuerpos iguales', () => {
    expect(differences(CUERPO, structuredClone(CUERPO))).toEqual([]);
  });

  it('nombra la RUTA de la cifra que se movió, y la clasifica como cifra', () => {
    const movido = structuredClone(CUERPO);
    movido.figures.totals.debit = '999.0000';
    expect(differences(CUERPO, movido)).toEqual([
      { kind: 'figure', path: 'figures.totals.debit', expected: '1000.0000', actual: '999.0000' },
    ]);
  });

  it('compara la balanza POR CÓDIGO: una cuenta de más en medio no acusa a las que la siguen', () => {
    // El caso que la revisión adversaria construyó: la subcuenta 1105 aparece
    // ENTRE 1100 y 1110. Por posición, 1110 se comparaba con 1105, 1120 con
    // 1110, y así hasta el final: todo el mayor «se movía» sin haberse movido.
    const antes = structuredClone(CUERPO);
    antes.figures.trial_balance = [cuenta('1100', '10.0000'), cuenta('1110', '20.0000'), cuenta('1120', '30.0000')];
    const despues = structuredClone(antes);
    despues.figures.trial_balance.splice(1, 0, cuenta('1105', '5.0000'));
    const d = differences(antes, despues);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'figure', path: 'figures.trial_balance[1105]', expected: '(absent)' });
    expect(d[0].actual).toContain('"account_code":"1105"');
  });

  it('una cuenta que desaparece se acusa por su código', () => {
    const antes = structuredClone(CUERPO);
    antes.figures.trial_balance = [cuenta('1100', '10.0000'), cuenta('1110', '20.0000')];
    const despues = structuredClone(antes);
    despues.figures.trial_balance = [cuenta('1110', '20.0000')];
    const d = differences(antes, despues);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'figure', path: 'figures.trial_balance[1100]', actual: '(absent)' });
  });

  it('un centavo en UNA cuenta se reporta en esa cuenta y en ninguna otra', () => {
    const antes = structuredClone(CUERPO);
    antes.figures.trial_balance = [cuenta('1100', '10.0000'), cuenta('1110', '20.0000')];
    const despues = structuredClone(antes);
    despues.figures.trial_balance[1].debit = '20.0100';
    expect(differences(antes, despues)).toEqual([
      { kind: 'figure', path: 'figures.trial_balance[1110].debit', expected: '20.0000', actual: '20.0100' },
    ]);
  });

  it('un renombre de la entidad es IDENTIDAD, no cifra: el mayor no se movió', () => {
    const renombrado = structuredClone(CUERPO);
    renombrado.entity.name = 'Acme Holding SA de CV';
    expect(differences(CUERPO, renombrado)).toEqual([
      { kind: 'identity', path: 'entity.name', expected: 'Acme SA de CV', actual: 'Acme Holding SA de CV' },
    ]);
  });

  it('un panel movido es CRITERIO, no cifra', () => {
    const otroPanel = structuredClone(CUERPO);
    otroPanel.criteria.informes_asientos_de_cierre = 'excluir';
    expect(differences(CUERPO, otroPanel)).toEqual([
      { kind: 'criteria', path: 'criteria.informes_asientos_de_cierre', expected: 'incluir', actual: 'excluir' },
    ]);
  });
});

describe('verdictFindings', () => {
  const limpio: PackVerdict = {
    sealIntact: true,
    issued: true,
    issuedAt: '2026-08-01 00:00:00+00',
    envelopeMatches: true,
    figuresReproduce: true,
    identityUnchanged: true,
    criteriaUnchanged: true,
    expectedSeal: 'a'.repeat(64),
    recomputedSeal: 'a'.repeat(64),
    differences: [],
  };

  it('un veredicto limpio no tiene hallazgos', () => {
    expect(verdictFindings(limpio)).toEqual({ blocking: 0, warning: 0 });
  });

  it('un archivo editado y vuelto a sellar concuerda consigo mismo, pero no fue emitido: BLOQUEA', () => {
    expect(verdictFindings({ ...limpio, issued: false, envelopeMatches: false }).blocking).toBe(1);
  });

  it('una cifra movida bloquea; un renombre o un panel movido sólo avisan', () => {
    expect(verdictFindings({ ...limpio, figuresReproduce: false })).toEqual({ blocking: 1, warning: 0 });
    expect(verdictFindings({ ...limpio, identityUnchanged: false })).toEqual({ blocking: 0, warning: 1 });
    expect(verdictFindings({ ...limpio, criteriaUnchanged: false })).toEqual({ blocking: 0, warning: 1 });
  });

  it('un sobre reescrito sobre un expediente emitido avisa; sin emisión no hay sobre con qué comparar', () => {
    expect(verdictFindings({ ...limpio, envelopeMatches: false })).toEqual({ blocking: 0, warning: 1 });
    expect(verdictFindings({ ...limpio, issued: false, envelopeMatches: false }).warning).toBe(0);
  });

  it('un sello roto bloquea', () => {
    expect(verdictFindings({ ...limpio, sealIntact: false }).blocking).toBe(1);
  });
});

describe('parseClosingPack', () => {
  const valido = {
    mnemosine_closing_pack: CLOSING_PACK_SCHEMA_VERSION,
    sealed: CUERPO,
    seal: sealOf(CUERPO),
    envelope: {
      generated_at: '2026-08-01T00:00:00.000Z',
      generated_by: null,
      run_id: null,
      period_status: 'soft_close',
    },
  };

  it('acepta un expediente bien formado', () => {
    expect(parseClosingPack(JSON.stringify(valido)).seal).toBe(valido.seal);
  });

  it('rechaza lo que no es JSON', () => {
    expect(() => parseClosingPack('no soy json')).toThrow(/not valid JSON/);
  });

  it('rechaza un JSON cualquiera que no lleve el marcador', () => {
    expect(() => parseClosingPack('{"hola":1}')).toThrow(/version marker/);
  });

  it('rechaza un expediente de una versión que este binario no entiende', () => {
    const futuro = { ...valido, mnemosine_closing_pack: CLOSING_PACK_SCHEMA_VERSION + 1 };
    expect(() => parseClosingPack(JSON.stringify(futuro))).toThrow(/understands up to/);
  });

  it('rechaza un sello que no es un SHA-256', () => {
    const malSello = { ...valido, seal: 'abc' };
    expect(() => parseClosingPack(JSON.stringify(malSello))).toThrow(/not a SHA-256/);
  });

  it('rechaza un id que no es UUID antes de que llegue a Postgres como error de conversión', () => {
    const noUuid = { ...valido, sealed: { ...CUERPO, period: { ...CUERPO.period, id: 'julio' } } };
    expect(() => parseClosingPack(JSON.stringify(noUuid))).toThrow(/not a UUID/);
  });

  it('rechaza un expediente sin cifras o sin sobre', () => {
    const sinCifras = { ...valido, sealed: { ...CUERPO, figures: undefined } };
    expect(() => parseClosingPack(JSON.stringify(sinCifras))).toThrow(/no figures/);
    const sinSobre = { ...valido, envelope: undefined };
    expect(() => parseClosingPack(JSON.stringify(sinSobre))).toThrow(/no envelope/);
  });

  it('rechaza un cuerpo sellado que no nombra entidad ni periodo', () => {
    const sinEntidad = { ...valido, sealed: { ...CUERPO, entity: undefined } };
    expect(() => parseClosingPack(JSON.stringify(sinEntidad))).toThrow(/names no entity/);
  });
});
