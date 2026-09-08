export type Severity = 'block' | 'warn' | 'off';

export interface Assertion {
  line: number;
  /** strong = checks a specific value; weak = truthiness / existence / broad / tautology. */
  strength: 'strong' | 'weak';
  text: string;
  /** Subject expression (what is being checked), normalized, for pairing before/after. */
  subject: string;
  /** False when the assertion can never execute: under a constant-false condition, after an unconditional exit, or in a function that is never called. */
  reachable: boolean;
}

export interface Mock {
  line: number;
  /** Module-ish target: python dotted path, or a JS import specifier / object expression. */
  target: string;
  text: string;
  /** True when the replacement is a plain literal (constant override) rather than behavior. */
  literal: boolean;
  /** True for whole-module mocks (jest.mock('x'), patch('pkg.mod')) vs a single attribute. */
  wholeModule: boolean;
}

export interface Tolerance {
  line: number;
  /** Larger = looser. */
  looseness: number;
  kind: string;
  text: string;
  /** Normalized text of the enclosing assertion minus the tolerance, for pairing. */
  key: string;
}

export interface TestCase {
  /** Qualified name, e.g. "TestAuth.test_login" or "auth > rejects bad password". */
  name: string;
  line: number;
  assertions: Assertion[];
  skip: { line: number; marker: string; conditional: boolean } | null;
  only: { line: number; marker: string } | null;
  mocks: Mock[];
  /** Assertions inside try/except(catch) whose handler neither asserts nor re-raises. */
  swallowed: { line: number; text: string }[];
  retry: { line: number; text: string } | null;
  tolerances: Tolerance[];
  timeout: { line: number; ms: number } | null;
  /** Whitespace-normalized body text, used to detect renames. */
  body: string;
  /** Number of exit statements (return/throw/raise/skip) that precede the first assertion. */
  earlyExits: number;
  /** Test is data-driven (parametrize / it.each / table loop). */
  parametrized: boolean;
  /** Data-driven with an empty data set: runs zero cases. */
  vacuous: boolean;
  /** Normalized text of the data table (parametrize argvalues, it.each rows, loop iterable), for consolidation matching. */
  data: string;
}

export interface TestFileModel {
  path: string;
  lang: string;
  tests: TestCase[];
  /** Module-level mocks (jest.mock at top, class-level @patch, autouse fixtures). */
  fileMocks: Mock[];
  fileSkip: { line: number; marker: string } | null;
  fileRetry: { line: number; text: string } | null;
  parseErrors: number;
  /** Local bindings that shadow the assertion library: `const expect = ...`, `def assert_...` no-op. */
  shadowed: { line: number; name: string }[];
  /** JS: local import binding -> specifier. Python: imported name -> module. */
  imports: Record<string, string>;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface FileChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  before?: string;
  after?: string;
  /** Set when the content could not be loaded (too large, binary): tells the rules not to treat it as absent. */
  unreadable?: 'before' | 'after' | 'both';
}

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line?: number;
  test?: string;
  message: string;
  before?: string;
  after?: string;
}
