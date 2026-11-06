import test from 'node:test';
import assert from 'node:assert/strict';
import { installPermissions } from '../src/permissions.js';

test('setup bypass ends before normal tools and denial performs no action', async () => {
 let setup = true, calls = 0, asks = 0;
 const agent = { config: { approval: {} }, toolMessage: async () => { calls++; return { content: 'executed' }; } };
 installPermissions(agent, { permissions: {commands:'deny'} }, { setup: () => setup, approve: async () => { asks++; return true; } });
 const call = { id: '1', function: { name: 'run_command' } };
 assert.equal((await agent.toolMessage(call)).content, 'executed');
 setup = false;
 assert.match((await agent.toolMessage(call)).content, /denied/);
 assert.equal(calls, 1); assert.equal(asks, 0);
});

test('normal read/write/command/network permissions are independent and unknown tools deny', async () => {
 const executed = [];
 const agent = { toolMessage: async (call) => { executed.push(call.function.name); return { content: 'ok' }; } };
 installPermissions(agent, { permissions: {read:'allow',write:'deny',commands:'deny',network:'deny'} }, { setup: () => false, approve: async () => assert.fail('unexpected approval') });
 for (const name of ['read_file', 'write_file', 'run_command', 'browse_internet', 'unknown']) await agent.toolMessage({ id:name,function:{name} });
 assert.deepEqual(executed, ['read_file']);
});

test('MCP server policies override generic permissions and Ask requires an affirmative answer', async () => {
 let approved = false, calls = 0, asks = 0;
 const agent = { mcpRegistry: { toolMap: new Map([['mcp__one__read', {serverName:'one'}], ['mcp__two__read', {serverName:'two'}]]) }, toolMessage: async () => { calls++; return {}; } };
 installPermissions(agent, {permissions:{read:'allow'},mcp:{one:'ask',two:'deny'}}, {setup:()=>false,approve:async()=>{asks++;return approved;}});
 const call = name => ({id:name,function:{name}});
 await agent.toolMessage(call('mcp__one__read')); assert.equal(calls,0);
 approved=true;
 await agent.toolMessage(call('mcp__one__read')); assert.equal(calls,1);
 await agent.toolMessage(call('mcp__two__read')); assert.equal(calls,1);
 assert.equal(asks,2);
});


test('unconfigured tools and registered MCP servers require approval by default', async () => {
 let approved=false, calls=0, asks=0;
 const agent={mcpRegistry:{toolMap:new Map([['mcp__docs__read',{serverName:'docs'}]])},toolMessage:async()=>{calls++;return {content:'executed'};}};
 installPermissions(agent, {permissions:{},mcp:{}}, {setup:()=>false, approve:async()=>{asks++;return approved;}});
 const invoke=name=>agent.toolMessage({id:name,function:{name}});
 for (const name of ['read_file','write_file','run_command','browse_internet','mcp__docs__read']) await invoke(name);
 assert.equal(asks,5); assert.equal(calls,0);
 approved=true;
 for (const name of ['read_file','write_file','run_command','browse_internet','mcp__docs__read']) await invoke(name);
 assert.equal(asks,10); assert.equal(calls,5);
 await invoke('unknown'); await invoke('mcp__unregistered__read');
 assert.equal(asks,10); assert.equal(calls,5);
});

test('native command approvals are bypassed only during server-owned setup', async () => {
 let setup = true, nativeApprovals = 0, executions = 0;
 const agent = {
  config: {approval: {}},
  async confirmToolExecution() { nativeApprovals++; return false; },
  async toolMessage(call) {
   if (!await this.confirmToolExecution(call.function.name, {})) return {content: 'native approval denied'};
   executions++;
   return {content: 'executed'};
  },
 };
 installPermissions(agent, {permissions: {commands: 'allow'}}, {setup: () => setup, approve: async () => assert.fail('unexpected policy approval')});
 const call = {id:'setup',function:{name:'run_command'}};
 assert.equal((await agent.toolMessage(call)).content,'executed');
 assert.equal(nativeApprovals,0);
 setup = false;
 assert.equal((await agent.toolMessage(call)).content,'native approval denied');
 assert.equal(nativeApprovals,1);
 assert.equal(executions,1);
});
