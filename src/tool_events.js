import { randomUUID } from 'node:crypto';
import { commandOutcome } from './command_output.js';
import { withCommandExecution } from './command_execution.js';

const commands = new Set(['run_command', 'git', 'run_plugin_hook', 'start_background_process', 'read_background_process', 'monitor_background_process', 'write_background_process', 'stop_background_process', 'list_background_processes']);
const limit = 32768;
const bounded = text => text.length > limit ? text.slice(0, limit) + '\n[Output truncated]' : text;

// Transport events describe actual tool requests/results; model-facing messages
// and arguments are returned untouched. Permissions remain inside this wrapper.
export function installToolEvents(agent, publish, turn = () => null) {
  const original = agent.toolMessage.bind(agent);
  const state = { active: false, diffs: [], diff(detail) { this.diffs.push(String(detail)); } };
  agent.toolMessage = async function(call) {
    const name = call.function?.name || 'unknown';
    let args = {};
    let argumentsValue = call.function?.arguments || {};
    try { const value = JSON.parse(call.function?.arguments || '{}'); argumentsValue = value; if (value && typeof value === 'object' && !Array.isArray(value)) args = value; } catch { /* Native validation rejects malformed arguments. */ }
    const mapped = agent.mcpRegistry?.toolMap?.get(name);
    const command = name === 'git' ? `git ${args.command || ''}` : args.command || args.hook_command || name.replaceAll('_', ' ');
    const base = { id: `mate-tool-${call.id || randomUUID()}` };
    let item = mapped ? { ...base, type: 'mcpToolCall', server: mapped.serverName, tool: mapped.toolName, arguments: argumentsValue, status: 'inProgress', result: null, error: null, durationMs: null, appContext: null, pluginId: null }
      : commands.has(name) ? { ...base, type: 'commandExecution', command, cwd: args.cwd || '.', processId: args.process_id || null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command }], aggregatedOutput: null, exitCode: null, durationMs: null, pluginId: null, scriptPath: null }
      : { ...base, type: 'dynamicToolCall', namespace: 'mate', tool: name, arguments: argumentsValue, status: 'inProgress', contentItems: null, success: null, durationMs: null };
    const current = turn();
    const params = { ...(current ? { turnId: current.id } : {}), item };
    if (current) current.items.push(item);
    publish('item/started', params);
    const started = Date.now();
    state.active = true;
    state.diffs = [];
    let result, thrown, streamed = 0;
    const onOutput = delta => {
      if (item.type !== 'commandExecution' || streamed > limit) return;
      const text = delta.slice(0, limit - streamed);
      streamed += text.length;
      const truncated = delta.length > text.length ? '\n[Output truncated]' : '';
      if (truncated) streamed++;
      if (text || truncated) publish('item/commandExecution/outputDelta', { ...(current ? { turnId: current.id } : {}), itemId: item.id, delta: text + truncated });
    };
    try { result = await withCommandExecution({ onOutput }, () => original(call)); }
    catch (error) { thrown = error; }
    finally { state.active = false; }
    const content = thrown ? `ERROR: ${thrown.message || thrown}` : String(result?.content ?? '');
    const outcome = commands.has(name) ? commandOutcome(name, content) : {};
    const failed = Boolean(thrown) || /^ERROR:/i.test(content) || ['failed', 'timedOut'].includes(outcome.status);
    const declined = /permissions denied|denied command approval/i.test(content);
    const output = bounded([content, ...state.diffs].filter(Boolean).join('\n\n'));
    item = { ...item, status: failed ? 'failed' : 'completed', durationMs: Date.now() - started };
    if (item.type === 'commandExecution') {
      item.status = declined ? 'declined' : ['timedOut', 'backgrounded', 'inProgress'].includes(outcome.status) ? outcome.status : outcome.status === 'interrupted' || agent.currentTurn?.interrupted ? 'interrupted' : item.status;
      item.exitCode = outcome.exitCode ?? null;
      item.processId = outcome.processId ?? item.processId;
      item.aggregatedOutput = output;
      if (output && !streamed) publish('item/commandExecution/outputDelta', { ...(current ? { turnId: current.id } : {}), itemId: item.id, delta: output });
    } else if (item.type === 'mcpToolCall') {
      item.result = failed ? null : { content: [{ type: 'text', text: output }], structuredContent: null, _meta: null };
      item.error = failed ? { message: output } : null;
    } else {
      item.contentItems = [{ type: 'inputText', text: output }];
      item.success = !failed;
    }
    if (current) current.items[current.items.findIndex(value => value.id === item.id)] = item;
    publish('item/completed', { ...(current ? { turnId: current.id } : {}), item });
    if (thrown) throw thrown;
    return result;
  };
  return state;
}
