import { z } from 'zod';

export const MinedRuleSchema = z.object({
  title: z.string().describe('Short descriptive rule title (e.g. Controller Response Envelope Pattern)'),
  layer: z.enum(['routing', 'service', 'repository', 'model', 'middleware', 'general']).describe('Layer in the architecture'),
  convention: z.string().describe('Clear convention statement that must be followed in PRs'),
  exampleGood: z.string().nullable().describe('Concrete snippet or explanation from the analyzed code illustrating good pattern'),
});

export const MinedConventionsSchema = z.object({
  featureName: z.string().describe('Name of the feature or module analyzed'),
  architectureSummary: z.string().describe('Brief summary of how data flows from entrypoint to database in this feature'),
  rules: z.array(MinedRuleSchema).describe('List of extracted convention rules mined from the code'),
});

export type MinedRule = z.infer<typeof MinedRuleSchema>;
export type MinedConventions = z.infer<typeof MinedConventionsSchema>;
