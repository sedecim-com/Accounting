import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// The closed lists of the Anexo 24, read from the SAT's own XSD (#404).
//
// CodAgrup, Moneda, the national bank attributes and the payment method are
// not patterns: CatalogosParaEsqContE.xsd declares each as an `xs:enumeration`
// list. A value off the list makes the whole file invalid, so the generators
// refuse it before building anything.
//
// CONTRACT: the lists are read from the vendored XSD in `xsd/`, which is kept
// byte for byte with its SHA-256 in provenance.json. They are never copied into
// code by hand: a hand-copied list drifts from the schema the day the SAT
// republishes it, and nothing would notice. `npm run build:api` copies `xsd/`
// next to the compiled module for the same reason.
//
// NOTE: a missing or unreadable XSD throws. It never yields an empty list,
// because an empty list would either refuse every file or, worse, be read as
// «nothing to check».
// ============================================================

/** The vendored schema that declares the four lists, relative to `xsd/`. */
export const OFFICIAL_ENUMERATIONS_XSD =
  'ContabilidadE/1_3/CatalogosParaEsqContE/CatalogosParaEsqContE.xsd';

/** The `xs:simpleType` names the generators check against. */
export type OfficialEnumeration = 'c_CodAgrup' | 'c_Banco' | 'c_Moneda' | 'c_MetPagos';

let cache: Map<string, ReadonlySet<string>> | undefined;

/** Every enumerated simple type in the schema text, by name. */
export function parseEnumerations(xsd: string): Map<string, ReadonlySet<string>> {
  const types = new Map<string, ReadonlySet<string>>();
  for (const block of xsd.matchAll(/<xs:simpleType name="([^"]+)">([\s\S]*?)<\/xs:simpleType>/g)) {
    const values = [...block[2].matchAll(/<xs:enumeration value="([^"]*)"\s*\/>/g)].map((v) => v[1]);
    if (values.length > 0) types.set(block[1], new Set(values));
  }
  return types;
}

/** The values the official XSD admits for one of the closed lists. */
export function officialEnumeration(type: OfficialEnumeration): ReadonlySet<string> {
  cache ??= parseEnumerations(
    fs.readFileSync(path.join(__dirname, 'xsd', OFFICIAL_ENUMERATIONS_XSD), 'utf-8')
  );
  const values = cache.get(type);
  if (values === undefined) {
    throw new Error(`${OFFICIAL_ENUMERATIONS_XSD} declares no enumeration named ${type}.`);
  }
  return values;
}
