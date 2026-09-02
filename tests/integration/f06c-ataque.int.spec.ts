import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import {
  ORIGEN_LOTE_IMPORTADO,
  listBatches,
  showBatch,
  checkBatch,
  postBatch,
  reverseBatch,
} from '../../src/services/accounting/batch-service.js';
import { reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/utils/errors.js';

/**
 * ATAQUE ADVERSARIAL A F06c.
 *
 * F06c es el tramo que POSTEA AL MAYOR EN BLOQUE: quinientas pólizas de un
 * archivo de terceros entran al libro con un solo verbo, y el mayor de la 041
 * no admite UPDATE ni DELETE — lo que entre mal se corrige por reversa, no
 * editando. El objetivo del ataque es uno: QUE EL LOTE MIENTA O ROMPA EL
 * MAYOR. Que un lote sin verificar postee, que postear dos veces duplique,
 * que una transacción rota deje medio lote en el libro, que una reversa pise
 * una reversa, o que la entidad hermana opere el lote ajeno.
 *
 * Las filas adversarias se INSERTAN POR SQL DIRECTO, no por `entry import`:
 * el servicio declara que el payload JSONB es input no confiable aunque lo
 * haya escrito nuestro propio parser (otra versión del parser, una fila
 * tocada a mano en la base), y esa declaración sólo se prueba metiendo al
 * staging exactamente lo que el parser de F01 jamás escribiría.
 */

let A: Fixture;
let B: Fixture;

interface PayloadPoliza {
  date: string;
  description?: string;
  reference?: string;
  lines: unknown[];
}

/** Póliza válida y cuadrada en agosto: gasto contra bancos, importes como cadena. */
function payloadOk(monto = '100.00', date = '2026-08-15'): PayloadPoliza {
  return {
    date,
    description: 'póliza importada',
    lines: [
      { account: '6100', debit: monto },
      { account: '1110', credit: monto },
    ],
  };
}

/**
 * Deposita un lote directo en el staging de la 045, con control total del
 * payload — incluida basura que el parser real nunca produciría.
 */
async function prepararLote(
  f: Fixture,
  filas: Array<{ payload: unknown; parse_error?: string | null }>,
  status: 'staged' | 'checked' = 'staged'
): Promise<{ batchId: string; filaIds: string[] }> {
  enterTenant(f.tenantId);
  const batchId = uuidv4();
  const invalidas = filas.filter((r) => r.parse_error).length;
  await query(
    `INSERT INTO journal_entry_import_batches
       (id, tenant_id, entity_id, layout, file_name, file_hash, rows_total, rows_invalid, status, created_by)
     VALUES ($1, $2, $3, 'ndjson', 'ataque.ndjson', $4, $5, $6, $7, $8)`,
    [batchId, f.tenantId, f.entityId, 'f'.repeat(64), filas.length, invalidas, status, f.userId]
  );
  const filaIds: string[] = [];
  for (let i = 0; i < filas.length; i++) {
    const filaId = uuidv4();
    filaIds.push(filaId);
    await query(
      `INSERT INTO journal_entry_import_rows (id, tenant_id, batch_id, row_number, payload, parse_error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [filaId, f.tenantId, batchId, i + 1, JSON.stringify(filas[i].payload ?? {}), filas[i].parse_error ?? null]
    );
  }
  return { batchId, filaIds };
}

/** Las pólizas del lote que viven en el mayor, por el vínculo fila→póliza. */
async function polizasDelLote(f: Fixture, batchId: string): Promise<
  Array<{ id: string; entry_number: string; status: string; source_id: string; reversed_by_entry_id: string | null }>
> {
  const r = await query<{
    id: string;
    entry_number: string;
    status: string;
    source_id: string;
    reversed_by_entry_id: string | null;
  }>(
    `SELECT je.id, je.entry_number, je.status, je.source_id, je.reversed_by_entry_id
       FROM journal_entries je
       JOIN journal_entry_import_rows r
         ON r.id = je.source_id AND r.tenant_id = $1 AND r.batch_id = $2
      WHERE je.entity_id = $3 AND je.source_type = $4
      ORDER BY je.entry_number`,
    [f.tenantId, batchId, f.entityId, ORIGEN_LOTE_IMPORTADO]
  );
  return r.rows;
}

async function estadoDelLote(batchId: string): Promise<{ status: string; rows_invalid: number }> {
  const r = await query<{ status: string; rows_invalid: number }>(
    'SELECT status, rows_invalid FROM journal_entry_import_batches WHERE id = $1',
    [batchId]
  );
  return r.rows[0];
}

beforeAll(async () => {
  A = await crearInquilino('F06c ataque');
  B = await crearEntidadHermana(A, 'F06c hermana');
  // El periodo 7 de A se cierra DURO para el ataque de la fecha: julio queda
  // sellado y agosto abierto, así que toda póliza válida del archivo usa agosto.
  await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [A.periodos[7]]);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

// ── 1 · LA MÁQUINA DE ESTADOS NO SE SALTA ───────────────────────────────
describe('postear sin verificar', () => {
  it("un lote 'staged' no postea sin check: se niega y el mayor queda intacto", async () => {
    const { batchId } = await prepararLote(A, [{ payload: payloadOk() }]);

    await expect(postBatch({ tenantId: A.tenantId, entityId: A.entityId }, batchId, A.userId)).rejects.toThrow(
      /staged.*checked|checked.*staged/s
    );
    expect(await polizasDelLote(A, batchId)).toHaveLength(0);
    expect((await estadoDelLote(batchId)).status).toBe('staged');
  });

  it("check sólo desde 'staged': verificar lo verificado o lo aplicado se niega", async () => {
    const { batchId } = await prepararLote(A, [{ payload: payloadOk() }], 'checked');
    await expect(checkBatch({ tenantId: A.tenantId, entityId: A.entityId }, batchId, A.userId)).rejects.toThrow(
      ConflictError
    );
  });
});

// ── 2 · POSTEAR DOS VECES NO POSTEA DOS VECES ───────────────────────────
describe('idempotencia del post', () => {
  it('el segundo post se niega y las N pólizas siguen siendo N', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const { batchId } = await prepararLote(A, [
      { payload: payloadOk('100.00') },
      { payload: payloadOk('250.50') },
      { payload: payloadOk('33.3333') },
    ]);

    const check = await checkBatch(ctx, batchId, A.userId);
    expect(check.status).toBe('checked');
    expect(check.invalidas).toBe(0);

    const post = await postBatch(ctx, batchId, A.userId);
    expect(post.status).toBe('posted');
    expect(post.posteadas).toHaveLength(3);
    // El dinero viaja como cadena con la escala de la columna, sin flotantes.
    expect(post.total_debe).toBe('383.8333');

    await expect(postBatch(ctx, batchId, A.userId)).rejects.toThrow(ConflictError);
    await expect(postBatch(ctx, batchId, A.userId, { partial: true })).rejects.toThrow(ConflictError);

    const polizas = await polizasDelLote(A, batchId);
    expect(polizas).toHaveLength(3);
    expect(polizas.every((p) => p.status === 'posted')).toBe(true);
  });

  it('el ensayo recorre el camino real y no deja NADA escrito', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const { batchId } = await prepararLote(A, [{ payload: payloadOk('77.00') }]);
    await checkBatch(ctx, batchId, A.userId);

    const ensayo = await postBatch(ctx, batchId, A.userId, { dryRun: true });
    expect(ensayo.dryRun).toBe(true);
    expect(ensayo.posteadas).toHaveLength(1);
    // La atestación de un ensayo atestaría una póliza que no existe.
    expect(ensayo.attestations).toHaveLength(0);

    expect(await polizasDelLote(A, batchId)).toHaveLength(0);
    expect((await estadoDelLote(batchId)).status).toBe('checked');
  });
});

// ── 3 · --partial DICE LA VERDAD ────────────────────────────────────────
describe('post --partial con una fila inválida', () => {
  it('lo válido entra, lo inválido queda en staging y los contadores cuadran', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const descuadrada: PayloadPoliza = {
      date: '2026-08-15',
      lines: [
        { account: '6100', debit: '100.00' },
        { account: '1110', credit: '99.99' },
      ],
    };
    const { batchId } = await prepararLote(A, [
      { payload: payloadOk('10.00') },
      { payload: descuadrada },
      { payload: payloadOk('20.00') },
      // La fila que el parser no pudo leer también cuenta como inválida.
      { payload: {}, parse_error: 'JSON ilegible: unexpected token' },
    ]);

    const r = await postBatch(ctx, batchId, A.userId, { partial: true });
    expect(r.status).toBe('staged');
    expect(r.posteadas.map((p) => p.row_number)).toEqual([1, 3]);
    expect(r.invalidas.map((h) => h.row_number).sort()).toEqual([2, 4]);
    expect(r.total_debe).toBe('30.0000');

    const lote = await estadoDelLote(batchId);
    expect(lote.status).toBe('staged');
    expect(lote.rows_invalid).toBe(2);
    expect(await polizasDelLote(A, batchId)).toHaveLength(2);

    // Repetir el --partial no repite las pólizas: las filas ya aplicadas se
    // saltan y se reportan como tales.
    const r2 = await postBatch(ctx, batchId, A.userId, { partial: true });
    expect(r2.posteadas).toHaveLength(0);
    expect(r2.ya_posteadas).toBe(2);
    expect(r2.invalidas).toHaveLength(2);
    expect(await polizasDelLote(A, batchId)).toHaveLength(2);
  });

  it('sin --partial, un mundo que cambió tras el check no aplica NADA y nombra las filas', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    // Octubre abierto al momento del check; se cierra duro antes del post.
    const { batchId } = await prepararLote(A, [
      { payload: payloadOk('50.00', '2026-10-10') },
      { payload: payloadOk('60.00', '2026-10-11') },
    ]);
    const check = await checkBatch(ctx, batchId, A.userId);
    expect(check.status).toBe('checked');

    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [A.periodos[10]]);
    try {
      await expect(postBatch(ctx, batchId, A.userId)).rejects.toThrow(/filas 1, 2.*nada se aplicó|nada se aplicó/s);
      expect(await polizasDelLote(A, batchId)).toHaveLength(0);
      expect((await estadoDelLote(batchId)).status).toBe('checked');
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [A.periodos[10]]);
    }
  });
});

// ── 4 · LA TRANSACCIÓN ROTA NO DEJA MEDIO LOTE ──────────────────────────
describe('romper la transacción a mitad del post', () => {
  it('si la fila 2 revienta en el INSERT, la fila 1 tampoco queda: cero pólizas de medio lote', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    // 16 dígitos enteros: pasa la validación (que no conoce la escala de la
    // columna) y desborda el DECIMAL(19,4) en pleno INSERT, a mitad de la
    // transacción — el crash de infraestructura más barato de fabricar.
    const gigante = '9999999999999999.00';
    const { batchId } = await prepararLote(A, [
      { payload: payloadOk('10.00') },
      { payload: payloadOk(gigante) },
    ]);
    const check = await checkBatch(ctx, batchId, A.userId);
    // DEBILIDAD DOCUMENTADA: el check aprueba un importe que el mayor no
    // puede almacenar (AMOUNT_RE no acota magnitud). El post no miente — se
    // niega entero —, pero el operador se entera con un error de base de
    // datos y no con un hallazgo de fila.
    expect(check.status).toBe('checked');

    await expect(postBatch(ctx, batchId, A.userId)).rejects.toThrow();

    // NADA de medio lote: ni la fila 1, ni líneas huérfanas, ni saldos.
    expect(await polizasDelLote(A, batchId)).toHaveLength(0);
    expect((await estadoDelLote(batchId)).status).toBe('checked');
  });
});

// ── 5 · EL CHECK RECHAZA LOS CUATRO PAYLOADS VENENOSOS, CON SU FILA ─────
describe('los cuatro venenos en el check', () => {
  it('cuenta ajena, número con precisión rota, descuadre y periodo cerrado: cada uno con su fila y su categoría', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const { batchId } = await prepararLote(A, [
      // 1 · la cuenta de la entidad HERMANA, por UUID crudo.
      {
        payload: {
          date: '2026-08-15',
          lines: [
            { account: B.cuentas['6100'], debit: '100.00' },
            { account: '1110', credit: '100.00' },
          ],
        },
      },
      // 2 · un number JSON con la precisión rota del flotante: 0.1+0.2.
      {
        payload: {
          date: '2026-08-15',
          lines: [
            { account: '6100', debit: 0.30000000000000004 },
            { account: '1110', credit: '0.30' },
          ],
        },
      },
      // 3 · el asiento descuadrado por un centavo.
      {
        payload: {
          date: '2026-08-15',
          lines: [
            { account: '6100', debit: '500.00' },
            { account: '1110', credit: '499.99' },
          ],
        },
      },
      // 4 · la fecha dentro del julio sellado con hard_close.
      { payload: payloadOk('100.00', '2026-07-15') },
    ]);

    const r = await checkBatch(ctx, batchId, A.userId);
    expect(r.status).toBe('staged');
    expect(r.invalidas).toBe(4);
    expect(r.validas).toBe(0);

    const porFila = new Map(r.filas.map((f) => [f.row_number, f]));
    expect(porFila.get(1)?.categoria).toBe('cuenta');
    expect(porFila.get(1)?.errores.join(' ')).toContain(B.cuentas['6100']);
    expect(porFila.get(2)?.categoria).toBe('forma');
    expect(porFila.get(2)?.errores.join(' ')).toMatch(/0\.30000000000000004/);
    expect(porFila.get(3)?.categoria).toBe('validacion');
    expect(porFila.get(3)?.errores.join(' ')).toMatch(/debit|credit|balance/i);
    expect(porFila.get(4)?.categoria).toBe('periodo');
    expect(porFila.get(4)?.errores.join(' ')).toMatch(/fiscal period/i);

    expect((await estadoDelLote(batchId)).rows_invalid).toBe(4);
    expect(await polizasDelLote(A, batchId)).toHaveLength(0);
  });
});

// ── 6 · LA REVERSA ES DE TODO EL LOTE O DE NADIE ────────────────────────
describe('batch reverse', () => {
  async function lotePosteado(montos: string[]): Promise<string> {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const { batchId } = await prepararLote(A, montos.map((m) => ({ payload: payloadOk(m) })));
    await checkBatch(ctx, batchId, A.userId);
    await postBatch(ctx, batchId, A.userId);
    return batchId;
  }

  it('si alguien ya revirtió UNA póliza a mano, la reversa del lote se niega nombrándola', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const batchId = await lotePosteado(['11.00', '22.00', '33.00']);
    const polizas = await polizasDelLote(A, batchId);
    const aMano = polizas[1];
    await reverseJournalEntry(aMano.id, A.userId, { reason: 'corrección manual previa' });

    await expect(reverseBatch(ctx, batchId, A.userId, { reason: 'ataque' })).rejects.toThrow(
      new RegExp(aMano.entry_number)
    );
    // Y no reversó a las otras dos alrededor del hueco.
    const despues = await polizasDelLote(A, batchId);
    expect(despues.filter((p) => p.reversed_by_entry_id !== null)).toHaveLength(1);
  });

  it('reversar dos veces se niega: máximo una reversa por póliza (041)', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const batchId = await lotePosteado(['44.00', '55.00']);

    const r = await reverseBatch(ctx, batchId, A.userId, { reason: 'lote equivocado' });
    expect(r.espejos).toHaveLength(2);
    expect(r.status).toBe('posted');

    await expect(reverseBatch(ctx, batchId, A.userId, { reason: 'otra vez' })).rejects.toThrow(/entero/);

    // Los espejos nacen sin source_type: no cuentan como pólizas del lote y
    // el mayor neto del lote queda en cero exacto.
    const neto = await query<{ neto: string }>(
      `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS neto
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1
          AND (je.id IN (SELECT je2.id FROM journal_entries je2
                          JOIN journal_entry_import_rows r2
                            ON r2.id = je2.source_id AND r2.tenant_id = $2 AND r2.batch_id = $3
                         WHERE je2.entity_id = $1 AND je2.source_type = $4)
            OR je.reverses_entry_id IN (SELECT je3.id FROM journal_entries je3
                          JOIN journal_entry_import_rows r3
                            ON r3.id = je3.source_id AND r3.tenant_id = $2 AND r3.batch_id = $3
                         WHERE je3.entity_id = $1 AND je3.source_type = $4))`,
      [A.entityId, A.tenantId, batchId, ORIGEN_LOTE_IMPORTADO]
    );
    expect(neto.rows[0].neto).toBe('0.0000');
  });

  it('la reversa sin motivo se niega y el ensayo de reversa no escribe', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const batchId = await lotePosteado(['66.00']);

    await expect(reverseBatch(ctx, batchId, A.userId, { reason: '   ' })).rejects.toThrow(ValidationError);

    const ensayo = await reverseBatch(ctx, batchId, A.userId, { reason: 'ensayo', dryRun: true });
    expect(ensayo.espejos).toHaveLength(1);
    expect(ensayo.attestations).toHaveLength(0);
    const polizas = await polizasDelLote(A, batchId);
    expect(polizas[0].reversed_by_entry_id).toBeNull();
  });

  it('una reversa que revienta a mitad (as-of en periodo sellado) no deja NINGÚN espejo', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const batchId = await lotePosteado(['77.00', '88.00']);

    // Julio está hard_close desde el beforeAll: cada espejo fechado ahí
    // revienta dentro de la transacción única.
    await expect(
      reverseBatch(ctx, batchId, A.userId, { reason: 'fecha imposible', asOf: '2026-07-20' })
    ).rejects.toThrow();

    const polizas = await polizasDelLote(A, batchId);
    expect(polizas.every((p) => p.reversed_by_entry_id === null)).toBe(true);
    const espejos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND reverses_entry_id = ANY($2::uuid[])`,
      [A.entityId, polizas.map((p) => p.id)]
    );
    expect(espejos.rows[0].n).toBe('0');
  });
});

