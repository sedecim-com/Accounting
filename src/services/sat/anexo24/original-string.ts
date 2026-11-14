import * as fs from 'node:fs';
import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { XSD_ROOT } from './official-xsd.js';
import { createOrderedXmlReader } from '../../../utils/xml-reader.js';

// ============================================================
// EFIRMA-4 (#442) · THE CADENA ORIGINAL, BY THE SAT'S OWN STYLESHEET
//
// CONTRACT: the Anexo 24 seals the cadena original the SAT's XSLT produces
// from the document. The stylesheets are vendored byte for byte in `xsd/`,
// with their URL, download date and SHA-256 in provenance.json, next to the
// XSDs they belong to (the SAT publishes the 1.3 ones as `*_1_2.xslt` inside
// the 1_3 folder, with the 1_3 namespace).
//
// NOTE: no XSLT dependency. This runs the vendored stylesheet itself, and it
// understands exactly the instructions the SAT's cadena stylesheets use:
// template (match "/" or a QName, or by name), include of a sibling under
// the SAT prefix, text output, apply-templates over `/p:X` or `./p:X`,
// call-template with with-param `./@A` or `$v`, param, if over `$v`, and
// value-of `normalize-space(string($v))`. Anything else THROWS: if the SAT
// republishes a stylesheet with a construct this does not know, the seal
// stops instead of signing a cadena built by a guess. The order of the
// fields is never written in code: it is read from the SAT's file.
// ============================================================

/** The cadena original stylesheet of each sealable document, relative to `xsd/`. */
export const ORIGINAL_STRING_STYLESHEETS = {
  catalogo: 'ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_2.xslt',
  balanza: 'ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_2.xslt',
} as const;

export type SealableDocument = keyof typeof ORIGINAL_STRING_STYLESHEETS;

const SAT_SCHEMAS_URL = 'http://www.sat.gob.mx/esquemas/';
const XSL = 'xsl:';

export class UnsupportedStylesheetError extends Error {
  constructor(message: string) {
    super(`The SAT stylesheet uses something the cadena runner does not know: ${message}`);
    this.name = 'UnsupportedStylesheetError';
  }
}

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = Element | string;

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
} as const;

const stylesheetParser = new XMLParser(PARSER_OPTIONS);

// The DOCUMENT parser decodes numeric character references, as the XSLT does.
// It is built in src/utils/xml-reader.ts, the one place that sets how a
// third-party file's entities are read. A line break that arrives as `&#10;`
// becomes a real one here, where an XML parser would keep it too (a character
// reference escapes attribute normalization); every value in the cadena goes
// through normalize-space, which collapses both the same.
const documentParser = createOrderedXmlReader();

function toTree(raw: unknown): XmlNode[] {
  return (raw as Record<string, unknown>[]).map((item) => {
    const name = Object.keys(item).find((k) => k !== ':@')!;
    if (name === '#text') return String(item[name]);
    return {
      name,
      attrs: (item[':@'] as Record<string, string> | undefined) ?? {},
      children: toTree(item[name]),
    };
  });
}

const elements = (nodes: XmlNode[]): Element[] => nodes.filter((n): n is Element => typeof n !== 'string');

function rootOf(xml: string, parser: XMLParser = stylesheetParser): Element {
  const [root, ...rest] = elements(toTree(parser.parse(xml)));
  if (!root || rest.length > 0) throw new Error('The document must have exactly one root element.');
  return root;
}

/** `{uri}local` of a QName, resolved against a prefix map. */
function expand(qname: string, ns: ReadonlyMap<string, string>): string {
  const [prefix, local] = qname.includes(':') ? qname.split(':') : ['', qname];
  const uri = ns.get(prefix) ?? (prefix === '' ? '' : undefined);
  if (uri === undefined) throw new UnsupportedStylesheetError(`the prefix of ${qname} is not declared`);
  return `{${uri}}${local}`;
}

function declaredNamespaces(el: Element, inherited: ReadonlyMap<string, string>): Map<string, string> {
  const ns = new Map(inherited);
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k === 'xmlns') ns.set('', v);
    else if (k.startsWith('xmlns:')) ns.set(k.slice(6), v);
  }
  return ns;
}

// ── The document, with every element's expanded name ──────────────────────

interface DocElement {
  expanded: string;
  attrs: Record<string, string>;
  children: DocElement[];
}

function documentTree(el: Element, inherited: ReadonlyMap<string, string>): DocElement {
  const ns = declaredNamespaces(el, inherited);
  return {
    expanded: expand(el.name, ns),
    attrs: el.attrs,
    children: elements(el.children).map((c) => documentTree(c, ns)),
  };
}

// ── The stylesheet ─────────────────────────────────────────────────────────

interface Template {
  body: XmlNode[];
  ns: ReadonlyMap<string, string>;
  params: string[];
}

interface Stylesheet {
  root: Template | undefined;
  byMatch: Map<string, Template>;
  byName: Map<string, Template>;
}

