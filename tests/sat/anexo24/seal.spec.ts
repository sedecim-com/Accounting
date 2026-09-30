import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verify, X509Certificate } from 'node:crypto';
import {
  construirCatalogoCuentas,
  type CuentaParaCatalogo,
} from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { construirBalanzaXml } from '../../../src/services/sat/anexo24/balanza-xml.js';
import type { CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { originalString, normalizeSpace } from '../../../src/services/sat/anexo24/original-string.js';
import {
  assertNoSeparatorInAttributes,
  assertSealableSource,
  sealAnexo24Xml,
  satCertificateNumber,
} from '../../../src/services/sat/anexo24/seal.js';
import { AppError } from '../../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../../helpers/official-xsd.js';

// ============================================================
// EFIRMA-4 (#442) · the cadena original by the SAT's vendored XSLT, and the
// seal. Synthetic self-signed fixtures only (invariant 7): efirma-sat-serial
// carries a serial written the way the SAT writes it.
// ============================================================

const DIR = path.join(__dirname, '../../fixtures/certs');
const MATERIAL = {
  cer: fs.readFileSync(`${DIR}/efirma-sat-serial.cer`),
  key: fs.readFileSync(`${DIR}/efirma-sat-serial.key`),
  password: 'test1234',
};

const account = (over: Partial<CuentaParaCatalogo> & { code: string }): CuentaParaCatalogo => ({
  name: `Cuenta ${over.code}`,
  account_level: 1,
  parent_code: null,
  codigo_agrupador_sat: '100',
  normal_balance: 'debit',
  account_type: 'asset',
  lineas_posteadas: 1,
  naturaleza_agrupador: null,
  estado_agrupador: 'valido',
  ...over,
});

const chartXml = (cashName = 'Caja y bancos'): string =>
  construirCatalogoCuentas({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: 2,
    cuentas: [
      account({ code: '1000', name: 'Activo' }),
      account({ code: '1110', name: cashName, account_level: 2, parent_code: '1000', codigo_agrupador_sat: '102.01' }),
      account({ code: '2110', name: 'Proveedores & Cía', codigo_agrupador_sat: '201', normal_balance: 'credit' }),
    ],
    politicas: { niveles: 'jerarquia_completa', sinAgrupador: 'bloquear', sellado: 'sellar_con_custodia' },
  }).xml!;

const row = (code: string, over: Partial<CuentaDeBalanza> = {}): CuentaDeBalanza => ({
  account_id: `id-${code}`,
  num_cta: code,
  natur: 'D',
  saldo_ini_mayor: '4500.0000',
  debe: '1300.0000',
  haber: '400.0000',
  saldo_fin_mayor: '5400.0000',
  codigo_agrupador: '102.01',
  natur_del_agrupador: 'D',
  ...over,
});

const balanceXml = (): string =>
  construirBalanzaXml({
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: '02',
    tipoEnvio: 'C',
    fechaModBal: '2026-03-15',
    cuentas: [row('1110'), row('2110', { natur: 'A', saldo_ini_mayor: '-3000.0000', debe: '1000.0000', haber: '0.0000', saldo_fin_mayor: '-2000.0000' })],
  });

const attribute = (xml: string, name: string): string => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
  expect(m, `missing ${name}`).not.toBeNull();
  return m![1]!;
};

describe('the cadena original, by the SAT stylesheet', () => {
  it('the catalog: header, then CodAgrup|NumCta|Desc|[SubCtaDe]|Nivel|Natur per account, entities decoded', () => {
    expect(originalString(chartXml(), 'catalogo')).toBe(
      '||1.3|AAA010101AAA|02|2026' +
        '|100|1000|Activo|1|D' +
        '|102.01|1110|Caja y bancos|1000|2|D' +
        '|201|2110|Proveedores & Cía|1|A||'
    );
  });

  it('the balance: TipoEnvio and the optional FechaModBal, then the four amounts per account', () => {
    expect(originalString(balanceXml(), 'balanza')).toBe(
      '||1.3|AAA010101AAA|02|2026|C|2026-03-15' +
        '|1110|4500.00|1300.00|400.00|5400.00' +
        '|2110|3000.00|1000.00|0.00|2000.00||'
    );
  });

  it('resolves the namespace, not the prefix: another prefix gives the same cadena', () => {
    const xml = chartXml();
    const prefix = /<(\w+):Catalogo/.exec(xml)![1]!;
    const renamed = xml.replaceAll(`${prefix}:`, 'otro:').replace(`xmlns:${prefix}=`, 'xmlns:otro=');
    expect(originalString(renamed, 'catalogo')).toBe(originalString(xml, 'catalogo'));
  });

  it('decodes a numeric character reference as the XSLT does, instead of signing it literally', () => {
    const xml = chartXml().replace('Desc="Activo"', 'Desc="Activo C&#237;a"');
    expect(originalString(xml, 'catalogo')).toContain('|1000|Activo Cía|1|D');
  });

  it('normalize-space trims and collapses the four XML whitespace characters', () => {
    expect(normalizeSpace(' \t a \r\n  b\n')).toBe('a b');
  });
});

