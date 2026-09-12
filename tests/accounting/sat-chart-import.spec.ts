import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(),
  tenantDe: vi.fn(async () => 'tenant-1'),
}));

import {
  planSatChartImport,
  importSatChart,
  renderSatChartImportReport,
  type ExistingAccountRow,
} from '../../src/services/accounting/sat-chart-import.js';
import { readCtaCatalogo } from '../../src/services/sat/anexo24/catalog-reader.js';
import { query, withTransaction } from '../../src/database/connection.js';
import { registrarAuditoria } from '../../src/services/audit/audit-log.js';
import { ValidationError } from '../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const mockAudit = registrarAuditoria as unknown as Mock;

// ============================================================
// O1 · EL ALTA DE CUENTAS DESDE EL CtaCatalogo
// ============================================================

const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';

interface FilaXml {
  numCta: string;
  desc?: string;
  codAgrup?: string;
  nivel?: number;
  natur?: 'D' | 'A';
  subCtaDe?: string;
}

function fila(f: FilaXml): string {
  const sub = f.subCtaDe === undefined ? '' : ` SubCtaDe="${f.subCtaDe}"`;
  return (
    `<catalogocuentas:Ctas CodAgrup="${f.codAgrup ?? '100'}" NumCta="${f.numCta}" ` +
    `Desc="${f.desc ?? `Cuenta ${f.numCta}`}"${sub} Nivel="${f.nivel ?? 1}" Natur="${f.natur ?? 'D'}"/>`
  );
}

function archivo(filas: FilaXml[], rfc = 'AAA010101AAA'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS}" Version="1.3" RFC="${rfc}" Mes="01" Anio="2026">` +
    filas.map(fila).join('') +
    `</catalogocuentas:Catalogo>`
  );
}

const plan = (filas: FilaXml[], existentes: ExistingAccountRow[] = []) =>
  planSatChartImport(readCtaCatalogo(archivo(filas)), existentes);

const existente = (p: Partial<ExistingAccountRow> & { code: string }): ExistingAccountRow => ({
  id: `id-${p.code}`,
  name: p.name ?? `Cuenta ${p.code}`,
  account_type: p.account_type ?? 'asset',
  normal_balance: p.normal_balance ?? 'debit',
  account_level: p.account_level ?? 1,
  codigo_agrupador_sat: 'codigo_agrupador_sat' in p ? (p.codigo_agrupador_sat ?? null) : '100',
  code: p.code,
});

