import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseCertificate,
  verifyKeyPair,
  decryptPrivateKey,
  privateKeyToPem,
  serializeMaterial,
  deserializeMaterial,
  CertificateParseError,
} from '../../src/services/fiscal-credentials/certificate.js';

// Fixtures generated with openssl using the SAME PKCS#8 encryption
// the SAT delivers (PBE-SHA1-3DES) and a different keyUsage in each case.
const DIR = path.join(__dirname, '../fixtures/certs');
const PASSWORD = 'test1234';
const fiel = { cer: fs.readFileSync(`${DIR}/fiel.cer`), key: fs.readFileSync(`${DIR}/fiel.key`) };
const csd = { cer: fs.readFileSync(`${DIR}/csd.cer`), key: fs.readFileSync(`${DIR}/csd.key`) };

describe('parseCertificate', () => {
  it('classifies the e.firma by keyUsage (it can encrypt)', () => {
    const info = parseCertificate(fiel.cer);
    expect(info.type).toBe('efirma');
    expect(info.rfc).toBe('AAA010101AAA');
    expect(info.serial).toBeTruthy();
    expect(info.validTo.getTime()).toBeGreaterThan(Date.now());
  });

  it('classifies the CSD by keyUsage (it only signs)', () => {
    expect(parseCertificate(csd.cer).type).toBe('csd');
  });

  it('extracts the RFC from the x500UniqueIdentifier with RFC / CURP', () => {
    // Legal entity: the field carries "RFC / legal representative's CURP"
    const info = parseCertificate(fiel.cer);
    expect(info.subject).toMatch(/AAAA010101HDFAAA01/); // the CURP is in the subject
    expect(info.rfc).toBe('AAA010101AAA');              // but the RFC is what gets extracted
  });

  it('rejects a file that is not a certificate', () => {
    expect(() => parseCertificate(Buffer.from('this is not a cer'))).toThrow(CertificateParseError);
  });
});

describe('decryptPrivateKey', () => {
  it('decrypts PKCS#8 with PBE-SHA1-3DES (the SAT format)', () => {
    // Node crypto fails with "digital envelope routines::unsupported"
    // on this format; node-forge handles it.
    expect(() => decryptPrivateKey(fiel.key, PASSWORD)).not.toThrow();
  });

  it('throws on an incorrect password', () => {
    expect(() => decryptPrivateKey(fiel.key, 'wrong-password')).toThrow(/password is incorrect/);
  });

  it('exports to PEM for signing (XML-DSig of the SAT token)', () => {
    const pem = privateKeyToPem(fiel.key, PASSWORD);
    expect(pem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
  });
});

describe('verifyKeyPair', () => {
  it('accepts the correct pair', () => {
    expect(verifyKeyPair(fiel.cer, fiel.key, PASSWORD)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    expect(verifyKeyPair(fiel.cer, fiel.key, 'wrong-password')).toBe(false);
  });

  it('rejects a key that does not match the certificate', () => {
    // Cross the FIEL cert with the CSD key
    expect(verifyKeyPair(fiel.cer, csd.key, PASSWORD)).toBe(false);
  });
});

describe('serializeMaterial', () => {
  it('round-trips without loss and stays well below the 64 KB limit', () => {
    const material = { cer: fiel.cer, key: fiel.key, password: PASSWORD };
    const blob = serializeMaterial(material);
    expect(blob.byteLength).toBeLessThan(65_536);
    const back = deserializeMaterial(blob);
    expect(back.cer.equals(fiel.cer)).toBe(true);
    expect(back.key.equals(fiel.key)).toBe(true);
    expect(back.password).toBe(PASSWORD);
  });
});
