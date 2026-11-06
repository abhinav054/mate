export function commandOutcome(name, output) {
  if (/^ERROR:/i.test(output)) return { status: "failed" };
  if (/\[timeout_seconds=\d+\](?:\n\[workspace_server_recorded=[^\n]*\])?\s*$|^\(command exceeded .* timeout\)/.test(output)) return { status: "timedOut" };
  const match = output.match(/\[exit_code=(-?\d+)\](?:\n\[workspace_server_recorded=[^\n]*\])?\s*$/) || output.match(/^\((?:command|git|hook) exited (-?\d+) with no output\)/) || output.match(/^\S+ exited\((-?\d+)\) pid=/);
  if (match) { const exitCode = Number(match[1]); return { status: exitCode === 0 ? "passed" : "failed", exitCode }; }
  if (name === "start_background_process" || (name === "read_background_process" && /^\S+ running pid=/.test(output))) return { status: "inProgress" };
  return { status: "completed" }; // No exit evidence: do not claim success.
}
