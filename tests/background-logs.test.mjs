import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace, startBackgroundProcess, readBackgroundProcess, stopBackgroundProcess } from '../src/tools.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('background stdout and stderr use a discoverable file and remain readable through the tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-background-test-'));
  const previous = process.env.AGENT_TERMINAL_LOG_ROOT;
  process.env.AGENT_TERMINAL_LOG_ROOT = path.join(root, 'logs');
  setWorkspace(root);
  const id = 'logs-test';
  let pid;
  try {
    const started = startBackgroundProcess({ process_id: id, command: 'printf "startup stdout\\n"; printf "startup stderr\\n" >&2; while true; do printf "live log\\n"; sleep 0.1; done' });
    pid = Number(started.match(/pid=(\d+)/)[1]);
    let output = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      output = readBackgroundProcess({ process_id: id });
      if (output.includes('startup stdout') && output.includes('startup stderr') && output.includes('live log')) break;
      await pause(20);
    }
    assert.match(output, /startup stdout/);
    assert.match(output, /startup stderr/);
    assert.match(output, /live log/);
    const stdout = fs.readlinkSync(`/proc/${pid}/fd/1`);
    assert.equal(stdout, fs.readlinkSync(`/proc/${pid}/fd/2`));
    assert.equal(path.basename(stdout), 'stdout.log');
    const before = fs.statSync(stdout).size;
    await pause(150);
    assert.ok(fs.statSync(stdout).size > before, 'workspace log source must receive live output');
    const log = fs.openSync(stdout, 'a');
    fs.writeSync(log, 'x'.repeat(100000) + '\nlatest tail\n'); fs.closeSync(log);
    assert.match(readBackgroundProcess({ process_id: id, max_lines: 1 }), /latest tail|live log/);
  } finally {
    if (pid) { try { stopBackgroundProcess({ process_id: id, signal_name: 'KILL' }); } catch {} }
    await pause(50);
    if (previous === undefined) delete process.env.AGENT_TERMINAL_LOG_ROOT; else process.env.AGENT_TERMINAL_LOG_ROOT = previous;
    setWorkspace(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
