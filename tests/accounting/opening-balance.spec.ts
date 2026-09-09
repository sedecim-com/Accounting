import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(),
  tenantDe: vi.fn(async () => 'tenant-1'),
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(),
  attestEntryAsync: vi.fn(),
}));

import {
  planOpeningBalance,
  importOpeningBalance,
  renderOpeningBalanceReport,
  subledgerKindOf,
  dayAfterCutoff,
  type OpeningAccountRow,
  type OpeningDocument,
  type OpeningExercise,
} from '../../src/services/accounting/opening-balance.js';
import { readBalanzaComprobacion } from '../../src/services/sat/anexo24/balance-reader.js';
import { query, withTransaction } from '../../src/database/connection.js';
import { registrarAuditoria } from '../../src/services/audit/audit-log.js';
import { createJournalEntry, attestEntryAsync } from '../../src/services/accounting/posting.js';
import { ValidationError } from '../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const mockAudit = registrarAuditoria as unknown as Mock;
const mockCrear = createJournalEntry as unknown as Mock;
const mockAtestar = attestEntryAsync as unknown as Mock;

// ============================================================
// O1 · LA BALANZA DE APERTURA
// ============================================================

const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion';

interface FilaXml {
  numCta: string;
  /** Sólo el SaldoFin importa para la apertura; las otras tres se derivan. */
  saldoFin: string;
  saldoIni?: string;
}

