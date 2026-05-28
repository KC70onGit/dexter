import { describe, expect, test } from 'bun:test';
import { buildCompactToolDescriptions, getToolRegistry } from './registry.js';

describe('tool registry routing hints', () => {
  test('registers Trade Ideas Hub read tools', () => {
    const names = getToolRegistry('test-model').map((tool) => tool.name);

    expect(names).toContain('trade_ideas_integrated_universe');
    expect(names).toContain('trade_ideas_quality_assurance');
    expect(names).toContain('trade_ideas_opening_session');
    expect(names).toContain('trade_ideas_watchlists');
  });

  test('keeps market-regime routing explicit instead of broad market routing', () => {
    const descriptions = buildCompactToolDescriptions('test-model');

    expect(descriptions).toContain('Use for explicit /MR');
    expect(descriptions).not.toContain('market environment questions');
    expect(descriptions).not.toContain('general market health');
  });
});
