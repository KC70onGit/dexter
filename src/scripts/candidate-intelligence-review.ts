#!/usr/bin/env bun
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { callLlm, DEFAULT_MODEL } from '../model/llm.js';

type ReviewRequest = {
  ticker?: string;
  side?: string;
  prompt?: string;
};

type CliOptions = {
  input: string;
  output: string;
  model?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' && next) {
      options.input = next;
      i += 1;
    } else if (arg === '--output' && next) {
      options.output = next;
      i += 1;
    } else if (arg === '--model' && next) {
      options.model = next;
      i += 1;
    }
  }
  if (!options.input || !options.output) {
    throw new Error('Usage: bun src/scripts/candidate-intelligence-review.ts --input request.json --output response.json [--model MODEL]');
  }
  return options as CliOptions;
}

function textFromResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    return JSON.stringify(content);
  }
  return String(response ?? '');
}

async function reviewOne(request: ReviewRequest, model: string) {
  const ticker = String(request.ticker || '').toUpperCase();
  try {
    if (!request.prompt) {
      throw new Error('Missing review prompt.');
    }
    const { response, usage } = await callLlm(request.prompt, {
      model,
      systemPrompt: [
        'You are Dexter running a Candidate Intelligence validation pass.',
        'Use only the supplied evidence.',
        'Return only the requested JSON object.',
        'Do not call tools, browse, fetch data, or invent missing values.',
      ].join('\n'),
    });
    return {
      ticker,
      side: request.side || 'unclear',
      status: 'reviewed',
      raw_response: textFromResponse(response),
      token_usage: usage ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ticker,
      side: request.side || 'unclear',
      status: 'error',
      raw_response: null,
      token_usage: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = options.model || DEFAULT_MODEL;
  const input = JSON.parse(await readFile(options.input, 'utf-8'));
  const requests = Array.isArray(input.requests) ? input.requests as ReviewRequest[] : [];
  const reviews = [];
  for (const request of requests) {
    reviews.push(await reviewOne(request, model));
  }
  await writeFile(
    options.output,
    JSON.stringify({
      metadata: {
        schema_version: 'dexter_candidate_intelligence_review_batch_v1',
        model,
        request_count: requests.length,
      },
      reviews,
    }, null, 2),
    'utf-8',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
