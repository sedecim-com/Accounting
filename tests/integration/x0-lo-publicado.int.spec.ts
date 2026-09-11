import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { blockchainOrchestrator } from '../../src/services/blockchain/orchestrator.js';
import { cryptoService } from '../../src/services/blockchain/crypto-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';

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

  it('CINCO publicaciones simultáneas terminan todas, y las versiones salen 1..5 sin hueco ni repetida', async () => {
    // WIT-01 de #210. `INSERT … SELECT COALESCE(MAX(version),0)+1` parece
    // atómico y no lo es: bajo READ COMMITTED el SELECT no bloquea, así que
    // dos publicaciones simultáneas leen el MISMO máximo y la segunda revienta
    // contra `uq_published_aggregates_version`. Republicar dejaba de estar
    // disponible justo cuando dos personas lo intentan a la vez.
    //
    // SE LANZAN CINCO Y NO DOS a propósito. Con dos, la ventana de carrera es
    // real pero estrecha y una corrida podría no dar con ella; con cinco, sin
    // el candado la colisión es prácticamente segura. Y la aserción es
    // DETERMINISTA en verde: cinco publicaciones serializadas tienen que
    // producir exactamente cinco versiones consecutivas.
    //
    // Se publica sobre el periodo 8, que es el que tiene movimiento —el 9 está
    // vacío y no habría nada que versionar—. Para no depender de cuántas
    // publicaciones dejaron las pruebas de arriba, la aserción es RELATIVA: se
    // lee el máximo antes y se exige que después la serie llegue hasta
    // `antes + 5`, contigua y sin repetir.
    const periodo = f.periodos[8]!;
    const previo = await query<{ dimension_value: string; maxv: string }>(
      `SELECT dimension_value, MAX(version)::text AS maxv FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3
        GROUP BY dimension_value`,
      [f.tenantId, f.entityId, periodo]
    );
    const antes = new Map(previo.rows.map((r) => [r.dimension_value, Number(r.maxv)]));
    const publicarEn = (): Promise<{ published: number }> =>
      blockchainOrchestrator.publishAggregates({
        tenantId: f.tenantId,
        entityId: f.entityId,
        periodId: periodo,
      });

    const resultados = await Promise.allSettled(Array.from({ length: 5 }, publicarEn));
    const caidas = resultados
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String((r.reason as Error).message));
    expect(
      caidas,
      `${caidas.length} de 5 publicaciones simultáneas fallaron: republicar no aguanta que dos ` +
        `personas lo intenten a la vez. ${caidas.slice(0, 2).join(' | ')}`
    ).toEqual([]);

    // Y las versiones, por dimensión, tienen que ser 1..5: ni repetida (la
    // llave única lo impediría) ni con hueco (que sería una publicación
    // perdida en silencio).
    const { rows } = await query<{ dimension_value: string; versiones: string }>(
      `SELECT dimension_value, string_agg(version::text, ',' ORDER BY version) AS versiones
         FROM published_aggregates
        WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3
        GROUP BY dimension_value
        ORDER BY dimension_value`,
      [f.tenantId, f.entityId, periodo]
    );
    expect(rows.length, 'ninguna dimensión quedó publicada').toBeGreaterThan(0);
    for (const d of rows) {
      const hasta = (antes.get(d.dimension_value) ?? 0) + 5;
      const esperada = Array.from({ length: hasta }, (_, i) => i + 1).join(',');
      expect(
        d.versiones,
        `la dimensión "${d.dimension_value}" no quedó con la serie contigua hasta ${hasta}: ` +
          'o una publicación se perdió, o dos se dieron el mismo número'
      ).toBe(esperada);
    }
  });

  // ── EL CONTRATO PÚBLICO, QUE ES LO ÚNICO QUE UN TERCERO VE (WIT-02) ──
  describe('lo que sale por la puerta pública', () => {
    let s: Servidor;
    beforeAll(async () => {
      // EL SELLO SE SIEMBRA, y hay que decir por qué. `commitPeriod` se niega
      // —con razón— mientras quede un asiento sin atestar, y este inquilino no
      // tiene configuración de anclaje, así que nunca se le escribe un hash y
      // el periodo no es sellable por el camino real. Lo que estas pruebas
      // miden NO es el sellado —eso es de G3 y ya tiene las suyas— sino qué
      // proyecta el contrato público sobre los agregados. Se siembra el sello
      // mínimo que la ruta exige para llegar a la parte que sí se está
      // midiendo, con el mismo INSERT que usa anclaje-simulado-superficies.
      // `is_simulated = false` porque la ruta se NIEGA (501) a presentar un
      // anclaje simulado como prueba, y hace bien: eso lo vigila G3.
      await query(
        `INSERT INTO period_commitments (
           id, tenant_id, entity_id, period_id, merkle_root, entry_count, tree_depth,
           balance_commitment, status, committed_at, is_simulated
         ) VALUES (gen_random_uuid(),$1,$2,$3,$4,1,1,'bc','committed',NOW(),false)
         ON CONFLICT DO NOTHING`,
        [f.tenantId, f.entityId, f.periodos[8]!, `0x${'c'.repeat(64)}`]
      );
      s = await levantar([['/public/v1', publicVerificationRouter]], sesionDe(f));
    });
    afterAll(async () => {
      await s.cerrar();
    });

    it('la cifra pública sale con su MONEDA y su VERSIÓN, no desnuda', async () => {
      // Un importe público sin unidad no se puede comparar ni auditar, y uno
      // sin versión no se puede citar: si mañana se republica, el tercero no
      // tiene forma de decir cuál verificó.
      const r = await pedir(
        s,
        'GET',
        `/public/v1/entities/${f.entityId}/periods/${f.periodos[8]!}`
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const data = r.body.data as { aggregates: Array<Record<string, unknown>> };
      expect(data.aggregates.length, 'la ruta no devolvió ningún agregado').toBeGreaterThan(0);
      for (const a of data.aggregates) {
        expect(a.currencyCode, `agregado sin moneda: ${JSON.stringify(a)}`).toBeTruthy();
        expect(
          typeof a.version === 'number' && (a.version as number) >= 1,
          `agregado sin versión utilizable: ${JSON.stringify(a)}`
        ).toBe(true);
      }
    });

    it('tras republicar, el tercero ve UNA fila por dimensión — la vigente, no el historial', async () => {
      // ES UNA REGRESIÓN QUE ESTE PR PUDO INTRODUCIR. Antes de la 076 la
      // unicidad garantizaba una fila por dimensión; al meter `version` en la
      // llave para que republicar AÑADA en vez de pisar, el contrato público
      // pasó a devolver la versión 1 y la 2 de la misma dimensión, con
      // importes y sellos distintos y nada que las distinguiera.
      const antes = await pedir(
        s, 'GET', `/public/v1/entities/${f.entityId}/periods/${f.periodos[8]!}`
      );
      const dimsAntes = (antes.body.data as { aggregates: Array<{ dimensionValue: string }> })
        .aggregates.map((a) => a.dimensionValue).sort();

      await publicar();

      const despues = await pedir(
        s, 'GET', `/public/v1/entities/${f.entityId}/periods/${f.periodos[8]!}`
      );
      const ags = (despues.body.data as {
        aggregates: Array<{ dimensionValue: string; version: number }>;
      }).aggregates;
      const dimsDespues = ags.map((a) => a.dimensionValue).sort();

      // Ni una fila de más: el mismo conjunto de dimensiones que antes.
      expect(
        dimsDespues,
        'republicar duplicó filas ante el tercero: está viendo el historial mezclado con lo vigente'
      ).toEqual(dimsAntes);
      expect(new Set(dimsDespues).size, 'una dimensión aparece dos veces').toBe(dimsDespues.length);

      // Y lo que ve es la ÚLTIMA versión, no la primera.
      const enBase = await query<{ dimension_value: string; maxv: string }>(
        `SELECT dimension_value, MAX(version)::text AS maxv FROM published_aggregates
          WHERE tenant_id = $1 AND entity_id = $2 AND period_id = $3
          GROUP BY dimension_value`,
        [f.tenantId, f.entityId, f.periodos[8]!]
      );
      const vigente = new Map(enBase.rows.map((x) => [x.dimension_value, Number(x.maxv)]));
      for (const a of ags) {
        expect(
          a.version,
          `la ruta entrega la versión ${a.version} de "${a.dimensionValue}" cuando la vigente es ` +
            `${vigente.get(a.dimensionValue)}`
        ).toBe(vigente.get(a.dimensionValue));
      }
    });

    it('el listado por entidad tampoco mezcla versiones, y también lleva moneda', async () => {
      // EL LISTADO SE NIEGA A PRESENTAR ANCLAJE SIMULADO (`is_simulated = false`),
      // y este inquilino no tiene configuración de anclaje, así que todo lo que
      // publica nace simulado. Sin esta línea la consulta devolvía CERO filas y
      // los bucles de abajo no se ejecutaban: la prueba pasaba EN VACÍO y dejaba
      // vivos los dos mutantes del listado. Lo comprobé mutando.
      //
      // Que el anclaje simulado no se presente como prueba lo vigila G3; lo que
      // se mide aquí es qué versión proyecta el contrato.
      await query(
        `UPDATE published_aggregates SET is_simulated = false WHERE entity_id = $1`,
        [f.entityId]
      );

      const r = await pedir(s, 'GET', `/public/v1/entities/${f.entityId}/aggregates`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const filas = r.body.data as Array<{
        dimension_value: string; period_id: string; version: number; currency_code: string | null;
      }>;
      // Y NO PUEDE PASAR EN VACÍO: si el listado no trae nada, no hay nada que
      // afirmar y los bucles de abajo mienten por omisión.
      expect(filas.length, 'el listado no devolvió ninguna fila: la prueba no mide nada').toBeGreaterThan(0);
      const claves = filas.map((x) => `${x.period_id}|${x.dimension_value}`);
      expect(new Set(claves).size, 'el listado repite dimensión+periodo: está mezclando versiones').toBe(
        claves.length
      );
      for (const x of filas) {
        expect(x.currency_code, `fila del listado sin moneda: ${JSON.stringify(x)}`).toBeTruthy();
        expect(typeof x.version).toBe('number');
      }

      // Y LA VERSIÓN ES LA VIGENTE, NO UNA CUALQUIERA. Sin esto la prueba se
      // conformaba con «una fila por dimensión» y dejaba vivo el mutante que
      // ordena por versión ASCENDENTE: seguiría dando una sola fila, pero la
      // MÁS VIEJA — el tercero verificaría contra un sello ya sustituido.
      const maximos = await query<{ period_id: string; dimension_value: string; maxv: string }>(
        `SELECT period_id, dimension_value, MAX(version)::text AS maxv
           FROM published_aggregates
          WHERE entity_id = $1 AND is_simulated = false
          GROUP BY period_id, dimension_value`,
        [f.entityId]
      );
      const vigentes = new Map(
        maximos.rows.map((x) => [`${x.period_id}|${x.dimension_value}`, Number(x.maxv)])
      );
      for (const x of filas) {
        const clave = `${x.period_id}|${x.dimension_value}`;
        expect(
          x.version,
          `el listado entrega la versión ${x.version} de "${x.dimension_value}" cuando la vigente ` +
            `es ${vigentes.get(clave)}`
        ).toBe(vigentes.get(clave));
      }
    });
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