describe('planSatChartImport · la jerarquía', () => {
  it('ordena por dependencia aunque el archivo venga del revés', () => {
    // El hijo primero, el nieto antes que el hijo: `parent_id` es una clave
    // foránea, así que el orden del archivo no vale como orden de inserción.
    const p = plan([
      { numCta: '100-01-01', subCtaDe: '100-01', nivel: 3 },
      { numCta: '100-01', subCtaDe: '100', nivel: 2 },
      { numCta: '100', nivel: 1 },
    ]);
    expect(p.aCrear.map((c) => c.code)).toEqual(['100', '100-01', '100-01-01']);
    expect(p.completa).toBe(true);
  });

  it('el padre puede estar YA en la entidad y no en el archivo', () => {
    const p = plan([{ numCta: '100-01', subCtaDe: '100', nivel: 2 }], [existente({ code: '100' })]);
    expect(p.aCrear).toHaveLength(1);
    expect(p.aCrear[0].parentCode).toBe('100');
    expect(p.aCrear[0].parentYaExistia).toBe(true);
    expect(p.aCrear[0].nivelEfectivo).toBe(2);
  });

  it('un padre que no está en ningún sitio deja la cuenta fuera, con nombre propio', () => {
    const p = plan([{ numCta: '100-01', subCtaDe: '999', nivel: 2 }]);
    expect(p.aCrear).toEqual([]);
    expect(p.omitidas).toEqual([
      { fila: 1, code: '100-01', motivo: 'padre_ausente', detalle: 'SubCtaDe="999"' },
    ]);
    const h = p.findings.find((f) => f.regla === 'IMP-PADRE-AUSENTE');
    expect(h?.numCta).toBe('100-01');
    expect(h?.mensaje).toContain('999');
  });

  it('la descendencia del que se quedó fuera se queda fuera con él, y se dice', () => {
    const p = plan([
      { numCta: '100-01', subCtaDe: '999', nivel: 2 },
      { numCta: '100-01-01', subCtaDe: '100-01', nivel: 3 },
    ]);
    expect(p.omitidas.map((o) => o.motivo)).toEqual(['padre_ausente', 'padre_omitido']);
    expect(p.findings.map((f) => f.regla)).toContain('IMP-PADRE-OMITIDO');
  });

  it('un ciclo bloquea el archivo ENTERO y nombra a sus miembros', () => {
    const p = plan([
      { numCta: 'A', subCtaDe: 'B', nivel: 2 },
      { numCta: 'B', subCtaDe: 'A', nivel: 2 },
      { numCta: 'C', nivel: 1 },
    ]);
    expect(p.puedeImportarse).toBe(false);
    // Y NO se ofrece un plan a medias que alguien pudiera ejecutar.
    expect(p.aCrear).toEqual([]);
    const h = p.findings.find((f) => f.regla === 'IMP-CICLO');
    expect(h?.severidad).toBe('bloquea');
    expect(h?.mensaje).toContain('"A"');
    expect(h?.mensaje).toContain('"B"');
    expect(h?.mensaje).not.toContain('"C"');
  });

  it('una cuenta que se declara padre de sí misma es un ciclo de uno', () => {
    const p = plan([{ numCta: 'A', subCtaDe: 'A', nivel: 1 }]);
    expect(p.puedeImportarse).toBe(false);
    expect(p.omitidas[0].motivo).toBe('jerarquia_ciclica');
  });

  it('el Nivel del archivo NO se guarda: manda la jerarquía, y la diferencia se dice', () => {
    const p = plan([{ numCta: '100', nivel: 3 }]);
    expect(p.aCrear[0].nivelDeclarado).toBe(3);
    expect(p.aCrear[0].nivelEfectivo).toBe(1);
    const h = p.findings.find((f) => f.regla === 'IMP-NIVEL-DISCREPA');
    expect(h?.mensaje).toContain('account_level lo calcula el disparador');
    expect(h?.mensaje).toContain('no cuelga de nadie');
  });

  it('y en un hijo, la discrepancia de nivel nombra al padre bajo el que queda', () => {
    const p = plan([
      { numCta: '100', nivel: 1 },
      { numCta: '100-01', subCtaDe: '100', nivel: 4 },
    ]);
    const h = p.findings.find((f) => f.regla === 'IMP-NIVEL-DISCREPA');
    expect(h?.numCta).toBe('100-01');
    expect(h?.mensaje).toContain('bajo "100"');
  });
});

