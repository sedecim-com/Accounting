import { InfraSection } from './s0-infra.js';
import { IdentidadSection } from './s1-identity.js';
import { UsuariosSection } from './s2-users.js';
import { IaSection } from './s3-ai.js';
import { PoliciesSection } from './s4-policies.js';
import { ImportSection } from './s5-import.js';
import type { SetupSection } from './section.js';

export * from './section.js';
export { InfraSection, upsertEnvVar, readEnvVar } from './s0-infra.js';
export { IdentidadSection } from './s1-identity.js';
export { UsuariosSection, ROLES } from './s2-users.js';
export { IaSection, KEY_URLS } from './s3-ai.js';
export { PoliciesSection } from './s4-policies.js';
export { ImportSection, XML_FIRST_RUN_CAP } from './s5-import.js';

/**
 * Deliberate order: each section assumes the previous ones are resolved.
 * Without a database there is no entity; without an entity there are no users
 * to attribute; without a provider there is no agent. The deferrable ones
 * (fiscal, accounting, memory) come in the second iteration. Policies need
 * the entity to exist to preview their impact on real data. Import goes
 * last: it needs the entity AND the AI provider (the CFDI path classifies
 * with the model), and it is the bridge from setup to real work.
 */
export function buildSections(cwd?: string): SetupSection[] {
  return [
    new InfraSection({ cwd }),
    new IdentidadSection({ cwd }),
    new UsuariosSection(),
    new IaSection({ cwd }),
    new PoliciesSection(),
    new ImportSection(),
  ];
}
