import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { listAllIndexedGuidelines } from '../core/db.js';
import { marked } from 'marked';

export async function inspectGuidelinesCommand(): Promise<void> {
  const guidelines = await listAllIndexedGuidelines();

  if (guidelines.length === 0) {
    console.log(chalk.yellow('\nBelum ada guideline atau coding convention yang di-ingest ke LanceDB.'));
    console.log(chalk.gray('Jalankan menu "📚 Ingest Guidelines" terlebih dahulu untuk mendaftarkan aturan tim.\n'));
    return;
  }

  console.log(chalk.bold.cyan(`\n📋 Daftar Aturan & Guidelines Terdaftar di RAG (${guidelines.length} Section/Rule):\n`));

  const choices = guidelines.map((g, index) => ({
    name: `${chalk.green(`${index + 1}.`)} ${chalk.bold.white(g.title)} ${chalk.gray(`[Source: ${g.source}]`)}`,
    value: g.id,
  }));

  choices.push({ name: '🔙 Kembali ke menu utama', value: 'back' });

  while (true) {
    const chosenId = await select({
      message: 'Pilih aturan untuk melihat detail isi teksnya:',
      choices,
    });

    if (chosenId === 'back') break;

    const selected = guidelines.find((g) => g.id === chosenId);
    if (selected) {
      console.log(chalk.bold.cyan('\n═════════════════════ DETAIL ATURAN CONVENTION ═════════════════════'));
      console.log(chalk.yellow(`Judul : ${selected.title}`));
      console.log(chalk.gray(`File  : ${selected.source}\n`));
      console.log(marked(selected.content));
      console.log(chalk.bold.cyan('════════════════════════════════════════════════════════════════════\n'));
    }
  }
}