describe('planSatChartImport · el tipo de cuenta', () => {
  it('sale del rubro del agrupador, no del código del cliente', () => {
    const p = plan([
      { numCta: 'X-1', codAgrup: '101', natur: 'D' },
      { numCta: 'X-2', codAgrup: '201', natur: 'A' },
      { numCta: 'X-3', codAgrup: '301', natur: 'A' },
      { numCta: 'X-4', codAgrup: '401', natur: 'A' },
      { numCta: 'X-5', codAgrup: '601', natur: 'D' },
    ]);
    expect(p.aCrear.map((c) => c.accountType)).toEqual([
      'asset',
      'liability',
      'equity',
      'revenue',
      'expense',
    ]);
    expect(p.aCrear.every((c) => c.origenDelTipo === 'agrupador')).toBe(true);
  });

  it('la depreciación acumulada entra como contracuenta, no como activo raro', () => {
    const p = plan([{ numCta: '1290', codAgrup: '171', natur: 'A', desc: 'Depreciación acumulada' }]);
    expect(p.aCrear[0].accountType).toBe('contra_asset');
    expect(p.aCrear[0].normalBalance).toBe('credit');
    // Y sin aviso de contradicción: el tipo y la naturaleza concuerdan.
    expect(p.findings.map((f) => f.regla)).not.toContain('IMP-NATUR-CONTRA-TIPO');
  });

  it('las devoluciones sobre ingresos entran como ingreso deudor Y se denuncia', () => {
    const p = plan([{ numCta: '4900', codAgrup: '402', natur: 'D', desc: 'Devoluciones' }]);
    expect(p.aCrear[0].accountType).toBe('revenue');
    expect(p.aCrear[0].normalBalance).toBe('debit');
    const h = p.findings.find((f) => f.regla === 'IMP-NATUR-CONTRA-TIPO');
    expect(h?.numCta).toBe('4900');
  });

  it('el rubro 700 lo desempata la naturaleza, y lo dice en vez de callarlo', () => {
    const p = plan([
      { numCta: 'F-1', codAgrup: '700', natur: 'D' },
      { numCta: 'F-2', codAgrup: '700', natur: 'A' },
    ]);
    expect(p.aCrear.map((c) => c.accountType)).toEqual(['expense', 'revenue']);
    expect(p.aCrear.every((c) => c.origenDelTipo === 'agrupador_y_naturaleza')).toBe(true);
    expect(p.findings.filter((f) => f.regla === 'IMP-RUBRO-AMBIGUO')).toHaveLength(2);
  });

  it('sin agrupador utilizable, el tipo lo da el PADRE, y la cuenta entra avisada', () => {
    const p = plan([
      { numCta: '100', codAgrup: '101', natur: 'D' },
      { numCta: '100-01', codAgrup: '', subCtaDe: '100', nivel: 2, natur: 'D' },
      { numCta: '100-02', codAgrup: '999', subCtaDe: '100', nivel: 2, natur: 'A' },
    ]);
    expect(p.aCrear.map((c) => c.accountType)).toEqual(['asset', 'asset', 'contra_asset']);
    expect(p.aCrear.slice(1).every((c) => c.origenDelTipo === 'padre')).toBe(true);
    expect(p.findings.filter((f) => f.regla === 'IMP-TIPO-HEREDADO')).toHaveLength(2);
    expect(p.completa).toBe(true);
  });

  it('también hereda de un padre que ya vivía en la entidad', () => {
    const p = plan(
      [{ numCta: '2100-01', codAgrup: '', subCtaDe: '2100', nivel: 2, natur: 'A' }],
      [existente({ code: '2100', account_type: 'liability', normal_balance: 'credit' })]
    );
    expect(p.aCrear[0].accountType).toBe('liability');
    expect(p.aCrear[0].origenDelTipo).toBe('padre');
  });

  it('sin agrupador y sin padre NO se inventa nada: la cuenta se queda fuera', () => {
    const p = plan([{ numCta: 'Z', codAgrup: '', natur: 'D' }]);
    expect(p.aCrear).toEqual([]);
    expect(p.omitidas[0].motivo).toBe('sin_tipo_deducible');
    expect(p.completa).toBe(false);
    const h = p.findings.find((f) => f.regla === 'IMP-SIN-TIPO');
    expect(h?.mensaje).toContain('No trae CodAgrup');
  });

  it('un agrupador fuera del c_CodAgrup y sin padre también se queda fuera, con OTRO motivo', () => {
    const p = plan([{ numCta: 'Z', codAgrup: '999', natur: 'D' }]);
    const h = p.findings.find((f) => f.regla === 'IMP-SIN-TIPO');
    expect(h?.mensaje).toContain('"999" no está en el c_CodAgrup');
  });

  it('las cuentas de orden NO heredan del padre: heredar las metería en el balance', () => {
    const p = plan([
      { numCta: '100', codAgrup: '101', natur: 'D' },
      { numCta: '800', codAgrup: '801', subCtaDe: '100', nivel: 2, natur: 'D', desc: 'UFIN' },
    ]);
    expect(p.aCrear.map((c) => c.code)).toEqual(['100']);
    expect(p.omitidas[0]).toMatchObject({ code: '800', motivo: 'cuentas_de_orden' });
    const h = p.findings.find((f) => f.regla === 'IMP-CUENTAS-DE-ORDEN');
    expect(h?.mensaje).toContain('sumaría al balance dinero que no existe');
  });

  it('un padre existente con un tipo que este módulo no traduce no presta tipo a nadie', () => {
    const p = plan(
      [{ numCta: 'H', codAgrup: '', subCtaDe: 'P', nivel: 2 }],
      [existente({ code: 'P', account_type: 'memorandum' })]
    );
    expect(p.omitidas[0].motivo).toBe('sin_tipo_deducible');
  });
});

