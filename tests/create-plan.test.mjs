import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan, TOOL_DEFINITIONS } from '../src/tools.js';
import { AgentServer } from '../src/server.js';
import { toolPermission } from '../src/permissions.js';
import { toolRequiresApproval } from '../src/config.js';

test('create_plan rejects incomplete plans and is advertised with structured steps', () => {
  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'create_plan');
  assert.deepEqual(definition.function.parameters.required, ['title', 'steps']);
  assert.equal(definition.function.parameters.properties.steps.type, 'array');
  for (const args of [{title:'',steps:['inspect']},{title:'Deploy',steps:[]},{title:'Deploy',steps:['']},{title:'Deploy',steps:'inspect'}]) {
    assert.throws(() => createPlan(args));
  }
  assert.equal(toolPermission({}, {permissions:{write:'deny',commands:'deny'}}, 'create_plan'), 'allow');
  assert.equal(toolRequiresApproval({approval:{require_tools:['create_plan']}}, 'create_plan'), false);
});

test('skill-directed plan is displayed and passed to the next model request without approval', async () => {
  const notifications = [];
  let requests = 0;
  const plan = {title:'Deploy production app',skill_name:'deploymate',steps:['Inspect app requirements','Prepare and validate Dockerfile','Create database and web service']};
  const server = new AgentServer({messages:[{role:'user',content:'Follow the deployment skill'}],mateConfig:{approval:{require_tools:['create_plan']}},ui:{activity(){},message(text){notifications.push(text);}},
    client:{chat:{completions:{async create(request){
      if (++requests === 1) return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'plan-call',type:'function',function:{name:'create_plan',arguments:JSON.stringify(plan)}}]}}]};
      assert.ok(request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'plan-call' && message.content === createPlan(plan)));
      return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Plan prepared.'}}]};
    }}}}});
  server.compactContextIfNeeded = async()=>{};
  server.confirmToolExecution = async()=>{throw new Error('Planning must not request approval');};
  await server.runAgentUntilAnswer();
  assert.equal(requests,2);
  assert.ok(notifications.includes(createPlan(plan)));
});
