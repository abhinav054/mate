// Conservative detection: explanations and completed-work summaries remain answers.
export function planningSummary(content, goal = "") {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return null;
  if (/^\s*(?:please\s+)?(?:explain|describe|outline|plan|how\b|what\b)|\b(?:give|show|write|suggest|create)\b.{0,25}\b(?:a |the )?plan\b|\b(?:plan only|don['’]t execute|do not execute)\b/i.test(goal)) return null;
  const thoughts = [...text.matchAll(/<thought>([\s\S]*?)<\/thought>/gi)];
  if (thoughts.length && !text.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim()) {
    // Publish a short action summary, not the model's internal deliberation.
    const action = thoughts.map(match => match[1].match(/(?:^|\n)\s*Change:\s*([^\n]+)/i)?.[1]).find(Boolean);
    return action ? `Next: ${action.slice(0, 400)}` : "Continuing the requested work.";
  }
  if (text.length > 800 || /\?|```|\b(?:completed|finished|implemented|unable|cannot|can't|blocked)\b/i.test(text)) return null;
  if (/^(?:next[, :]*\s*)?(?:(?:i|we)(?:['’]ll| will| need to| should| must)|need to|next step(?: is|:))\s+(?:first\s+|now\s+)?(?:inspect|check|read|write|create|run|install|configure|start|verify|test|update|fix|use|implement|prepare|load|discover|build|deploy)\b/i.test(text)) return text;
  return null;
}
