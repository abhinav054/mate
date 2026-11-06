import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { runCommand, git, browseInternet, runPluginHook, TOOL_DEFINITIONS } from '../src/tools.js';
import { McpRegistry } from '../src/mcp.js';

test('native executions default to fifteen minutes and accept explicit long budgets up to two hours', async () => {
  const original = childProcess.spawnSync;
  const calls = [], delays = [];
  const originalSpawn = childProcess.spawn, originalTimer = global.setTimeout;
  global.setTimeout = (fn, delay) => { delays.push(delay); return originalTimer(fn, 60000); };
  childProcess.spawn = (command, args, options) => {
    calls.push({command,args,options});
    const child = new EventEmitter(); child.stdin = new PassThrough();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  childProcess.spawnSync = (command, args, options) => {
    calls.push({command,args,options});
    return {status:0,stdout:command==='which'?'/usr/bin/git':'ok',stderr:''};
  };
  syncBuiltinESMExports();
  try {
    await runCommand({command:'build'});
    assert.equal(delays.at(-1),900000);
    await runCommand({command:'build',max_time_seconds:3600});
    assert.equal(delays.at(-1),3600000);
    await runCommand({command:'build',max_time_seconds:99999});
    assert.equal(delays.at(-1),7200000);
    await runCommand({command:'check',max_time_seconds:5});
    assert.equal(delays.at(-1),5000);
    await git({command:'status'});
    assert.equal(delays.at(-1),900000);
    await runPluginHook({plugin_name:'example',hook_command:'build'});
    assert.equal(delays.at(-1),900000);
    browseInternet({url:'https://example.invalid'});
    const curl=calls.at(-1);
    assert.equal(curl.args[curl.args.indexOf('--max-time')+1],'900');
    for(const name of ['run_command','git','browse_internet','run_plugin_hook']) {
      const schema=TOOL_DEFINITIONS.find(t=>t.function.name===name).function.parameters.properties.max_time_seconds;
      assert.equal(schema.maximum,7200);
      assert.equal(schema.default,900);
    }
  } finally { childProcess.spawnSync=original; childProcess.spawn=originalSpawn; global.setTimeout=originalTimer; syncBuiltinESMExports(); }
});

test('MCP tool execution has a two-hour budget and retains the turn cancellation signal', async () => {
  const registry=new McpRegistry();
  const controller=new AbortController();
  registry.toolMap.set('long',{serverName:'test',toolName:'build'});
  registry.clients.set('test',{client:{async callTool(params,schema,options){
    assert.deepEqual(params,{name:'build',arguments:{target:'app'}});
    assert.equal(schema,undefined);
    assert.equal(options.timeout,7200000);
    assert.equal(options.maxTotalTimeout,7200000);
    assert.equal(options.signal,controller.signal);
    return {content:[{type:'text',text:'built'}]};
  }}});
  assert.match(await registry.callTool('long',{target:'app'},{signal:controller.signal}),/built/);
});
