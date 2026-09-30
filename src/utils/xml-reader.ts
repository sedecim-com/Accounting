import { XMLParser } from 'fast-xml-parser';

// ============================================================
// THE ONE PLACE WHERE A THIRD-PARTY XML FILE IS PARSED (#218, #299)
//
// fast-xml-parser (5.11.1) gets three things wrong when READING, all measured
// by running the library, and each one corrupts data without a sound:
//
//   1. Without `htmlEntities: true`, NUMERIC character references are not
//      decoded: `Nombre="Cr&#233;dito"` is read as the literal `Cr&#233;dito`
//      and that string reaches the database. `&amp;` IS decoded, so a test
//      written with `&` goes green while every accented name is lost.
//   2. With `htmlEntities: true`, `&#10;` becomes a REAL line break inside the
//      attribute. XML 1.0 §3.3.3 makes every conforming parser replace #x9,
//      #xA and #xD with a SPACE: the SAT reads a space, so storing the break
//      would make our name differ from the one the authority holds.
//      `normalizeAttributeValue` is the half of the norm the library skips.
//   3. With `parseAttributeValue: true`, every attribute that looks like a
//      number becomes one: the postal code `01000` is stored as `1000`, the
//      folio `000123` as `123`, the key `002` as `2`. SAT keys and identifiers
//      are TEXT; an amount is converted by the reader that knows it is one.
//
// Every reader of a file somebody else wrote builds its parser here, so that
// the three answers live in one definition. A reader that copies the options
// is the reader that, a year from now, forgets one of them.
// ============================================================

export interface XmlReaderOptions {
  /**
   * Whether the library trims attribute and text values. The Anexo 24 readers
   * pass false so that they can REPORT a code with a leading space instead of
   * merging it, in silence, with its twin without one.
   */
  trimValues: boolean;
  /** Nodes that always come back as an array, even when the file has one. */
  repeated?: readonly string[];
}

/**
 * The parser for any third-party XML: attributes under `@_`, namespace
 * prefixes dropped (the issuer picks the prefix, not the schema), numeric
 * character references decoded, and every value kept as the text it was.
 */
export function createXmlReader(options: XmlReaderOptions): XMLParser {
  const repeated = options.repeated ?? [];
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    htmlEntities: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: options.trimValues,
    isArray: (name) => repeated.includes(name),
  });
}

/**
 * The parser for a reader that walks a third-party document the way an XSLT
 * does, as the cadena original of the Anexo 24 needs: document order kept
 * (`preserveOrder`), qualified names kept (the stylesheet matches them), and
 * attributes without a prefix. It decodes numeric character references like
 * the reader above, so that `&#237;` reaches the cadena as the letter it names.
 */
export function createOrderedXmlReader(): XMLParser {
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: true,
    htmlEntities: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
  });
}

/**
 * XML 1.0 §3.3.3 attribute-value normalization: tab, line feed and carriage
 * return are worth one space. Says whether anything changed, because a reader
 * that reports what it did to the file needs to know.
 */
export function normalizeAttributeValue(value: string): { text: string; normalized: boolean } {
  const text = value.replace(/[\t\n\r]/g, ' ');
  return { text, normalized: text !== value };
}

/**
 * Normalizes, in place, every `@_` attribute of a parsed tree. For the readers
 * that have nothing to report about the normalization and only need the text
 * the authority read.
 */
export function normalizeAttributes<T>(tree: T): T {
  if (Array.isArray(tree)) {
    for (const item of tree) normalizeAttributes(item);
  } else if (typeof tree === 'object' && tree !== null) {
    const node = tree as Record<string, unknown>;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (key.startsWith('@_')) node[key] = normalizeAttributeValue(value).text;
      } else {
        normalizeAttributes(value);
      }
    }
  }
  return tree;
}
