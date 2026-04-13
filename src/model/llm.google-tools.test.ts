import { describe, expect, it } from 'bun:test';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { createAlgoTraderRequestTradeTool } from '../tools/algotrader/request-trade.js';
import { cronTool } from '../tools/cron/cron-tool.js';

function stripUnsupportedGoogleSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedGoogleSchemaKeywords);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const cleaned: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
      continue;
    }
    if (key === 'const') {
      cleaned.enum = [child];
      continue;
    }
    cleaned[key] = stripUnsupportedGoogleSchemaKeywords(child);
  }

  return cleaned;
}

describe('google tool schema sanitizing', () => {
  it('removes exclusiveMinimum from generated tool schemas', () => {
    const tool = createAlgoTraderRequestTradeTool();
    const openAiTool = convertToOpenAITool(tool);
    const sanitized = stripUnsupportedGoogleSchemaKeywords(openAiTool.function.parameters);
    const json = JSON.stringify(sanitized);

    expect(JSON.stringify(openAiTool.function.parameters)).toContain('exclusiveMinimum');
    expect(json).not.toContain('exclusiveMinimum');
  });

  it('rewrites const discriminators into enum values for Gemini compatibility', () => {
    const openAiTool = convertToOpenAITool(cronTool);
    const sanitized = stripUnsupportedGoogleSchemaKeywords(openAiTool.function.parameters);
    const json = JSON.stringify(sanitized);

    expect(JSON.stringify(openAiTool.function.parameters)).toContain('\"const\":\"at\"');
    expect(json).not.toContain('\"const\"');
    expect(json).toContain('\"enum\":[\"at\"]');
  });
});
