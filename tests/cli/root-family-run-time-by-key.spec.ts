import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the root speaks by key, slice 4 part 1 (MNE-001-800, #150). Under es-MX the provider failures, the agent's
// question, the repair, broken-startup and rescue lines, the tenant of the invocation, `entities`, the banner, `web start`
// and the trace's dry-run note are Spanish from the catalogue, written here by hand before the code. Commands, flags,
// variables, ids and counts pass through untranslated. The English was compared by a dump, before and after.

const world = vi.hoisted(() => ({ answers: [] as Array<string | null>, currentTenant: undefined as string | undefined, estado: 'activo' }));
vi.mock('../../src/database/connection.js', async (o) => ({ ...(await o<Record<string, unknown>>()), initDatabase: vi.fn(async () => ({ tunneled: true })),
  closeDatabase: vi.fn(async () => undefined), currentTenant: () => world.currentTenant }));
vi.mock('../../src/ai/context.js', async (o) => ({ ...(await o<Record<string, unknown>>()), listEntities: vi.fn(async () => []), estadoDelInquilino: vi.fn(async () => world.estado) }));
vi.mock('../../src/cli/rls-bypass-notice.js', () => ({ noticeRlsBypassOnce: vi.fn(async () => undefined) }));
vi.mock('node:readline/promises', async (o) => ({ ...(await o<Record<string, unknown>>()), createInterface: () => ({
  question: async (p: string) => { process.stdout.write(p); return world.answers.length ? world.answers.shift()! : null; },
  once: () => undefined, removeListener: () => undefined, on: () => undefined, close: () => undefined }) }));

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Command } from 'commander';
import { fijarInquilinoDeLaOrden, freshRescueIntro, inquilinoPedido, makeAskUser, program, renderBrokenFlow, repairCommandFor, reportError } from '../../src/cli/mnemosine.js';
import { renderBanner } from '../../src/cli/banner.js';
import { listeningMismatch, registerWebCommand } from '../../src/cli/web-command.js';
import { writeTraceCompletion } from '../../src/cli/trace-completion-output.js';
import { CliError, ExitCode } from '../../src/cli/kernel/index.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { olvidarInquilinoDeLaSesion } from '../../src/ai/context.js';
import { palette } from '../../src/cli/palette.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';

const plain = palette({ isTTY: false } as NodeJS.WriteStream);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
afterEach(() => { resetLanguage(); delete process.env.MNEMOSINE_TENANT; olvidarInquilinoDeLaSesion(); });

/** Everything written while `f` runs, under es. */
async function es(f: () => unknown): Promise<string> {
  setLanguage('es');
  let out = '';
  const w = (s: unknown) => { out += String(s); return true; };
  const line = (...a: unknown[]) => { out += `${a.join(' ')}\n`; };
  const spies = [vi.spyOn(process.stdout, 'write').mockImplementation(w as never), vi.spyOn(process.stderr, 'write').mockImplementation(w as never),
    vi.spyOn(console, 'log').mockImplementation(line), vi.spyOn(console, 'error').mockImplementation(line),
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => { out += `[exit ${code}]\n`; }) as never)];
  try { await f(); } finally { for (const s of spies) s.mockRestore(); }
  return out;
}
const probe = program.command('zz-probe').option('-v, --verbose').option('-t, --tenant <uuid>').action(() => undefined);
/** The shipped program, its option values cleared between runs; a refusal of the hook reported as the entry does. */
const run = (...argv: string[]) => async () => {
  for (const c of [program, probe, ...program.commands]) for (const o of c.options) c.setOptionValue(o.attributeName(), o.defaultValue);
  olvidarInquilinoDeLaSesion();
  await program.parseAsync(['node', 'mnemosine', ...argv]).catch((err: unknown) => reportError(err));
};
const fake = (root?: string, leaf?: string) => ({ optsWithGlobals: () => ({ tenant: root }), opts: () => ({ tenant: leaf }) }) as unknown as Command;
const refusal = (f: () => unknown): CliError => { try { f(); } catch (e) { return e as CliError; } throw new Error('no refusal'); };

