import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// @vscode/tree-sitter-wasm ships CommonJS; load it via require.
const TS = require('@vscode/tree-sitter-wasm') as typeof import('@vscode/tree-sitter-wasm');

export type SyntaxNode = import('@vscode/tree-sitter-wasm').Node;
export type Tree = import('@vscode/tree-sitter-wasm').Tree;
export type Lang = 'python' | 'javascript' | 'typescript' | 'tsx' | 'go' | 'rust' | 'java' | 'ruby';

// Resolve through the package itself so hoisted installs (npm i -D gatekeep) still find the wasm files.
const wasmDir = path.join(path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');

let initialized: Promise<void> | null = null;
const parsers = new Map<Lang, Promise<import('@vscode/tree-sitter-wasm').Parser>>();

async function parserFor(lang: Lang) {
  if (!initialized) initialized = TS.Parser.init();
  await initialized;
  let p = parsers.get(lang);
  if (!p) {
    p = TS.Language.load(path.join(wasmDir, `tree-sitter-${lang}.wasm`)).then((language) => {
      const parser = new TS.Parser();
      parser.setLanguage(language);
      return parser;
    });
    parsers.set(lang, p);
  }
  return p;
}

export class ParseTimeout extends Error {
  constructor(public readonly lang: Lang, public readonly ms: number) { super(`parsing ${lang} source exceeded ${ms} ms`); }
}

/** Some grammars go quadratic on hostile input (tens of thousands of comment lines). Cap the time; the caller treats a timeout as unreadable. */
export const PARSE_TIMEOUT_MS = Number(process.env.GATEKEEP_PARSE_TIMEOUT_MS ?? 8000);

/** Parse `source`, run `fn` on the tree, and free the wasm-side tree afterwards. One parser per language is reused. */
export async function withTree<T>(source: string, lang: Lang, fn: (tree: Tree) => T): Promise<T> {
  const parser = await parserFor(lang);
  const t0 = Date.now();
  const tree = parser.parse(source, null, { progressCallback: () => Date.now() - t0 > PARSE_TIMEOUT_MS });
  if (!tree) throw new ParseTimeout(lang, PARSE_TIMEOUT_MS);
  try { return fn(tree); } finally { tree.delete(); }
}

/** Depth-first walk. Return false from visit to skip a node's children. */
export function walk(node: SyntaxNode, visit: (n: SyntaxNode) => boolean | void): void {
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    const r = visit(n);
    if (r === false) continue;
    const ks = kids(n);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]!);
  }
}

export function descendants(node: SyntaxNode, type: string | string[]): SyntaxNode[] {
  const types = Array.isArray(type) ? new Set(type) : new Set([type]);
  const out: SyntaxNode[] = [];
  walk(node, (n) => { if (types.has(n.type)) out.push(n); });
  return out;
}

/** Nearest ancestor (excluding self) whose type is in `types`, stopping at `stopAt` if given. */
export function ancestor(node: SyntaxNode, types: string[], stopAt?: SyntaxNode): SyntaxNode | null {
  const set = new Set(types);
  let cur = node.parent;
  while (cur) {
    if (stopAt && cur.id === stopAt.id) return null;
    if (set.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

export function countErrors(tree: Tree): number {
  let n = 0;
  walk(tree.rootNode, (node) => { if (node.type === 'ERROR' || node.isMissing) n++; });
  return n;
}

export function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0], b = t[t.length - 1];
    if ((a === '"' || a === "'" || a === '`') && a === b) return t.slice(1, -1);
    // python prefixed strings: r"..", f"..", b".."
    const m = /^[a-zA-Z]{1,2}(["'])([\s\S]*)\1$/.exec(t);
    if (m) return m[2] ?? '';
  }
  return t;
}

/** Non-null children. */
export function kids(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return n ? (n.children.filter((c) => c !== null) as SyntaxNode[]) : [];
}
/** Non-null named children. */
export function named(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return n ? (n.namedChildren.filter((c) => c !== null) as SyntaxNode[]) : [];
}

/** Identifier/literal tokens of a snippet, for similarity scoring. */
export function tokens(s: string): string[] {
  return s.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'|`[^`]*`|[=!<>]=+|[-+*/%&|^~<>]/g) ?? [];
}
