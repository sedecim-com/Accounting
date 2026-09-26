import * as path from 'node:path';
import type { AgentContext } from '../../../src/ai/context.js';
import type { ToolDeps } from '../../../src/ai/tools/observer.js';
import { buildTools } from '../../../src/ai/tools/index.js';
import { buildReaderTools } from '../../../src/ai/webhooks/reader-agent.js';

// CONTRACT: the input schema every agent tool sends to the model, recorded on
// zod 3.25.76 (#367). Keys are sorted, so the golden pins what the schema SAYS
// and not the order a Zod version happens to emit it in.

export const TOOL_SCHEMAS_GOLDEN = path.resolve(__dirname, 'tool-schemas.golden.json');

const CONTEXT: AgentContext = {
  entityId: '11111111-1111-4111-8111-111111111111',
  entityName: 'Golden',
  tenantId: '22222222-2222-4222-8222-222222222222',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'NIF',
  taxId: 'XAXX010101000',
};

const DEPS: ToolDeps = { model: 'golden' };

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

type SchemaCarrier = { name: string; input_schema?: unknown };

function schemasOf(tools: readonly SchemaCarrier[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    out[tool.name] = tool.input_schema;
  }
  return out;
}

/** Every agent tool's input schema, as the session hands it to a provider. */
export function agentToolSchemas(): Record<string, unknown> {
  return schemasOf(buildTools(CONTEXT, DEPS));
}

/** The webhook reader's tools, which must be a subset with the same schemas. */
export function readerToolSchemas(): Record<string, unknown> {
  return schemasOf(buildReaderTools(CONTEXT, DEPS));
}

/** The golden: canonical (sorted-key) schema per tool name. */
export function recordToolSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(agentToolSchemas())) out[name] = canonical(schema);
  return out;
}