describe('sealAnexo24Xml', () => {
  it.each([
    ['catalogo', 'chart', chartXml],
    ['balanza', 'trialBalance', balanceXml],
  ] as const)('%s: the seal verifies with the certificate and the result validates against the XSD', (doc, schema, build) => {
    const unsealed = build();
    const sealed = sealAnexo24Xml(unsealed, doc, MATERIAL);

    expect(validateAgainstOfficialXsd(sealed, schema)).toEqual({ valid: true, errors: [] });
    expect(attribute(sealed, 'noCertificado')).toBe('00001000000000000145');
    const cert = new X509Certificate(Buffer.from(attribute(sealed, 'Certificado'), 'base64'));
    expect(cert.raw.equals(MATERIAL.cer)).toBe(true);

    // The seal does not enter the cadena, so the verifier recomputes it from the sealed file.
    const chain = originalString(sealed, doc);
    expect(chain).toBe(originalString(unsealed, doc));
    const signature = Buffer.from(attribute(sealed, 'Sello'), 'base64');
    expect(verify('RSA-SHA256', Buffer.from(chain, 'utf8'), cert.publicKey, signature)).toBe(true);
    expect(verify('RSA-SHA256', Buffer.from(chain.replace('AAA010101AAA', 'AAA010101AAB')), cert.publicKey, signature)).toBe(false);
  });

  it('refuses to hand over a document the XSD rejects', () => {
    // The stylesheet reads it fine; only the XSD knows RFC is malformed.
    const invalid = chartXml().replace('RFC="AAA010101AAA"', 'RFC="NOT-AN-RFC"');
    expect(() => sealAnexo24Xml(invalid, 'catalogo', MATERIAL)).toThrow(/does not validate against the SAT's XSD/);
  });

  it('refuses a document that is already sealed', () => {
    const sealed = sealAnexo24Xml(chartXml(), 'catalogo', MATERIAL);
    expect(() => sealAnexo24Xml(sealed, 'catalogo', MATERIAL)).toThrow(/already sealed/);
  });
});

describe('satCertificateNumber', () => {
  it('reads the 20 digits of a SAT serial', () => {
    expect(satCertificateNumber(MATERIAL.cer)).toBe('00001000000000000145');
  });

  it('refuses a certificate whose serial is not a SAT certificate number, by key', () => {
    const refused = (() => {
      try {
        return satCertificateNumber(fs.readFileSync(`${DIR}/fiel.cer`));
      } catch (e) {
        return e;
      }
    })();
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe('VALIDATION_ERROR');
    expect((refused as AppError).messageKey?.key).toBe('anexo24.seal.not_sat_serial');
  });
});

describe('what is refused before the key is read', () => {
  const refusal = (fn: () => void): AppError => {
    try {
      fn();
    } catch (e) {
      return e as AppError;
    }
    throw new Error('it did not refuse');
  };

  it("an attribute with '|', the cadena separator, naming the account and the attribute", () => {
    const xml = chartXml('Caja | chica');
    const e = refusal(() => assertNoSeparatorInAttributes(xml));
    expect(e.messageKey).toEqual({
      key: 'anexo24.seal.separator_in_attribute',
      params: { element: 'Ctas', account: '1110', attribute: 'Desc', value: 'Caja | chica' },
    });
    expect(() => assertNoSeparatorInAttributes(chartXml())).not.toThrow();
  });

  it("a '|' written as a character reference is still a '|'", () => {
    const xml = chartXml().replace('Desc="Activo"', 'Desc="A&#124;B"');
    expect(refusal(() => assertNoSeparatorInAttributes(xml)).messageKey?.key).toBe('anexo24.seal.separator_in_attribute');
  });

  it('an unsealed source the XSD rejects; a valid unsealed source passes', () => {
    const invalid = chartXml().replace('RFC="AAA010101AAA"', 'RFC="NOT-AN-RFC"');
    expect(refusal(() => assertSealableSource(invalid, 'catalogo')).messageKey?.key).toBe('anexo24.seal.source_invalid');
    expect(() => assertSealableSource(chartXml(), 'catalogo')).not.toThrow();
    expect(() => assertSealableSource(balanceXml(), 'balanza')).not.toThrow();
  });
});
