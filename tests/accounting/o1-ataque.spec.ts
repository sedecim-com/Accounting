// ============================================================
// O1 · EL ATAQUE — LO QUE UN VERIFICADOR ADVERSARIO LE HIZO A LAS DOS CAPAS
//
// No es una segunda copia de las pruebas del tramo: es la lista de las cosas
// que, si estuvieran mal, dejarían el criterio de la tarjeta —«la balanza del
// sistema viejo y la nuestra, IGUALES AL PESO»— diciendo que sí cuando no.
// Cada bloque nació de un intento de romper algo, y DOS LO CONSIGUIERON:
//
//   · ATAQUE 2 encontró que Debe y Haber se agregaban con el signo de la
//     naturaleza, así que una hija ACREEDORA restaba en vez de sumar y el
//     cotejo inventaba un descuadre. La prueba que cubría esa columna usaba
//     un árbol enteramente deudor: pasaba en verde sin poder fallar nunca.
//   · ATAQUE 3 encontró que la doctrina de CxC/CxP se saltaba en silencio en
//     cuanto la cuenta no traía un CodAgrup del c_CodAgrup — que es
//     exactamente lo que la capa 1 de este mismo tramo crea cuando emite
//     `IMP-TIPO-HEREDADO`.
//
// Los dos están arreglados en el archivo donde vivía el defecto, y estas
// pruebas se quedan como el trinquete: cada una se comprobó ROJA contra una
// mutación del código de producción antes de darse por buena.
// ============================================================

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  compareToSource,
  type AccountShape,
} from '../../src/services/accounting/opening-balance-check.js';
import {
  planOpeningBalance,
  subledgerKindOf,
  type OpeningAccountRow,
  type OpeningDocument,
} from '../../src/services/accounting/opening-balance.js';
import { readBalanzaComprobacion } from '../../src/services/sat/anexo24/balance-reader.js';
import type { BalanceFileRow } from '../../src/services/sat/anexo24/balance-reader.js';

let n = 1;
const fila = (
  numCta: string,
  saldoFin: string,
  extra: Partial<BalanceFileRow> = {}
): BalanceFileRow => ({
  fila: n++,
  numCta,
  saldoIni: '0.00',
  debe: '0.00',
  haber: '0.00',
  saldoFin,
  ...extra,
});
const forma = (code: string, parentCode: string | null, natur: 'D' | 'A' = 'D'): AccountShape => ({
  code,
  parentCode,
  natur,
});

// ============================================================
// ATAQUE 1 · SALDOS INTERCAMBIADOS: la suma cuadra, las cuentas no
// ============================================================
describe('ATAQUE 1 · dos saldos intercambiados', () => {
  const shapes = [forma('100', null), forma('101', '100'), forma('102', '100')];
  const origen = [fila('100', '80000.00'), fila('101', '50000.00'), fila('102', '30000.00')];
  // Nuestro mayor: los mismos 80 000, repartidos AL REVÉS entre las dos hijas.
  const nuestra = [fila('100', '0.00'), fila('101', '30000.00'), fila('102', '50000.00')];

  it('sumar totales NO lo ve (la trampa que hay que descartar)', () => {
    const suma = (rs: BalanceFileRow[]) =>
      rs.reduce((a, r) => a.plus(r.saldoFin), new Decimal(0)).toString();
    // Las hojas suman lo mismo: un cotejo por totales daría verde.
    expect(suma(origen.slice(1))).toBe(suma(nuestra.slice(1)));
  });

  it('el cotejo cuenta por cuenta SÍ lo ve, y nombra las dos', () => {
    const c = compareToSource(origen, nuestra, shapes, 'SaldoFin');
    expect(c.iguales).toBe(false);
    expect(c.diferencias.map((d) => d.numCta).sort()).toEqual(['101', '102']);
    expect(c.diferencias.find((d) => d.numCta === '101')?.diferencia).toBe('-20000.0000');
    expect(c.diferencias.find((d) => d.numCta === '102')?.diferencia).toBe('20000.0000');
  });

  it('y el intercambio entre naturalezas opuestas tampoco se le escapa', () => {
    const sh = [forma('100', null), forma('171', '100', 'A')];
    // El archivo dice activo 50 000 y depreciación 10 000 (neto 40 000).
    const org = [fila('100', '40000.00'), fila('171', '10000.00')];
    // Nuestro mayor tiene los importes cambiados de cuenta: el neto sigue
    // dando 40 000 sólo si además se invierte el signo, así que aquí no.
    const nue = [fila('100', '10000.00'), fila('171', '50000.00')];
    const c = compareToSource(org, nue, sh, 'SaldoFin');
    expect(c.iguales).toBe(false);
    expect(c.diferencias.map((d) => d.numCta).sort()).toEqual(['100', '171']);
  });
});

