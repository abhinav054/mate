import { commandOutcome } from './command_output.js';

const commands = new Set(['run_command','git','run_plugin_hook','start_background_process','read_background_process','monitor_background_process','write_background_process','stop_background_process','list_background_processes']);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;

export function toolResultFailed(name, result) {
  const text = String(result?.content || '');
  if (/^(?:ERROR:|No tool call found:)/i.test(text)) return true;
  return commands.has(name) && ['failed','timedOut','interrupted','declined'].includes(commandOutcome(name,text).status);
}

export function alternativeToolFeedback(names) {
  return 'Harness feedback: the tool failure/retry limit was reached for ' + names.join(', ') + '. '
    + 'Stop repeating the failing request. Find a different authorized approach, use another suitable tool, or move forward with independent tasks from the original request. '
    + 'Keep completed work and do not repeat successful sibling calls. Failures may have made partial changes; inspect existing state before repeating writes. '
    + 'Do not bypass denied permissions or invent missing parameters. If no alternative is available, explain the blocked step and what remains incomplete; do not claim it succeeded.';
}

export class ToolFailureRecovery {
  constructor(limit = 3) { this.limit=limit; this.counts=new Map(); this.blocked=new Set(); this.ignored=0; }
  key(call, invalid) {
    const name=call.function?.name || '(missing tool name)';
    if (invalid) return name+':invalid';
    try { return name+':'+JSON.stringify(canonical(JSON.parse(call.function.arguments || '{}'))); }
    catch { return name+':invalid'; }
  }
  check(key) {
    if (!this.blocked.has(key)) return {blocked:false, exhausted:false};
    return {blocked:true, exhausted:++this.ignored >= this.limit};
  }
  record(name,key,failed) {
    if (!failed) {
      this.counts.delete(name); this.blocked.clear(); this.ignored=0;
      return null;
    }
    const count=(this.counts.get(name)||0)+1;
    this.counts.set(name,count);
    if (count < this.limit) return null;
    this.counts.set(name,0); this.blocked.add(key);
    return alternativeToolFeedback([name]);
  }
}
