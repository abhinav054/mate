import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentServer } from '../src/server.js';

const call = (id, args) => ({ id, type: 'function', function: { name: 'test_tool', arguments: args } });
function server(create) {
  const executed = [];
  const agent = new AgentServer({
    client: { chat: { completions: { create } } }, model: 'deepseek',
    ui: { activity() {} }, messages: [], mateConfig: { raw: {}, approval: { auto_approve: true } },
    mcpRegistry: { toolDefinitions: [], hasTool: () => true, callTool: async (name, args) => { executed.push(args); return 'ok'; } }
  });
  agent.compactContextIfNeeded = async () => {};
  agent.confirmToolExecution = async () => true;
  return { agent, executed };
}

test('malformed tool arguments are not executed and history remains valid for a strict provider', async () => {
  let requests = 0;
  const malformed = call('bad', '{"command":"broken"oops}');
  const { agent, executed } = server(async ({ messages }) => {
    for (const message of messages) for (const tool of message.tool_calls || []) JSON.parse(tool.function.arguments);
    if (requests++ === 0) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [malformed, call('good', '{"value":1}'), call('array', '[]'), call('scalar', '42')] } }] };
    assert.equal(messages.some(m => m.tool_call_id === 'bad'), false);
    assert.match(messages[0].content, /Tool calls rejected/);
    assert.deepEqual(messages[0].tool_calls.map(c => c.id), ['good']);
    if (requests === 2) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [call('retry', '{"value":2}')] } }] };
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };
  });
  assert.equal(await agent.runAgentUntilAnswer(), 'done');
  assert.deepEqual(executed, [{ value: 1 }, { value: 2 }]);
  assert.equal(malformed.function.arguments, '{"command":"broken"oops}');
});

test('resumed malformed history is sanitized without mutating saved messages', async () => {
  const old = { role: 'assistant', tool_calls: [call('old', '{bad')] };
  const { agent } = server(async ({ messages }) => {
    assert.equal(messages[0].tool_calls, undefined);
    assert.match(messages[0].content, /Tool calls rejected/);
    return {};
  });
  await agent.createChatCompletionWithRetry({ messages: [old] });
  assert.equal(old.tool_calls[0].function.arguments, '{bad');
});

test('provider JSON generation error is retried only once', async () => {
  let count = 0;
  const error = Object.assign(new Error("Expecting ',' delimiter: line 1 column 13 (char 12)"), { status: 400 });
  const { agent } = server(async () => { count++; throw error; });
  await assert.rejects(agent.createChatCompletionWithRetry({}), error);
  assert.equal(count, 2);
});

test('unrelated bad requests are not retried', async () => {
  let count = 0;
  const error = Object.assign(new Error('Invalid model'), { status: 400 });
  const { agent } = server(async () => { count++; throw error; });
  await assert.rejects(agent.createChatCompletionWithRetry({}), error);
  assert.equal(count, 1);
});


test('legacy empty calls with invalid-argument errors are removed with their results', async () => {
  const messages = [
    { role: 'assistant', tool_calls: [call('bad', '{}'), call('good', '{"value":1}')] },
    { role: 'tool', tool_call_id: 'bad', content: 'ERROR: Error: Invalid tool arguments: expected a valid JSON object.' },
    { role: 'tool', tool_call_id: 'good', content: 'ok' }
  ];
  const { agent } = server(async ({ messages: safe }) => {
    assert.deepEqual(safe[0].tool_calls.map(c => c.id), ['good']);
    assert.deepEqual(safe.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['good']);
    return {};
  });
  await agent.createChatCompletionWithRetry({ messages });
  assert.equal(messages[0].tool_calls.length, 2);
});

test('repeated malformed output stops after three responses without executing any tool', async () => {
  let requests = 0;
  const { agent, executed } = server(async ({ messages }) => {
    for (const m of messages) for (const c of m.tool_calls || []) JSON.parse(c.function.arguments);
    requests++;
    return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [call(`bad-${requests}`, '{"command": "incomplete')] } }] };
  });
  await assert.rejects(agent.runAgentUntilAnswer(), /Stopped after three attempts/);
  assert.equal(requests, 3);
  assert.deepEqual(executed, []);
});


test('requests explicitly disable streaming and await the full response before running tools', async () => {
  let deliver;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  let requests = 0;
  const { agent, executed } = server(async (request) => {
    assert.equal(request.stream, false);
    if (requests++ === 0) {
      entered();
      return await new Promise(resolve => { deliver = resolve; });
    }
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };
  });
  const turn = agent.runAgentUntilAnswer();
  await pending;
  assert.deepEqual(executed, []);
  deliver({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [call('complete', '{"value":1}')] } }] });
  assert.equal(await turn, 'done');
  assert.deepEqual(executed, [{ value: 1 }]);
});

