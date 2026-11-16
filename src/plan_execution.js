// Session-owned state is retained as a system message across compaction/resume.
export class PlanExecution {
  constructor(messages = []) {
    const saved = messages.findLast(message => message.name === 'plan_execution_state');
    this.plan = saved ? JSON.parse(saved.content).plan : null;
  }
  create({title, steps, skill_name}) {
    if (this.plan?.status === 'running') throw new Error('Finish or fail the running plan before replacing it');
    this.plan = {title, steps: steps.map(content => ({content, status:'pending'})), skill_name, status:'created', current:0};
  }
  execute({action, step, result, reason, alternatives_tried, next_action}) {
    const plan = this.plan;
    if (!plan) throw new Error('Call create_plan first');
    if (action === 'status') return this.describe();
    if (action === 'start') {
      if (plan.status !== 'created') throw new Error('Only a newly created plan can be started');
      plan.status = 'running'; plan.steps[0].status = 'running';
      return this.describe();
    }
    if (plan.status !== 'running') throw new Error('The plan is not running');
    if (step !== plan.current + 1) throw new Error(`Execute step ${plan.current + 1} before later steps`);
    const current = plan.steps[plan.current];
    if (action === 'complete_step') {
      if (typeof result !== 'string' || !result.trim()) throw new Error('Provide a verified result before completing a step');
      current.status = 'completed'; current.result = result;
      plan.current++;
      if (plan.current === plan.steps.length) plan.status = 'completed';
      else plan.steps[plan.current].status = 'running';
    } else if (action === 'fail_step') {
      if (typeof reason !== 'string' || !reason.trim() || typeof next_action !== 'string' || !next_action.trim() ||
          !Array.isArray(alternatives_tried) || !alternatives_tried.length || alternatives_tried.some(value => typeof value !== 'string' || !value.trim())) {
        throw new Error('Provide reason, next_action, and alternatives_tried (include why no alternative is available)');
      }
      current.status = 'failed'; current.reason = reason; current.alternatives_tried = alternatives_tried;
      plan.status = 'failed'; plan.next_action = next_action;
    } else throw new Error('Unknown execute_plan action');
    return this.describe();
  }
  describe() {
    const plan = this.plan;
    return [`Plan ${plan.status}: ${plan.title}`, ...plan.steps.map((step,index) => `${index+1}. [${step.status}] ${step.content}${step.reason ? ` — ${step.reason}` : ''}`),
      ...(plan.status === 'running' ? [`Execute only step ${plan.current+1} using normal tools. Verify the result, then call execute_plan complete_step. Try safe alternatives on failure; if exhausted call fail_step with a concrete user next_action.`] : []),
      ...(plan.next_action ? [`Next action for the user: ${plan.next_action}`] : [])].join('\n');
  }
  save(messages) {
    const content = JSON.stringify({plan:this.plan});
    const existing = messages.find(message => message.name === 'plan_execution_state');
    if (existing) existing.content = content;
    else messages.push({role:'system',name:'plan_execution_state',content});
  }
}
