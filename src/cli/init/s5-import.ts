import fs from 'node:fs';
import path from 'node:path';
import { query } from '../../database/connection.js';
import { resolveEntity, type AgentContext } from '../../ai/context.js';
import { resolveReviewer, type Reviewer } from '../../ai/draft-service.js';
import {
  planOnboarding,
  executeOnboarding,
  type OnboardingPlan,
  type OnboardingResult,
} from '../../ai/onboarding-service.js';
import { ingestCfdiFiles, type DraftCapture, type IngestReport } from '../../ai/ingest-service.js';
import { conCorridaRegistrada } from '../../ai/ingest-runs.js';
import { SUPERFICIE_INGESTA } from '../../ai/tools/superficie.js';
import { clampTokenCount, estimateCostUsd } from '../../ai/usage-ledger.js';
import {
  createLlmSession,
  resolveProfile,
  type LlmSession,
  type ResolvedProfile,
  type SessionCallbacks,
} from '../../ai/providers/index.js';
import { resolveIngestThresholds } from '../../ai/providers/config.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S5 · BRING YOUR ACCOUNTING IN
// The friendliest possible on-ramp: the system is most useful
// when it sees real books, so the wizard closes by offering to
// load them. Three doors, none of them scary:
//   1. Import from another accounting system by API (Contalink)
//      — plan → confirm → execute, on top of the EXISTING
//      onboarding service (thin orchestration only).
//   2. Ingest CFDI XML files from a folder — the EXISTING ingest
//      pipeline, auto-post OFF: everything lands as drafts.
//   3. Start fresh — the default. Never surprise-import.
// Everything lands as reviewable drafts; nothing posts without a
// human. No secrets are prompted here: the Contalink key lives
// in .env, never in the config.
// ============================================================

/** First-run cap so an accidental point at a huge folder stays reviewable. */
export const XML_FIRST_RUN_CAP = 50;

interface ImportCounts {
  entries: number;
  xmls: number;
  onboardingDrafts: number;
}

export interface ImportSectionDeps {
  resolveEntity?: typeof resolveEntity;
  resolveReviewer?: (tenantId: string, email?: string) => Promise<Reviewer>;
  planOnboarding?: (
    ctx: AgentContext, provider: string, startDate: string, cutoffDate: string
  ) => Promise<OnboardingPlan>;
  executeOnboarding?: (
    ctx: AgentContext, plan: OnboardingPlan, reviewer: Reviewer,
    opts?: { balanceAccountCode?: string; postNow?: boolean }
  ) => Promise<OnboardingResult>;
  ingest?: typeof ingestCfdiFiles;
  /** Resolves the provider profile the batch is classified with. */
  resolveProfile?: (provider?: string, model?: string) => ResolvedProfile;
  /**
   * Builds the LLM session the ingest pipeline classifies with.
   *
   * Takes the RESOLVED profile rather than resolving one of its own: the run
   * row of `ai_ingest_runs` opens with `provider` and `model` BEFORE the first
   * file, so the wizard has to know which profile it is about to use — and a
   * session built from a second, separately resolved profile would write a row
   * naming a model that never classified anything.
   */
  createSession?: (
    profile: ResolvedProfile,
    ctx: AgentContext,
    callbacks: SessionCallbacks
  ) => Promise<LlmSession>;
  /** Environment to read CONTALINK_API_KEY from (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Lists *.xml files in a folder, absolute paths (injectable for tests). */
  listXmlFiles?: (dir: string) => string[];
}

function defaultListXmlFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xml'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * B3 · LA MISMA SUPERFICIE RECORTADA QUE `mnemosine ingest`, EN EL ALTA.
 *
 * Esta fábrica construía la sesión sin pasar lista, así que el alta recibía
 * las 25 herramientas —`external_pull`, `external_push` y
 * `external_diff_trial_balance` incluidas, contra el sistema del cliente y con
 * su credencial— por el mismo camino de clasificación por lotes que A7·3 ya
 * había recortado en la hoja de `ingest`. Aquello arregló la INSTANCIA; la
 * clase son los DOS caminos que clasifican carpetas enteras, y éste es el
 * segundo.
 *
 * No hay lista propia: es la MISMA `SUPERFICIE_INGESTA`. Dos listas para el
 * mismo trabajo divergirían, y la que se olvidara sería la que un día vuelva a
 * llevarse el brazo externo puesto.
 *
 * Se exporta para que el guardián pueda ejercerla: comprobar el NOMBRE de la
 * lista en el fuente es lo que dejó pasar un `.concat([...])` con la cola
 * hacia fuera dentro.
 */
export async function defaultCreateSession(
  profile: ResolvedProfile,
  ctx: AgentContext,
  callbacks: SessionCallbacks
): Promise<LlmSession> {
  // Batch classification pipeline: the grounding corrective turn is
  // harness-initiated and must not add drafts behind the wizard's back.
  return createLlmSession(profile, ctx, callbacks, {
    grounding: { enabled: false },
    herramientas: SUPERFICIE_INGESTA,
  });
}

export class ImportSection implements SetupSection {
  readonly id = 'importar' as const;
  readonly title = 'Bring your accounting in';
  /** Never blocks setup: starting fresh is a legitimate answer. */
  readonly required = false;

  private readonly deps: Required<ImportSectionDeps>;

  constructor(deps: ImportSectionDeps = {}) {
    this.deps = {
      resolveEntity: deps.resolveEntity ?? resolveEntity,
      resolveReviewer: deps.resolveReviewer ?? resolveReviewer,
      planOnboarding: deps.planOnboarding ?? planOnboarding,
      executeOnboarding: deps.executeOnboarding ?? executeOnboarding,
      ingest: deps.ingest ?? ingestCfdiFiles,
      resolveProfile: deps.resolveProfile ?? resolveProfile,
      createSession: deps.createSession ?? defaultCreateSession,
      env: deps.env ?? process.env,
      listXmlFiles: deps.listXmlFiles ?? defaultListXmlFiles,
    };
  }

  /** One round trip: entries, ingested XMLs and unapproved onboarding drafts. */
  private async counts(entityId: string): Promise<ImportCounts> {
    const result = await query<{ entries: string; xmls: string; onboarding_drafts: string }>(
      `SELECT
         (SELECT COUNT(*) FROM journal_entries
            WHERE entity_id = $1 AND status != 'void')::text AS entries,
         (SELECT COUNT(*) FROM xml_documents WHERE entity_id = $1)::text AS xmls,
         (SELECT COUNT(*) FROM ai_drafts
            WHERE entity_id = $1 AND status = 'pending_review'
              AND payload->>'reference' LIKE 'onboarding:%')::text AS onboarding_drafts`,
      [entityId]
    );
    const row = result.rows[0];
    return {
      entries: parseInt(row.entries, 10),
      xmls: parseInt(row.xmls, 10),
      onboardingDrafts: parseInt(row.onboarding_drafts, 10),
    };
  }

  async status(): Promise<SectionStatus> {
    try {
      const entity = await this.deps.resolveEntity(undefined);
      const c = await this.counts(entity.entityId);
      // An unapproved onboarding draft means an import is mid-flight: the
      // opening balance exists but has not reached the books yet.
      if (c.onboardingDrafts > 0) return 'partial';
      if (c.entries > 0 || c.xmls > 0) return 'ok';
      return 'missing';
    } catch {
      return 'missing';
    }
  }

