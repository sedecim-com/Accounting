import { withTransaction } from '../../database/connection.js';
import { AccountingError, NotFoundError, type ErrorMessageKey } from '../../utils/errors.js';
import { getDecision, type DecisionPoint } from './cfdi-decisions.js';
import { CODABLE_STATUSES } from './pre-registration-coding.js';

// ============================================================
// MNE-001-906 (#1075), part 1 · A PERSON ANSWERS A HELD CFDI, PER DOCUMENT.
//
// `bill inbox run` holds a received CFDI on a blocking decision of
// cfdi-decisions.ts, and until now nothing could hand the classifier the
// answer: the door passed it the firm's panel keys and nothing else, so a CFDI
// held on a fact of that one document (its payment form is wrong; this
// purchase is an asset) could not enter by the inbox at all.
//
// The answer lives where migration 015 reserved its place, in the trail:
// `cfdi_classifications.decisions`, on the element of the decision, with who
// gave it and when. The next run reads it in the statement that already reads
// the XML (pre-registration-service.ts, `planDeAsiento`).
//
// ONE RULE SAYS WHICH DECISIONS, read from the decision's own options: a
// blocking decision is answered per document when EVERY option names the role
// it posts to, because that is the only kind of answer the classifier turns
// into an entry (`resolveRoleOverride`). The decisions whose options carry no
// role (a new vendor, a closed period, a cancelled CFDI) are refused: the
// classifier only asks whether an answer exists, so «do not record» would
// release the CFDI and post it.
// ============================================================

/** A decision as the trail keeps it: what the classifier asked, and the person's answer once given. */
export interface TrailDecision {
  id: string;
  severity?: string;
  options?: Array<{ value: string; label?: string }>;
  answer?: string;
  /** The user id of the person who answered. */
  answered_by?: string;
  /** ISO timestamp. */
  answered_at?: string;
}

/** True for a decision a person answers for one CFDI: blocking, and every option says where it posts. */
export function answeredPerDocument(d: DecisionPoint | undefined): d is DecisionPoint {
  return d !== undefined && d.severity === 'blocking' && d.options.length > 0 && d.options.every((o) => o.role);
}

const asTrail = (decisions: unknown): TrailDecision[] => (Array.isArray(decisions) ? (decisions as TrailDecision[]) : []);

/** The answers a trail holds, as the classifier takes them: `{ decisionId: value }`. */
export function documentAnswers(decisions: unknown): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const d of asTrail(decisions)) {
    if (typeof d.answer === 'string' && answeredPerDocument(getDecision(d.id))) answers[d.id] = d.answer;
  }
  return answers;
}

/** The pending decisions of a classification that this verb answers, with the options each one offered. */
export function answerablePending(decisions: unknown): TrailDecision[] {
  return asTrail(decisions).filter((d) => d.answer === undefined && answeredPerDocument(getDecision(d.id)));
}

/** Each decision with the values it offers, as `id = a | b; …`, for the refusal that says how to answer. */
export const optionsText = (pending: TrailDecision[]): string =>
  pending.map((d) => `${d.id} = ${(d.options ?? []).map((o) => o.value).join(' | ')}`).join('; ');

/** An answer that is kept while the CFDI stays held, and why its entry cannot be posted yet. */
export interface AnswerWithoutEntry {
  decision: string;
  answer: string;
  role: string;
  why: 'not_followed' | 'off_role_account';
  /** `off_role_account`: the code of the account of the role, where the amount should land. */
  account?: string;
}

/** What the door would post, as far as an answer is judged against it. */
export interface EntryToJudge {
  /** The roles of the classifier's lines. */
  lineRoles: ReadonlySet<string>;
  /** `PlanDeAsiento.openedOffRoleAccount`: roles whose amount the plan put on other accounts. */
  openedOffRoleAccount: Readonly<Record<string, string | undefined>>;
}

/**
 * The first stored answer the entry cannot honour yet, or null. The door never
 * posts an entry that ignores what a person answered; holding is what it did
 * before the answer existed.
 *
 * `not_followed`: no line of the classifier sits on the role the answer names.
 * It follows one answer per CFDI, and only on a case that has an expense line.
 *
 * `off_role_account`: the classifier follows the answer, but the posting plan
 * opens that role into the document's lines and at least one is coded to an
 * account that is not the role's, so the amount would not land where the answer
 * says. Coding the lines to that account releases it.
 *
 * An answer that names the plain expense role asks for no change: it is judged
 * only when no other answer moves the expense, and never by the lines' accounts,
 * which are the person's own coding of an expense.
 *
 * MNE-001-906, part 2: «non-deductible» is judged like any other answer since
 * its entry exists (cfdi-classifier.ts takes the IVA with the expense, and the
 * plan posts that role to its own account).
 */
