import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';

// ============================================================
// #211 · UN ASIENTO FECHADO EL 1 DE MARZO SE GUARDA EL 28 DE FEBRERO
//
// `entry_date` es DATE. La ruta REST hacía `new Date(entry_date)` sobre la
// cadena `YYYY-MM-DD` del cuerpo, que es medianoche UTC; node-postgres
// serializa un `Date` con los componentes LOCALES del proceso, así que al
// oeste de Greenwich la columna recibía el día anterior. En CI el reloj es UTC
// y el defecto no aparece: aparece en el mercado al que va el sistema.
//
// Por eso esta prueba FIJA LA ZONA dentro de cada caso y la restaura en
// `finally`: la suite de integración corre en un solo proceso y un `TZ` suelto
// se pegaría a todos los archivos que vengan detrás. Y comprueba antes que el
// cambio de zona surtió efecto, o pasaría en falso en una máquina sin datos de
// zonas horarias.
//
// Dos zonas y no una: México, donde se mide el defecto, y Tokio, donde se mide
// que el arreglo no rompa el otro lado del meridiano.
// ============================================================

let fx: Fixture;
let server: Servidor;

beforeAll(async () => {
  fx = await crearInquilino('#211 fecha del asiento');
  server = await levantar([['/v1/journal-entries', journalEntriesRouter]], sesionDe(fx));
}, 120_000);

afterAll(async () => {
  await drainAttestations(3000).catch(() => undefined);
  await server?.cerrar();
  await closeDatabase();
});

async function inTimezone<T>(tz: string, expectedOffsetMinutes: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const offset = new Date('2026-03-01T12:00:00Z').getTimezoneOffset();
    expect(offset, `the process did not switch to ${tz}: the test would pass vacuously`).toBe(expectedOffsetMinutes);
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const MEXICO = ['America/Mexico_City', 360] as const;
const TOKYO = ['Asia/Tokyo', -540] as const;

interface StoredEntry {
  id: string;
  entry_date: string;
  fiscal_period_id: string;
  entry_number: string;
}

async function postEntry(entryDate: string): Promise<{ status: number; stored: StoredEntry | undefined; body: unknown }> {
  const reference = `D211-${randomUUID().slice(0, 8)}`;
  const r = await pedir(server, 'POST', '/v1/journal-entries', {
    entity_id: fx.entityId,
    entry_date: entryDate,
    description: `#211 ${entryDate}`,
    reference,
    auto_post: true,
    lines: [
      { account_id: fx.cuentas['1120'], debit_amount: '100.00' },
      { account_id: fx.cuentas['4100'], credit_amount: '100.00' },
    ],
  });
  const { rows } = await query<StoredEntry>(
    `SELECT id, entry_date::text AS entry_date, fiscal_period_id, entry_number
       FROM journal_entries WHERE reference = $1`,
    [reference]
  );
  return { status: r.status, stored: rows[0], body: r.body };
}

describe('the date a user writes is the date the ledger keeps — west of Greenwich', () => {
  it('an entry dated March 1st is stored on March 1st, in the March period', async () => {
    await inTimezone(...MEXICO, async () => {
      const { status, stored, body } = await postEntry('2026-03-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date, 'the entry landed on another day').toBe('2026-03-01');
      expect(stored?.fiscal_period_id, 'the entry landed in another fiscal period').toBe(fx.periodos[3]);
    });
  });

  it('an entry dated January 1st is accepted, and takes the folio series of ITS year', async () => {
    // Shifted back one day it would be December 31st of the previous year:
    // a period that does not exist here, and the previous year's folio series.
    await inTimezone(...MEXICO, async () => {
      const { status, stored, body } = await postEntry('2026-01-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date).toBe('2026-01-01');
      expect(stored?.entry_number, 'the folio came from the previous year series').toMatch(/-2026-/);
    });
  });

  it('a reversal dated April 1st is stored on April 1st', async () => {
    await inTimezone(...MEXICO, async () => {
      const { stored } = await postEntry('2026-03-15');
      const r = await pedir(server, 'POST', `/v1/journal-entries/${stored!.id}/reverse`, { reversal_date: '2026-04-01' });
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
      const { rows } = await query<{ entry_date: string }>(
        `SELECT entry_date::text AS entry_date FROM journal_entries WHERE reverses_entry_id = $1`,
        [stored!.id]
      );
      expect(rows[0]?.entry_date, 'the reversal landed on another day').toBe('2026-04-01');
    });
  });
});

describe('and the fix does not break the other side of the meridian', () => {
  it('east of Greenwich, March 1st is still March 1st, in the March period', async () => {
    await inTimezone(...TOKYO, async () => {
      const { status, stored, body } = await postEntry('2026-03-01');
      expect(status, JSON.stringify(body).slice(0, 200)).toBe(201);
      expect(stored?.entry_date).toBe('2026-03-01');
      expect(stored?.fiscal_period_id).toBe(fx.periodos[3]);
    });
  });
});
