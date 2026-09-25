import { describe, it, expect, afterEach } from 'vitest';

import { toCalendarDate } from '../../src/utils/calendar-date.js';
import { yymmdd } from '../../src/services/payroll/usa/nacha-generator.js';

// ============================================================
// #241 · A STORED DATE IS READ BACK WHOLE, NOT ONE DAY EARLY
//
// The other half of #211. That one fixed WRITING: the day the user types is
// the day the column stores. This is READING: pg builds the Date of a DATE
// column at LOCAL midnight, and `.toISOString()` re-reads that instant in UTC,
// so EAST of Greenwich it hands back the previous day.
//
// The clock is moved on purpose. CI runs in UTC — the one zone where none of
// this shows — so without moving it these tests measure nothing.
// ============================================================

const ORIGINAL_TZ = process.env.TZ;

function restoreClock(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    restoreClock();
  }
}

afterEach(restoreClock);

/** The shape pg hands back for a DATE column: midnight in the LOCAL zone. */
const asPgDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

describe('toCalendarDate sobre lo que pg devuelve de una columna DATE', () => {
  const ZONES = ['UTC', 'America/Mexico_City', 'America/Tijuana', 'Europe/Madrid', 'Asia/Tokyo', 'Pacific/Kiritimati'];

  it('devuelve el día guardado en cualquier huso, y toISOString no', () => {
    for (const tz of ZONES) {
      // La fixture se construye DENTRO de la zona: pg fabrica ese Date con el
      // huso del proceso en el momento de la consulta.
      const read = inZone(tz, () => toCalendarDate(asPgDate('2026-03-01')));
      expect(read, tz).toBe('2026-03-01');
    }
  });

  it('y el defecto que esto sustituye se ve al ESTE: toISOString pierde el día', () => {
    // No es una aserción sobre el arreglo: es la medida del defecto, para que
    // quede escrito por qué `toISOString` no vale aquí.
    const withIso = inZone('Asia/Tokyo', () => asPgDate('2026-03-01').toISOString().split('T')[0]);
    expect(withIso).toBe('2026-02-28');
  });
});

describe('la fecha efectiva del fichero ACH que se le entrega al banco', () => {
  it('es la guardada, también al oeste de Greenwich', () => {
    // EL DEFECTO MEDIDO: `yymmdd` leía el Date por sus campos UTC, así que un
    // pay_date de 2026-01-01 salía como `251231` — el día Y el año. Y ese mismo
    // pay_date se inserta crudo en `direct_deposit_batches.effective_date`, de
    // modo que el fichero que va al banco y la fila que lo registra se
    // contradecían en la misma operación.
    for (const tz of ['UTC', 'America/Mexico_City', 'America/Tijuana', 'Asia/Tokyo']) {
      const written = inZone(tz, () => yymmdd(asPgDate('2026-01-01')));
      expect(written, `${tz} escribió otra fecha efectiva`).toBe('260101');
    }
  });

  it('y acepta la cadena tal cual, sin reinterpretarla', () => {
    for (const tz of ['UTC', 'America/Mexico_City', 'Asia/Tokyo']) {
      expect(inZone(tz, () => yymmdd('2026-01-01')), tz).toBe('260101');
    }
  });
});
