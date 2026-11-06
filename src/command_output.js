export function commandOutcome(name, output) {
  const background = output.match(/\[background_process_id=([^\]\n]+)\](?:\n\[workspace_server_recorded=[^\n]*\])?\s*$/);
  if (background) return { status: "backgrounded", processId: background[1] };
  if (/\[interrupted\]\s*$/.test(output)) return { status: "interrupted" };
  if (/^ERROR:/i.test(output)) return { status: "failed" };
  if (/\[timeout_seconds=\d+\](?:\n\[workspace_server_recorded=[^\n]*\])?\s*$|^\(command exceeded .* timeout\)/.test(output)) return { status: "timedOut" };
  const match = output.match(/\[exit_code=(-?\d+)\](?:\n\[workspace_server_recorded=[^\n]*\])?\s*$/) || output.match(/^\((?:command|git|hook) exited (-?\d+) with no output\)/) || output.match(/^\S+ exited\((-?\d+)\) pid=/);
  if (match) { const exitCode = Number(match[1]); return { status: exitCode === 0 ? "passed" : "failed", exitCode }; }
  if (/^\S+ (?:failed|signaled\(SIG\w+\)) pid=/.test(output)) return { status: "failed" };
  if (name === "start_background_process" || (["read_background_process", "monitor_background_process"].includes(name) && /^\S+ running pid=/.test(output))) return { status: "inProgress" };
  return { status: "completed" }; // No exit evidence: do not claim success.
}
