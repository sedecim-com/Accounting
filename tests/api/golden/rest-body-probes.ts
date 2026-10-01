import * as fs from 'node:fs';
import * as path from 'node:path';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { montarSuperficieCensable } from '../../../src/api/rest/montajes.js';
import { censarRutas } from '../../../src/api/rest/risk.js';
import { caminoOpenAPI } from '../../../src/api/rest/openapi.js';
import { esquemaDeCuerpo, validateBody } from '../../../src/api/rest/middleware/async-handler.js';
import { AppError } from '../../../src/utils/errors.js';

// ============================================================
// CONTRACT: the REST 422 body, pinned probe by probe (#367).
// CONTRACT: the over-cap 422 diverges from the zod 3 recording by design since #407 / MNE-001-395, and the `overCapWithViolations` probes are post-migration additions.
//
// Every request-body schema the API validates is replayed through the REAL
// `validateBody` with a deterministic set of probes, and the outcome is
// recorded as one line:
//
//   422 VALIDATION_ERROR <message>   the exact prose a client receives
//   OK <JSON of req.body>            the parsed body a handler receives
//   THROW <name>                     the validator crashed (answers 500)
//
// The probes are derived from docs/openapi.json and not from the Zod objects,
// so the SAME probe set is generated whatever Zod major validates them: the
// published contract is identical before and after the Zod 4 migration, and
// this file is how the migration proves the validation behind it is too.
//
// The golden (rest-body.golden.json) was recorded on zod 3.25.76 and is
// written only by `npx tsx scripts/zod-contract-goldens.ts --write`.
// ============================================================

export const ROOT = path.resolve(__dirname, '..', '..', '..');
export const REST_BODY_GOLDEN = path.join(ROOT, 'tests', 'api', 'golden', 'rest-body.golden.json');

type JsonNode = { [key: string]: unknown };
type PathKey = string | number;

export interface BodyProbe {
  id: string;
  body: unknown;
}

/** A mounted route that validates its body, with the schema openapi.json publishes for it. */
export interface ProbedRoute {
  key: string;
  handler: RequestHandler;
  published: JsonNode;
  fixup?: SampleFixup;
}

type SampleMode = 'minimal' | 'full';
/** Makes a sample valid where a refinement needs it; `full` is the full sample before any fixup. */
type SampleFixup = (body: unknown, mode: SampleMode, full: unknown) => unknown;

// ─── the valid samples ───

export const UUID_SAMPLE = '11111111-1111-1111-1111-111111111111';

/** Ids v3 accepts and RFC 9562 rejects (wrong version or variant nibble). */
export const NON_RFC_UUIDS = [
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'A8D1F2B4-7E52-4D90-C16F-425D6E7F8091',
] as const;

/** Strings where the URL parser and a trimming validator disagree. */
export const URL_EDGES = [
  ' https://a.com',
  ' https://a.com',
  ' https://a.com',
  '﻿https://a.com',
  'https://exa\tmple.com',
  'http:example.com',
  'mailto:a@b.co',
] as const;

export const EMAIL_EDGES = [
  'a..b@x.co',
  '.a@x.co',
  "o'neil@x.co",
  'a@b.c',
  'A@B.CO',
  'a+tag@x.co',
  'á@x.co',
] as const;

/** A valid value per published `pattern`; an unknown pattern is a new case to add here. */
const PATTERN_SAMPLES: Readonly<Record<string, string>> = {
  '^\\d{4}-\\d{2}-\\d{2}': '2024-01-15',
};

function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(node: JsonNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

function stringAt(node: JsonNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

/** The first non-null type the node declares, or undefined for `{}` and `anyOf`. */
function primaryType(node: JsonNode): string | undefined {
  const declared = node.type;
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared)) {
    return declared.find((t): t is string => typeof t === 'string' && t !== 'null');
  }
  return undefined;
}

function acceptsNull(node: JsonNode): boolean {
  const declared = node.type;
  if (Array.isArray(declared)) return declared.includes('null');
  if (Array.isArray(node.anyOf)) return node.anyOf.some((b) => isNode(b) && b.type === 'null');
  return false;
}

function enumValues(node: JsonNode): unknown[] | undefined {
  return Array.isArray(node.enum) ? node.enum : undefined;
}

