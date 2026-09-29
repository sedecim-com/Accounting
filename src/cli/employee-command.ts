import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import type { Palette } from './palette.js';
import { exitCodeFor, requireExplicitEntity, resolveActiveEntity, type ExitCodeValue } from './kernel/index.js';
import { registerEmployeeCreate } from './employee-create-command.js';
import { registerEmployeeList } from './employee-list-command.js';
import { registerEmployeeShow } from './employee-show-command.js';

// ============================================================
// mnemosine employee · empleado
//
// The payroll roll at the terminal, part 1 of 4 of #306 (MNE-001-066):
//
//   employee create  · empleado crear   — employee-create-command.ts
//   employee show    · empleado ver     — employee-show-command.ts
//   employee list    · empleado listar  — employee-list-command.ts
//
// ONE FILE PER LEAF. The four parts of #306 all land in the payroll family
// and would otherwise collide in one file; this one only builds the family
// node and the plumbing the three leaves share.
//
// THE LEAVES CALL THE SAME SERVICE AS THE API (employee-service.ts). The
// entity boundary lives inside its SQL — `requireByIdInScope` for one
// employee, `entity_id = $n` for the roll — never in a filter applied here.
//
// Help prose is English in place, as garnishment-command.ts explains: a new
// file carries no language debt, and the Spanish ALIASES come from the closed
// verb list.
// ============================================================

export interface EmployeeCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

export interface EmployeeCommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

/** What every leaf receives from the family: no leaf imports another. */
export interface EmployeeLeafKit {
  deps: EmployeeCommandDeps;
  run: (fn: () => Promise<ExitCodeValue | void>) => Promise<void>;
  /** A write never guesses the entity: it is named, or it is pinned. */
  scopeForWrite: (opts: EmployeeCommonOpts) => Promise<EntityScope>;
  scopeForRead: (opts: EmployeeCommonOpts) => Promise<EntityScope>;
}

export function registerEmployeeCommand(program: Command, deps: EmployeeCommandDeps): void {
  const employee = program
    .command('employee')
    .alias('empleado')
    .description('The payroll roll: register an employee, see one record, list the roll');

  const kit: EmployeeLeafKit = {
    deps,
    run: async (fn) => {
      try {
        const code = await fn();
        await deps.shutdown(code ?? 0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    },
    // Tenant FIRST: entity resolution is itself bounded by RLS, so a --tenant
    // applied afterwards resolves nothing.
    scopeForWrite: async (opts) => {
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      return entityScope(ctx.tenantId, ctx.entityId);
    },
    scopeForRead: async (opts) => {
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
      return entityScope(ctx.tenantId, ctx.entityId);
    },
  };

  registerEmployeeCreate(employee, kit);
  registerEmployeeShow(employee, kit);
  registerEmployeeList(employee, kit);
}