for (const reason of [null, undefined, 'length', 'content_filter']) {
  test(`incomplete finish_reason ${reason} informs the agent without executing partial calls`, async () => {
    let requests = 0;
    const { agent, executed } = server(async ({messages}) => {
      if (++requests === 1) return { choices: [{ finish_reason: reason, message: { role: 'assistant', content: 'partial answer',
        tool_calls: [call('partial', '{"value":1}')] } }] };
      assert.match(messages.at(-1).content, /Harness feedback:.*incomplete/);
      assert.match(messages.at(-1).content, /No tools.*were executed/);
      assert.equal(messages.some(m => m.role === 'assistant'), false);
      return { choices: [{ finish_reason: 'stop', message: {role:'assistant',content:'I need more information.'} }] };
    });
    assert.equal(await agent.runAgentUntilAnswer(), 'I need more information.');
    assert.equal(requests, 2);
    assert.deepEqual(executed, []);
  });
}

test('a streaming delta informs the agent without executing a partial call', async () => {
  let requests = 0;
  const { agent, executed } = server(async ({messages}) => {
    if (++requests === 1) return { choices: [{ finish_reason: null, delta: { tool_calls: [call('fragment', '{"value":')] } }] };
    assert.match(messages.at(-1).content, /discarded/);
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Need input'}}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Need input');
  assert.deepEqual(executed, []);
});

test('an unrelated answer after a rejected call cannot complete the turn or enter history', async () => {
  let requests = 0;
  const { agent, executed } = server(async () => {
    if (requests++ === 0) return { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [call('bad-timeout', '{"command":"echo ok","max_time_seconds":')]
    } }] };
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Curso-Java-basico\nInvented Java code' } }] };
  });
  await assert.rejects(agent.runAgentUntilAnswer(), /could not recover its rejected tool call after three attempts/);
  assert.deepEqual(executed, []);
  assert.equal(agent.messages.some(m => m.content?.includes('Invented Java code')), false);
});

test('a corrected tool call executes and permits the final answer after rejection', async () => {
  let requests = 0;
  const { agent, executed } = server(async () => {
    requests++;
    const message = requests === 1 ? { role: 'assistant', tool_calls: [call('bad', '{"value":')] }
      : requests === 2 ? { role: 'assistant', tool_calls: [call('fixed', '{"value":1}')] }
      : { role: 'assistant', content: 'Verified' };
    return { choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] };
  });
  assert.equal(await agent.runAgentUntilAnswer(), 'Verified');
  assert.deepEqual(executed, [{ value: 1 }]);
});


for (const model of ['deepseek.v3.1', 'other-model']) {
  test(`${model} receives the original tool schemas without forced JSON response mode`, async () => {
    const definitions = [{type: 'function', function: {name: 'run_command', parameters: {type: 'object', properties: {
      command: {type: 'string'}, max_time_seconds: {type: 'integer'}
    }}}}];
    const { agent } = server(async request => {
      assert.equal(request.tools, definitions);
      assert.equal(request.tools[0].function.parameters.properties.max_time_seconds.type, 'integer');
      assert.equal(request.response_format, undefined);
      assert.equal(request.tool_choice, undefined);
      return {};
    });
    await agent.createChatCompletionWithRetry({model, tools: definitions});
  });
}

test('the harness preserves valid numeric arguments without coercion', async () => {
  const { agent, executed } = server(async () => {});
  const result = await agent.toolMessage({id: 'native', function: {name: 'run_command', arguments: '{"command":"echo ok","max_time_seconds":60}'}});
  assert.equal(result.content, 'ok');
  assert.deepEqual(executed, [{command: 'echo ok', max_time_seconds: 60}]);
});

for (const value of ['60', '60oops', 1.5, '', null]) {
  test(`the harness rejects invalid integer ${JSON.stringify(value)} before execution`, async () => {
    const { agent, executed } = server(async () => {});
    const result = await agent.toolMessage({id: 'bad', function: {name: 'run_command', arguments: JSON.stringify({command: 'echo ok', max_time_seconds: value})}});
    assert.match(result.content, /No tool was executed/);
    assert.deepEqual(executed, []);
  });
}


