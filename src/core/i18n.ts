export type Language = 'id' | 'en';

export const translations = {
  id: {
    tagline: 'AI Code Review & Knowledge Engine',
    provider: 'provider',
    model: 'model',
    db: 'db',
    unset: 'belum diset',
    chooseAction: 'Pilih aksi:',
    notGitRepoWarn: 'ℹ️  Direktori saat ini bukan git repository. Fitur review cabang git dinonaktifkan.\n',
    
    // Menu Utama
    menuReviewTitle: '🔍 Review Changes',
    menuReviewDesc: 'Review PR / Git diff dengan aturan tim',
    menuKnowledgeTitle: '📚 Knowledge Base',
    menuKnowledgeDesc: 'Tanya jawab, pelajari kode, ingest & kelola aturan',
    menuModelTitle: '⚡ Ganti Model Cepat',
    menuModelDesc: 'Switch model & auto-sync provider',
    menuProviderTitle: '🤖 Configure AI Provider',
    menuProviderDesc: 'Kelola API Key, Base URL & model profile',
    menuHistoryTitle: '📜 Review History',
    menuHistoryDesc: 'Buka atau hapus laporan hasil audit review',
    menuSettingsTitle: '⚙️ Pengaturan',
    menuSettingsDesc: 'Status konfigurasi, bahasa & mode database',
    menuExit: '🚪 Keluar (Exit)',
    goodbye: 'Sampai jumpa, Bos! 👋\n',

    // Submenu Settings
    settingsMenuTitle: 'Menu Utama > ⚙️ Pengaturan',
    settingStatusTitle: '📊 Status Configuration',
    settingStatusDesc: 'Cek ringkasan konfigurasi & lingkungan',
    settingLangTitle: '🌐 Language / Bahasa',
    settingLangDesc: 'Ganti bahasa tampilan (ID / EN)',
    settingDbTitle: '💾 Database Storage Mode',
    settingDbDesc: 'Pilih mode Qdrant VPS atau Local LanceDB',
    settingLogTitle: '📜 System Logs & Tracing',
    settingLogDesc: 'Lihat catatan error/tracing & bersihkan log',
    settingBack: '🔙 Kembali ke Menu Utama',

    // Submenu Knowledge Base
    kbMenuTitle: 'Menu Utama > 📚 Knowledge Base',
    kbDialogTitle: '💬 Tanya Jawab Aturan (Chat Dialog)',
    kbDialogDesc: 'Diskusi interaktif & tanya aturan coding internal',
    kbInspectTitle: '📖 Inspect Active Rules',
    kbInspectDesc: 'Lihat pasal aturan aktif di Vector DB',
    kbLearnTitle: '🧠 Learn Feature Code',
    kbLearnDesc: 'Pelajari konvensi dari folder/route lokal',
    kbIngestTitle: '📥 Ingest Knowledge Baru',
    kbIngestDesc: 'Tambah dokumen (.md, .txt, URL) atau form manual',
    kbBack: '🔙 Kembali ke Menu Utama',

    // Language switcher
    switchLangPrompt: 'Pilih bahasa tampilan (Select display language):',
    langSwitched: '✔ Bahasa berhasil diubah ke Bahasa Indonesia!',
    pressEnter: 'Tekan [Enter] untuk kembali ke Menu Utama...',
  },
  en: {
    tagline: 'AI Code Review & Knowledge Engine',
    provider: 'provider',
    model: 'model',
    db: 'db',
    unset: 'unset',
    chooseAction: 'Select action:',
    notGitRepoWarn: 'ℹ️  Current directory is not a git repository. Git review features are disabled.\n',

    // Main Menu
    menuReviewTitle: '🔍 Review Changes',
    menuReviewDesc: 'Review PR / Git diff against team rules',
    menuKnowledgeTitle: '📚 Knowledge Base',
    menuKnowledgeDesc: 'Chat, learn code, ingest & manage rules',
    menuModelTitle: '⚡ Quick Switch Model',
    menuModelDesc: 'Switch active model & auto-sync provider',
    menuProviderTitle: '🤖 Configure AI Provider',
    menuProviderDesc: 'Manage API keys, Base URLs & model profiles',
    menuHistoryTitle: '📜 Review History',
    menuHistoryDesc: 'Inspect or delete review audit reports',
    menuSettingsTitle: '⚙️ Settings',
    menuSettingsDesc: 'Configuration status, language & database mode',
    menuExit: '🚪 Exit Lumio',
    goodbye: 'See you next time! 👋\n',

    // Submenu Settings
    settingsMenuTitle: 'Main Menu > ⚙️ Settings',
    settingStatusTitle: '📊 Status Configuration',
    settingStatusDesc: 'Check system config & environment details',
    settingLangTitle: '🌐 Language / Bahasa',
    settingLangDesc: 'Change display language (ID / EN)',
    settingDbTitle: '💾 Database Storage Mode',
    settingDbDesc: 'Choose Qdrant VPS or Local LanceDB',
    settingLogTitle: '📜 System Logs & Tracing',
    settingLogDesc: 'View error/tracing logs & clear log file',
    settingBack: '🔙 Back to Main Menu',

    // Submenu Knowledge Base
    kbMenuTitle: 'Main Menu > 📚 Knowledge Base',
    kbDialogTitle: '💬 Knowledge Dialog (Chat)',
    kbDialogDesc: 'Discuss & query internal coding conventions',
    kbInspectTitle: '📖 Inspect Active Rules',
    kbInspectDesc: 'Inspect team conventions stored in Vector DB',
    kbLearnTitle: '🧠 Learn Feature Code',
    kbLearnDesc: 'Learn conventions from local folder/routes',
    kbIngestTitle: '📥 Ingest New Knowledge',
    kbIngestDesc: 'Add documents (.md, .txt, URL) or manual entry',
    kbBack: '🔙 Back to Main Menu',

    // Language switcher
    switchLangPrompt: 'Select display language (Pilih bahasa tampilan):',
    langSwitched: '✔ Display language switched to English!',
    pressEnter: 'Press [Enter] to return to Main Menu...',
  },
};

export function getTranslation(lang: Language = 'id') {
  return translations[lang] || translations.id;
}
