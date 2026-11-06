import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStdioServer } from '../src/stdio.js';
const sessions = await import('../src/sessions.js');

async function rpc(input, output, id, method, params) {
  const response = new Promise(resolve => {
    let buffer = '';
    const receive = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id === id) { output.off('data', receive); resolve(message); }
      }
    };
    output.on('data', receive);
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return response;
}

test('resume loads the saved messages and next turn continues without reset', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mate-resume-'));
  const saved = sessions.createSession(workspace);
  const history = [{role:'user', content:'Remember the marker alpha'}, {role:'assistant', content:'Saved alpha'}];
  sessions.appendMessages(saved, history);
  const input = new PassThrough(), output = new PassThrough();
  let options, resets = 0;
  const server = runStdioServer({workspace, input, output, createAgent: async (_workspace, _ui, value) => {
    options = value;
    return { async toolMessage() { return {}; }, reset() { resets++; }, async runTurn(prompt) { assert.deepEqual(options.resumeMessages, history); return 'Continuing alpha: '+prompt; } };
  }});
  try {
    const restored = await rpc(input, output, 1, 'conversation/resume');
    assert.equal(restored.result.resumed, true);
    assert.equal(options.session.id, saved.id);
    assert.equal(resets, 0);
    const next = await rpc(input, output, 2, 'turn/start', {prompt:'continue'});
    assert.equal(next.result.markdown, 'Continuing alpha: continue');
    assert.equal(resets, 0);
    await rpc(input, output, 3, 'shutdown');
    await server;
  } finally { input.end(); rmSync(workspace, {recursive:true, force:true}); }
});

test('missing saved conversation fails instead of starting a fresh one', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mate-resume-empty-'));
  const input = new PassThrough(), output = new PassThrough();
  let created = false;
  const server = runStdioServer({workspace, input, output, createAgent: async () => { created = true; }});
  try {
    const result = await rpc(input, output, 1, 'conversation/resume');
    assert.match(result.error.message, /No saved Mate conversation/);
    assert.equal(created, false);
    await rpc(input, output, 2, 'shutdown');
    await server;
  } finally { input.end(); rmSync(workspace, {recursive:true, force:true}); }
});

test('setup bypass is removed after completion and failure without resetting the agent', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'mate-setup-policy-'));
  const input = new PassThrough(), output = new PassThrough();
  let executed = 0, created = 0, approvals = 0, approvalBuffer = '';
  // The default is now Ask. Reject normal-turn approval requests explicitly;
  // setup turns must still bypass prompts, including after a failed setup.
  output.on('data', chunk => {
    approvalBuffer += chunk.toString();
    const lines = approvalBuffer.split('\n'); approvalBuffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === 'mate/approval/request') {
        approvals++;
        input.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{approved:false}})+'\n');
      }
    }
  });
  const server = runStdioServer({workspace, input, output, createAgent: async () => {
    created++;
    return {
      config: {approval:{}},
      async confirmToolExecution() { throw new Error('native setup approval must be bypassed'); },
      async toolMessage() {
        assert.equal(await this.confirmToolExecution('run_command', {}), true);
        executed++; return {content:'executed'};
      },
      async runTurn(prompt) {
        const result = await this.toolMessage({id:prompt,function:{name:'run_command'}});
        if (prompt === 'setup-failure') throw new Error('setup failed');
        return result.content;
      },
    };
  }});
  try {
    const setup = await rpc(input, output, 1, 'turn/start', {prompt:'setup', cmSetup:true});
    assert.equal(setup.result.markdown, 'executed');
    const normal = await rpc(input, output, 2, 'turn/start', {prompt:'normal'});
    assert.match(normal.result.markdown, /denied/);
    assert.equal(executed, 1);
    const failed = await rpc(input, output, 3, 'turn/start', {prompt:'setup-failure',cmSetup:true});
    assert.match(failed.error.message, /setup failed/);
    const after = await rpc(input, output, 4, 'turn/start', {prompt:'after-failure'});
    assert.match(after.result.markdown, /denied/);
    assert.equal(executed, 2); assert.equal(created, 1); assert.equal(approvals, 2);
    await rpc(input, output, 5, 'shutdown');
    await server;
  } finally { input.end(); rmSync(workspace, {recursive:true,force:true}); }
});

