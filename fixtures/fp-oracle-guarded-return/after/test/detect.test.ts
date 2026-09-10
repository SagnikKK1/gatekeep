import { detectTestCommand } from '../src/detect.js';

test('detects a pytest project from pyproject.toml', () => {
  const found = detectTestCommand(() => '[tool.pytest.ini_options]\naddopts = "-q"\n');
  assert.equal(found?.command, 'pytest -q');
  assert.match(found?.from ?? '', /pyproject/);
});
