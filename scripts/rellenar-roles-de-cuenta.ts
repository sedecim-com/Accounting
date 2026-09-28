#!/usr/bin/env tsx
import 'dotenv/config';
import { enterTenant, closeDatabase } from '../src/database/connection.js';
import {
  censarEntidadesSinRoles,
  rellenarRoles,
  actoresPorInquilino,
  censusMissingRole,
  addMissingRoles,
} from '../src/services/accounting/account-roles-backfill.js';

// ============================================================
// Envoltorio de línea de comandos sobre
// services/accounting/account-roles-backfill.
//
// Por omisión NO escribe: censa y lo imprime.
//
// Two passes, both idempotent: entities with no roles at all get the whole
// seed, and seeded entities get `efectivo`, the role the seed gained after
// they were seeded (BAN-1, #324).
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