// ============================================================
// ATAQUE 2 · LA COLUMNA Debe SE AGREGA CON EL SIGNO DEL SALDO
// ============================================================
describe('ATAQUE 2 · Debe/Haber agregados en el eje del mayor', () => {
  it('un padre con una hija ACREEDORA da un descuadre que no existe', () => {
    const shapes = [forma('100', null), forma('101', '100'), forma('171', '100', 'A')];
    // El Anexo 24 agrega Debe como SUMA DE IMPORTES: 1000 + 500 = 1500.
    const origen = [
      fila('100', '0.00', { debe: '1500.00' }),
      fila('101', '0.00', { debe: '1000.00' }),
      fila('171', '0.00', { debe: '500.00' }),
    ];
    // Nuestra balanza declara el movimiento PROPIO de cada cuenta.
    const nuestra = [
      fila('100', '0.00', { debe: '0.00' }),
      fila('101', '0.00', { debe: '1000.00' }),
      fila('171', '0.00', { debe: '500.00' }),
    ];
    const c = compareToSource(origen, nuestra, shapes, 'Debe');
    expect(c.diferencias).toEqual([]);
    expect(c.iguales).toBe(true);
  });
});

// ============================================================
// ATAQUE 3 · LA DOCTRINA DE CxC/CxP CON EL AGRUPADOR AUSENTE
// ============================================================
describe('ATAQUE 3 · una cuenta de clientes sin CodAgrup', () => {
  const cuenta = (
    code: string,
    parent: string | null,
    agrup: string | null,
    natur: 'debit' | 'credit' = 'debit',
    tipo = 'asset'
  ): OpeningAccountRow => ({
    id: `id-${code}`,
    code,
    name: `cuenta ${code}`,
    parent_code: parent,
    account_type: tipo,
    normal_balance: natur,
    codigo_agrupador_sat: agrup,
    is_header: false,
    is_active: true,
    allow_manual_entries: true,
    role: null,
  });

  const balanza = (filas: string) =>
    readBalanzaComprobacion(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">${filas}</Balanza>`
    );

  const ctas = (...xs: [string, string][]) =>
    xs
      .map(([c, s]) => `<Ctas NumCta="${c}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`)
      .join('');

  const ejercicio = { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' };

  it('con CodAgrup 105.01 la doctrina se cumple: bloquea', () => {
    const lectura = balanza(ctas(['300', '12000.00'], ['105', '12000.00'], ['105-001', '12000.00']));
    const plan = planOpeningBalance(
      lectura,
      [
        cuenta('300', null, '300', 'credit', 'equity'),
        cuenta('105', null, '105'),
        cuenta('105-001', '105', '105.01'),
      ],
      [],
      ejercicio
    );
    expect(plan.findings.map((f) => f.regla)).toContain('APE-CXC-AGREGADA');
    expect(plan.puedeCargarse).toBe(false);
  });

  it('SIN CodAgrup —lo que la capa 1 crea con IMP-TIPO-HEREDADO— el agregado ENTRA', () => {
    const lectura = balanza(ctas(['300', '12000.00'], ['105', '12000.00'], ['105-001', '12000.00']));
    const plan = planOpeningBalance(
      lectura,
      [
        cuenta('300', null, '300', 'credit', 'equity'),
        cuenta('105', null, '105'),
        // La hija nació sin agrupador y heredó el tipo del padre: es
        // exactamente lo que `IMP-TIPO-HEREDADO` deja escrito en la base.
        cuenta('105-001', '105', null),
      ],
      [],
      ejercicio
    );
    expect(subledgerKindOf(cuenta('105-001', '105', null))).toBe(null);
    // AQUÍ ESTÁ EL DEFECTO: el saldo agregado de clientes se carga sin un
    // solo hallazgo, que es exactamente lo que la doctrina prohíbe.
    expect(plan.findings.map((f) => f.regla)).toContain('APE-CXC-AGREGADA');
    expect(plan.puedeCargarse).toBe(false);
  });
});

// ============================================================
// ATAQUE 4 · EL CENTAVO QUE NO DIVIDE EXACTO
// ============================================================
describe('ATAQUE 4 · el rastro del centavo', () => {
  const cuenta = (
    code: string,
    parent: string | null,
    agrup: string | null,
    natur: 'debit' | 'credit' = 'debit',
    tipo = 'asset'
  ): OpeningAccountRow => ({
    id: `id-${code}`,
    code,
    name: `cuenta ${code}`,
    parent_code: parent,
    account_type: tipo,
    normal_balance: natur,
    codigo_agrupador_sat: agrup,
    is_header: false,
    is_active: true,
    allow_manual_entries: true,
    role: null,
  });

  it('100.01 repartido en tres no pierde ni gana un centavo', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="102" SaldoIni="100.01" Debe="0.00" Haber="0.00" SaldoFin="100.01"/>` +
        `<Ctas NumCta="102-1" SaldoIni="33.34" Debe="0.00" Haber="0.00" SaldoFin="33.34"/>` +
        `<Ctas NumCta="102-2" SaldoIni="33.34" Debe="0.00" Haber="0.00" SaldoFin="33.34"/>` +
        `<Ctas NumCta="102-3" SaldoIni="33.33" Debe="0.00" Haber="0.00" SaldoFin="33.33"/>` +
        `<Ctas NumCta="300" SaldoIni="100.01" Debe="0.00" Haber="0.00" SaldoFin="100.01"/>` +
        `</Balanza>`
    );
    const plan = planOpeningBalance(
      lectura,
      [
        cuenta('102', null, '102'),
        cuenta('102-1', '102', '102.01'),
        cuenta('102-2', '102', '102.01'),
        cuenta('102-3', '102', '102.01'),
        cuenta('300', null, '300', 'credit', 'equity'),
      ],
      [],
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    expect(plan.findings.filter((f) => f.severidad === 'bloquea')).toEqual([]);
    expect(plan.puedeCargarse).toBe(true);
    // El padre no recibe nada: sus hijas lo cubren al centavo.
    expect(plan.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['102-1', '33.3400', null],
      ['102-2', '33.3400', null],
      ['102-3', '33.3300', null],
      ['300', null, '100.0100'],
    ]);
    expect(plan.totalDebe).toBe('100.0100');
    expect(plan.totalHaber).toBe('100.0100');
  });

  it('un archivo con más decimales que el Anexo 24 (0.005) se deja pasar por el lector', () => {
    const r = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="102" SaldoIni="0.005" Debe="0.00" Haber="0.00" SaldoFin="0.005"/>` +
        `</Balanza>`
    );
    // Se lee sin bloquear: LEC-BAL-ESCALA sólo salta por encima de CUATRO.
    expect(r.puedeImportarse).toBe(true);
    expect(r.rows[0].saldoFin).toBe('0.005');
  });
});

