import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { generateObject } from 'ai';
import { scanFeatureCodeFiles, CodeFileContext } from '../core/code-scanner.js';
import { MinedConventionsSchema, MinedConventions } from '../core/learn-schema.js';
import { getActiveAIProvider } from '../core/config.js';
import { insertChunks, InsertResult } from '../core/db.js';
import { DocChunk } from '../core/chunker.js';
import { resolveUserPath } from './ingest.js';

export async function learnFeatureCommand(targetPath: string, modelOverride?: string): Promise<boolean> {
  const resolved = resolveUserPath(targetPath);
  const spinner = ora(chalk.blue(`Memindai source code di ${resolved}...`)).start();

  try {
    const files: CodeFileContext[] = await scanFeatureCodeFiles(resolved, 15, 25000);

    if (files.length === 0) {
      spinner.warn(chalk.yellow(`Tidak ditemukan file source code yang didukung di: ${resolved}`));
      return false;
    }

    spinner.text = chalk.cyan(`Membaca ${files.length} file source code untuk analisis hulu-ke-hilir...`);

    // Gabungkan cuplikan kode terstruktur
    const codeContext = files
      .map((f) => `### File: ${f.relativePath}\n\`\`\`${f.ext.replace('.', '')}\n${f.content.slice(0, 3000)}\n\`\`\``)
      .join('\n\n');

    const { client, config } = await getActiveAIProvider();
    const modelName = modelOverride || config.defaultModel || 'ag/gemini-3.8-flash';

    spinner.text = chalk.magenta(`Menganalisis pola arsitektur & aturan coding via AI (${modelName})...`);

    const prompt = `You are a Principal Software Architect.
Analyze the following source code files from a local feature/module folder (${path.basename(resolved)}).
Trace the flow from entrypoint/route down to business logic and data layer.

Reverse-engineer the implicit and explicit CODING CONVENTIONS, architecture patterns, and rules that this team follows.

Extract rules across these categories:
- Routing & Controller patterns (input validation, error handling, status codes)
- Service / Business logic rules (DTO usage, typing, pure logic vs side effects)
- Model & Database persistence conventions
- Naming conventions (files, variables, interfaces)

Source Code from folder:
${codeContext}
`;

    const { object: mined } = await generateObject({
      model: client(modelName),
      schema: MinedConventionsSchema,
      prompt,
    });

    spinner.succeed(chalk.green(`Selesai menganalisis fitur "${mined.featureName}"! Ditemukan ${mined.rules.length} aturan konvensi.\n`));

    console.log(chalk.bold.cyan('═════════════════ HASIL EKSTRAKSI ARSITEKTUR & ATURAN ═════════════════'));
    console.log(chalk.yellow(`Fitur   : ${mined.featureName}`));
    console.log(chalk.gray(`Alur    : ${mined.architectureSummary}\n`));

    console.log(chalk.bold.green(`Daftar Aturan yang Dipelajari (${mined.rules.length}):`));
    mined.rules.forEach((rule, idx) => {
      console.log(`\n  ${chalk.bold.cyan(`${idx + 1}. [${rule.layer.toUpperCase()}] ${rule.title}`)}`);
      console.log(`     Aturan : ${chalk.white(rule.convention)}`);
      if (rule.exampleGood) {
        console.log(`     Pola   : ${chalk.gray(rule.exampleGood.replace(/\n/g, ' '))}`);
      }
    });
    console.log(chalk.bold.cyan('\n═══════════════════════════════════════════════════════════════════════\n'));

    // Siapkan chunks untuk disimpan ke LanceDB
    const chunks: DocChunk[] = mined.rules.map((rule, idx) => ({
      id: `mined_${path.basename(resolved)}_${idx}_${Date.now()}`,
      source: `local_feature:${resolved}`,
      title: `${mined.featureName} > [${rule.layer.toUpperCase()}] ${rule.title}`,
      content: `${rule.convention}\n\nArchitecture Context:\n${mined.architectureSummary}${
        rule.exampleGood ? `\n\nExample Good Pattern:\n${rule.exampleGood}` : ''
      }`,
    }));

    const saveSpinner = ora(chalk.blue('Menyimpan aturan hasil belajar ke LanceDB (dengan cek anti-duplikat)...')).start();
    const result: InsertResult = await insertChunks(chunks);

    if (result.insertedCount === 0 && result.duplicateCount > 0) {
      saveSpinner.info(chalk.yellow(`Semua (${result.duplicateCount}) aturan yang dipelajari sudah pernah tersimpan sebelumnya.`));
    } else {
      saveSpinner.succeed(
        chalk.green(
          `Berhasil menambahkan ${result.insertedCount} aturan convention baru ke LanceDB!` +
            (result.duplicateCount > 0 ? chalk.gray(` (${result.duplicateCount} duplikat dilewati)`) : '')
        )
      );
    }

    return true;
  } catch (error: any) {
    spinner.fail(chalk.red(`Gagal mengekstrak aturan dari code: ${error.message}`));
    return false;
  }
}
