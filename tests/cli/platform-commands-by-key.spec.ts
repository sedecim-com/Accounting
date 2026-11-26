import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

// I8b · the platform speaks by key (MNE-001-808 part 1, #150). Under es-MX the refusals, headings, notes and
// verdicts of `memory`, `entity`, `user` and `tenant` are Spanish from the catalogue, written here by hand before
// the code; commands, flags, option values, ids and amounts pass through untranslated, and the
// machine formats of `entity show` keep their English. The English was compared by a dump.

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', taxId: 'ESI010101AA1', country: 'MX', currency: 'MXN', accountingStandard: 'mx_nif' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn(), resolveEntity: vi.fn(async () => CTX), listEntities: vi.fn(async () => []), inquilinoDeLaSesion: vi.fn(() => ({ tenantId: 't1' })) }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ email: 'ana@example.com', userId: 'u1' })) }));
vi.mock('../../src/services/policy/today.js', () => ({ zoneFor: vi.fn(async () => 'America/Mexico_City') }));
vi.mock('../../src/ai/memory-service.js', () => ({ listMemory: vi.fn(), memoryStats: vi.fn(), correctMemory: vi.fn(), retireMemory: vi.fn(), restoreMemory: vi.fn(), teachMemory: vi.fn(), detectMemoryConflicts: vi.fn(), digestCoverage: vi.fn() }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({ ...(await o<Record<string, unknown>>()), resolveActiveEntity: vi.fn(), useEntity: vi.fn() }));
vi.mock('../../src/services/entity/entity-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), createEntity: vi.fn(), archiveEntity: vi.fn(), getEntityTaxProfile: vi.fn(), updateEntityTaxProfile: vi.fn() }));
vi.mock('../../src/services/payroll/mx/minimum-wage-zone.js', async (o) => ({ ...(await o<Record<string, unknown>>()), minimumWageZoneOf: vi.fn(), setEntityMinimumWageZone: vi.fn() }));
vi.mock('../../src/services/user/user-service.js', () => ({ listUsers: vi.fn(), createUser: vi.fn(), archiveUser: vi.fn(), resolveUserTenant: vi.fn(async () => 't1') }));
vi.mock('../../src/services/tenant/tenant-service.js', () => ({ listTenants: vi.fn(async () => []), createTenant: vi.fn() }));

import { registerMemoryCommand, renderConflicts, renderDigestCoverage, renderMemory } from '../../src/cli/memory-command.js';
import { registerEntityCommand } from '../../src/cli/entity-command.js';
import { registerUserCommand, readPassword } from '../../src/cli/user-command.js';
import { registerTenantCommand } from '../../src/cli/tenant-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';
import * as mem from '../../src/ai/memory-service.js';
import * as ec from '../../src/cli/kernel/entity-context.js';
import * as ent from '../../src/services/entity/entity-service.js';
import * as mw from '../../src/services/payroll/mx/minimum-wage-zone.js';
import * as tn from '../../src/services/tenant/tenant-service.js';

const m = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
const HOME = path.join(os.tmpdir(), 'mnemosine-808-spec-home');
const MX = 'America/Mexico_City';
afterEach(() => { resetLanguage(); });

function build(): Command {
  resetDeclarations();
  const program = new Command('mnemosine').exitOverride();
  const deps = { palette, home: HOME, shutdown: async (c: number) => { throw new Error(`exit ${c}`); },
    reportError: (e: unknown) => { const l = (e as { localized?: () => string }).localized; if (l) process.stderr.write(l.call(e)); } };
  for (const register of [registerMemoryCommand, registerEntityCommand, registerTenantCommand]) register(program, deps as never);
  registerUserCommand(program, { ...deps, readSecret: async () => null, env: {}, stdin: Object.assign(Readable.from([]), { isTTY: false }) } as never);
  return program;
}
async function es(...argv: string[]): Promise<string> {
  return (await raw(...argv)).replace(/[ \t]+/g, ' ');
}
async function raw(...argv: string[]): Promise<string> {
  setLanguage('es');
  let out = '';
  const w = (c: unknown) => { out += String(c); return true; };
  const spies = [vi.spyOn(process.stdout, 'write').mockImplementation(w), vi.spyOn(process.stderr, 'write').mockImplementation(w),
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out += `${a.join(' ')}\n`; })];
  await build().parseAsync(['node', 'mnemosine', ...argv]).catch(() => undefined);
  for (const s of spies) s.mockRestore();
  return out;
}
const entry = (id: string, answer: string, precedent = true) => ({ id, answer, context: null, question: 'q', topic: null, answered_by: 'ana', answered_at: new Date('2026-07-01T18:00:00Z'), is_precedent: precedent });

