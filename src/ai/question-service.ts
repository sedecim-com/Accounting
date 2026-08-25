import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import type { AgentContext } from './context.js';

// ============================================================
// AI QUESTION SERVICE (questions + precedents)
// Persistence for the agent's questions and the human answers.
// An answer with is_precedent=true is firm memory: the agent
// consults it before asking again.
// ============================================================

export interface QuestionRow {
  id: string;
  entity_id: string;
  status: 'pending' | 'answered' | 'dismissed';
  question: string;
  context: string | null;
  options: string[] | null;
  topic: string | null;
  answer: string | null;
  answered_by: string | null;
  answered_at: Date | null;
  is_precedent: boolean;
  created_at: Date;
}

const QUESTION_COLUMNS = `id, entity_id, status, question, context, options, topic,
  answer, answered_by, answered_at, is_precedent, created_at`;

export interface CreateQuestionInput {
  question: string;
  context?: string;
  options?: string[];
  topic?: string;
  model: string;
  userRequest?: string;
}

export async function createQuestion(ctx: AgentContext, input: CreateQuestionInput): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO ai_questions (
      id, tenant_id, entity_id, status, question, context, options, topic, ai_model, user_request
    ) VALUES ($1, $2, $3, 'pending', $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      id, ctx.tenantId, ctx.entityId,
      input.question, input.context ?? null,
      input.options ? JSON.stringify(input.options) : null,
      input.topic ?? null, input.model, input.userRequest ?? null,
    ]
  );
  return id;
}

/**
 * Answer a question. Guarded update (pending → answered): a question already
 * resolved elsewhere errors instead of being silently overwritten.
 * Used both by the inline chat flow (immediate answer) and `mnemosine questions`.
 */
export async function answerQuestion(
  ctx: AgentContext,
  questionId: string,
  answer: string,
  answeredBy: string,
  isPrecedent = true
): Promise<void> {
  const result = await query(
    `UPDATE ai_questions
     SET status = 'answered', answer = $1, answered_by = $2, answered_at = NOW(), is_precedent = $3
     WHERE id = $4 AND entity_id = $5 AND status = 'pending'`,
    [answer, answeredBy, isPrecedent, questionId, ctx.entityId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`No pending question with id ${questionId} exists in this entity`);
  }
}

export async function dismissQuestion(ctx: AgentContext, questionId: string, dismissedBy: string): Promise<void> {
  const result = await query(
    `UPDATE ai_questions
     SET status = 'dismissed', answered_by = $1, answered_at = NOW()
     WHERE id = $2 AND entity_id = $3 AND status = 'pending'`,
    [dismissedBy, questionId, ctx.entityId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`No pending question with id ${questionId} exists in this entity`);
  }
}

/**
 * Record an already-answered exchange (chat mode: the user answered inline).
 * Stored as answered from the start so it immediately becomes a precedent.
 */
export async function recordAnsweredQuestion(
  ctx: AgentContext,
  input: CreateQuestionInput & { answer: string; answeredBy: string }
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO ai_questions (
      id, tenant_id, entity_id, status, question, context, options, topic,
      answer, answered_by, answered_at, ai_model, user_request
    ) VALUES ($1, $2, $3, 'answered', $4, $5, $6::jsonb, $7, $8, $9, NOW(), $10, $11)`,
    [
      id, ctx.tenantId, ctx.entityId,
      input.question, input.context ?? null,
      input.options ? JSON.stringify(input.options) : null,
      input.topic ?? null,
      input.answer, input.answeredBy,
      input.model, input.userRequest ?? null,
    ]
  );
  return id;
}

export async function listQuestions(
  ctx: AgentContext,
  status?: QuestionRow['status']
): Promise<QuestionRow[]> {
  const conditions = ['entity_id = $1'];
  const params: unknown[] = [ctx.entityId];
  if (status) {
    conditions.push('status = $2');
    params.push(status);
  }
  const result = await query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM ai_questions
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ASC`,
    params
  );
  return result.rows;
}

/**
 * Precedent search: answered questions marked as precedent, matched by text
 * against question/answer/context/topic. Newest first — the firm's most
 * recent criterion wins.
 */
export async function searchPrecedents(ctx: AgentContext, search: string): Promise<QuestionRow[]> {
  // Escape LIKE metacharacters: the term is model-controlled and a literal
  // '%' or '_' would silently over-match ('%' alone matches everything).
  const escaped = search.replace(/[\\%_]/g, (m) => '\\' + m);
  const result = await query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM ai_questions
     WHERE entity_id = $1 AND status = 'answered' AND is_precedent = true
       AND (question ILIKE $2 OR answer ILIKE $2 OR context ILIKE $2 OR topic ILIKE $2)
     ORDER BY answered_at DESC
     LIMIT 20`,
    [ctx.entityId, `%${escaped}%`]
  );
  return result.rows;
}
