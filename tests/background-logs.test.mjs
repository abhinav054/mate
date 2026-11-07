import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWorkspace, runCommand, startBackgroundProcess, readBackgroundProcess, stopBackgroundProcess, monitorBackgroundProcess } from '../src/tools.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('regular shell commands keep background descendants output discoverable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-command-test-'));
  const previous = process.env.AGENT_TERMINAL_LOG_ROOT;
  process.env.AGENT_TERMINAL_LOG_ROOT = path.join(root, 'logs');
  setWorkspace(root);
  let pid;
  try {
    const result = await runCommand({ command: `printf 'foreground output\\n'; python3 -u -c 'import time,sys; print("server stdout"); print("server stderr",file=sys.stderr); time.sleep(30)' & echo $! > child.pid` });
    assert.match(result, /foreground output/);
    assert.match(result, /exit_code=0/);
    pid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8').trim());
    const stdout = fs.readlinkSync(`/proc/${pid}/fd/1`);
    assert.equal(stdout, fs.readlinkSync(`/proc/${pid}/fd/2`));
    assert.equal(path.basename(stdout), 'stdout.log');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.readFileSync(stdout, 'utf8').includes('server stderr')) break;
      await pause(20);
    }
    assert.match(fs.readFileSync(stdout, 'utf8'), /server stdout\nserver stderr/);
    assert.match(await runCommand({ command: 'printf "failure output" >&2; exit 7' }), /failure output\n\n\[exit_code=7\]/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (previous === undefined) delete process.env.AGENT_TERMINAL_LOG_ROOT; else process.env.AGENT_TERMINAL_LOG_ROOT = previous;
    setWorkspace(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background stdout and stderr use a discoverable file and remain readable through the tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-background-test-'));
  const previous = process.env.AGENT_TERMINAL_LOG_ROOT;
  process.env.AGENT_TERMINAL_LOG_ROOT = path.join(root, 'logs');
  setWorkspace(root);
  const id = 'logs-test';
  let pid;
  try {
    const started = startBackgroundProcess({ process_id: id, command: 'printf "startup stdout\\n"; printf "startup stderr\\n" >&2; while true; do printf "live log\\n"; sleep 0.1; done' });
    pid = Number(started.match(/pid=(\d+)/)[1]);
    let output = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      output = readBackgroundProcess({ process_id: id });
      if (output.includes('startup stdout') && output.includes('startup stderr') && output.includes('live log')) break;
      await pause(20);
    }
    assert.match(output, /startup stdout/);
    assert.match(output, /startup stderr/);
    assert.match(output, /live log/);
    const stdout = fs.readlinkSync(`/proc/${pid}/fd/1`);
    assert.equal(stdout, fs.readlinkSync(`/proc/${pid}/fd/2`));
    assert.equal(path.basename(stdout), 'stdout.log');
    const before = fs.statSync(stdout).size;
    await pause(150);
    assert.ok(fs.statSync(stdout).size > before, 'workspace log source must receive live output');
    const log = fs.openSync(stdout, 'a');
    fs.writeSync(log, 'x'.repeat(100000) + '\nlatest tail\n'); fs.closeSync(log);
    assert.match(readBackgroundProcess({ process_id: id, max_lines: 1 }), /latest tail|live log/);
  } finally {
    if (pid) { try { stopBackgroundProcess({ process_id: id, signal_name: 'KILL' }); } catch {} }
    await pause(50);
    if (previous === undefined) delete process.env.AGENT_TERMINAL_LOG_ROOT; else process.env.AGENT_TERMINAL_LOG_ROOT = previous;
    setWorkspace(process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background snapshots and completion preserve newlines, blank lines, spaces and CRLF', async () => {
  const {withCommandExecution}=await import('../src/command_execution.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mate-log-newlines-'));
  const previous=process.env.AGENT_TERMINAL_LOG_ROOT;
  process.env.AGENT_TERMINAL_LOG_ROOT=path.join(root,'logs');
  setWorkspace(root);
  const id='newline-preservation';
  const events=[];
  try {
    withCommandExecution({onBackgroundComplete:event=>events.push(event)},()=>startBackgroundProcess({
      process_id:id,command:"printf 'first\\n\\nsecond  \\r\\n\\n'"
    }));
    const result=await monitorBackgroundProcess({process_id:id,wait_seconds:2});
    const expected='first\n\nsecond  \r\n\n';
    assert.equal(result.slice(result.indexOf('\n')+1),expected);
    assert.equal(readBackgroundProcess({process_id:id,max_lines:2}).split('\n').slice(1).join('\n'),'second  \r\n\n');
    await pause(0);
    assert.equal(events[0].output,expected);
    assert.equal(fs.readFileSync(events[0].logFile,'utf8'),expected);
  } finally {
    try {stopBackgroundProcess({process_id:id,signal_name:'KILL'});} catch {}
    if(previous===undefined)delete process.env.AGENT_TERMINAL_LOG_ROOT;else process.env.AGENT_TERMINAL_LOG_ROOT=previous;
    setWorkspace(process.cwd());
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('newline-only background output remains log data', async ()=>{
  const id='newline-only';
  startBackgroundProcess({process_id:id,command:"printf '\\n\\n'"});
  const result=await monitorBackgroundProcess({process_id:id,wait_seconds:2});
  assert.equal(result.slice(result.indexOf('\n')+1),'\n\n');
});

test('foreground-to-background handoff preserves trailing line breaks', async ()=>{
  const {executeCommand}=await import('../src/command_execution.js');
  const result=await executeCommand('bash',['-lc',"printf 'ready\\n\\n'; sleep 0.3"],{
    cwd:process.cwd(),timeout:2000,yieldAfterMs:100
  });
  try {
    assert.equal(result.backgrounded,true);
    assert.equal(result.output,'ready\n\n');
  } finally {
    await result.entry.completion;
  }
});
