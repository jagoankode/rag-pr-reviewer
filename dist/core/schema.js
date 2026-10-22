"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRReviewResultSchema = exports.LineViolationSchema = void 0;
const zod_1 = require("zod");
exports.LineViolationSchema = zod_1.z.object({
    file: zod_1.z.string().describe('Relative path of the file where violation occurred (e.g. src/payment.ts)'),
    line: zod_1.z.number().describe('Line number of the new/modified code where the violation occurred'),
    rule: zod_1.z.string().describe('The specific code convention or rule that was violated'),
    severity: zod_1.z.enum(['error', 'warning', 'info']).describe('Severity of the violation'),
    comment: zod_1.z.string().describe('Clear explanation of the violation (e.g. You shouldn\'t use any data type, because shape ambiguous violates code convention rules)'),
    suggestedFix: zod_1.z.string().optional().describe('Actionable replacement code snippet or suggestion'),
});
exports.PRReviewResultSchema = zod_1.z.object({
    status: zod_1.z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    summary: zod_1.z.string().describe('High-level overview of the pull request changes'),
    violations: zod_1.z.array(exports.LineViolationSchema).describe('List of all detected code convention violations mapped to exact file and line number'),
    generalFeedback: zod_1.z.array(zod_1.z.string()).describe('General architecture or design pattern observations not tied to a single line'),
});
