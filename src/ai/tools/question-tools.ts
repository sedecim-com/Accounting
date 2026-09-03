import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';
import {
  createQuestion,
  recordAnsweredQuestion,
  searchPrecedents,
} from '../question-service.js';
import { groupConflicts, type ConflictScope } from '../memory-service.js';

// ============================================================
// QUESTION TOOLS (questions + precedents)
// ask_user: human-in-the-loop channel. In chat the question is
// answered inline and stored as a precedent; with no human
// available it stays 'pending' for `mnemosine questions`.
// search_precedents: the firm's memory — already-resolved
// criteria the agent must consult BEFORE asking.
// ============================================================

// ============================================================
// LA FORMA DE LO QUE EL MODELO RECIBE ESTÁ CERRADA
//
// Este es el objeto que el modelo lee cuando la memoria del despacho se
// contradice, y es exactamente donde la autonomía se ampliaría sin que
// nadie lo decidiera: un campo de conveniencia —`prevailing` con el
// precedente más reciente, `suggested`, `winner`, `applies`— no sería un
// dato más. Sería el sistema entregando un GANADOR calculado por fecha
// dentro del mismo objeto en el que dice, por escrito, que sólo un humano
// resuelve el conflicto. Y el modelo obedece al campo, no a la nota.
//
// Por eso el resultado se declara como TIPO en vez de construirse suelto:
// un campo nuevo deja de compilar en silencio. La prueba cierra por su lado
// el juego de claves del JSON que sale de verdad — el tipo ata la forma en
// compilación y la prueba ata el efecto en ejecución.
// ============================================================
interface SearchPrecedentsResult {
  count: number;
  conflicts?: Array<{ competing_for: string; grouped_by: ConflictScope; answers: string[] }>;
  conflict_note?: string;
  precedents: Array<{
    question: string;
    answer: string | null;
    context: string | null;
    topic: string | null;
    answered_by: string | null;
    answered_at: Date | null;
  }>;
}

export function buildQuestionTools(ctx: AgentContext, deps: ToolDeps) {
  const askUserTool = betaZodTool({
    name: 'ask_user',
    description:
      'Asks the human user when a question BLOCKS the work (uncertain account, ambiguous accounting ' +
      'treatment, unknown vendor/customer). BEFORE using it: search in search_precedents ' +
      'and in search_journal_entries — ask only if there is no precedent. In interactive mode you get ' +
      'the answer immediately; if the user is unavailable, the question is recorded for ' +
      '`mnemosine questions` and you must continue without inventing data (or make clear what was blocked). ' +
      'The answer is stored as a precedent for the future.',
    inputSchema: z.object({
      question: z.string().min(1).max(1000).describe('The question, concrete and self-contained'),
      context: z
        .string()
        .max(2000)
        .optional()
        .describe('Context to decide: vendor, amount, document, what you found and what is missing'),
      options: z
        .array(z.string().min(1))
        .min(2)
        .max(5)
        .optional()
        .describe('Suggested options if the question is multiple-choice (e.g. candidate accounts)'),
      topic: z
        .string()
        .max(255)
        .optional()
        .describe('Topic slug for precedents, e.g. "clasificacion:Servicios Integrales SA"'),
    }),
    run: async (input) => {
      deps.observe?.('ask_user', input);

      if (deps.askUser) {
        const answer = await deps.askUser({
          question: input.question,
          context: input.context,
          options: input.options,
        });
        if (answer !== null && answer.trim()) {
          // The human answer is NEVER lost due to a persistence failure:
          // if the INSERT fails, it is still returned with a warning.
          const trimmed = answer.trim();
          let precedentId: string | null = null;
          let warning: string | undefined;
          try {
            precedentId = await recordAnsweredQuestion(ctx, {
              question: input.question,
              context: input.context,
              options: input.options,
              topic: input.topic,
              model: deps.model,
              userRequest: deps.userRequestRef?.current,
              answer: trimmed,
              answeredBy: 'chat',
            });
          } catch (err) {
            warning =
              'The answer could NOT be saved as a precedent (database error); use it anyway.';
            deps.observe?.('ask_user:persist_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return JSON.stringify({
            answered: true,
            answer: trimmed,
            ...(precedentId
              ? { precedent_id: precedentId, note: "The user's answer. It was saved as a precedent; use it and cite it." }
              : { warning }),
          });
        }
        // User declined / EOF: fall through to the pending path.
      }

      const id = await createQuestion(ctx, {
        question: input.question,
        context: input.context,
        options: input.options,
        topic: input.topic,
        model: deps.model,
        userRequest: deps.userRequestRef?.current,
      });
      return JSON.stringify({
        answered: false,
        question_id: id,
        note:
          'No immediate answer (the user declined to answer now or is unavailable); ' +
          'the question was recorded for `mnemosine questions`. ' +
          'Continue with what you can WITHOUT inventing data and state explicitly what was blocked.',
      });
    },
  });

  const searchPrecedentsTool = betaZodTool({
    name: 'search_precedents',
    description:
      'Searches precedents: questions already resolved by the firm (classification criteria, ' +
      'vendor treatment, policies). ALWAYS consult it before ask_user and before ' +
      'classifying doubtful operations. The most recent precedent prevails — EXCEPT when the ' +
      'result flags a conflict: two active precedents answering the same decision differently ' +
      'are not a recency question, they are an unresolved one, and only a human resolves them.',
    inputSchema: z.object({
      search: z.string().min(1).describe('Text to search: vendor, description, account, topic'),
    }),
    run: async (input) => {
      deps.observe?.('search_precedents', input);
      const rows = await searchPrecedents(ctx, input.search);
      if (rows.length === 0) return 'No precedents for that search.';

      // DONDE MÁS IMPORTA: en el momento de usarlos.
      //
      // `doctor` encuentra los conflictos cuando alguien corre `doctor`; el
      // modelo se topa con ellos AQUÍ, clasificando una factura. Sin esto la
      // regla «prevalece el más reciente» resuelve por él una contradicción
      // de criterio contable, en silencio y sin dejar rastro de que había
      // dos. Marcarla no la resuelve —no es del sistema resolverla— pero
      // convierte una elección invisible en una pregunta.
      const conflictos = groupConflicts(rows);

      // Sin `...spread`: el spread de un objeto condicional se cuela por
      // delante del chequeo de propiedades sobrantes, y lo que aquí importa
      // es justamente que no entre una clave que nadie declaró. Las claves
      // ausentes se escriben `undefined`: JSON.stringify no las emite, así
      // que la salida es la misma y la forma queda atada.
      const salida: SearchPrecedentsResult = {
        count: rows.length,
        conflicts:
          conflictos.length > 0
            ? conflictos.map((c) => ({
                competing_for: c.key,
                grouped_by: c.scope,
                answers: c.answers,
              }))
            : undefined,
        conflict_note:
          conflictos.length > 0
            ? 'CONFLICT: these precedents give different answers for the same decision. Do NOT ' +
              'pick one on your own and do NOT fall back on the most recent: say out loud that ' +
              'the firm holds two contradicting criteria, use ask_user so a human decides which ' +
              'one stands, and keep working on what does not depend on it. The human resolves ' +
              'it with `mnemosine memory --conflicts`.'
            : undefined,
        precedents: rows.map((r) => ({
          question: r.question,
          answer: r.answer,
          context: r.context,
          topic: r.topic,
          answered_by: r.answered_by,
          answered_at: r.answered_at,
        })),
      };
      return JSON.stringify(salida);
    },
  });

  return [askUserTool, searchPrecedentsTool];
}
