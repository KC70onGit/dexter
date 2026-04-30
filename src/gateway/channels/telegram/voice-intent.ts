import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type SharedVoiceCommand = {
  command: string;
  ticker?: string | null;
  amount_usd?: number | null;
  query_text?: string | null;
};

export type SharedVoiceIntentResult = {
  ok: boolean;
  command?: SharedVoiceCommand;
  error?: string;
};

export type VoiceIntentConfig = {
  repoRoot: string;
  pythonBin: string;
};

export type VoiceIntentCommand = {
  file: string;
  args: string[];
  cwd: string;
};

type ConfigInput = {
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export function resolveVoiceIntentConfig(input: ConfigInput = {}): VoiceIntentConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  return {
    repoRoot: env.ALGOTRADER_REPO_ROOT || path.resolve(cwd, '..'),
    pythonBin: env.DEXTER_VOICE_INTENT_PYTHON || 'python3',
  };
}

export function buildVoiceIntentCommand(
  audioFile: string,
  config: VoiceIntentConfig = resolveVoiceIntentConfig(),
): VoiceIntentCommand {
  return {
    file: config.pythonBin,
    args: ['-m', 'telegram.voice_intent', '--audio-file', audioFile],
    cwd: config.repoRoot,
  };
}

export async function parseVoiceIntentFile(
  audioFile: string,
  config: VoiceIntentConfig = resolveVoiceIntentConfig(),
): Promise<SharedVoiceIntentResult | null> {
  const command = buildVoiceIntentCommand(audioFile, config);
  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      cwd: command.cwd,
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });
    return parseVoiceIntentCliOutput(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    const parsed = parseVoiceIntentCliOutput(stdout);
    if (parsed) return parsed;

    console.error('[telegram] Failed to parse shared voice intent:', error);
    return null;
  }
}

export function parseVoiceIntentCliOutput(stdout: unknown): SharedVoiceIntentResult | null {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!isVoiceIntentResult(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isVoiceIntentResult(value: unknown): value is SharedVoiceIntentResult {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

export function voiceIntentToDexterText(result: SharedVoiceIntentResult | null | undefined): string | null {
  if (!result?.ok || !result.command) return null;

  const command = result.command.command.toUpperCase();
  const ticker = normalizeTicker(result.command.ticker);
  const amount = formatUsd(result.command.amount_usd);
  const queryText = result.command.query_text?.trim();

  if (command === '?' && queryText) return queryText;

  switch (command) {
    case 'L':
      return ticker ? `Prepare a long trade request for ${ticker}${amount ? ` for ${amount}` : ''}.` : null;
    case 'S':
      return ticker ? `Prepare a short trade request for ${ticker}${amount ? ` for ${amount}` : ''}.` : null;
    case 'LA':
      return ticker ? `Prepare an add-to-long trade request for ${ticker}${amount ? ` for ${amount}` : ''}.` : null;
    case 'SA':
      return ticker ? `Prepare an add-to-short trade request for ${ticker}${amount ? ` for ${amount}` : ''}.` : null;
    case 'C':
      return ticker ? `Show me the chart for ${ticker}.` : 'Show me the market chart view.';
    case 'N':
      return ticker ? `Show me the latest news for ${ticker}.` : 'Show me the latest market-moving news.';
    case 'PM':
      return 'Show my current positions.';
    case 'TT':
      return "Show today's trades.";
    case 'H':
      return 'What is the current AlgoTrader system health?';
    case 'TA':
      return 'Show the top alerts.';
    case 'E':
      return 'Show the AlgoTrader engine status.';
    case 'CP':
      return 'Start the cancel pending orders flow.';
    case 'CL':
      return 'Start the close long positions flow.';
    case 'CS':
      return 'Start the close short positions flow.';
    case 'CA':
      return 'Start the close all positions flow.';
    case 'CANCEL':
      return 'Cancel the current Telegram trade flow.';
    default:
      return queryText || null;
  }
}

function normalizeTicker(ticker: string | null | undefined): string | null {
  const clean = ticker?.trim().toUpperCase();
  return clean || null;
}

function formatUsd(amount: number | null | undefined): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded} USD`;
}
