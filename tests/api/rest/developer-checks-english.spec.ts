/**
 * MNE-001-823 (#151, I9 by folder, part 6b): the checks of `src/api/rest`
 * that only a developer or a deployer reads are English prose, with no key.
 *
 * None of them reaches a caller: the converter and the repeated operationId
 * throw while `scripts/openapi.ts` builds the contract, the route risk checks
 * throw at import or at boot, and the TRUST_PROXY warnings are logged once at
 * boot. So they follow rule 1 of docs/language.md (the machine layer is
 * English), as the input-contract guards of `isr-calculator.ts` did in
 * MNE-001-730. Every expected text below is written by hand.
 */
import fs from 'node:fs';
import express, { Router, type Express, type RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serviceUserStrings } from '../../../scripts/language/lanes/service-strings.js';
import { construirOpenAPI } from '../../../src/api/rest/openapi.js';
import { auditarRiesgoDeRutas, declararRiesgoRuta } from '../../../src/api/rest/risk.js';
import { arregloAcotado } from '../../../src/api/rest/topes.js';
import { resolverTrustProxy } from '../../../src/api/rest/trust-proxy.js';
import { jsonSchemaDeZod, ZodNoTraducible } from '../../../src/api/rest/zod-a-json-schema.js';

const FILES = [
  'src/api/rest/zod-a-json-schema.ts',
  'src/api/rest/risk.ts',
  'src/api/rest/trust-proxy.ts',
  'src/api/rest/openapi.ts',
];

describe('the four files hold no Spanish prose for the services lane', () => {
  it.each(FILES)('%s', (file) => {
    expect(serviceUserStrings(fs.readFileSync(file, 'utf8'), file)).toEqual([]);
  });
});

// ── the Zod to JSON Schema converter ──

const FRAME =
  'The converter in src/api/rest/zod-a-json-schema.ts throws instead of emitting an empty schema, ' +
  'because a contract that leaves a field out reads as "anything goes here" and is worse than ' +
  'publishing nothing. Add the case to the converter, with its test, or write the schema with ' +
  'the constructors it already translates.';

function refusal(schema: z.core.$ZodType): ZodNoTraducible {
  try {
    jsonSchemaDeZod(schema, 'body');
  } catch (err) {
    if (err instanceof ZodNoTraducible) return err;
    throw err;
  }
  throw new Error('the converter translated a schema it should refuse');
}

/** A string schema that carries the array cap of topes.ts, which only an array may carry. */
function capOnAString(): z.core.$ZodType {
  const capped = arregloAcotado(z.string(), { tope: 3, refusal: 'error.VALIDATION_ERROR.cap.invoice_lines' });
  const cap = capped._zod.def.checks?.at(-1);
  if (cap === undefined) throw new Error('arregloAcotado built no cap check');
  return z.string().check(cap as never);
}

/** A regex check with no expression, which no Zod helper builds but the converter guards. */
function regexWithoutPattern(): z.core.$ZodType {
  const check = new z.core.$ZodCheckRegex({
    check: 'string_format',
    format: 'regex',
    pattern: undefined as unknown as RegExp,
  });
  return z.string().check(check);
}

