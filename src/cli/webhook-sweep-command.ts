import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { currentTenant } from '../database/connection.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import { exitCodeFor } from './kernel/index.js';
import {
  barrerEntregasVencidas,
  TOPE_POR_INQUILINO,
  type ResultadoBarrido,
} from '../services/webhooks/barrido-entregas.js';

// ============================================================
// mnemosine subscription delivery sweep · suscripcion entrega barrer
//
// EL DISPARO ES UN COMANDO, NO UN TRABAJADOR.
//
// La tentación evidente era un proceso residente que mirase la cola
// cada minuto. Un proceso que corre solo necesita gobierno: quién lo
// arranca, quién lo vigila, qué pasa cuando se cae un martes a las tres
// de la mañana, cómo se le dice que pare, dónde escribe. Nada de eso
// existe aquí —`src/jobs/` está vacío y el `daemon start` del catálogo
// sigue sin construirse—, así que un trabajador sería la quinta pieza
// sin dueño del sistema.
//
// Un comando que alguien invoca no necesita nada de eso: el cron del
// despacho ya es el planificador, ya tiene bitácora y ya sabe avisar
// cuando algo devuelve distinto de cero. Es la misma decisión que tomó
// `jobs run-due`, y por la misma razón.
//
// El uso previsto:
//     */5 * * * *  mnemosine subscription delivery sweep --all-tenants --live -y
//
// CATÁLOGO: docs/cli-command-catalog.md tiene la familia de SALIDA bajo
// `subscription`·`suscripcion` (§ «Ingesta desatendida», filas 2927-2932)
// —ojo: `webhooks`·`ganchos` es la familia de ENTRADA, tokens del agente
// lector, y no tiene nada que ver con esto—. De las seis filas escritas
// ninguna es este barrido: la más cercana, `subscription delivery retry
// <id>`·`suscripcion entrega reintentar` (fila 2932), es el reintento
// MANUAL de UNA entrega, que es justo lo que ya existía y no barre nada.
// La fila de este comando NO está escrita, y este archivo no la escribe:
// el catálogo no es de este frente. La propuesta va en el informe.
// ============================================================

export interface SweepPalette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  yellow: (s: string) => string;
}