function archivo(filas: FilaXml[], cab: Partial<{ rfc: string; mes: string; anio: string }> = {}): string {
  const cuerpo = filas
    .map(
      (f) =>
        `<BCE:Ctas NumCta="${f.numCta}" SaldoIni="${f.saldoIni ?? f.saldoFin}" Debe="0.00" ` +
        `Haber="0.00" SaldoFin="${f.saldoFin}"/>`
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<BCE:Balanza xmlns:BCE="${NS}" Version="1.3" RFC="${cab.rfc ?? 'XAXX010101000'}" ` +
    `Mes="${cab.mes ?? '12'}" Anio="${cab.anio ?? '2025'}" TipoEnvio="N">${cuerpo}</BCE:Balanza>`
  );
}

const cuenta = (p: Partial<OpeningAccountRow> & { code: string }): OpeningAccountRow => ({
  id: `id-${p.code}`,
  code: p.code,
  name: p.name ?? `Cuenta ${p.code}`,
  parent_code: 'parent_code' in p ? (p.parent_code ?? null) : null,
  account_type: p.account_type ?? 'asset',
  normal_balance: p.normal_balance ?? 'debit',
  codigo_agrupador_sat: 'codigo_agrupador_sat' in p ? (p.codigo_agrupador_sat ?? null) : null,
  is_header: p.is_header ?? false,
  is_active: p.is_active ?? true,
  allow_manual_entries: p.allow_manual_entries ?? true,
  role: 'role' in p ? (p.role ?? null) : null,
});

const EJERCICIO: OpeningExercise = { id: 'fy-2026', yearNumber: 2026, startDate: '2026-01-01' };

const plan = (
  filas: FilaXml[],
  cuentas: OpeningAccountRow[],
  documentos: OpeningDocument[] = [],
  cab: Partial<{ rfc: string; mes: string; anio: string }> = {},
  ejercicio: OpeningExercise = EJERCICIO
) => planOpeningBalance(readBalanzaComprobacion(archivo(filas, cab)), cuentas, documentos, ejercicio);

const reglas = (p: { findings: readonly { regla: string }[] }) => p.findings.map((f) => f.regla);

// ------------------------------------------------------------
// 1 · LA FECHA: «INICIO DE EJERCICIO» COMO CANDADO
// ------------------------------------------------------------

describe('dayAfterCutoff · aritmética de calendario sin Date', () => {
  it('diciembre abre el ejercicio siguiente', () => {
    expect(dayAfterCutoff('2025', '12')).toBe('2026-01-01');
  });

  it('Mes 13 —la balanza de cierre— cierra diciembre igual', () => {
    expect(dayAfterCutoff('2025', '13')).toBe('2026-01-01');
  });

  it('cualquier otro mes da el primero del siguiente, con su cero delante', () => {
    expect(dayAfterCutoff('2025', '06')).toBe('2025-07-01');
    expect(dayAfterCutoff('2025', '09')).toBe('2025-10-01');
  });
});

describe('el corte tiene que ser el del cierre del ejercicio anterior', () => {
  it('la balanza de JUNIO no abre el ejercicio: bloquea y pide la que sí', () => {
    const p = plan([{ numCta: '1110', saldoFin: '100.00' }], [cuenta({ code: '1110' })], [], {
      mes: '06',
      anio: '2025',
    });
    expect(p.puedeCargarse).toBe(false);
    const h = p.findings.find((f) => f.regla === 'APE-CORTE');
    expect(h?.mensaje).toContain('2025-07-01');
    expect(h?.mensaje).toContain('Mes 12 o Mes 13');
    expect(p.lines).toEqual([]);
  });

  it('la de diciembre del año anterior sí', () => {
    const p = plan([{ numCta: '1110', saldoFin: '100.00' }], [cuenta({ code: '1110' })]);
    expect(reglas(p)).not.toContain('APE-CORTE');
  });
});

// ------------------------------------------------------------
// 2 · EL RESIDUO: NO CONTAR EL DINERO DOS VECES
// ------------------------------------------------------------

describe('planOpeningBalance · el residuo', () => {
  const arbol = [
    cuenta({ code: '1100' }),
    cuenta({ code: '1110', parent_code: '1100' }),
    cuenta({ code: '1120', parent_code: '1100' }),
    cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' }),
  ];

  it('la cuenta de mayor NO se postea cuando su saldo está entero en las hijas', () => {
    const p = plan(
      [
        { numCta: '1100', saldoFin: '130.00' },
        { numCta: '1110', saldoFin: '100.00' },
        { numCta: '1120', saldoFin: '30.00' },
        { numCta: '2100', saldoFin: '130.00' },
      ],
      arbol
    );
    expect(p.lines.map((l) => l.code)).toEqual(['1110', '1120', '2100']);
    expect(p.totalDebe).toBe('130.0000');
    expect(p.totalHaber).toBe('130.0000');
    expect(p.puedeCargarse).toBe(true);
  });

  it('la cuenta de mayor CON movimiento propio recibe su residuo', () => {
    // El caso que un «postear sólo las hojas» pierde: 130 declarado con 100 en
    // la hija deja 30 que el sistema viejo llevaba directamente en el mayor.
    const p = plan(
      [
        { numCta: '1100', saldoFin: '130.00' },
        { numCta: '1110', saldoFin: '100.00' },
        { numCta: '2100', saldoFin: '130.00' },
      ],
      arbol
    );
    expect(p.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1100', '30.0000', null],
      ['1110', '100.0000', null],
      ['2100', null, '130.0000'],
    ]);
  });

  it('el nieto se resta al ABUELO cuando el padre no viene en el archivo', () => {
    const conNieto = [...arbol, cuenta({ code: '1111', parent_code: '1110' })];
    const p = plan(
      [
        { numCta: '1100', saldoFin: '100.00' },
        { numCta: '1111', saldoFin: '100.00' },
        { numCta: '2100', saldoFin: '100.00' },
      ],
      conNieto
    );
    expect(p.lines.map((l) => l.code)).toEqual(['1111', '2100']);
    expect(p.puedeCargarse).toBe(true);
  });

  it('el signo lo elige la NATURALEZA, no el número: la acreedora se abona', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '500.00' },
        { numCta: '2100', saldoFin: '500.00' },
      ],
      arbol
    );
    expect(p.lines.find((l) => l.code === '2100')).toMatchObject({
      debit: null,
      credit: '500.0000',
    });
  });

  it('una acreedora SOBREGIRADA —saldo deudor— se carga, que es lo que dice el archivo', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '-40.00' },
        { numCta: '2100', saldoFin: '-40.00' },
      ],
      arbol
    );
    expect(p.lines.find((l) => l.code === '2100')).toMatchObject({ debit: '40.0000', credit: null });
    expect(p.lines.find((l) => l.code === '1110')).toMatchObject({ credit: '40.0000', debit: null });
    expect(p.puedeCargarse).toBe(true);
  });

  it('una cuenta en ceros no produce renglón: el CHECK de la 001 prohíbe el importe cero', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '10.00' },
        { numCta: '1120', saldoFin: '0.00' },
        { numCta: '2100', saldoFin: '10.00' },
      ],
      arbol
    );
    expect(p.lines.map((l) => l.code)).toEqual(['1110', '2100']);
  });
});

// ------------------------------------------------------------
// 3 · EL CANDADO DEL «AL PESO»
// ------------------------------------------------------------

describe('el asiento cuadra solo o no se escribe', () => {
  it('un libro de origen descuadrado se NOMBRA y no se pone una cuenta puente', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '100.00' },
        { numCta: '2100', saldoFin: '99.00' },
      ],
      [cuenta({ code: '1110' }), cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' })]
    );
    expect(p.puedeCargarse).toBe(false);
    const h = p.findings.find((f) => f.regla === 'APE-NO-CUADRA');
    expect(h?.mensaje).toContain('1.00 de diferencia');
    expect(h?.mensaje).toContain('No se pone una cuenta puente');
  });

  it('una balanza toda en ceros no es una apertura', () => {
    const p = plan([{ numCta: '1110', saldoFin: '0.00' }], [cuenta({ code: '1110' })]);
    expect(reglas(p)).toContain('APE-SIN-IMPORTES');
    expect(p.puedeCargarse).toBe(false);
  });

  it('un archivo que el lector ya rechazó no se planea', () => {
    const roto = archivo([{ numCta: '1110', saldoFin: '1.00' }]).replace('NumCta="1110"', '');
    const p = planOpeningBalance(readBalanzaComprobacion(roto), [], [], EJERCICIO);
    expect(p.puedeCargarse).toBe(false);
    expect(p.lines).toEqual([]);
    expect(reglas(p)).toContain('LEC-BAL-NUMCTA-AUSENTE');
  });
});

// ------------------------------------------------------------
// 4 · LO QUE NO ENTRA
// ------------------------------------------------------------

describe('lo que no entra en una apertura', () => {
  it('una cuenta que el catálogo no creó bloquea y manda a la capa anterior', () => {
    const p = plan([{ numCta: '105-999', saldoFin: '10.00' }], []);
    const h = p.findings.find((f) => f.regla === 'APE-CUENTA-DESCONOCIDA');
    expect(h?.numCta).toBe('105-999');
    expect(h?.mensaje).toContain('importa primero el catálogo');
    expect(p.lines).toEqual([]);
  });

  it('el resultado abierto bloquea: un ejercicio nuevo no abre con ingresos', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '100.00' },
        { numCta: '4100', saldoFin: '100.00' },
      ],
      [
        cuenta({ code: '1110' }),
        cuenta({ code: '4100', normal_balance: 'credit', account_type: 'revenue' }),
      ]
    );
    const h = p.findings.find((f) => f.regla === 'APE-RESULTADO-ABIERTO');
    expect(h?.mensaje).toContain('4100');
    expect(h?.mensaje).toContain('Mes 13');
    expect(p.puedeCargarse).toBe(false);
  });

  it('una cuenta de resultado EN CEROS no bloquea: es lo que trae un cierre bien hecho', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '100.00' },
        { numCta: '4100', saldoFin: '0.00' },
        { numCta: '2100', saldoFin: '100.00' },
      ],
      [
        cuenta({ code: '1110' }),
        cuenta({ code: '4100', normal_balance: 'credit', account_type: 'revenue' }),
        cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' }),
      ]
    );
    expect(reglas(p)).not.toContain('APE-RESULTADO-ABIERTO');
    expect(p.puedeCargarse).toBe(true);
  });

  it('con más de ocho cuentas de resultado el mensaje se recorta Y LO DICE', () => {
    // El informe tiene que caber en una pantalla: enumerar cuarenta cuentas
    // esconde el mensaje que importa.
    const nueve = Array.from({ length: 9 }, (_, i) => `41${i}0`);
    const p = plan(
      [
        { numCta: '1110', saldoFin: '900.00' },
        ...nueve.map((c) => ({ numCta: c, saldoFin: '100.00' })),
      ],
      [
        cuenta({ code: '1110' }),
        ...nueve.map((c) =>
          cuenta({ code: c, normal_balance: 'credit', account_type: 'revenue' })
        ),
      ]
    );
    const h = p.findings.find((f) => f.regla === 'APE-RESULTADO-ABIERTO');
    expect(h?.mensaje).toContain('9 cuenta(s) de resultado');
    expect(h?.mensaje).toContain(', …');
    expect(h?.mensaje).not.toContain('4180 ');
  });

  it('una cuenta CABECERA con saldo se nombra a ella, no al asiento entero', () => {
    const p = plan(
      [
        { numCta: '1100', saldoFin: '100.00' },
        { numCta: '2100', saldoFin: '100.00' },
      ],
      [
        cuenta({ code: '1100', is_header: true }),
        cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' }),
      ]
    );
    const h = p.findings.find((f) => f.regla === 'APE-CUENTA-NO-POSTEABLE');
    expect(h?.mensaje).toContain('es una cuenta cabecera');
    expect(p.puedeCargarse).toBe(false);
  });

  it('una cuenta archivada, y una con los asientos manuales cerrados, también', () => {
    const archivada = plan(
      [{ numCta: '1110', saldoFin: '1.00' }],
      [cuenta({ code: '1110', is_active: false })]
    );
    expect(archivada.findings.find((f) => f.regla === 'APE-CUENTA-NO-POSTEABLE')?.mensaje).toContain(
      'está archivada'
    );
    const cerrada = plan(
      [{ numCta: '1110', saldoFin: '1.00' }],
      [cuenta({ code: '1110', allow_manual_entries: false })]
    );
    expect(cerrada.findings.find((f) => f.regla === 'APE-CUENTA-NO-POSTEABLE')?.mensaje).toContain(
      'asientos manuales cerrados'
    );
  });
});

// ------------------------------------------------------------
// 5 · CxC / CxP: DOCUMENTO A DOCUMENTO, JAMÁS AGREGADOS
// ------------------------------------------------------------

describe('subledgerKindOf · qué cuenta exige detalle', () => {
  it('EL ROL MANDA cuando existe', () => {
    expect(subledgerKindOf(cuenta({ code: 'X', role: 'cxc' }))).toBe('cxc');
    expect(subledgerKindOf(cuenta({ code: 'X', role: 'cxp' }))).toBe('cxp');
  });

  it('sin rol, el RUBRO del agrupador: 105 Clientes, 201 Proveedores', () => {
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '105.01' }))).toBe('cxc');
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '201' }))).toBe('cxp');
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '186.01' }))).toBe('cxc');
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '252' }))).toBe('cxp');
  });

  it('la ESTIMACIÓN de incobrables (108) NO exige detalle: no tiene documentos', () => {
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '108.01' }))).toBeNull();
  });

  it('ni el banco, ni una cuenta sin agrupador, ni una con el agrupador vacío', () => {
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '102.01' }))).toBeNull();
    expect(subledgerKindOf(cuenta({ code: 'X' }))).toBeNull();
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '  ' }))).toBeNull();
  });

  it('un agrupador que no está en el c_CodAgrup no se convierte en control por parecerse', () => {
    expect(subledgerKindOf(cuenta({ code: 'X', codigo_agrupador_sat: '999' }))).toBeNull();
  });
});

describe('la negativa a cargar CxC agregada', () => {
  const cxcYBanco = [
    cuenta({ code: '1120', codigo_agrupador_sat: '105.01', name: 'Clientes' }),
    cuenta({ code: '2110', codigo_agrupador_sat: '201.01', normal_balance: 'credit', account_type: 'liability' }),
    cuenta({ code: '1110', codigo_agrupador_sat: '102.01' }),
  ];
  const balanza = [
    { numCta: '1110', saldoFin: '2000.00' },
    { numCta: '1120', saldoFin: '12000.00' },
    { numCta: '2110', saldoFin: '14000.00' },
  ];

  it('sin auxiliar NO se carga NADA, y el mensaje dice qué se rompería', () => {
    const p = plan(balanza, cxcYBanco);
    expect(p.puedeCargarse).toBe(false);
    const h = p.findings.find((f) => f.regla === 'APE-CXC-AGREGADA');
    expect(h?.numCta).toBe('1120');
    expect(h?.mensaje).toContain('12000.00');
    expect(h?.mensaje).toContain('ar reconcile');
    expect(h?.mensaje).toContain('No hay bandera que se lo salte');
    expect(reglas(p)).toContain('APE-CXP-AGREGADA');
  });

  it('el informe enseña las cuentas de control aunque la carga se niegue', () => {
    const p = plan(balanza, cxcYBanco);
    expect(p.control).toEqual([
      {
        code: '1120',
        name: 'Clientes',
        kind: 'cxc',
        residual: '12000.0000',
        detalle: '0.0000',
        documentos: 0,
        cubierto: false,
      },
      expect.objectContaining({ code: '2110', kind: 'cxp' }),
    ]);
  });

  it('CON el auxiliar entra UN RENGLÓN POR DOCUMENTO, con folio y contraparte', () => {
    const documentos: OpeningDocument[] = [
      { cuenta: '1120', documento: 'A-123', contraparte: 'Aceros SA', fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '4000.00' },
      { cuenta: '1120', documento: 'A-456', contraparte: 'Bravo SC', fecha: '2025-11-20', vencimiento: '2026-01-19', importe: '8000.00', uuid: 'UU-1' },
      { cuenta: '2110', documento: 'F-77', contraparte: 'Papelera', fecha: '2025-12-01', vencimiento: '2026-01-01', importe: '14000.00' },
    ];
    const p = plan(balanza, cxcYBanco, documentos);
    expect(p.puedeCargarse).toBe(true);
    const cxc = p.lines.filter((l) => l.code === '1120');
    expect(cxc.map((l) => l.debit)).toEqual(['4000.0000', '8000.0000']);
    expect(cxc[0].description).toContain('A-123');
    expect(cxc[0].description).toContain('Aceros SA');
    expect(cxc[0].description).toContain('vence 2025-12-02');
    expect(cxc[1].description).toContain('UUID UU-1');
    expect(cxc[0].documento?.documento).toBe('A-123');
    expect(p.control.every((c) => c.cubierto)).toBe(true);
  });

  it('el auxiliar que no cuadra contra la balanza bloquea CON LA DIFERENCIA', () => {
    const documentos: OpeningDocument[] = [
      { cuenta: '1120', documento: 'A-123', contraparte: 'Aceros SA', fecha: '2025-11-02', importe: '4000.00' },
      { cuenta: '1120', documento: 'A-456', contraparte: 'Bravo SC', fecha: '2025-11-20', importe: '7999.00' },
      { cuenta: '2110', documento: 'F-77', contraparte: 'Papelera', fecha: '2025-12-01', importe: '14000.00' },
    ];
    const p = plan(balanza, cxcYBanco, documentos);
    const h = p.findings.find((f) => f.regla === 'APE-DETALLE-NO-CUADRA');
    expect(h?.numCta).toBe('1120');
    expect(h?.mensaje).toContain('11999.00');
    expect(h?.mensaje).toContain('12000.00');
    expect(h?.mensaje).toContain('-1.00');
    expect(p.puedeCargarse).toBe(false);
  });

  it('un documento sin vencimiento entra y se AVISA: la antigüedad no lo podrá clasificar', () => {
    const documentos: OpeningDocument[] = [
      { cuenta: '1120', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', importe: '12000.00' },
      { cuenta: '2110', documento: 'F-1', contraparte: 'Y', fecha: '2025-11-02', vencimiento: '2026-01-01', importe: '14000.00' },
    ];
    const p = plan(balanza, cxcYBanco, documentos);
    expect(reglas(p)).toContain('APE-SIN-VENCIMIENTO');
    expect(p.puedeCargarse).toBe(true);
  });

  it('una nota de crédito —importe contrario— entra y se avisa', () => {
    const documentos: OpeningDocument[] = [
      { cuenta: '1120', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '12500.00' },
      { cuenta: '1120', documento: 'NC-9', contraparte: 'X', fecha: '2025-12-02', vencimiento: '2025-12-02', importe: '-500.00' },
      { cuenta: '2110', documento: 'F-1', contraparte: 'Y', fecha: '2025-11-02', vencimiento: '2026-01-01', importe: '14000.00' },
    ];
    const p = plan(balanza, cxcYBanco, documentos);
    expect(reglas(p)).toContain('APE-DOCUMENTO-CONTRARIO');
    expect(p.lines.find((l) => l.documento?.documento === 'NC-9')).toMatchObject({
      debit: null,
      credit: '500.0000',
    });
    expect(p.puedeCargarse).toBe(true);
  });

  it('un documento de una cuenta que la balanza no declara es huérfano y bloquea', () => {
    const p = plan(balanza, cxcYBanco, [
      { cuenta: '9999', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', importe: '1.00' },
    ]);
    expect(reglas(p)).toContain('APE-DOCUMENTO-HUERFANO');
    expect(p.puedeCargarse).toBe(false);
  });

  it('el mismo folio dos veces bloquea: se cobraría dos veces', () => {
    const doc: OpeningDocument = { cuenta: '1120', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', importe: '6000.00' };
    const p = plan(balanza, cxcYBanco, [doc, { ...doc }]);
    expect(reglas(p)).toContain('APE-DOCUMENTO-DUPLICADO');
    expect(p.puedeCargarse).toBe(false);
  });

  it('un documento con saldo cero bloquea: saldría abierto en la antigüedad', () => {
    const p = plan(balanza, cxcYBanco, [
      { cuenta: '1120', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', importe: '0.00' },
    ]);
    expect(reglas(p)).toContain('APE-DOCUMENTO-SIN-SALDO');
    expect(p.puedeCargarse).toBe(false);
  });

  it('un importe que no es un decimal bloquea', () => {
    const p = plan(balanza, cxcYBanco, [
      { cuenta: '1120', documento: 'A-1', contraparte: 'X', fecha: '2025-11-02', importe: 'doce mil' },
    ]);
    expect(reglas(p)).toContain('APE-DOCUMENTO-IMPORTE');
    expect(p.puedeCargarse).toBe(false);
  });

  it('detalle en una cuenta que NO es de control se ACEPTA: más detalle nunca es peor', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '2000.00' },
        { numCta: '2100', saldoFin: '2000.00' },
      ],
      [
        cuenta({ code: '1110', codigo_agrupador_sat: '102.01' }),
        cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' }),
      ],
      [
        { cuenta: '1110', documento: 'CHQ-1', contraparte: 'Banco', fecha: '2025-12-31', vencimiento: '2025-12-31', importe: '1200.00' },
        { cuenta: '1110', documento: 'CHQ-2', contraparte: 'Banco', fecha: '2025-12-31', vencimiento: '2025-12-31', importe: '800.00' },
      ]
    );
    expect(p.puedeCargarse).toBe(true);
    expect(p.lines.filter((l) => l.code === '1110')).toHaveLength(2);
    // No es cuenta de control, así que no sale en el cuadro de control.
    expect(p.control).toEqual([]);
  });

  it('una cuenta de control EN CEROS no exige auxiliar', () => {
    const p = plan(
      [
        { numCta: '1110', saldoFin: '10.00' },
        { numCta: '1120', saldoFin: '0.00' },
        { numCta: '2100', saldoFin: '10.00' },
      ],
      [
        cuenta({ code: '1110' }),
        cuenta({ code: '1120', codigo_agrupador_sat: '105.01' }),
        cuenta({ code: '2100', normal_balance: 'credit', account_type: 'liability' }),
      ]
    );
    expect(p.puedeCargarse).toBe(true);
    expect(p.control).toEqual([
      expect.objectContaining({ code: '1120', residual: '0.0000', cubierto: true }),
    ]);
  });
});

// ------------------------------------------------------------
// 6 · LA ENVOLTURA DE E/S
// ------------------------------------------------------------

interface Escenario {
  entidad?: { tax_id: string; tax_id_type: string; name: string }[];
  ejercicios?: { id: string; year_number: number; start_date: string }[];
  todosLosEjercicios?: { year_number: number; start_date: string }[];
  cuentas?: OpeningAccountRow[];
  yaCargada?: { entry_number: string }[];
}

function conBase(e: Escenario = {}): void {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM legal_entities')) {
      return { rows: e.entidad ?? [{ tax_id: 'XAXX010101000', tax_id_type: 'rfc', name: 'Acme SA' }] };
    }
    if (sql.includes('FROM fiscal_years') && sql.includes('ORDER BY start_date')) {
      return { rows: e.todosLosEjercicios ?? [] };
    }
    if (sql.includes('FROM fiscal_years')) {
      return { rows: e.ejercicios ?? [{ id: 'fy-2026', year_number: 2026, start_date: '2026-01-01' }] };
    }
    if (sql.includes('FROM accounts a')) {
      return {
        rows:
          e.cuentas ??
          [
            cuenta({ code: '1110' }),
            cuenta({ code: '3100', normal_balance: 'credit', account_type: 'equity' }),
          ],
      };
    }
    if (sql.includes('FROM journal_entries')) return { rows: e.yaCargada ?? [] };
    throw new Error(`consulta no prevista: ${sql}`);
  });
}

const XML_SIMPLE = archivo([
  { numCta: '1110', saldoFin: '1000.00' },
  { numCta: '3100', saldoFin: '1000.00' },
]);

const CTX = { tenantId: 'tenant-1', entityId: 'ent-1' };
const OPTS = { entityId: 'ent-1', xml: XML_SIMPLE, userId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({}));
  mockCrear.mockResolvedValue({ id: 'je-1', entry_number: 'JE-2026-0001' });
  conBase();
});

describe('importOpeningBalance · lo que LANZA', () => {
  it('una entidad de otro inquilino no existe: el inquilino ACOTA dentro del SQL', async () => {
    conBase({ entidad: [] });
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toThrow(/no existe en este inquilino/);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('tenant_id = $2');
  });

  it('una entidad sin RFC no puede presentar el Anexo 24', async () => {
    conBase({ entidad: [{ tax_id: '12-3456789', tax_id_type: 'ein', name: 'Acme Inc' }] });
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toThrow(/EIN y no con RFC/);
  });

  it('la balanza de OTRO contribuyente se rechaza nombrando los dos RFC', async () => {
    const ajena = archivo([{ numCta: '1110', saldoFin: '1.00' }], { rfc: 'AAA010101AAA' });
    await expect(importOpeningBalance(CTX, { ...OPTS, xml: ajena })).rejects.toThrow(
      /AAA010101AAA.*XAXX010101000/s
    );
  });

  it('sin ejercicio que empiece el día siguiente al corte NO HAY ASIENTO, y se dice cuál falta', async () => {
    conBase({ ejercicios: [], todosLosEjercicios: [{ year_number: 2025, start_date: '2025-01-01' }] });
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toThrow(/2026-01-01/);
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toThrow(/2025 desde 2025-01-01/);
  });

  it('sin ningún ejercicio, el mensaje dice que hay que crearlo con sus periodos', async () => {
    conBase({ ejercicios: [], todosLosEjercicios: [] });
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toThrow(/no tiene ninguno/);
  });

  it('un ejercicio nombrado a mano que no es de la entidad se rechaza', async () => {
    conBase({ ejercicios: [] });
    await expect(
      importOpeningBalance(CTX, { ...OPTS, fiscalYearId: 'fy-ajeno' })
    ).rejects.toThrow(/no existe o no es de esta entidad/);
  });

  it('nombrar el ejercicio a mano NO salta el candado del corte', async () => {
    conBase({ ejercicios: [{ id: 'fy-2030', year_number: 2030, start_date: '2030-01-01' }] });
    const r = await importOpeningBalance(CTX, { ...OPTS, fiscalYearId: 'fy-2030' });
    expect(r.escrito).toBe(false);
    expect(r.findings.map((f) => f.regla)).toContain('APE-CORTE');
  });
});

describe('importOpeningBalance · lo que ESCRIBE', () => {
  it('postea UN asiento de ajuste, al primer día del ejercicio y con su source_type', async () => {
    const r = await importOpeningBalance(CTX, { ...OPTS, reason: 'migración desde CONTPAQi' });
    expect(r.escrito).toBe(true);
    expect(r.asiento).toEqual({ id: 'je-1', entry_number: 'JE-2026-0001' });

    type Renglon = { account_id: string; debit_amount: string | null; credit_amount: string | null; description: string };
    const [entityId, fecha, tipo, descripcion, lineas, userId, opciones] = mockCrear.mock.calls[0] as [
      string,
      Date,
      string,
      string,
      Renglon[],
      string,
      Record<string, unknown>,
    ];
    expect(entityId).toBe('ent-1');
    expect(fecha.getFullYear()).toBe(2026);
    expect(fecha.getMonth()).toBe(0);
    expect(fecha.getDate()).toBe(1);
    expect(tipo).toBe('adjusting');
    expect(descripcion).toContain('Saldos de apertura del ejercicio 2026');
    expect(descripcion).toContain('2025-12');
    expect(lineas).toHaveLength(2);
    expect(lineas[0]).toMatchObject({ account_id: 'id-1110', debit_amount: '1000.0000', credit_amount: null });
    expect(lineas[0].description).toContain('Apertura 2026');
    expect(lineas[1]).toMatchObject({ account_id: 'id-3100', debit_amount: null, credit_amount: '1000.0000' });
    expect(lineas[1].description).toContain('3100');
    expect(userId).toBe('user-1');
    expect(opciones).toMatchObject({
      sourceType: 'opening_balance',
      reference: 'XAXX010101000202512B',
      autoPost: true,
    });
  });

  it('deja rastro de la CARGA aparte del rastro del asiento, y con la razón', async () => {
    await importOpeningBalance(CTX, { ...OPTS, reason: 'migración' });
    const entrada = mockAudit.mock.calls[0][1] as Record<string, unknown>;
    expect(entrada.entityType).toBe('opening_balance');
    expect(entrada.reason).toBe('migración');
    expect(entrada.newValues).toMatchObject({
      fiscal_year: 2026,
      entry_date: '2026-01-01',
      origen: 'xml-sat:BalanzaComprobacion:2025-12',
      cuentas: 2,
      documentos_de_auxiliar: 0,
    });
  });

  it('la atestación se lanza DESPUÉS del commit', async () => {
    const orden: string[] = [];
    mockTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const r = await fn({});
      orden.push('commit');
      return r;
    });
    mockAtestar.mockImplementation(() => orden.push('atestacion'));
    await importOpeningBalance(CTX, OPTS);
    expect(orden).toEqual(['commit', 'atestacion']);
  });

  it('--dry-run recorre todo el camino y NO escribe', async () => {
    const r = await importOpeningBalance(CTX, { ...OPTS, dryRun: true });
    expect(r.escrito).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.lines).toHaveLength(2);
    expect(mockCrear).not.toHaveBeenCalled();
  });

  it('con un hallazgo bloqueante no escribe y devuelve el informe entero', async () => {
    conBase({ cuentas: [cuenta({ code: '1110' })] });
    const r = await importOpeningBalance(CTX, OPTS);
    expect(r.escrito).toBe(false);
    expect(r.findings.map((f) => f.regla)).toContain('APE-CUENTA-DESCONOCIDA');
    expect(mockCrear).not.toHaveBeenCalled();
  });

  it('una apertura YA POSTEADA no se repite: duplicaría todos los saldos', async () => {
    conBase({ yaCargada: [{ entry_number: 'JE-2026-0001' }] });
    const r = await importOpeningBalance(CTX, OPTS);
    expect(r.escrito).toBe(false);
    const h = r.findings.find((f) => f.regla === 'APE-YA-CARGADA');
    expect(h?.mensaje).toContain('JE-2026-0001');
    expect(h?.mensaje).toContain('DUPLICARÍA');
  });

  it('el detalle del auxiliar viaja hasta el asiento y se cuenta en el rastro', async () => {
    conBase({
      cuentas: [
        cuenta({ code: '1110', codigo_agrupador_sat: '105.01' }),
        cuenta({ code: '3100', normal_balance: 'credit', account_type: 'equity' }),
      ],
    });
    const r = await importOpeningBalance(CTX, {
      ...OPTS,
      documentos: [
        { cuenta: '1110', documento: 'A-1', contraparte: 'X', fecha: '2025-10-01', vencimiento: '2025-11-01', importe: '600.00' },
        { cuenta: '1110', documento: 'A-2', contraparte: 'Y', fecha: '2025-10-02', vencimiento: '2025-11-02', importe: '400.00' },
      ],
    });
    expect(r.escrito).toBe(true);
    expect(r.lines.filter((l) => l.documento !== undefined)).toHaveLength(2);
    const entrada = mockAudit.mock.calls[0][1] as { newValues: Record<string, unknown> };
    expect(entrada.newValues.documentos_de_auxiliar).toBe(2);
  });
});

// ------------------------------------------------------------
// 7 · EL INFORME
// ------------------------------------------------------------

describe('renderOpeningBalanceReport', () => {
  it('dice qué entró, qué no, y por qué', async () => {
    conBase({
      cuentas: [
        cuenta({ code: '1110', codigo_agrupador_sat: '105.01', name: 'Clientes' }),
        cuenta({ code: '3100', normal_balance: 'credit', account_type: 'equity' }),
      ],
    });
    const r = await importOpeningBalance(CTX, OPTS);
    const texto = renderOpeningBalanceReport(r);
    expect(texto).toContain('Apertura del ejercicio 2026');
    expect(texto).toContain('XAXX010101000');
    expect(texto).toContain('Asiento al 2026-01-01');
    expect(texto).toContain('1110 (cxc)');
    expect(texto).toContain('NO CUADRA');
    expect(texto).toContain('NADA ESCRITO: ver los hallazgos.');
    expect(texto).toContain('APE-CXC-AGREGADA');
  });

  it('cuando se postea, dice el número del asiento y cuántos renglones vienen del auxiliar', async () => {
    conBase({
      cuentas: [
        cuenta({ code: '1110', codigo_agrupador_sat: '105.01' }),
        cuenta({ code: '3100', normal_balance: 'credit', account_type: 'equity' }),
      ],
    });
    const r = await importOpeningBalance(CTX, {
      ...OPTS,
      documentos: [
        { cuenta: '1110', documento: 'A-1', contraparte: 'X', fecha: '2025-10-01', vencimiento: '2025-11-01', importe: '1000.00' },
      ],
    });
    const texto = renderOpeningBalanceReport(r);
    expect(texto).toContain('POSTEADO: asiento JE-2026-0001');
    expect(texto).toContain('1 renglón(es) vienen del auxiliar');
    expect(texto).toContain('cuadra');
  });

  it('un hallazgo con NÚMERO DE FILA lo enseña: es lo que se va a arreglar en el archivo', async () => {
    conBase({ cuentas: [cuenta({ code: '1110' })] });
    const r = await importOpeningBalance(CTX, OPTS);
    expect(renderOpeningBalanceReport(r)).toContain('APE-CUENTA-DESCONOCIDA fila 2 3100');
  });

  it('un hallazgo SIN cuenta —el del archivo entero— también se imprime entero', async () => {
    conBase({ yaCargada: [{ entry_number: 'JE-2026-0001' }] });
    const r = await importOpeningBalance(CTX, OPTS);
    expect(renderOpeningBalanceReport(r)).toContain('[bloquea] APE-YA-CARGADA: Esta entidad');
  });

  it('en ensayo lo dice, en vez de dejar creer que escribió', async () => {
    const r = await importOpeningBalance(CTX, { ...OPTS, dryRun: true });
    expect(renderOpeningBalanceReport(r)).toContain('NADA ESCRITO: es un ensayo');
  });
});

describe('el tipo de error', () => {
  it('lo que lanza es ValidationError, que es lo que el CLI traduce', async () => {
    conBase({ entidad: [] });
    await expect(importOpeningBalance(CTX, OPTS)).rejects.toBeInstanceOf(ValidationError);
  });
});
