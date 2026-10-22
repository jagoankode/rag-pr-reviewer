import { z } from 'zod';

export const LineViolationSchema = z.object({
  file: z.string().describe('Relative path of the file where violation occurred (e.g. src/payment.ts)'),
  line: z.number().describe('Line number of the new/modified code where the violation occurred'),
  rule: z.string().describe('The specific code convention or rule that was violated'),
  severity: z.enum(['error', 'warning', 'info']).describe('Severity of the violation'),
  comment: z.string().describe('Clear explanation of the violation (e.g. You shouldn\'t use any data type, because shape ambiguous violates code convention rules)'),
  suggestedFix: z.string().optional().describe('Actionable replacement code snippet or suggestion'),
});

export const PRReviewResultSchema = z.object({
  status: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  summary: z.string().describe('High-level overview of the pull request changes'),
  violations: z.array(LineViolationSchema).describe('List of all detected code convention violations mapped to exact file and line number'),
  generalFeedback: z.array(z.string()).describe('General architecture or design pattern observations not tied to a single line'),
});

export type LineViolation = z.infer<typeof LineViolationSchema>;
export type PRReviewResult = z.infer<typeof PRReviewResultSchema>;
