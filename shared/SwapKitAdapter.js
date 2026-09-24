/**
 * SwapKitAdapter — App Kit–style cross-chain swap interface over the existing
 * LI.FI proxy.
 *
 * App Kit's current aggregator is LiFi (per Circle documentation). This
 * adapter bridges the existing LI.FI proxy (/api/lifi/quote + /api/lifi/status)
 * to App Kit's semantic model: chain string names, estimateSwap(), waitForSwap().
 *
 * This is NOT a re-implementation of App Kit — it is a thin bridge that maps
 * App Kit's parameter shapes to the existing server-side proxy calls.
 *
 * Used by: executeSwap (index.html) when fromChainId !== toChainId (cross-chain).
 */

'use strict';

// ── App Kit chain name ↔ numeric chain ID mapping ─────────────────────────
// Exact string identifiers from @circle-fin/app-kit supported mainnet chains.
var CHAIN_ID_TO_KIT_NAME = {
  5042:   'Arc',
  1:      'Ethereum',
  8453:   'Base',
  42161:  'Arbitrum',
  10:     'Optimism',
  137:    'Polygon',
  43114:  'Avalanche',
  56:     'BNB',
  59144:  'Linea',
  10200:  'Chiado',
};

var KIT_NAME_TO_CHAIN_ID = {};
for (var _k in CHAIN_ID_TO_KIT_NAME) {
  KIT_NAME_TO_CHAIN_ID[CHAIN_ID_TO_KIT_NAME[_k]] = Number(_k);
}

// ── USDC ↔ NATIVE: same asset on Arc — must be blocked ─────────────────────
var ARC_CHAIN_ID = 5042;
var ARC_USDC_ADDR = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

/**
 * Returns true when the pair is a no-op on Arc (USDC ↔ NATIVE same asset).
 * Must be checked BEFORE estimateSwap or any routing call.
 */
function isArcUsdcNativePair(fromChainId, tokenIn, tokenOut) {
  if (Number(fromChainId) !== ARC_CHAIN_ID) return false;
  var inLower  = (tokenIn  || '').toLowerCase();
  var outLower = (tokenOut || '').toLowerCase();
  var USDC_SYMS = ['usdc', ARC_USDC_ADDR];
  var NATIVE_SYMS = ['native', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                     '0x0000000000000000000000000000000000000000'];
  var inIsUsdc   = USDC_SYMS.indexOf(inLower)   !== -1;
  var inIsNative = NATIVE_SYMS.indexOf(inLower) !== -1;
  var outIsUsdc  = USDC_SYMS.indexOf(outLower)   !== -1;
  var outIsNative= NATIVE_SYMS.indexOf(outLower) !== -1;
  return (inIsUsdc && outIsNative) || (inIsNative && outIsUsdc);
}

/** Resolve numeric chain ID → App Kit chain name string. */
function toKitChainName(chainId) {
  return CHAIN_ID_TO_KIT_NAME[Number(chainId)] || null;
}

/** Resolve App Kit chain name → numeric chain ID. */
function fromKitChainName(name) {
  return KIT_NAME_TO_CHAIN_ID[name] || null;
}

// ── Estimate (read-only, no signing) ───────────────────────────────────────

/**
 * estimateSwap — App Kit–style cross-chain estimate via LI.FI proxy.
 *
 * @param {object} params
 * @param {number|string} params.fromChainId
 * @param {number|string} params.toChainId
 * @param {string} params.tokenIn  — symbol or address
 * @param {string} params.tokenOut — symbol or address
 * @param {string} params.amountIn — human-readable (e.g. "1.00")
 * @param {string} params.fromAddress — sender/signer EVM address
 * @param {string} [params.toAddress]  — recipient (defaults to fromAddress)
 * @param {number} [params.slippageBps] — slippage in basis points (default 50 = 0.5%)
 * @returns {Promise<SwapKitEstimate>}
 */
