import chalk from 'chalk';
import ora from 'ora';
import { select, input, confirm } from '../core/nav.js';
import { listAllIndexedGuidelines, updateGuideline, deleteGuideline } from '../core/db.js';
import { t } from '../core/i18n.js';
import { logError } from '../core/logger.js';

export async function inspectGuidelinesCommand(): Promise<void> {
  while (true) {
    const guidelines = await listAllIndexedGuidelines();

    if (guidelines.length === 0) {
      console.log(chalk.yellow(`\n${t('rulesEmpty')}`));
      console.log(chalk.gray(`${t('rulesEmptyHint')}\n`));
      return;
    }

    console.log(chalk.bold.cyan(`\n${t('rulesListTitle', { count: guidelines.length })}\n`));

    const choices = guidelines.map((g, index) => ({
      name: `${chalk.green(`${index + 1}.`)} ${chalk.bold.white(g.title)} ${chalk.gray(`[Source: ${g.source}]`)}`,
      value: g.id,
    }));

    choices.push({ name: t('rulesBack'), value: 'back' });

    const chosenId = await select({
      message: t('rulesPick'),
      choices,
    });

    if (chosenId === 'back') break;

    const selected = guidelines.find((g) => g.id === chosenId);
    if (!selected) continue;

    while (true) {
      console.log(chalk.bold.cyan(`\n═════════════════════ ${t('ruleDetailTitle')} ═════════════════════`));
      console.log(chalk.yellow(`${t('ruleTitleLabel')} : ${selected.title}`));
      console.log(chalk.gray(`${t('ruleFileLabel')} : ${selected.source}\n`));
      console.log(chalk.white(selected.content));
      console.log(chalk.bold.cyan('════════════════════════════════════════════════════════════════════\n'));

      const action = await select({
        message: t('ruleActionPrompt'),
        choices: [
          { name: t('ruleEdit'), value: 'edit' },
          { name: t('ruleDelete'), value: 'delete' },
          { name: t('ruleBackList'), value: 'back_list' },
        ],
      });

      if (action === 'back_list') {
        break;
      }

      if (action === 'edit') {
        const newTitle = await input({
          message: t('ruleEditTitle'),
          default: selected.title,
          validate: (v) => (v.trim().length > 0 ? true : t('ruleTitleEmpty')),
        });
        if (newTitle === 'back') continue;

        const newContent = await input({
          message: t('ruleEditContent'),
          default: selected.content,
          validate: (v) => (v.trim().length > 0 ? true : t('ruleContentEmpty')),
        });
        if (newContent === 'back') continue;

        const spinner = ora(chalk.blue(t('ruleSaving'))).start();
        try {
          await updateGuideline(selected.id, newTitle.trim(), newContent.trim(), selected.source);
          selected.title = newTitle.trim();
          selected.content = newContent.trim();
          spinner.succeed(chalk.green(t('ruleSaved')));
        } catch (err: any) {
          logError('GuidelineUpdate', err, { id: selected.id });
          spinner.fail(chalk.red(err.message));
        }
      }

      if (action === 'delete') {
        const confirmDelete = await confirm({
          message: t('ruleDeleteConfirm', { title: selected.title }),
          default: false,
        });

        if (confirmDelete) {
          const spinner = ora(chalk.blue(t('ruleDeleting'))).start();
          try {
            await deleteGuideline(selected.id);
            spinner.succeed(chalk.green(t('ruleDeleted', { title: selected.title })));
            break; // kembali ke list utama karena item sudah terhapus
          } catch (err: any) {
            logError('GuidelineDelete', err, { id: selected.id });
            spinner.fail(chalk.red(err.message));
          }
        }
      }
    }
  }
}