  async configure(ctx: SectionContext): Promise<void> {
    let entity: AgentContext;
    try {
      entity = await this.deps.resolveEntity(ctx.flags.entity);
    } catch {
      ctx.print('  No entity resolved yet; the import comes after the entity exists.');
      return;
    }

    // Explain BEFORE asking (house idiom): why, and what happens to the data.
    ctx.print('');
    ctx.print('  Why I ask: mnemosine is most useful when it sees your real books.');
    ctx.print('  What I do: everything lands as reviewable drafts — nothing posts without you.');
    ctx.print('');
    ctx.print('  How would you like to start?');
    ctx.print('    1) Import from another accounting system by API (Contalink today)');
    ctx.print('    2) Ingest CFDI XML files from a folder');
    ctx.print('    3) Start fresh — you can import anytime later');

    // --yes mode must not ask, and an import is never a surprise default.
    if (!ctx.rl || ctx.flags.yes) {
      ctx.print('');
      ctx.print('  Non-interactive mode: starting fresh. You can import anytime: mnemosine onboard --help');
      return;
    }

    const raw = await ctx.askText('  Choice [1/2/3] (3): ', '3');
    const choice = (raw ?? '3').trim() || '3';

    if (choice === '1') {
      await this.importByApi(ctx, entity);
    } else if (choice === '2') {
      await this.ingestFolder(ctx, entity);
    } else {
      ctx.print('  Starting fresh. You can import anytime: mnemosine onboard --help');
    }
  }

