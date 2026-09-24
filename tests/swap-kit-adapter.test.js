/**
 * swap-kit-adapter.test.js
 * Tests for SwapKitAdapter — App Kit-style interface over LI.FI proxy
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../shared/SwapKitAdapter.js'), 'utf8');

function loadAdapter(opts = {}) {
  const w = {
    fetch: opts.fetch || vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    console: { warn: () => {}, error: () => {}, log: () => {} },
    ...opts,
  };
  new Function('window', src)(w);
  return w.SwapKitAdapter;
}

describe('SwapKitAdapter', () => {
  describe('exports', () => {
    it('exposes required methods', () => {
      const kit = loadAdapter();
      expect(typeof kit.estimateSwap).toBe('function');
      expect(typeof kit.waitForSwap).toBe('function');
      expect(typeof kit.getSwapStatus).toBe('function');
      expect(typeof kit.chainIdToKitName).toBe('function');
      expect(typeof kit.isArcUsdcNativePair).toBe('function');
    });

    it('exposes SUPPORTED_CHAINS map', () => {
      const kit = loadAdapter();
      expect(kit.SUPPORTED_CHAINS).toBeDefined();
      expect(kit.SUPPORTED_CHAINS[5042]).toBe('Arc');
      expect(kit.SUPPORTED_CHAINS[1]).toBe('Ethereum');
      expect(kit.SUPPORTED_CHAINS[8453]).toBe('Base');
    });
  });

  describe('chainIdToKitName', () => {
    it('maps Arc chainId to Arc', () => {
      const kit = loadAdapter();
      expect(kit.chainIdToKitName(5042)).toBe('Arc');
    });
    it('maps Ethereum chainId to Ethereum', () => {
      const kit = loadAdapter();
      expect(kit.chainIdToKitName(1)).toBe('Ethereum');
    });
    it('maps Base chainId to Base', () => {
      const kit = loadAdapter();
      expect(kit.chainIdToKitName(8453)).toBe('Base');
    });
    it('returns null for unknown chainId', () => {
      const kit = loadAdapter();
      expect(kit.chainIdToKitName(99999)).toBeNull();
    });
  });

  describe('isArcUsdcNativePair', () => {
    it('blocks USDC ↔ NATIVE on Arc', () => {
      const kit = loadAdapter();
      expect(kit.isArcUsdcNativePair(5042, 'USDC', 'NATIVE')).toBe(true);
      expect(kit.isArcUsdcNativePair(5042, 'NATIVE', 'USDC')).toBe(true);
    });
    it('does not block USDC ↔ EURC on Arc', () => {
      const kit = loadAdapter();
      expect(kit.isArcUsdcNativePair(5042, 'USDC', 'EURC')).toBe(false);
    });
    it('does not block USDC ↔ NATIVE on non-Arc chain', () => {
      const kit = loadAdapter();
      expect(kit.isArcUsdcNativePair(1, 'USDC', 'NATIVE')).toBe(false);
    });
    it('blocks case-insensitive', () => {
      const kit = loadAdapter();
      expect(kit.isArcUsdcNativePair(5042, 'usdc', 'native')).toBe(true);
    });
  });

  describe('estimateSwap', () => {
    it('rejects missing fromChainId', async () => {
      const kit = loadAdapter();
      const r = await kit.estimateSwap({ toChainId: 8453, tokenIn: 'USDC', tokenOut: 'USDC', amountIn: '1000000' });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/fromChainId/i);
    });
    it('rejects missing toChainId', async () => {
      const kit = loadAdapter();
      const r = await kit.estimateSwap({ fromChainId: 5042, tokenIn: 'USDC', tokenOut: 'USDC', amountIn: '1000000' });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/toChainId/i);
    });
    it('rejects missing tokenIn', async () => {
      const kit = loadAdapter();
      const r = await kit.estimateSwap({ fromChainId: 5042, toChainId: 8453, tokenOut: 'USDC', amountIn: '1000000' });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/tokenIn/i);
    });
    it('rejects Arc USDC↔NATIVE pair', async () => {
      const kit = loadAdapter();
      const r = await kit.estimateSwap({ fromChainId: 5042, toChainId: 5042, tokenIn: 'USDC', tokenOut: 'NATIVE', amountIn: '1000000' });
      expect(r.ok).toBe(false);
      // Reason code for USDC↔NATIVE no-op on Arc
      expect(r.reason).toMatch(/ARC_USDC_NATIVE_NOOP|same.asset/i);
    });
    it('calls /api/lifi/quote for cross-chain', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          estimate: { toAmount: '900000', toAmountMin: '891000', executionDuration: 120 },
          action: { fromChainId: 5042, toChainId: 8453, fromToken: { address: '0xabc' }, toToken: { address: '0xdef' } },
          transactionRequest: { to: '0xrouter', data: '0xdata', value: '0x0' },
          tool: 'lifi',
        }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.estimateSwap({
        fromChainId: 5042, toChainId: 8453,
        tokenIn: '0xabc', tokenOut: '0xdef',
        amountIn: '1000000', recipient: '0xwallet',
      });
      expect(r.ok).toBe(true);
      expect(r.expectedOutRaw).toBe(900000n);
      expect(mockFetch).toHaveBeenCalled();
      const url = mockFetch.mock.calls[0][0];
      expect(url).toMatch(/lifi.*quote|api.*lifi/i);
    });
    it('returns ok:false on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'Server error' }) });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.estimateSwap({ fromChainId: 5042, toChainId: 8453, tokenIn: '0xabc', tokenOut: '0xdef', amountIn: '1000000' });
      expect(r.ok).toBe(false);
    });
    it('returns ok:false on network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.estimateSwap({ fromChainId: 5042, toChainId: 8453, tokenIn: '0xabc', tokenOut: '0xdef', amountIn: '1000000' });
      expect(r.ok).toBe(false);
    });
  });

  describe('getSwapStatus', () => {
    it('returns PENDING when API returns PENDING', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'PENDING', substatus: 'WAIT_SOURCE_CONFIRMATIONS' }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.getSwapStatus('0xhash123', { fromChainId: 5042, toChainId: 8453 });
      expect(r.status).toBe('PENDING');
    });
    it('returns DONE when API returns DONE', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'DONE', substatus: 'COMPLETED' }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.getSwapStatus('0xhash123', { fromChainId: 5042, toChainId: 8453 });
      expect(r.status).toBe('DONE');
    });
    it('returns FAILED on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.getSwapStatus('0xhash123', { fromChainId: 5042, toChainId: 8453 });
      expect(r.status).toBe('FAILED');
    });
  });

  describe('waitForSwap', () => {
    const noSleep = () => Promise.resolve(); // skip real delays in tests
    it('resolves DONE quickly when status is immediately DONE', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'DONE' }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.waitForSwap('0xhash', {
        fromChainId: 5042, toChainId: 8453,
        maxWaitMs: 5000, pollIntervalMs: 0, _sleepFn: noSleep,
      });
      expect(r.status).toBe('DONE');
    });
    it('resolves FAILED when status is FAILED', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'FAILED' }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      const r = await kit.waitForSwap('0xhash', {
        fromChainId: 5042, toChainId: 8453,
        maxWaitMs: 5000, pollIntervalMs: 0, _sleepFn: noSleep,
      });
      expect(r.status).toBe('FAILED');
    });
    it('returns TIMEOUT when maxWaitMs exceeded', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'PENDING' }),
      });
      const kit = loadAdapter({ fetch: mockFetch });
      // _nowFn always returns a value past the deadline so the loop exits immediately
      const pastDeadline = () => Date.now() + 99999;
      const r = await kit.waitForSwap('0xhash', {
        fromChainId: 5042, toChainId: 8453,
        maxWaitMs: 5000, pollIntervalMs: 0, _sleepFn: noSleep, _nowFn: pastDeadline,
      });
      expect(r.status).toBe('TIMEOUT');
    });
  });

  describe('Arc Mainnet alignment', () => {
    it('Arc chain ID is 5042', () => {
      const kit = loadAdapter();
      expect(kit.SUPPORTED_CHAINS[5042]).toBe('Arc');
    });
    it('no testnet chain IDs in SUPPORTED_CHAINS', () => {
      const kit = loadAdapter();
      expect(kit.SUPPORTED_CHAINS[5042002]).toBeUndefined();
    });
    it('USDC address for Arc is real mainnet address', () => {
      const kit = loadAdapter();
      expect(kit.ARC_USDC_ADDRESS).toMatch(/^0x3c499c/i);
    });
  });
});
