import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOutcome } from '../src/command_output.js';

test('command outcomes use exit evidence, timeouts and background state', () => {
 for (const [name,output,status,code] of [
  ['run_command','ok\n[exit_code=0]','passed',0],
  ['run_command','(command exited 2 with no output)','failed',2],
  ['git','(git exited 0 with no output)','passed',0],
  ['run_command','out\n[timeout_seconds=30]','timedOut',undefined],
  ['run_command','ERROR: command failed','failed',undefined],
  ['start_background_process','started bg running pid=1','inProgress',undefined],
  ['read_background_process','bg exited(3) pid=1','failed',3],
  ['read_background_process','bg running pid=1','inProgress',undefined],
  ['run_command','output without exit metadata','completed',undefined],
 ]) assert.deepEqual(commandOutcome(name,output),{status,...(code===undefined?{}:{exitCode:code})});
});