describe('the converter refuses in English, naming where', () => {
  it.each<[string, () => z.core.$ZodType, string, string]>([
    ['a discriminated union', () => z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]), 'body', 'the Zod constructor "discriminatedUnion" is not translated.'],
    ['a date', () => z.date(), 'body', 'the Zod constructor "date" is not translated.'],
    ['a preprocess', () => z.preprocess((v) => String(v), z.string()), 'body', 'is a `z.preprocess`, and what it validates inside is not what the client sends: the contract would describe the value AFTER the transform.'],
    ['a pipe to another schema', () => z.string().pipe(z.string().min(1)), 'body', 'is a `.pipe()` to another schema (or a codec): the input and what is validated afterwards are not the same contract, and the converter does not pick one.'],
    ['an array cap on a string', capOnAString, 'body', 'carries an array cap (topes.ts) on something that is not an array.'],
    ['a string overwrite check', () => z.string().trim(), 'body', 'the string check "overwrite" is not translated.'],
    ['a url with options', () => z.url({ protocol: /^https$/ }), 'body', 'the string check "url" with options is not translated.'],
    ['a regex with no expression', regexWithoutPattern, 'body', 'the string check "regex" carries no expression.'],
    ['a regex with flags', () => z.string().regex(/^abc$/i), 'body', "the regular expression /^abc$/i has flags, and JSON Schema's `pattern` does not take them: the contract would publish a different rule from the one the API applies."],
    ['a string format check', () => z.string().startsWith('MX'), 'body', 'the string check "startsWith" is not translated.'],
    ['a numeric format', () => z.int32(), 'body', 'the numeric check "int32" is not translated.'],
    ['a numeric overwrite check', () => z.number().check(z.overwrite((n) => n)), 'body', 'the numeric check "overwrite" is not translated.'],
    ['an array overwrite check', () => z.array(z.string()).check(z.overwrite((a) => a)), 'body', 'the array check "overwrite" is not translated.'],
    ['a typed catchall', () => z.object({ a: z.string() }).catchall(z.string()), 'body.*', 'the catchall "string" is not translated.'],
    ['a native enum', () => z.nativeEnum({ A: 'a', B: 'b' }), 'body', 'the Zod constructor "enum" with keys different from its values (a `z.nativeEnum`) is not translated.'],
    ['a loose record', () => z.looseRecord(z.string(), z.number()), 'body', 'a partial or `loose` record is not translated.'],
    ['an enum-keyed record', () => z.record(z.enum(['a', 'b']), z.number()), 'body', 'the record keys are "enum" and only string keys are translated.'],
  ])('%s', (_label, schema, where, detail) => {
    const err = refusal(schema());
    expect(err.donde).toBe(where);
    expect(err.message).toBe(`Cannot publish the contract of ${where}: ${detail}\n\n${FRAME}`);
  });
});

// ── the route risk declarations and the boot census ──

describe('an impossible risk declaration is refused in English', () => {
  it('an irreversible route for the agent', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'irreversible', agente: true })).toThrow(
      'A route declares risk "irreversible" and agent access at once. The agent does not post to the ' +
        'ledger, does not move money, does not stamp, does not cancel, does not file with an authority, ' +
        'does not delete and does not reach a third party with a client credential. If one part of this ' +
        'route is genuinely safe, split it into two routes with two declarations: the permission cannot ' +
        'depend on the content of the request.'
    );
  });

  it('a write for the agent without soloBorrador', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'escritura', agente: true })).toThrow(
      'A route grants the agent a write without asserting soloBorrador. A write the agent can call lands ' +
        'in a review queue, not in the ledger. Set soloBorrador: true if that holds on EVERY path of the ' +
        'route; if not, agente: false.'
    );
  });

  it('soloBorrador without agente', () => {
    expect(() => declararRiesgoRuta({ riesgo: 'escritura', soloBorrador: true })).toThrow(
      'A route asserts soloBorrador without declaring agente. soloBorrador exists to enable the agent on ' +
        'a write; without agente there is nothing to enable, and the assertion is left as a guarantee ' +
        'nobody checks. Remove it, or declare agente: true.'
    );
  });
});

const answer: RequestHandler = (_req, res) => {
  res.json({});
};

function appWith(build: (r: Router) => void): Express {
  const app = express();
  const r = Router();
  build(r);
  app.use('/v1/x', r);
  return app;
}

