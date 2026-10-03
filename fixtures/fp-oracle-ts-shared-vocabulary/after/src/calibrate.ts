import { familyOf } from './rules.js';

export function population(rule: string, commits: number, touchingTests: number): number {
  if (familyOf(rule) === 'test integrity') return touchingTests || commits;
  return commits;
}
