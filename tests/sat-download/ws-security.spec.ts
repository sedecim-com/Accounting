import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { verify, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import {
  buildSignedAutentica,
  buildSignedRequest,
  wipeRsaPrivateKey,
  AUTENTICA_SOAP_ACTION,
} from '../../src/services/sat-download/ws-security.js';
import { decryptPrivateKey } from '../../src/services/fiscal-credentials/certificate.js';
import { satCode } from '../../src/services/sat-download/sat-codes.js';
import { satAcceptsSigned, SIMULATED_TOKEN } from './sat-simulator.js';

// Synthetic self-signed fixtures (tests/fixtures/certs/README.md); never a real e.firma.
const DIR = path.join(__dirname, '../fixtures/certs');
const MATERIAL = {
  cer: fs.readFileSync(`${DIR}/fiel.cer`),
  key: fs.readFileSync(`${DIR}/fiel.key`),
  password: 'test1234',
};
const CREATED = new Date('2026-09-29T12:00:00.000Z');
// SHA-1 (base64) of the exclusive-c14n Timestamp built for CREATED; see the c14n test below.
const TIMESTAMP_SHA1 = 'Q/DEkuZuh2NWf2/OIildS2l41F8=';

function between(xml: string, open: RegExp, close: string): string {
  const m = open.exec(xml);
  expect(m, `missing ${open.source}`).not.toBeNull();
  const end = xml.indexOf(close, m!.index);
  return xml.slice(m!.index, end + close.length);
}

function inner(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
  expect(m, `missing ${tag}`).not.toBeNull();
  return m![1];
}

describe('buildSignedAutentica', () => {
  const envelope = buildSignedAutentica(MATERIAL, { created: CREATED, tokenId: 'uuid-test-1' });

  it('signs the Timestamp so that the signature verifies with the certificate public key', () => {
    // The verifier here is independent of the signer: it takes the certificate
    // out of the BinarySecurityToken, checks the Timestamp digest and checks
    // SignatureValue over SignedInfo with node's crypto. The digest is the SHA-1
    // the SAT requires of this fixed Timestamp (created at CREATED, c14n form
    // asserted below), written as a constant so the test does not hash
    // envelope data with SHA-1 itself.
    const cert = new X509Certificate(Buffer.from(inner(envelope, 'o:BinarySecurityToken'), 'base64'));
    expect(cert.raw.equals(MATERIAL.cer)).toBe(true);

    const timestamp = between(envelope, /<u:Timestamp /, '</u:Timestamp>');
    const signedInfo = between(envelope, /<SignedInfo /, '</SignedInfo>');
    expect(timestamp).toContain('u:Id="_0"><u:Created>2026-09-29T12:00:00.000Z</u:Created>');
    expect(inner(signedInfo, 'DigestValue')).toBe(TIMESTAMP_SHA1);

    const signature = Buffer.from(inner(envelope, 'SignatureValue'), 'base64');
    expect(verify('RSA-SHA1', Buffer.from(signedInfo), cert.publicKey, signature)).toBe(true);
    expect(verify('RSA-SHA1', Buffer.from(signedInfo.replace('#_0', '#_1')), cert.publicKey, signature)).toBe(false);
  });

  it('writes the signed fragments in exclusive-c14n form with the algorithms the SAT requires', () => {
    const timestamp = between(envelope, /<u:Timestamp /, '</u:Timestamp>');
    expect(timestamp).toBe(
      '<u:Timestamp xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" u:Id="_0">' +
        '<u:Created>2026-09-29T12:00:00.000Z</u:Created><u:Expires>2026-09-29T12:05:00.000Z</u:Expires></u:Timestamp>'
    );
    // SignatureValue is RSA over these exact bytes, so SignedInfo must already
    // be in exclusive-c14n form (double-quoted attributes, explicit end tags,
    // no whitespace). Asserted whole: this string was checked once against a
    // general exc-c14n XML-DSig verifier (xml-crypto's SignedXml.checkSignature).
    const signedInfo = between(envelope, /<SignedInfo /, '</SignedInfo>');
    expect(signedInfo).toBe(
      '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">' +
        '<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod>' +
        '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>' +
        '<Reference URI="#_0"><Transforms>' +
        '<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms>' +
        '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>' +
        `<DigestValue>${TIMESTAMP_SHA1}</DigestValue></Reference></SignedInfo>`
    );
  });

  it('carries the certificate as an X509v3 BinarySecurityToken referenced from KeyInfo', () => {
    expect(envelope).toMatch(
      /<o:BinarySecurityToken u:Id="uuid-test-1" ValueType="[^"]+#X509v3" EncodingType="[^"]+#Base64Binary">/
    );
    expect(envelope).toContain('<o:Reference ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" URI="#uuid-test-1"/>');
    expect(envelope).toContain('<s:Body><Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/></s:Body>');
    expect(AUTENTICA_SOAP_ACTION).toBe('http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica');
  });

  it('accepts a PEM certificate and still sends DER in the token', () => {
    const pem = forge.pki.certificateToPem(
      forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(new Uint8Array(MATERIAL.cer))))
    );
    const fromPem = buildSignedAutentica({ ...MATERIAL, cer: Buffer.from(pem) }, { created: CREATED, tokenId: 'x' });
    expect(inner(fromPem, 'o:BinarySecurityToken')).toBe(MATERIAL.cer.toString('base64'));
  });

  it('refuses to sign with a wrong password', () => {
    expect(() => buildSignedAutentica({ ...MATERIAL, password: 'wrong' }, { created: CREATED, tokenId: 'x' })).toThrow(
      /password is incorrect/
    );
  });
});