describe('planSatChartImport · la idempotencia y quién gana', () => {
  it('la cuenta que ya existe NO se toca y no se duplica', () => {
    const p = plan(
      [{ numCta: '100', codAgrup: '101', desc: 'Cuenta 100' }],
      [existente({ code: '100', codigo_agrupador_sat: '101' })]
    );
    expect(p.aCrear).toEqual([]);
    expect(p.yaExistian).toEqual([{ fila: 1, code: '100', id: 'id-100', divergencias: [] }]);
    expect(p.completa).toBe(true);
  });

  it('gana el sistema, y CADA diferencia se nombra en vez de pisarse', () => {
    const p = plan(
      [{ numCta: '100', desc: 'Caja chica', codAgrup: '101.01', natur: 'A' }],
      [
        existente({
          code: '100',
          name: 'Caja (corregido a mano)',
          codigo_agrupador_sat: '101',
          normal_balance: 'debit',
        }),
      ]
    );
    expect(p.aCrear).toEqual([]);
    expect(p.yaExistian[0].divergencias).toEqual([
      { campo: 'name', enElArchivo: 'Caja chica', enElSistema: 'Caja (corregido a mano)' },
      { campo: 'codigo_agrupador_sat', enElArchivo: '101.01', enElSistema: '101' },
      { campo: 'normal_balance', enElArchivo: 'credit', enElSistema: 'debit' },
    ]);
    const h = p.findings.find((f) => f.regla === 'IMP-YA-EXISTIA-DISTINTA');
    expect(h?.severidad).toBe('aviso');
    expect(h?.mensaje).toContain('no puede borrar la corrección');
  });

  it('la naturaleza también se compara al revés: archivo deudor contra sistema acreedor', () => {
    const p = plan(
      [{ numCta: '2100', codAgrup: '201', natur: 'D' }],
      [
        existente({
          code: '2100',
          codigo_agrupador_sat: '201',
          account_type: 'liability',
          normal_balance: 'credit',
        }),
      ]
    );
    expect(p.yaExistian[0].divergencias).toEqual([
      { campo: 'normal_balance', enElArchivo: 'debit', enElSistema: 'credit' },
    ]);
  });

  it('una cuenta acreedora que coincide en todo no produce divergencia ninguna', () => {
    const p = plan(
      [{ numCta: '2100', desc: 'Cuenta 2100', codAgrup: '201', natur: 'A' }],
      [
        existente({
          code: '2100',
          codigo_agrupador_sat: '201',
          account_type: 'liability',
          normal_balance: 'credit',
        }),
      ]
    );
    expect(p.yaExistian[0].divergencias).toEqual([]);
  });

  it('la cuenta existente SIN agrupador diverge de la del archivo que sí lo trae', () => {
    const p = plan(
      [{ numCta: '100', codAgrup: '101' }],
      [existente({ code: '100', codigo_agrupador_sat: null })]
    );
    expect(p.yaExistian[0].divergencias).toEqual([
      { campo: 'codigo_agrupador_sat', enElArchivo: '101', enElSistema: '' },
    ]);
  });

  it('los hijos de una cuenta que ya existía sí se crean, colgados de ella', () => {
    const p = plan(
      [
        { numCta: '100', codAgrup: '101' },
        { numCta: '100-01', codAgrup: '101.01', subCtaDe: '100', nivel: 2 },
      ],
      [existente({ code: '100' })]
    );
    expect(p.aCrear.map((c) => c.code)).toEqual(['100-01']);
    expect(p.aCrear[0].parentYaExistia).toBe(true);
  });
});

