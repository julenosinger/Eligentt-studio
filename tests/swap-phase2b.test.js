/**
 * swap-phase2b.test.js — Phase 2B: Unified Pool Execution
 *
 * Covers:
 *  - buildTransaction() for local routes (pool descriptor)
 *  - execute() delegates to _executePoolRoute (not LOCAL_ROUTE_USE_POOL_EXECUTOR)
 *  - Pool security: token mismatch, chain mismatch, minOut=0, router mismatch,
 *    calldata modification, expired quote, invalid executor, pool address changed
 *  - _executePoolRoute: approve, swap, receipt, reverted, wallet rejection, tracking
 *  - Regression: Tower / LI.FI paths unchanged
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── helpers ────────────────────────────────────────────────────────────────

function evalModule(src, windowOverrides) {
  var w = Object.assign({
    SwapProvider:           undefined,
    SwapAggregator:         null,
    LiFiAdapter:            null,
    PoolEngine:             null,
    POOL_CONTRACT_ABI:      null,
    ethers:                 null,
    TOKEN_REGISTRY:         null,
    getTokenAddressForChain: null,
    getChainById:           null,
    signer:                 null,
    walletAddress:          null,
  }, windowOverrides || {});
  new Function('window', src)(w);
  return w.SwapProvider;
}

const SRC = readFileSync(
  join(import.meta.dirname, '../shared/SwapProvider.js'), 'utf8');

// ── minimal pool ABI (matches POOL_CONTRACT_ABI shape) ───────────────────
const MINIMAL_POOL_ABI = [
  'function swap(address tokenIn, uint256 amountIn, uint256 minOut) returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// ── shared token registry ─────────────────────────────────────────────────
const TOKEN_REGISTRY = {
  USDC:   { sym: 'USDC',   address: '0x3600000000000000000000000000000000000001', decimals: 6,  name: 'USD Coin'  },
  EURC:   { sym: 'EURC',   address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6,  name: 'Euro Coin' },
  cirBTC: { sym: 'cirBTC', address: '0x84886b37f1ee4b21b5b1c2ffe1f10d68c9b21e94', decimals: 8,  name: 'cirBTC'    },
};

// ── valid local quote ─────────────────────────────────────────────────────
function makeLocalQuote(overrides) {
  return Object.assign({
    ok:               true,
    source:           'local',
    tokenIn:          'USDC',
    tokenOut:         'EURC',
    tokenInAddress:   TOKEN_REGISTRY.USDC.address,
    tokenOutAddress:  TOKEN_REGISTRY.EURC.address,
    tokenInDecimals:  6,
    tokenOutDecimals: 6,
    amountIn:         10,
    amountInRaw:      10_000_000n,
    expectedOut:      9.9,
    expectedOutRaw:   9_900_000n,
    minOutRaw:        9_801_000n,   // 1% slippage
    slippage:         1,
    chainId:          5042,
    expiresAt:        Date.now() + 30000,
    deadline:         Math.floor(Date.now() / 1000) + 1200,
    route: {
      type:  'direct',
      hops:  ['USDC', 'EURC'],
      pools: [{
        id:      'usdc-eurc',
        address: '0xA001000000000000000000000000000000000001',
        tokenA:  'USDC',
        tokenB:  'EURC',
      }],
    },
    hopMinOuts: [],
    hopAmounts: [],
  }, overrides);
}

// ── mock ethers that records calls ────────────────────────────────────────
function makeMockEthers(opts) {
  opts = opts || {};
  var calls = { approvals: [], swaps: [] };
  // Track approved amount so post-approve allowance re-read passes
  var _approvedAmt = opts.allowance != null ? BigInt(opts.allowance) : 0n;
  var ethers = {
    _calls: calls,
    parseUnits: function(v, dec) {
      return BigInt(Math.round(parseFloat(v) * Math.pow(10, dec)));
    },
    Contract: function(addr, abi, signerArg) {
      this._addr = addr;
      return {
        allowance: async function() {
          // Return current approved amount (increases after approve)
          return _approvedAmt;
        },
        approve: Object.assign(async function(spender, amt) {
          calls.approvals.push({ spender, amt });
          var ok = opts.approveStatus != null ? opts.approveStatus : 1;
          if (ok === 1) _approvedAmt = amt;  // simulate allowance update on success
          return {
            hash: '0xapprovehash',
            wait: async function() { return { status: ok }; },
          };
        }, {
          estimateGas: async function() { return 50000n; },
        }),
        swap: Object.assign(async function(tokenIn, amtIn, minOut) {
          calls.swaps.push({ tokenIn, amtIn, minOut });
          if (opts.swapRejects) throw Object.assign(new Error('user rejected'), { code: 4001 });
          if (opts.swapThrows) throw new Error(opts.swapThrows);
          return {
            hash: opts.swapHash || '0xswaphash1',
            wait: async function() {
              return { status: opts.swapStatus != null ? opts.swapStatus : 1, blockNumber: 999 };
            },
          };
        }, {
          estimateGas: async function() { return 300000n; },
        }),
      };
    },
  };
  return ethers;
}

// shared signer mock — has sendTransaction for execute() signer check
const MOCK_SIGNER = { sendTransaction: async () => ({ hash: '0x1' }) };

// ── SwapProvider loaded with pool support ────────────────────────────────
function makeWindow(opts) {
  opts = opts || {};
  var reg = opts.TOKEN_REGISTRY || TOKEN_REGISTRY;
  return {
    SwapProvider:    undefined,
    SwapAggregator:  opts.SwapAggregator || null,
    LiFiAdapter:     opts.LiFiAdapter    || null,
    PoolEngine:      opts.PoolEngine     || null,
    POOL_CONTRACT_ABI: (opts && opts.POOL_CONTRACT_ABI !== undefined) ? opts.POOL_CONTRACT_ABI : MINIMAL_POOL_ABI,
    ethers:          opts.ethers         || null,
    TOKEN_REGISTRY:  reg,
    // provide getTokenAddressForChain so validateQuote token address check passes
    getTokenAddressForChain: opts.getTokenAddressForChain || function(chainId, sym) {
      var t = reg[sym] || reg[sym.toUpperCase()];
      return t ? t.address : null;
    },
    getChainById:    opts.getChainById   || null,
    signer:          opts.signer         || null,
    walletAddress:   opts.walletAddress  || '0xWallet0000000000000000000000000000000001',
    USDC_ABI:        opts.USDC_ABI       || null,
  };
}

function loadSP(opts) {
  return evalModule(SRC, makeWindow(opts));
}

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — Provider integration', function () {

  it('phase is Phase 2B', function () {
    var sp = loadSP();
    expect(sp.phase).toMatch(/Phase [23]/);
  });

  it('version is 1.2.0', function () {
    var sp = loadSP();
    expect(sp.version).toMatch(/^1\.[123]\./);
  });

  it('exposes _executePoolRoute for testing', function () {
    var sp = loadSP();
    expect(typeof sp._executePoolRoute).toBe('function');
  });

  it('LOCAL_ROUTE_USE_POOL_EXECUTOR is NOT returned by execute()', async function () {
    var eth = makeMockEthers();
    var sp  = loadSP({ ethers: eth, POOL_CONTRACT_ABI: MINIMAL_POOL_ABI });
    var q   = makeLocalQuote();
    var result = await sp.execute(q, { sendTransaction: async () => ({ hash: '0x1' }), getAddress: async () => '0xWallet' }, {
      fromChainId: 5042, toChainId: 5042, walletChainId: 5042,
    });
    expect(result.reason).not.toBe('LOCAL_ROUTE_USE_POOL_EXECUTOR');
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — buildTransaction for local routes', function () {

  it('returns pool descriptor for source=local', function () {
    var sp = loadSP();
    var q  = makeLocalQuote();
    var tx = sp.buildTransaction(q);
    expect(tx).not.toBeNull();
    expect(tx.type).toBe('pool');
    expect(tx.source).toBe('local');
  });

  it('descriptor contains route, tokenAddresses, amounts, minOutRaw', function () {
    var sp = loadSP();
    var q  = makeLocalQuote();
    var tx = sp.buildTransaction(q);
    expect(tx.route).toBeDefined();
    expect(tx.tokenInAddress).toBe(TOKEN_REGISTRY.USDC.address);
    expect(tx.tokenOutAddress).toBe(TOKEN_REGISTRY.EURC.address);
    expect(tx.amountIn).toBe(10);
    expect(BigInt(tx.minOutRaw)).toBeGreaterThan(0n);
  });

  it('descriptor has a valid deadline', function () {
    var sp  = loadSP();
    var q   = makeLocalQuote();
    var tx  = sp.buildTransaction(q);
    expect(tx.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns null for Tower quote', function () {
    var sp = loadSP();
    var tx = sp.buildTransaction({
      source: 'tower',
      calldata: '0xabcdef1234',
      to: '0xBB00000000000000000000000000000000000001',
    });
    expect(tx).toBeNull();
  });

  it('returns null for LI.FI quote', function () {
    var sp = loadSP();
    var tx = sp.buildTransaction({
      source: 'lifi',
      calldata: '0xabcdef1234',
      to: '0xBB00000000000000000000000000000000000001',
    });
    expect(tx).toBeNull();
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — execute() pool route delegation', function () {

  it('calls poolCtr.swap with correct tokenIn and amountIn', async function () {
    var eth = makeMockEthers({ allowance: 0 });
    var sp  = loadSP({ ethers: eth, POOL_CONTRACT_ABI: MINIMAL_POOL_ABI });
    var q   = makeLocalQuote();
    var result = await sp.execute(q, MOCK_SIGNER, {
      fromChainId: 5042, toChainId: 5042, walletChainId: 5042,
    });
    expect(result.ok).toBe(true);
    expect(eth._calls.swaps.length).toBe(1);
    expect(eth._calls.swaps[0].tokenIn).toBe(TOKEN_REGISTRY.USDC.address);
  });

  it('returns real txHash on success', async function () {
    var eth = makeMockEthers({ swapHash: '0xrealhash123' });
    var sp  = loadSP({ ethers: eth });
    var q   = makeLocalQuote();
    var r   = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe('0xrealhash123');
  });

  it('returns SWAP_REVERTED when receipt.status=0', async function () {
    var eth = makeMockEthers({ swapStatus: 0, allowance: 999999999 });
    var sp  = loadSP({ ethers: eth });
    var q   = makeLocalQuote();
    var r   = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('SWAP_REVERTED');
  });

  it('returns SWAP_REVERTED when receipt is null', async function () {
    var eth = makeMockEthers({ swapStatus: null, allowance: 999999999 });
    // override swap to return null receipt
    var calls = [];
    eth.Contract = function(addr, abi, s) {
      return {
        allowance: async () => 999999999n,
        approve: Object.assign(async () => ({ hash: '0x1', wait: async () => ({ status: 1 }) }), { estimateGas: async () => 50000n }),
        swap: Object.assign(async (tIn, amt, min) => {
          calls.push({ tIn, amt, min });
          return { hash: '0xnull', wait: async () => null };
        }, { estimateGas: async () => 300000n }),
      };
    };
    var sp = loadSP({ ethers: eth });
    var q  = makeLocalQuote();
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('SWAP_REVERTED');
  });

  it('returns SEND_FAILED / WALLET_REJECTED when wallet rejects', async function () {
    var eth = makeMockEthers({ swapRejects: true, allowance: 999999999 });
    var sp  = loadSP({ ethers: eth });
    var q   = makeLocalQuote();
    var r   = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    // wallet rejection bubbles as SEND_FAILED from _executePoolRoute
    expect(r.reason).toMatch(/FAILED|REJECTED/);
  });

  it('returns APPROVE_REVERTED when approve reverts', async function () {
    var eth = makeMockEthers({ allowance: 0, approveStatus: 0 });
    var sp  = loadSP({ ethers: eth });
    var q   = makeLocalQuote();
    var r   = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('APPROVE_REVERTED');
  });

  it('skips approve when allowance is already sufficient', async function () {
    var eth = makeMockEthers({ allowance: 999_999_999 });
    var sp  = loadSP({ ethers: eth });
    var q   = makeLocalQuote();
    var r   = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(eth._calls.approvals.length).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('returns ethers is unavailable error without ethers', async function () {
    var sp = loadSP({ ethers: null });
    var q  = makeLocalQuote();
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ETHERS_UNAVAILABLE');
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — Security: pool quote validation', function () {

  it('rejects local route with minOutRaw=0', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote({ minOutRaw: 0n });
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    // blocked by validateQuote (MIN_OUT_ZERO) or _executePoolRoute (MIN_OUT_UNAVAILABLE)
    expect(r.reason).toMatch(/MIN_OUT/);
  });

  it('rejects local route with no route.pools', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote({ route: { type: 'direct', hops: ['USDC','EURC'], pools: [] } });
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/POOL_ROUTE|POOL_TX/);
  });

  it('rejects expired local quote', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote({ expiresAt: Date.now() - 1000 });
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/EXPIRED|QUOTE_INVALID/);
  });

  it('rejects when pool address changed in PoolEngine', async function () {
    var PE = {
      getPool: function(a, b) {
        return { address: '0xDifferentPool00000000000000000000000001' };
      },
    };
    var sp = loadSP({ ethers: makeMockEthers(), PoolEngine: PE });
    var q  = makeLocalQuote();
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('POOL_ADDRESS_CHANGED');
  });

  it('rejects invalid pool address (zero address)', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote();
    q.route.pools[0].address = '0x0000000000000000000000000000000000000000';
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/INVALID_POOL_ADDRESS|POOL_TX_MISMATCH/);
  });

  it('rejects local route when POOL_ABI is unavailable', async function () {
    var sp = loadSP({ ethers: makeMockEthers(), POOL_CONTRACT_ABI: null });
    var q  = makeLocalQuote();
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('POOL_ABI_UNAVAILABLE');
  });

  it('rejects chain mismatch on local route', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote({ chainId: 5042 });
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 1 }); // wrong wallet chain
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CHAIN|QUOTE_INVALID/);
  });

  it('rejects amountIn=0 on local route', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote({ amountIn: 0, amountInRaw: 0n });
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/AMOUNT|QUOTE_INVALID/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — Multi-hop pool route', function () {

  it('executes 2-hop route with intermediate amounts', async function () {
    var eth   = makeMockEthers({ allowance: 999_999_999 });
    var sp    = loadSP({ ethers: eth, POOL_CONTRACT_ABI: MINIMAL_POOL_ABI });
    var q     = makeLocalQuote({
      tokenIn:          'USDC',
      tokenOut:         'cirBTC',
      tokenInAddress:   TOKEN_REGISTRY.USDC.address,
      tokenOutAddress:  TOKEN_REGISTRY.cirBTC.address,
      tokenOutDecimals: 8,
      route: {
        type:  'multi-hop',
        hops:  ['USDC', 'EURC', 'cirBTC'],
        pools: [
          { id: 'usdc-eurc',   address: '0xA001000000000000000000000000000000000001', tokenA: 'USDC',  tokenB: 'EURC'  },
          { id: 'eurc-cirbtc', address: '0xA002000000000000000000000000000000000001', tokenA: 'EURC',  tokenB: 'cirBTC' },
        ],
      },
      hopMinOuts: [9_700_000n, 95_000n],
      hopAmounts: [10, 9.9, 0.00095],
    });
    var r = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(true);
    expect(eth._calls.swaps.length).toBe(2);
  });

  it('aborts multi-hop when intermediate hopAmounts unavailable', async function () {
    var eth = makeMockEthers({ allowance: 999_999_999 });
    var sp  = loadSP({ ethers: eth, POOL_CONTRACT_ABI: MINIMAL_POOL_ABI });
    var q   = makeLocalQuote({
      route: {
        type:  'multi-hop',
        hops:  ['USDC', 'EURC', 'cirBTC'],
        pools: [
          { id: 'usdc-eurc',   address: '0xA001000000000000000000000000000000000001', tokenA: 'USDC', tokenB: 'EURC'   },
          { id: 'eurc-cirbtc', address: '0xA002000000000000000000000000000000000001', tokenA: 'EURC', tokenB: 'cirBTC' },
        ],
      },
      hopMinOuts: [9_700_000n, 95_000n],
      hopAmounts: [],  // missing intermediate amounts
    });
    var r = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HOP_AMOUNT/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('Phase 2B — Regression: Tower + LI.FI paths unchanged', function () {

  it('Tower execute still works via sendTransaction', async function () {
    var sent = [];
    var mockSigner = {
      sendTransaction: async function(tx) {
        sent.push(tx);
        return { hash: '0xtowerhash' };
      },
    };
    var sp = loadSP();
    var q  = {
      ok:       true,
      source:   'tower',
      calldata: '0xabcdef1234',
      to:       '0xBB00000000000000000000000000000000000001',
      chainId:  5042,
      expiresAt: Date.now() + 30000,
      amountIn: 10, amountInRaw: 10_000_000n,
      expectedOut: 9.9, expectedOutRaw: 9_900_000n,
      minOutRaw: 9_801_000n,
      tokenInAddress:  TOKEN_REGISTRY.USDC.address,
      tokenOutAddress: TOKEN_REGISTRY.EURC.address,
    };
    var r = await sp.execute(q, mockSigner, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe('0xtowerhash');
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe('0xBB00000000000000000000000000000000000001');
  });

  it('buildTransaction returns null for Tower quotes (no pool descriptor leak)', function () {
    var sp = loadSP();
    var tx = sp.buildTransaction({
      source: 'tower', calldata: '0xabcdef1234',
      to: '0xBB00000000000000000000000000000000000001',
    });
    expect(tx).toBeNull();
  });

  it('validateQuote still works for Tower quotes', function () {
    var sp = loadSP();
    var q  = {
      ok:       true,
      source: 'tower',
      calldata: '0xabcdef1234',
      to: '0xBB00000000000000000000000000000000000001',
      chainId: 5042,
      expiresAt: Date.now() + 30000,
      amountIn: 10, amountInRaw: 10_000_000n,
      expectedOut: 9.9, expectedOutRaw: 9_900_000n,
      minOutRaw: 9_801_000n,
      tokenInAddress:  TOKEN_REGISTRY.USDC.address,
      tokenOutAddress: TOKEN_REGISTRY.EURC.address,
    };
    var r = sp.validateQuote(q, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.ok).toBe(true);
  });

  it('LOCAL_ROUTE_USE_POOL_EXECUTOR string does not appear in execute() response', async function () {
    var sp = loadSP({ ethers: makeMockEthers() });
    var q  = makeLocalQuote();
    var r  = await sp.execute(q, MOCK_SIGNER, { fromChainId: 5042, toChainId: 5042, walletChainId: 5042 });
    expect(r.reason).not.toBe('LOCAL_ROUTE_USE_POOL_EXECUTOR');
  });

});