test('harness serializes plain model text into Codex turn and agentMessage JSON', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const events = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop();
    events.push(...lines.map(JSON.parse));
  });
  const text = 'Plain reply\n{"method":"do-not-execute","quote":"\\\""}';
  const server = runStdioServer({workspace:tmpdir(), input, output, createAgent: async (_workspace, ui) => ({
    async toolMessage() { return {}; },
    async runTurn() { ui.message('Using a skill'); return text; }
  })});
  try {
    const response = await rpc(input, output, 1, 'turn/start', {prompt:'hello'});
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.result.markdown, text);
    const turn = response.result.turn;
    assert.equal(turn.status, 'completed');
    assert.equal(turn.error, null);
    assert.equal(turn.items.length, 2);
    assert.deepEqual(turn.items.map(i => [i.type, i.phase, i.text]), [
      ['agentMessage', 'commentary', 'Using a skill'], ['agentMessage', 'final_answer', text]
    ]);
    const notifications = events.filter(e => e.method);
    const started = notifications.find(e => e.method === 'turn/started');
    assert.equal(started.params.turn.id, turn.id);
    assert.equal(started.params.turn.status, 'inProgress');
    assert.deepEqual(started.params.turn.items, []);
    const final = notifications.filter(e => e.method === 'item/completed' && e.params.item.phase === 'final_answer');
    assert.equal(final.length, 1);
    assert.equal(final[0].params.turnId, turn.id);
    assert.deepEqual(final[0].params.item, turn.items[1]);
    assert.equal(notifications.some(e => e.method === 'codex.assistant.message'), false);
    assert.deepEqual(notifications.find(e => e.method === 'turn/completed').params.turn, turn);
    await rpc(input, output, 2, 'shutdown');
    await server;
  } finally { input.end(); }
});

for (const interrupted of [false, true]) {
  test(`harness emits a ${interrupted ? 'interrupted' : 'failed'} turn without inventing a final answer`, async () => {
    const { TurnInterruptedError } = await import('../src/server.js');
    const input = new PassThrough(), output = new PassThrough();
    const events = [];
    let buffer = '';
    output.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      events.push(...lines.map(JSON.parse));
    });
    const server = runStdioServer({workspace:tmpdir(), input, output, createAgent: async () => ({
      async toolMessage() { return {}; },
      async runTurn() { throw interrupted ? new TurnInterruptedError('Stopped') : new Error('Invalid tool arguments'); }
    })});
    try {
      const response = await rpc(input, output, 1, 'turn/start', {prompt:'hello'});
      assert.equal(response.error.code, interrupted ? -32800 : -32603);
      const finished = events.find(e => e.method === 'turn/completed');
      assert.equal(finished.params.turn.status, interrupted ? 'interrupted' : 'failed');
      assert.deepEqual(finished.params.turn.items, []);
      assert.equal(finished.params.turn.error.message, response.error.message);
      assert.equal(events.some(e => e.method === 'item/completed'), false);
      await rpc(input, output, 2, 'shutdown');
      await server;
    } finally { input.end(); }
  });
}

test('planning progress reaches app-server clients before the final answer', async () => {
  const { AgentServer } = await import('../src/server.js');
  const workspace = mkdtempSync(join(tmpdir(), 'mate-planning-'));
  const input = new PassThrough(), output = new PassThrough(), events = [];
  let buffer = '', requests = 0;
  output.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) events.push(JSON.parse(line));
  });
  const server = runStdioServer({ workspace, input, output, createAgent: async (_workspace, ui) => {
    const agent = new AgentServer({ client: { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: requests++ === 0 ? "I'll check the project." : 'The project check is complete.' } }] }) } } },
      model: 'test', ui, messages: [], mateConfig: { raw: {} } });
    agent.compactContextIfNeeded = async () => {};
    return agent;
  }});
  try {
    const result = await rpc(input, output, 1, 'turn/start', { prompt: 'Check the project' });
    assert.equal(result.result.markdown, 'The project check is complete.');
    const completed = events.filter(e => e.method === 'item/completed').map(e => e.params.item);
    assert.deepEqual(completed.map(item => [item.phase, item.text]), [
      ['commentary', "I'll check the project."], ['final_answer', 'The project check is complete.']]);
    assert.equal(events.filter(e => e.method === 'turn/completed').length, 1);
    await rpc(input, output, 2, 'shutdown');
    await server;
  } finally { input.end(); rmSync(workspace, { recursive: true, force: true }); }
});
