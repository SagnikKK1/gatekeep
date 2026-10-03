export type Family = 'test integrity' | 'check integrity' | 'scope';

export function familyOf(rule: string): Family {
  if (rule.startsWith('scope-')) return 'scope';
  if (rule.endsWith('-weakened') && rule.startsWith('ci')) return 'check integrity';
  return 'test integrity';
}