function loadStylesheet(file: string, into: Stylesheet): Stylesheet {
  const sheet = rootOf(fs.readFileSync(path.join(XSD_ROOT, file), 'utf8'));
  if (sheet.name !== `${XSL}stylesheet`) throw new UnsupportedStylesheetError(`root ${sheet.name}`);
  const ns = declaredNamespaces(sheet, new Map());
  for (const top of elements(sheet.children)) {
    const a = top.attrs;
    if (top.name === `${XSL}include`) {
      if (!a.href?.startsWith(SAT_SCHEMAS_URL)) throw new UnsupportedStylesheetError(`include of ${a.href}`);
      loadStylesheet(a.href.slice(SAT_SCHEMAS_URL.length), into);
    } else if (top.name === `${XSL}output`) {
      if (a.method !== 'text') throw new UnsupportedStylesheetError(`output method ${a.method}`);
    } else if (top.name === `${XSL}template`) {
      const params = elements(top.children)
        .filter((c) => c.name === `${XSL}param`)
        .map((c) => c.attrs.name);
      const template: Template = { body: top.children, ns, params };
      if (a.match === '/') into.root = template;
      else if (a.match !== undefined) into.byMatch.set(expand(a.match, ns), template);
      else if (a.name !== undefined) into.byName.set(a.name, template);
      else throw new UnsupportedStylesheetError('a template with neither match nor name');
    } else {
      throw new UnsupportedStylesheetError(top.name);
    }
  }
  return into;
}

const loaded = new Map<SealableDocument, Stylesheet>();

function stylesheetFor(document: SealableDocument): Stylesheet {
  let sheet = loaded.get(document);
  if (!sheet) {
    sheet = loadStylesheet(ORIGINAL_STRING_STYLESHEETS[document], { root: undefined, byMatch: new Map(), byName: new Map() });
    loaded.set(document, sheet);
  }
  return sheet;
}

// ── Running it ─────────────────────────────────────────────────────────────

/** An attribute node-set: its value, or undefined when it selected nothing. */
type Value = string | undefined;

/** XPath 1.0 normalize-space: trims and collapses #x20, #x9, #xD and #xA. */
export function normalizeSpace(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');
}

interface Context {
  node: DocElement | null;
  root: DocElement;
  vars: ReadonlyMap<string, Value>;
  ns: ReadonlyMap<string, string>;
}

function valueOf(expr: string, ctx: Context): Value {
  const attribute = /^\.\/@([A-Za-z_][\w.-]*)$/.exec(expr);
  if (attribute) return ctx.node?.attrs[attribute[1]];
  const variable = /^\$([\w-]+)$/.exec(expr);
  if (variable && ctx.vars.has(variable[1])) return ctx.vars.get(variable[1]);
  throw new UnsupportedStylesheetError(`the expression ${expr}`);
}

function select(expr: string, ctx: Context): DocElement[] {
  const m = /^(\.?)\/([\w-]+:[\w-]+)$/.exec(expr);
  if (!m) throw new UnsupportedStylesheetError(`the selection ${expr}`);
  const wanted = expand(m[2], ctx.ns);
  if (m[1] === '') return ctx.root.expanded === wanted ? [ctx.root] : [];
  return (ctx.node?.children ?? []).filter((c) => c.expanded === wanted);
}

function run(body: XmlNode[], ctx: Context, sheet: Stylesheet, out: string[]): void {
  for (const node of body) {
    if (typeof node === 'string') {
      if (node.trim() !== '') out.push(node);
      continue;
    }
    const a = node.attrs;
    switch (node.name) {
      case `${XSL}param`:
        break;
      case `${XSL}apply-templates`:
        for (const el of select(a.select ?? '', ctx)) {
          const template = sheet.byMatch.get(el.expanded);
          if (!template) throw new UnsupportedStylesheetError(`no template matches ${el.expanded}`);
          run(template.body, { ...ctx, node: el, vars: new Map(), ns: template.ns }, sheet, out);
        }
        break;
      case `${XSL}call-template`: {
        const template = sheet.byName.get(a.name ?? '');
        if (!template) throw new UnsupportedStylesheetError(`call of the unknown template ${a.name}`);
        const vars = new Map<string, Value>();
        for (const p of elements(node.children)) {
          if (p.name !== `${XSL}with-param`) throw new UnsupportedStylesheetError(p.name);
          vars.set(p.attrs.name, valueOf(p.attrs.select ?? '', ctx));
        }
        for (const p of template.params) if (!vars.has(p)) vars.set(p, undefined);
        run(template.body, { ...ctx, vars, ns: template.ns }, sheet, out);
        break;
      }
      case `${XSL}if`:
        if (valueOf(a.test ?? '', ctx) !== undefined) run(node.children, ctx, sheet, out);
        break;
      case `${XSL}value-of`: {
        const m = /^normalize-space\(string\((\$[\w-]+)\)\)$/.exec(a.select ?? '');
        if (!m) throw new UnsupportedStylesheetError(`value-of ${a.select}`);
        out.push(normalizeSpace(valueOf(m[1], ctx) ?? ''));
        break;
      }
      default:
        throw new UnsupportedStylesheetError(node.name);
    }
  }
}

/**
 * The cadena original of an Anexo 24 catalog or trial balance, produced by
 * running the SAT's vendored stylesheet over the document.
 */
export function originalString(xml: string, document: SealableDocument): string {
  const sheet = stylesheetFor(document);
  if (!sheet.root) throw new UnsupportedStylesheetError('no template matches "/"');
  const root = documentTree(rootOf(xml, documentParser), new Map());
  const out: string[] = [];
  run(sheet.root.body, { node: null, root, vars: new Map(), ns: sheet.root.ns }, sheet, out);
  return out.join('');
}

/** One element of a document, with its attribute values decoded. */
export interface DocumentElement {
  /** The local name, without prefix. */
  name: string;
  attrs: Readonly<Record<string, string>>;
}

/** Every element of the document in document order, parsed as the cadena reads it. */
export function documentElements(xml: string): DocumentElement[] {
  const out: DocumentElement[] = [];
  const walk = (el: Element): void => {
    out.push({ name: el.name.slice(el.name.indexOf(':') + 1), attrs: el.attrs });
    elements(el.children).forEach(walk);
  };
  walk(rootOf(xml, documentParser));
  return out;
}
