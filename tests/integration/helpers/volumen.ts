import { query } from '../../../src/database/connection.js';

// ============================================================
// LA FIXTURE DE VOLUMEN (E1b)
//
// Un mayor grande no es un asiento con un millón de líneas: son cientos de
// miles de asientos con dos o tres líneas cada uno. La distinción no es
// cosmética y costó descubrirla —el primer intento cargó 150 000 líneas sobre
// UN asiento y no terminó en 33 minutos—, porque `trg_update_je_totals`
// recomputa los totales del padre en CADA inserción de línea: N líneas sobre
// el mismo asiento leen 1+2+…+N filas y versionan N veces la misma fila
// (issue #178). Sembrar con la forma equivocada mide ese defecto, no el que
// E1 viene a medir.
//
// SE SALTA LA CAPA DE APLICACIÓN A PROPÓSITO. `createJournalEntry` valida,
// actualiza saldos y encola atestaciones; nada de eso participa en lo que aquí
// se mide, que es el COSTE DEL PREDICADO DE AISLAMIENTO al leer. Sembrar por
// SQL directo es más rápido y, sobre todo, no mete el camino de
// contabilización dentro de la medida.
// ============================================================

export interface VolumenSembrado {
  asientos: number;
  lineas: number;
  ms: number;
}

/**
 * Siembra `asientos` asientos de dos líneas (un cargo y un abono) sobre la
 * entidad y el periodo dados. Devuelve lo sembrado y cuánto costó, porque una
 * fixture que no dice su propio coste esconde justo lo que hay que vigilar.
 */
export async function sembrarVolumen(
  entityId: string,
  fiscalPeriodId: string,
  createdBy: string,
  cargoCuentaId: string,
  abonoCuentaId: string,
  asientos: number
): Promise<VolumenSembrado> {
  const t0 = Date.now();

  // Los asientos primero, en una sola sentencia: generate_series los fabrica
  // dentro del servidor y no cruzan la red uno por uno.
  await query(
    `INSERT INTO journal_entries
       (id, entry_number, entry_type, entity_id, fiscal_period_id, entry_date, created_by, status, description)
     SELECT gen_random_uuid(), 'VOL-' || g, 'standard', $1::uuid, $2::uuid, CURRENT_DATE, $3::uuid, 'draft', 'volumen ' || g
       FROM generate_series(1, $4::int) g`,
    [entityId, fiscalPeriodId, createdBy, asientos]
  );

  // Y las líneas colgando de ellos. Dos por asiento: el disparador de totales
  // dispara dos veces y suma dos filas cada vez, que es lineal.
  await query(
    `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit_amount, credit_amount, description)
     SELECT gen_random_uuid(), e.id, 1, $1::uuid, 100.0000, NULL, 'cargo'
       FROM journal_entries e WHERE e.entity_id = $3::uuid AND e.entry_number LIKE 'VOL-%'
     UNION ALL
     SELECT gen_random_uuid(), e.id, 2, $2::uuid, NULL, 100.0000, 'abono'
       FROM journal_entries e WHERE e.entity_id = $3::uuid AND e.entry_number LIKE 'VOL-%'`,
    [cargoCuentaId, abonoCuentaId, entityId]
  );

  await query('ANALYZE journal_entries');
  await query('ANALYZE journal_entry_lines');

  return { asientos, lineas: asientos * 2, ms: Date.now() - t0 };
}