test('missing closing delimiters are normalized before execution, events and history replay', async () => {
  const original = call('closing-only', '{"path":".","options":{"flags":["safe"]');
  let requests = 0;
  const {agent,executed}=server(async ({messages})=>{
    requests++;
    if(requests===1)return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[original]}}]};
    assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments),{path:'.',options:{flags:['safe']}});
    assert.equal(messages[1].content,'ok');
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Checked'}}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Checked');
  assert.deepEqual(executed,[{path:'.',options:{flags:['safe']}}]);
  assert.equal(original.function.arguments,'{"path":".","options":{"flags":["safe"]');
});

test('the actual list-files missing-brace response recovers without another model tool request', async () => {
  let requests=0;
  const {agent,executed}=server(async ()=>{
    requests++;
    const message=requests===1?{role:'assistant',tool_calls:[{id:'list',function:{name:'list_files',arguments:'{"path": "."'}}]}:{role:'assistant',content:'Listed'};
    return {choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Listed');
  assert.deepEqual(executed,[{path:'.'}]);
  assert.equal(requests,2);
});

for (const encoded of [false, true]) {
  test(`read_file recovers the reported missing brace with max_lines (encoded=${encoded})`, async () => {
    const raw = '{"path": "/workspace/app/main.py", "max_lines": 10';
    let requests = 0;
    const { agent, executed } = server(async ({ messages }) => {
      if (++requests === 1) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{
        id: 'read', function: { name: 'read_file', arguments: encoded ? JSON.stringify(raw) : raw }
      }] } }] };
      assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments), { path: '/workspace/app/main.py', max_lines: 10 });
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Read file' } }] };
    });
    assert.equal(await agent.runAgentUntilAnswer(), 'Read file');
    assert.deepEqual(executed, [{ path: '/workspace/app/main.py', max_lines: 10 }]);
    assert.equal(requests, 2);
  });
}

for (const args of ['{"path":"a","max_lines":0', '{"path":"a","max_lines":10001', '{"path":"a","max_lines":10,"other":5']) {
  test(`read_file does not guess invalid or unsupported numeric endings: ${args}`, async () => {
    const { agent, executed } = server(async () => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'bad', function: { name: 'read_file', arguments: args } }] } }] }));
    await assert.rejects(agent.runAgentUntilAnswer(), /Stopped after three attempts/);
    assert.deepEqual(executed, []);
  });
}

for(const args of ['{"command":"unfinished','{"command":"echo ok","max_time_seconds":','{"max_time_seconds":6','{"value":tru','{"path":".",','{"path": ]']) {
  test(`incomplete values or invalid syntax are never guessed: ${args}`, async ()=>{
    const {agent,executed}=server(async ()=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[call('bad',args)]}}]}));
    await assert.rejects(agent.runAgentUntilAnswer(),/Stopped after three attempts/);
    assert.deepEqual(executed,[]);
  });
}

test('a plain answer after rejection gets bounded correction feedback and can recover', async ()=>{
  let requests=0;
  const {agent,executed}=server(async ({messages})=>{
    requests++;
    if(requests===3) {
      assert.match(messages.at(-1).content,/Harness feedback/);
      assert.equal(messages.some(m=>m.content==='Invented unrelated answer'),false);
    }
    const message=requests===1?{role:'assistant',tool_calls:[call('bad','{"value":')]}
      :requests===2?{role:'assistant',content:'Invented unrelated answer'}
      :requests===3?{role:'assistant',tool_calls:[call('correct','{"value":1}')]}
      :{role:'assistant',content:'Verified'};
    return {choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Verified');
  assert.deepEqual(executed,[{value:1}]);
  assert.equal(requests,4);
});

test('delimiter recovery preserves quotes, escapes and braces inside command values', async () => {
  const command = 'printf \'{"message":"quoted \\\"value\\\""}\'';
  const value = JSON.stringify({command});
  let requests=0;
  const {agent,executed}=server(async ()=>({choices:[{finish_reason:++requests===1?'tool_calls':'stop',message:requests===1?{role:'assistant',tool_calls:[call('quoted',value.slice(0,-1))]}:{role:'assistant',content:'done'}}]}));
  assert.equal(await agent.runAgentUntilAnswer(),'done');
  assert.deepEqual(executed,[{command}]);
});

test('incomplete responses let the agent choose a fresh complete tool call', async () => {
  let requests=0;
  const {agent,executed}=server(async ({messages})=>{
    if(++requests===1) return {choices:[{finish_reason:'length',message:{role:'assistant',tool_calls:[call('partial','{"path":"."')]}}]};
    if(requests===2) {
      assert.match(messages.at(-1).content,/Decide the next step/);
      return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[call('fresh','{"path":"."}')]}}]};
    }
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Checked'}}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Checked');
  assert.deepEqual(executed,[{path:'.'}]);
});

