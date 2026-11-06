import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolEvents } from '../src/tool_events.js';
import { installPermissions } from '../src/permissions.js';
import { runCommand } from '../src/tools.js';
import { withCommandExecution } from '../src/command_execution.js';

const call = (name, args = {}) => ({ id: 'call-1', function: { name, arguments: JSON.stringify(args) } });
function capture(agent) {
  const events = [], turn = { id: 'turn-1', items: [] };
  const state = installToolEvents(agent, (method, params) => events.push({ method, params }), () => turn);
  return {events, turn, state};
}

test('commands publish stable native lifecycle/output with correct status and preserve the model result', async () => {
  const result = {role:'tool',content:'stdout\nstderr\n[exit_code=1]'};
  const agent = {async toolMessage(){return result;}};
  const {events, turn} = capture(agent);
  assert.equal(await agent.toolMessage(call('run_command',{command:'npm test',cwd:'/repo'})), result);
  assert.deepEqual(events.map(e=>e.method),['item/started','item/commandExecution/outputDelta','item/completed']);
  const started=events[0].params.item, completed=events[2].params.item;
  assert.equal(started.type,'commandExecution');
  assert.equal(started.status,'inProgress');
  assert.equal(completed.id,started.id);
  assert.equal(completed.command,'npm test');
  assert.equal(completed.cwd,'/repo');
  assert.equal(completed.status,'failed');
  assert.equal(completed.exitCode,1);
  assert.equal(completed.aggregatedOutput,result.content);
  assert.deepEqual(turn.items,[completed]);
});

test('command output reaches clients before the running tool completes', async () => {
  const agent = { async toolMessage(c) { return { content: await runCommand(JSON.parse(c.function.arguments)) }; } };
  const { events } = capture(agent);
  let finished = false;
  const running = agent.toolMessage(call('run_command', { command: "printf 'startup stdout\\n'; printf 'startup stderr\\n' >&2; sleep 0.6; printf 'finished\\n'" })).then(value => { finished = true; return value; });
  const deadline = Date.now() + 3000;
  while (!events.some(e => e.method.endsWith('outputDelta')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false, 'output must arrive while the command is running');
  const live = events.filter(e => e.method.endsWith('outputDelta')).map(e => e.params.delta).join('');
  assert.match(live, /startup stdout\nstartup stderr/);
  const result = await running;
  assert.match(result.content, /finished/);
  const completed = events.at(-1).params.item;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.exitCode, 0);
  const deltas = events.filter(e => e.method.endsWith('outputDelta')).map(e => e.params.delta).join('');
  assert.equal(deltas.match(/startup stdout/g).length, 1, 'completion must not replay streamed output');
});

test('long command output retains timeout evidence and reports timedOut', async () => {
  const agent = { async toolMessage(c) { return { content: await runCommand(JSON.parse(c.function.arguments)) }; } };
  const { events } = capture(agent);
  const result = await agent.toolMessage(call('run_command', { command: "python3 -u -c 'import time; print(\"x\"*100000); time.sleep(30)'", max_time_seconds: 1 }));
  assert.match(result.content, /\[timeout_seconds=1\]$/);
  assert.equal(events.at(-1).params.item.status, 'timedOut');
  assert.equal(events.at(-1).params.item.exitCode, null);
  assert.ok(events.filter(e => e.method.endsWith('outputDelta')).reduce((n,e) => n + e.params.delta.length, 0) < 33000);
});

test('interrupts stop running command groups without waiting for the timeout', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const result = await withCommandExecution({ signal: controller.signal, onOutput: () => controller.abort() },
    () => runCommand({ command: "printf 'ready\\n'; sleep 30" }));
  assert.match(result, /ready/);
  assert.match(result, /\[interrupted\]$/);
  assert.ok(Date.now() - started < 3000);
});

test('denied calls emit a declined result without executing the command', async () => {
  let executed=0;
  const agent={async toolMessage(){executed++;}};
  installPermissions(agent,{permissions:{commands:'deny'}},{setup:()=>false,approve:async()=>false});
  const {events}=capture(agent);
  const result=await agent.toolMessage(call('run_command',{command:'touch denied'}));
  assert.equal(executed,0);
  assert.match(result.content,/permissions denied/);
  assert.equal(events.at(-1).params.item.status,'declined');
});

test('native read/write tools and MCP calls expose typed arguments and bounded output', async () => {
  const result={content:'x'.repeat(40000)};
  const agent={async toolMessage(){return result;},mcpRegistry:{toolMap:new Map([['external',{serverName:'provider',toolName:'lookup'}]])}};
  const {events}=capture(agent);
  for(const name of ['read_file','write_file','external']) {
    assert.equal(await agent.toolMessage(call(name,{path:'a.js'})),result);
    const item=events.at(-1).params.item;
    assert.deepEqual(item.arguments,{path:'a.js'});
    assert.equal(item.status,'completed');
    assert.equal(item.type,name==='external'?'mcpToolCall':'dynamicToolCall');
    const output=item.type==='mcpToolCall'?item.result.content[0].text:item.contentItems[0].text;
    assert.match(output,/Output truncated/);
    assert.ok(output.length<33000);
  }
});

test('diff output is attached to the original file tool; exceptions close the item and remain exceptions', async () => {
  let state;
  const agent={async toolMessage(c){if(c.function.name==='write_file'){state.diff('--- a/a.js\n+++ b/a.js\n+new');return {content:'wrote a.js'};}throw new Error('Interrupted');}};
  const captured=capture(agent); state=captured.state;
  await agent.toolMessage(call('write_file',{path:'a.js'}));
  assert.match(captured.events.at(-1).params.item.contentItems[0].text,/\+new/);
  await assert.rejects(agent.toolMessage(call('run_command')),/Interrupted/);
  assert.equal(captured.events.at(-1).params.item.status,'failed');
  assert.equal(state.active,false);
});
