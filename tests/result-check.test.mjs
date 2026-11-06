import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAnswer, parseAssessment } from '../src/result_check.js';
const installResultCheck = agent => { agent.assessAnswer = assessAnswer; return agent; };
const assessment = { aligned: true, can_improve_with_tools: false, reason: 'Greeting answered', follow_up_prompt: '' };
const message = value => ({ content: `Aligned: ${value.aligned ? 'yes' : 'no'}\nCan improve with tools: ${value.can_improve_with_tools ? 'yes' : 'no'}\nReason: ${value.reason}\nFollow-up: ${value.follow_up_prompt}` });

test('the harness parses plain text into typed assessment fields and rejects invalid output', () => {
  assert.deepEqual(parseAssessment(message(assessment)), assessment);
  for (const content of ['broken', 'Aligned: maybe', '{"aligned":true}', 'Aligned: yes\nReason: missing fields']) {
    assert.throws(() => parseAssessment({content}), SyntaxError);
  }
  assert.throws(() => parseAssessment({...message(assessment), tool_calls: [{function: {name: 'report_assessment', arguments: '{}'}}]}), SyntaxError);
});

test('requests plain text without JSON mode, forced tools, or conversation changes', async () => {
  const history = Object.freeze([{role:'system',content:'Unchanged setup context'}]);
  const agent = {model:'test',messages:history,throwIfInterrupted(){},assessAnswer(){},
    async createChatCompletionWithRetry(request) {
      assert.equal(request.tools,undefined);
      assert.equal(request.tool_choice,undefined);
      assert.doesNotMatch(request.messages[0].content,/JSON|report_assessment/i);
      assert.equal(request.response_format,undefined);
      assert.notEqual(request.messages,history);
      return {choices:[{message:message(assessment)}]};
    }};
  assert.equal(installResultCheck(agent),agent);
  assert.deepEqual(await agent.assessAnswer('hi','Hello'),assessment);
  assert.equal(agent.messages,history);
});

test('retries invalid assessment text once and preserves interruption/errors', async () => {
  let calls=0;
  const agent={model:'test',throwIfInterrupted(){},async createChatCompletionWithRetry(){
    calls++; return {choices:[{message:calls===1?{content:'broken'}:message(assessment)}]};
  }};
  assert.deepEqual(await assessAnswer.call(agent,'hi','Hello'),assessment);
  assert.equal(calls,2);
  agent.createChatCompletionWithRetry=async()=>{throw new Error('provider failure');};
  await assert.rejects(assessAnswer.call(agent,'hi','Hello'),/provider failure/);
  agent.throwIfInterrupted=()=>{throw new Error('interrupted');};
  await assert.rejects(assessAnswer.call(agent,'hi','Hello'),/interrupted/);
});
