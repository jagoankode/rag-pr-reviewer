import chalk from 'chalk';
import ora from 'ora';
import { select, input, confirm } from '../core/nav.js';
import { listAllIndexedGuidelines, updateGuideline, deleteGuideline } from '../core/db.js';

export async function inspectGuidelinesCommand(): Promise<void> {
  while (true) {
    const guidelines = await listAllIndexedGuidelines();

    if (guidelines.length === 0) {
      console.log(chalk.yellow('\nBelum ada guideline atau coding convention yang terdaftar di database.'));
      console.log(chalk.gray('Jalankan menu "📥 Ingest Knowledge" terlebih dahulu untuk mendaftarkan aturan tim.\n'));
      return;
    }

    console.log(chalk.bold.cyan(`\n📋 Daftar Aturan & Guidelines Terdaftar di RAG (${guidelines.length} Section/Rule):\n`));

    const choices = guidelines.map((g, index) => ({
      name: `${chalk.green(`${index + 1}.`)} ${chalk.bold.white(g.title)} ${chalk.gray(`[Source: ${g.source}]`)}`,
      value: g.id,
    }));

    choices.push({ name: '🔙 Kembali ke menu sebelumnya', value: 'back' });

    const chosenId = await select({
      message: 'Pilih aturan untuk melihat detail / mengelola:',
      choices,
    });

    if (chosenId === 'back') break;

    const selected = guidelines.find((g) => g.id === chosenId);
    if (!selected) continue;

    while (true) {
      console.log(chalk.bold.cyan('\n═════════════════════ DETAIL ATURAN CONVENTION ═════════════════════'));
      console.log(chalk.yellow(`Judul : ${selected.title}`));
      console.log(chalk.gray(`File  : ${selected.source}\n`));
      console.log(chalk.white(selected.content));
      console.log(chalk.bold.cyan('════════════════════════════════════════════════════════════════════\n'));

      const action = await select({
        message: 'Aksi untuk aturan ini:',
        choices: [
          { name: '✏️  Edit / Perbarui Aturan Ini (Admin)', value: 'edit' },
          { name: '🗑️  Hapus Aturan Ini dari Database (Admin)', value: 'delete' },
          { name: '🔙 Kembali ke Daftar Aturan', value: 'back_list' },
        ],
      });

      if (action === 'back_list') {
        break;
      }

      if (action === 'edit') {
        const newTitle = await input({
          message: 'Edit Judul Aturan:',
          default: selected.title,
          validate: (v) => (v.trim().length > 0 ? true : 'Judul tidak boleh kosong'),
        });
        if (newTitle === 'back') continue;

        const newContent = await input({
          message: 'Edit Isi Spesifikasi Aturan:',
          default: selected.content,
          validate: (v) => (v.trim().length > 0 ? true : 'Isi aturan tidak boleh kosong'),
        });
        if (newContent === 'back') continue;

        const spinner = ora(chalk.blue('Menyimpan perubahan aturan ke database...')).start();
        try {
          await updateGuideline(selected.id, newTitle.trim(), newContent.trim(), selected.source);
          selected.title = newTitle.trim();
          selected.content = newContent.trim();
          spinner.succeed(chalk.green('✔ Aturan berhasil diperbarui dan disinkronkan ke Vector DB!'));
        } catch (err: any) {
          spinner.fail(chalk.red(err.message));
        }
      }

      if (action === 'delete') {
        const confirmDelete = await confirm({
          message: `Apakah Anda yakin ingin MENGHAPUS aturan "${selected.title}"?`,
          default: false,
        });

        if (confirmDelete) {
          const spinner = ora(chalk.blue('Menghapus aturan dari database...')).start();
          try {
            await deleteGuideline(selected.id);
            spinner.succeed(chalk.green(`✔ Aturan "${selected.title}" berhasil dihapus!`));
            break; // kembali ke list utama karena item sudah terhapus
          } catch (err: any) {
            spinner.fail(chalk.red(err.message));
          }
        }
      }
    }
  }
}