  /** [1] Plan → confirm → execute over the existing onboarding service. */
  private async importByApi(ctx: SectionContext, entity: AgentContext): Promise<void> {
    const provider =
      (await ctx.askText('  External system (contalink): ', 'contalink')) ?? 'contalink';

    if (provider === 'contalink' && !this.deps.env.CONTALINK_API_KEY) {
      // No dead end: the exact line to add, and where the flow resumes.
      ctx.print('');
      ctx.print('  The contalink provider needs an API key that is not set yet.');
      ctx.print('  Add this line to your .env (the key never goes in the config):');
      ctx.print('    CONTALINK_API_KEY=<your key>');
      ctx.print('  Then re-run: mnemosine init --section import');
      ctx.print('  Section left incomplete for now.');
      return;
    }

    const cutoff = await ctx.askText('  Cutoff date, balances as of YYYY-MM-DD: ');
    if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff.trim())) {
      ctx.print('  The cutoff must be YYYY-MM-DD. Nothing was imported — re-run when ready:');
      ctx.print('    mnemosine init --section import');
      return;
    }
    const cutoffDate = cutoff.trim();
    const startDate = `${cutoffDate.slice(0, 4)}-01-01`;

    let plan: OnboardingPlan;
    try {
      ctx.print('  Reading the remote trial balance…');
      plan = await this.deps.planOnboarding(entity, provider, startDate, cutoffDate);
    } catch (err) {
      ctx.print(`  Could not plan the import: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Nothing was created. Full control over the import: mnemosine onboard --help');
      return;
    }

    ctx.print('');
    ctx.print(
      `  Remote accounts: ${plan.remoteAccounts} · already exist: ${plan.existingAccounts} · ` +
        `to create: ${plan.accountsToCreate.length}`
    );
    ctx.print(
      `  Opening balance: ${plan.openingLines.length} line(s) · ` +
        `debits ${plan.totals.debits} · credits ${plan.totals.credits}`
    );
    if (plan.openingLines.length === 0) {
      ctx.print('  Nothing to import: the remote trial balance has no balances.');
      return;
    }

    let balanceAccountCode: string | undefined;
    if (plan.needsBalancingAccount) {
      ctx.print(`  The remote trial balance does not balance (difference ${plan.totals.imbalance}).`);
      balanceAccountCode =
        (await ctx.askText('  Balancing account code (3200): ', '3200')) ?? '3200';
    }

    // Same consequence wording the onboard command uses; default is No.
    const go = await ctx.confirm(
      `  Create ${plan.accountsToCreate.length} account(s) and the opening balance as a draft?`,
      false
    );
    if (!go) {
      ctx.print('  Cancelled. Nothing was created. You can import anytime: mnemosine onboard --help');
      return;
    }

    try {
      const reviewer = await this.deps.resolveReviewer(entity.tenantId, ctx.flags.user);
      const result = await this.deps.executeOnboarding(entity, plan, reviewer, {
        balanceAccountCode,
        postNow: false,
      });
      ctx.print(`  ✔ ${result.accountsCreated} account(s) created.`);
      ctx.print(`  ✔ Opening balance in draft ${result.draftId} (ref ${plan.reference}).`);
      ctx.print('  Review the drafts: mnemosine review');
    } catch (err) {
      ctx.print(`  Import failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Retry with full control: mnemosine onboard --help');
    }
  }

  /** [2] Folder of CFDIs through the existing ingest pipeline, auto-post OFF. */
  private async ingestFolder(ctx: SectionContext, entity: AgentContext): Promise<void> {
    const dir = await ctx.askText('  Folder with CFDI XML files: ');
    if (!dir) {
      ctx.print('  No folder given. You can ingest anytime: mnemosine ingest <files…>');
      return;
    }

    let files: string[];
    try {
      files = this.deps.listXmlFiles(dir.trim());
    } catch (err) {
      ctx.print(`  Could not read the folder: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  You can ingest anytime: mnemosine ingest <files…>');
      return;
    }
    if (files.length === 0) {
      ctx.print('  No *.xml files found there. You can ingest anytime: mnemosine ingest <files…>');
      return;
    }

    let batch = files;
    if (files.length > XML_FIRST_RUN_CAP) {
      batch = files.slice(0, XML_FIRST_RUN_CAP);
      ctx.print(
        `  Found ${files.length} files; taking the first ${XML_FIRST_RUN_CAP} on this first run ` +
          'so the review stays manageable. Ingest the rest with: mnemosine ingest <files…>'
      );
    } else {
      ctx.print(`  Found ${files.length} file(s).`);
    }

    try {
      const reviewer = await this.deps.resolveReviewer(entity.tenantId, ctx.flags.user);
      const capture: DraftCapture = { drafts: [] };
      // `capture.drafts` se REEMPLAZA en cada archivo (ingest-service lo pone a
      // [] antes de cada turno), así que su longitud al final es la del ÚLTIMO
      // archivo, no la de la corrida. Este contador sí cuenta la corrida
      // entera, y sólo se usa en el camino de la MUERTE: el camino feliz
      // cuenta sobre report.results, que es donde siempre se midió.
      const borradoresCapturados = { n: 0 };
      const consumo = { input: 0, output: 0, costo: 0, costoConocido: false };
      const callbacks: SessionCallbacks = {
        onDraftCreated: (info) => {
          capture.drafts.push(info);
          borradoresCapturados.n++;
        },
        onUsage: (usage) => {
          // Mismas pinzas que recordUsage: un contador hostil o no-numérico se
          // fija ANTES de estimar el costo, o un NaN envenena el total de la
          // fila entera.
          const fijado = {
            ...usage,
            inputTokens: clampTokenCount(usage.inputTokens),
            outputTokens: clampTokenCount(usage.outputTokens),
            cacheReadInputTokens: clampTokenCount(usage.cacheReadInputTokens ?? 0),
            cacheCreationInputTokens: clampTokenCount(usage.cacheCreationInputTokens ?? 0),
          };
          consumo.input += fijado.inputTokens;
          consumo.output += fijado.outputTokens;
          const costo = estimateCostUsd(fijado);
          if (costo !== null) {
            consumo.costo += costo;
            consumo.costoConocido = true;
          }
        },
      };
      const profile = this.deps.resolveProfile(undefined, undefined);
      const session = await this.deps.createSession(profile, entity, callbacks);
      // Auto-post OFF regardless of config: the wizard never posts on its own.
      const thresholds = resolveIngestThresholds({ autoPost: false });

      // B3 · Y LA CORRIDA DEL ALTA TAMBIÉN DEJA FILA.
      //
      // Este archivo no nombraba `ai_ingest_runs` ni una vez: una carpeta
      // ingerida desde `mnemosine init` producía documentos, borradores y
      // asientos, y CERO filas de corrida — y si moría a media carpeta, ni eso.
      // A7·3 partió el registro en dos actos para la hoja de `ingest`; esto es
      // el mismo envoltorio, no una copia: abre antes del primer archivo,
      // cierra después, y cierra también por el camino de la excepción.
      const inicioCorrida = Date.now();
      const report: IngestReport = await conCorridaRegistrada({
        ctx: entity,
        apertura: {
          provider: profile.name,
          model: profile.model,
          // Lo que de verdad se va a procesar, no lo que había en la carpeta:
          // el tope de la primera corrida ya recortó, y una fila que dijera 60
          // sobre 50 archivos haría de «costo por comprobante» una división
          // chueca.
          filesTotal: batch.length,
          autoPostEnabled: thresholds.autoPost,
          createdBy: reviewer.email,
        },
        cuerpo: () =>
          this.deps.ingest({
            ctx: entity,
            reviewer,
            files: batch,
            thresholds,
            session,
            capture,
            onProgress: (msg) => ctx.print(`    ${msg}`),
          }),
        // Si la corrida reventó (`resultado` null) NO se inventan counts: se
        // omiten, las columnas conservan su DEFAULT 0 y el status 'failed' es
        // lo que dice que esos ceros son «no se llegó a contar».
        cierre: (resultado) => ({
          counts: resultado?.counts,
          sospechaCount: resultado
            ? resultado.results.filter((r) => (r.sospechas?.length ?? 0) > 0).length
            : 0,
          draftsCreated: resultado
            ? resultado.results.filter((r) => r.draftId).length
            : borradoresCapturados.n,
          inputTokens: consumo.input,
          outputTokens: consumo.output,
          estimatedCostUsd: consumo.costoConocido ? consumo.costo : null,
          durationMs: Date.now() - inicioCorrida,
        }),
        // El registro es best-effort —los CFDI clasificados son verdad aunque
        // la anotación falle— pero un registro fallido se VE, y en el asistente
        // el sitio donde el humano mira es esta misma columna de texto.
        onAviso: (mensaje) => ctx.print(`  ⚠ ${mensaje}`),
      });
      const c = report.counts;
      ctx.print(
        `  Done: ${c.rules} by rules, ${c.draft} draft(s), ${c.blocked} blocked, ` +
          `${c.duplicate} duplicate(s), ${c.invalid + c.error} with errors.`
      );
      ctx.print('  Review the drafts: mnemosine review');
    } catch (err) {
      ctx.print(`  Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Retry anytime: mnemosine ingest <files…>');
    }
  }

  async verify(): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    try {
      const entity = await this.deps.resolveEntity(undefined);
      const c = await this.counts(entity.entityId);
      const hasData = c.entries > 0 || c.xmls > 0;
      checks.push({
        name: 'Accounting data',
        level: hasData ? 'ok' : 'warn',
        detail: hasData
          ? `${c.entries} journal entr${c.entries === 1 ? 'y' : 'ies'}, ${c.xmls} CFDI(s) ingested`
          : 'No accounting data yet',
        ...(hasData ? {} : { fix: 'Import with `mnemosine onboard` or ingest CFDIs with `mnemosine ingest`' }),
      });
      if (c.onboardingDrafts > 0) {
        checks.push({
          name: 'Onboarding draft',
          level: 'warn',
          detail: `${c.onboardingDrafts} opening-balance draft(s) awaiting approval`,
          fix: 'Approve or reject with `mnemosine review`',
        });
      }
    } catch (err) {
      checks.push({
        name: 'Accounting data',
        level: 'warn',
        detail: `Could not read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return checks;
  }
}
