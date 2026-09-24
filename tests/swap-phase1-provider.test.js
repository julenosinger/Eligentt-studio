/**
 * Phase 1 — SwapProvider Tests
 * ════════════════════════════
 * Covers all Phase 1 requirements:
 *   - TokenResolver: symbol resolution, address resolution, decimals
 *   - validateQuote: stale, amount mismatch, chain mismatch, wallet chain mismatch,
 *                    token address mismatch, minOut=0, expectedOut=0, invalid router
 *   - buildTransaction: external quotes, local quotes
 *   - quote(): invalid chain, invalid amount, invalid slippage, aggregator unavailable
 *   - Security: no minOut=0 executes, no placeholder router, chain isolation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load SwapProvider in a sandboxed window context ───────────────────

function makeWindow(overrides) {
  var w = Object.assign({
    // Token registry (Arc Mainnet)
    TOKEN_REGISTRY: {
      USDC:   { sym: 'USDC',   address: '0x3600000000000000000000000000000000000000', decimals: 6,  name: 'USD Coin' },
      EURC:   { sym: 'EURC',   address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6,  name: 'Euro Coin' },
      cirBTC: { sym: 'cirBTC', address: '0x84886b37f1ee4b21b5b1c2ffe1f10d68c9b21e94', decimals: 8,  name: 'Circle BTC' },
    },
    // Multi-chain resolver mock
    getTokenAddressForChain: function(chainId, sym) {
      var CHAIN_TOKENS = {
        5042: {
          USDC:   '0x3600000000000000000000000000000000000000',
          EURC:   '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
          cirBTC: '0x84886b37f1ee4b21b5b1c2ffe1f10d68c9b21e94',
        },
        1: {
          USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
        },
        8453: {
          USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          WETH: '0x4200000000000000000000000000000000000006',
        },
      };
      return (CHAIN_TOKENS[Number(chainId)] || {})[sym] || null;
    },
    getChainById: function(chainId) {
      var CHAINS = {
        5042: { tokens: {
          USDC:   { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
          EURC:   { address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6 },
          cirBTC: { address: '0x84886b37f1ee4b21b5b1c2ffe1f10d68c9b21e94', decimals: 8 },
        }},
        1: { tokens: {
          USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
          WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
        }},
        8453: { tokens: {
          USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
        }},
      };
      return CHAINS[Number(chainId)] || null;
    },
    SwapAggregator: null,   // overridden per test
    SwapMath: {
      calcMinOut: function(expectedOutRaw, slippageBps) {
        if (!expectedOutRaw || expectedOutRaw <= 0n) return 0n;
        var slip = BigInt(Math.floor(Number(slippageBps) || 0));
        return (expectedOutRaw * (10000n - slip)) / 10000n;
      },
      formatUnits: function(raw, d) {
        var s = String(raw).padStart(Number(d) + 1, '0');
        return s.slice(0, s.length - d) + '.' + s.slice(s.length - d).replace(/0+$/, '');
      },
    },
    LiFiAdapter: null,
    TowerAdapter: null,
  }, overrides || {});
  return w;
}

function loadProvider(w) {
  var src = fs.readFileSync(
    path.resolve(__dirname, '..', 'shared', 'SwapProvider.js'), 'utf8'
  );
  // eslint-disable-next-line no-new-func
  new Function('window', src)(w);
  return w.SwapProvider;
}

// ─── TokenResolver ────────────────────────────────────────────────────

describe('Phase 1 — TokenResolver: resolve by symbol (Arc)', () => {
  var P;
  beforeEach(() => { P = loadProvider(makeWindow()); });

  it('resolves USDC on Arc (5042)', () => {
    var r = P.TokenResolver.resolve(5042, 'USDC');
    expect(r).not.toBeNull();
    expect(r.symbol).toBe('USDC');
    expect(r.address).toBe('0x3600000000000000000000000000000000000000');
    expect(r.decimals).toBe(6);
    expect(r.chainId).toBe(5042);
  });

  it('resolves EURC on Arc (5042)', () => {
    var r = P.TokenResolver.resolve(5042, 'EURC');
    expect(r).not.toBeNull();
    expect(r.address).toBe('0x89b50855aa3be2f677cd6303cec089b5f319d72a');
    expect(r.decimals).toBe(6);
  });

  it('resolves cirBTC on Arc (5042) with 8 decimals', () => {
    var r = P.TokenResolver.resolve(5042, 'cirBTC');
    expect(r).not.toBeNull();
    expect(r.decimals).toBe(8);
  });

  it('returns null for unknown symbol', () => {
    var r = P.TokenResolver.resolve(5042, 'FOOBAR');
    expect(r).toBeNull();
  });

  it('returns null for null symbol', () => {
    var r = P.TokenResolver.resolve(5042, null);
    expect(r).toBeNull();
  });

  it('returns null for null chainId', () => {
    var r = P.TokenResolver.resolve(null, 'USDC');
    expect(r).toBeNull();
  });
});

describe('Phase 1 — TokenResolver: resolve by symbol (multi-chain)', () => {
  var P;
  beforeEach(() => { P = loadProvider(makeWindow()); });

  it('resolves USDC on Ethereum (1)', () => {
    var r = P.TokenResolver.resolve(1, 'USDC');
    expect(r).not.toBeNull();
    expect(r.address).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(r.decimals).toBe(6);
    expect(r.chainId).toBe(1);
  });

  it('resolves WETH on Ethereum (1) with 18 decimals', () => {
    var r = P.TokenResolver.resolve(1, 'WETH');
    expect(r).not.toBeNull();
    expect(r.address).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(r.decimals).toBe(18);
  });

  it('resolves USDC on Base (8453)', () => {
    var r = P.TokenResolver.resolve(8453, 'USDC');
    expect(r).not.toBeNull();
    expect(r.address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('USDC address differs between Ethereum and Arc', () => {
    var onEth = P.TokenResolver.resolve(1, 'USDC');
    var onArc = P.TokenResolver.resolve(5042, 'USDC');
    expect(onEth.address).not.toBe(onArc.address);
  });

  it('resolves address input directly', () => {
    var addr = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    var r = P.TokenResolver.resolve(1, addr);
    expect(r).not.toBeNull();
    expect(r.address).toBe(addr);
  });
});

describe('Phase 1 — TokenResolver: decimals helper', () => {
  var P;
  beforeEach(() => { P = loadProvider(makeWindow()); });

  it('returns 6 for USDC on Arc', () => {
    expect(P.TokenResolver.decimals(5042, 'USDC')).toBe(6);
  });

  it('returns 8 for cirBTC on Arc', () => {
    expect(P.TokenResolver.decimals(5042, 'cirBTC')).toBe(8);
  });

  it('returns 18 for WETH on Ethereum', () => {
    expect(P.TokenResolver.decimals(1, 'WETH')).toBe(18);
  });

  it('returns null for unknown token', () => {
    expect(P.TokenResolver.decimals(5042, 'FOOBAR')).toBeNull();
  });
});

// ─── validateQuote ────────────────────────────────────────────────────

describe('Phase 1 — validateQuote: basic guards', () => {
  var P;
  var NOW;
  beforeEach(() => {
    P = loadProvider(makeWindow());
    NOW = Date.now();
  });

  function goodQuote(overrides) {
    return Object.assign({
      ok: true,
      source: 'tower',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      tokenInAddress:  '0x3600000000000000000000000000000000000000',
      tokenOutAddress: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
      amountInRaw: 100000000n,
      expectedOutRaw: 87000000n,
      minOutRaw: 86565000n,
      chainId: 5042,
      fromChainId: 5042,
      toChainId: 5042,
      expiresAt: NOW + 30000,
      calldata: '0xabcdef01',
      to: '0x1234567890abcdef1234567890abcdef12345678',
      spender: '0x1234567890abcdef1234567890abcdef12345678',
    }, overrides || {});
  }

  it('accepts a valid tower quote', () => {
    expect(P.validateQuote(goodQuote(), { fromChainId: 5042, toChainId: 5042 }).ok).toBe(true);
  });

  it('rejects null quote', () => {
    expect(P.validateQuote(null, {}).ok).toBe(false);
  });

  it('rejects quote with ok:false', () => {
    expect(P.validateQuote({ ok: false }, {}).ok).toBe(false);
  });

  it('rejects stale quote (expiresAt in past)', () => {
    var r = P.validateQuote(goodQuote({ expiresAt: NOW - 1 }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('QUOTE_STALE');
  });

  it('accepts quote without expiresAt (no TTL set)', () => {
    var q = goodQuote();
    delete q.expiresAt;
    expect(P.validateQuote(q, { fromChainId: 5042 }).ok).toBe(true);
  });
});

describe('Phase 1 — validateQuote: amount and chain mismatch', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  function goodQuote(overrides) {
    return Object.assign({
      ok: true, source: 'tower',
      amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 86565000n,
      chainId: 5042, fromChainId: 5042, toChainId: 5042,
      expiresAt: NOW + 30000,
      calldata: '0xabcdef01',
      to: '0x1234567890abcdef1234567890abcdef12345678',
    }, overrides || {});
  }

  it('rejects amount mismatch', () => {
    var r = P.validateQuote(goodQuote({ amountInRaw: 100000000n }), {
      amountInRaw: 200000000n, fromChainId: 5042,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('AMOUNT_MISMATCH');
  });

  it('accepts matching amount', () => {
    var r = P.validateQuote(goodQuote({ amountInRaw: 100000000n }), {
      amountInRaw: 100000000n, fromChainId: 5042,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects chain mismatch (quote on ETH, requested Arc)', () => {
    var r = P.validateQuote(goodQuote({ chainId: 1, fromChainId: 1 }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('FROM_CHAIN_MISMATCH');
  });

  it('rejects wallet chain mismatch', () => {
    var r = P.validateQuote(goodQuote(), {
      fromChainId: 5042, walletChainId: 1,   // wallet is on Ethereum, not Arc
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('WALLET_CHAIN_MISMATCH');
  });

  it('accepts correct wallet chain', () => {
    var r = P.validateQuote(goodQuote(), {
      fromChainId: 5042, walletChainId: 5042,
    });
    expect(r.ok).toBe(true);
  });
});

describe('Phase 1 — validateQuote: minOut and output guards', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  function goodQuote(overrides) {
    return Object.assign({
      ok: true, source: 'tower',
      amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 86565000n,
      chainId: 5042, fromChainId: 5042, expiresAt: NOW + 30000,
      calldata: '0xabcdef01',
      to: '0x1234567890abcdef1234567890abcdef12345678',
    }, overrides || {});
  }

  it('rejects minOutRaw = 0n', () => {
    var r = P.validateQuote(goodQuote({ minOutRaw: 0n }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MIN_OUT_INVALID');
  });

  it('rejects null minOutRaw', () => {
    var r = P.validateQuote(goodQuote({ minOutRaw: null }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MIN_OUT_INVALID');
  });

  it('rejects expectedOutRaw = 0n', () => {
    var r = P.validateQuote(goodQuote({ expectedOutRaw: 0n, minOutRaw: 0n }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
  });

  it('rejects minOut > expectedOut', () => {
    var r = P.validateQuote(goodQuote({ minOutRaw: 999999999n, expectedOutRaw: 87000000n }), {
      fromChainId: 5042,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MIN_OUT_EXCEEDS_EXPECTED');
  });
});

describe('Phase 1 — validateQuote: router and calldata guards', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  function goodQuote(overrides) {
    return Object.assign({
      ok: true, source: 'tower',
      amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 86565000n,
      chainId: 5042, fromChainId: 5042, expiresAt: NOW + 30000,
      calldata: '0xabcdef01',
      to: '0x1234567890abcdef1234567890abcdef12345678',
    }, overrides || {});
  }

  it('rejects zero address router', () => {
    var r = P.validateQuote(goodQuote({ to: '0x0000000000000000000000000000000000000000' }), {
      fromChainId: 5042,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_ROUTER');
  });

  it('rejects null router', () => {
    var r = P.validateQuote(goodQuote({ to: null }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_ROUTER');
  });

  it('rejects placeholder calldata', () => {
    var r = P.validateQuote(goodQuote({ calldata: '0x' }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_CALLDATA');
  });

  it('rejects empty calldata', () => {
    var r = P.validateQuote(goodQuote({ calldata: '' }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_CALLDATA');
  });

  it('rejects non-hex calldata', () => {
    var r = P.validateQuote(goodQuote({ calldata: 'not-hex' }), { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_CALLDATA');
  });

  it('accepts valid calldata and router', () => {
    var r = P.validateQuote(goodQuote(), { fromChainId: 5042 });
    expect(r.ok).toBe(true);
  });

  it('lifi source also requires calldata + valid router', () => {
    var q = goodQuote({ source: 'lifi', calldata: null, to: null });
    var r = P.validateQuote(q, { fromChainId: 5042 });
    expect(r.ok).toBe(false);
  });
});

// ─── buildTransaction ─────────────────────────────────────────────────

describe('Phase 1 — buildTransaction', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  it('builds tx from tower quote', () => {
    var q = {
      ok: true, source: 'tower',
      calldata: '0xaabbccdd',
      to: '0x1234567890abcdef1234567890abcdef12345678',
      value: '0',
      fromChainId: 5042,
    };
    var tx = P.buildTransaction(q);
    expect(tx).not.toBeNull();
    expect(tx.to).toBe(q.to);
    expect(tx.data).toBe(q.calldata);
    expect(tx.value).toBe('0');
    expect(tx.chainId).toBe(5042);
  });

  it('builds tx from lifi quote', () => {
    var q = {
      ok: true, source: 'lifi',
      calldata: '0xdeadbeef',
      to: '0xabcdef1234567890abcdef1234567890abcdef12',
      value: '1000',
      fromChainId: 1,
    };
    var tx = P.buildTransaction(q);
    expect(tx).not.toBeNull();
    expect(tx.value).toBe('1000');
    expect(tx.chainId).toBe(1);
  });

  it('returns null for local quote (pool executor handles this)', () => {
    var q = { ok: true, source: 'local' };
    expect(P.buildTransaction(q)).toBeNull();
  });

  it('returns null for failed quote', () => {
    expect(P.buildTransaction({ ok: false })).toBeNull();
  });

  it('returns null when calldata missing from external quote', () => {
    var q = { ok: true, source: 'tower', calldata: null, to: '0x1234567890abcdef1234567890abcdef12345678' };
    expect(P.buildTransaction(q)).toBeNull();
  });
});

// ─── quote() integration ──────────────────────────────────────────────

describe('Phase 1 — quote(): input validation guards', () => {
  var P;
  beforeEach(() => { P = loadProvider(makeWindow()); });

  it('rejects invalid fromChainId', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100000000n, fromChainId: 0, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_FROM_CHAIN');
  });

  it('rejects zero amountInRaw', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 0n, fromChainId: 5042, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_AMOUNT');
  });

  it('rejects negative amountInRaw', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: -1n, fromChainId: 5042, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_AMOUNT');
  });

  it('rejects slippage = 0', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_SLIPPAGE');
  });

  it('rejects slippage >= 10000 (100%)', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 10000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_SLIPPAGE');
  });

  it('rejects unknown tokenIn (unresolvable)', async () => {
    var r = await P.quote({ tokenIn: 'UNKNOWN', tokenOut: 'EURC', amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOKEN_ADDRESS_UNRESOLVABLE');
  });

  it('rejects unknown tokenOut (unresolvable)', async () => {
    var r = await P.quote({ tokenIn: 'USDC', tokenOut: 'UNKNOWN', amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TOKEN_ADDRESS_UNRESOLVABLE');
  });

  it('returns AGGREGATOR_UNAVAILABLE when SwapAggregator not set', async () => {
    var w = makeWindow({ SwapAggregator: null });
    var Pp = loadProvider(w);
    var r = await Pp.quote({ tokenIn: 'USDC', tokenOut: 'EURC', amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('AGGREGATOR_UNAVAILABLE');
  });
});

describe('Phase 1 — quote(): aggregator integration', () => {
  it('returns best executable quote from aggregator', async () => {
    var mockQuote = {
      ok: true, source: 'tower', executable: true,
      tokenIn: 'USDC', tokenOut: 'EURC',
      tokenInAddress: '0x3600000000000000000000000000000000000000',
      tokenOutAddress: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
      amountInRaw: 100000000n,
      expectedOutRaw: 87000000n,
      minOutRaw: 86565000n,
      chainId: 5042, fromChainId: 5042,
      expiresAt: Date.now() + 30000,
      calldata: '0xaabbccdd',
      to: '0x1234567890abcdef1234567890abcdef12345678',
    };
    var w = makeWindow({
      SwapAggregator: {
        getBestQuote: async function() {
          return {
            ok: true, executable: true,
            bestExecutable: mockQuote,
            quotes: [mockQuote],
          };
        },
      },
    });
    var Pp = loadProvider(w);
    var r = await Pp.quote({
      tokenIn: 'USDC', tokenOut: 'EURC',
      amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.quote.source).toBe('tower');
    expect(r.quote.expectedOutRaw).toBe(87000000n);
  });

  it('returns NO_EXECUTABLE_ROUTE when aggregator has no executable quote', async () => {
    var w = makeWindow({
      SwapAggregator: {
        getBestQuote: async function() {
          return { ok: false, executable: false, reason: 'NO_EXECUTABLE_ROUTE', quotes: [] };
        },
      },
    });
    var Pp = loadProvider(w);
    var r = await Pp.quote({
      tokenIn: 'USDC', tokenOut: 'EURC',
      amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_EXECUTABLE_ROUTE');
  });

  it('attaches resolved token metadata to quote', async () => {
    var mockQuote = {
      ok: true, source: 'lifi', executable: true,
      expectedOutRaw: 87000000n, minOutRaw: 86565000n,
      chainId: 5042, fromChainId: 5042,
      expiresAt: Date.now() + 30000,
      calldata: '0xaabbcc', to: '0x1234567890abcdef1234567890abcdef12345678',
    };
    var w = makeWindow({
      SwapAggregator: {
        getBestQuote: async function() {
          return { ok: true, executable: true, bestExecutable: mockQuote, quotes: [mockQuote] };
        },
      },
    });
    var Pp = loadProvider(w);
    var r = await Pp.quote({
      tokenIn: 'USDC', tokenOut: 'EURC',
      amountInRaw: 100000000n, fromChainId: 5042, slippageBps: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.quote._resolvedIn).not.toBeNull();
    expect(r.quote._resolvedIn.symbol).toBe('USDC');
    expect(r.quote._decimalsIn).toBe(6);
    expect(r.quote._decimalsOut).toBe(6);
  });
});

// ─── Security properties ──────────────────────────────────────────────

describe('Phase 1 — Security: no minOut=0 ever executes', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  it('validateQuote blocks minOut=0n always', () => {
    var q = {
      ok: true, source: 'tower',
      amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 0n,
      chainId: 5042, fromChainId: 5042, expiresAt: NOW + 30000,
      calldata: '0xaabbcc', to: '0x1234567890abcdef1234567890abcdef12345678',
    };
    expect(P.validateQuote(q, { fromChainId: 5042 }).ok).toBe(false);
  });

  it('validateQuote blocks missing minOut', () => {
    var q = {
      ok: true, source: 'tower',
      expectedOutRaw: 87000000n,
      chainId: 5042, fromChainId: 5042, expiresAt: NOW + 30000,
      calldata: '0xaabbcc', to: '0x1234567890abcdef1234567890abcdef12345678',
    };
    expect(P.validateQuote(q, { fromChainId: 5042 }).ok).toBe(false);
  });
});

describe('Phase 1 — Security: no placeholder/invalid router', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  var BLOCKED = [
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000001',
    null,
    undefined,
    '',
    'placeholder',
    '0xinvalid',
  ];

  BLOCKED.forEach(function(addr) {
    it('blocks router: ' + String(addr), () => {
      var q = {
        ok: true, source: 'tower',
        amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 86565000n,
        chainId: 5042, fromChainId: 5042, expiresAt: Date.now() + 30000,
        calldata: '0xaabbcc', to: addr,
      };
      expect(P.validateQuote(q, { fromChainId: 5042 }).ok).toBe(false);
    });
  });
});

describe('Phase 1 — Security: chain isolation', () => {
  var P;
  var NOW;
  beforeEach(() => { P = loadProvider(makeWindow()); NOW = Date.now(); });

  it('USDC on Ethereum has different address than USDC on Arc', () => {
    var onEth = P.TokenResolver.resolve(1, 'USDC');
    var onArc = P.TokenResolver.resolve(5042, 'USDC');
    expect(onEth.address).not.toEqual(onArc.address);
  });

  it('validateQuote rejects quote for Ethereum on Arc wallet', () => {
    var q = {
      ok: true, source: 'lifi',
      amountInRaw: 100000000n, expectedOutRaw: 87000000n, minOutRaw: 86565000n,
      chainId: 1, fromChainId: 1, expiresAt: Date.now() + 30000,
      calldata: '0xaabbcc', to: '0x1234567890abcdef1234567890abcdef12345678',
    };
    var r = P.validateQuote(q, { fromChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('FROM_CHAIN_MISMATCH');
  });

  it('WBTC on Bitcoin-chain not resolvable on Arc', () => {
    var r = P.TokenResolver.resolve(5042, 'WBTC');
    expect(r).toBeNull(); // WBTC not in Arc registry
  });
});

describe('Phase 1 — SwapProvider version and interface shape', () => {
  var P;
  beforeEach(() => { P = loadProvider(makeWindow()); });

  it('exposes all Phase 1 interface methods', () => {
    expect(typeof P.quote).toBe('function');
    expect(typeof P.validateQuote).toBe('function');
    expect(typeof P.buildTransaction).toBe('function');
    expect(typeof P.execute).toBe('function');
    expect(typeof P.trackTransaction).toBe('function');
  });

  it('exposes TokenResolver', () => {
    expect(typeof P.TokenResolver.resolve).toBe('function');
    expect(typeof P.TokenResolver.decimals).toBe('function');
  });

  it('phase is set', () => {
    expect(typeof P.phase).toBe('string');
    expect(P.phase.length).toBeGreaterThan(0);
  });

  it('version is semver string', () => {
    expect(typeof P.version).toBe('string');
    expect(P.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
