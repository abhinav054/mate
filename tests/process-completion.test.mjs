import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer } from '../src/server.js';
import { withCommandExecution } from '../src/command_execution.js';
import { runCommand, monitorBackgroundProcess, TOOL_DEFINITIONS } from '../src/tools.js';

const notice = { processId: 'bg-result', command: 'build', cwd: '/workspace', pid: 123,
  status: 'completed', exitCode: 0, signal: null, durationMs: 1234, logFile: '/tmp/build/stdout.log', output: 'build succeeded' };
const answer = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
function createAgent(create, ui = { activity() {} }) {
  const agent = new AgentServer({ client: { chat: { completions: { create } } }, model: 'test', ui,
    messages: [], mateConfig: { raw: {}, approval: { auto_approve: true } } });
  agent.compactContextIfNeeded = async () => {};
  agent.saveNewMessages = () => {};
  return agent;
}

test('foreground schema defaults to sixty seconds independently of bounded monitor waits', () => {
  for (const name of ['run_command', 'git', 'run_plugin_hook']) {
    const schema = TOOL_DEFINITIONS.find(t => t.function.name === name).function.parameters.properties;
    assert.equal(schema.yield_after_seconds.default, 60);
    assert.equal(schema.yield_after_seconds.maximum, 60);
  }
  assert.equal(TOOL_DEFINITIONS.find(t => t.function.name === 'monitor_background_process').function.parameters.properties.wait_seconds.maximum, 30);
});

test('automatic background completion delivers final output and execution metadata exactly once', async () => {
  const events = [];
  const output = await withCommandExecution({ onBackgroundComplete: event => events.push(event) },
    () => runCommand({ command: 'printf "start\\n"; sleep 1.2; printf "final stderr\\n" >&2; exit 7', yield_after_seconds: 1 }));
  const process_id = output.match(/\[background_process_id=([^\]]+)\]/)[1];
  await monitorBackgroundProcess({ process_id, wait_seconds: 3 });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.processId, process_id);
  assert.equal(event.status, 'failed');
  assert.equal(event.exitCode, 7);
  assert.equal(event.signal, null);
  assert.match(event.output, /start\nfinal stderr/);
  assert.match(event.command, /exit 7/);
  assert.ok(event.cwd);
  assert.ok(event.durationMs >= 1000);
  assert.ok(event.pid > 0);
  assert.match(event.logFile, /stdout.log$/);
  await monitorBackgroundProcess({ process_id, wait_seconds: 0 });
  assert.equal(events.length, 1);
});

test('completion during a model request is injected before accepting a final answer', async () => {
  let calls = 0;
  const agent = createAgent(async ({ messages }) => {
    if (++calls === 1) { agent.queueProcessCompletion(notice); return answer('stale answer'); }
    const event = messages.find(m => m.content?.includes('Background process completion'));
    assert.ok(event);
    assert.match(event.content, /build succeeded/);
    assert.match(event.content, /"exitCode":0/);
    return answer('Build completed successfully');
  });
  assert.equal(await agent.runAgentUntilAnswer('Build'), 'Build completed successfully');
  assert.equal(calls, 2);
  assert.equal(agent.hasPendingProcessCompletions(), false);
  assert.equal(agent.messages.some(m => m.content === 'stale answer'), false);
});

test('interrupt rollback retains completion events for the next user turn', async () => {
  let interrupted = false;
  const agent = createAgent(async ({ messages }) => {
    assert.ok(messages.some(m => m.content?.includes('build succeeded')));
    if (!interrupted) {
      interrupted = true;
      agent.interruptCurrentTurn();
      throw new Error('aborted');
    }
    return answer('Result reviewed');
  });
  agent.queueProcessCompletion(notice);
  await assert.rejects(agent.runTurn('Check the result'), /interrupted/i);
  assert.equal(agent.hasPendingProcessCompletions(), true);
  assert.equal(await agent.runTurn('Continue'), 'Result reviewed');
  assert.equal(agent.hasPendingProcessCompletions(), false);
});