describe('under es-MX, memory speaks Spanish', () => {
  it('the list, the conflicts, the digest and the four writes', async () => {
    setLanguage('es');
    const empty = renderMemory([], { active: 0, retired: 0, taught: 0 }, palette, MX).join('\n');
    expect(empty).toContain('Memoria del despacho');
    expect(empty).toContain('Se crean al contestar preguntas (mnemosine questions) o directamente:');
    expect(renderMemory([entry('m2', 'b', false) as never], { active: 1, retired: 2, taught: 1 }, palette, MX).join('\n'))
      .toContain('b [retirado]');
    expect(renderMemory([entry('m1', 'a') as never], { active: 1, retired: 2, taught: 1 }, palette, MX).join('\n'))
      .toContain('1 activo · 2 retirados · 1 enseñado directamente');
    expect(renderConflicts([], 0, palette, MX).join('\n')).toContain('Todavía no hay precedentes activos: nada puede contradecir nada.');
    expect(renderConflicts([], 4, palette, MX).join('\n')).toContain('Ninguno: los 4 precedentes activos no se contradicen entre sí.');
    const k = [{ key: 'k1', scope: 'topic', entityName: 'E', entries: [entry('m1', 'a')] }, { key: 'k2', scope: 'question', entityName: 'E', entries: [entry('m3', 'c')] }];
    const fight = renderConflicts(k as never, 1, palette, MX).join('\n');
    expect(fight).toContain('Precedentes en conflicto');
    expect(fight).toContain('k1  (tema · E)');
    expect(fight).toContain('k2  (misma pregunta · E)');
    expect(fight).toContain('→ mnemosine memory retire m1 --reason "perdió frente a un precedente en conflicto"');
    expect(fight).toContain('2 decisiones con criterios que se contradicen, de 1 precedente activo.');
    expect(fight).toContain('(mnemosine memory correct <id> "<la respuesta que vale>").');
    expect(renderDigestCoverage({ hidden: 1, active: 41, visible: 40, maxEntries: 40 } as never, palette).join('\n'))
      .toContain('⚠ 1 de 41 precedentes activos queda fuera del resumen de la sesión (lleva 40, máximo 40): la IA sólo lo ve si lo busca.');
    m(mem.listMemory).mockResolvedValue([]);
    m(mem.memoryStats).mockResolvedValue({ active: 0, retired: 0, taught: 0, topics: [{ topic: 'iva', count: 2 }] });
    m(mem.detectMemoryConflicts).mockResolvedValue({ conflicts: k.slice(0, 1), scanned: 3 });
    m(mem.digestCoverage).mockResolvedValue({ hidden: 0, active: 0, visible: 0, maxEntries: 40 });
    const list = await es('memory');
    expect(list).toContain('⚠ 1 decisión tiene precedentes que se contradicen; la IA aplica uno sin decir cuál.');
    expect(list).toContain('Temas más frecuentes:');
    expect(list).toContain('2× iva');
    m(mem.teachMemory).mockResolvedValue('m9');
    expect(await es('memory', 'teach', 'regla', 'criterio')).toContain('✔ Criterio guardado. La IA lo usará desde ahora.');
    m(mem.correctMemory).mockResolvedValue({ answer: 'otra' });
    expect(await es('memory', 'correct', 'm1', 'otra')).toContain('✔ Precedente corregido: otra');
    expect(await es('memory', 'retire', 'm1')).toContain('✔ Precedente retirado. La IA ya no lo verá.');
    expect(await es('memory', 'restore', 'm1')).toContain('✔ Precedente reactivado.');
  });
});