export function answerWithoutEntry(answers: Record<string, string>, entry: EntryToJudge): AnswerWithoutEntry | null {
  const asked = Object.entries(answers).flatMap(([decision, answer]) => {
    const role = getDecision(decision)?.options.find((o) => o.value === answer)?.role;
    return role ? [{ decision, answer, role }] : [];
  });
  const moves = asked.filter((a) => a.role !== 'gasto');
  const unmet = (moves.length > 0 ? moves : asked).find((a) => !entry.lineRoles.has(a.role));
  if (unmet) return { ...unmet, why: 'not_followed' };
  const off = moves.find((a) => entry.openedOffRoleAccount[a.role] !== undefined);
  return off ? { ...off, why: 'off_role_account', account: entry.openedOffRoleAccount[off.role] } : null;
}

export interface HeldDecisionAnswer {
  preRegistrationId: string;
  cfdiUuid: string;
  decision: string;
  answer: string;
  answeredBy: string;
  answeredAt: string;
}

const invalid = (message: ErrorMessageKey) => new AccountingError('CFDI_ANSWER_INVALID', message);

/**
 * Keeps a person's answer to one decision a CFDI is held on. Two statements:
 * the pre-registration with its trail, locked, and the write. Nothing is
 * posted here: `bill inbox run` does that, with the answer.
 */
export async function answerHeldDecision(
  entityId: string,
  preRegistrationId: string,
  input: { decision: string; answer: string },
  userId: string
): Promise<HeldDecisionAnswer> {
  return withTransaction(async (client) => {
    // The lock on the pre-registration orders two answers to the same document.
    const found = await client.query<{
      status: string; bill_id: string | null; journal_entry_id: string | null;
      cfdi_uuid: string | null; trail_id: string | null; decisions: unknown;
    }>(
      `SELECT pr.status, pr.bill_id, pr.journal_entry_id, x.cfdi_uuid, cc.id AS trail_id, cc.decisions
         FROM pre_registrations pr
         LEFT JOIN xml_documents x ON x.id = pr.xml_document_id AND x.entity_id = pr.entity_id
         LEFT JOIN cfdi_classifications cc ON cc.entity_id = pr.entity_id AND cc.cfdi_uuid = x.cfdi_uuid
        WHERE pr.id = $1 AND pr.entity_id = $2
          FOR UPDATE OF pr`,
      [preRegistrationId, entityId]
    );
    const pre = found.rows[0];
    if (!pre) throw new NotFoundError('Pre-registration', preRegistrationId);
    if (pre.bill_id || pre.journal_entry_id || !(CODABLE_STATUSES as readonly string[]).includes(pre.status)) {
      throw new AccountingError('CFDI_ANSWER_NOT_OPEN', {
        key: 'error.CFDI_ANSWER_NOT_OPEN',
        params: { id: preRegistrationId, status: pre.status },
      });
    }

    const decisions = asTrail(pre.decisions);
    const asked = decisions.find((d) => d.id === input.decision);
    if (!asked) {
      const held = decisions.filter((d) => answeredPerDocument(getDecision(d.id))).map((d) => d.id);
      throw invalid({
        key: 'error.CFDI_ANSWER_INVALID.not_asked',
        params: { id: preRegistrationId, decision: input.decision, held: held.join(', ') || 'none' },
      });
    }
    if (!answeredPerDocument(getDecision(asked.id))) {
      throw invalid({ key: 'error.CFDI_ANSWER_INVALID.not_per_document', params: { decision: asked.id } });
    }
    const offered = (asked.options ?? []).map((o) => o.value);
    if (!offered.includes(input.answer)) {
      throw invalid({
        key: 'error.CFDI_ANSWER_INVALID.unknown_option',
        params: { decision: asked.id, value: input.answer, options: offered.join(', ') },
      });
    }

    const answeredAt = new Date().toISOString();
    asked.answer = input.answer;
    asked.answered_by = userId;
    asked.answered_at = answeredAt;
    await client.query(
      `UPDATE cfdi_classifications SET decisions = $3::jsonb, updated_at = NOW() WHERE id = $1 AND entity_id = $2`,
      [pre.trail_id, entityId, JSON.stringify(decisions)]
    );
    return {
      preRegistrationId,
      cfdiUuid: pre.cfdi_uuid as string,
      decision: asked.id,
      answer: input.answer,
      answeredBy: userId,
      answeredAt,
    };
  });
}
