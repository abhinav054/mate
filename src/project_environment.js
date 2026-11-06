import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const prefixes = ["/opt/deploymate", "/opt/codex-ws-venv", "/app/agent-runner", "/app/snapshot_agent"];
const platformPath = value => prefixes.some(prefix => value === prefix || value.startsWith(prefix + "/"));
export function projectEnvironment(base = process.env) {
  const env = {...base};
  for (const key of ["NODE_OPTIONS", "NODE_PATH"]) {
    const saved = "DEPLOYMATE_PROJECT_" + key;
    if (Object.hasOwn(env, saved)) { env[key] = env[saved]; delete env[saved]; }
  }
  for (const key of ["PATH", "PYTHONPATH", "NODE_PATH", "LD_LIBRARY_PATH"]) {
    if (env[key] == null) continue;
    const values = env[key].split(":").filter(value => !platformPath(value) && !(key === "PYTHONPATH" && value === "/app"));
    if (values.some(Boolean)) env[key] = values.join(":"); else delete env[key];
  }
  for (const key of ["VIRTUAL_ENV", "PYTHONHOME", "PYTHONUSERBASE", "PIP_PREFIX", "NPM_CONFIG_PREFIX", "npm_config_prefix"]) {
    if (platformPath(env[key] || "")) delete env[key];
  }
  if (prefixes.some(prefix => (env.NODE_OPTIONS || "").includes(prefix))) delete env.NODE_OPTIONS;
  return env;
}
let installed = false;
export function installProjectEnvironment() {
  if (installed) return;
  installed = true;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[name];
    childProcess[name] = function(...args) {
      const index = name.startsWith("exec") && !name.startsWith("execFile") ? 1 : (Array.isArray(args[1]) || (args[1] == null && args.length > 2)) ? 2 : 1;
      const options = args[index] && typeof args[index] === "object" ? args[index] : {};
      const clean = {...options, env: projectEnvironment(options.env || process.env)};
      if (typeof args[index] === "function") args.splice(index, 0, clean); else args[index] = clean;
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