// ============================================================
// ATAQUE 5 · LOS DOCUMENTOS QUE SUMAN EL SALDO CON OTRO REPARTO
// ============================================================
describe('ATAQUE 5 · el auxiliar que suma bien y reparte mal', () => {
  const cuenta = (
    code: string,
    parent: string | null,
    agrup: string | null,
    natur: 'debit' | 'credit' = 'debit',
    tipo = 'asset'
  ): OpeningAccountRow => ({
    id: `id-${code}`,
    code,
    name: `cuenta ${code}`,
    parent_code: parent,
    account_type: tipo,
    normal_balance: natur,
    codigo_agrupador_sat: agrup,
    is_header: false,
    is_active: true,
    allow_manual_entries: true,
    role: null,
  });

  it('dos cuentas de control con los auxiliares CRUZADOS se rechazan las dos', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="105" SaldoIni="4000.00" Debe="0.00" Haber="0.00" SaldoFin="4000.00"/>` +
        `<Ctas NumCta="107" SaldoIni="8000.00" Debe="0.00" Haber="0.00" SaldoFin="8000.00"/>` +
        `<Ctas NumCta="300" SaldoIni="12000.00" Debe="0.00" Haber="0.00" SaldoFin="12000.00"/>` +
        `</Balanza>`
    );
    const docs: OpeningDocument[] = [
      { cuenta: '105', documento: 'A-1', contraparte: 'X', fecha: '2025-11-01', importe: '8000.00' },
      { cuenta: '107', documento: 'B-1', contraparte: 'Y', fecha: '2025-11-01', importe: '4000.00' },
    ];
    const plan = planOpeningBalance(
      lectura,
      [
        cuenta('105', null, '105'),
        cuenta('107', null, '107'),
        cuenta('300', null, '300', 'credit', 'equity'),
      ],
      docs,
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    // La suma total del auxiliar (12 000) coincide con la de la balanza, pero
    // el reparto por cuenta no: las dos tienen que salir nombradas.
    const noCuadra = plan.findings.filter((f) => f.regla === 'APE-DETALLE-NO-CUADRA');
    expect(noCuadra.map((f) => f.numCta).sort()).toEqual(['105', '107']);
    expect(plan.puedeCargarse).toBe(false);
  });
});

// ============================================================
// ATAQUE 6 · LA JERARQUÍA Y LA IDEMPOTENCIA DEL CATÁLOGO
// ============================================================
import {
  planSatChartImport,
  type ExistingAccountRow,
} from '../../src/services/accounting/sat-chart-import.js';
import { readCtaCatalogo } from '../../src/services/sat/anexo24/catalog-reader.js';

const catalogo = (filas: string) =>
  readCtaCatalogo(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Catalogo xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ` +
      `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025">${filas}</Catalogo>`
  );

const cta = (num: string, padre: string | null, agrup: string, nivel: number, natur = 'D') =>
  `<Ctas CodAgrup="${agrup}" NumCta="${num}" Desc="c ${num}"` +
  `${padre === null ? '' : ` SubCtaDe="${padre}"`} Nivel="${nivel}" Natur="${natur}"/>`;

describe('ATAQUE 6 · el archivo que trae los hijos antes que los padres', () => {
  it('una cadena de cuatro niveles EN ORDEN INVERSO se ordena por dependencia', () => {
    const plan = planSatChartImport(
      catalogo(
        cta('102-1-1-1', '102-1-1', '102.01', 4) +
          cta('102-1-1', '102-1', '102.01', 3) +
          cta('102-1', '102', '102.01', 2) +
          cta('102', null, '102', 1)
      ),
      []
    );
    expect(plan.aCrear.map((a) => a.code)).toEqual(['102', '102-1', '102-1-1', '102-1-1-1']);
    // Y el padre siempre aparece antes que el hijo en la lista de escritura.
    const pos = new Map(plan.aCrear.map((a, i) => [a.code, i]));
    for (const a of plan.aCrear) {
      if (a.parentCode !== null) expect(pos.get(a.parentCode)!).toBeLessThan(pos.get(a.code)!);
    }
    expect(plan.puedeImportarse).toBe(true);
  });

  it('un padre AUSENTE deja fuera a toda su descendencia y el plan queda incompleto', () => {
    const plan = planSatChartImport(
      catalogo(cta('102-9', '102', '102.01', 2) + cta('102-9-1', '102-9', '102.01', 3)),
      []
    );
    expect(plan.aCrear).toEqual([]);
    expect(plan.omitidas.map((o) => [o.code, o.motivo])).toEqual([
      ['102-9', 'padre_ausente'],
      ['102-9-1', 'padre_omitido'],
    ]);
    expect(plan.completa).toBe(false);
  });

  it('un padre que YA VIVE en la entidad sí resuelve, y el nivel lo pone la base', () => {
    const existentes: ExistingAccountRow[] = [
      {
        id: 'id-102',
        code: '102',
        name: 'Bancos',
        account_type: 'asset',
        normal_balance: 'debit',
        account_level: 2,
        codigo_agrupador_sat: '102',
      },
    ];
    const plan = planSatChartImport(catalogo(cta('102-9', '102', '102.01', 2)), existentes);
    expect(plan.aCrear.map((a) => [a.code, a.parentCode, a.parentYaExistia, a.nivelEfectivo])).toEqual([
      ['102-9', '102', true, 3],
    ]);
    // El Nivel del archivo decía 2 y la jerarquía lo deja en 3: se dice.
    expect(plan.findings.map((f) => f.regla)).toContain('IMP-NIVEL-DISCREPA');
  });

  it('el ciclo de dos se nombra y NO se importa nada', () => {
    const plan = planSatChartImport(catalogo(cta('A', 'B', '102.01', 2) + cta('B', 'A', '102.01', 2)), []);
    expect(plan.puedeImportarse).toBe(false);
    expect(plan.aCrear).toEqual([]);
    expect(plan.omitidas.map((o) => o.code).sort()).toEqual(['A', 'B']);
  });

  it('IDEMPOTENCIA: la segunda pasada no crea nada y gana el sistema', () => {
    const existentes: ExistingAccountRow[] = [
      {
        id: 'id-102',
        code: '102',
        name: 'Bancos CORREGIDO A MANO',
        account_type: 'asset',
        normal_balance: 'debit',
        account_level: 1,
        codigo_agrupador_sat: '102',
      },
    ];
    const plan = planSatChartImport(catalogo(cta('102', null, '102', 1)), existentes);
    expect(plan.aCrear).toEqual([]);
    expect(plan.yaExistian).toHaveLength(1);
    expect(plan.yaExistian[0].divergencias.map((d) => d.campo)).toEqual(['name']);
    expect(plan.findings.map((f) => f.regla)).toContain('IMP-YA-EXISTIA-DISTINTA');
    expect(plan.completa).toBe(true);
  });
});

// ============================================================
// ATAQUE 7 · LA FECHA DEL ASIENTO DE APERTURA
// ============================================================
import { dayAfterCutoff } from '../../src/services/accounting/opening-balance.js';

describe('ATAQUE 7 · el corte manda sobre la fecha', () => {
  it('diciembre y el mes 13 abren el mismo 1 de enero; junio abre el 1 de julio', () => {
    expect(dayAfterCutoff('2025', '12')).toBe('2026-01-01');
    expect(dayAfterCutoff('2025', '13')).toBe('2026-01-01');
    expect(dayAfterCutoff('2025', '06')).toBe('2025-07-01');
  });

  it('nombrar el ejercicio a mano NO salta el candado del corte', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="06" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="102" SaldoIni="1.00" Debe="0.00" Haber="0.00" SaldoFin="1.00"/>` +
        `</Balanza>`
    );
    const plan = planOpeningBalance(lectura, [], [], {
      id: 'fy',
      yearNumber: 2026,
      startDate: '2026-01-01',
    });
    expect(plan.findings.map((f) => f.regla)).toContain('APE-CORTE');
    expect(plan.lines).toEqual([]);
    expect(plan.puedeCargarse).toBe(false);
  });
});

// ============================================================
// ATAQUE 8 · DÓNDE SE DETIENE LA HERENCIA DEL AUXILIAR
//
// Heredar de más es tan malo como heredar de menos: exigirle el auxiliar
// documento a documento a una ESTIMACIÓN de incobrables o a una cuenta de
// orden es exigir lo que no existe, y bloquearía una migración correcta.
// ============================================================
import { resolveSubledgerKind } from '../../src/services/accounting/opening-balance.js';

describe('ATAQUE 8 · la herencia se detiene en quien sabe responder', () => {
  const fil = (
    code: string,
    parent: string | null,
    agrup: string | null,
    role: string | null = null
  ): OpeningAccountRow => ({
    id: `id-${code}`,
    code,
    name: `c ${code}`,
    parent_code: parent,
    account_type: 'asset',
    normal_balance: 'debit',
    codigo_agrupador_sat: agrup,
    is_header: false,
    is_active: true,
    allow_manual_entries: true,
    role,
  });

  const arbol = (...xs: OpeningAccountRow[]) => new Map(xs.map((x) => [x.code, x]));

  it('el ROL decide aunque la cuenta no traiga agrupador ninguno', () => {
    const c = fil('X', null, null, 'cxc');
    expect(resolveSubledgerKind(c, arbol(c))).toEqual({ kind: 'cxc', decidio: 'X' });
  });

  it('la ESTIMACIÓN de incobrables (108) bajo Clientes NO hereda «cxc»', () => {
    const padre = fil('105', null, '105');
    const hija = fil('105-9', '105', '108.01');
    expect(resolveSubledgerKind(hija, arbol(padre, hija))).toEqual({ kind: null, decidio: '105-9' });
  });

  it('un rubro AMBIGUO (700) responde por sí mismo y detiene la herencia', () => {
    const padre = fil('105', null, '105');
    const hija = fil('105-9', '105', '700');
    expect(resolveSubledgerKind(hija, arbol(padre, hija))).toEqual({ kind: null, decidio: '105-9' });
  });

  it('una CUENTA DE ORDEN (8xx) también responde por sí misma', () => {
    const padre = fil('105', null, '105');
    const hija = fil('105-9', '105', '801');
    expect(resolveSubledgerKind(hija, arbol(padre, hija))).toEqual({ kind: null, decidio: '105-9' });
  });

  it('un agrupador FUERA del c_CodAgrup no responde: hereda del padre', () => {
    const padre = fil('201', null, '201');
    const hija = fil('201-9', '201', '999.01');
    expect(resolveSubledgerKind(hija, arbol(padre, hija))).toEqual({ kind: 'cxp', decidio: '201' });
  });

  it('sin nadie que responda en toda la rama, no se inventa un auxiliar', () => {
    const padre = fil('9', null, null);
    const hija = fil('9-1', '9', '  ');
    expect(resolveSubledgerKind(hija, arbol(padre, hija))).toEqual({ kind: null, decidio: null });
  });

  it('un ciclo de padres no cuelga el ascenso', () => {
    const a = fil('A', 'B', null);
    const b = fil('B', 'A', null);
    expect(resolveSubledgerKind(a, arbol(a, b))).toEqual({ kind: null, decidio: null });
  });

  it('y el mensaje del bloqueo DICE quién lo decidió cuando no fue ella', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="105" SaldoIni="7000.00" Debe="0.00" Haber="0.00" SaldoFin="7000.00"/>` +
        `<Ctas NumCta="105-1" SaldoIni="7000.00" Debe="0.00" Haber="0.00" SaldoFin="7000.00"/>` +
        `<Ctas NumCta="300" SaldoIni="7000.00" Debe="0.00" Haber="0.00" SaldoFin="7000.00"/>` +
        `</Balanza>`
    );
    const capital: OpeningAccountRow = {
      ...fil('300', null, '300'),
      account_type: 'equity',
      normal_balance: 'credit',
    };
    const plan = planOpeningBalance(
      lectura,
      [fil('105', null, '105'), fil('105-1', '105', null), capital],
      [],
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    const h = plan.findings.find((x) => x.regla === 'APE-CXC-AGREGADA');
    expect(h?.numCta).toBe('105-1');
    expect(h?.mensaje).toContain('cuelga de "105"');
    expect(plan.puedeCargarse).toBe(false);
  });
});

// ============================================================
// ATAQUE 9 · EL MAYOR QUE DECLARA MENOS QUE SUS PROPIAS HIJAS
// ============================================================
describe('ATAQUE 9 · el archivo internamente inconsistente', () => {
  const fil2 = (
    code: string,
    parent: string | null,
    agrup: string | null,
    tipo = 'asset',
    natur: 'debit' | 'credit' = 'debit'
  ): OpeningAccountRow => ({
    id: `id-${code}`,
    code,
    name: `c ${code}`,
    parent_code: parent,
    account_type: tipo,
    normal_balance: natur,
    codigo_agrupador_sat: agrup,
    is_header: false,
    is_active: true,
    allow_manual_entries: true,
    role: null,
  });

  it('el mayor recibe un renglón CONTRARIO a su naturaleza, y ahora se dice', () => {
    // «102 Bancos» declara 40 000 y su única subcuenta declara 50 000: el
    // residuo son 10 000 de ABONO sobre una cuenta deudora. El árbol sumado
    // sigue cuadrando con el archivo —por eso el cotejo al peso no lo ve— y
    // por eso el aviso es el único sitio donde queda escrito.
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="102" SaldoIni="40000.00" Debe="0.00" Haber="0.00" SaldoFin="40000.00"/>` +
        `<Ctas NumCta="102-1" SaldoIni="50000.00" Debe="0.00" Haber="0.00" SaldoFin="50000.00"/>` +
        `<Ctas NumCta="300" SaldoIni="40000.00" Debe="0.00" Haber="0.00" SaldoFin="40000.00"/>` +
        `</Balanza>`
    );
    const plan = planOpeningBalance(
      lectura,
      [
        fil2('102', null, '102'),
        fil2('102-1', '102', '102.01'),
        fil2('300', null, '300', 'equity', 'credit'),
      ],
      [],
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    const h = plan.findings.find((x) => x.regla === 'APE-RESIDUO-CONTRARIO');
    expect(h?.numCta).toBe('102');
    expect(h?.severidad).toBe('aviso');
    expect(h?.mensaje).toContain('declara 40000.00 y sus subcuentas');
    expect(h?.mensaje).toContain('-10000.00');
    // Sigue siendo un aviso: el asiento se escribe y cuadra.
    expect(plan.puedeCargarse).toBe(true);
    expect(plan.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['102', null, '10000.0000'],
      ['102-1', '50000.0000', null],
      ['300', null, '40000.0000'],
    ]);
  });

  it('una cuenta ACREEDORA con hijas normales NO dispara el aviso', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="213" SaldoIni="3000.00" Debe="0.00" Haber="0.00" SaldoFin="3000.00"/>` +
        `<Ctas NumCta="213-1" SaldoIni="1000.00" Debe="0.00" Haber="0.00" SaldoFin="1000.00"/>` +
        `<Ctas NumCta="102" SaldoIni="3000.00" Debe="0.00" Haber="0.00" SaldoFin="3000.00"/>` +
        `</Balanza>`
    );
    const plan = planOpeningBalance(
      lectura,
      [
        fil2('213', null, '213', 'liability', 'credit'),
        fil2('213-1', '213', '213.01', 'liability', 'credit'),
        fil2('102', null, '102'),
      ],
      [],
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    expect(plan.findings.map((x) => x.regla)).not.toContain('APE-RESIDUO-CONTRARIO');
    expect(plan.puedeCargarse).toBe(true);
  });
});

// ============================================================
// ATAQUE 10 · EL ESLABÓN QUE HACE ALCANZABLE EL ATAQUE 3
//
// La capa 1 no rechaza una cuenta sin CodAgrup: la crea heredando el tipo del
// padre y guarda el agrupador como NULL. Es esa cuenta —creada por este mismo
// tramo, con un archivo perfectamente normal— la que la capa 2 tenía que
// haber reconocido como cuenta de control y no reconocía.
// ============================================================
describe('ATAQUE 10 · la capa 1 crea cuentas sin agrupador utilizable', () => {
  it('una subcuenta de Clientes SIN CodAgrup se crea, hereda el tipo y guarda NULL', () => {
    const lectura = readCtaCatalogo(
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Catalogo xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025">` +
        `<Ctas CodAgrup="105" NumCta="105" Desc="Clientes" Nivel="1" Natur="D"/>` +
        // Sin CodAgrup: el Anexo 24 lo exige y el lector lo NOMBRA, pero no
        // bloquea, y la cuenta entra igual heredando el tipo de su padre.
        `<Ctas CodAgrup="" NumCta="105-001" Desc="Clientes nacionales" SubCtaDe="105" Nivel="2" Natur="D"/>` +
        `</Catalogo>`
    );
    expect(lectura.findings.map((f) => f.regla)).toContain('LEC-CODAGRUP-AUSENTE');
    expect(lectura.puedeImportarse).toBe(true);

    const plan = planSatChartImport(lectura, []);
    expect(plan.aCrear.map((a) => [a.code, a.codAgrup, a.accountType, a.origenDelTipo])).toEqual([
      ['105', '105', 'asset', 'agrupador'],
      ['105-001', '', 'asset', 'padre'],
    ]);
    expect(plan.findings.map((f) => f.regla)).toContain('IMP-TIPO-HEREDADO');
    expect(plan.puedeImportarse).toBe(true);
    // `codAgrup: ''` es lo que el escritor guarda como NULL en la columna, que
    // es exactamente la fila con la que el ATAQUE 3 rompía la doctrina.
    expect(plan.aCrear[1].codAgrup).toBe('');
  });
});

// ============================================================
// ATAQUE 11 · LA CLAVE DEL DOCUMENTO DUPLICADO NO PUEDE COLISIONAR
//
// `APE-DOCUMENTO-DUPLICADO` se decide sobre una clave compuesta de cuenta y
// folio. Con un separador que SÍ pueda aparecer en cualquiera de los dos —un
// espacio, un guion, o ninguno— dos documentos distintos comparten clave y el
// segundo se rechaza como duplicado de un documento que no existe: un
// auxiliar correcto se vuelve incargable y el mensaje señala al renglón que
// no tiene la culpa.
// ============================================================
describe('ATAQUE 11 · dos documentos que sólo colisionan si el separador es débil', () => {
  it('cuatro documentos que sólo colisionan si el separador se debilita', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        // Un NumCta con espacio no es un caso rebuscado: la doctrina de este
        // tramo es que el código del cliente entra TAL CUAL, y los despachos
        // los escriben así.
        `<Ctas NumCta="105" SaldoIni="300.00" Debe="0.00" Haber="0.00" SaldoFin="300.00"/>` +
        `<Ctas NumCta="105 A" SaldoIni="200.00" Debe="0.00" Haber="0.00" SaldoFin="200.00"/>` +
        `<Ctas NumCta="105A" SaldoIni="400.00" Debe="0.00" Haber="0.00" SaldoFin="400.00"/>` +
        `<Ctas NumCta="300" SaldoIni="900.00" Debe="0.00" Haber="0.00" SaldoFin="900.00"/>` +
        `</Balanza>`
    );
    const fil3 = (code: string, agrup: string | null, tipo = 'asset', natur: 'debit' | 'credit' = 'debit'): OpeningAccountRow => ({
      id: `id-${code}`,
      code,
      name: `c ${code}`,
      parent_code: null,
      account_type: tipo,
      normal_balance: natur,
      codigo_agrupador_sat: agrup,
      is_header: false,
      is_active: true,
      allow_manual_entries: true,
      role: null,
    });
    // Las claves, según el separador:
    //   NUL      105·A 1   105·A1   105 A·1   105A·1     → cuatro distintas
    //   espacio  105 A 1   105 A1   105 A 1   105A 1     → 1.ª y 3.ª IGUALES
    //   nada     105A 1    105A1    105 A1    105A1      → 2.ª y 4.ª IGUALES
    const docs: OpeningDocument[] = [
      { cuenta: '105', documento: 'A 1', contraparte: 'X', fecha: '2025-11-01', importe: '100.00' },
      { cuenta: '105', documento: 'A1', contraparte: 'X', fecha: '2025-11-01', importe: '200.00' },
      { cuenta: '105 A', documento: '1', contraparte: 'Y', fecha: '2025-11-01', importe: '200.00' },
      { cuenta: '105A', documento: '1', contraparte: 'Z', fecha: '2025-11-01', importe: '400.00' },
    ];
    const plan = planOpeningBalance(
      lectura,
      [
        fil3('105', '105'),
        fil3('105 A', '105'),
        fil3('105A', '105'),
        fil3('300', '300', 'equity', 'credit'),
      ],
      docs,
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    expect(plan.findings.map((f) => f.regla)).not.toContain('APE-DOCUMENTO-DUPLICADO');
    expect(plan.puedeCargarse).toBe(true);
    expect(plan.lines).toHaveLength(5);
  });

  it('y el duplicado de verdad sí se caza', () => {
    const lectura = readBalanzaComprobacion(
      `<Balanza xmlns="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ` +
        `Version="1.3" RFC="XAXX010101000" Mes="12" Anio="2025" TipoEnvio="N">` +
        `<Ctas NumCta="A" SaldoIni="100.00" Debe="0.00" Haber="0.00" SaldoFin="100.00"/>` +
        `</Balanza>`
    );
    const plan = planOpeningBalance(
      lectura,
      [
        {
          id: 'id-A',
          code: 'A',
          name: 'c A',
          parent_code: null,
          account_type: 'asset',
          normal_balance: 'debit',
          codigo_agrupador_sat: '105',
          is_header: false,
          is_active: true,
          allow_manual_entries: true,
          role: null,
        },
      ],
      [
        { cuenta: 'A', documento: 'F-1', contraparte: 'X', fecha: '2025-11-01', importe: '50.00' },
        { cuenta: 'A', documento: 'F-1', contraparte: 'X', fecha: '2025-11-01', importe: '50.00' },
      ],
      { id: 'fy', yearNumber: 2026, startDate: '2026-01-01' }
    );
    expect(plan.findings.map((f) => f.regla)).toContain('APE-DOCUMENTO-DUPLICADO');
    expect(plan.puedeCargarse).toBe(false);
  });
});