test('repeated incomplete responses do not fail setup and missing choices are reported', async () => {
  let requests=0;
  const {agent,executed}=server(async ({messages})=>{
    if(++requests<=4) return requests===1 ? {} : {choices:[{finish_reason:'length',message:{role:'assistant',content:'partial'}}]};
    assert.equal(messages.filter(m=>m.content?.startsWith('Harness feedback:')).length,4);
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Please provide a smaller task.'}}]};
  });
  assert.equal(await agent.runAgentUntilAnswer(),'Please provide a smaller task.');
  assert.deepEqual(executed,[]);
});

test('user cancellation still interrupts instead of feeding cancellation back to the model', async () => {
  const {agent}=server(async ()=>{agent.interruptCurrentTurn(); return {};});
  agent.currentTurn={controller:new AbortController()};
  await assert.rejects(agent.runAgentUntilAnswer(),/interrupt/i);
  assert.deepEqual(agent.messages,[]);
});

for (const args of [
  '{"process_id":"build","wait_seconds":30',
  '{"process_id":"build","wait_seconds":0',
  '{"process_id":"build","wait_seconds":30,"max_lines":120',
  '{"name":"monitor_background_process","arguments":{"process_id":"build","wait_seconds":30',
  '{"function":{"name":"monitor_background_process","arguments":{"process_id":"build","wait_seconds":30'
]) {
  test('monitor recovers complete values from incomplete JSON: ' + args, async () => {
    let requests = 0;
    const { agent, executed } = server(async ({ messages }) => {
      if (++requests === 1) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
        tool_calls: [{ id: 'monitor', function: { name: 'monitor_background_process', arguments: args } }] } }] };
      const replay = messages[0].tool_calls[0];
      assert.equal(replay.function.name, 'monitor_background_process');
      assert.equal(JSON.parse(replay.function.arguments).process_id, 'build');
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Monitored' } }] };
    });
    assert.equal(await agent.runAgentUntilAnswer(), 'Monitored');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].process_id, 'build');
    assert.equal(requests, 2);
  });
}

for (const args of [
  '{"process_id":"build","wait_seconds":31',
  '{"process_id":"unfinished',
  '{"process_id":"build","max_lines":601',
  '{"process_id":"build","wait_seconds":30,"unknown":1'
]) {
  test('monitor leaves ambiguous or invalid JSON for retry: ' + args, async () => {
    const { agent, executed } = server(async () => {});
    const result = await agent.toolMessage({ id: 'bad', function: { name: 'monitor_background_process', arguments: args } });
    assert.match(result.content, /No tool was executed/);
    assert.deepEqual(executed, []);
  });
}

test('extracts a missing tool name from an incomplete function envelope', async () => {
  let requests = 0;
  const { agent, executed } = server(async ({ messages }) => {
    if (++requests === 1) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
      tool_calls: [{ id: 'wrapped', function: { arguments: '{"name":"monitor_background_process","arguments":{"process_id":"build","wait_seconds":30' } }] } }] };
    assert.equal(messages[0].tool_calls[0].function.name, 'monitor_background_process');
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] };
  });
  assert.equal(await agent.runAgentUntilAnswer(), 'done');
  assert.deepEqual(executed, [{ process_id: 'build', wait_seconds: 30 }]);
});

test('native argument objects are normalized without changing their values', async () => {
  const { agent, executed } = server(async () => {});
  assert.equal((await agent.toolMessage({ id: 'object', function: {
    name: 'monitor_background_process', arguments: { process_id: 'build', wait_seconds: 0 }
  } })).content, 'ok');
  assert.deepEqual(executed, [{ process_id: 'build', wait_seconds: 0 }]);
});

for (const [name, raw, expected] of [
  ['read_file', '{"path":"/workspace/app/db.py","max_lines":', {path:'/workspace/app/db.py'}],
  ['run_command', '{"command":"echo ok","max_time_seconds":', {command:'echo ok'}],
  ['git', '{"command":"status","cwd":"unfinished', {command:'status'}],
  ['monitor_background_process', '{"process_id":"build","wait_seconds":', {process_id:'build'}],
  ['write_file', '{"path":"a","content":"kept","append":tru', {path:'a',content:'kept'}],
  ['edit_file', '{"path":"a","old_text":"x","new_text":"y","replace_all":', {path:'a',old_text:'x',new_text:'y'}],
  ['run_plugin_hook', '{"plugin_name":"p","hook_command":"build","input_json":"unfinished', {plugin_name:'p',hook_command:'build'}],
  ['read_file', '{"path":"a","max_lines":1e', {path:'a'}],
  ['list_files', '{"path":', {}],
]) {
  for (const encoded of [false, true]) test(name + ' omits unfinished optional field (encoded=' + encoded + ')', async () => {
    let requests = 0;
    const { agent, executed } = server(async ({messages}) => {
      if (++requests === 1) return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[
        {id:'recover',function:{name,arguments:encoded ? JSON.stringify(raw) : raw}}
      ]}}]};
      assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments), expected);
      return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'done'}}]};
    });
    assert.equal(await agent.runAgentUntilAnswer(),'done');
    assert.deepEqual(executed,[expected]);
  });
}