// ── 7 · LA ENTIDAD HERMANA NO VE, NO APLICA, NO REVIERTE ────────────────
describe('frontera de entidad (mismo inquilino)', () => {
  it('B no lista, no ve, no verifica, no postea ni reversa el lote de A — y A queda intacto', async () => {
    const ctxA = { tenantId: A.tenantId, entityId: A.entityId };
    const ctxB = { tenantId: B.tenantId, entityId: B.entityId };
    const { batchId } = await prepararLote(A, [{ payload: payloadOk('99.00') }]);
    await checkBatch(ctxA, batchId, A.userId);

    const listaB = await listBatches(ctxB, {});
    expect(listaB.map((l) => l.id)).not.toContain(batchId);

    // 404 siempre por pertenencia, nunca un error que confiese «existe».
    await expect(showBatch(ctxB, batchId)).rejects.toThrow(NotFoundError);
    await expect(checkBatch(ctxB, batchId, B.userId)).rejects.toThrow(NotFoundError);
    await expect(postBatch(ctxB, batchId, B.userId)).rejects.toThrow(NotFoundError);
    await expect(postBatch(ctxB, batchId, B.userId, { partial: true })).rejects.toThrow(NotFoundError);
    await expect(reverseBatch(ctxB, batchId, B.userId, { reason: 'robo' })).rejects.toThrow(NotFoundError);

    expect((await estadoDelLote(batchId)).status).toBe('checked');
    expect(await polizasDelLote(A, batchId)).toHaveLength(0);

    // Y tras postear A, la reversa desde B sigue siendo un 404.
    await postBatch(ctxA, batchId, A.userId);
    await expect(reverseBatch(ctxB, batchId, B.userId, { reason: 'robo' })).rejects.toThrow(NotFoundError);
    const polizas = await polizasDelLote(A, batchId);
    expect(polizas).toHaveLength(1);
    expect(polizas[0].reversed_by_entry_id).toBeNull();
  });
});

