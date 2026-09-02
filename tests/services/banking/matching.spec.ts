import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Sin Postgres detrás. Las cuatro reglas y las dos compuertas son aritmética
// sobre datos que ya están en memoria: sembrar dos entidades, una cuenta, tres
// facturas y sus asientos para preguntar si 500 casa con 500 costaría cien
// líneas de andamio y no probaría nada que no se pueda probar aquí.
//
// Lo que SÍ necesita doble es la lectura de candidatos, porque el defecto que
// tenía era de SQL —proyectaba una columna distinta de la que filtraba— y ese
// se caza mirando la consulta que sale.
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/database/scope.js', () => ({
  findByIdInScope: vi.fn(),
  requireByIdInScope: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import { query, withTransaction } from '../../../src/database/connection.js';
import { findByIdInScope, requireByIdInScope, type Scope } from '../../../src/database/scope.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import {
  evaluarReglas,
  findBestMatch,
  autoMatchUnreconciled,
  puedeAutoAplicarse,
  techoDeMontoAuto,
  descriptionSimilarity,
  type Matchable,
  type MatchResult,
  type MovimientoCotejable,
} from '../../../src/services/banking/matching.js';
import { FLOOR_MAX_AUTO_POST } from '../../../src/ai/floor.js';
import { BankTransactionType, type BankTransaction } from '../../../src/types/index.js';

const mockQuery = query as unknown as Mock;
const mockWithTransaction = withTransaction as unknown as Mock;
const mockFindByIdInScope = findByIdInScope as unknown as Mock;
const mockRequireByIdInScope = requireByIdInScope as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

const ALCANCE: Scope = { kind: 'entity', tenantId: 'inq-1', entityId: 'ent-1' };

const mov = (over: Partial<MovimientoCotejable> = {}): MovimientoCotejable => ({
  amount: '1000.0000',
  transaction_date: new Date('2026-03-10T00:00:00Z'),
  description: 'TRANSFERENCIA SPEI ACME',
  merchant_name: null,
  ...over,
});

const candidato = (over: Partial<Matchable> = {}): Matchable => ({
  id: 'cand-1',
  type: 'invoice',
  amount: '1000.0000',
  date: new Date('2026-03-10T00:00:00Z'),
  description: 'TRANSFERENCIA SPEI ACME',
  ...over,
});

const movimientoCompleto = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 'tx-1',
  bank_account_id: 'cta-1',
  bank_transaction_id: 'BBVA-0001',
  transaction_date: new Date('2026-03-10T00:00:00Z'),
  posted_date: null,
  amount: '1000.0000',
  transaction_type: BankTransactionType.CREDIT,
  description: 'TRANSFERENCIA SPEI ACME',
  merchant_name: null,
  category: null,
  raw_data: null,
  is_matched: false,
  matched_at: null,
  matched_by: null,
  confidence_score: null,
  imported_at: new Date('2026-03-11T00:00:00Z'),
  import_batch_id: null,
  ...over,
});

const filas = <T>(rows: T[]) => ({ rows, rowCount: rows.length });

beforeEach(() => {
  mockQuery.mockReset();
  mockWithTransaction.mockReset();
  mockFindByIdInScope.mockReset();
  mockRequireByIdInScope.mockReset();
  mockGetPolicy.mockReset();
});

// ============================================================
// LAS CUATRO REGLAS
// ============================================================

