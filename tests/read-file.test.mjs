import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile, setWorkspace, TOOL_DEFINITIONS } from '../src/tools.js';

test('read_file honors max_lines and rejects invalid limits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-read-file-'));
  try {
    setWorkspace(root);
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(root, 'main.py'), lines.join('\n'));
    assert.equal(readFile({ path: 'main.py', max_lines: 10 }), lines.slice(0, 10).join('\n'));
    assert.equal(readFile({ path: 'main.py' }), lines.join('\n'));
    for (const max_lines of [0, -1, 1.5, '10', 10001]) assert.throws(() => readFile({ path: 'main.py', max_lines }), /max_lines/);
    assert.equal(TOOL_DEFINITIONS.find(t => t.function.name === 'read_file').function.parameters.properties.max_lines.type, 'integer');
  } finally {
    setWorkspace(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
