import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { estadisticasDelAgente } from '../ai/stats-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  describeCommand,
  render,
  withContext,
  withOutput,
  resolveActiveEntity,
  exitCodeFor,
  type Row,
} from './kernel/index.js';
import { t } from '../i18n/index.js';
import { FLOOR_SOMBRA_ACUERDO, FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_VEREDICTOS } from '../ai/floor.js';

// ============================================================
// mnemosine ai
//
// La familia de MÉTRICAS del agente — no de sus capacidades. Todo lo que
// el agente hace ya vive en otras familias (drafts, review, questions,
// ingest); aquí vive lo que el agente ES: qué tan calibrado está lo que
// reporta, cuánto cuesta, cuánto tarda, cuántas veces tropezó.
//
// `ai stats` existe para una decisión concreta: el panel pregunta si
// ingest_auto_post se enciende, y «medir antes de soltar» exige que la
// respuesta se apoye en la aprobación por bucket de confianza y el delta
// confianza-vs-realidad — no en la impresión del último demo. La tabla
// (stdout) es la calibración; el resumen operativo va a stderr para no
// ensuciar un pipe.
// ============================================================

export interface AiCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface StatsOpts {
  entity?: string;
  tenant?: string;
  format?: string;
  json?: boolean;
  output?: string;
  fields?: string | boolean;
  quiet?: boolean;
}

export function registerAiCommand(program: Command, deps: AiCommandDeps): void {
  const ai = describeCommand(program.command('ai').alias('ia'), 'help.ai.description');

  const note = (message: string) => process.stderr.write(deps.palette.dim(`${message}\n`));
  const warn = (message: string) => process.stderr.write(deps.palette.yellow(`${message}\n`));

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // ---- ai stats -----------------------------------------------------
  const stats = describeCommand(ai.command('stats').alias('estadisticas'), 'help.ai.stats.description');
  withOutput(withContext(stats));
  declareRisk(stats, { risk: 'lectura', agent: true });
  stats.action((opts: StatsOpts) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity(
        { entity: opts.entity },
        { home: deps.home, warn }
      );

      const est = await estadisticasDelAgente(ctx);
      const r = est.resumen;

      note(t('platform.ai.stats.header', { entity: ctx.entityName, drafts: r.borradores_total, decided: r.decididos }));
      const rows: Row[] = est.buckets.map((b) => ({
        bucket: b.bucket,
        borradores: b.borradores,
        humano: b.aprobados_humano,
        politica: b.aprobados_politica,
        auto: b.auto_posteados,
        rechazados: b.rechazados,
        pendientes: b.pendientes,
        confianza_media: b.confianza_media ?? '—',
        tasa_aprobacion: b.tasa_aprobacion ?? '—',
        delta: b.delta ?? '—',
      }));
      render(rows, { ...opts, idField: 'bucket' });

      // El resumen operativo, a stderr: legible para el humano, invisible
      // para un pipe que consume la tabla.
      if (r.tasa_intervencion_humana !== null) {
        note(
          t('platform.ai.stats.human_intervention', {
            rate: r.tasa_intervencion_humana,
            human: r.aprobados_humano,
            rejected: r.rechazados,
            decided: r.decididos,
            policy: r.aprobados_politica,
            auto: r.auto_posteados,
          })
        );
      }
      if (r.corridas_ingesta > 0) {
        note(
          t('platform.ai.stats.ingest', {
            runs: r.corridas_ingesta,
            drafts: r.borradores_de_ingesta,
            priced: r.costo_por_borrador_usd !== null ? 'yes' : 'no',
            perDraft: r.costo_por_borrador_usd ?? '',
            total: r.costo_ingesta_usd ?? '',
          })
        );
      }
      if (r.llamadas_con_duracion > 0) {
        note(
          t('platform.ai.stats.latency', {
            average: r.duracion_promedio_ms ?? '—',
            p95: r.duracion_p95_ms ?? '—',
            calls: r.llamadas_con_duracion,
          })
        );
      }
      note(
        t('platform.ai.stats.events', {
          suspicions: r.eventos.sospecha,
          nudges: r.eventos.nudge,
          failovers: r.eventos.failover,
        })
      );
      if (est.sombra.veredictos > 0) {
        // The floors come from the rule itself (src/ai/floor.ts), so this line
        // cannot say something the panel does not enforce.
        note(
          t('platform.ai.stats.shadow', {
            verdicts: est.sombra.veredictos,
            days: est.sombra.dias_con_veredictos,
            decided: est.sombra.decididos,
            agreement: est.sombra.tasa_acuerdo ?? '—',
            minDays: FLOOR_SOMBRA_DIAS,
            minDecided: FLOOR_SOMBRA_VEREDICTOS,
            minAgreement: FLOOR_SOMBRA_ACUERDO.toFixed(2),
          })
        );
      }
    })
  );
}
