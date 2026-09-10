import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Releasing, so that npm is a channel of this repository rather than a thing someone has to remember. The package
 * on npm sat 57 commits behind `main` for two days because publishing was a manual step with nothing checking it,
 * and the README documented three commands no published build contained.
 *
 * One version string has to be identical in four places, and `test/manifest.test.ts` fails when they diverge:
 *   package.json                      the package itself
 *   .claude-plugin/plugin.json        what the plugin directory installs
 *   .claude-plugin/marketplace.json   what the directory lists
 *   hooks/gatekeep-hook.sh            the `npx` fallback, which must name a version that exists on the registry
 *
 * package.json (and the lockfile with it) is `npm version`'s job. This module owns the other three, and picks the
 * number.
 */

export const PACKAGE_NAME = 'gatekeep-agent';

/** Files this module rewrites. package.json and package-lock.json are deliberately not here: `npm version` owns those. */
export const VERSION_FILES = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/gatekeep-hook.sh'] as const;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * The version to publish next. The one in package.json wins whenever the registry does not already have it, so a
 * deliberate `0.2.0` for a release with new commands is respected; otherwise the first free patch above it, so a
 * push that changes the package always reaches users instead of failing on an immutable version.
 */
export function nextVersion(current: string, published: string[]): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`package.json version "${current}" is not a plain x.y.z version`);
  const taken = new Set(published);
  if (!taken.has(current)) return current;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  for (let patch = Number(m[3]) + 1; patch < 10000; patch++) {
    const v = `${major}.${minor}.${patch}`;
    if (!taken.has(v)) return v;
  }
  throw new Error(`no free patch version above ${current}`);
}

/** Every version already on the registry. An unpublished package (or no network) yields none. */
export async function publishedVersions(name = PACKAGE_NAME): Promise<string[]> {
  try {
    const { stdout } = await execFileP('npm', ['view', name, 'versions', '--json'], { maxBuffer: 8 * 1024 * 1024 });
    const j: unknown = JSON.parse(stdout);
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : typeof j === 'string' ? [j] : [];
  } catch { return []; }
}

/**
 * Rewrite one file's version in place. Regex rather than a JSON round-trip: it keeps the hand-written formatting.
 * A missing field is an error — silently doing nothing is how these four drift apart — but a file already carrying
 * the version is not, or a re-run would fail on the files it had just finished writing.
 */
function rewrite(file: string, text: string, version: string): string {
  const re = file.endsWith('.sh')
    ? new RegExp(`(pinned=${PACKAGE_NAME}@)\\d+\\.\\d+\\.\\d+`)
    : /("version":\s*")\d+\.\d+\.\d+(")/;
  if (!re.test(text)) throw new Error(`${file}: no ${file.endsWith('.sh') ? `"pinned=${PACKAGE_NAME}@x.y.z" line` : '"version" field'} to update`);
  return text.replace(re, file.endsWith('.sh') ? `$1${version}` : `$1${version}$2`);
}

/** Put `version` into every file this module owns. Returns the ones that actually changed. */
export async function syncVersion(root: string, version: string): Promise<string[]> {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a plain x.y.z version`);
  const changed: string[] = [];
  for (const rel of VERSION_FILES) {
    const file = path.join(root, rel);
    const text = await fs.readFile(file, 'utf8');
    const out = rewrite(rel, text, version);
    if (out !== text) { await fs.writeFile(file, out); changed.push(rel); }
  }
  return changed;
}

/* ------------------------------------------------------------------ CLI, used by the release job in ci.yml */

async function main(argv: string[]): Promise<number> {
  const root = process.cwd();
  const cmd = argv[0];
  if (cmd === 'next') {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    process.stdout.write(nextVersion(pkg.version, await publishedVersions()) + '\n');
    return 0;
  }
  if (cmd === 'set') {
    const v = argv[1];
    if (!v) { console.error('usage: release set <version>'); return 2; }
    const changed = await syncVersion(root, v);
    console.log(changed.length ? `${v}: updated ${changed.join(', ')}` : `${v}: already set everywhere`);
    return 0;
  }
  console.error('usage: release next | release set <version>');
  return 2;
}

// Only when run directly, so importing this from a test never touches the filesystem or the network.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'src', 'release.js'))) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e: Error) => { console.error(`release: ${e.message}`); process.exitCode = 1; });
}
