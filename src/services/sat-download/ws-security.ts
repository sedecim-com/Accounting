import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { decryptPrivateKey, type EfirmaMaterial } from '../fiscal-credentials/certificate.js';

// ============================================================
// EFIRMA-1 (#439) · THE SIGNED `Autentica` ENVELOPE
//
// CONTRACT: SAT Descarga Masiva web service, authentication (service v1.5,
// in force since 2025-05-29), endpoint
// https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc,
// action http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica.
// The SAT's «Documentación para la implementación del Servicio Web de
// Descarga Masiva de CFDI y Retenciones» (material adicional at
// https://www.sat.gob.mx, consulted 2026-09-29) fixes the WS-Security header:
// a u:Timestamp (Id "_0") signed with XML-DSig, Exclusive XML Canonicalization
// 1.0 without comments (http://www.w3.org/2001/10/xml-exc-c14n#) for both the
// reference transform and SignedInfo, SHA-1 digest and RSA-SHA1 signature, and
// the e.firma certificate as an X509v3 BinarySecurityToken referenced from
// KeyInfo. The same algorithms are what the reference client
// phpcfdi/sat-ws-descarga-masiva (FielRequestBuilder) sends.
//
// NOTE: no XML-DSig dependency. The envelope is fixed, so the two signed
// fragments are WRITTEN in their exclusive-c14n form (namespace declaration
// on the apex, attributes in canonical order, no whitespace, explicit end
// tags) and sit in the envelope byte for byte. Exclusive c14n of an element
// that already declares every prefix it uses is the element itself, so the
// bytes hashed here are the bytes a verifier recomputes. The unit test checks
// the signature against the certificate's public key from the envelope.
// ============================================================

const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const NS_WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const X509V3 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const BASE64_BINARY =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export const AUTENTICA_SOAP_ACTION = 'http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica';

/** How long the signed Timestamp asks the SAT to honour the request. */
export const TIMESTAMP_LIFETIME_MS = 5 * 60_000;

export interface AutenticaEnvelopeOptions {
  created: Date;
  /** wsu:Id of the BinarySecurityToken; a fresh UUID per request. */
  tokenId: string;
}

function certificateBase64(cer: Buffer): string {
  // storeCredential tolerates a PEM certificate; the token carries DER.
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(cer.toString('latin1'));
  return pem ? pem[1].replace(/\s+/g, '') : cer.toString('base64');
}

function canonicalTimestamp(created: Date): string {
  const expires = new Date(created.getTime() + TIMESTAMP_LIFETIME_MS);
  return (
    `<u:Timestamp xmlns:u="${NS_WSU}" u:Id="_0">` +
    `<u:Created>${created.toISOString()}</u:Created>` +
    `<u:Expires>${expires.toISOString()}</u:Expires>` +
    '</u:Timestamp>'
  );
}

function canonicalSignedInfo(digest: string): string {
  return (
    `<SignedInfo xmlns="${NS_DSIG}">` +
    `<CanonicalizationMethod Algorithm="${EXC_C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${NS_DSIG}rsa-sha1"></SignatureMethod>` +
    '<Reference URI="#_0">' +
    `<Transforms><Transform Algorithm="${EXC_C14N}"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${NS_DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    '</Reference>' +
    '</SignedInfo>'
  );
}

type WipeableBigInteger = { t: number; s: number; [word: number]: number };

/**
 * SECURITY: overwrites the private parts of a decrypted forge RSA key. The
 * vault buffers are zeroized by withCredential; this is the decrypted key
 * derived from them, which lives only inside buildSignedAutentica.
 */
export function wipeRsaPrivateKey(key: forge.pki.rsa.PrivateKey): void {
  for (const part of [key.d, key.p, key.q, key.dP, key.dQ, key.qInv]) {
    const big = part as unknown as WipeableBigInteger;
    for (let i = 0; i < big.t; i++) big[i] = 0;
    big.t = 0;
    big.s = 0;
  }
}

/**
 * Builds the `Autentica` request signed with the e.firma. Call it only
 * inside withCredential: `material` is the decrypted vault content.
 */
export function buildSignedAutentica(material: EfirmaMaterial, opts: AutenticaEnvelopeOptions): string {
  const timestamp = canonicalTimestamp(opts.created);
  const digest = createHash('sha1').update(timestamp, 'utf8').digest('base64');
  const signedInfo = canonicalSignedInfo(digest);

  const key = decryptPrivateKey(material.key, material.password);
  let signature: string;
  try {
    const md = forge.md.sha1.create();
    md.update(signedInfo, 'utf8');
    signature = forge.util.encode64(key.sign(md));
  } finally {
    wipeRsaPrivateKey(key);
  }

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<s:Envelope xmlns:s="${NS_SOAP}" xmlns:u="${NS_WSU}">` +
    '<s:Header>' +
    `<o:Security xmlns:o="${NS_WSSE}" s:mustUnderstand="1">` +
    timestamp +
    `<o:BinarySecurityToken u:Id="${opts.tokenId}" ValueType="${X509V3}" EncodingType="${BASE64_BINARY}">` +
    certificateBase64(material.cer) +
    '</o:BinarySecurityToken>' +
    `<Signature xmlns="${NS_DSIG}">` +
    signedInfo +
    `<SignatureValue>${signature}</SignatureValue>` +
    '<KeyInfo><o:SecurityTokenReference>' +
    `<o:Reference ValueType="${X509V3}" URI="#${opts.tokenId}"/>` +
    '</o:SecurityTokenReference></KeyInfo>' +
    '</Signature>' +
    '</o:Security>' +
    '</s:Header>' +
    '<s:Body><Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/></s:Body>' +
    '</s:Envelope>'
  );
}
