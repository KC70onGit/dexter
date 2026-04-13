import { afterEach, describe, expect, it } from 'bun:test';
import { getRuntimeDefaultModelSelection } from './model-defaults.js';

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearProviderKeys() {
  for (const key of Object.keys(ORIGINAL_ENV)) {
    delete process.env[key];
  }
}

describe('getRuntimeDefaultModelSelection', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('prefers the first configured provider in registry order', () => {
    clearProviderKeys();
    process.env.GOOGLE_API_KEY = 'google-test-key';

    expect(getRuntimeDefaultModelSelection()).toEqual({
      provider: 'google',
      modelId: 'gemini-2.5-flash-lite',
    });
  });

  it('falls back to OpenAI defaults when no provider keys are configured', () => {
    clearProviderKeys();

    expect(getRuntimeDefaultModelSelection()).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.4',
    });
  });
});