for (const [name, raw] of [
  ['run_command', '{"cwd":".","max_time_seconds":'],
  ['write_file', '{"path":"a","append":'],
  ['write_file', '{"path":"a","content":"unfinished'],
  ['read_file', '{"path":"a","unknown":'],
  ['read_file', '{"path":"a","max_lines":oops'],
  ['read_file', '{"path":"a"oops,"max_lines":'],
  ['read_file', '{"path":"a","max_lines":2,"max_lines":'],
]) test(name + ' rejects missing required or invalid fields: ' + raw, async () => {
  const {agent,executed}=server(async()=>{});
  assert.match((await agent.toolMessage({id:'bad',function:{name,arguments:raw}})).content,/No tool was executed/);
  assert.deepEqual(executed,[]);
});

test('MCP schemas support unfinished nested optional values', async () => {
  const {agent,executed}=server(async()=>{});
  agent.mcpRegistry.toolDefinitions=[{type:'function',function:{name:'external',parameters:{
    type:'object',required:['target'],properties:{target:{type:'string'},options:{type:'object'}}
  }}}];
  const result=await agent.toolMessage({id:'mcp',function:{name:'external',arguments:'{"target":"a","options":{"nested":[1,'}});
  assert.equal(result.content,'ok');
  assert.deepEqual(executed,[{target:'a'}]);
});

test('every built-in tool declares its required arguments', async () => {
  const {TOOL_DEFINITIONS}=await import('../src/tools.js');
  for(const tool of TOOL_DEFINITIONS) {
    assert.ok(Array.isArray(tool.function.parameters.required),tool.function.name);
    for(const key of tool.function.parameters.required) assert.ok(tool.function.parameters.properties[key]);
  }
});

for (const tool of [
  {name:'run_command',arguments:'{}'},
  {name:'run_command',arguments:'{"command":"  "}'},
  {name:'run_command',arguments:'{"command":"unfinished'},
  {name:'run_plugin_hook',arguments:'{"plugin_name":"p"}'},
  {name:'read_file',arguments:'{}'},
  {arguments:'{}'},
]) test('missing requests send no-call feedback without execution or retry: ' + JSON.stringify(tool), async () => {
  const {installToolEvents}=await import('../src/tool_events.js');
  let requests=0;
  const {agent,executed}=server(async ({messages})=>{
    if(++requests===1) return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'missing',function:tool}]}}]};
    assert.ok(messages.some(m=>m.content?.includes('No tool call found:')));
    return {choices:[{finish_reason:'stop',message:{role:'assistant',content:'No action was taken.'}}]};
  });
  const chat=[],events=[];
  agent.ui.message=text=>chat.push(text);
  installToolEvents(agent,(...event)=>events.push(event));
  assert.equal(await agent.runAgentUntilAnswer(),'No action was taken.');
  assert.equal(requests,2);
  assert.deepEqual(executed,[]);
  assert.deepEqual(events,[]);
  assert.match(chat[0],/^No tool call found:/);
  assert.equal(chat.some(text=>text.startsWith('Running tool:')),false);
});

test('tool name and actual shell command are sent to chat before execution', async ()=>{
  const {agent}=server(async()=>{});
  const chat=[];
  agent.ui.message=text=>chat.push(text);
  agent.mcpRegistry.callTool=async(name,args)=>{
    assert.equal(name,'git');
    assert.equal(args.command,'status --short');
    assert.deepEqual(chat,['Running tool: git\nCommand: git status --short']);
    return 'ok';
  };
  assert.equal((await agent.toolMessage({id:'git',function:{name:'git',arguments:'{"command":"status --short"}'}})).content,'ok');
});

test('tools without shell commands send their names to chat', async ()=>{
  const {agent,executed}=server(async()=>{});
  const chat=[];
  agent.ui.message=text=>chat.push(text);
  await agent.toolMessage({id:'read',function:{name:'read_file',arguments:'{"path":"a"}'}});
  assert.deepEqual(chat,['Running tool: read_file']);
  assert.deepEqual(executed,[{path:'a'}]);
});