// ── 8 · EL ORIGEN DISTINGUE AL LOTE, Y `ap reconcile` LO ENSEÑA ─────────
describe('el origen de las pólizas del lote', () => {
  it('source_type=import_batch y source_id=LA FILA, exactos en ambas direcciones', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const { batchId, filaIds } = await prepararLote(A, [
      { payload: payloadOk('12.00') },
      { payload: payloadOk('34.00') },
    ]);
    await checkBatch(ctx, batchId, A.userId);
    await postBatch(ctx, batchId, A.userId);

    const polizas = await polizasDelLote(A, batchId);
    expect(polizas).toHaveLength(2);
    expect(new Set(polizas.map((p) => p.source_id))).toEqual(new Set(filaIds));

    const detalle = await showBatch(ctx, batchId);
    expect(detalle.lote.entries_posted).toBe(2);
    expect(detalle.filas.map((f) => f.entry_number).every((n) => n !== null)).toBe(true);
  });

  it('un lote que toca la cuenta de control de CxP aparece en `ap reconcile` como partida conciliatoria', async () => {
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    // La póliza importada ABONA el control 2110 (sube el pasivo del mayor)
    // sin gasto en el subdiario: exactamente lo que la conciliación debe ver.
    const { batchId } = await prepararLote(A, [
      {
        payload: {
          date: '2026-08-20',
          description: 'provisión importada',
          lines: [
            { account: '6100', debit: '1500.00' },
            { account: '2110', credit: '1500.00' },
          ],
        },
      },
    ]);
    await checkBatch(ctx, batchId, A.userId);
    await postBatch(ctx, batchId, A.userId);
    const [poliza] = await polizasDelLote(A, batchId);

    const conciliacion = await apReconcile(A.entityId, { asOf: '2026-08-31' });
    const partida = conciliacion.partidas.find((p) => p.referencia === poliza.entry_number);
    // La aritmética dice la verdad: el asiento importado sobre el control se
    // enumera y explica la diferencia. HOY el tipo con que se enumera es
    // 'asiento-manual' (ORIGENES_CXP no conoce import_batch): véase el
    // reporte del verificador — la partida existe y cuadra, la ETIQUETA es
    // la decisión de criterio pendiente.
    expect(partida).toBeDefined();
    expect(conciliacion.cuadra).toBe(false);
    expect(conciliacion.sinExplicar).toBe('0.00');
  });
});
