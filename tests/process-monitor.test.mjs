import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, readBackgroundProcess, monitorBackgroundProcess, stopBackgroundProcess, startBackgroundProcess, listBackgroundProcesses, setWorkspace } from '../src/tools.js';
import { withCommandExecution } from '../src/command_execution.js';
import { commandOutcome } from '../src/command_output.js';
import { installToolEvents } from '../src/tool_events.js';

const idFrom = output => output.match(/\[background_process_id=([^\]]+)\]/)?.[1];
async function isolated(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-monitor-'));
  const previous = process.env.AGENT_TERMINAL_LOG_ROOT;
  process.env.AGENT_TERMINAL_LOG_ROOT = path.join(root, 'logs');
  setWorkspace(root);
  const ids = [];
  try { await action(ids, root); }
  finally {
    for (const process_id of ids) {
      stopBackgroundProcess({ process_id, signal_name: 'KILL' });
      await monitorBackgroundProcess({ process_id, wait_seconds: 1 });
    }
    if (previous === undefined) delete process.env.AGENT_TERMINAL_LOG_ROOT; else process.env.AGENT_TERMINAL_LOG_ROOT = previous;
    setWorkspace(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('automatic handoff keeps the same process, streams only before handoff, and monitors completion', async () => isolated(async (ids, root) => {
  const controller = new AbortController();
  const deltas = [];
  const started = Date.now();
  const output = await withCommandExecution({ signal: controller.signal, onOutput: text => deltas.push(text) },
    () => runCommand({ command: 'echo $$ > pid; printf "startup\\n"; sleep 2.2; printf "done\\n"', yield_after_seconds: 1 }));
  const process_id = idFrom(output); ids.push(process_id);
  assert.ok(process_id);
  assert.ok(Date.now() - started < 2100);
  assert.equal(commandOutcome('run_command', output).status, 'backgrounded');
  const pid = Number(output.match(/pid=(\d+)/)[1]);
  assert.equal(pid, Number(fs.readFileSync(path.join(root, 'pid'), 'utf8')));
  assert.match(readBackgroundProcess({ process_id }), /running pid=/);
  assert.match(readBackgroundProcess({ process_id }), /startup/);
  const liveCount = deltas.length;
  controller.abort(); // The foreground turn no longer owns the background job.
  const final = await monitorBackgroundProcess({ process_id, wait_seconds: 3 });
  assert.match(final, /exited\(0\) pid=/);
  assert.match(final, /startup\ndone/);
  assert.equal(deltas.length, liveCount, 'background output must not target a completed tool event');
  assert.deepEqual(commandOutcome('monitor_background_process', final), { status: 'passed', exitCode: 0 });
}));

test('a background execution deadline remains enforced and is distinct from monitor wait expiry', async () => isolated(async ids => {
  const output = await runCommand({ command: 'printf "ready\\n"; sleep 30', yield_after_seconds: 1, max_time_seconds: 3 });
  const process_id = idFrom(output); ids.push(process_id);
  const pending = await monitorBackgroundProcess({ process_id, wait_seconds: 1 });
  assert.match(pending, /running pid=/);
  assert.equal(commandOutcome('monitor_background_process', pending).status, 'inProgress');
  const final = await monitorBackgroundProcess({ process_id, wait_seconds: 3 });
  assert.match(final, /timedOut pid=/);
  assert.match(final, /\[timeout_seconds=3\]/);
  assert.equal(commandOutcome('monitor_background_process', final).status, 'timedOut');
}));

test('background failures preserve the real exit code and completed jobs can be checked repeatedly', async () => isolated(async ids => {
  const output = await runCommand({ command: 'sleep 1.2; printf "build failed\\n" >&2; exit 7', yield_after_seconds: 1 });
  const process_id = idFrom(output); ids.push(process_id);
  const final = await monitorBackgroundProcess({ process_id, wait_seconds: 2 });
  assert.match(final, /build failed/);
  assert.deepEqual(commandOutcome('monitor_background_process', final), { status: 'failed', exitCode: 7 });
  assert.equal(await monitorBackgroundProcess({ process_id, wait_seconds: 0 }), final);
}));

test('monitoring is interruptible without stopping the process, and signal exits are not reported as running', async () => isolated(async ids => {
  const process_id = 'explicit-monitor'; ids.push(process_id);
  startBackgroundProcess({ process_id, command: 'printf "server\\n"; sleep 30' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Monitor interrupted')), 50);
  try {
    await assert.rejects(withCommandExecution({ signal: controller.signal }, () => monitorBackgroundProcess({ process_id, wait_seconds: 30 })), /Monitor interrupted/);
  } finally { clearTimeout(timer); }
  assert.match(readBackgroundProcess({ process_id }), /running pid=/);
  stopBackgroundProcess({ process_id, signal_name: 'TERM' });
  const final = await monitorBackgroundProcess({ process_id, wait_seconds: 2 });
  assert.match(final, /signaled\(SIGTERM\)/);
  assert.equal(commandOutcome('monitor_background_process', final).status, 'failed');
  assert.match(listBackgroundProcesses(), /explicit-monitor\tsignaled\(SIGTERM\)/);
}));

test('native tool events expose the background handle and never claim exit success on handoff', async () => isolated(async ids => {
  const events = [];
  const agent = { async toolMessage(c) { return { content: await runCommand(JSON.parse(c.function.arguments)) }; } };
  installToolEvents(agent, (method, params) => events.push({ method, params }));
  const result = await agent.toolMessage({ id: 'auto', function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 30', yield_after_seconds: 1 }) } });
  const process_id = idFrom(result.content); ids.push(process_id);
  const item = events.at(-1).params.item;
  assert.equal(item.status, 'backgrounded');
  assert.equal(item.processId, process_id);
  assert.equal(item.exitCode, null);
}));

test('invalid monitor handles and wait limits fail immediately', async () => isolated(async ids => {
  await assert.rejects(monitorBackgroundProcess({ process_id: 'missing' }), /not found/);
  const process_id = 'invalid-wait'; ids.push(process_id);
  startBackgroundProcess({ process_id, command: 'sleep 30' });
  for (const wait_seconds of [-1, 31, 1.5, '10']) await assert.rejects(monitorBackgroundProcess({ process_id, wait_seconds }), /wait_seconds/);
  await assert.rejects(runCommand({ command: 'echo should-not-run', yield_after_seconds: 0 }), /yield_after_seconds/);
}));