async function estimateSwap(params) {
  var fromChainId  = Number(params.fromChainId);
  var toChainId    = Number(params.toChainId);
  var tokenIn      = params.tokenIn;
  var tokenOut     = params.tokenOut;
  var amountIn     = String(params.amountIn);
  var fromAddress  = params.fromAddress;
  var toAddress    = params.toAddress || fromAddress;
  var slippageBps  = params.slippageBps != null ? Number(params.slippageBps) : 50;

  // ── Input validation ──────────────────────────────────────────────────
  if (!tokenIn)  return { ok: false, reason: 'MISSING_TOKEN_IN',  message: 'tokenIn is required.' };
  if (!tokenOut) return { ok: false, reason: 'MISSING_TOKEN_OUT', message: 'tokenOut is required.' };
  if (!amountIn || amountIn === '0' || amountIn === 'undefined') {
    return { ok: false, reason: 'MISSING_AMOUNT_IN', message: 'amountIn is required and must be > 0.' };
  }

  // ── Arc USDC ↔ NATIVE guard ────────────────────────────────────────────
  if (isArcUsdcNativePair(fromChainId, tokenIn, tokenOut)) {
    return {
      ok: false,
      reason: 'ARC_USDC_NATIVE_NOOP',
      message: 'USDC and native gas are the same asset on Arc — swap is a no-op.',
      estimatedOutput: null,
      fees: [],
    };
  }

  // ── Resolve token addresses if symbols provided ────────────────────────
  var tokenInAddr  = params.tokenInAddress  || tokenIn;
  var tokenOutAddr = params.tokenOutAddress || tokenOut;

  // ── Convert amount to base units (we need the token decimals) ─────────
  var tokenInDecimals  = params.tokenInDecimals  || 6;
  var tokenOutDecimals = params.tokenOutDecimals || 6;

  var amountInRaw;
  try {
    var factor = BigInt(10) ** BigInt(tokenInDecimals);
    var parts  = amountIn.split('.');
    var whole  = BigInt(parts[0] || '0') * factor;
    var frac   = parts[1] ? parts[1].slice(0, tokenInDecimals).padEnd(tokenInDecimals, '0') : '';
    amountInRaw = whole + BigInt(frac || '0');
  } catch (_) {
    return { ok: false, reason: 'AMOUNT_PARSE_ERROR', message: 'Invalid amountIn: ' + amountIn };
  }

  // ── Call LI.FI proxy ───────────────────────────────────────────────────
  var body = {
    fromChainId:    fromChainId,
    toChainId:      toChainId,
    fromTokenAddress: tokenInAddr,
    toTokenAddress:   tokenOutAddr,
    fromAmount:     amountInRaw.toString(),
    fromAddress:    fromAddress,
    toAddress:      toAddress,
    slippage:       (slippageBps / 10000).toString(),
    allowBridges:   ['lifi'],
    order:          'RECOMMENDED',
  };

  var _fetchQ = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;
  var resp, data;
  try {
    resp = await _fetchQ('/api/lifi/quote', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    data = await resp.json();
  } catch (e) {
    return { ok: false, reason: 'NETWORK_ERROR', message: e.message };
  }

  if (!resp.ok) {
    // HTTP error — LI.FI INPUT_UNSUPPORTED_ROUTE or server error
    var reason = (data && (data.reason || data.code)) || 'QUOTE_ERROR';
    return {
      ok: false,
      reason: reason,
      message: (data && (data.message || data.error)) || 'No route found for this pair.',
      estimatedOutput: null,
      fees: [],
    };
  }

  // LI.FI proxy returns { quote: {...} }; direct API call returns the route object itself.
  var quote = data.quote || data;
  if (!quote || typeof quote !== 'object') {
    return { ok: false, reason: 'EMPTY_QUOTE', message: 'Provider returned empty quote.' };
  }
  // If the response is a LI.FI error body (has code but no estimate), treat as no route
  if (!quote.estimate && !quote.transactionRequest && (data.code || data.message)) {
    return { ok: false, reason: data.code || 'NO_ROUTE', message: data.message || 'No route found.' };
  }

  // ── Normalise to App Kit–style response shape ──────────────────────────
  var estOut = quote.estimate && quote.estimate.toAmount;
  var feesBps = quote.estimate && quote.estimate.feeCosts;

  return {
    ok:           true,
    reason:       null,
    // App Kit SwapEstimate shape
    estimatedOutput: {
      amount:   estOut ? _formatUnits(BigInt(estOut), tokenOutDecimals) : '0',
      token:    tokenOut,
    },
    expectedOutRaw:  estOut ? BigInt(estOut) : 0n,
    minOutRaw:       quote.estimate && quote.estimate.toAmountMin ? BigInt(quote.estimate.toAmountMin) : 0n,
    fees:            feesBps || [],
    priceImpactBps:  quote.estimate && quote.estimate.executionDuration != null ? null : null,
    txRequest:       quote.transactionRequest || null,
    txTo:            quote.transactionRequest && quote.transactionRequest.to,
    txData:          quote.transactionRequest && quote.transactionRequest.data,
    txValue:         quote.transactionRequest && quote.transactionRequest.value,
    spender:         quote.estimate && quote.estimate.approvalAddress,
    fromChainId:     fromChainId,
    toChainId:       toChainId,
    fromKitChain:    toKitChainName(fromChainId),
    toKitChain:      toKitChainName(toChainId),
    tokenIn:         tokenIn,
    tokenOut:        tokenOut,
    amountIn:        amountIn,
    amountInRaw:     amountInRaw,
    isCrossChain:    fromChainId !== toChainId,
    quotedAt:        Date.now(),
    expiresAt:       Date.now() + 30000, // 30s TTL
    _raw:            quote,
  };
}

// ── Wait for cross-chain swap (LI.FI status polling) ──────────────────────

/**
 * waitForSwap — polls /api/lifi/status until the destination leg is terminal.
 *
 * Mirrors App Kit's waitForSwap({ result, onProgress }) shape.
 *
 * @param {object} params
 * @param {string} params.txHash — source chain tx hash
 * @param {number|string} params.fromChainId
 * @param {number|string} params.toChainId
 * @param {Function} [params.onProgress] — called with status snapshot on each poll
 * @param {number}   [params.pollIntervalMs] — poll interval (default 3000ms)
 * @param {number}   [params.timeoutMs]      — total timeout (default 300000ms = 5min)
 * @returns {Promise<SwapKitFinalStatus>}
 */
async function waitForSwap(txHashOrParams, opts) {
  // Accept both waitForSwap(txHash, opts) and waitForSwap({ txHash, ...opts })
  var params = (typeof txHashOrParams === 'object' && txHashOrParams !== null) ? txHashOrParams : Object.assign({ txHash: txHashOrParams }, opts || {});
  var txHash       = params.txHash;
  var fromChainId  = Number(params.fromChainId  || 5042);
  var toChainId    = Number(params.toChainId    || 5042);
  var onProgress   = typeof params.onProgress === 'function' ? params.onProgress : null;
  var pollMs       = params.pollIntervalMs || params.pollMs || 3000;
  var timeoutMs    = params.maxWaitMs || params.timeoutMs || 300000;
  // Allow _sleepFn injection for tests — avoids real setTimeout delays
  var _sleepFn     = typeof params._sleepFn === 'function' ? params._sleepFn : _sleep;
  var deadline     = Date.now() + timeoutMs;

  var TERMINAL = ['DONE', 'FAILED', 'INVALID', 'NOT_PROCESSABLE_REFUND_NEEDED', 'REFUNDED'];
  var SUCCESS  = ['DONE'];

  var _fetchFn = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;
  var _nowFn   = params._nowFn || Date.now.bind(Date);
  while (_nowFn() < deadline) {
    var resp, data;
    try {
      resp = await _fetchFn('/api/lifi/status', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ txHash: txHash, fromChain: fromChainId, toChain: toChainId }),
      });
      data = await resp.json();
    } catch (_e) {
      // Network hiccup — keep polling
      await _sleepFn(pollMs);
      continue;
    }

    if (!resp.ok) {
      await _sleepFn(pollMs);
      continue;
    }

    var status    = (data.status    || '').toUpperCase();
    var substatus = data.substatus  || '';

    var snapshot = {
      txHash:   txHash,
      progress: { status: status, substatus: substatus },
      sending:  data.sending || null,
      receiving:data.receiving || null,
    };

    if (onProgress) {
      try { onProgress(snapshot); } catch (_) {}
    }

    if (TERMINAL.indexOf(status) !== -1) {
      return {
        ok:           SUCCESS.indexOf(status) !== -1,
        status:       status,
        substatus:    substatus,
        txHash:       txHash,
        destTxHash:   data.receiving && data.receiving.txHash,
        progress:     snapshot.progress,
        sending:      snapshot.sending,
        receiving:    snapshot.receiving,
      };
    }

    await _sleepFn(pollMs);
  }

  // Timeout — not a failure, just timed out. Caller should resume with same txHash.
  return {
    ok:       null, // null = indeterminate, not failed
    status:   'TIMEOUT',
    substatus:'TIMEOUT',
    txHash:   txHash,
    progress: { status: 'PENDING', substatus: 'TIMEOUT' },
    message:  'Polling timed out. Use waitForSwap({ txHash }) to resume tracking.',
  };
}