describe('the boot census refuses in English', () => {
  it('a scope longer than the idempotency_keys.scope column', () => {
    const long = 'a'.repeat(80);
    const app = appWith((r) => r.post(`/${long}`, declararRiesgoRuta({ riesgo: 'irreversible' }), answer));
    // «POST /v1/x/» is 11 characters, so the scope is 91.
    expect(() => auditarRiesgoDeRutas(app)).toThrow(
      '1 route(s) that require an idempotency key have a scope longer than the 80 characters of ' +
        `idempotency_keys.scope:\n  POST /v1/x/${long} (91)\n\n` +
        'Shorten the route, or widen the column with a migration. Letting it through means the key is ' +
        'refused when it is STORED, which is after the irreversible act already happened.'
    );
  });

  it('a declaration behind the handler', () => {
    const app = appWith((r) => r.post('/late', answer, declararRiesgoRuta({ riesgo: 'escritura' })));
    expect(() => auditarRiesgoDeRutas(app)).toThrow(
      '1 route(s) declare their risk outside the FIRST handler:\n  POST /v1/x/late (position 1)\n\n' +
        '`declararRiesgoRuta` is not an inert marker: it leaves the class in res.locals and, when the ' +
        'class requires it, applies the idempotency key. Behind the handler that answers it never gets ' +
        'to run, so the route is declared and unprotected at once. Move it to the first place in the chain.'
    );
  });

  it('two declarations on one route', () => {
    const app = appWith((r) =>
      r.post('/twice', declararRiesgoRuta({ riesgo: 'lectura' }), declararRiesgoRuta({ riesgo: 'escritura' }), answer)
    );
    expect(() => auditarRiesgoDeRutas(app)).toThrow(
      '1 route(s) declare their risk more than once:\n  POST /v1/x/twice (2 declarations)\n\n' +
        'A route has ONE class. With two declarations, which one rules is decided by the order of two ' +
        'lines and not by the act the route performs. Keep only one; if there really are two acts of ' +
        'different classes, they are two routes.'
    );
  });

  it('a mutating route with no declaration', () => {
    const app = appWith((r) => r.post('/bare', answer));
    expect(() => auditarRiesgoDeRutas(app)).toThrow(
      '1 mutating route(s) did not declare their risk:\n  POST /v1/x/bare\n\n' +
        'Every POST, PUT, PATCH or DELETE route declares its class with `declararRiesgoRuta` as its FIRST ' +
        'handler, as every CLI leaf declares it next to its registration (src/cli/kernel/risk.ts). ' +
        'Without a declaration there is no telling whether the route writes a draft or posts to the ' +
        'ledger, and the agent has nothing to tell them apart by, which is exactly how the API came to ' +
        'post while skipping the control the CLI declared it did not expose.'
    );
  });
});

// ── the TRUST_PROXY warnings at boot ──

describe('the TRUST_PROXY warnings are English', () => {
  it('unset in production', () => {
    expect(resolverTrustProxy(undefined, 'production').aviso).toBe(
      'TRUST_PROXY is not set. If there is a load balancer or an ingress in front, req.ip is its address ' +
        'for every request and the pre-authentication limiter shares one single bucket among every caller. ' +
        'Declare the trusted hops (e.g. TRUST_PROXY=1) or the proxy networks (TRUST_PROXY=10.0.0.0/8). ' +
        'If the app is exposed directly, this value is the right one.'
    );
  });

  it('true', () => {
    expect(resolverTrustProxy('true').aviso).toBe(
      'TRUST_PROXY=true trusts the WHOLE X-Forwarded-For header, and the caller writes that header: it ' +
        'can claim a different IP on every request and get a fresh rate-limit bucket each time. Prefer ' +
        'the number of proxies in front (TRUST_PROXY=1) or their networks (TRUST_PROXY=10.0.0.0/8), ' +
        'which cannot be forged.'
    );
  });
});

// ── the repeated operationId ──

describe('a repeated operationId is refused in English', () => {
  it('naming both routes', () => {
    const app = express();
    const r = Router();
    r.get('/same', answer);
    app.use('/v1/dup', r);
    app.use('/v1/dup', r);
    expect(() => construirOpenAPI(app)).toThrow(
      /^Two routes produce the same operationId "[^"]+": GET \/v1\/dup\/same and GET \/v1\/dup\/same\. A repeated operationId makes a client generator keep only one of the two, without warning\. Rename one of the routes\.$/
    );
  });
});
