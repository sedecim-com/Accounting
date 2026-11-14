import forge from 'node-forge';
import { query } from '../../../database/connection.js';
import { AppError, ValidationError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import { withCredential } from '../../fiscal-credentials/service.js';
import {
  decryptPrivateKey,
  parseCertificate,
  type EfirmaMaterial,
} from '../../fiscal-credentials/certificate.js';
import { certificateBase64, wipeRsaPrivateKey } from '../../sat-download/ws-security.js';
import { archivarArtefacto, type ArtefactoArchivado } from './artefactos.js';
import { documentElements, originalString, type SealableDocument } from './original-string.js';
import { validateAgainstOfficialXsd, type OfficialSchema } from './official-xsd.js';

// ============================================================
// EFIRMA-4 (#442) · THE ANEXO 24 CATALOG AND TRIAL BALANCE, SEALED
//
// Only under `efirma_sellado_contabilidad_electronica = sellar_con_custodia`.
// Under any other value the seal is refused BEFORE the credential is looked
// up: no decryption, no access-log row. The panel's default does not change
// here (nunca_sellar_en_el_sistema); a firm opts in.
//
// CONTRACT: Anexo 24, «Generación de sellos digitales para contabilidad
// electrónica»: the cadena original is what the SAT's XSLT produces (see
// original-string.ts), digested with SHA-256 and signed with RSA
// (RSASSA-PKCS1-v1_5), base64 in `Sello`; `noCertificado` is the 20-digit
// serial of the certificate; `Certificado` is the certificate, base64. The
// sealed document must validate against the vendored XSD or it is not handed
// over.
//
// SECURITY: the key is read ONLY inside withCredential, with purpose
// 'seal_anexo24'. That writes the access-log row (success or error) and
// applies the daily cap, the panel ceiling and efirma_accion_anomalia before
// the key is decrypted. The decrypted forge key is wiped after signing.
//
// What is sealed is the ARCHIVED document the accountant generated and
// reviewed, not a rebuild: the unsealed row of the period that was generated
// LAST (last_generated_at, migration 172, which regenerating identical bytes
// also moves), and its hash is printed in the receipt. The sealed copy is
// archived as its own row (sellado = true) pointing at the one it seals.
//
// Everything that can be refused without the key is refused BEFORE
// withCredential, so a broken setup or a bad source costs no decryption and
// none of the daily accesses: the source must validate against the XSD (Sello,
// noCertificado and Certificado are optional there, so an unsealed file
// validates, and this also proves xmllint runs) and no attribute may carry
// '|', the cadena's separator (Anexo 24, «Generación de sellos digitales»). Nothing is filed with the
// SAT: there is no public web service for it, and the upload stays in the
// SAT portal, done by a person.
// ============================================================

export const SEAL_POLICY = 'efirma_sellado_contabilidad_electronica';
export const SEAL_POLICY_OPT_IN = 'sellar_con_custodia';

const SCHEMA_OF: Record<SealableDocument, OfficialSchema> = { catalogo: 'chart', balanza: 'trialBalance' };

/**
 * `noCertificado`: the SAT writes the serial of its certificates as the hex
 * of 20 ASCII digits. A certificate whose serial does not read that way is
 * not one the SAT issued, and the XSD would reject it anyway.
 */
export function satCertificateNumber(cer: Buffer): string {
  const hex = parseCertificate(cer).serial;
  const digits = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex').toString('latin1');
  if (!/^\d{20}$/.test(digits)) {
    throw new AppError(422, 'VALIDATION_ERROR', { key: 'anexo24.seal.not_sat_serial', params: { serial: hex } });
  }
  return digits;
}

/** Inserts the three attributes in the root start tag. Base64 and digits need no escaping. */
function withSealAttributes(xml: string, attrs: string): string {
  const start = /<(?![?!])[^>]*?(\/?)>/.exec(xml);
  if (!start) throw new ValidationError('The document has no root element to seal.');
  if (/\sSello="/.test(start[0])) throw new ValidationError('The document is already sealed.');
  const at = start.index + start[0].length - 1 - start[1].length;
  return `${xml.slice(0, at)} ${attrs}${xml.slice(at)}`;
}

/**
 * Seals an unsealed Anexo 24 document. Call it only inside withCredential:
 * `material` is the decrypted vault content.
 */
export function sealAnexo24Xml(xml: string, document: SealableDocument, material: EfirmaMaterial): string {
  const chain = originalString(xml, document);
  const key = decryptPrivateKey(material.key, material.password);
  let signature: string;
  try {
    const md = forge.md.sha256.create();
    md.update(chain, 'utf8');
    signature = forge.util.encode64(key.sign(md));
  } finally {
    wipeRsaPrivateKey(key);
  }
  const sealed = withSealAttributes(
    xml,
    `Sello="${signature}" noCertificado="${satCertificateNumber(material.cer)}" ` +
      `Certificado="${certificateBase64(material.cer)}"`
  );
  const verdict = validateAgainstOfficialXsd(sealed, SCHEMA_OF[document]);
  if (!verdict.valid) {
    throw new ValidationError(
      `The sealed document does not validate against the SAT's XSD, so it is not handed over: ${verdict.errors.join('; ')}`
    );
  }
  return sealed;
}

export interface SealRequest {
  tenantId: string;
  entityId: string;
  document: SealableDocument;
  year: number;
  /** 1–12, or 13 for the year-end balance. */
  month: number;
  envelopeType: 'N' | 'C';
  /** Who asks; it is what the access log records. */
  actor: string;
  userId: string;
  requestId?: string;
}

export interface SealedDocument {
  xml: string;
  sealedFrom: string;
  /** SHA-256 of the unsealed source: the hash `generate` printed for it. */
  sourceHash: string;
  certificateNumber: string;
  artifact: ArtefactoArchivado;
}

/** The refusal under any value but sellar_con_custodia: said by key, before any credential is read. */
export class SealRefusedByPolicy extends AppError {
  constructor(value: string) {
    super(403, 'SEAL_REFUSED_BY_POLICY', {
      key: 'anexo24.seal.refused_by_policy',
      params: { policy: SEAL_POLICY, value, optIn: SEAL_POLICY_OPT_IN },
    });
    this.name = 'SealRefusedByPolicy';
  }
}

/**
 * Refuses a document with '|' in any attribute: it is the separator of the
 * cadena original, so the SAT's own rule forbids it, and a seal over such a
 * cadena signs something that does not read one way only.
 */
export function assertNoSeparatorInAttributes(xml: string): void {
  for (const el of documentElements(xml)) {
    for (const [attribute, value] of Object.entries(el.attrs)) {
      if (value.includes('|')) {
        throw new AppError(422, 'VALIDATION_ERROR', {
          key: 'anexo24.seal.separator_in_attribute',
          params: { element: el.name, account: el.attrs.NumCta ?? '-', attribute, value },
        });
      }
    }
  }
}

/** The checks that need no key. Throws on the first failure. */
export function assertSealableSource(xml: string, document: SealableDocument): void {
  assertNoSeparatorInAttributes(xml);
  const verdict = validateAgainstOfficialXsd(xml, SCHEMA_OF[document]);
  if (!verdict.valid) {
    throw new AppError(422, 'VALIDATION_ERROR', {
      key: 'anexo24.seal.source_invalid',
      params: { errors: verdict.errors.join('; ') },
    });
  }
}

/** Seals the archived, unsealed document of the period generated last, and archives the sealed copy. */
export async function sealArchivedDocument(req: SealRequest): Promise<SealedDocument> {
  const policy = (await getPolicy({ tenantId: req.tenantId, entityId: req.entityId }, SEAL_POLICY)).value;
  if (policy !== SEAL_POLICY_OPT_IN) throw new SealRefusedByPolicy(policy);

  const found = await query<{ id: string; xml: string; rfc: string; version: string; hash_sha256: string }>(
    `SELECT id, xml, rfc, version, hash_sha256 FROM sat_anexo24_artefactos
      WHERE entity_id = $1 AND tenant_id = $2 AND tipo = $3 AND anio = $4 AND mes = $5
        AND tipo_envio = $6 AND sellado = false
      ORDER BY last_generated_at DESC, generado_en DESC LIMIT 1`,
    [req.entityId, req.tenantId, req.document, req.year, req.month, req.envelopeType]
  );
  const source = found.rows[0];
  if (!source) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', {
      key: 'anexo24.seal.not_archived',
      params: { document: req.document, period: `${req.year}-${String(req.month).padStart(2, '0')}` },
    });
  }
  assertSealableSource(source.xml, req.document);

  let certificateNumber = '';
  const xml = await withCredential(
    req.entityId,
    req.tenantId,
    { purpose: 'seal_anexo24', actor: req.actor, unattended: false, requestId: req.requestId },
    async (material) => {
      const rfc = parseCertificate(material.cer).rfc;
      if (rfc.toUpperCase() !== source.rfc.toUpperCase()) {
        throw new AppError(422, 'VALIDATION_ERROR', {
          key: 'anexo24.seal.rfc_mismatch',
          params: { certificateRfc: rfc, documentRfc: source.rfc },
        });
      }
      certificateNumber = satCertificateNumber(material.cer);
      return sealAnexo24Xml(source.xml, req.document, material);
    }
  );

  const artifact = await archivarArtefacto({
    tenantId: req.tenantId,
    entityId: req.entityId,
    tipo: req.document,
    version: source.version,
    rfc: source.rfc,
    anio: req.year,
    mes: req.month,
    tipoEnvio: req.envelopeType,
    xml,
    politicaSellado: policy,
    hallazgos: [],
    generadoPor: req.userId,
    sealedFrom: source.id,
  });
  return { xml, sealedFrom: source.id, sourceHash: source.hash_sha256, certificateNumber, artifact };
}

/** Whether the unsealed document with these bytes has a sealed copy archived. */
export async function hasSealedCopy(
  tenantId: string,
  entityId: string,
  document: SealableDocument,
  hash: string
): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM sat_anexo24_artefactos sealed
       JOIN sat_anexo24_artefactos source ON source.id = sealed.sealed_from AND source.entity_id = sealed.entity_id
      WHERE sealed.tenant_id = $1 AND sealed.entity_id = $2 AND sealed.tipo = $3 AND sealed.sellado
        AND source.hash_sha256 = $4
      LIMIT 1`,
    [tenantId, entityId, document, hash]
  );
  return r.rows.length > 0;
}
