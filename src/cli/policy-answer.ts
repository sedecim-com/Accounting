import type { PolicyOption } from '../services/policy/pending-catalog.js';

// ============================================================
// WHAT A TYPED ANSWER TO A POLICY PROMPT MEANS
//
// Both prompts that resolve a policy — `pending define` and the setup wizard
// (`init`, section 4) — print a numbered list and accept "a number, or a
// free-form value". They used to decide with `Number(answer)`: any string that
// parsed to an integer between 1 and the list length was taken as a POSITION.
//
// That silently saved a value the accountant did not type. `Number('1.00')` is
// 1 and `Number('03')` is 3, so typing an option's own value landed on another
// option. Measured over POLICY_CATALOG, four keys collide:
//
//   prima_vacacional_pct             «1.00» saved «0.25»
//   rep_tolerancia_importe           «1.00» saved «0.01»
//   rep_ventana_dias                 «3»    saved «15»
//   diot_tipo_operacion_por_omision  «03»   saved «bloquear»
//
// The first one is money: 0.25 is the legal minimum, so it passes every domain
// check, and a firm that meant to pay a 100 % vacation premium pays 25 %. The
// collision list is not frozen here on purpose — tests/cli/policy-answer.spec.ts
// recomputes it from the live catalog, so a new option cannot reintroduce the
// defect unnoticed.
//
// THE RULE, in two parts:
//   · Only a canonical positive integer ("3", never "03" or "1.00") can be a
//     position. Anything else is exactly what was typed.
//   · If a canonical integer is ALSO the exact value of a different option,
//     nobody can know which one was meant, so the prompt asks instead of
//     guessing. This is an input-safety rule, not an accounting criterion:
//     it never picks an answer, it only refuses to invent one.
// ============================================================

export type PolicyAnswer =
  | { readonly kind: 'chosen'; readonly value: string }
  | AmbiguousPolicyAnswer;

export interface AmbiguousPolicyAnswer {
  readonly kind: 'ambiguous';
  /** What was typed. */
  readonly typed: string;
  /** The value of the option at that position. */
  readonly byPosition: string;
  /** The option whose value is exactly what was typed. */
  readonly byValue: string;
}

const CANONICAL_POSITION = /^[1-9]\d*$/;

export function interpretPolicyAnswer(answer: string, options: readonly PolicyOption[]): PolicyAnswer {
  const isPosition = CANONICAL_POSITION.test(answer) && Number(answer) <= options.length;
  if (!isPosition) return { kind: 'chosen', value: answer };

  const byPosition = options[Number(answer) - 1].value;
  const exact = options.find((o) => o.value === answer);
  if (exact !== undefined && exact.value !== byPosition) {
    return { kind: 'ambiguous', typed: answer, byPosition, byValue: exact.value };
  }
  return { kind: 'chosen', value: byPosition };
}

/** The follow-up question for an ambiguous answer. */
export function ambiguityQuestion(a: AmbiguousPolicyAnswer): string {
  return (
    `"${a.typed}" is both option ${a.typed} (${a.byPosition}) and the value ${a.byValue}. ` +
    `Type p for option ${a.typed}, v for the value ${a.byValue}, or leave it empty to cancel.`
  );
}

/**
 * The reply to `ambiguityQuestion`: the chosen value, `null` to cancel, or
 * `undefined` when the reply is neither and the question must be asked again.
 */
export function resolveAmbiguity(reply: string, a: AmbiguousPolicyAnswer): string | null | undefined {
  const r = reply.trim().toLowerCase();
  if (r === '') return null;
  if (r === 'p') return a.byPosition;
  if (r === 'v') return a.byValue;
  return undefined;
}
