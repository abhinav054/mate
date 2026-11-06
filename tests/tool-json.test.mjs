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
  test(`does not execute even valid JSON tools when finish_reason is ${reason}`, async () => {
    const { agent, executed } = server(async () => ({ choices: [{ finish_reason: reason, message: { role: 'assistant', tool_calls: [call('partial', '{"value":1}')] } }] }));
    await assert.rejects(agent.runAgentUntilAnswer(), /response was incomplete/);
    assert.deepEqual(executed, []);
    assert.deepEqual(agent.messages, []);
  });
}

test('a streaming delta cannot be executed as a complete message', async () => {
  const { agent, executed } = server(async () => ({ choices: [{ finish_reason: null, delta: { tool_calls: [call('fragment', '{"value":')] } }] }));
  await assert.rejects(agent.runAgentUntilAnswer(), /response was incomplete/);
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

for (const args of ['{"path":"a","max_lines":1e', '{"path":"a","max_lines":0', '{"path":"a","max_lines":10001', '{"path":"a","max_lines":10,"other":5']) {
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

test('a transport-level incomplete response never receives delimiter repair or execution', async () => {
  const {agent,executed}=server(async ()=>({choices:[{finish_reason:'length',message:{role:'assistant',tool_calls:[call('partial','{"path":"."')]}}]}));
  await assert.rejects(agent.runAgentUntilAnswer(),/response was incomplete/);
  assert.deepEqual(executed,[]);
});