function sampleString(node: JsonNode): string {
  const values = enumValues(node);
  if (values && typeof values[0] === 'string') return values[0];
  switch (stringAt(node, 'format')) {
    case 'uuid':
      return UUID_SAMPLE;
    case 'email':
      return 'a@b.co';
    case 'uri':
      return 'https://a.com';
  }
  const pattern = stringAt(node, 'pattern');
  if (pattern !== undefined) {
    const known = PATTERN_SAMPLES[pattern];
    if (known === undefined) {
      throw new Error(`rest-body-probes: no valid sample for pattern /${pattern}/; add it to PATTERN_SAMPLES`);
    }
    return known;
  }
  return 'a'.repeat(Math.max(numberAt(node, 'minLength') ?? 1, 1));
}

function sampleNumber(node: JsonNode): number {
  const exclusiveMin = numberAt(node, 'exclusiveMinimum');
  let value = numberAt(node, 'minimum') ?? (exclusiveMin !== undefined ? exclusiveMin + 1 : 1);
  const maximum = numberAt(node, 'maximum');
  if (maximum !== undefined && value > maximum) value = maximum;
  return value;
}

export function sample(node: JsonNode, mode: SampleMode): unknown {
  if (Array.isArray(node.anyOf)) {
    const first = node.anyOf.find(isNode);
    return first ? sample(first, mode) : 1;
  }
  switch (primaryType(node)) {
    case 'string':
      return sampleString(node);
    case 'number':
    case 'integer':
      return sampleNumber(node);
    case 'boolean':
      return true;
    case 'array': {
      const items = isNode(node.items) ? node.items : {};
      const count = Math.max(numberAt(node, 'minItems') ?? 0, 1);
      return Array.from({ length: count }, () => sample(items, mode));
    }
    case 'object': {
      const properties = isNode(node.properties) ? node.properties : undefined;
      if (properties) {
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        const out: JsonNode = {};
        for (const [key, child] of Object.entries(properties)) {
          if (!isNode(child)) continue;
          if (mode === 'full' || required.has(key)) out[key] = sample(child, mode);
        }
        return out;
      }
      if (isNode(node.additionalProperties)) return { k: sample(node.additionalProperties, mode) };
      return {};
    }
    default:
      return 1;
  }
}

// ─── the invalid values ───

/** A value of the wrong JSON type for the node, or undefined when any type is valid. */
function wrongTypeFor(node: JsonNode): unknown {
  if (Array.isArray(node.anyOf)) return true;
  if (enumValues(node)) return 123;
  switch (primaryType(node)) {
    case 'string':
      return 123;
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
    case 'object':
      return 'x';
    default:
      return undefined;
  }
}

/** Every leaf violation of one node, as [probe name, value]. Arrays and objects add theirs elsewhere. */
function leafViolations(node: JsonNode): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const wrong = wrongTypeFor(node);
  if (wrong !== undefined) out.push(['wrongType', wrong]);
  const type = primaryType(node);

  if (type === 'string' && !Array.isArray(node.anyOf)) {
    if (enumValues(node)) out.push(['enum', 'zz']);
    const format = stringAt(node, 'format');
    if (format === 'uuid') {
      out.push(['uuid', 'nope']);
      NON_RFC_UUIDS.forEach((id, i) => out.push([`uuidNonRfc:${i}`, id]));
    }
    if (format === 'email') {
      out.push(['email', 'a@']);
      EMAIL_EDGES.forEach((e, i) => out.push([`emailEdge:${i}`, e]));
    }
    if (format === 'uri') {
      out.push(['uri', 'not a url']);
      URL_EDGES.forEach((u, i) => out.push([`urlEdge:${i}`, u]));
    }
    if (stringAt(node, 'pattern') !== undefined) out.push(['pattern', '!']);
    const min = numberAt(node, 'minLength');
    const max = numberAt(node, 'maxLength');
    if (min !== undefined && min > 0) out.push(['minLength-1', 'a'.repeat(min - 1)]);
    if (max !== undefined) {
      out.push(['maxLength+1', 'a'.repeat(max + 1)]);
      out.push(['astralOverMax', '\u{1F600}'.repeat(Math.ceil((max + 1) / 2))]);
    }
    if (min !== undefined || max !== undefined) out.push(['wrongTypeWithLength', ['a', 'b', 'c']]);
    if (min !== undefined && min === max && min >= 2) {
      out.push(['astralExactLength', '\u{1F600}' + 'a'.repeat(min - 2)]);
    }
  }

  if (type === 'number' || type === 'integer') {
    const minimum = numberAt(node, 'minimum');
    const maximum = numberAt(node, 'maximum');
    const exclusiveMin = numberAt(node, 'exclusiveMinimum');
    const exclusiveMax = numberAt(node, 'exclusiveMaximum');
    if (type === 'integer') out.push(['integer', 1.5]);
    if (minimum !== undefined) out.push(['minimum-1', minimum - 1]);
    if (maximum !== undefined) out.push(['maximum+1', maximum + 1]);
    if (exclusiveMin !== undefined) out.push(['exclusiveMinimumEdge', exclusiveMin]);
    if (exclusiveMax !== undefined) out.push(['exclusiveMaximumEdge', exclusiveMax]);
    if (type === 'integer' && minimum !== undefined) out.push(['nonIntegerBelowMin', minimum - 0.5]);
    if (type === 'integer' && maximum !== undefined) out.push(['nonIntegerAboveMax', maximum + 0.5]);
  }
  return out;
}

