import type { RequestHandler } from 'express';
import type { GatewayConfig } from './config.js';
import { PROXY_PREFIX } from './routes.js';

// ============================================================
// RESPONSE HARDENING, BY HAND
//
// Not through helmet: its defaults are written for a server that renders
// pages, and the two policies here are narrower than any default.
//
// The SPA policy allows only same-origin script, style, fonts, images and
// fetches, no inline anything, no base or form targets, no framing, and
// Trusted Types with no policy at all: in a browser that enforces it, every
// HTML sink (innerHTML and friends) throws. Entity names, draft descriptions
// and questions are third-party strings; with this policy one of them cannot
// become script that drives the proxy with the session.
//
// Responses relayed from /v1 get the API policy instead: nothing loads, and
// the document is sandboxed if a browser is ever made to render one.
// ============================================================

export const SPA_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

export const API_CONTENT_SECURITY_POLICY = ["default-src 'none'", "frame-ancestors 'none'", 'sandbox'].join('; ');

const HARDENING_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['X-Frame-Options', 'DENY'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
];

export function isProxiedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === PROXY_PREFIX || lower.startsWith(`${PROXY_PREFIX}/`);
}

export function createSecurityHeaders(config: Pick<GatewayConfig, 'publicOrigin'>): RequestHandler {
  const https = new URL(config.publicOrigin).protocol === 'https:';
  return function securityHeaders(req, res, next) {
    for (const [name, value] of HARDENING_HEADERS) res.setHeader(name, value);
    res.setHeader(
      'Content-Security-Policy',
      isProxiedPath(req.path) ? API_CONTENT_SECURITY_POLICY : SPA_CONTENT_SECURITY_POLICY
    );
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
