import { describe, expect, test } from 'bun:test';
import {
  buildVoiceIntentCommand,
  parseVoiceIntentCliOutput,
  resolveVoiceIntentConfig,
  voiceIntentToDexterText,
} from './voice-intent.js';

describe('telegram voice intent adapter', () => {
  test('builds a Python CLI command against the Algo checkout', () => {
    const config = resolveVoiceIntentConfig({
      env: {
        ALGOTRADER_REPO_ROOT: '/repo/algo',
        DEXTER_VOICE_INTENT_PYTHON: '/venv/bin/python',
      },
      cwd: '/repo/algo/dexter-telegram',
    });

    const command = buildVoiceIntentCommand('/tmp/note.ogg', config);

    expect(command.cwd).toBe('/repo/algo');
    expect(command.file).toBe('/venv/bin/python');
    expect(command.args).toEqual(['-m', 'telegram.voice_intent', '--audio-file', '/tmp/note.ogg']);
  });

  test('defaults to the parent Algo checkout and python3', () => {
    const config = resolveVoiceIntentConfig({
      env: {},
      cwd: '/Users/me/Python_Dev/dexter-telegram',
    });

    expect(config.repoRoot).toBe('/Users/me/Python_Dev');
    expect(config.pythonBin).toBe('python3');
  });

  test('turns shared LONG voice intent into a natural Dexter trade request', () => {
    const text = voiceIntentToDexterText({
      ok: true,
      command: { command: 'L', ticker: 'AAPL', amount_usd: 5000 },
    });

    expect(text).toBe('Prepare a long trade request for AAPL for 5000 USD.');
  });

  test('turns shared chart voice intent into a natural Dexter question', () => {
    const text = voiceIntentToDexterText({
      ok: true,
      command: { command: 'C', ticker: 'NVDA' },
    });

    expect(text).toBe('Show me the chart for NVDA.');
  });

  test('preserves shared free-form Dexter questions', () => {
    const text = voiceIntentToDexterText({
      ok: true,
      command: { command: '?', query_text: 'What is the current market regime?' },
    });

    expect(text).toBe('What is the current market regime?');
  });

  test('parses structured CLI failure output for diagnostics', () => {
    const result = parseVoiceIntentCliOutput('{"ok": false, "error": "voice_intent_unavailable_or_unparsed"}');

    expect(result).toEqual({ ok: false, error: 'voice_intent_unavailable_or_unparsed' });
    expect(voiceIntentToDexterText(result)).toBeNull();
  });

  test('rejects non-object CLI output', () => {
    expect(parseVoiceIntentCliOutput('"not a result"')).toBeNull();
    expect(parseVoiceIntentCliOutput('{"command": {"command": "L"}}')).toBeNull();
  });
});
