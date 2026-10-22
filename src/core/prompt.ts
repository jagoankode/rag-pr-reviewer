export function buildLineReviewPrompt(annotatedDiff: string, contextRules: string[]): string {
  const rulesSection = contextRules.length > 0
    ? `### Mandatory Code Conventions & Architecture Rules:\n${contextRules.join('\n\n---\n\n')}`
    : 'Standard industry conventions: enforce strict typing (no `any`), error handling, and clean code.';

  return `You are a strict Senior Tech Lead and Code Reviewer.
Your goal is to detect ALL code convention violations in the PR diff and map each violation to its EXACT file and line number.

${rulesSection}

### Rules for Review:
1. Scrutinize every newly added or modified line (marked with \`+ L<number>:\`).
2. If ANY rule or coding convention is violated (e.g., using \`any\` type, missing error handling, wrong naming, architecture layer breach), record it under \`violations\`.
3. The \`line\` property MUST match the exact \`L<number>\` from the diff.
4. The \`comment\` must clearly state why it is a violation referencing the rule. Example:
   "You shouldn't use any data type, because shape ambiguous violates code convention rules"
5. If a line is clean or follows conventions, do NOT report it.
6. Provide an overall \`status\` ('APPROVE', 'REQUEST_CHANGES', or 'COMMENT'). If there are errors or major rule violations, status must be \`REQUEST_CHANGES\`.

### Git Diff with Line Numbers:
${annotatedDiff}
`;
}
