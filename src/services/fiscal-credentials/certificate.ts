import forge from 'node-forge';

// ============================================================
// SAT CREDENTIAL PARSING (.cer + .key in DER)
//
// node-forge is used and NOT native crypto, for two reasons
// discovered by testing with real certificates:
//   1. crypto.X509Certificate.keyUsage returns undefined on Node 22,
//      so it cannot distinguish an e.firma from a CSD.
//   2. SAT keys come as PKCS#8 encrypted with
//      pbeWithSHAAnd3-KeyTripleDES-CBC. OpenSSL 3 treats it as legacy
//      and crypto.createPrivateKey fails with
//      "digital envelope routines::unsupported".
//      node-forge decrypts it in pure JS, independent of the provider.
// ============================================================

export interface CertificateInfo {
  rfc: string;
  serial: string;
  subject: string;
  validFrom: Date;
  validTo: Date;
  /**
   * e.firma vs CSD via keyUsage: the e.firma can encrypt
   * (dataEncipherment/keyEncipherment); the CSD only signs. It is the
   * real functional difference, verifiable from the certificate.
   * The final authority is the SAT: a CSD would be rejected by the
   * bulk download service.
   */
  type: 'efirma' | 'csd' | 'unknown';
}

export class CertificateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateParseError';
  }
}

function toForgeCert(cer: Buffer): forge.pki.Certificate {
  try {
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(new Uint8Array(cer))));
  } catch (derErr) {
    // Tolerate PEM in case the user converted the file.
    try {
      return forge.pki.certificateFromPem(cer.toString('utf-8'));
    } catch {
      throw new CertificateParseError(
        `The file is not a valid X.509 certificate (the SAT .cer in DER format is expected): ` +
          `${(derErr as Error).message}`
      );
    }
  }
}

export function parseCertificate(cer: Buffer): CertificateInfo {
  const cert = toForgeCert(cer);

  const subject = cert.subject.attributes
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value)}`)
    .join(' | ');

  const rfc = extractRfc(subject);
  if (!rfc) {
    throw new CertificateParseError(`No RFC was found in the certificate. Subject: ${subject}`);
  }

  return {
    rfc,
    serial: cert.serialNumber,
    subject,
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    type: classify(cert),
  };
}

/**
 * The RFC lives in the subject, usually in x500UniqueIdentifier
 * (legal entity: "RFC / representative's CURP") and sometimes in the CN.
 */
function extractRfc(subject: string): string | null {
  const m = subject.match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  return m ? m[1] : null;
}

function classify(cert: forge.pki.Certificate): CertificateInfo['type'] {
  const ku = cert.getExtension('keyUsage') as unknown as
    | { dataEncipherment?: boolean; keyEncipherment?: boolean }
    | undefined;
  if (!ku) return 'unknown';
  return ku.dataEncipherment || ku.keyEncipherment ? 'efirma' : 'csd';
}

export interface EfirmaMaterial {
  cer: Buffer;
  key: Buffer;
  password: string;
}

/**
 * Verifies that the private key matches the certificate and that the
 * password is correct. A failure here is reported to the user BEFORE
 * anything is transmitted.
 */
export function verifyKeyPair(cer: Buffer, keyDer: Buffer, password: string): boolean {
  try {
    const cert = toForgeCert(cer);
    const priv = decryptPrivateKey(keyDer, password);
    const pub = cert.publicKey as forge.pki.rsa.PublicKey;
    // Same RSA modulus ⇒ the pair matches.
    return pub.n.equals(priv.n);
  } catch {
    return false;
  }
}

/** Decrypts the SAT PKCS#8 key. Throws if the password is incorrect. */
export function decryptPrivateKey(keyDer: Buffer, password: string): forge.pki.rsa.PrivateKey {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(new Uint8Array(keyDer)));
  const info = forge.pki.decryptPrivateKeyInfo(asn1, password);
  if (!info) {
    throw new CertificateParseError(
      'Could not decrypt the private key: the password is incorrect or the format is not the SAT .key.'
    );
  }
  return forge.pki.privateKeyFromAsn1(info) as forge.pki.rsa.PrivateKey;
}

/** Key as PEM, ready for signing (XML-DSig of the SAT token). */
export function privateKeyToPem(keyDer: Buffer, password: string): string {
  return forge.pki.privateKeyToPem(decryptPrivateKey(keyDer, password));
}

/**
 * Serializes the material for the vault. JSON with base64: Secrets
 * Manager stores an opaque blob and the result (~6 KB) stays well
 * below the 64 KB limit.
 */
export function serializeMaterial(m: EfirmaMaterial): Buffer {
  return Buffer.from(
    JSON.stringify({
      cer: m.cer.toString('base64'),
      key: m.key.toString('base64'),
      password: m.password,
    }),
    'utf-8'
  );
}

export function deserializeMaterial(blob: Buffer): EfirmaMaterial {
  const p = JSON.parse(blob.toString('utf-8')) as { cer: string; key: string; password: string };
  return {
    cer: Buffer.from(p.cer, 'base64'),
    key: Buffer.from(p.key, 'base64'),
    password: p.password,
  };
}
