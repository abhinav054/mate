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

export function commandExecutionSignal() {
  return executions.getStore()?.signal;
}

export function backgroundCompletionHandler() {
  return executions.getStore()?.onBackgroundComplete;
}

export function trackProcess(child, metadata = {}) {
  const entry = { ...metadata, process: child, result: null };
  entry.completion = new Promise(resolve => {
    const finish = result => {
      if (entry.result) return;
      entry.result = result;
      resolve(result);
    };
    child.once('error', error => finish({ status: null, error }));
    child.once('exit', (status, exitSignal) => finish({ status, exitSignal }));
  });
  return entry;
}

// File-backed output survives foreground-to-background handoff. The original
// process and execution deadline are retained; the command is never restarted.
export async function executeCommand(command, args, options) {
  const { onOutput, signal } = executions.getStore() || {};
  if (signal?.aborted) throw signal.reason || new Error('Command interrupted');
  const root = process.env.AGENT_TERMINAL_LOG_ROOT || process.env.CODEX_TERMINAL_LOG_ROOT || path.join(os.tmpdir(), 'codex-terminals');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const logFile = path.join(fs.mkdtempSync(path.join(root, 'mate-command-')), 'stdout.log');
  const descriptor = fs.openSync(logFile, 'a', 0o600);
  const reader = fs.openSync(logFile, 'r');
  const decoder = new StringDecoder('utf8');
  let offset = 0, tail = '', timedOut = false, interrupted = false;
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
  let poll, yieldTimer, timer, entry;
  const abort = () => { interrupted = true; stop(); };
  const stop = () => { try { process.kill(-entry.process.pid, 'SIGKILL'); } catch {} };
  try {
    const { timeout, input, yieldAfterMs, ...spawnOptions } = options;
    // The legacy PTY wrapper hangs up background jobs; capture output directly.
    const executable = command === 'bash' && fs.existsSync('/opt/codex-real/bash') ? '/opt/codex-real/bash' : command;
    let child;
    try { child = spawn(executable, args, { ...spawnOptions, detached: true, stdio: ['pipe', descriptor, descriptor] }); }
    finally { fs.closeSync(descriptor); }
    entry = trackProcess(child, { logFile, command: command === 'bash' ? args.at(-1) : [command, ...args].join(' '), cwd: options.cwd,
      created_at: new Date().toISOString(), timeoutSeconds: timeout / 1000 });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    // This completion handler stays attached after handoff and owns the deadline.
    entry.completion.then(result => {
      clearTimeout(timer);
      Object.assign(result, { timedOut, interrupted });
    });
    poll = setInterval(drain, 100);
    const foreground = Number.isFinite(yieldAfterMs) ? new Promise(resolve => {
      yieldTimer = setTimeout(() => resolve({ backgrounded: true }), yieldAfterMs);
    }) : new Promise(() => {});
    if (signal?.aborted) abort();
    let result = await Promise.race([entry.completion, foreground]);
    // If completion raced with the foreground timer, prefer the exit evidence.
    if (entry.result) result = entry.result;
    drain();
    const final = decoder.end();
    if (final) { tail = (tail + final).slice(-65536); onOutput?.(final); }
    return { ...result, output: tail.trimEnd(), logFile, entry };
  } catch (error) {
    clearTimeout(timer);
    if (entry && !entry.result) stop();
    throw error;
  } finally {
    clearInterval(poll);
    clearTimeout(yieldTimer);
    signal?.removeEventListener('abort', abort);
    fs.closeSync(reader);
  }
}
