import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import {
  listarPartidasDeLibros,
  sellarPartidas,
  liberarPartidas,
} from '../../../src/services/banking/book-items.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;

/** Un doble de client de transacción: sólo hace falta su `query`. */
const cliente = (rowCount: number) => {
  const q = vi.fn().mockResolvedValue({ rows: [], rowCount });
  return { doble: { query: q } as never, q };
};

const filaCruda = (over: Record<string, unknown> = {}) => ({
  line_id: 'jel-1',
  entry_id: 'je-1',
  entry_number: 'POL-2026-0001',
  fecha: '2026-03-01',
  importe: '-15400.0000',
  descripcion: 'Cheque 1042 a proveedor',
  antiguedad_dias: 92,
  sellada: false,
  ...over,
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ============================================================
// EL LADO DE LIBROS
// ============================================================

describe('listarPartidasDeLibros', () => {
  it('acota por entidad los DOS extremos del join, no sólo el asiento', async () => {
    await listarPartidasDeLibros('ent-1', 'cta-1', {});

    const sql = mockQuery.mock.calls[0][0] as string;
    // El vínculo entre la cuenta y el asiento es `gl_account_id`. Una cuenta de
    // mayor mal capturada —apuntando al plan de otra entidad del despacho—
    // convertiría este lector en una ventana a los libros ajenos.
    expect(sql).toContain('je.entity_id = $1');
    expect(sql).toContain('ba.entity_id = $1');
    expect(sql).toContain('ba.gl_account_id = jel.account_id');
    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', 'cta-1']);
  });

  it('pide sólo asientos contabilizados y sin sellar', async () => {
    await listarPartidasDeLibros('ent-1', 'cta-1', {});

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("je.status = 'posted'");
    expect(sql).toContain('jel.is_reconciled = false');
  });

  it('conserva el importe FIRMADO con sus cuatro decimales', async () => {
    mockQuery.mockResolvedValue({ rows: [filaCruda()], rowCount: 1 });

    const [p] = await listarPartidasDeLibros('ent-1', 'cta-1', {});

    // Negativo porque es un crédito contra la cuenta de banco: dinero que
    // SALIÓ según los libros. Un valor absoluto no distinguiría un cheque en
    // circulación de un depósito en tránsito, que son los dos hallazgos que
    // este lector existe para producir.
    expect(p.importe).toBe('-15400.0000');
    expect(p.antiguedadDias).toBe(92);
    expect(p.entryNumber).toBe('POL-2026-0001');
    expect(p.sellada).toBe(false);
  });

  it('traduce --over-days a una comparación de días enteros', async () => {
    await listarPartidasDeLibros('ent-1', 'cta-1', { overDays: 60 });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('(CURRENT_DATE - je.entry_date) > $3::int');
    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', 'cta-1', 60]);
  });

  it('encadena since y until sin desalinear los parámetros', async () => {
    await listarPartidasDeLibros('ent-1', 'cta-1', {
      since: '2026-01-01',
      until: '2026-03-31',
      overDays: 30,
    });

    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', 'cta-1', '2026-01-01', '2026-03-31', 30]);
  });

  it('rechaza una antigüedad que no es un número de días', async () => {
    await expect(
      listarPartidasDeLibros('ent-1', 'cta-1', { overDays: -3 })
    ).rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ============================================================
// EL SELLO: LAS TRES COLUMNAS O NINGUNA
// ============================================================

describe('sellarPartidas', () => {
  it('escribe las tres columnas del sello en una sola sentencia', async () => {
    const { doble, q } = cliente(2);

    await sellarPartidas(doble, ['jel-1', 'jel-2'], 'grp-1');

    const sql = q.mock.calls[0][0] as string;
    // El CHECK `jel_sello_coherente` de la 052 no admite término medio:
    // sellada implica con fecha y con dueño, o las tres vacías.
    expect(sql).toContain('is_reconciled = true');
    expect(sql).toContain('reconciled_at = NOW()');
    expect(sql).toContain('reconciliation_id = g.id');
  });

  it('acota por entidad exigiendo que la línea y el grupo coincidan', async () => {
    const { doble, q } = cliente(1);

    await sellarPartidas(doble, ['jel-1'], 'grp-1');

    const sql = q.mock.calls[0][0] as string;
    // Sin parámetro de entidad: el grupo ya sabe de quién es y el asiento
    // también. Un id de línea ajena no casa la condición y no se actualiza.
    expect(sql).toContain('je.entity_id = g.entity_id');
    expect(sql).toContain("je.status = 'posted'");
    expect(q.mock.calls[0][1]).toEqual([['jel-1'], 'grp-1']);
  });

  it('no vuelve a sellar lo ya sellado', async () => {
    const { doble, q } = cliente(1);

    await sellarPartidas(doble, ['jel-1'], 'grp-1');

    expect(q.mock.calls[0][0] as string).toContain('jel.is_reconciled = false');
  });

  it('se rehúsa entero cuando no alcanzó a todas las partidas', async () => {
    // Sellar dos de tres dejaría el grupo descuadrado en silencio, y el
    // descuadre aparecería mucho más tarde, en la sesión, sin quién lo explique.
    const { doble } = cliente(2);

    await expect(sellarPartidas(doble, ['a', 'b', 'c'], 'grp-1')).rejects.toThrow(ValidationError);
    await expect(sellarPartidas(doble, ['a', 'b', 'c'], 'grp-1')).rejects.toThrow(/2 de 3/);
  });

  it('no toca la base con una lista vacía', async () => {
    const { doble, q } = cliente(0);

    expect(await sellarPartidas(doble, [], 'grp-1')).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('liberarPartidas', () => {
  it('vacía las tres columnas juntas, por el mismo CHECK que las llena juntas', async () => {
    const { doble, q } = cliente(1);

    await liberarPartidas(doble, ['jel-1']);

    const sql = q.mock.calls[0][0] as string;
    expect(sql).toContain('is_reconciled = false');
    expect(sql).toContain('reconciled_at = NULL');
    expect(sql).toContain('reconciliation_id = NULL');
  });

  it('sólo levanta el sello que puso un grupo de la MISMA entidad', async () => {
    const { doble, q } = cliente(1);

    await liberarPartidas(doble, ['jel-1']);

    const sql = q.mock.calls[0][0] as string;
    // `reconciliation_id` no tiene FK a propósito —la 052 la deja genérica para
    // la certificación de cuentas de F05e—, así que la coherencia que la base
    // no puede exigir se exige aquí.
    expect(sql).toContain('FROM reconciliation_match_groups g');
    expect(sql).toContain('g.id = jel.reconciliation_id');
    expect(sql).toContain('g.entity_id = je.entity_id');
  });

  it('avisa cuando alguna partida no se pudo liberar', async () => {
    const { doble } = cliente(0);

    await expect(liberarPartidas(doble, ['jel-1'])).rejects.toThrow(/0 de 1/);
  });
});