/**
 * JSON 1e999, which express.json parses to Infinity, on every leaf where zod 3
 * refused it: a field that is not a number, an integer, a bound it breaks.
 * Where zod 3 took it as a number, zod 4 refuses it on purpose (T1), and
 * body-contract.spec.ts pins both answers instead of the golden.
 */
function infinityViolations(node: JsonNode): Array<[string, unknown]> {
  if (Array.isArray(node.anyOf)) return [];
  const type = primaryType(node);
  if (type === 'number' || type === 'integer') {
    const out: Array<[string, unknown]> = [];
    const integer = type === 'integer';
    if (integer || node.maximum !== undefined || node.exclusiveMaximum !== undefined) out.push(['plusInfinity', Infinity]);
    if (integer || node.minimum !== undefined || node.exclusiveMinimum !== undefined) out.push(['minusInfinity', -Infinity]);
    return out;
  }
  return wrongTypeFor(node) === undefined ? [] : [['infinity', Infinity]];
}

/** The first violation an element can carry, used to build multi-issue arrays. */
function firstViolation(node: JsonNode, base: unknown): unknown {
  const properties = isNode(node.properties) ? node.properties : undefined;
  if (properties && isNode(base)) {
    for (const [key, child] of Object.entries(properties)) {
      if (!isNode(child)) continue;
      const inner = leafViolations(child).find(([name]) => name !== 'wrongType');
      if (inner) return { ...base, [key]: inner[1] };
    }
    return base;
  }
  const leaf = leafViolations(node).find(([name]) => name !== 'wrongType');
  return leaf ? leaf[1] : wrongTypeFor(node);
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function setAt(root: unknown, at: readonly PathKey[], value: unknown): unknown {
  if (at.length === 0) return value;
  const copy = clone(root);
  let cursor: unknown = copy;
  for (let i = 0; i < at.length - 1; i++) {
    const step = at[i];
    cursor = Array.isArray(cursor)
      ? cursor[Number(step)]
      : isNode(cursor)
        ? cursor[String(step)]
        : undefined;
  }
  const last = at[at.length - 1];
  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else if (isNode(cursor)) cursor[String(last)] = value;
  return copy;
}

function label(at: readonly PathKey[]): string {
  return at.length === 0 ? '<root>' : at.join('.');
}

/** A JSON body whose own key is `__proto__`, exactly as express.json delivers it. */
function protoKeyBody(): unknown {
  return JSON.parse('{"__proto__":{"x":1}}');
}

/**
 * A record whose own `__proto__` entry carries `value` between two valid
 * entries: zod 3 validated that entry in key order and left it out of the
 * output, and zod 4's record skips it unless recordOf restores it (#367).
 */
function protoEntryRecord(value: unknown, valid: unknown): unknown {
  const entries = [`"a":${JSON.stringify(valid)}`, `"__proto__":${JSON.stringify(value)}`, `"b":${JSON.stringify(valid)}`];
  return JSON.parse(`{${entries.join(',')}}`);
}

/**
 * For a refinement that wants at least one field, or one of two: the minimal
 * sample carries `key`, valued as in the full sample. The full sample already
 * holds every field, so it is left as it is.
 */
function withField(key: string): SampleFixup {
  return (body, mode, full) =>
    mode === 'minimal' && isNode(body) && isNode(full) && key in full ? { ...body, [key]: full[key] } : body;
}

/**
 * Valid samples that a refinement needs and JSON Schema cannot express (the
 * nodes published with `x-validacion-adicional`), keyed by route. Without
 * them every probe of the route would also carry the refinement's issue, and
 * a `minimalValid` or `fullValid` probe would record a rejection under the
 * name of an acceptance (body-contract.spec.ts refuses that).
 */
const SAMPLE_FIXUPS: Readonly<Record<string, SampleFixup>> = {
  // "At least one field must be provided" (or "... required").
  'PATCH /v1/accounts/:id': withField('name'),
  'PATCH /v1/customers/:id': withField('company_name'),
  'PATCH /v1/pre-registrations/:id': withField('notes'),
  'PATCH /v1/vendors/:id': withField('company_name'),
  'PUT /v1/processing-rules/:id': withField('rule_name'),
  // "company_name or first_name is required".
  'POST /v1/customers': withField('company_name'),
  // "xml_content or xml_contents array is required".
  'POST /v1/upload': withField('xml_content'),
  // A journal line carries a debit OR a credit, never both and never neither.
  'POST /v1/journal-entries': (body, mode) => {
    if (!isNode(body) || !Array.isArray(body.lines)) return body;
    const rows: unknown[] = body.lines;
    const lines = rows.map((line) => {
      if (!isNode(line)) return line;
      const { credit_amount: _credit, ...debitOnly } = line;
      return mode === 'full' ? debitOnly : { ...line, debit_amount: '1' };
    });
    return { ...body, lines };
  },
};

/** Every probe for one published body schema, in a stable order. */
export function probesFor(schema: JsonNode, fixup: SampleFixup = (body) => body): BodyProbe[] {
  const unfixed = sample(schema, 'full');
  const full = fixup(unfixed, 'full', unfixed);
  const probes: BodyProbe[] = [
    { id: '<root>:array', body: [] },
    { id: '<root>:null', body: null },
    { id: '<root>:string', body: 'x' },
    { id: '<root>:number', body: 0 },
    { id: '<root>:infinity', body: Infinity },
    { id: '<root>:emptyObject', body: {} },
    { id: '<root>:protoKey', body: protoKeyBody() },
    { id: 'minimalValid', body: fixup(sample(schema, 'minimal'), 'minimal', unfixed) },
    { id: 'fullValid', body: full },
  ];
  if (isNode(full)) probes.push({ id: 'extraKey', body: { ...full, __extra__: 1 } });

  const visit = (node: JsonNode, at: PathKey[]): void => {
    if (at.length > 0) {
      for (const [name, value] of [...leafViolations(node), ...infinityViolations(node)]) {
        probes.push({ id: `${label(at)}:${name}`, body: setAt(full, at, value) });
      }
      if (acceptsNull(node)) probes.push({ id: `${label(at)}:null`, body: setAt(full, at, null) });
    }
    if (Array.isArray(node.anyOf)) return;
    const type = primaryType(node);
    if (type === 'array') {
      const items = isNode(node.items) ? node.items : {};
      const element = sample(items, 'full');
      const minItems = numberAt(node, 'minItems');
      const maxItems = numberAt(node, 'maxItems');
      if (minItems !== undefined && minItems > 0) {
        probes.push({
          id: `${label(at)}:minItems-1`,
          body: setAt(full, at, Array.from({ length: minItems - 1 }, () => clone(element))),
        });
        probes.push({ id: `${label(at)}:wrongTypeWithLength`, body: setAt(full, at, 'x') });
      }
      if (minItems !== undefined && minItems >= 2) {
        const short = Array.from({ length: minItems - 1 }, () => clone(element));
        short[0] = firstViolation(items, clone(element));
        probes.push({ id: `${label(at)}:shortWithViolation`, body: setAt(full, at, short) });
      }
      if (maxItems !== undefined && maxItems <= 100) {
        probes.push({
          id: `${label(at)}:maxItems+1`,
          body: setAt(full, at, Array.from({ length: maxItems + 1 }, () => clone(element))),
        });
      }
      if (maxItems !== undefined && maxItems >= 100) {
        // #407: past a cap the body is refused before its elements are read, so
        // the 422 names the cap and none of the invalid elements.
        const bad = firstViolation(items, clone(element));
        probes.push({
          id: `${label(at)}:overCapWithViolations`,
          body: setAt(full, at, Array.from({ length: maxItems + 1 }, () => clone(bad))),
        });
      }
      const pair = [firstViolation(items, clone(element)), wrongTypeFor(items) ?? null];
      probes.push({ id: `${label(at)}:violationThenWrongType`, body: setAt(full, at, pair) });
      visit(items, [...at, 0]);
      return;
    }
    if (type === 'object') {
      const properties = isNode(node.properties) ? node.properties : undefined;
      if (properties) {
        for (const [key, child] of Object.entries(properties)) {
          if (isNode(child)) visit(child, [...at, key]);
        }
      } else if (isNode(node.additionalProperties)) {
        const values = node.additionalProperties;
        const valid = sample(values, 'full');
        probes.push({ id: `${label(at)}:protoEntryValid`, body: setAt(full, at, protoEntryRecord(valid, valid)) });
        const wrong = wrongTypeFor(values);
        if (wrong !== undefined) {
          probes.push({ id: `${label(at)}:protoEntryWrongType`, body: setAt(full, at, protoEntryRecord(wrong, valid)) });
        }
        visit(values, [...at, 'k']);
      }
    }
  };
  visit(schema, []);

  const seen = new Set<string>();
  for (const p of probes) {
    if (seen.has(p.id)) throw new Error(`rest-body-probes: duplicate probe id ${p.id}`);
    seen.add(p.id);
  }
  return probes;
}

// ─── the routes, and the replay ───

function publishedBodies(): Map<string, JsonNode> {
  const doc: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi.json'), 'utf8'));
  const out = new Map<string, JsonNode>();
  if (!isNode(doc) || !isNode(doc.paths)) throw new Error('docs/openapi.json has no paths');
  for (const [route, methods] of Object.entries(doc.paths)) {
    if (!isNode(methods)) continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!isNode(op) || !isNode(op.requestBody) || !isNode(op.requestBody.content)) continue;
      const json = op.requestBody.content['application/json'];
      if (isNode(json) && isNode(json.schema)) out.set(`${method} ${route}`, json.schema);
    }
  }
  return out;
}

