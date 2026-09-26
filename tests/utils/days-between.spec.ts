import { describe, it, expect, afterEach } from 'vitest';

import { daysBetween } from '../../src/utils/calendar-date.js';
import { earlyPaymentDiscount } from '../../src/services/ap/bill-service.js';

// ============================================================
// #243 · COUNTING DAYS ON THE CALENDAR, NOT ON A CLOCK
//
// Three places subtracted milliseconds and divided by 86_400_000. The two
// operands were never the same kind of thing: one side arrived as a
// 'YYYY-MM-DD' string — which `new Date()` reads as UTC midnight — and the
// other as the Date pg builds from a DATE column, which is LOCAL midnight.
// Subtracting them mixes two origins that differ by the offset, so the
// quotient lands a whole day off on one half of the planet.
//
// The tests below FIX THE CLOCK. Without that they pass everywhere and measure
// nothing: CI runs in UTC, which is precisely the one zone where the bug is
// invisible.
// ============================================================

const ORIGINAL_TZ = process.env.TZ;

/**
 * Devuelve el reloj a como estaba. BORRA la variable cuando no existía, en vez
 * de asignarle `undefined`: `process.env.TZ = undefined` escribe la CADENA
 * "undefined", que no es ninguna zona — y en CI, donde TZ no está puesta, eso
 * dejaba el proceso en un huso inventado para todo lo que viniera después.
 */
function restoreClock(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

/** Runs `fn` with the process clock parked in `tz`. */
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

describe('daysBetween — the same answer in every zone', () => {
  const ZONES = ['UTC', 'America/Mexico_City', 'America/Tijuana', 'America/New_York', 'Europe/Madrid', 'Asia/Tokyo'];

  it('eleven days is eleven days, wherever the server stands', () => {
    for (const tz of ZONES) {
      expect(inZone(tz, () => daysBetween('2026-08-01', '2026-08-12')), tz).toBe(11);
    }
  });

  it('and it says so with the mixed operands that caused the defect', () => {
    // Una cadena contra el Date que pg construye: los dos orígenes que se
    // restaban y que difieren justo en el desfase del huso.
    for (const tz of ZONES) {
      expect(inZone(tz, () => daysBetween(asPgDate('2026-08-01'), '2026-08-12')), tz).toBe(11);
    }
  });

  it('a DST change does not add or drop a day', () => {
    // México adelanta el reloj dentro de este tramo en los años en que aplica,
    // y un día de 23 horas volvía fracción el cociente.
    expect(inZone('America/New_York', () => daysBetween('2026-03-01', '2026-03-31'))).toBe(30);
    expect(inZone('Europe/Madrid', () => daysBetween('2026-10-01', '2026-11-01'))).toBe(31);
  });

  it('counts backwards and counts zero', () => {
    expect(daysBetween('2026-08-12', '2026-08-01')).toBe(-11);
    expect(daysBetween('2026-08-12', '2026-08-12')).toBe(0);
  });
});

describe('el descuento por pronto pago, que es donde el día suelto reparte dinero', () => {
  // Gasto del 1 de agosto, condiciones 2/10 Net 30, pagado el 12: el día ONCE,
  // fuera de la ventana. Medido antes del arreglo: UTC contestaba 11 y no daba
  // descuento; Mexico_City, Tijuana y New_York contestaban 10 y SÍ lo daban.
  // El gasto se construye DENTRO de la zona, no al cargar el módulo: pg fabrica
  // el Date de una columna DATE con el huso del proceso EN EL MOMENTO DE LA
  // CONSULTA. Construirlo fuera lo congela en el huso de arranque —UTC en CI— y
  // la prueba mide entonces otra cosa: es la misma sutileza que el defecto.
  const billIn = () => ({
    amount_due: '1000.0000',
    bill_date: asPgDate('2026-08-01'),
    terms: '2/10 Net 30',
  });

  it('el día once queda fuera de la ventana en TODAS las zonas', () => {
    for (const tz of ['UTC', 'America/Mexico_City', 'America/Tijuana', 'America/New_York', 'Europe/Madrid', 'Asia/Tokyo']) {
      const r = inZone(tz, () => earlyPaymentDiscount(billIn(), '2026-08-12'));
      expect(r.applied, `${tz} concedió un descuento vencido`).toBe(false);
      expect(r.discountAmount).toBe('0.0000');
    }
  });

  it('y el día diez sigue dentro, también en todas', () => {
    for (const tz of ['UTC', 'America/Mexico_City', 'Asia/Tokyo']) {
      const r = inZone(tz, () => earlyPaymentDiscount(billIn(), '2026-08-11'));
      expect(r.applied, `${tz} negó un descuento vigente`).toBe(true);
      expect(r.discountAmount).toBe('20.0000');
    }
  });
});
