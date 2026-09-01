import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { estadisticasDelAgente } from '../ai/stats-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  resolveActiveEntity,
  exitCodeFor,
  type Row,
} from './kernel/index.js';

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
  const ai = program
    .command('ai')
    .alias('ia')
    .description('Métricas y calibración del agente contable');

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
  const stats = ai
    .command('stats')
    .alias('estadisticas')
    .description('Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos');
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

      note(`ai stats · ${ctx.entityName} · ${r.borradores_total} borrador(es), ${r.decididos} decidido(s)`);
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
          `intervención humana ${r.tasa_intervencion_humana} ` +
            `(${r.aprobados_humano} aprobados + ${r.rechazados} rechazados de ${r.decididos} decididos; ` +
            `${r.aprobados_politica} por política, ${r.auto_posteados} auto-posteados)`
        );
      }
      if (r.corridas_ingesta > 0) {
        note(
          `ingesta: ${r.corridas_ingesta} corrida(s), ${r.borradores_de_ingesta} borrador(es)` +
            (r.costo_por_borrador_usd !== null
              ? `, ~$${r.costo_por_borrador_usd} USD por borrador (total $${r.costo_ingesta_usd})`
              : ', costo no estimable (modelo sin precio)')
        );
      }
      if (r.llamadas_con_duracion > 0) {
        note(
          `latencia del modelo: ${r.duracion_promedio_ms} ms promedio, ` +
            `${r.duracion_p95_ms} ms p95 (${r.llamadas_con_duracion} llamada(s) medidas)`
        );
      }
      note(
        `eventos: ${r.eventos.sospecha} sospecha(s) de inyección, ` +
          `${r.eventos.nudge} nudge(s) de grounding, ${r.eventos.failover} failover(s)`
      );
      if (est.sombra.veredictos > 0) {
        note(
          `sombra: ${est.sombra.veredictos} veredicto(s) en ${est.sombra.dias_con_veredictos} día(s), ` +
            `${est.sombra.decididos} decidido(s) por humano, acuerdo ${est.sombra.tasa_acuerdo ?? '—'} ` +
            `(encender 'on' exige ≥7 días, ≥10 decididos y ≥0.90)`
        );
      }
    })
  );
}
