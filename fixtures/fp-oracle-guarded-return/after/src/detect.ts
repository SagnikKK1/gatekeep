export function detectTestCommand(at: (p: string) => string | null): { command: string; from: string } | null {
  for (const [file, marker] of MARKERS) {
    const raw = at(file);
    if (raw?.includes(marker)) return { command: 'pytest -q', from: `${file} ${marker}` };
  }
  return null;
}
