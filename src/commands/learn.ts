import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { scanFeatureCodeFiles, CodeFileContext } from '../core/code-scanner.js';
import { MinedConventionsSchema, MinedConventions, MinedRule } from '../core/learn-schema.js';
import { loadConfig } from '../core/config.js';
import { setActiveAbortController, createProcessAbortController, clearActiveAbortController } from '../core/nav.js';
import { callLLM } from '../core/llm-client.js';
import { getDynamicLearnPromptTemplate } from '../core/prompt-manager.js';
import { insertChunks, InsertResult } from '../core/db.js';
import { DocChunk } from '../core/chunker.js';
import { resolveUserPath } from './ingest.js';
import { t } from '../core/i18n.js';
import { logError } from '../core/logger.js';

function extractMinedResult(rawText: string): MinedConventions {
  const text = (rawText || '').trim();

  // 1. Coba parse langsung
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
      return parsed as MinedConventions;
    }
  } catch {}

  // 2. Ekstrak dari blok markdown ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
        return parsed as MinedConventions;
      }
    } catch {}
  }

  // 3. Fallback bracket matching
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      const snippet = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(snippet);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
        return parsed as MinedConventions;
      }
    } catch {}
  }

  throw new Error(t('learnInvalidJson'));
}

export async function learnFeatureCommand(targetPath: string, modelOverride?: string): Promise<boolean> {
  const resolved = resolveUserPath(targetPath);
  const abortController = createProcessAbortController();
  const spinner = ora(chalk.blue(t('learnScanning', { path: resolved }))).start();

  try {
    const files: CodeFileContext[] = await scanFeatureCodeFiles(resolved, 15, 25000);

    if (abortController.signal.aborted) {
      spinner.info(chalk.yellow(`\n${t('learnScanCancelled')}`));
      return false;
    }

    if (files.length === 0) {
      spinner.warn(chalk.yellow(t('learnNoFiles', { path: resolved })));
      return false;
    }

    spinner.text = chalk.cyan(t('learnReading', { count: files.length }));

    // Gabungkan cuplikan kode terstruktur
    const codeContext = files
      .map((f) => `### File: ${f.relativePath}\n\`\`\`${f.ext.replace('.', '')}\n${f.content.slice(0, 3000)}\n\`\`\``)
      .join('\n\n');

    const config = await loadConfig();
    const modelName = modelOverride || config.defaultModel || '';
    if (!modelName) throw new Error(t('noModel'));

    spinner.text = chalk.magenta(t('learnAnalyzing', { model: modelName }));

    const learnTemplate = await getDynamicLearnPromptTemplate();
    // Function replacers: injected code may contain `$&`, `$'` etc.
    const prompt = learnTemplate
      .replace('{{FOLDER_NAME}}', () => path.basename(resolved))
      .replace('{{CODE_CONTEXT}}', () => codeContext);

    let rawAIResponse = '';
    try {
      rawAIResponse = await callLLM(prompt, modelName, abortController.signal);
    } catch (callErr: any) {
      if (abortController.signal.aborted || callErr.name === 'AbortError') {
        spinner.info(chalk.yellow(`\n${t('learnAiCancelled')}`));
        return false;
      }
      throw callErr;
    }

    if (abortController.signal.aborted) {
      spinner.info(chalk.yellow(`\n${t('cancelledByUser')}`));
      return false;
    }
    const mined = extractMinedResult(rawAIResponse);

    spinner.succeed(chalk.green(`${t('learnDone', { feature: mined.featureName, count: mined.rules.length })}\n`));

    console.log(chalk.bold.cyan(`═════════════════ ${t('learnResultTitle')} ═════════════════`));
    console.log(chalk.yellow(`${t('learnFeature')}: ${mined.featureName}`));
    console.log(chalk.gray(`${t('learnFlow')}: ${mined.architectureSummary}\n`));

    console.log(chalk.bold.green(t('learnRulesTitle', { count: mined.rules.length })));
    // The AI names the layer itself, so it may be missing.
    const layerTag = (rule: MinedRule): string => rule.layer?.trim() ? `[${rule.layer.trim().toUpperCase()}] ` : '';
    mined.rules.forEach((rule, idx) => {
      console.log(`\n  ${chalk.bold.cyan(`${idx + 1}. ${layerTag(rule)}${rule.title}`)}`);
      console.log(`     ${t('learnRule')}: ${chalk.white(rule.convention)}`);
      if (rule.exampleGood) {
        console.log(`     ${t('learnPattern')}: ${chalk.gray(rule.exampleGood.replace(/\n/g, ' '))}`);
      }
    });
    console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════════════\n'));

    // Siapkan chunks untuk disimpan ke database
    const chunks: DocChunk[] = mined.rules.map((rule, idx) => ({
      id: `mined_${path.basename(resolved)}_${idx}_${Date.now()}`,
      source: 'feature-learn',
      title: `${mined.featureName} > ${layerTag(rule)}${rule.title}`,
      content: `${rule.convention}\n\nArchitecture Context:\n${mined.architectureSummary}${
        rule.exampleGood ? `\n\nExample Good Pattern:\n${rule.exampleGood}` : ''
      }`,
    }));

    const saveSpinner = ora(chalk.blue(t('learnSaving'))).start();
    const result: InsertResult = await insertChunks(chunks);

    if (result.insertedCount === 0 && result.duplicateCount > 0) {
      saveSpinner.info(chalk.yellow(t('learnAllDuplicate', { count: result.duplicateCount })));
    } else {
      saveSpinner.succeed(
        chalk.green(
          t('learnSaved', { count: result.insertedCount }) +
            (result.duplicateCount > 0 ? chalk.gray(t('duplicatesSkipped', { count: result.duplicateCount })) : '')
        )
      );
    }

    return true;
  } catch (error: any) {
    if (abortController.signal.aborted || error.name === 'AbortError') {
      spinner.info(chalk.yellow(`\n${t('learnCancelled')}`));
      return false;
    }
    logError('LearnFeature', error, { path: resolved });
    spinner.fail(chalk.red(t('learnFailed', { message: error.message })));
    return false;
  } finally {
    clearActiveAbortController();
  }
}