describe('regla 1 · importe exacto y misma fecha', () => {
  it('casa el candidato único con confianza 1.0 y lo declara auto-aplicable', () => {
    const r = evaluarReglas(mov(), [candidato()]);

    expect(r).not.toBeNull();
    expect(r!.rule).toBe('exact_amount_date');
    expect(r!.match_id).toBe('cand-1');
    expect(r!.confidence).toBe(1.0);
    expect(r!.auto_applicable).toBe(true);
    // El importe cotejado sale con los CUATRO decimales de la columna, no con
    // los dos de la costumbre: en F05a se cazaron tres defectos por esa poda.
    expect(r!.matched_amount).toBe('1000.0000');
  });

  it('no casa cuando hay dos candidatos idénticos: la ambigüedad no la resuelve esta regla', () => {
    const r = evaluarReglas(mov(), [
      candidato({ id: 'a' }),
      candidato({ id: 'b' }),
    ]);

    // Cae a las reglas siguientes, y ninguna puede nombrar un ganador sin
    // recurrir al texto. El resultado es «no sé», que es la respuesta correcta.
    expect(r).toBeNull();
  });

  it('la CUARTA cifra decimal decide: 1160.5001 no es 1160.5000', () => {
    // La poda a dos decimales —el defecto de F05a— habría hecho iguales estos
    // dos importes y la regla 1 habría casado en firme. Aquí no casa, y la
    // regla que sí lo recoge lo marca como no auto-aplicable.
    const r = evaluarReglas(
      mov({ amount: '1160.5000' }),
      [candidato({ amount: '1160.5001' })]
    );

    expect(r!.rule).not.toBe('exact_amount_date');
    expect(r!.auto_applicable).toBe(false);
  });
});

describe('regla 2 · importe exacto y fecha cercana', () => {
  it('casa dentro de los tres días con confianza 0.90 y auto-aplicable', () => {
    const r = evaluarReglas(
      mov(),
      [candidato({ date: new Date('2026-03-12T00:00:00Z') })]
    );

    expect(r!.rule).toBe('exact_amount_near_date');
    expect(r!.confidence).toBe(0.90);
    expect(r!.auto_applicable).toBe(true);
  });

  it('a cuatro días ya no es la regla 2 la que responde', () => {
    const r = evaluarReglas(
      mov(),
      [candidato({ date: new Date('2026-03-14T00:00:00Z') })]
    );

    expect(r?.rule).not.toBe('exact_amount_near_date');
  });
});

describe('regla 3 · descripción difusa', () => {
  it('con el importe DENTRO de la banda del 5 % pero no exacto, propone y no aplica', () => {
    // 1020 contra 1000: el 2 % cae en la tolerancia, así que quien elige a este
    // candidato y no a otro de la banda es la descripción. Señal blanda.
    const r = evaluarReglas(mov(), [candidato({ amount: '1020.0000' })]);

    expect(r!.rule).toBe('fuzzy_description');
    expect(r!.confidence).toBe(1.0);
    expect(r!.auto_applicable).toBe(false);
    // Y la confianza máxima NO le abre la puerta: la compuerta obedece a la
    // regla, no al número.
    expect(puedeAutoAplicarse(r!, '1000.0000', 0.85, FLOOR_MAX_AUTO_POST)).toBe(false);
  });

  it('con el importe EXACTO sí aplica, aunque la fecha esté lejos', () => {
    // Diecinueve días: las reglas 1 y 2 no llegan. Lo que sostiene el cotejo es
    // la identidad del importe al centavo, que no es texto, más una descripción
    // que confirma. Segunda señal dura.
    const r = evaluarReglas(
      mov(),
      [candidato({ date: new Date('2026-03-29T00:00:00Z') })]
    );

    expect(r!.rule).toBe('fuzzy_description');
    expect(r!.auto_applicable).toBe(true);
  });
});

describe('regla 4 · puntaje ponderado', () => {
  it('ya no se llama ml_prediction, porque no hay modelo ninguno detrás', () => {
    const r = evaluarReglas(
      mov(),
      [candidato({ amount: '1002.0000', date: new Date('2026-03-12T00:00:00Z'), description: 'TRANSFERENCIA SPEI ACMX' })]
    );

    expect(r!.rule).toBe('puntaje_ponderado');
    expect(r!.rule).not.toBe('ml_prediction');
  });

  it('supera el umbral de confianza y AUN ASÍ no se auto-aplica', () => {
    const r = evaluarReglas(
      mov(),
      [candidato({ amount: '1002.0000', date: new Date('2026-03-12T00:00:00Z'), description: 'TRANSFERENCIA SPEI ACMX' })]
    );

    // Ni el importe ni la fecha coinciden: 1002 contra 1000 y dos días de
    // separación. Con .45 y .25 de sumandos blandos el puntaje pasa de 0.85 sin
    // que ninguna señal sea una identidad, y el catálogo prohíbe aplicar eso.
    expect(r!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r!.auto_applicable).toBe(false);
    expect(puedeAutoAplicarse(r!, '1000.0000', 0.85, FLOOR_MAX_AUTO_POST)).toBe(false);
    expect(puedeAutoAplicarse(r!, '1000.0000', 0.75, FLOOR_MAX_AUTO_POST)).toBe(false);
  });
});

