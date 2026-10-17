/**
 * Resolve the workspace's real dependencies from the A6 harness.
 *
 * Two problems have to be solved here, and neither may be solved by touching a
 * `package.json` (`AGENTS.md` §2) or adding a dependency (R3):
 *
 * 1. **Location.** The harness lives at the repository root, where pnpm's strict
 *    linking exposes none of `yjs` / `y-protocols` / `lib0` — only `vitest`,
 *    `typescript` and `prettier` are root devDependencies. Resolution is therefore
 *    anchored at the workspace packages that already declare these dependencies,
 *    which is exactly where a real consumer finds them. `lib0` is anchored at
 *    `packages/shared`, because `apps/server` cannot see it (documented under the
 *    M1-A3 notes in `docs/TASKS.md`).
 *
 * 2. **Module identity.** `require.resolve` selects npm's `require` condition, so
 *    it yields the CJS build (`yjs/dist/yjs.cjs`, `y-protocols/dist/sync.cjs`)
 *    while `@insighthub/shared`'s compiled ESM imports the ESM build. Loading both
 *    gives **two** `Y.Doc` classes in one process, which yjs itself warns about
 *    ("Yjs was already imported… this breaks constructor checks") and which would
 *    make every convergence assertion in this suite meaningless: a document from
 *    one instance is not the document the codec from the other instance expects.
 *
 *    So the resolver below finds the package directory the plain way and then
 *    selects the **`import` condition** from the package's own `exports` map — the
 *    same target a real ESM importer in `apps/web` or `packages/shared` gets.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `<repo>` — `tests/browser/lib` is three levels below the root. */
export const repoRoot = path.resolve(here, '..', '..', '..');

/** Where the harness writes evidence (screenshots, JSON reports). */
export const artifactsDir = path.join(repoRoot, 'tests', 'browser', 'artifacts');

const anchors = [
  createRequire(path.join(repoRoot, 'apps', 'server', 'package.json')),
  createRequire(path.join(repoRoot, 'apps', 'web', 'package.json')),
  createRequire(path.join(repoRoot, 'packages', 'shared', 'package.json')),
];

/** Split `@scope/name/sub` into `{ name: '@scope/name', subpath: './sub' }`. */
function parseSpecifier(specifier) {
  const segments = specifier.split('/');
  const nameLength = specifier.startsWith('@') ? 2 : 1;
  const name = segments.slice(0, nameLength).join('/');
  const rest = segments.slice(nameLength).join('/');
  return { name, subpath: rest === '' ? '.' : `./${rest}` };
}

/** The nearest `package.json` at or above `filePath`. */
function nearestPackageJson(filePath) {
  let directory = path.dirname(filePath);
  for (;;) {
    const candidate = path.join(directory, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Pick the target a real ESM importer would use from an `exports` entry. */
function pickImportTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object') return null;
  for (const condition of ['import', 'module', 'node', 'default']) {
    if (entry[condition] !== undefined) {
      const resolved = pickImportTarget(entry[condition]);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/**
 * Resolve a bare specifier to an absolute file path using the package's `import`
 * condition. Throws a message naming the missing dependency when it cannot.
 */
export function resolveDependency(specifier) {
  const { subpath } = parseSpecifier(specifier);
  const failures = [];

  for (const anchor of anchors) {
    let cjsPath;
    try {
      cjsPath = anchor.resolve(specifier);
    } catch (error) {
      failures.push(error.code ?? String(error));
      continue;
    }

    const packageJsonPath = nearestPackageJson(cjsPath);
    if (packageJsonPath === null) return cjsPath;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    } catch {
      return cjsPath;
    }

    const packageDirectory = path.dirname(packageJsonPath);
    const exportsField = manifest.exports;
    let target = null;

    if (exportsField !== undefined) {
      const entry =
        typeof exportsField === 'string' ? exportsField : (exportsField[subpath] ?? null);
      target = pickImportTarget(entry);
    }
    if (target === null) {
      target = subpath === '.' ? (manifest.module ?? manifest.main ?? null) : null;
    }
    if (target === null) return cjsPath;

    const absolute = path.resolve(packageDirectory, target);
    if (!existsSync(absolute)) return cjsPath;
    return absolute;
  }

  throw new Error(
    `cannot resolve ${specifier} from any workspace package (${failures.join(', ')}). ` +
      'Run `pnpm install` and `pnpm build` first.',
  );
}

/** Import a bare specifier as an ES module, from its ESM build. */
export async function importDependency(specifier) {
  return import(pathToFileURL(resolveDependency(specifier)).href);
}

let sharedPromise;
/** The shared contract package — the same module instance the apps use. */
export function loadShared() {
  sharedPromise ??= importDependency('@insighthub/shared');
  return sharedPromise;
}

let yjsPromise;
export function loadYjs() {
  yjsPromise ??= importDependency('yjs');
  return yjsPromise;
}

let syncPromise;
export function loadSyncProtocol() {
  syncPromise ??= importDependency('y-protocols/sync');
  return syncPromise;
}

let awarenessPromise;
export function loadAwarenessProtocol() {
  awarenessPromise ??= importDependency('y-protocols/awareness');
  return awarenessPromise;
}
