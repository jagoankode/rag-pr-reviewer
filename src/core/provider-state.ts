import { AppConfig, ProviderProfile, loadConfig, saveConfig, resolveProviderForModel } from './config.js';

// Model names are unique in the saved list. Assigning an existing name moves it
// to the chosen provider (the schema cannot represent provider-scoped duplicates).
export function parseModelNames(value: string): string[] {
  const names = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
  if (!names.length || names.some(v => /^(back|b)$/i.test(v))) throw new Error('Invalid model name');
  return names;
}
export function registerProvider(config: AppConfig, profile: ProviderProfile, edit = false): AppConfig {
  if (!profile.id || /^(back|b|new_custom)$/i.test(profile.id)) throw new Error('Invalid provider id');
  if (!edit && config.providers?.[profile.id]) throw new Error('Provider already registered');
  const next = structuredClone(config);
  next.providers = { ...next.providers, [profile.id]: { ...profile, models: edit ? [...(next.providers?.[profile.id]?.models || [])] : [] } };
  if (next.provider === profile.id) {
    next.apiKey = profile.apiKey;
    next.baseUrl = profile.baseUrl;
  }
  return next;
}
export function selectModel(config: AppConfig, model: string): AppConfig {
  const provider = config.modelProviderMap?.[model];
  if (!config.savedModels?.includes(model) || !provider || !config.providers?.[provider]) throw new Error('Model must belong to a registered provider');
  const resolved = resolveProviderForModel(config, model);
  return { ...config, defaultModel: model, provider, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl };
}
export function assignModels(config: AppConfig, models: string[], provider: string): AppConfig {
  if (!config.providers?.[provider]) throw new Error('Provider is not registered');
  const next = structuredClone(config);
  next.savedModels ||= [];
  next.modelProviderMap ||= {};
  for (const model of parseModelNames(models.join(','))) {
    for (const profile of Object.values(next.providers!)) profile.models = profile.models.filter(m => m !== model);
    next.providers![provider].models.push(model);
    next.modelProviderMap[model] = provider;
    if (!next.savedModels.includes(model)) next.savedModels.push(model);
  }
  return selectModel(next, models[0]);
}
export function removeModels(config: AppConfig, models: string[]): AppConfig {
  const next = structuredClone(config);
  next.savedModels = (next.savedModels || []).filter(m => !models.includes(m));
  for (const model of models) delete next.modelProviderMap?.[model];
  for (const profile of Object.values(next.providers || {})) profile.models = profile.models.filter(m => !models.includes(m));
  if (models.includes(next.defaultModel || '')) next.defaultModel = '';
  return next;
}
export function removeProvider(config: AppConfig, id: string): AppConfig {
  const affected = Object.entries(config.modelProviderMap || {}).filter(([, p]) => p === id).map(([m]) => m);
  const next = removeModels(config, affected);
  delete next.providers?.[id];
  if (next.provider === id) Object.assign(next, { provider: '', defaultModel: '', apiKey: '', baseUrl: '' });
  return next;
}
// Reload the writable layer at commit time, not the snapshot from menu entry.
// Project-only DB/report/embedding overrides must never leak into global config.
export async function updateProviderState(change: (latest: AppConfig) => AppConfig): Promise<AppConfig> {
  const next = change(await loadConfig(false));
  await saveConfig(next);
  return next;
}