// ============================================================
// EL DESEMPATE, QUE ES DONDE ESTABA EL DEFECTO
// ============================================================

describe('el desempate', () => {
  it('no aplica entre dos candidatos que sólo la descripción separa', () => {
    // Mismo importe AL CENTAVO y misma fecha en los dos: las reglas 1 y 2 los
    // rechazaron por ambiguos. Y entonces la regla 3 los recogía: 'a' pasa su
    // 0.70 de parecido y 'b' no, así que se quedaba sola en la lista y se
    // aplicaba en firme —con el importe exacto como coartada, cuando el importe
    // exacto lo tenían los dos y no distinguía nada. Quien elegía era el texto.
    const r = evaluarReglas(mov(), [
      candidato({ id: 'a', description: 'TRANSFERENCIA SPEI ACME' }),
      candidato({ id: 'b', description: 'TRANSFERENCIA SPEI ACMX' }),
    ]);

    // El ganador por texto se sigue nombrando —para eso existe la vista previa—
    // pero no puede aplicarse solo.
    expect(r).not.toBeNull();
    expect(r!.rule).toBe('fuzzy_description');
    expect(r!.match_id).toBe('a');
    expect(r!.auto_applicable).toBe(false);
    expect(puedeAutoAplicarse(r!, '1000.0000', 0.85, FLOOR_MAX_AUTO_POST)).toBe(false);
  });

  it('devuelve nada cuando los dos primeros están dentro del margen', () => {
    // Idénticos en las tres señales: no hay nada que los separe, ni siquiera
    // ruido. Nombrar a uno sería inventar una razón.
    const r = evaluarReglas(mov(), [
      candidato({ id: 'a' }),
      candidato({ id: 'b' }),
    ]);

    expect(r).toBeNull();
  });

  it('la descripción que decide es la misma que la regla 3 dejó pasar de largo', () => {
    // El número que hace todo esto posible: 0.68 no llega al 0.70 que la regla
    // 3 exige, así que ese par cae siempre en manos de la regla 4.
    const s = descriptionSimilarity('TRANSFERENCIA SPEI ACME', 'TRANSFERENCIA SPEI ACMX');

    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(0.70);
  });
});

// ============================================================
// LAS DOS COMPUERTAS
// ============================================================

