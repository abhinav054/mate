import test from 'node:test';
import assert from 'node:assert/strict';
import {toolValidationFeedback} from '../src/tool_validation_feedback.js';
import {AgentServer} from '../src/server.js';
const schema={type:'object',required:['kind','configuration'],properties:{kind:{type:'string',enum:['postgres']},configuration:{type:'object',required:['name','storageGB'],additionalProperties:false,properties:{name:{type:'string'},storageGB:{type:'integer'}}}}};
const definitions=[{type:'function',function:{name:'create_service',parameters:{type:'object'}}}];
const args={kind:'postgres',configuration:{name:'private-secret-value',serviceType:'postgres'}};
const call={id:'invalid',type:'function',function:{name:'create_service',arguments:JSON.stringify(args)}};
const error='ERROR: invalid service configuration: json: unknown field "serviceType"; schema_validation_details='+JSON.stringify({schemaValidation:{schema}});
test('schema feedback reports valid, missing, unknown and mistyped paths without argument values',()=>{
 const feedback=toolValidationFeedback(call,{content:error},definitions);
 const report=JSON.parse(feedback.split('\n').at(-1));
 assert.deepEqual(report.schema,schema);
 assert.ok(report.correctFields.includes('configuration.name'));
 assert.ok(report.missingFields.includes('configuration.storageGB'));
 assert.ok(report.wrongFields.some(field=>field.field==='configuration.serviceType'));
 assert.ok(!feedback.includes('private-secret-value'));
 const mistyped={...call,function:{...call.function,arguments:JSON.stringify({kind:'postgres',configuration:{name:'db',storageGB:'one'}})}};
 assert.match(toolValidationFeedback(mistyped,{content:error},definitions),/configuration.storageGB/);
 assert.equal(toolValidationFeedback(call,{content:'ERROR: permission denied'},definitions),null);
});
test('first failed tool call sends authoritative schema feedback in the next model request',async()=>{
 let requests=0;
 const agent=new AgentServer({messages:[],mateConfig:{approval:{auto_approve:true}},ui:{activity(){},message(){}},mcpRegistry:{toolDefinitions:definitions,hasTool:()=>true,callTool:async()=>error},client:{chat:{completions:{create:async request=>{
 if(++requests===1) return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[call]}}]};
 const feedback=request.messages.find(message=>message.role==='user' && message.content.startsWith('Harness feedback: tool schema validation failed'));
 assert.ok(feedback);assert.match(feedback.content,/configuration.storageGB/);assert.match(feedback.content,/configuration.serviceType/);
 return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Configuration needs correction.'}}]};
 }}}}});
 agent.compactContextIfNeeded=async()=>{};
 await agent.runAgentUntilAnswer();assert.equal(requests,2);
});
