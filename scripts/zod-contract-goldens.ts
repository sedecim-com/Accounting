/**
 * Writes or checks the two goldens that pin what Zod does behind the API.
 *
 *   npx tsx scripts/zod-contract-goldens.ts --write   rewrites both files
 *   npx tsx scripts/zod-contract-goldens.ts --check   exits 1 when either is stale
 *
 * CONTRACT: tests/api/golden/rest-body.golden.json is the 422 body (and the
 * parsed body) of every REST request-body probe; tests/ai/tools/
 * tool-schemas.golden.json is the input schema every agent tool sends to the
 * model. Both were recorded on zod 3.25.76 before the Zod 4 migration (#367),
 * and that migration must pass against them WITHOUT regenerating them: a diff
 * here is a client-visible change, and it goes through its own CONTRACT PR.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REST_BODY_GOLDEN, ROOT, recordRestBodyGolden } from '../tests/api/golden/rest-body-probes.js';
import { TOOL_SCHEMAS_GOLDEN, recordToolSchemas } from '../tests/ai/tools/tool-schema-snapshot.js';

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(args: string[]): number {
  const goldens: Array<[string, string]> = [
    [REST_BODY_GOLDEN, serialize(recordRestBodyGolden())],
    [TOOL_SCHEMAS_GOLDEN, serialize(recordToolSchemas())],
  ];

  if (args.includes('--write')) {
    for (const [file, text] of goldens) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      process.stdout.write(`Wrote ${path.relative(ROOT, file)}.\n`);
    }
    return 0;
  }

  if (args.includes('--check')) {
    const stale = goldens.filter(
      ([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text
    );
    for (const [file] of stale) {
      process.stderr.write(
        `${path.relative(ROOT, file)} does not match what Zod does today. It is a contract ` +
          'pin: find the change that moved it before regenerating with --write.\n'
      );
    }
    if (stale.length === 0) process.stdout.write('The Zod contract goldens are up to date.\n');
    return stale.length === 0 ? 0 : 1;
  }

  process.stderr.write('usage: zod-contract-goldens.ts --write | --check\n');
  return 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