/**
 * Every mounted route that validates its body, once per schema object: a
 * router mounted under two prefixes validates with the same schema twice, and
 * the first path (in census order) stands for both.
 */
export function probedRoutes(): ProbedRoute[] {
  const published = publishedBodies();
  const seen = new Set<unknown>();
  const out: ProbedRoute[] = [];
  const routes = censarRutas(montarSuperficieCensable(express())).sort(
    (a, b) => a.ruta.localeCompare(b.ruta) || a.metodo.localeCompare(b.metodo)
  );
  for (const r of routes) {
    const schema = r.manejadores.map((h) => esquemaDeCuerpo(h)).find((s) => s !== undefined);
    if (schema === undefined || seen.has(schema)) continue;
    seen.add(schema);
    const body = published.get(`${r.metodo} ${caminoOpenAPI(r.ruta)}`);
    if (!body) throw new Error(`${r.metodo} ${r.ruta} validates a body that docs/openapi.json does not publish`);
    const key = `${r.metodo.toUpperCase()} ${r.ruta}`;
    out.push({ key, handler: validateBody(schema), published: body, fixup: SAMPLE_FIXUPS[key] });
  }
  return out;
}

/** What one request body does to the real validator. */
export function outcomeOf(handler: RequestHandler, body: unknown): string {
  const req = { body } as Request;
  const calls: unknown[][] = [];
  try {
    void handler(req, {} as Response, (...args: unknown[]) => {
      calls.push(args);
    });
  } catch (err) {
    return `THROW ${err instanceof Error ? err.name : typeof err}`;
  }
  if (calls.length !== 1) return `NEXT called ${calls.length} times`;
  const err = calls[0]?.[0];
  if (err === undefined) return `OK ${JSON.stringify(req.body)}`;
  if (err instanceof AppError) return `${err.statusCode} ${err.code} ${err.message}`;
  return `NEXT ${err instanceof Error ? err.name : typeof err}`;
}

/** The whole golden, keyed `<METHOD> <path> · <probe id>`, in sorted key order. */
export function recordRestBodyGolden(): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const route of probedRoutes()) {
    for (const probe of probesFor(route.published, route.fixup)) {
      entries.push([`${route.key} · ${probe.id}`, outcomeOf(route.handler, probe.body)]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}
