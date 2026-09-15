import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATIC_ASSETS } from '../../src/gateway/static-assets.js';
import { startHarness, type Harness } from './helpers/harness.js';

// ============================================================
// W1 · the browser program builds, and the gateway serves what it built.
//
// CI never runs `npm run build`, so this spec does its web half in process:
// it compiles tsconfig.web.json through the TypeScript API into a temporary
// directory, requires the emitted module set to be exactly the /modules
// entries of STATIC_ASSETS (a module the table forgets is a 404 in the page, a
// table entry nothing emits refuses startup), follows every relative import
// of the emitted code, and serves the result through the real gateway app.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'src', 'gateway', 'public');

let workDir: string;
let modulesDir: string;
let emitted: string[] = [];
let diagnostics: string[] = [];
let h: Harness | undefined;

function filesUnder(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-web-build-'));
  modulesDir = path.join(workDir, 'modules');
  const configPath = path.join(ROOT, 'tsconfig.web.json');
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, configPath);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, outDir: modulesDir });
  const result = program.emit();
  diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...result.diagnostics].map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')
  );
  emitted = fs.existsSync(modulesDir) ? filesUnder(modulesDir).sort() : [];
}, 60_000);

afterAll(async () => {
  await h?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the web program', () => {
  it('compiles with no diagnostic', () => {
    expect(diagnostics).toEqual([]);
  });

  it('emits exactly the modules STATIC_ASSETS publishes, and nothing else (no source maps, no declarations)', () => {
    const published = STATIC_ASSETS.filter(([, file]) => file.startsWith('modules/'))
      .map(([, file]) => file.slice('modules/'.length))
      .sort();
    expect(emitted.length).toBeGreaterThanOrEqual(9);
    expect(emitted).toEqual(published);
    for (const [publishedPath, file, contentType] of STATIC_ASSETS.filter(([, f]) => f.startsWith('modules/'))) {
      expect(publishedPath).toBe(`/${file}`);
      expect(contentType).toBe('text/javascript; charset=utf-8');
    }
  });

  it('every relative import of the emitted code resolves to an emitted module, and nothing is bare', () => {
    for (const file of emitted) {
      const code = fs.readFileSync(path.join(modulesDir, file), 'utf8');
      for (const { fileName: specifier } of ts.preProcessFile(code, true, true).importedFiles) {
        expect(specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports ${specifier}`).toBe(true);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        expect(emitted, `${file} imports ${specifier}, which was not emitted`).toContain(target);
      }
    }
  });

  it('the gateway serves the built program from a public root laid out like dist', async () => {
    const publicRoot = path.join(workDir, 'public');
    fs.cpSync(PUBLIC, publicRoot, { recursive: true });
    fs.cpSync(modulesDir, path.join(publicRoot, 'modules'), { recursive: true });
    h = await startHarness({ staticRoot: { dir: publicRoot, remove: () => undefined } });

    for (const [publishedPath, file, contentType] of STATIC_ASSETS) {
      const res = await h.request('GET', publishedPath);
      expect(res.status, publishedPath).toBe(200);
      expect(res.headers['content-type'], publishedPath).toBe(contentType);
      expect(res.body, publishedPath).toBe(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
    }
    const main = await h.request('GET', '/modules/gateway/app/main.js');
    expect(main.body).toMatch(/from '\.\/dom\.js'/);
  }, 30_000);
});

describe('the shell', () => {
  const shell = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  it('has no inline script, no style attribute and no event-handler attribute', () => {
    for (const [, attributes, body] of shell.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(attributes).toMatch(/\ssrc="/);
      expect(body.trim()).toBe('');
    }
    expect(shell).not.toMatch(/\sstyle\s*=|<style\b|\son[a-z]+\s*=/i);
  });

  it('every script and stylesheet it names is a published file', () => {
    const published = new Set(STATIC_ASSETS.map(([publishedPath]) => publishedPath));
    const targets = [...shell.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((target) => !target.startsWith('#'));
    expect(targets).toEqual(['/design/tokens.css', '/app.css', '/modules/gateway/app/main.js']);
    for (const target of targets) expect(published.has(target), target).toBe(true);
    expect(shell).toMatch(/<script type="module" src="\/modules\/gateway\/app\/main\.js"><\/script>/);
  });

  it('carries no translatable prose: the page sets its title and skip link from the catalog', () => {
    const visible = shell
      .replace(/<title>mnemosine<\/title>/, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    expect(visible).toBe('');
    expect(shell).toMatch(/<a id="skip-link" class="skip-link" href="#app"><\/a>/);
    expect(shell).toMatch(/<main id="app" tabindex="-1"><\/main>/);
  });
});
