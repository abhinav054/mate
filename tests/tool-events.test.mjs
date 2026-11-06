import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolEvents } from '../src/tool_events.js';
import { installPermissions } from '../src/permissions.js';

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
