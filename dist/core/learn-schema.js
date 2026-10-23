"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinedConventionsSchema = exports.MinedRuleSchema = void 0;
const zod_1 = require("zod");
exports.MinedRuleSchema = zod_1.z.object({
    title: zod_1.z.string().describe('Short descriptive rule title (e.g. Controller Response Envelope Pattern)'),
    layer: zod_1.z.enum(['routing', 'service', 'repository', 'model', 'middleware', 'general']).describe('Layer in the architecture'),
    convention: zod_1.z.string().describe('Clear convention statement that must be followed in PRs'),
    exampleGood: zod_1.z.string().nullable().describe('Concrete snippet or explanation from the analyzed code illustrating good pattern'),
});
exports.MinedConventionsSchema = zod_1.z.object({
    featureName: zod_1.z.string().describe('Name of the feature or module analyzed'),
    architectureSummary: zod_1.z.string().describe('Brief summary of how data flows from entrypoint to database in this feature'),
    rules: zod_1.z.array(exports.MinedRuleSchema).describe('List of extracted convention rules mined from the code'),
});