/**
 * getSwapStatus — single-shot status check (no polling).
 */
async function getSwapStatus(txHash, fromChainIdOrOpts, toChainIdArg) {
  // Accept getSwapStatus(hash, fromId, toId) AND getSwapStatus(hash, { fromChainId, toChainId })
  var fromChainId, toChainId;
  if (fromChainIdOrOpts && typeof fromChainIdOrOpts === 'object') {
    fromChainId = fromChainIdOrOpts.fromChainId;
    toChainId   = fromChainIdOrOpts.toChainId;
  } else {
    fromChainId = fromChainIdOrOpts;
    toChainId   = toChainIdArg;
  }
  var _f = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;
  var resp, data;
  try {
    resp = await _f('/api/lifi/status', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        txHash:    txHash,
        fromChain: Number(fromChainId || 5042),
        toChain:   Number(toChainId   || 5042),
      }),
    });
    data = await resp.json();
  } catch (e) {
    return { ok: false, status: 'FAILED', reason: 'NETWORK_ERROR', message: e.message };
  }
  if (!resp.ok) return { ok: false, status: 'FAILED', reason: data && data.reason || 'STATUS_ERROR' };
  return { ok: true, status: (data.status || 'PENDING').toUpperCase(), substatus: data.substatus, raw: data };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _formatUnits(value, decimals) {
  if (typeof value !== 'bigint') value = BigInt(value || 0);
  var d    = BigInt(10) ** BigInt(decimals);
  var whole= value / d;
  var frac = value % d;
  var fracStr = frac.toString().padStart(decimals, '0');
  // trim trailing zeros up to 6
  fracStr = fracStr.replace(/0+$/, '').slice(0, 6);
  return fracStr ? whole.toString() + '.' + fracStr : whole.toString();
}