describe('planSatChartImport · el archivo que no se puede leer', () => {
  it('no planea nada sobre un archivo con un defecto que bloquea', () => {
    const lectura = readCtaCatalogo(
      archivo([{ numCta: '100' }, { numCta: '100' }]) // NumCta duplicado
    );
    const p = planSatChartImport(lectura, []);
    expect(p.puedeImportarse).toBe(false);
    expect(p.aCrear).toEqual([]);
    expect(p.completa).toBe(false);
    expect(p.findings.map((f) => f.regla)).toContain('LEC-NUMCTA-DUPLICADO');
  });
});

// ============================================================
// LA ENVOLTURA DE E/S
// ============================================================

const ENTIDAD = { tax_id: 'AAA010101AAA', tax_id_type: 'rfc', name: 'Aceros del Norte' };

function conBase(existentes: ExistingAccountRow[], entidad: unknown = ENTIDAD): void {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('legal_entities')) {
      return { rows: entidad === null ? [] : [entidad], rowCount: entidad === null ? 0 : 1 };
    }
    return { rows: existentes, rowCount: existentes.length };
  });
}

/** Ejecuta el cuerpo de la transacción contra un cliente de mentira que sí cuenta. */
function conTransaccion(): { inserciones: unknown[][] } {
  const inserciones: unknown[][] = [];
  mockTx.mockReset();
  mockTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO accounts')) {
          inserciones.push(params);
          return { rows: [{ id: `nuevo-${String(params[1])}` }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return fn(client);
  });
  return { inserciones };
}

describe('importSatChart · la frontera de entidad y de inquilino', () => {
  beforeEach(() => {
    mockAudit.mockReset();
  });

  it('una entidad que no es de este inquilino no devuelve fila y no existe', async () => {
    conBase([], null);
    await expect(
      importSatChart({ tenantId: 't1' }, { entityId: 'e1', xml: archivo([{ numCta: '100' }]), userId: 'u1' })
    ).rejects.toThrowError(/no existe en este inquilino/);
    // El inquilino va DENTRO del SQL, no en un filtro posterior.
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('tenant_id = $2');
    expect(mockQuery.mock.calls[0][1]).toEqual(['e1', 't1']);
  });

  it('una entidad sin RFC no puede recibir un archivo del Anexo 24', async () => {
    conBase([], { tax_id: '12-3456789', tax_id_type: 'ein', name: 'Norte LLC' });
    await expect(
      importSatChart({ tenantId: 't1' }, { entityId: 'e1', xml: archivo([{ numCta: '100' }]), userId: 'u1' })
    ).rejects.toThrowError(/EIN y no con RFC/);
  });

  it('el catálogo de OTRO contribuyente se rehúsa: es la equivocación cara de una migración', async () => {
    conBase([]);
    await expect(
      importSatChart(
        { tenantId: 't1' },
        { entityId: 'e1', xml: archivo([{ numCta: '100' }], 'BBB020202BB2'), userId: 'u1' }
      )
    ).rejects.toThrowError(ValidationError);
    await expect(
      importSatChart(
        { tenantId: 't1' },
        { entityId: 'e1', xml: archivo([{ numCta: '100' }], 'BBB020202BB2'), userId: 'u1' }
      )
    ).rejects.toThrowError(/BBB020202BB2/);
  });

  it('sólo lee las cuentas de ESTA entidad', async () => {
    conBase([]);
    conTransaccion();
    await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', xml: archivo([{ numCta: '100', codAgrup: '101' }]), userId: 'u1' }
    );
    const sql = String(mockQuery.mock.calls[1][0]);
    expect(sql).toContain('FROM accounts');
    expect(sql).toContain('WHERE entity_id = $1');
    expect(mockQuery.mock.calls[1][1]).toEqual(['e1']);
  });
});

