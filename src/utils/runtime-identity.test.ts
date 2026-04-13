import { describe, expect, test } from 'bun:test';
import { getRuntimeIdentity, inferRuntimeIdentityFromPath } from './runtime-identity.js';

describe('inferRuntimeIdentityFromPath', () => {
  test('detects development checkout from Python_Dev path', () => {
    const result = inferRuntimeIdentityFromPath('/Users/keespronk/Python_Dev/dexter-telegram');
    expect(result).toEqual({
      name: 'dev',
      role: 'development',
      repoPath: '/Users/keespronk/Python_Dev/dexter-telegram',
      source: 'path',
    });
  });

  test('detects production checkout from Python path', () => {
    const result = inferRuntimeIdentityFromPath('/Users/keespronk/Python/dexter-telegram');
    expect(result).toEqual({
      name: 'prod',
      role: 'production',
      repoPath: '/Users/keespronk/Python/dexter-telegram',
      source: 'path',
    });
  });
});

describe('getRuntimeIdentity', () => {
  test('prefers env overrides over path inference', () => {
    process.env.DEXTER_RUNTIME_NAME = 'paper-prod';
    process.env.DEXTER_RUNTIME_ROLE = 'production';
    process.env.DEXTER_RUNTIME_NOTES = 'launchd service';

    const result = getRuntimeIdentity('/Users/keespronk/Python_Dev/dexter-telegram');
    expect(result).toEqual({
      name: 'paper-prod',
      role: 'production',
      repoPath: '/Users/keespronk/Python_Dev/dexter-telegram',
      source: 'env',
      notes: 'launchd service',
    });

    delete process.env.DEXTER_RUNTIME_NAME;
    delete process.env.DEXTER_RUNTIME_ROLE;
    delete process.env.DEXTER_RUNTIME_NOTES;
  });
});
