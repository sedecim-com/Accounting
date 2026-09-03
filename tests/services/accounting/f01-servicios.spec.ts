import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  // G3: `setAccountGovernance` audita, y `tenantDe` pregunta primero por el
  // inquilino del CONTEXTO.
  currentTenant: vi.fn(() => 'tenant-1'),
}));

import {
  resolverEsquema,
  setAccountGovernance,
} from '../../../src/services/accounting/account-service.js';
import { parseGovernancePairs, parseMappingCsv } from '../../../src/cli/account-command.js';
import { assertRolConocido, rolesValidos } from '../../../src/services/accounting/account-roles-service.js';
import {
  parseImportFile,
  parseNdjson,
  parseCsvEntradas,
  assertLayoutSoportado,
} from '../../../src/services/accounting/entry-import-service.js';
import { query, withTransaction } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;

beforeEach(() => {
  mockQuery.mockReset();
  mockTx.mockReset();
  // El cuerpo de la transacción corre contra un cliente cuyo query() es el
  // MISMO mock, para que las secuencias sigan viendo las sentencias en orden.
  mockTx.mockImplementation((fn: (c: { query: unknown }) => unknown) => fn({ query: mockQuery }));
});

describe('parseGovernancePairs — vocabulario cerrado, valores estrictos', () => {
  it('traduce las claves del CLI a columnas y exige true/false literales', () => {
    expect(parseGovernancePairs(['allow-manual=false', 'header=true'])).toEqual({
      allow_manual_entries: false,
      is_header: true,
    });
    expect(() => parseGovernancePairs(['header=yes'])).toThrow(/true o false/);
    expect(() => parseGovernancePairs(['desconocida=true'])).toThrow(/Clave desconocida/);
    expect(() => parseGovernancePairs(['sin-igual'])).toThrow(/clave=valor/);
  });

  it('currency= vacío limpia; el código se normaliza a mayúsculas', () => {
    expect(parseGovernancePairs(['currency='])).toEqual({ currency_code: null });
    expect(parseGovernancePairs(['currency=usd'])).toEqual({ currency_code: 'USD' });
  });
});

describe('setAccountGovernance — el CHECK de la 001, antes del UPDATE', () => {
  it('rechaza header=true con allow-manual heredado en true (estado RESULTANTE)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', is_header: false, allow_manual_entries: true }],
    });
    await expect(
      setAccountGovernance('a1', { is_header: true }, 'u1')
    ).rejects.toThrow(/agrupadora/);
    expect(mockQuery.mock.calls).toHaveLength(1); // nada se escribió
  });

  it('acepta la pareja coherente y escribe solo las claves dadas', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', entity_id: 'e-1', is_header: false, allow_manual_entries: true }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', is_header: true, allow_manual_entries: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // G3: el INSERT del rastro
    await setAccountGovernance('a1', { is_header: true, allow_manual_entries: false }, 'u1');
    const [sql] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/is_header = \$1/);
    expect(sql).toMatch(/allow_manual_entries = \$2/);
    expect(sql).not.toMatch(/is_control_account/);
  });

  // G3: las banderas de gobierno son la PUERTA del posteo —quién puede
  // escribir en esta cuenta y si el mayor la considera control de un
  // subdiario—. Cambiarlas sin dejar quién es lo que hace irrebatible un
  // asiento discutido.
  it('deja rastro con el antes y el después de las banderas tocadas', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', entity_id: 'e-1', is_header: false, allow_manual_entries: true }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', allow_manual_entries: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await setAccountGovernance('a1', { allow_manual_entries: false }, 'u1', 'se postea sólo por regla');

    const [sqlRastro, paramsRastro] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(sqlRastro).toMatch(/INSERT INTO audit_log/);
    expect(paramsRastro[1]).toBe('u1');
    expect(paramsRastro[4]).toBe('account');
    expect(JSON.parse(String(paramsRastro[6]))).toEqual({ allow_manual_entries: true });
    expect(JSON.parse(String(paramsRastro[7]))).toEqual({ allow_manual_entries: false });
    expect(paramsRastro[8]).toBe('se postea sólo por regla');
  });

  // La validación cae DENTRO de la transacción: ni la cuenta cambia ni la
  // bitácora crece.
  it('una pareja rechazada no deja rastro', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', entity_id: 'e-1', is_header: false, allow_manual_entries: true }],
    });
    await expect(setAccountGovernance('a1', { is_header: true }, 'u1')).rejects.toThrow(/agrupadora/);
    expect(mockQuery.mock.calls).toHaveLength(1);
  });
});