describe('importSatChart · escribir, o no escribir', () => {
  beforeEach(() => {
    mockAudit.mockReset();
  });

  it('crea las cuentas en orden de dependencia y guarda el agrupador tal cual', async () => {
    conBase([]);
    const { inserciones } = conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        reason: 'migración desde CONTPAQi',
        xml: archivo([
          { numCta: '100-01', codAgrup: '101.01', subCtaDe: '100', nivel: 2 },
          { numCta: '100', codAgrup: '101', nivel: 1 },
        ]),
      }
    );

    expect(r.escrito).toBe(true);
    expect(r.creadas).toEqual(['100', '100-01']);
    expect(inserciones.map((p) => p[1])).toEqual(['100', '100-01']);
    // El hijo se cuelga del id que el padre acaba de recibir.
    expect(inserciones[0][6]).toBeNull();
    expect(inserciones[1][6]).toBe('nuevo-100');
    expect(inserciones[1][5]).toBe('101.01');
    // Y cada alta deja rastro, con su razón, en la MISMA transacción.
    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'create',
      entityType: 'account',
      reason: 'migración desde CONTPAQi',
    });
  });

  it('el agrupador vacío se guarda como NULL, que es lo que la columna significa', async () => {
    conBase([existente({ code: '100' })]);
    const { inserciones } = conTransaccion();
    await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        xml: archivo([{ numCta: '100-01', codAgrup: '', subCtaDe: '100', nivel: 2 }]),
      }
    );
    expect(inserciones[0][5]).toBeNull();
  });

  it('el ensayo no escribe una sola fila', async () => {
    conBase([]);
    const { inserciones } = conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', userId: 'u1', dryRun: true, xml: archivo([{ numCta: '100', codAgrup: '101' }]) }
    );
    expect(r.dryRun).toBe(true);
    expect(r.escrito).toBe(false);
    expect(r.aCrear).toHaveLength(1);
    expect(inserciones).toEqual([]);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('por omisión NO escribe nada si alguna cuenta se queda fuera', async () => {
    conBase([]);
    const { inserciones } = conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        xml: archivo([
          { numCta: '100', codAgrup: '101' },
          { numCta: 'Z', codAgrup: '' },
        ]),
      }
    );
    expect(r.escrito).toBe(false);
    expect(r.puedeImportarse).toBe(false);
    expect(inserciones).toEqual([]);
    const h = r.findings.find((f) => f.regla === 'IMP-INCOMPLETO');
    expect(h?.severidad).toBe('bloquea');
    expect(h?.mensaje).toContain('AL PESO');
  });

  it('con --parcial escribe lo que puede, a sabiendas', async () => {
    conBase([]);
    const { inserciones } = conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        parcial: true,
        xml: archivo([
          { numCta: '100', codAgrup: '101' },
          { numCta: 'Z', codAgrup: '' },
        ]),
      }
    );
    expect(r.escrito).toBe(true);
    expect(r.creadas).toEqual(['100']);
    expect(r.completa).toBe(false);
    expect(inserciones).toHaveLength(1);
  });

  it('no abre transacción cuando no hay nada nuevo que crear (reimportación limpia)', async () => {
    conBase([existente({ code: '100', codigo_agrupador_sat: '101' })]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', userId: 'u1', xml: archivo([{ numCta: '100', codAgrup: '101' }]) }
    );
    expect(r.escrito).toBe(true);
    expect(r.creadas).toEqual([]);
    expect(r.yaExistian).toHaveLength(1);
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('si otra corrida ganó la carrera, el hijo encuentra al padre igualmente', async () => {
    conBase([]);
    // ON CONFLICT DO NOTHING deja el RETURNING vacío: hay que releer el id.
    mockTx.mockReset();
    const relecturas: string[] = [];
    mockTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          if (sql.includes('INSERT INTO accounts')) return { rows: [], rowCount: 0 };
          if (sql.includes('SELECT id FROM accounts')) {
            relecturas.push(String(params[0]));
            return { rows: [{ id: `ya-${String(params[0])}` }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(client);
    });
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        xml: archivo([
          { numCta: '100', codAgrup: '101' },
          { numCta: '100-01', codAgrup: '101.01', subCtaDe: '100', nivel: 2 },
        ]),
      }
    );
    expect(relecturas).toEqual(['100', '100-01']);
    // Nada se cuenta como creado, y nada se audita: no lo creó esta corrida.
    expect(r.creadas).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('si la cuenta ni se inserta ni se relee, se deshace TODO en vez de re-enraizar al hijo', async () => {
    conBase([]);
    mockTx.mockReset();
    mockTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      };
      return fn(client);
    });
    await expect(
      importSatChart(
        { tenantId: 't1' },
        {
          entityId: 'e1',
          userId: 'u1',
          xml: archivo([
            { numCta: '100', codAgrup: '101' },
            { numCta: '100-01', codAgrup: '101.01', subCtaDe: '100', nivel: 2 },
          ]),
        }
      )
    ).rejects.toThrowError(/ni se insertó ni se pudo releer/);
  });

  it('un archivo ilegible no llega a abrir transacción', async () => {
    conBase([]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', userId: 'u1', xml: archivo([{ numCta: '100' }, { numCta: '100' }]) }
    );
    expect(r.escrito).toBe(false);
    expect(mockTx).not.toHaveBeenCalled();
  });
});

