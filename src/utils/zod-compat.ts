import { z } from 'zod';

// ============================================================
// CONTRACT: one helper per validation whose grammar zod 4 changes (#367).
//
// The owner's decision on #367 is that the Zod 4 migration accepts and
// rejects exactly what zod 3.25.76 did, and parses to the same output. Zod 4
// changes five grammars the REST bodies and the config file use:
//
//   uuidString     v4 `.uuid()` is RFC 9562 (version and variant nibbles);
//                  v3 accepted any 8-4-4-4-12 hex, and so must we.
//   emailString    v4 rewrote the email regex.
//   urlString      v4 trims the input before parsing it and returns the
//                  normalized URL; v3 parsed the raw string and kept it.
//   boundedString  v4 counts string lengths in code points; v3 counted
//                  UTF-16 units, and so does every published maxLength.
//   integerNumber  v4 stops at a failed `.int()`; v3 went on to report the
//                  bounds after it too.
//
// Every route and config schema builds those validations through here, so
// the grammar lives in one file per Zod major. On zod 3 each helper is the
// native method, and the goldens (tests/api/golden) pin what they do.
// ============================================================

/** Any 8-4-4-4-12 hex string, in either case. */
export function uuidString(message?: string): z.ZodString {
  return z.string().uuid(message);
}

export function emailString(): z.ZodString {
  return z.string().email();
}

/** Whatever `new URL()` parses, kept exactly as sent. */
export function urlString(): z.ZodString {
  return z.string().url();
}

export interface StringBounds {
  min?: number;
  max?: number;
  length?: number;
}

export interface StringBoundMessages {
  min?: string;
  max?: string;
  length?: string;
}

/** A string whose bounds count UTF-16 units, checked in the fixed order min, max, length. */
export function boundedString(bounds: StringBounds, messages: StringBoundMessages = {}): z.ZodString {
  let schema = z.string();
  if (bounds.min !== undefined) schema = schema.min(bounds.min, messages.min);
  if (bounds.max !== undefined) schema = schema.max(bounds.max, messages.max);
  if (bounds.length !== undefined) schema = schema.length(bounds.length, messages.length);
  return schema;
}

/** An integer whose failure does not hide the bounds chained after it. */
export function integerNumber(): z.ZodNumber {
  return z.number().int();
}
