import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer } from '../src/server.js';
import { toolResultFailed } from '../src/tool_failure_recovery.js';

const response=(calls)=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:calls}}]});
const tool=(name,args,id)=>({id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}});
const answer=text=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}]});
function harness(create,execute=async()=> 'ok'){
 const executed=[];
 const agent=new AgentServer({client:{chat:{completions:{create}}},model:'test',messages:[],ui:{activity(){},message(){}},mateConfig:{raw:{},approval:{auto_approve:true}},mcpRegistry:{
  toolDefinitions:[{type:'function',function:{name:'mcp__deploymate__get_service',parameters:{type:'object',required:['serviceId'],properties:{serviceId:{type:'integer'}}}}}],
  hasTool:()=>true,callTool:async(name,args)=>{executed.push({name,args});return execute(name,args);}
 }});
 agent.compactContextIfNeeded=async()=>{};
 return {agent,executed};
}

test('three malformed calls hand control back for an independent task instead of ending the turn',async()=>{
 let requests=0;
 const {agent,executed}=harness(async({messages})=>{
  if(++requests<=3)return response([tool('mcp__deploymate__get_service','{"serviceId":','bad-'+requests)]);
  if(requests===4){
   const feedback=messages.at(-1).content;
   assert.match(feedback,/Find a different authorized approach/);
   assert.match(feedback,/independent tasks/);
   assert.match(feedback,/do not claim it succeeded/);
   assert.deepEqual(executed,[]);
   return response([tool('read_file',{path:'README.md'},'independent')]);
  }
  return answer('Read the project instructions. Service inspection remains blocked.');
 });
 assert.match(await agent.runAgentUntilAnswer(),/remains blocked/);
 assert.deepEqual(executed,[{name:'read_file',args:{path:'README.md'}}]);
});

test('repeated command exit failures allow a changed command and retain prior failures',async()=>{
 let requests=0;
 const {agent,executed}=harness(async({messages})=>{
  if(++requests<=3)return response([tool('run_command',{command:'broken'},'failed-'+requests)]);
  if(requests===4){
   assert.match(messages.at(-1).content,/failure\/retry limit/);
   assert.match(messages.at(-1).content,/partial changes/);
   assert.match(messages.at(-1).content,/Do not bypass denied permissions/);
   return response([tool('run_command',{command:'alternative'},'alternative')]);
  }
  return answer('The alternative worked.');
 },async(_name,args)=>args.command==='broken'?'command failed\n[exit_code=1]':'done\n[exit_code=0]');
 assert.equal(await agent.runAgentUntilAnswer(),'The alternative worked.');
 assert.equal(executed.length,4);
 assert.equal(agent.messages.filter(m=>m.role==='tool'&&m.content.includes('[exit_code=1]')).length,3);
});

test('unchanged requests after the retry limit do not execute again and cannot loop forever',async()=>{
 let requests=0;
 const {agent,executed}=harness(async()=>response([tool('mcp__deploymate__get_service',{serviceId:25},'same-'+(++requests))]),async()=> 'ERROR: API unavailable');
 await assert.rejects(agent.runAgentUntilAnswer(),/repeat an exhausted tool request/);
 assert.equal(requests,6);
 assert.equal(executed.length,3);
});

test('failure detection includes MCP errors, denied calls, command failures and timeouts',()=>{
 for(const [name,content] of [['mcp__deploymate__get_service','ERROR: unavailable'],['run_command','ERROR: Agent permissions denied tool'],['run_command','output\n[exit_code=2]'],['run_command','output\n[timeout_seconds=60]']]){
  assert.equal(toolResultFailed(name,{content}),true);
 }
 assert.equal(toolResultFailed('run_command',{content:'ok\n[exit_code=0]'}),false);
 assert.equal(toolResultFailed('monitor_background_process',{content:'job running pid=3'}),false);
});
