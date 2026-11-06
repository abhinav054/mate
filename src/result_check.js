const assessmentInstructions = "Assess whether the candidate response satisfies the user's request, including completeness, direct responsiveness, and honest verification. Reply in four plain-text lines: Aligned: yes or no; Can improve with tools: yes or no; Reason: a brief explanation; Follow-up: a brief next action, or leave blank.";

export function parseAssessment(message) {
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  const match = text.match(/^Aligned:[ \t]*(yes|no)[ \t]*\r?\nCan improve with tools:[ \t]*(yes|no)[ \t]*\r?\nReason:[ \t]*([^\r\n]*)\r?\nFollow-up:[ \t]*([\s\S]*)$/i);
  if (!match || message.tool_calls?.length) throw new SyntaxError("Result check did not return a complete plain-text assessment");
  return { aligned: match[1].toLowerCase() === "yes", can_improve_with_tools: match[2].toLowerCase() === "yes", reason: match[3].trim(), follow_up_prompt: match[4].trim() };
}

export async function assessAnswer(userGoal, answer) {
  const messages = [
    { role: "system", content: assessmentInstructions },
    { role: "user", content: `User prompt:\n${userGoal}\n\nCandidate response:\n${answer}` },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    this.throwIfInterrupted();
    const response = await this.createChatCompletionWithRetry({ label: "result check", model: this.model, messages });
    this.throwIfInterrupted();
    try {
      return parseAssessment(response?.choices?.[0]?.message);
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === 1) throw error;
      messages[0] = { ...messages[0], content: assessmentInstructions + " Put each labeled field on its own line." };
    }
  }
}