describe('under es-MX, the shared helpers of the root speak Spanish', () => {
  it('the provider failures, with their next step', async () => {
    const out = await es(() => {
      reportError(new OpenAI.AuthenticationError(401, undefined, 'bad key', new Headers()));
      reportError(new OpenAI.APIConnectionError({ message: 'down' }));
      reportError(new Anthropic.AuthenticationError(401, undefined, 'bad', new Headers()));
      reportError(new OpenAI.InternalServerError(500, undefined, 'boom', new Headers()));
    });
    expect(out).toContain('El proveedor rechazó la credencial (401).\nRevisa la variable de entorno que nombra api_key_env en el perfil (mnemosine providers).');
    expect(out).toContain('No se pudo conectar con el endpoint del proveedor.\nSi es un modelo local (ollama, hermes-agent), revisa que el servidor esté corriendo.');
    expect(out).toContain('Error de autenticación con la API de Anthropic.');
    expect(out).toContain('Error de la API del proveedor (500): 500 boom');
  });

  it("the agent's question, its prompt and the bare yes left pending", async () => {
    const { createInterface } = await import('node:readline/promises');
    const iface = createInterface({ input: process.stdin });
    const askUser = makeAskUser(() => iface);
    world.answers = ['sí', 'yes'];
    const out = await es(() => askUser({ question: '¿Se deduce?' }));
    expect(out).toContain('❓ El agente pregunta:\n¿Se deduce?\n  (número de opción o texto libre; vacío = dejarla pendiente para `mnemosine questions`)\nrespuesta> ');
    expect(out).toContain('Quedó pendiente: no se registró nada como precedente.');
  });

  it('the repair of a dead database, the broken startup and the rescue', async () => {
    setLanguage('es');
    expect(repairCommandFor('sin conexión con la base de datos: ECONNREFUSED')).toBe('mnemosine doctor   (y revisa DATABASE_URL en .env)');
    expect(freshRescueIntro([], plain)[0]).toBe('Bienvenido. Mnemosine es un contador con IA que mantiene tu contabilidad auditable: él propone, tú apruebas.');
    const broken = await es(() => renderBrokenFlow({ state: 'broken', reasons: ['el proveedor de IA no está configurado'] }));
    expect(broken).toBe('Algo necesita atención antes de poder conversar:\n  · el proveedor de IA no está configurado\n      → mnemosine init --section ai\n');
  });
});

describe('under es-MX, the tenant of the invocation speaks Spanish', () => {
  it('the two refusals keep exit 2 and their remedy', async () => {
    setLanguage('es');
    const both = refusal(() => inquilinoPedido(fake('A', 'B')));
    expect(both.exitCode).toBe(ExitCode.USAGE);
    expect(both.localized()).toBe('--tenant dice A y -t dice B. Elige uno: son la misma bandera y dos inquilinos distintos.');
    const bad = refusal(() => fijarInquilinoDeLaOrden(fake(undefined, 'basura')));
    expect(bad.exitCode).toBe(ExitCode.USAGE);
    expect(bad.localized()).toBe('El inquilino debe ser un UUID; --tenant trae "basura".\n  → mnemosine entity list --tenant <uuid>   (el id que imprimió `mnemosine init`)');
  });

  it('the verbose lines, the tunnel, and a tenant that is missing or inactive', async () => {
    expect(await es(run('zz-probe', '-v'))).toContain('  sin contexto de inquilino: toda consulta acotada por RLS devolverá cero filas\n  Túnel SSH establecido');
    process.env.MNEMOSINE_TENANT = U2;
    expect(await es(run('zz-probe', '-t', U1))).toContain(`  inquilino ${U1} (--tenant); se ignora MNEMOSINE_TENANT=${U2}`);
    world.estado = 'inexistente';
    expect(await es(run('zz-probe'))).toContain(`No hay ningún inquilino con id ${U2}. Nada sería visible bajo él, y un informe vacío no es lo mismo que una contabilidad vacía. (viene de MNEMOSINE_TENANT)`);
    expect(await es(run('zz-probe', '-t', U1))).toContain('\n  → revisa el id que imprimió `mnemosine init`, o MNEMOSINE_TENANT en .env');
    world.estado = 'inactivo';
    expect(await es(run('zz-probe'))).toContain(`El inquilino ${U2} existe pero no está activo. Sus datos siguen donde están; reactívalo antes de operar sobre él.`);
    world.estado = 'activo';
  });

  it('entities: the old name, and no entities with and without a tenant', async () => {
    world.currentTenant = U1;
    const none = await es(run('entities'));
    expect(none).toContain('`mnemosine entities` ahora es `mnemosine entity list`; el nombre anterior sigue funcionando.\nNo hay entidades activas en este inquilino.');
    world.currentTenant = undefined;
    expect(await es(run('entities'))).toContain('No hay entidades visibles. Si la base aplica aislamiento por inquilino, indica uno con --tenant <uuid> o MNEMOSINE_TENANT.');
  });
});