function _sleep(ms) {
  var _st = (typeof window !== 'undefined' && window.setTimeout) ? window.setTimeout : setTimeout;
  return new Promise(function(resolve) { _st(resolve, ms); });
}

// ── isCrossChain helper ─────────────────────────────────────────────────────
function isCrossChain(fromChainId, toChainId) {
  if (toChainId === undefined || toChainId === null) return false;
  return Number(fromChainId) !== Number(toChainId);
}

// ── Public API ─────────────────────────────────────────────────────────────
var _publicApi = {
  version:              '1.0.0',
  estimateSwap:         estimateSwap,
  waitForSwap:          waitForSwap,
  getSwapStatus:        getSwapStatus,
  isArcUsdcNativePair:  isArcUsdcNativePair,
  isCrossChain:         isCrossChain,
  chainName:            toKitChainName,   // alias
  chainIdToKitName:     toKitChainName,   // alias for tests
  toKitChainName:       toKitChainName,
  fromKitChainName:     fromKitChainName,
  CHAIN_ID_TO_KIT_NAME: CHAIN_ID_TO_KIT_NAME,
  KIT_NAME_TO_CHAIN_ID: KIT_NAME_TO_CHAIN_ID,
  SUPPORTED_CHAINS:     CHAIN_ID_TO_KIT_NAME,  // alias for tests
  ARC_USDC_ADDRESS:     ARC_USDC_ADDR,
  ARC_CHAIN_ID:         ARC_CHAIN_ID,
};

if (typeof window !== 'undefined') {
  window.SwapKitAdapter = _publicApi;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _publicApi;
}
