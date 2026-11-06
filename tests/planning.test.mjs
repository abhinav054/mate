import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer, TurnInterruptedError } from '../src/server.js';
import { planningSummary } from '../src/planning.js';

const answer = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
function harness(responses) {
  const progress = [], executed = [];
  let requests = 0;
  const agent = new AgentServer({ client: { chat: { completions: { create: async () => responses[requests++] } } },
    model: 'test', ui: { message: text => progress.push(text), activity() {} }, messages: [],
    mateConfig: { raw: {}, approval: { auto_approve: true } } });
  agent.compactContextIfNeeded = async () => {};
  agent.toolMessage = async call => { executed.push(call.function.name); return { role: 'tool', tool_call_id: call.id, content: 'ok' }; };
  return { agent, progress, executed, requests: () => requests };
}

test('planning is shown as progress, then tools execute before the final answer', async () => {
  const { agent, progress, executed } = harness([answer("I'll inspect the repository."),
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [
      { id: 'one', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] },
    answer('Repository inspected; the requested change is complete.')]);
  assert.equal(await agent.runAgentUntilAnswer('Inspect the repository and make the change'), 'Repository inspected; the requested change is complete.');
  assert.deepEqual(progress, ["I'll inspect the repository."]);
  assert.deepEqual(executed, ['read_file']);
  assert.match(agent.messages[1].content, /described planned work/);
});

test('thought-only responses show an action summary without publishing deliberation', async () => {
  const { agent, progress } = harness([answer('<thought>\nProblem: private deliberation\nChange: Create the service manifest.\nCheck: Verify readiness.\n</thought>'), answer('Setup is complete.')]);
  assert.equal(await agent.runAgentUntilAnswer('Prepare the environment'), 'Setup is complete.');
  assert.deepEqual(progress, ['Next: Create the service manifest.']);
});

test('repeated planning fails after three responses rather than reporting success', async () => {
  const { agent, progress, requests } = harness(Array(3).fill(answer('Need to create the manifest.')));
  await assert.rejects(agent.runAgentUntilAnswer('Prepare the environment'), /task remains incomplete/);
  assert.equal(requests(), 3);
  assert.equal(progress.length, 3);
});

test('answers, blockers, questions, and explicitly requested plans remain final', () => {
  for (const text of ['Done. Tests passed.', 'I cannot install packages because access is blocked.', 'Should I install PostgreSQL?', 'The next step is optional.', '<thought>internal</thought>\nThe result is 42.']) {
    assert.equal(planningSummary(text, 'Fix the app'), null);
  }
  for (const goal of ['Give me a plan for setup', 'Explain how to install packages', 'Plan only, do not execute']) {
    assert.equal(planningSummary("I'll install dependencies.", goal), null);
  }
});

test('interrupting during planning prevents a continuation request', async () => {
  const { agent, requests } = harness([answer("I'll inspect the project.")]);
  let interrupted = false;
  agent.ui.message = () => { interrupted = true; };
  agent.throwIfInterrupted = () => { if (interrupted) throw new TurnInterruptedError(); };
  await assert.rejects(agent.runAgentUntilAnswer('Fix the project'), TurnInterruptedError);
  assert.equal(requests(), 1);
});
