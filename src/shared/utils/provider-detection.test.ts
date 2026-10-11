/**
 * Tests for provider detection utilities
 */

import { describe, it, expect } from 'vitest';
import { detectProvider } from './provider-detection';

describe('provider-detection', () => {
  describe('detectProvider', () => {
    describe('Anthropic provider', () => {
      it('should detect Anthropic from api.anthropic.com', () => {
        const result = detectProvider('https://api.anthropic.com');
        expect(result).toBe('anthropic');
      });

      it('should detect Anthropic with path', () => {
        const result = detectProvider('https://api.anthropic.com/v1/messages');
        expect(result).toBe('anthropic');
      });

      it('should handle subdomain of Anthropic correctly', () => {
        const result = detectProvider('https://sub.api.anthropic.com');
        expect(result).toBe('anthropic');
      });
    });

    describe('z.ai provider', () => {
      it('should detect z.ai from api.z.ai', () => {
        const result = detectProvider('https://api.z.ai/api/anthropic');
        expect(result).toBe('zai');
      });

      it('should detect z.ai from z.ai domain', () => {
        const result = detectProvider('https://z.ai/api/anthropic');
        expect(result).toBe('zai');
      });
    });

    describe('ZHIPU provider', () => {
      it('should detect ZHIPU from open.bigmodel.cn', () => {
        const result = detectProvider('https://open.bigmodel.cn/api/anthropic');
        expect(result).toBe('zhipu');
      });

      it('should detect ZHIPU from dev.bigmodel.cn', () => {
        const result = detectProvider('https://dev.bigmodel.cn/api/paas/v4');
        expect(result).toBe('zhipu');
      });

      it('should detect ZHIPU from bigmodel.cn', () => {
        const result = detectProvider('https://bigmodel.cn/api/paas/v4');
        expect(result).toBe('zhipu');
      });
    });

    describe('Unknown provider', () => {
      it('should return unknown for unrecognized domain', () => {
        const result = detectProvider('https://unknown.com/api');
        expect(result).toBe('unknown');
      });

      it('should handle invalid URL gracefully', () => {
        const result = detectProvider('not-a-url');
        expect(result).toBe('unknown');
      });
    });
  });

});
