#!/usr/bin/env tsx
import 'dotenv/config';
import { enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censarEntidadesSinRoles,
  rellenarRoles,
  actoresPorInquilino,
  censusMissingRole,
  addMissingRoles,
  censusRolesOnParentAccounts,
  repointRolesToLeaves,
} from '../src/services/accounting/account-roles-backfill.js';

// ============================================================
// Envoltorio de línea de comandos sobre
// services/accounting/account-roles-backfill.
//
// Por omisión NO escribe: censa y lo imprime.
//
// Three passes, all idempotent: entities with no roles at all get the whole
// seed; seeded entities get `efectivo`, the role the seed gained after they
// were seeded; and default roles seeded onto a parent account (`banco` →
// 1110) move to the leaf the seed now uses (BAN-1, #324). The order matters:
// `efectivo` has to anchor cash on 1110 before `banco` leaves it, or the
// cash-flow statement of an entity would shrink to 1111 in between.
//
//   npx tsx scripts/rellenar-roles-de-cuenta.ts [--tenant <uuid>]
//   npx tsx scripts/rellenar-roles-de-cuenta.ts [--tenant <uuid>] --aplicar
// ============================================================

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const aplicar = process.argv.includes('--aplicar');
  if (tenantId) enterTenant(tenantId);

  await seedMissingRoles(tenantId, aplicar);
  await addCashRole(tenantId, aplicar);
  await repointParentRoles(tenantId, aplicar);
}

async function repointParentRoles(tenantId: string | undefined, apply: boolean): Promise<void> {
  const census = await censusRolesOnParentAccounts(tenantId);
  console.log(`\nRoles sobre una cuenta con subcuentas\n${'─'.repeat(64)}`);
  for (const r of census.fixable) {
    console.log(`  ${r.entityName.padEnd(34)} ${r.role}: ${r.fromCode} → ${r.toCode}`);
  }
  if (census.unfixable.length > 0) {
    console.log(`  ${census.unfixable.length} más que la semilla no puede reapuntar sola (revísalos con role set):`);
    for (const u of census.unfixable.slice(0, 20)) {
      console.log(`    ${u.entityName}: ${u.role} → ${u.code} (${u.why})`);
    }
  }
  if (census.fixable.length === 0) {
    console.log('  Ningún rol que reapuntar.');
    return;
  }
  if (!apply) {
    console.log('Censo, sin escribir nada. Para reapuntarlos: --aplicar');
    return;
  }
  const actors = await actoresPorInquilino([...new Set(census.fixable.map((r) => r.tenantId))]);
  const r = await repointRolesToLeaves(census.fixable, actors);
  console.log(`${r.repointed} roles reapuntados a su hoja`);
  for (const f of r.failures) console.log(`  ✗ ${f}`);
  if (r.failures.length > 0) process.exitCode = 1;
}

async function addCashRole(tenantId: string | undefined, apply: boolean): Promise<void> {
  const census = await censusMissingRole('efectivo', tenantId);
  console.log(`\nEntidades sembradas sin el rol «efectivo»\n${'─'.repeat(64)}`);
  for (const m of census.missing) console.log(`  ${m.entityName.padEnd(34)} efectivo → ${m.code}`);
  for (const u of census.unmappable) {
    console.log(`  ${u.entityName.padEnd(34)} sin la cuenta ${u.code}: mapéalo con account role set`);
  }
  if (census.missing.length === 0) {
    console.log('  Ninguna entidad que completar.');
    return;
  }
  if (!apply) {
    console.log('Censo, sin escribir nada. Para añadirlo: --aplicar');
    return;
  }
  const actors = await actoresPorInquilino([...new Set(census.missing.map((m) => m.tenantId))]);
  const r = await addMissingRoles(census.missing, actors);
  console.log(`${r.added} entidades con el rol «efectivo» añadido`);
  for (const f of r.failures) console.log(`  ✗ ${f}`);
  if (r.failures.length > 0) process.exitCode = 1;
}

async function seedMissingRoles(tenantId: string | undefined, apply: boolean): Promise<void> {
  const entidades = await censarEntidadesSinRoles(tenantId);
  if (entidades.length === 0) {
    console.log('Todas las entidades activas tienen su capa semántica sembrada. Nada que rellenar.');
    return;
  }

  console.log(`\nEntidades sin roles de cuenta\n${'─'.repeat(64)}`);
  for (const e of entidades) {
    console.log(
      `  ${e.entity_name.padEnd(34)} ${String(e.cuentas_actuales).padStart(4)} cuentas · ` +
        `${e.roles_actuales} roles`
    );
  }
  console.log(`\n${entidades.length} entidades. Sin roles, la ingesta de CFDI y los pagos`);
  console.log('mueren con MISSING_ROLE_ACCOUNT en cuanto se use el sistema.');

  if (!apply) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log('Censo, sin escribir nada. Para sembrarlas: --aplicar');
    return;
  }

  const actores = await actoresPorInquilino([...new Set(entidades.map((e) => e.tenant_id))]);
  const r = await rellenarRoles(entidades, actores);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(
    `${r.sembradas} entidades sembradas · ${r.cuentasCreadas} cuentas creadas · ` +
      `${r.rolesMapeados} roles mapeados`
  );
  if (r.sinMapear.length > 0) {
    console.log(`\n${r.sinMapear.length} roles sin cuenta en el catálogo (revísalos con mnemosine doctor):`);
    for (const u of r.sinMapear.slice(0, 20)) {
      console.log(`  ${u.entidad}: ${u.role} → ${u.code}`);
    }
  }
  for (const f of r.fallos) console.log(`  ✗ ${f}`);
  if (r.fallos.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
