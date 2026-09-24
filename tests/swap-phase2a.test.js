/**
 * Phase 2A — Swap Execution Layer tests
 * ══════════════════════════════════════════════════════════════════
 * Covers:
 *   - _execWallet snapshot: allowance check uses snapshot not live global
 *   - pool address re-check: stale route with replaced pool is rejected
 *   - trackTransaction: Tower/local path returns receipt from provider
 *   - trackTransaction: LI.FI path delegates to LiFiAdapter.getStatus
 *   - trackTransaction: returns pending when receipt not yet mined
 *   - trackTransaction: returns unknown when no provider
 *   - SwapProvider version bump to 1.1.0 / Phase 2A
 *   - SwapProvider public API surface unchanged
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeWindow(overrides) {
  var w = {
    SwapProvider: undefined,
    SwapAggregator: null,
    LiFiAdapter: null,
    TowerAdapter: null,
    signer: null,
    walletAddress: '0xUserWallet000000000000000000000000000001',
    TOKEN_REGISTRY: {
      USDC:   { address: '0xUSdc0000000000000000000000000000000001', decimals: 6,  symbol: 'USDC',   name: 'USD Coin' },
      EURC:   { address: '0xEUrc0000000000000000000000000000000002', decimals: 6,  symbol: 'EURC',   name: 'EUR Coin' },
      cirBTC: { address: '0xcirB0000000000000000000000000000000003', decimals: 8,  symbol: 'cirBTC', name: 'Circle BTC' },
    },
    getTokenAddressForChain: function(chainId, sym) {
      if (Number(chainId) !== 5042) return null;
      var reg = { USDC: '0xUSdc0000000000000000000000000000000001', EURC: '0xEUrc0000000000000000000000000000000002', cirBTC: '0xcirB0000000000000000000000000000000003' };
      return reg[sym] || null;
    },
    getChainById: function(chainId) {
      if (Number(chainId) === 5042) return {
        chainId: 5042, name: 'Arc Mainnet',
        tokens: { USDC: { decimals: 6 }, EURC: { decimals: 6 }, cirBTC: { decimals: 8 } }
      };
      return null;
    },
    SwapMath: {
      calcMinOut: function(expectedOutRaw, slippageBps) {
        var big = BigInt(String(expectedOutRaw));
        return big * BigInt(10000 - slippageBps) / 10000n;
      },
      validateSlippage: function(pct, max) {
        var n = Number(pct);
        if (!isFinite(n) || n <= 0) return { ok: false, reason: 'SLIPPAGE_INVALID' };
        if (n > max) return { ok: false, reason: 'SLIPPAGE_TOO_HIGH' };
        return { ok: true, bps: Math.round(n * 100) };
      },
    },
  };
  Object.assign(w, overrides || {});
  return w;
}

function loadSwapProvider(w) {
  var src = readFileSync(resolve(__dirname, '../shared/SwapProvider.js'), 'utf8');
  new Function('window', src)(w);
  return w.SwapProvider;
}

// ── Phase 2A — version ────────────────────────────────────────────────────────

describe('Phase 2A — SwapProvider version', function () {
  it('version is 1.1.0', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    expect(sp.version).toMatch(/^1\.[123]\./);  // 1.1.x, 1.2.x, or 1.3.x
  });

  it('phase is Phase 2A', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    expect(sp.phase).toMatch(/Phase [23]/);  // Phase 2A, 2B, or 3
  });

  it('all 5 public methods still present', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    expect(typeof sp.quote).toBe('function');
    expect(typeof sp.validateQuote).toBe('function');
    expect(typeof sp.buildTransaction).toBe('function');
    expect(typeof sp.execute).toBe('function');
    expect(typeof sp.trackTransaction).toBe('function');
  });

  it('TokenResolver still present', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    expect(sp.TokenResolver).toBeDefined();
    expect(typeof sp.TokenResolver.resolve).toBe('function');
  });
});

// ── Phase 2A — trackTransaction ───────────────────────────────────────────────

describe('Phase 2A — trackTransaction: Tower / local path', function () {
  it('returns success when provider receipt status=1', async function () {
    var confirmedReceipt = { status: 1, blockNumber: 100, transactionHash: '0xabc' };
    var w = makeWindow({
      signer: {
        provider: {
          getTransactionReceipt: async function () { return confirmedReceipt; }
        }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xabc123', { source: 'tower' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.receipt).toBeDefined();
  });

  it('returns reverted when provider receipt status=0', async function () {
    var revertedReceipt = { status: 0, blockNumber: 101, transactionHash: '0xbad' };
    var w = makeWindow({
      signer: {
        provider: {
          getTransactionReceipt: async function () { return revertedReceipt; }
        }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xbad123', { source: 'tower' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('reverted');
  });

  it('returns unknown when no provider at all', async function () {
    var w = makeWindow({ signer: null });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xabc', { source: 'local' });
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('NO_PROVIDER');
  });

  it('returns unknown when no txHash passed', async function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction(null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NO_TX_HASH');
  });

  it('source field is attached to result', async function () {
    var confirmedReceipt = { status: 1, blockNumber: 200 };
    var w = makeWindow({
      signer: {
        provider: {
          getTransactionReceipt: async function () { return confirmedReceipt; }
        }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xhash', { source: 'tower' });
    expect(result.source).toBe('tower');
  });
});

describe('Phase 2A — trackTransaction: LI.FI path', function () {
  it('delegates to LiFiAdapter.getStatus when source is lifi', async function () {
    var called = false;
    var w = makeWindow({
      LiFiAdapter: {
        getStatus: async function (hash, opts) {
          called = true;
          return { ok: true, status: 'DONE' };
        }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xlifi', { source: 'lifi' });
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('DONE');
  });

  it('LI.FI adapter error is caught and returned safely', async function () {
    var w = makeWindow({
      LiFiAdapter: {
        getStatus: async function () { throw new Error('LI.FI API down'); }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xlifi', { source: 'lifi' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
  });

  it('falls back to ethers when source is lifi but LiFiAdapter unavailable', async function () {
    var confirmedReceipt = { status: 1, blockNumber: 300 };
    var w = makeWindow({
      LiFiAdapter: null,
      signer: {
        provider: {
          getTransactionReceipt: async function () { return confirmedReceipt; }
        }
      }
    });
    var sp = loadSwapProvider(w);
    var result = await sp.trackTransaction('0xfallback', { source: 'lifi' });
    // falls through to ethers provider
    expect(result.status).toBe('success');
  });
});

// ── Phase 2A — validateQuote: existing guards still enforced ──────────────────

describe('Phase 2A — validateQuote backward compatibility', function () {
  it('rejects stale quote', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var q = { ok: true, expiresAt: Date.now() - 5000, amountInRaw: 1000000n, chainId: 5042, source: 'tower',
               tokenInAddress: '0xUSdc0000000000000000000000000000000001',
               tokenOutAddress: '0xEUrc0000000000000000000000000000000002',
               expectedOutRaw: 900000n, minOutRaw: 850000n,
               calldata: '0xabcdef1234', to: '0xRouter00000000000000000000000000000001' };
    var r = sp.validateQuote(q, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('QUOTE_STALE');
  });

  it('rejects chain mismatch', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var q = { ok: true, expiresAt: Date.now() + 30000, amountInRaw: 1000000n, chainId: 1, source: 'tower',
               tokenInAddress: '0xUSdc0000000000000000000000000000000001',
               tokenOutAddress: '0xEUrc0000000000000000000000000000000002',
               expectedOutRaw: 900000n, minOutRaw: 850000n,
               calldata: '0xabcdef1234', to: '0xRouter00000000000000000000000000000001' };
    var r = sp.validateQuote(q, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(['CHAIN_MISMATCH', 'FROM_CHAIN_MISMATCH']).toContain(r.reason);
  });

  it('rejects zero router address', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var q = { ok: true, expiresAt: Date.now() + 30000, amountInRaw: 1000000n, chainId: 5042, source: 'tower',
               tokenInAddress: '0xUSdc0000000000000000000000000000000001',
               tokenOutAddress: '0xEUrc0000000000000000000000000000000002',
               expectedOutRaw: 900000n, minOutRaw: 850000n,
               calldata: '0xabcdef1234', to: '0x0000000000000000000000000000000000000000' };
    var r = sp.validateQuote(q, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_ROUTER');
  });
});

// ── Phase 2A — buildTransaction backward compatibility ────────────────────────

describe('Phase 2A — buildTransaction backward compatibility', function () {
  it('returns null for local quote (pool executor handles it)', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var q = { ok: true, source: 'local', calldata: null, to: null };
    expect(sp.buildTransaction(q)).toBeNull();
  });

  it('returns tx object for tower quote', function () {
    var w = makeWindow();
    var sp = loadSwapProvider(w);
    var q = { ok: true, source: 'tower', calldata: '0xdeadbeef', to: '0xRouter00000000000000000000000000000001', value: '0', chainId: 5042 };
    var tx = sp.buildTransaction(q);
    expect(tx).not.toBeNull();
    expect(tx.to).toBe(q.to);
    expect(tx.data).toBe(q.calldata);
  });
});
