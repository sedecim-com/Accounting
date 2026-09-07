import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { deactivateAccount } from '../../src/services/accounting/account-service.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';
import { getTrialBalance } from '../../src/services/reporting/report-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// T13 · LA BALANZA DEL ANEXO 24 DESPUÉS DE ARCHIVAR (#100)
//
// ESTE ARCHIVO NO EXISTÍA, y por eso las 1 190 pruebas de integración pasaban
// con el defecto puesto: ninguna generaba la balanza fiscal DESPUÉS de archivar
// una cuenta con movimiento.
//
// El daño tenía dos caras, y las dos son peores que la que el issue reporta:
//   · Antes de T13 el XML perdía la cuenta en silencio — el movimiento
//     declarable simplemente no viajaba.
//   · Y al ensanchar sólo `getTrialBalance`, la cuenta volvía PERO con el
//     saldo del revés: `metadatosDeCuentas` seguía filtrando `is_active`, así
//     que su naturaleza caía al defecto 'debit' y una cuenta acreedora se
//     declaraba deudora. El recálculo del SAT rehacía la resta con esa MISMA
//     naturaleza equivocada, de modo que salía cuadrada y ningún invariante la
//     veía.
// ============================================================

let f: Fixture;
let cuentaIngreso: string;

// El fixture ya siembra el catálogo: aquí sólo se localizan las cuentas.
async function cuenta(codigo: string): Promise<string> {
  const r = await query<{ id: string }>(
    'SELECT id FROM accounts WHERE entity_id = $1 AND code = $2',
    [f.entityId, codigo]
  );
  if (!r.rows[0]) throw new Error(`el fixture no sembró la cuenta ${codigo}`);
  return r.rows[0].id;
}

beforeAll(async () => {
  f = await crearInquilino('T13 balanza tras archivar');
  enterTenant(f.tenantId);
  cuentaIngreso = await cuenta('4100');
  const banco = await cuenta('1110');
  await createJournalEntry(
    f.entityId,
    fechaEnPeriodo(2, 10),
    JournalEntryType.STANDARD,
    'Venta del periodo',
    [
      { account_id: banco, debit_amount: '10000.00', credit_amount: null, description: 'v' },
      { account_id: cuentaIngreso, debit_amount: null, credit_amount: '10000.00', description: 'v' },
    ],
    f.userId,
    { autoPost: true }
  );
  await drainAttestations();
  // Y SE ARCHIVA, que es el acto rutinario que lo dispara todo. Pasa sin
  // `--force` porque su saldo de por vida es cero en cuanto el cierre la barre
  // — aquí basta `allowWithHistory`, que es lo que el despacho usa al retirar
  // una línea del catálogo a fin de ejercicio.
  await deactivateAccount(cuentaIngreso, f.userId, { allowWithHistory: true });
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('la balanza fiscal después de archivar una cuenta con movimiento', () => {
  it('la cuenta archivada sigue en la balanza del servicio de informes', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    const fila = tb.rows.find((a) => a.account_code === '4100');
    expect(fila, 'archivar no puede borrar el movimiento del periodo').toBeDefined();
    expect(Number(fila?.credit_total)).toBe(10000);
  }, 60_000);

  it('el generador del Anexo 24 NO se niega: el catálogo contiene lo que la balanza declara', async () => {
    // Sin el mismo criterio en `catalogoSegunElPlanDeCuentas`, la comprobación
    // cruzada `cuentas-en-catalogo` encontraba una cuenta declarada que el
    // catálogo no contenía y emitía BLOQUEANTE: la balanza de un mes YA
    // PRESENTADO dejaba de poder generarse por archivar una cuenta.
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(b).toBeDefined();
  }, 60_000);

  it('y la declara en el XML con SU naturaleza, no con el defecto deudor', async () => {
    // Se afirma contra el XML y no contra una estructura intermedia: es el
    // artefacto que va a la autoridad, y es donde el defecto se vería.
    //
    // Ésta es la cara que el recálculo del SAT no podía ver: rehacía la resta
    // con la MISMA naturaleza equivocada, así que la cuenta salía cuadrada y
    // ningún invariante la denunciaba.
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const linea = b.xml.split('\n').find((l) => l.includes('NumCta="4100"'));
    expect(linea, 'la cuenta archivada tiene que viajar en el XML').toBeDefined();
    // El signo ES la naturaleza. El SaldoFin del SAT se rehace como
    // SaldoIni + Debe − Haber para una cuenta DEUDORA y al revés para una
    // ACREEDORA; con la naturaleza caída al defecto 'debit', esta cuenta —que
    // recibió 10 000 al haber— se declararía en −10 000.00.
    expect(linea).toContain('Haber="10000.00"');
    expect(linea, 'con la naturaleza del revés el saldo se declara negativo').toContain(
      'SaldoFin="10000.00"'
    );
  }, 60_000);
});
