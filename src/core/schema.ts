import { z } from 'zod';

export const LineViolationSchema = z.object({
  id: z.string().optional(),
  ruleId: z.string().optional(),
  column: z.number().int().positive().optional(),
  check: z.string().optional(),
  engine: z.enum(['ast', 'filesystem', 'ai']).optional(),
  file: z.string().describe('Relative path of the file where violation occurred (e.g. src/payment.ts)'),
  line: z.number().describe('Line number of the new/modified code where the violation occurred'),
  rule: z.string().describe('The specific code convention or rule that was violated'),
  severity: z.enum(['error', 'warning', 'info']).describe('Severity of the violation'),
  comment: z.string().describe('Clear explanation of the violation'),
  suggestedFix: z.string().nullable().describe('Actionable replacement code snippet or suggestion (null if no fix available)'),
});

export const FileReviewResultSchema = z.object({
  violations: z.array(LineViolationSchema).describe('Violations found in this file'),
  notes: z.array(z.string()).describe('Specific architecture or convention notes for this file'),
});

export const PRReviewResultSchema = z.object({
  advisory: z.array(LineViolationSchema).optional(),
  advisoryNotes: z.array(z.string()).optional(),
  reviewSnapshot: z.object({ fingerprint: z.string(), engine: z.string(), rules: z.string(), inputs: z.string(), diff: z.string(), base: z.string(), head: z.string(), mergeBase: z.string(), mode: z.string(), scope: z.string() }).optional(),
  complete: z.boolean().optional(),
  ruleSnapshot: z.string().optional(),
  coverage: z.array(z.object({ ruleId: z.string(), file: z.string(), status: z.enum(['PASS','FAIL','NOT_APPLICABLE','UNCERTAIN']), reason: z.string() })).optional(),
  status: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  summary: z.string().describe('High-level overview of the pull request changes'),
  violations: z.array(LineViolationSchema).describe('List of all detected code convention violations mapped to exact file and line number'),
  generalFeedback: z.array(z.string()).describe('General architecture or design pattern observations'),
});

export type LineViolation = z.infer<typeof LineViolationSchema>;
export type FileReviewResult = z.infer<typeof FileReviewResultSchema>;
export type PRReviewResult = z.infer<typeof PRReviewResultSchema>;
