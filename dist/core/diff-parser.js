"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAnnotatedDiffFiles = parseAnnotatedDiffFiles;
exports.annotateDiffWithLineNumbers = annotateDiffWithLineNumbers;
const parse_diff_1 = __importDefault(require("parse-diff"));
/**
 * Parses raw git diff and annotates each file individually with exact line numbers.
 * Returning per-file blocks enables granular real-time progress indicators (e.g. [1/50] src/payment.ts).
 */
function parseAnnotatedDiffFiles(rawDiff) {
    const parsedFiles = (0, parse_diff_1.default)(rawDiff);
    const result = [];
    for (const file of parsedFiles) {
        const filePath = file.to || file.from || 'unknown';
        // Skip deleted files or binary files without change chunks
        if (file.deleted || file.chunks.length === 0) {
            continue;
        }
        const fileLines = [`### File: ${filePath}`];
        let addedCount = 0;
        for (const chunk of file.chunks) {
            fileLines.push(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`);
            for (const change of chunk.changes) {
                if (change.type === 'add') {
                    addedCount++;
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
        result.push({
            file: filePath,
            annotatedText: fileLines.join('\n'),
            addedLinesCount: addedCount,
        });
    }
    return result;
}
/**
 * Legacy combined annotator
 */
function annotateDiffWithLineNumbers(rawDiff) {
    const fileDiffs = parseAnnotatedDiffFiles(rawDiff);
    return {
        annotatedText: fileDiffs.map((f) => f.annotatedText).join('\n\n'),
        files: fileDiffs.map((f) => f.file),
    };
}
