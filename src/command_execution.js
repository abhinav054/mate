import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';

const executions = new AsyncLocalStorage();

export function withCommandExecution(context, action) {
  return executions.run({ ...executions.getStore(), ...context }, action);
}

// Files remain inherited by background descendants and discoverable via /proc.
// Polling them keeps the event loop free for output notifications and interrupts.
export async function executeCommand(command, args, options) {
  const { onOutput, signal } = executions.getStore() || {};
  if (signal?.aborted) throw signal.reason || new Error('Command interrupted');
  const root = process.env.AGENT_TERMINAL_LOG_ROOT || process.env.CODEX_TERMINAL_LOG_ROOT || path.join(os.tmpdir(), 'codex-terminals');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const logFile = path.join(fs.mkdtempSync(path.join(root, 'mate-command-')), 'stdout.log');
  const descriptor = fs.openSync(logFile, 'a', 0o600);
  const reader = fs.openSync(logFile, 'r');
  const decoder = new StringDecoder('utf8');
  let child, offset = 0, tail = '', timedOut = false, interrupted = false;
  const drain = () => {
    const size = fs.fstatSync(reader).size;
    while (offset < size) {
      const buffer = Buffer.alloc(Math.min(size - offset, 65536));
      const count = fs.readSync(reader, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      const text = decoder.write(buffer.subarray(0, count));
      tail = (tail + text).slice(-65536);
      if (text) onOutput?.(text);
    }
  };
  try {
    const { timeout, input, ...spawnOptions } = options;
    child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ['pipe', descriptor, descriptor] });
    child.stdin.on('error', () => {}); // A command may exit without consuming input.
    child.stdin.end(input);
    return await new Promise(resolve => {
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const abort = () => { interrupted = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
      const poll = setInterval(drain, 100);
      signal?.addEventListener('abort', abort, { once: true });
      let finished = false;
      const finish = (status, error = null) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        drain();
        const final = decoder.end();
        tail = (tail + final).slice(-65536);
        if (final) onOutput?.(final);
        resolve({ status, error, timedOut, interrupted, output: tail.trimEnd(), logFile });
      };
      child.once('error', error => finish(null, error));
      child.once('exit', status => finish(status));
      if (signal?.aborted) abort();
    });
  } finally {
    fs.closeSync(descriptor);
    fs.closeSync(reader);
  }
}