describe('under es-MX, entity, user and tenant speak Spanish', () => {
  it('entity: the table in Spanish while json and csv keep English, the refusals, create, edit, archive, unset', async () => {
    m(ent.getEntityTaxProfile).mockResolvedValue({ tax_regime: '601', tax_regime_name: 'General', tax_postal_code: '01000' });
    m(mw.minimumWageZoneOf).mockResolvedValue({ zone: 'general', declaredBy: null });
    m(ec.resolveActiveEntity).mockResolvedValue({ ctx: CTX, source: 'stored' });
    const table = await es('entity', 'show');
    expect(table).toContain('general (sin declarar) fijada con `mnemosine entity use`');
    expect(await es('entity', 'show', '--json')).toContain('"selected_because": "pinned with `mnemosine entity use`"');
    expect(await es('entity', 'show', '--format', 'csv')).toContain(',general (not declared),pinned with `mnemosine entity use`');
    m(ec.useEntity).mockResolvedValue({ ctx: CTX, file: '/x/state.json' });
    const use = await es('entity', 'use', 'ESI010101AA1');
    expect(use).toContain('✔ Entidad activa: Entidad Sintetica SA (ESI010101AA1, MX, MXN)');
    expect(use).toContain('guardada en /x/state.json');
    expect(await es('entity', 'create', 'X', '--tax-id', 'ESI010101AA1', '--country', 'ZZ')).toContain('--country "ZZ" desconocido. Se admiten: MX, USA.');
    expect(await es('entity', 'create', 'X', '--tax-id', 'ESI010101AA1', '--chart', 'quizá')).toContain('--chart "quizá" desconocido. Usa auto, siempre o nunca.');
    m(ent.createEntity).mockResolvedValue({ entityId: 'e9', tenantId: 't9', name: 'X', taxId: 'ESI010101AA1', country: 'MX', currency: 'MXN', attributedToSystem: true, warnings: [],
      accounting: { cuentasBaseCreadas: ['a'], accountsCreated: ['a', 'b'], nomina: { bucketsMapped: ['b'], bucketsUnmappable: [{ bucket: 'cash_payroll', code: '1111' }] }, assetClasses: { creadas: ['c', 'd'] } } });
    const create = await raw('entity', 'create', 'X', '--tax-id', 'ESI010101AA1');
    // The label column is as wide as its longest Spanish label (despacho, catálogo) plus two.
    expect(create).toContain('  entidad   e9\n  despacho  t9\n');
    expect(create).toContain('  catálogo  1 cuenta sembrada, 2 cuentas de rol, 1 grupo de nómina');
    expect(create).toContain('  activos   2 clases de activo con su tasa del art. 34/35 de la LISR');
    expect(create).toContain('! el grupo de nómina cash_payroll necesita la cuenta 1111, que este catálogo no tiene: asígnala antes de la primera corrida de nómina');
    expect(create).toContain('atribuida a la cuenta de sistema del despacho (no había usuario en sesión)');
    expect(create).toContain('fíjala con: mnemosine entity use ESI010101AA1');
    m(ec.resolveActiveEntity).mockResolvedValue({ ctx: CTX, source: 'flag' });
    m(ent.updateEntityTaxProfile).mockResolvedValue({ tax_regime: '626', tax_postal_code: null });
    m(mw.setEntityMinimumWageZone).mockResolvedValue({ minimum_wage_zone: 'general' });
    const edit = await es('entity', 'edit', 'e1', '--tax-regime', '626', '--minimum-wage-zone', 'general');
    expect(edit).toContain('✔ Perfil fiscal de Entidad Sintetica SA actualizado (régimen 626, código postal —)');
    expect(edit).toContain('✔ Zona de salario mínimo de Entidad Sintetica SA: general');
    m(ent.archiveEntity).mockResolvedValue({ name: 'Entidad Sintetica SA' });
    ec.writeState({ entityId: 'e1', entityName: 'Entidad Sintetica SA' }, HOME);
    const archive = await es('entity', 'archive', 'e1', '--reason', 'baja');
    expect(archive).toContain('era la entidad fijada; se quitó la fijación');
    expect(archive).toContain('✔ Se archivó Entidad Sintetica SA.');
    ec.writeState({ entityId: 'e1', entityName: 'Entidad Sintetica SA' }, HOME);
    expect(await es('entity', 'unset')).toContain('✔ Se quitó la fijación de Entidad Sintetica SA.');
    expect(await es('entity', 'unset')).toContain('No había entidad fijada.');
  });

  it('user and tenant: the password refusals, the lifecycle refusal, the labels', async () => {
    expect(await es('user', 'list', '--status', 'baja')).toContain('--status baja: un usuario sólo puede estar active o archived.');
    expect(await es('tenant', 'list', '--status', 'baja')).toContain('--status baja: un despacho sólo puede estar active o archived.');
    expect(await es('user', 'create', '--role', 'viewer')).toContain('--email es obligatorio.');
    expect(await es('user', 'create', '--email', 'a@example.com')).toContain('--role es obligatorio: un acceso nunca recibe un rol por omisión.');
    setLanguage('es');
    const refusal = async (o: object, env: Record<string, string>, isTTY: boolean) => {
      let prompt = '';
      const d = { readSecret: async (p: string) => { prompt = p; return null; }, env, stdin: Object.assign(Readable.from([]), { isTTY }) };
      const e = await readPassword(o, d as never).catch((x: { localized: () => string }) => x);
      return `${prompt}|${(e as { localized: () => string }).localized()}`;
    };
    expect(await refusal({ passwordStdin: true }, { MNEMOSINE_USER_PASSWORD: 'x' }, false)).toContain('--password-stdin y MNEMOSINE_USER_PASSWORD están definidos a la vez; usa uno.');
    expect(await refusal({ passwordStdin: true }, {}, true)).toContain('--password-stdin espera una tubería; en una terminal, córrelo sin esa opción y la contraseña se pide oculta.');
    expect(await refusal({}, {}, true)).toBe('  Contraseña: |Cancelado; no se creó nada.');
    expect(await refusal({}, {}, false)).toContain('Sin contraseña: pásala por una tubería con --password-stdin o define MNEMOSINE_USER_PASSWORD. Nunca se acepta como argumento');
    m(tn.createTenant).mockResolvedValue({ tenantId: 't9', name: 'Despacho X', subdomain: 'x' });
    const tenant = await raw('tenant', 'create', 'Despacho X');
    expect(tenant).toContain('  despacho  t9\n');
    expect(tenant).toContain('  sigue     mnemosine entity create <name> --tax-id <rfc> -t t9');
  });
});

describe('the lane', () => {
  it('counts no English string without a key in the four files', () => {
    for (const f of ['memory', 'entity', 'user', 'tenant']) {
      const rel = `src/cli/${f}-command.ts`;
      expect(englishUserStrings(fs.readFileSync(path.resolve(rel), 'utf8'), rel), rel).toEqual([]);
    }
  });
});