describe('resolverEsquema — sin columna se rechaza, no se finge', () => {
  it('mapea los esquemas con columna y rechaza el resto con mensajes distintos', () => {
    // F07a: el agrupador se mudó a su propia columna con la 063. Antes esto
    // decía mx_nif_code, que es el código de PRESENTACIÓN bajo NIF.
    expect(resolverEsquema('sat-agrupador')).toBe('codigo_agrupador_sat');
    expect(resolverEsquema('us-tax-line')).toBe('us_gaap_code');
    expect(() => resolverEsquema('fs-line')).toThrow(/aún no tiene columna/);
    expect(() => resolverEsquema('marciano')).toThrow(/Esquema desconocido/);
  });
});

describe('parseMappingCsv', () => {
  it('lee pares código,valor con encabezado opcional y separador coma o punto y coma', () => {
    const csv = 'code,valor\n6100,601.84\n1110;102.01\n"1120","105.01"\n';
    expect(parseMappingCsv(csv)).toEqual([
      { code: '6100', value: '601.84' },
      { code: '1110', value: '102.01' },
      { code: '1120', value: '105.01' },
    ]);
  });

  it('la primera línea con dígitos NO es encabezado: no se pierde la primera cuenta', () => {
    expect(parseMappingCsv('6100,601.84\n')).toEqual([{ code: '6100', value: '601.84' }]);
  });
});

describe('roles contables — el vocabulario es ROLE_MAP', () => {
  it('acepta los roles del mapa y rechaza inventos listando los válidos', () => {
    expect(() => assertRolConocido('banco')).not.toThrow();
    expect(() => assertRolConocido('rol_inventado')).toThrow(/Válidos:/);
    expect(rolesValidos()).toContain('iva_pendiente_acreditar');
  });
});

describe('entry import — parsers del lote (045)', () => {
  it('los layouts propietarios se rechazan con mensaje, no se fingen', () => {
    expect(() => assertLayoutSoportado('contpaqi')).toThrow(/aún no está soportado/);
    expect(() => assertLayoutSoportado('xml-magico')).toThrow(/Layout desconocido/);
    expect(() => assertLayoutSoportado('csv')).not.toThrow();
  });

  it('ndjson: una póliza por línea; la ilegible queda con su error, no se descarta', () => {
    const lote = parseNdjson(
      '{"date":"2026-08-20","description":"ok","lines":[{"account":"6100","debit":"100"},{"account":"1110","credit":"100"}]}\n' +
        'esto no es json\n' +
        '{"date":"2026-08-21","lines":[{"account":"6100","debit":"50"}]}\n'
    );
    expect(lote.validas).toBe(1);
    expect(lote.invalidas).toBe(2);
    expect(lote.filas[1].parse_error).toMatch(/JSON ilegible/);
    expect(lote.filas[2].parse_error).toMatch(/dos líneas/);
  });

  it('csv: agrupa renglones por clave y detecta fechas mezcladas y lados dobles', () => {
    const lote = parseCsvEntradas(
      'entry_key,entry_date,description,account_code,debit,credit\n' +
        'A1,2026-08-20,Gasto,6100,500.00,\n' +
        'A1,2026-08-20,Gasto,1110,,500.00\n' +
        'B1,2026-08-21,Raro,6100,100.00,100.00\n' +
        'B1,2026-08-21,Raro,1110,,100.00\n'
    );
    expect(lote.validas).toBe(1);
    expect(lote.invalidas).toBe(1);
    expect(lote.filas[0].payload).toMatchObject({ entry_key: 'A1', date: '2026-08-20' });
    expect(lote.filas[1].parse_error).toMatch(/exactamente un lado/);
  });

  it('parseImportFile enruta por layout y valida el layout ANTES de leer nada', () => {
    expect(() => parseImportFile('aspel', 'lo que sea')).toThrow(/aún no está soportado/);
    expect(parseImportFile('ndjson', '').filas).toEqual([]);
  });
});
