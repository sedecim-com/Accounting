// ============================================================
// INSTANTANEAS DE PRESENTACION
// Dos propiedades que son correccion contable, no estetica:
//
//   LA FECHA NO SE CORRE DE MES. Una poliza capturada el 31 de
//   enero a las 20:00 en CDMX se imprimia 2026-02-01T02:00:00.000Z
//   — se LEIA como del 1 de febrero, del otro lado del corte de
//   periodo. El renderizador imprime el dia LOCAL en toda rama.
//
//   EL DINERO DE MAQUINA NO CAMBIA NI UN BYTE. json y csv son
//   contrato: cadena de cuatro decimales, sin separador de miles.
//   El formato es-MX (1,234,567.89) existe SOLO en la tabla para
//   humanos. Los esperados van como literales a proposito: si un
//   byte cambia, la prueba acusa.
//
// La zona horaria se fija aqui mismo: el corrimiento solo se ve
// al oeste de Greenwich, y un runner en UTC lo taparia.
// ============================================================
process.env.TZ = 'America/Mexico_City';

import { describe, it, expect } from 'vitest';
import { render, dateOnly, formatMoneyMx } from '../../../src/cli/kernel/output.js';

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    stdout: { write: (s: string) => { out.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    stderr: { write: (s: string) => { err.push(s); return true; }, isTTY: false } as unknown as NodeJS.WriteStream,
    get stdoutText() { return out.join(''); },
    get stderrText() { return err.join(''); },
  };
}

// Acentos en las DOS normalizaciones: el renderizador no debe normalizar
// nombres — NFC precompuesto y NFD con combinantes salen tal cual entraron.
const NOMBRE_NFC = 'José Pérez Núñez';                       // precompuesto
const NOMBRE_NFD = 'José Fernández Muñoz'; // combinantes

// El 31 de enero a las 20:00 en CDMX (UTC-6): en UTC ya es 1 de febrero.
const NOCHE_DE_CIERRE = new Date(2026, 0, 31, 20, 0, 0);

const FILAS = [
  { entry: 'JE-2026-00042', entry_date: NOCHE_DE_CIERRE, vendor_name: NOMBRE_NFC, total_amount: '12458930.5500' },
  { entry: 'JE-2026-00043', entry_date: new Date(2026, 0, 15, 0, 0, 0), vendor_name: NOMBRE_NFD, total_amount: '-1234567.8950' },
];

describe('la zona horaria del propio spec', () => {
  it('corre en America/Mexico_City (UTC-6), donde el corrimiento es visible', () => {
    // Si el runner ignorara TZ, todo lo demas probaria vacio. CDMX ya no
    // tiene horario de verano: offset fijo de 360 minutos.
    expect(NOCHE_DE_CIERRE.getTimezoneOffset()).toBe(360);
  });
});

describe('la fecha no se corre de mes', () => {
  it('la tabla imprime el 31 de enero, no el 1 de febrero de Greenwich', () => {
    const s = sink();
    render(FILAS, { stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('2026-01-31');
    expect(s.stdoutText).not.toContain('2026-02-01');
    expect(s.stdoutText).not.toContain('T02:00');
  });

  it('dateOnly da el dia local y deja pasar cadenas ya resueltas', () => {
    expect(dateOnly(NOCHE_DE_CIERRE)).toBe('2026-01-31');
    expect(dateOnly('2026-01-31')).toBe('2026-01-31');
    // Una cadena ISO con hora ya trae la fecha decidida: se recorta, no se reinterpreta.
    expect(dateOnly('2026-01-31T20:00:00.000Z')).toBe('2026-01-31');
    expect(dateOnly(null)).toBe('');
    expect(dateOnly(undefined)).toBe('');
  });
});

describe('importes como los lee un contador — SOLO en la tabla', () => {
  it('siete digitos con separador de miles y DOS decimales de presentacion', () => {
    const s = sink();
    render(FILAS, { stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('12,458,930.55');
    expect(s.stdoutText).not.toContain('12458930.5500');
  });

  it('el negativo queda legible, con miles y redondeo half-up del tercer decimal', () => {
    const s = sink();
    render(FILAS, { stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain('-1,234,567.90');
  });

  it('los nombres conservan su normalizacion: NFC sale NFC y NFD sale NFD', () => {
    const s = sink();
    render(FILAS, { stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toContain(NOMBRE_NFC);
    expect(s.stdoutText).toContain(NOMBRE_NFD);
    // La forma NFD NO fue promovida a NFC en el camino.
    expect(s.stdoutText).not.toContain(NOMBRE_NFD.normalize('NFC'));
  });

  it('formatMoneyMx opera por cadena y BigInt, nunca por float', () => {
    expect(formatMoneyMx('12458930.5500')).toBe('12,458,930.55');
    expect(formatMoneyMx('-1234567.8950')).toBe('-1,234,567.90');
    expect(formatMoneyMx('999.9950')).toBe('1,000.00');   // el acarreo cruza el punto
    expect(formatMoneyMx('0.0000')).toBe('0.00');
    expect(formatMoneyMx('-0.0040')).toBe('0.00');        // un menos-cero seria ilegible
    expect(formatMoneyMx('1000')).toBe('1,000.00');
    // Mas alla de 2^53 centesimos: float ya mentiria, la cadena no.
    expect(formatMoneyMx('90071992547409919.0150')).toBe('90,071,992,547,409,919.02');
  });
});

describe('los formatos de maquina, byte por byte', () => {
  // Los esperados son LITERALES adrede: el contrato es el byte exacto.
  // Dinero: cadena de cuatro decimales, sin comas. Fecha: el dia local
  // (el desfase UTC era incorrecto tambien aqui — un agente que leyera el
  // json heredaba la poliza en el mes equivocado).
  const JSON_ESPERADO = `{
  "schema": 1,
  "count": 2,
  "rows": [
    {
      "entry": "JE-2026-00042",
      "entry_date": "2026-01-31",
      "vendor_name": "José Pérez Núñez",
      "total_amount": "12458930.5500"
    },
    {
      "entry": "JE-2026-00043",
      "entry_date": "2026-01-15",
      "vendor_name": "José Fernández Muñoz",
      "total_amount": "-1234567.8950"
    }
  ]
}
`;

  const CSV_ESPERADO =
    'entry,entry_date,vendor_name,total_amount\n' +
    'JE-2026-00042,2026-01-31,José Pérez Núñez,12458930.5500\n' +
    'JE-2026-00043,2026-01-15,José Fernández Muñoz,-1234567.8950\n';

  it('json produce EXACTAMENTE estos bytes', () => {
    const s = sink();
    render(FILAS, { json: true, stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toBe(JSON_ESPERADO);
  });

  it('csv produce EXACTAMENTE estos bytes: sin miles, cuatro decimales, dia local', () => {
    const s = sink();
    render(FILAS, { format: 'csv', stdout: s.stdout, stderr: s.stderr });
    expect(s.stdoutText).toBe(CSV_ESPERADO);
  });

  it('ndjson tampoco viste el dinero ni corre la fecha', () => {
    const s = sink();
    render(FILAS, { format: 'ndjson', stdout: s.stdout, stderr: s.stderr });
    const lineas = s.stdoutText.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lineas[0].total_amount).toBe('12458930.5500');
    expect(lineas[0].entry_date).toBe('2026-01-31');
  });
});
