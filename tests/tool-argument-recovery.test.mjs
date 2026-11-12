import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverToolArguments } from '../src/tool_argument_recovery.js';

const schema={type:'object',required:['serviceId','prompt'],additionalProperties:false,properties:{
 serviceId:{type:'integer',minimum:1},prompt:{type:'string',minLength:1},timeout:{type:'integer',maximum:30},
 options:{type:'object',required:['enabled'],properties:{enabled:{type:'boolean'}}}
}};
for(const raw of ['{"serviceId":25,"prompt":"inspect"',JSON.stringify('{"serviceId":25,"prompt":"inspect"'),' {"prompt":"inspect","serviceId":25,']) {
 test('complete required values are recovered: '+raw,()=>{
  const result=recoverToolArguments(raw,schema);
  assert.equal(result.ready,true);
  assert.deepEqual({...result.recoveredArguments},{serviceId:25,prompt:'inspect'});
 });
}
test('preserves complete nested values and escaped content',()=>{
 const prompt='Use "quoted" {text} and \\paths';
 const args={serviceId:25,prompt,options:{enabled:false}};
 const result=recoverToolArguments(JSON.stringify(args).slice(0,-1),schema);
 assert.equal(result.ready,true);
 assert.deepEqual({...result.recoveredArguments},args);
});
test('reports required fields still missing without fabricating string values',()=>{
 const result=recoverToolArguments('{"serviceId":25,"prompt":"not complete',schema);
 assert.equal(result.ready,false);
 assert.deepEqual(result.missingRequired,['prompt']);
 assert.deepEqual({...result.recoveredArguments},{serviceId:25});
});
test('known unfinished optional fields may be omitted after recovering all required fields',()=>{
 const result=recoverToolArguments('{"serviceId":25,"prompt":"inspect","timeout":',schema);
 assert.equal(result.ready,true);
 assert.deepEqual({...result.recoveredArguments},{serviceId:25,prompt:'inspect'});
});
for(const raw of ['{"serviceId":0,"prompt":"inspect"','{"serviceId":"25","prompt":"inspect"','{"serviceId":25,"prompt":"inspect","timeout":100}',
 '{"serviceId":25,"prompt":"inspect","timeout":oops',
 '{"serviceId":25,"prompt":"inspect"oops',
 '{"serviceId":25,"prompt":"inspect","options":{}}']) {
 test('invalid or ambiguous supplied values are not executed: '+raw,()=>assert.equal(recoverToolArguments(raw,schema).ready,false));
}

test('nested required fields are named in retry feedback',()=>{
 const result=recoverToolArguments('{"serviceId":25,"prompt":"inspect","options":{}}',schema);
 assert.equal(result.ready,false);
 assert.deepEqual(result.missingRequired,['options.enabled']);
});

test('partial-json does not invent numeric digits at EOF',()=>{
 const result=recoverToolArguments('{"prompt":"inspect","serviceId":25',schema);
 assert.equal(result.ready,false);
 assert.deepEqual(result.missingRequired,['serviceId']);
});