describe('wipeRsaPrivateKey', () => {
  it('leaves no private component of the decrypted key readable', () => {
    const key = decryptPrivateKey(MATERIAL.key, MATERIAL.password);
    expect(key.d.toString(16)).not.toBe('0');
    wipeRsaPrivateKey(key);
    for (const part of [key.d, key.p, key.q, key.dP, key.dQ, key.qInv]) {
      expect(part.toString(16)).toBe('0');
    }
  });
});

describe('buildSignedRequest (EFIRMA-2)', () => {
  const body = buildSignedRequest(MATERIAL, 'SolicitaDescargaEmitidos', 'solicitud', {
    TipoSolicitud: 'CFDI',
    RfcSolicitante: 'AAA010101AAA',
    RfcEmisor: 'AAA010101AAA',
    FechaInicial: '2026-01-01T00:00:00',
    FechaFinal: '2026-01-31T23:59:59',
    EstadoComprobante: undefined,
  });
  const envelope = (b: string) => `<s:Envelope><s:Body>${b}</s:Body></s:Envelope>`;
  const token = `WRAP access_token="${SIMULATED_TOKEN}"`;

  it('writes the attributes in alphabetical order and leaves out the empty ones, as the SAT requires', () => {
    expect(body).toContain(
      '<des:solicitud FechaFinal="2026-01-31T23:59:59" FechaInicial="2026-01-01T00:00:00" ' +
        'RfcEmisor="AAA010101AAA" RfcSolicitante="AAA010101AAA" TipoSolicitud="CFDI"><Signature '
    );
  });

  it('carries an enveloped signature the SAT verifies, with the certificate serial in decimal', () => {
    expect(satAcceptsSigned(envelope(body), token)).toBe(true);
    expect(inner(body, 'X509SerialNumber')).toBe(BigInt(`0x${new X509Certificate(MATERIAL.cer).serialNumber}`).toString());
    expect(satAcceptsSigned(envelope(body.replace('TipoSolicitud="CFDI"', 'TipoSolicitud="Metadata"')), token)).toBe(false);
    expect(satAcceptsSigned(envelope(body), 'WRAP access_token="other"')).toBe(false);
  });
});

describe('satCode', () => {
  it('reads 5004 as success with zero rows and an unknown code as ambiguous', () => {
    expect(satCode('5004')).toMatchObject({ outcome: 'empty' });
    expect(satCode('5002')).toMatchObject({ outcome: 'error', retry: 'permanent_quota' });
    expect(satCode('9999')).toMatchObject({ key: 'sat_download.unknown_code', retry: 'ambiguous' });
  });
});
