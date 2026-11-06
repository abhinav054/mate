import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function launch(workspace, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), 'app-server', '--listen', 'stdio://', '--workspace', workspace], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const messages = [], waiters = new Map();
  let buffer = '', stderr = '', nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      messages.push(message);
      if (waiters.has(message.id)) { waiters.get(message.id)(message); waiters.delete(message.id); }
    }
  });
  return {
    child, messages, exit, stderr: () => stderr,
    async rpc(method, params) {
      const id = ++nextId;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}; messages=${JSON.stringify(messages)}`)), 4000);
        waiters.set(id, message => { clearTimeout(timer); resolve(message); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return result;
    }
  };
}

test('native Mate app-server owns commands, permissions, JSON events, usage and saved-session resume', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-native-cli-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(home, 'permissions.json'), JSON.stringify({ permissions: { read: 'allow', commands: 'allow' } }));
  let requests = 0;
  const provider = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.stream, false);
    assert.equal(payload.response_format, undefined);
    assert.equal(payload.tools.find(t => t.function.name === 'run_command').function.parameters.properties.max_time_seconds.type, 'integer');
    requests++;
    if (requests === 2) assert.match(payload.messages.at(-1).content, /harness-marker/);
    if (requests === 3) assert.ok(payload.messages.some(m => m.role === 'assistant' && m.content === 'Verified harness-marker'));
    const message = requests === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'native-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf harness-marker', max_time_seconds: 5 }) } }] }
      : { role: 'assistant', content: requests === 2 ? 'Verified harness-marker' : 'Resumed harness-marker' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'fake-completion', object: 'chat.completion', choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const usageFile = path.join(root, 'usage.json');
  const env = { ...process.env, MATE_HOME: home, OPENAI_API_KEY: 'test-key-not-real', OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, OPENAI_MODEL: 'test-model', AGENT_USAGE_FILE: usageFile, AGENT_HARNESS_MAX_RETRIES: '2' };
  const children = [];
  try {
    const first = launch(workspace, env); children.push(first);
    assert.equal((await first.rpc('initialize')).result.serverInfo.name, 'mate');
    const completed = await first.rpc('turn/start', { prompt: 'Run the marker check' });
    assert.equal(completed.error, undefined, JSON.stringify(completed.error));
    assert.equal(completed.result.turn.status, 'completed');
    assert.equal(completed.result.turn.items.at(-1).text, 'Verified harness-marker');
    const output = first.messages.find(m => m.method === 'item/completed' && m.params.item.type === 'commandExecution' && m.params.item.command === 'printf harness-marker' && m.params.item.status === 'completed');
    assert.match(output.params.item.aggregatedOutput, /harness-marker/);
    assert.equal(output.params.item.exitCode, 0);
    assert.equal(requests, 2); // app-server must not run another assessment pass.
    assert.equal(JSON.parse(fs.readFileSync(usageFile, 'utf8')).total_tokens, 30);
    await first.rpc('shutdown');
    first.child.stdin.end();
    assert.deepEqual(await first.exit, [0, null], first.stderr());

    const resumed = launch(workspace, env); children.push(resumed);
    assert.equal((await resumed.rpc('conversation/resume')).result.resumed, true);
    assert.equal(requests, 2); // resume alone never invokes the model.
    const next = await resumed.rpc('turn/start', { prompt: 'Continue the saved check' });
    assert.equal(next.result.turn.items.at(-1).text, 'Resumed harness-marker');
    await resumed.rpc('shutdown');
    resumed.child.stdin.end();
    assert.deepEqual(await resumed.exit, [0, null], resumed.stderr());
    assert.equal(requests, 3);
  } finally {
    for (const item of children) if (item.child.exitCode === null) item.child.kill();
    await Promise.allSettled(children.map(item => item.exit));
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
