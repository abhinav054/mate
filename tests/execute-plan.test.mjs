import test from 'node:test';
import assert from 'node:assert/strict';
import {PlanExecution} from '../src/plan_execution.js';
import {AgentServer} from '../src/server.js';

test('plan enforces order, validates failure details, and persists completion across resume',()=>{
 const state=new PlanExecution();
 assert.throws(()=>state.execute({action:'start'}),/create_plan/);
 state.create({title:'Release',steps:['Build','Deploy']});
 state.execute({action:'start'});
 assert.throws(()=>state.execute({action:'complete_step',step:2,result:'done'}),/step 1/);
 assert.throws(()=>state.create({title:'Replace',steps:['skip']}),/running plan/);
 assert.throws(()=>state.execute({action:'complete_step',step:1}),/verified result/);
 state.execute({action:'complete_step',step:1,result:'Build passed'});
 const messages=[]; state.save(messages);
 const resumed=new PlanExecution(messages);
 assert.equal(resumed.plan.current,1);
 assert.throws(()=>resumed.execute({action:'fail_step',step:2,reason:'No access'}),/next_action/);
 resumed.execute({action:'complete_step',step:2,result:'Deployment healthy'});
 assert.equal(resumed.plan.status,'completed');
 assert.throws(()=>resumed.execute({action:'complete_step',step:2,result:'again'}),/not running/);
});

test('terminal plan failure stops queued tools and skips result-check retries',async()=>{
 const messages=[];
 const server=new AgentServer({messages:[],mateConfig:{approval:{auto_approve:true}},ui:{activity(){},message(value){messages.push(value);}}});
 const call=(name,args,id=name)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 await server.toolMessage(call('create_plan',{title:'Deploy',steps:['Connect account','Deploy app']}));
 await server.toolMessage(call('execute_plan',{action:'start'}));
 let requests=0;
 server.client={chat:{completions:{async create(){requests++;return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
 call('execute_plan',{action:'fail_step',step:1,reason:'Access denied',alternatives_tried:['Retry denied; no alternate authorized account'],next_action:'Reconnect the provider account with deployment permission.'},'fail'),
 call('create_plan',{title:'Must not run',steps:['Skip failure']},'queued')
 ]}}]};}}}};
 server.compactContextIfNeeded=async()=>{};
 server.assessAnswer=async()=>{throw new Error('Must not retry terminal failure');};
 const answer=await server.runAgentTurn('Deploy');
 assert.match(answer,/Plan failed/);
 assert.match(answer,/Next action for the user: Reconnect/);
 assert.equal(server.planExecution.plan.steps[1].status,'pending');
 assert.equal(server.planExecution.plan.title,'Deploy');
 assert.match(server.messages.find(m=>m.tool_call_id==='queued').content,/not executed/);
 assert.equal(requests,1);
 assert.ok(messages.some(value=>value.includes('Next action for the user:')));
 const restored=new PlanExecution(server.messages);
 assert.equal(restored.plan.status,'failed');
});
