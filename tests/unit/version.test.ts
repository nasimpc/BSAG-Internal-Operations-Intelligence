import { describe, expect, it } from 'vitest';
import { SERVER_INFO } from '../../src/version.js';

describe('SERVER_INFO', () => {
  it('publishes a stable MCP identity', () => {
    expect(SERVER_INFO).toEqual({
      name: 'bsag-public-operations-briefing',
      version: '0.1.0',
    });
  });
});
