"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.annotateDiffWithLineNumbers = annotateDiffWithLineNumbers;
const parse_diff_1 = __importDefault(require("parse-diff"));
/**
 * Parses raw git diff and annotates each added/modified line with its exact line number
 * so the LLM can precisely reference the line of violation.
 */
function annotateDiffWithLineNumbers(rawDiff) {
    const parsedFiles = (0, parse_diff_1.default)(rawDiff);
    const annotatedBlocks = [];
    const fileNames = [];
    for (const file of parsedFiles) {
        const filePath = file.to || file.from || 'unknown';
        fileNames.push(filePath);
        const fileLines = [`### File: ${filePath}`];
        for (const chunk of file.chunks) {
            fileLines.push(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`);
            for (const change of chunk.changes) {
                if (change.type === 'add') {
                    fileLines.push(`+ L${change.ln}: ${change.content.replace(/^\+/, '')}`);
                }
                else if (change.type === 'del') {
                    fileLines.push(`- (old): ${change.content.replace(/^-/, '')}`);
                }
                else {
                    fileLines.push(`  L${change.ln2 ?? change.ln1}: ${change.content}`);
                }
            }
        }
        annotatedBlocks.push(fileLines.join('\n'));
    }
    return {
        annotatedText: annotatedBlocks.join('\n\n'),
        files: fileNames,
    };
}
