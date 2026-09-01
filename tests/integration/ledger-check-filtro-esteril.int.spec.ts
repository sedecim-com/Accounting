import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  resolveAccount,
  getAccountBalanceByPeriod,
} from '../../src/services/accounting/account-service.js';
import { runLedgerChecks, listStaleDrafts } from '../../src/services/accounting/ledger-checks.js';

// ============================================================
// NINGUNA FORMA DE --period PUEDE DAR EL VISTO BUENO SOBRE UN MAYOR CORRUPTO.
//
// `balance` devuelve sólo los renglones DESCUADRADOS, así que un filtro que no
// casa nada y un mayor sano dan lo mismo —cero filas—, y arriba eso se imprime
// como «✔ el mayor pasa las verificaciones bloqueantes» con salida 0.
//
// El caso no era hipotético. El filtro comparaba texto con
// `period_name ILIKE '%…%'`, de modo que la forma «2026-08» —la que el manual
// mandaba correr antes de cerrar el mes— no casaba ningún periodo y devolvía el
// visto bueno con la contabilidad rota. El contador copiaba esa línea, veía el ✔
// y cerraba el periodo creyendo que había comprobado la integridad.
//
// El arreglo no fue avisar de que el filtro no casó: fue dejar de comparar
// texto. `resolvePeriod` es el resolvedor que la casa ya tenía —uuid, «2026-08»
// o parte inequívoca del nombre— y que nació porque `close -p` podía cerrar en
// silencio un mes distinto del querido. Así que aquí se afirman las dos mitades:
// las formas válidas DENUNCIAN el descuadre, y una forma que no existe LANZA en
// vez de estrenar un universo vacío y llamarlo limpio.
// ============================================================

let f: Fixture;
let cuentaId: string;

beforeAll(async () => {
  f = await crearInquilino('filtros de ledger check');
  const cuenta = await resolveAccount(f.entityId, '6100');
  cuentaId = cuenta.id;
  // La misma deriva sembrada que usa la suite de F01: una fila de saldos que
  // las líneas posteadas no respaldan.
  await query(
    `INSERT INTO account_balances (account_id, fiscal_period_id, entity_id, debit_total, credit_total, ending_balance)
     VALUES ($1, $2, $3, 777, 0, 777)
     ON CONFLICT (account_id, fiscal_period_id)
     DO UPDATE SET debit_total = account_balances.debit_total + 777,
                   ending_balance = account_balances.ending_balance + 777`,
    [cuentaId, f.periodos[8], f.entityId]
  );
}, 120_000);

afterAll(async () => {
  await query(`DELETE FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`, [
    cuentaId,
    f.periodos[8],
  ]);
  await closeDatabase();
});

const descuadre = (h: { detalle: string }): boolean => h.detalle.includes('account_balances dice');

describe('con el mayor corrupto, ninguna forma válida de --period sale limpia', () => {
  it('sin filtro: denuncia el descuadre', async () => {
    const r = await runLedgerChecks(f.entityId, ['balance'], {});
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((h) => h.severity === 'blocking')).toBe(true);
  });

  it('«2026-08», la forma del manual, ahora SÍ verifica y denuncia', async () => {
    // Éste es el caso que devolvía [] y hacía imprimir el ✔.
    const r = await runLedgerChecks(f.entityId, ['balance'], { period: '2026-08' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.some(descuadre)).toBe(true);
  });

  it('por nombre del periodo: denuncia lo mismo', async () => {
    const r = await runLedgerChecks(f.entityId, ['balance'], { period: 'Periodo 8/2026' });
    expect(r.some(descuadre)).toBe(true);
  });

  it('por id del periodo: denuncia lo mismo', async () => {
    const r = await runLedgerChecks(f.entityId, ['balance'], { period: f.periodos[8] });
    expect(r.some(descuadre)).toBe(true);
  });

  it('cuenta y periodo a la vez siguen midiendo', async () => {
    const r = await runLedgerChecks(f.entityId, ['balance'], { account: '6100', period: '2026-08' });
    expect(r.some(descuadre)).toBe(true);
  });
});

describe('un filtro que no existe se niega, no sale limpio', () => {
  it('un periodo inexistente lanza en vez de dar el visto bueno', async () => {
    await expect(
      runLedgerChecks(f.entityId, ['balance'], { period: '1999-01' })
    ).rejects.toThrow(/Fiscal period/i);
  });

  it('una cuenta inexistente lanza en vez de dar el visto bueno', async () => {
    await expect(
      runLedgerChecks(f.entityId, ['balance'], { account: 'NO-EXISTE' })
    ).rejects.toThrow(/Account/i);
  });

  it('un mes sin descuadre sí sale limpio: la negativa no se come el verde legítimo', async () => {
    // Un periodo que existe y está sano tiene que devolver []. Sin esto, la
    // suite pasaría igual con un `balance` que denunciara siempre.
    const r = await runLedgerChecks(f.entityId, ['balance'], { period: '2026-03' });
    expect(r).toEqual([]);
  });
});

// Las otras dos superficies que comparaban texto de periodo y por eso podían
// contestar «no hay nada» sobre un universo que nunca miraron.
describe('las otras dos superficies con --period', () => {
  it('stale-draft list acepta «2026-08» en vez de no casar nada', async () => {
    // Antes, esta forma no casaba ningún periodo y la lista salía vacía: se
    // leía como «no hay borradores viejos». Ahora resuelve el periodo; que la
    // lista venga vacía es un hecho sobre ESE mes, no sobre la nada.
    await expect(listStaleDrafts(f.entityId, { days: 0, period: '2026-08' })).resolves.toBeInstanceOf(Array);
  });

  it('stale-draft list se niega ante un periodo inexistente', async () => {
    await expect(listStaleDrafts(f.entityId, { days: 0, period: '1999-01' })).rejects.toThrow(
      /Fiscal period/i
    );
  });

  it('el saldo por periodo acepta «2026-08» y devuelve el del mes, no una lista vacía', async () => {
    const conForma = await getAccountBalanceByPeriod(f.entityId, cuentaId, { period: '2026-08' });
    const porNombre = await getAccountBalanceByPeriod(f.entityId, cuentaId, {
      period: 'Periodo 8/2026',
    });
    expect(conForma).toEqual(porNombre);
    expect(conForma.length).toBeGreaterThan(0);
  });

  it('el saldo por periodo se niega ante un periodo inexistente', async () => {
    await expect(
      getAccountBalanceByPeriod(f.entityId, cuentaId, { period: '1999-01' })
    ).rejects.toThrow(/Fiscal period/i);
  });
});
