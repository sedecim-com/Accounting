import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { ToolDeps } from './observer.js';

// ============================================================
// SYSTEM DOCS (progressive disclosure)
// The compact index lives in the system prompt (cached); the
// content is loaded on demand with read_docs — the agent can
// operate or guide ANY system module without inflating each
// session's context.
// The .md files live next to this code (src/ai/docs; the build
// copies them to dist/ai/docs).
// ============================================================

export const DOC_TOPICS = {
  accounting: 'journal entries (types/states/validations), fiscal periods, signs',
  receivables: 'customers, issued invoices (states, CFDI), collections, aging',
  payables: 'vendors, received invoices (bills), approvals, payments',
  banking: 'transaction import, matching and reconciliation',
  'mexico-cfdi': 'CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping, XML ingestion',
  payroll: 'Mexico payroll (ISR/IMSS/payroll CFDI/SUA) and USA (FICA/SUTA/W-2/941/NACHA)',
  reports: 'the 7 reports: which to use and how to interpret signs',
  mnemosine: 'your own flow: drafts/review, questions/precedents, ingestion, limits',
  playbooks: 'how to GUIDE each process: new company, migration, daily flow, month end — diagnose-first protocol',
  system: 'overview: multi-tenant, webhooks, integrations, blockchain, audit',
  'external-integrations': 'other accounting systems (Contalink): pull, trial balance diff, write outbox',
  'nif-marco': 'NIF serie A: los 8 postulados, definiciones de activo/pasivo/ingreso — el fundamento de todo registro',
  'nif-registro': 'NIF B/C/D aplicadas: cómo se registra cada operación (ingresos D-1, inventarios C-4, PPyE C-6, provisiones C-9, nómina D-3, moneda extranjera B-15)',
  'nif-validaciones': 'qué valida el sistema automáticamente, qué norma respalda cada regla, y qué exige criterio humano',
  'cli-reference': 'EXACT surface of the mnemosine binary (auto-generated): every command, flag and alias — quote verbatim',
  'identity-access': 'OIDC login, tenant isolation (RLS) symptoms and fixes, database roles, reviewer attribution, SAT credentials',
  connectivity: 'database hosting (presets/TLS/SSH tunnel), doctor, the 12 model providers and their config',
  'niif-indice': 'índice maestro NIIF/IFRS: toda norma vigente con su estado, vigencias 2025-2029, supletoriedad, y cómo actualizar el corpus',
  'niif-marco-presentacion': 'Marco Conceptual IASB, NIC 1→NIIF 18 (2027), NIIF 19, NIC 7/8/10/34, NIIF 8, NIC 24/33',
  'niif-activos': 'activos no financieros IFRS: NIC 2 inventarios, 16 PP&E, 23, 36 deterioro, 38 intangibles, 40, 41, NIIF 5/6',
  'niif-instrumentos-financieros': 'NIC 32, NIIF 7, NIIF 9 (clasificación SPPI, pérdidas esperadas, coberturas, enmiendas 2026), NIIF 13 valor razonable',
  'niif-ingresos-arrendamientos': 'NIIF 15 ingresos (5 pasos a detalle), NIIF 16 arrendamientos (derecho de uso, arrendador, sale-leaseback), NIC 20',
  'niif-pasivos-empleados-impuestos': 'NIC 37 provisiones, NIC 19 beneficios definidos, NIIF 2, NIC 12 impuestos diferidos + pilar 2, NIC 26',
  'niif-grupos': 'NIIF 3 combinaciones, NIIF 10/11/12 consolidación y acuerdos conjuntos, NIC 27/28 método de participación',
  'niif-moneda-seguros-adopcion': 'NIC 21 moneda extranjera (enmiendas 2025/2027), NIC 29 hiperinflación, NIIF 17 seguros, NIIF 1, NIIF 14→NIIF 20 (2029)',
  'niif-interpretaciones': 'las 20 interpretaciones CINIIF/SIC vigentes + decisiones de agenda (criptoactivos, SaaS, depósitos restringidos)',
  'niif-pymes-convergencia': 'NIIF para PyMEs 3a edición (2027) y mapa de convergencia NIF mexicanas ↔ IFRS con supletoriedad práctica',
} as const;

export type DocTopic = keyof typeof DOC_TOPICS;

const DOCS_DIR = path.join(__dirname, '..', 'docs');

export function readDoc(topic: DocTopic): string {
  return fs.readFileSync(path.join(DOCS_DIR, `${topic}.md`), 'utf-8');
}

/** One-line index per topic, for the stable block of the system prompt. */
export function docsIndex(): string {
  return Object.entries(DOC_TOPICS)
    .map(([topic, summary]) => `- ${topic}: ${summary}`)
    .join('\n');
}

export function buildDocsTools(deps: ToolDeps) {
  const readDocsTool = betaZodTool({
    name: 'read_docs',
    description:
      'Reads the internal documentation of a system module. Use it BEFORE operating or explaining a ' +
      'module you do not master (payroll, CFDI, reconciliation, AR/AP…): it says what you can do with ' +
      'your tools and what the human must do (exact CLI command or REST endpoint). Cheap and local — ' +
      'when in doubt, read it.',
    inputSchema: z.object({
      topic: z.enum(Object.keys(DOC_TOPICS) as [DocTopic, ...DocTopic[]]).describe('Module to consult'),
    }),
    run: (input) => {
      deps.observe?.('read_docs', input);
      return readDoc(input.topic);
    },
  });

  return [readDocsTool];
}
