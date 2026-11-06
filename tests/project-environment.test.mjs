import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { projectEnvironment, installProjectEnvironment } from '../src/project_environment.js';

test('cleans platform paths while preserving project virtualenvs and options', () => {
 const env=projectEnvironment({PATH:'/opt/deploymate/runner/venv/bin:/workspace/venv/bin:/usr/bin',PYTHONPATH:'/app:/opt/deploymate/runner/src:/workspace/src',VIRTUAL_ENV:'/opt/deploymate/runner/venv',NODE_OPTIONS:'--import=/app/agent-runner/mate_usage.mjs',TOKEN:'project-token'});
 assert.equal(env.PATH,'/workspace/venv/bin:/usr/bin');
 assert.equal(env.PYTHONPATH,'/workspace/src');
 assert.equal(env.VIRTUAL_ENV,undefined);assert.equal(env.NODE_OPTIONS,undefined);
 assert.equal(env.TOKEN,'project-token');
 assert.equal(projectEnvironment({VIRTUAL_ENV:'/workspace/venv',NODE_OPTIONS:'--max-old-space-size=1024'}).VIRTUAL_ENV,'/workspace/venv');
});
test('actual tool children get clean environments without mutating their parent', () => {
 installProjectEnvironment();
 const env={...process.env,VIRTUAL_ENV:'/opt/deploymate/runner/venv',PYTHONPATH:'/opt/deploymate/snapshot/src',NODE_OPTIONS:'--import=/app/agent-runner/mate_usage.mjs'};
 const result=childProcess.spawnSync(process.execPath,['-e','console.log(JSON.stringify({venv:process.env.VIRTUAL_ENV,python:process.env.PYTHONPATH,node:process.env.NODE_OPTIONS}))'],{env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{});
 assert.equal(env.VIRTUAL_ENV,'/opt/deploymate/runner/venv');
});
