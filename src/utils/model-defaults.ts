import { PROVIDERS } from '../providers.js';
import { getDefaultModelForProvider } from './model.js';

export interface RuntimeModelSelection {
  provider: string;
  modelId: string;
}

const FALLBACK_SELECTION: RuntimeModelSelection = {
  provider: 'openai',
  modelId: 'gpt-5.4',
};

/**
 * Pick the first provider that is actually configured in the current runtime.
 * This prevents fresh installs from defaulting to OpenAI when only another
 * provider key, such as GOOGLE_API_KEY, is available.
 */
export function getRuntimeDefaultModelSelection(): RuntimeModelSelection {
  for (const provider of PROVIDERS) {
    if (!provider.apiKeyEnvVar) {
      continue;
    }

    if (!process.env[provider.apiKeyEnvVar]?.trim()) {
      continue;
    }

    const modelId = getDefaultModelForProvider(provider.id);
    if (!modelId) {
      continue;
    }

    return {
      provider: provider.id,
      modelId,
    };
  }

  return FALLBACK_SELECTION;
}