export interface WebhookSweepDeps {
  palette: SweepPalette;
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

interface SweepOpts extends Record<string, unknown> {
  tenant?: string;
  allTenants?: boolean;
  limit: string;
  json?: boolean;
  dryRun?: boolean;
  live?: boolean;
  yes?: boolean;
  idempotencyKey?: string;
}

function resumen(r: ResultadoBarrido): string {
  return (
    `tenants ${r.inquilinosRevisados} · due ${r.vencidas} · delivered ${r.entregadas} · ` +
    `retryable ${r.reintentables} · dead ${r.muertas} · frozen ${r.congeladas}`
  );
}

/**
 * Registra `subscription delivery sweep` bajo el comando `subscription`
 * que le pase el orquestador.
 *
 * Recibe el padre en vez de crearlo porque la familia `subscription`
 * pertenece al registro del binario (src/cli/mnemosine.ts), que este
 * frente no toca. Si la familia todavía no existe, el orquestador la
 * crea y pasa el `Command`; aquí sólo cuelga la hoja.
 */
export function registerWebhookSweepCommand(
  subscription: Command,
  deps: WebhookSweepDeps
): void {
  const c = deps.palette;

  const delivery =
    subscription.commands.find((x) => x.name() === 'delivery') ??
    subscription.command('delivery').alias('entrega').description('Outbound delivery log and retries');

  const sweep = delivery
    .command('sweep')
    .alias('barrer')
    .description(
      'Retry every outbound delivery whose retry time has passed, with exponential backoff; ' +
        'deliveries that exhaust their attempts are declared dead and reported (call this from cron)'
    )
    .option('-t, --tenant <id>', 'Tenant to sweep (defaults to MNEMOSINE_TENANT)')
    .option('--all-tenants', 'Sweep every active tenant, each under its own tenant context')
    .option('-n, --limit <n>', 'Max deliveries per tenant in this pass', String(TOPE_POR_INQUILINO))
    .option('--json', 'JSON output');

  // EJEMPLOS DE AYUDA. Invocaciones copiables, no plantillas: parsean contra
  // el commander embarcado (lo comprueba tests/cli/ejemplos-de-ayuda.spec.ts).
  // La primera es la que va al cron y la segunda es la que se teclea antes de
  // ponerla ahí: esta hoja hace POST a terceros, así que el ensayo va primero.
  sweep.addHelpText(
    'after',
    `
Examples:
  # The rehearsal: it reports what it WOULD retry and posts to nobody.
  mnemosine subscription delivery sweep --all-tenants --dry-run
  # The line that goes in the crontab, every five minutes.
  mnemosine subscription delivery sweep --all-tenants --live --yes --json
  # One firm only, with a smaller batch per pass.
  mnemosine subscription delivery sweep --tenant 3f2504e0-4f89-11d3-9a0c-0305e82c3301 --limit 50 --live -y
`
  );

  // Externo: cada entrega es un POST a la URL de un tercero. El kernel
  // añade --dry-run, -y/--yes, --idempotency-key y --live.
  declareRisk(sweep, {
    risk: 'externo',
    agent: false,
    writes:
      'webhook_deliveries (status, attempt_count, next_retry_at, error_message); ' +
      'y hace POST a la URL de cada suscripción con el evento original',
  });

  sweep.action(async (opts: SweepOpts) => {
    try {
      const { dryRun, live } = gateMutation(sweep, opts);

      const limite = Number.parseInt(opts.limit, 10);
      if (!Number.isFinite(limite) || limite < 1) {
        throw new Error(`Invalid --limit "${opts.limit}": use a positive number.`);
      }

      bootstrapTenant(opts.tenant);
      const tenantId = opts.allTenants ? undefined : currentTenant();
      if (!opts.allTenants && !tenantId) {
        throw new Error(
          'The sweep needs a scope: pass --tenant <uuid> (or set MNEMOSINE_TENANT) to sweep one ' +
            'tenant, or --all-tenants to sweep every active tenant. It does not default to ' +
            'everything: crossing every tenant is a decision, not a fallback.'
        );
      }

      // SIN --live NO SE ENTREGA. Un webhook no tiene ambiente de
      // pruebas: la URL es la del cliente y el único "sandbox" honesto
      // es no llamar. Así que la compuerta degrada a censo en vez de
      // fingir un envío, y lo dice.
      const soloCenso = dryRun || !live;
      if (soloCenso && !dryRun) {
        console.log(
          c.dim(
            'sandbox: nothing was sent. A webhook has no test endpoint — the URL is the ' +
              'customer\'s. Add --live to actually retry.'
          )
        );
      }
      if (opts.idempotencyKey) {
        process.stderr.write(
          '  --idempotency-key does not apply to the sweep: each delivery already carries its own ' +
            'stable key (X-Webhook-ID), and deduplicating whole passes would skip due deliveries.\n'
        );
      }

      const resultado = await barrerEntregasVencidas({
        tenantId,
        limite,
        marchaSeca: soloCenso,
        traza: opts.json ? undefined : (l) => console.log(`  ${c.dim(l)}`),
      });

      if (opts.json) {
        console.log(JSON.stringify(resultado, null, 2));
      } else {
        console.log('');
        console.log(c.bold(`  ${soloCenso ? 'Would sweep' : 'Swept'}: ${resumen(resultado)}`));
        if (resultado.congeladas > 0) {
          console.log(
            c.yellow(
              `  ${resultado.congeladas} due deliver(ies) belong to DISABLED subscriptions and were ` +
                'left untouched — neither retried nor killed.'
            )
          );
        }
        if (!soloCenso && resultado.muertas > 0) {
          console.log(
            c.yellow(
              `  ${resultado.muertas} deliver(y/ies) exhausted their attempts and are now DEAD: ` +
                'they will not be retried again. Inspect them with ' +
                '`mnemosine subscription delivery list <subscriptionId> --status failed`.'
            )
          );
        }
        console.log('');
      }

      // Una entrega muerta NO es un fallo del barrido: el barrido hizo
      // exactamente su trabajo al declararla. El código de salida
      // distingue «no pude barrer» de «barrí y algo murió»; que el cron
      // avise o no de lo segundo es decisión de quien lo programa, y
      // para eso está --json.
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      // El código lo decide el error, no la hoja. Un `1` a mano aplasta el
      // 4 de `--strict`, el 3 de conflicto y el 2 de uso en el mismo valor,
      // y el cron que invoca este barrido cada cinco minutos sólo tiene el
      // código de salida para distinguir «no pude barrer» de «me llamaste mal».
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
