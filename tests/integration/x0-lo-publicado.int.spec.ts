import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { blockchainOrchestrator } from '../../src/services/blockchain/orchestrator.js';
import { cryptoService } from '../../src/services/blockchain/crypto-service.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * LO QUE SE PUBLICA A UN TERCERO (X0).
 *
 * Este publicador ya publicaba cuando la tarjeta se escribió, y NINGUNA prueba
 * lo miraba: las cuatro comprobaciones de abajo pasaban en verde con los cuatro
 * defectos vivos, porque no existían. Cada una nace de un defecto medido, no de
 * una hipótesis:
 *
 *   1. El compromiso criptográfico sellaba `total` y se publicaba `rounded`.
 *      Un tercero que verificara el sello contra la cifra publicada obtenía un
 *      fallo; uno que se fiara del sello creía un número que el sello no
 *      ampara. Peor que no sellar.
 *   2. `SUM(debit - credit)` para todo tipo de cuenta: los ingresos y los
 *      pasivos salían publicados EN NEGATIVO.
 *   3. `ON CONFLICT DO UPDATE`: republicar borraba la cifra anterior, que un
 *      tercero pudo haber citado.
 *   4. Ni moneda ni tipo de cambio: un número sin unidad.
 */
describe('X0 · lo que se publica lleva su sello, su signo y su historia', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await crearInquilino('X0 · publicador');
    await query(
      `INSERT INTO disclosure_config (tenant_id, entity_id, minimum_aggregation_count, round_to_nearest)
       VALUES ($1, $2, 1, 1000)
       ON CONFLICT (tenant_id, entity_id) DO UPDATE
         SET minimum_aggregation_count = 1, round_to_nearest = 1000`,
      [f.tenantId, f.entityId]
    );

    // EL IMPORTE NO ES MÚLTIPLO DEL REDONDEO, Y ESO ES LA PRUEBA.
    //
    // Con 12 000 y redondeo a millares, el total y lo publicado coinciden, así
    // que sellar uno u otro da el MISMO hash: la prueba del sello pasaría
    // siempre, con el defecto vivo o muerto. Lo comprobé rompiendo el arreglo a
    // mano: cero pruebas en rojo. Con 12 345.67 los dos números difieren
    // —12 345.67 sellado frente a 12 000 publicado— y la comprobación tiene
    // algo que distinguir.
    //
    // Una venta: cargo a bancos (deudora) y abono a ingresos (acreedora). El
    // ingreso es el que salía en negativo.
    const banco = f.roles.banco ?? f.cuentas['1110'];
    const ventas = f.cuentas['4100'];
    await createJournalEntry(
      f.entityId,
      fechaEnPeriodo(8),
      JournalEntryType.STANDARD,
      'X0 venta',
      [
        { account_id: banco!, debit_amount: '12345.6700', credit_amount: null, description: 'cobro' },
        { account_id: ventas!, debit_amount: null, credit_amount: '12345.6700', description: 'venta' },
      ],
      f.userId,
      { autoPost: true }
    );
    await drainAttestations(3000);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function publicar(): Promise<void> {
    await blockchainOrchestrator.publishAggregates({
      tenantId: f.tenantId,
      entityId: f.entityId,
      periodId: f.periodos[8]!,
    });
  }

  it('el sello cubre EXACTAMENTE la cifra publicada, no otra', async () => {
    await publicar();
    const { rows } = await query<{
      dimension_hash: string;
      aggregate_commitment: string;
      public_amount: string;
      dimension_value: string;
    }>(
      `SELECT dimension_hash, aggregate_commitment, public_amount, dimension_value
         FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3`,
      [f.tenantId, f.entityId, f.periodos[8]]
    );
    expect(rows.length, 'no se publicó ninguna dimensión').toBeGreaterThan(0);

    // La verificación que haría un tercero: rehacer el compromiso con lo que
    // ve publicado. Antes fallaba SIEMPRE, porque el sello cubría el importe
    // sin redondear.
    for (const r of rows) {
      const rehecho = cryptoService.sha256Hex(
        `${r.dimension_hash}:${f.periodos[8]}:${Number(r.public_amount).toFixed(4)}`
      );
      expect(
        rehecho,
        `el sello de "${r.dimension_value}" no cubre su importe publicado (${r.public_amount}): ` +
          'quien verifique desde fuera obtiene un fallo, y quien se fíe cree una cifra que el sello no ampara'
      ).toBe(r.aggregate_commitment);
    }
  });

  it('un ingreso se publica POSITIVO: el signo lo da la naturaleza de la cuenta', async () => {
    const { rows } = await query<{ public_amount: string }>(
      `SELECT public_amount FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3 AND dimension_value = 'revenue'`,
      [f.tenantId, f.entityId, f.periodos[8]]
    );
    expect(rows.length, 'no se publicó la dimensión de ingresos').toBe(1);
    expect(
      Number(rows[0]!.public_amount),
      'el ingreso salió en negativo: es SUM(debit - credit) aplicado a una cuenta acreedora, y un ' +
        'tercero no tiene cómo saber que el menos es una convención y no una pérdida'
    ).toBeGreaterThan(0);
  });

  it('republicar AÑADE una versión y deja intacta la anterior', async () => {
    const antes = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3`,
      [f.tenantId, f.entityId, f.periodos[8]]
    );
    await publicar();
    const despues = await query<{ n: string; maxv: string; minv: string }>(
      `SELECT count(*)::text AS n, MAX(version)::text AS maxv, MIN(version)::text AS minv
         FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3`,
      [f.tenantId, f.entityId, f.periodos[8]]
    );
    expect(
      Number(despues.rows[0]!.n),
      'republicar no añadió filas: la cifra anterior se sobrescribió, y lo que un tercero pudo citar ya no existe'
    ).toBeGreaterThan(Number(antes.rows[0]!.n));
    expect(Number(despues.rows[0]!.maxv), 'la segunda publicación no subió de versión').toBeGreaterThan(1);
    expect(Number(despues.rows[0]!.minv), 'la primera versión desapareció').toBe(1);
  });

  it('lo publicado dice en qué moneda está', async () => {
    const { rows } = await query<{ sin_moneda: string }>(
      `SELECT count(*)::text AS sin_moneda FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3 AND currency_code IS NULL`,
      [f.tenantId, f.entityId, f.periodos[8]]
    );
    expect(
      Number(rows[0]!.sin_moneda),
      'hay agregados publicados sin moneda: un número sin unidad no se puede comparar ni auditar'
    ).toBe(0);
  });
});