describe('el informe, que es lo que lee quien migra', () => {
  beforeEach(() => {
    mockAudit.mockReset();
  });

  it('cuenta cuántas entraron, cuántas con agrupador y cuáles quedaron sin él', async () => {
    conBase([existente({ code: '100', codigo_agrupador_sat: '101' })]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        xml: archivo([
          { numCta: '100', codAgrup: '101' },
          { numCta: '100-01', codAgrup: '101.01', subCtaDe: '100', nivel: 2 },
          { numCta: '100-02', codAgrup: '', subCtaDe: '100', nivel: 2 },
          { numCta: '100-03', codAgrup: '999', subCtaDe: '100', nivel: 2 },
        ]),
      }
    );

    expect(r.filasLeidas).toBe(4);
    expect(r.creadas).toEqual(['100-01', '100-02', '100-03']);
    expect(r.yaExistian.map((y) => y.code)).toEqual(['100']);
    expect(r.conAgrupadorValido).toBe(2);
    expect(r.sinAgrupadorValido).toEqual([
      { fila: 3, code: '100-02', codAgrup: '', motivo: 'ausente' },
      { fila: 4, code: '100-03', codAgrup: '999', motivo: 'fuera_de_catalogo' },
    ]);
    expect(r.rfc).toBe('AAA010101AAA');
    expect(r.anio).toBe('2026');
    expect(r.mes).toBe('01');
  });

  it('se rinde en texto con las cifras y las listas que el encargo pide', async () => {
    conBase([]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      {
        entityId: 'e1',
        userId: 'u1',
        parcial: true,
        xml: archivo([
          { numCta: '100', codAgrup: '101' },
          { numCta: 'Z', codAgrup: '' },
          { numCta: 'Y', codAgrup: '999' },
        ]),
      }
    );
    const texto = renderSatChartImportReport(r);
    expect(texto).toContain('RFC AAA010101AAA · ejercicio 2026-01');
    expect(texto).toContain('1 cuentas creadas');
    expect(texto).toContain('Sin agrupador válido:');
    // El vacío se enseña como «(vacío)» y el que sí trae código, con su código.
    expect(texto).toContain('fila 2 · Z · (vacío) · ausente');
    expect(texto).toContain('fila 3 · Y · 999 · fuera_de_catalogo');
    expect(texto).toContain('No entraron:');
    expect(texto).toContain('sin_tipo_deducible');
    expect(texto).toContain('Hallazgos:');
  });

  it('el ensayo lo dice en la primera pantalla, no en la letra pequeña', async () => {
    conBase([]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', userId: 'u1', dryRun: true, xml: archivo([{ numCta: '100', codAgrup: '101' }]) }
    );
    expect(renderSatChartImportReport(r)).toContain('NADA ESCRITO: es un ensayo');
  });

  it('y cuando se rehúsa escribir, también', async () => {
    conBase([]);
    conTransaccion();
    const r = await importSatChart(
      { tenantId: 't1' },
      { entityId: 'e1', userId: 'u1', xml: archivo([{ numCta: 'Z', codAgrup: '' }]) }
    );
    expect(renderSatChartImportReport(r)).toContain('NADA ESCRITO: ver los hallazgos');
  });
});