describe('under es-MX, the banner, web start and the trace speak Spanish', () => {
  it('the banner: tagline, hint, labels padded to the longest plus one, plural counts', () => {
    setLanguage('es');
    const info = { version: '0.1.0', entityName: 'Entidad Sintetica SA', providerLabel: 'anthropic · m1', language: 'es', pending: { drafts: 1, questions: 2, ops: 3 } };
    const wide = renderBanner(info, 140, plain).join('\n');
    expect(wide).toContain('v0.1.0 · Tu contabilidad, recordada.');
    expect(wide).toContain('entidad   Entidad Sintetica SA');
    expect(wide).toContain('proveedor anthropic · m1');
    expect(wide).toContain('pendiente 1 borrador · 2 dudas · 3 escrituras en cola');
    expect(wide).toContain('chat: sólo escribe · /help para los comandos · mnemosine status para una revisión');
    expect(renderBanner(info, 60, plain)).toEqual(['mnemosine v0.1.0 — Tu contabilidad, recordada.', 'Entidad Sintetica SA · anthropic · m1']);
  });

  it('web start: the listening mismatch and the refusal keep exit 2', async () => {
    setLanguage('es');
    const m = listeningMismatch({ publicOrigin: 'http://127.0.0.1:8080' } as never, { port: 8081 } as never);
    expect(new CliError(m as never).localized()).toBe('el navegador llega al gateway en http://127.0.0.1:8080, donde esta corrida no escucha (--port 8081 frente a http://127.0.0.1:8080). Pasa --public-origin con la dirección que abre el navegador, define GATEWAY_PUBLIC_ORIGIN o quita la bandera.');
    resetDeclarations();
    const web = new (await import('commander')).Command('mnemosine').exitOverride();
    let said = '';
    registerWebCommand(web, {
      shutdown: async (code) => { said += `[exit ${code}]`; return undefined as never; },
      reportError: (e) => { said += (e as CliError).localized(); },
      loadGateway: async () => ({ readConfig: () => ({ publicOrigin: 'http://127.0.0.1:8080' }) as never, configProblems: () => ['GATEWAY_API_URL is required'], missingAssets: () => undefined, start: async () => { throw new Error('no'); } }),
    });
    await web.parseAsync(['node', 'mnemosine', 'web', 'start']);
    expect(said).toBe('el gateway web se niega a arrancar:\n  - GATEWAY_API_URL is required[exit 2]');
  });

  it("the trace's dry-run note", async () => {
    const result = { paymentNumber: 'P-1', status: 'posted', filled: [], unchanged: [], journalEntry: null, period: '2026-11', periodStatus: 'open', archivedVoucherFiles: 0 };
    expect(await es(() => writeTraceCompletion(result as never, { dryRun: true, palette: plain }))).toBe('Ensayo: no se escribió nada.\n');
  });
});

describe('the lane', () => {
  const lane = (rel: string) => englishUserStrings(fs.readFileSync(path.resolve(rel), 'utf8'), rel);
  it('counts nothing in banner, web and trace, and above `chat` only the stored reason of a rejection', () => {
    for (const f of ['banner', 'web-command', 'trace-completion-output']) expect(lane(`src/cli/${f}.ts`), f).toEqual([]);
    const code = fs.readFileSync(path.resolve('src/cli/mnemosine.ts'), 'utf8');
    const chat = code.slice(0, code.indexOf("program.command('chat'")).split('\n').length;
    // `rejectionReasonFrom` stores 'No reason' in ai_drafts.review_notes: data, not a message. Part 14 rules on it.
    expect(lane('src/cli/mnemosine.ts').filter((s) => s.line < chat).map((s) => s.text)).toEqual(['No reason']);
  });
});