describe('techoDeMontoAuto · el techo se combina con el piso por Math.min', () => {
  it('respeta un techo configurado por debajo del piso', () => {
    expect(techoDeMontoAuto('10000')).toBe(10000);
  });

  it('NO deja que la configuración levante el piso', () => {
    expect(techoDeMontoAuto('999999')).toBe(FLOOR_MAX_AUTO_POST);
    expect(techoDeMontoAuto(1_000_000)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('el "0" del catálogo es «sin compuerta propia», y entonces manda el piso', () => {
    expect(techoDeMontoAuto('0')).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('un valor negativo o ilegible cierra la puerta, no la abre', () => {
    expect(techoDeMontoAuto('-1')).toBe(0);
    expect(techoDeMontoAuto('no-es-un-numero')).toBe(0);
  });
});

describe('puedeAutoAplicarse · confianza e importe son compuertas independientes', () => {
  const duro = (over: Partial<MatchResult> = {}): MatchResult => ({
    match_id: 'cand-1',
    match_type: 'invoice',
    confidence: 1.0,
    matched_amount: '1000.0000',
    rule: 'exact_amount_date',
    auto_applicable: true,
    ...over,
  });

  it('deja pasar el cotejo duro por debajo de las dos compuertas', () => {
    expect(puedeAutoAplicarse(duro(), '1000.0000', 0.85, 50000)).toBe(true);
  });

  it('el umbral configurado corta un 0.90 cuando el despacho pide 0.95', () => {
    const r = duro({ confidence: 0.90, rule: 'exact_amount_near_date' });

    expect(puedeAutoAplicarse(r, '1000.0000', 0.85, 50000)).toBe(true);
    expect(puedeAutoAplicarse(r, '1000.0000', 0.95, 50000)).toBe(false);
  });

  it('el techo corta por importe aunque la confianza sea 1.0', () => {
    // Una transferencia grande que se parece perfectamente a una factura sigue
    // siendo la que uno querría ver con sus propios ojos.
    expect(puedeAutoAplicarse(duro(), '60000.0000', 0.85, 50000)).toBe(false);
  });

  it('el techo se compara con los cuatro decimales, no con los dos de costumbre', () => {
    expect(puedeAutoAplicarse(duro(), '50000.0000', 0.85, 50000)).toBe(true);
    expect(puedeAutoAplicarse(duro(), '50000.0001', 0.85, 50000)).toBe(false);
  });

  it('el signo del movimiento no cambia el techo: un cargo de 60000 tampoco pasa', () => {
    expect(puedeAutoAplicarse(duro(), '-60000.0000', 0.85, 50000)).toBe(false);
  });
});

// ============================================================
// LA LECTURA DE CANDIDATOS: LO QUE SE FILTRA Y LO QUE SE COMPARA
// ============================================================

describe('getCandidates · la factura pagada a medias', () => {
  beforeEach(() => {
    mockFindByIdInScope.mockResolvedValue({ entity_id: 'ent-1' });
  });

  it('proyecta el SALDO y no el total, así que una parcialidad puede casar', () => {
    // Factura de 1160 con 660 ya cobrados: saldo 500. El depósito es de 500.
    // Antes entraba al rango por su saldo y se comparaba contra su total, de
    // modo que una factura parcialmente cobrada no casaba jamás.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM invoices')) {
        return Promise.resolve(filas([{
          id: 'inv-parcial',
          type: 'invoice',
          amount: '500.0000',
          date: new Date('2026-03-10T00:00:00Z'),
          description: 'Factura A-1',
        }]));
      }
      return Promise.resolve(filas([]));
    });

    return findBestMatch('cta-1', movimientoCompleto({ amount: '500.0000' }), ALCANCE).then((r) => {
      expect(r).not.toBeNull();
      expect(r!.match_id).toBe('inv-parcial');
      expect(r!.confidence).toBe(1.0);

      const sqlFacturas = mockQuery.mock.calls.map((c) => c[0] as string).find((s) => s.includes('FROM invoices'))!;
      expect(sqlFacturas).toContain('amount_due as amount');
      expect(sqlFacturas).not.toContain('total_amount as amount');

      const sqlGastos = mockQuery.mock.calls.map((c) => c[0] as string).find((s) => s.includes('FROM bills'))!;
      expect(sqlGastos).toContain('amount_due as amount');
      expect(sqlGastos).not.toContain('total_amount as amount');
    });
  });
});

// ============================================================
// LA ESCRITURA DEL AUTO-COTEJO
// ============================================================

describe('autoMatchUnreconciled', () => {
  const conPoliticas = (umbral: string, techo: string) => {
    mockGetPolicy.mockImplementation((_ctx: unknown, clave: string) =>
      Promise.resolve({
        key: clave,
        value: clave === 'cotejo_umbral_confianza' ? umbral : techo,
        defined: false,
        question: clave,
        rationale: null,
      })
    );
  };

  const conMovimientoYCandidato = (tx: BankTransaction, cand: Record<string, unknown> | null) => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM reconciliation_sessions')) return Promise.resolve(filas([{ id: 'ses-1' }]));
      if (sql.includes('FROM bank_transactions')) return Promise.resolve(filas([tx]));
      if (sql.includes('FROM invoices')) return Promise.resolve(filas(cand ? [cand] : []));
      return Promise.resolve(filas([]));
    });
  };

  const facturaGemela = (amount: string) => ({
    id: 'inv-1',
    type: 'invoice',
    amount,
    date: new Date('2026-03-10T00:00:00Z'),
    description: 'TRANSFERENCIA SPEI ACME',
  });

  let clientQuery: Mock;

  beforeEach(() => {
    mockRequireByIdInScope.mockResolvedValue({ id: 'cta-1', entity_id: 'ent-1' });
    mockFindByIdInScope.mockResolvedValue({ entity_id: 'ent-1' });
    clientQuery = vi.fn().mockResolvedValue(filas([]));
    mockWithTransaction.mockImplementation((fn: (c: { query: Mock }) => Promise<unknown>) =>
      fn({ query: clientQuery })
    );
  });

  it('escribe la marca y el cotejo DENTRO de una sola transacción', async () => {
    conPoliticas('0.85', '50000');
    conMovimientoYCandidato(movimientoCompleto(), facturaGemela('1000.0000'));

    const r = await autoMatchUnreconciled('cta-1', { scope: ALCANCE });

    expect(r.matched).toBe(1);
    // Las dos escrituras sueltas dejaban `is_matched = true` sin fila de cotejo
    // si la segunda fallaba: un movimiento invisible para las dos listas.
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(clientQuery).toHaveBeenCalledTimes(2);
    expect(clientQuery.mock.calls[0][0]).toContain('UPDATE bank_transactions');
    expect(clientQuery.mock.calls[1][0]).toContain('INSERT INTO reconciliation_matches');
  });

  it('liga el cotejo a la sesión, que es lo único que su lector filtra', async () => {
    conPoliticas('0.85', '50000');
    conMovimientoYCandidato(movimientoCompleto(), facturaGemela('1000.0000'));

    await autoMatchUnreconciled('cta-1', { scope: ALCANCE, sessionId: 'ses-1' });

    const insert = clientQuery.mock.calls[1];
    expect(insert[0]).toContain('reconciliation_session_id');
    // GET /reconciliations/:id filtra por esta columna: en NULL devolvía
    // `matches: []` siempre, aunque el motor hubiera cotejado el extracto entero.
    expect((insert[1] as unknown[])[0]).toBe('ses-1');
  });

  it('sin sesión escribe NULL, que es lo correcto, no un descuido', async () => {
    conPoliticas('0.85', '50000');
    conMovimientoYCandidato(movimientoCompleto(), facturaGemela('1000.0000'));

    await autoMatchUnreconciled('cta-1', { scope: ALCANCE });

    expect((clientQuery.mock.calls[1][1] as unknown[])[0]).toBeNull();
  });

  it('rechaza una sesión que no es de esta cuenta antes de escribir nada', async () => {
    conPoliticas('0.85', '50000');
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM reconciliation_sessions')) return Promise.resolve(filas([]));
      return Promise.resolve(filas([]));
    });

    await expect(
      autoMatchUnreconciled('cta-1', { scope: ALCANCE, sessionId: 'ses-ajena' })
    ).rejects.toThrow(/Reconciliation Session/);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('el techo por importe detiene un cotejo de confianza 1.0', async () => {
    conPoliticas('0.85', '50000');
    conMovimientoYCandidato(
      movimientoCompleto({ amount: '60000.0000' }),
      facturaGemela('60000.0000')
    );

    const r = await autoMatchUnreconciled('cta-1', { scope: ALCANCE });

    expect(r.results[0].match!.confidence).toBe(1.0);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(1);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('un techo configurado por encima del piso no levanta el piso', async () => {
    conPoliticas('0.85', '999999');
    conMovimientoYCandidato(
      movimientoCompleto({ amount: '60000.0000' }),
      facturaGemela('60000.0000')
    );

    const r = await autoMatchUnreconciled('cta-1', { scope: ALCANCE });

    expect(r.matched).toBe(0);
  });

  it('el umbral del panel manda sobre el 0.85 que estaba escrito a mano', async () => {
    conPoliticas('0.95', '50000');
    conMovimientoYCandidato(
      movimientoCompleto(),
      facturaGemela('1000.0000')
    );
    // Mismo importe, tres días de diferencia: regla 2, confianza 0.90.
    conMovimientoYCandidato(
      movimientoCompleto(),
      { ...facturaGemela('1000.0000'), date: new Date('2026-03-12T00:00:00Z') }
    );

    const r = await autoMatchUnreconciled('cta-1', { scope: ALCANCE });

    expect(r.results[0].match!.confidence).toBe(0.90);
    expect(r.matched).toBe(0);
  });
});
