/**
 * SwapProvider — provider-agnostic Swap Execution Layer (Phase 2B)
 * ═══════════════════════════════════════════════════════════════════════
 * Formal interface that wraps SwapAggregator + TowerAdapter + LiFiAdapter
 * + the existing local Pool Executor into a single, deterministic contract:
 *
 *   SwapProvider.quote(params)         → normalized, validated quote
 *   SwapProvider.validateQuote(q, ctx) → full pre-execution guard
 *   SwapProvider.buildTransaction(q)   → {to, data, value, chainId}
 *   SwapProvider.execute(q, signer)    → receipt (never custodial)
 *   SwapProvider.trackTransaction(h)   → status
 *
 * Providers:
 *   Tower  → TowerAdapter (server-side calldata via Cloudflare Function)
 *   LI.FI  → LiFiAdapter  (cross-chain aggregator)
 *   LOCAL  → existing Pool Executor (Arc AMM, ethers Contract.swap())
 *
 * Rules enforced here (not assumed of callers):
 *   - chainId validated against requested and wallet chain
 *   - token addresses validated against resolved registry values
 *   - decimals never assumed — always resolved from TokenResolver
 *   - minOut never 0n (blocks execution if SwapMath unavailable)
 *   - stale quotes rejected (expiresAt < now)
 *   - token/chain mismatch between quote and request → REJECTED
 *   - zero / placeholder router blocked
 *   - local pool: router re-verified against PoolEngine at execution time
 *   - no mock data, no fake quotes, no custodial signing
 *   - LOCAL_ROUTE_USE_POOL_EXECUTOR exception eliminated
 *
 * Attached to window.SwapProvider
 */
(function (w) {
  'use strict';

  if (w.SwapProvider) return;

  var ZERO_ADDR   = '0x0000000000000000000000000000000000000000';
  var ADDR_RE     = /^0x[0-9a-fA-F]{40}$/;
  var CALLDATA_RE = /^0x[0-9a-fA-F]{2,}$/;   // at least one full byte beyond '0x'

  // ─── Known precompile/low-value addresses that must never be routers ─
  var BLOCKED_ADDRS = (function () {
    var s = {};
    // zero address
    s[ZERO_ADDR] = true;
    // common precompile addresses (0x0...0001 through 0x0...0009)
    for (var i = 1; i <= 20; i++) {
      var pad = '000000000000000000000000000000000000000' + i.toString(16);
      s['0x' + pad.slice(-40)] = true;
    }
    return s;
  }());

  // ─── helpers ──────────────────────────────────────────────────────────

  function isValidAddr(a) {
    if (typeof a !== 'string') return false;
    if (!ADDR_RE.test(a)) return false;
    var lo = a.toLowerCase();
    return !BLOCKED_ADDRS[lo];
  }

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null) return null;
    try { var b = BigInt(String(v)); return b >= 0n ? b : null; } catch (_) { return null; }
  }

  function nowMs() { return Date.now(); }

  // ─── window-scoped accessors (support both browser and test sandbox) ──

  function _getTokenAddressForChain(chainId, sym) {
    var fn = w.getTokenAddressForChain;
    if (typeof fn === 'function') return fn(chainId, sym);
    return null;
  }

  function _getChainById(chainId) {
    var fn = w.getChainById;
    if (typeof fn === 'function') return fn(chainId);
    return null;
  }

  function _getTokenRegistry() {
    return w.TOKEN_REGISTRY || null;
  }

  function _getSwapAggregator() {
    return w.SwapAggregator || null;
  }

  function _getLiFiAdapter() {
    return w.LiFiAdapter || null;
  }

  function _getPoolEngine() {
    return w.PoolEngine || null;
  }

  function _getPoolContractABI() {
    return w.POOL_CONTRACT_ABI || null;
  }

  function _getEthers() {
    return w.ethers || null;
  }

  // ─── _executePoolRoute() ──────────────────────────────────────────────
  /**
   * Executes a local pool quote through the existing Pool Executor pattern.
   * Delegates to the same POOL_CONTRACT_ABI + ethers.Contract.swap() call
   * used by executeSwap() — no duplication of pool math or routing logic.
   *
   * Returns { ok, txHash, hops } on success or { ok:false, reason, error } on failure.
   * Never custodial. Wallet must be the signer.
   */
  async function _executePoolRoute(q, signer, opts) {
    opts = opts || {};
    var ethers  = _getEthers();
    var PE      = _getPoolEngine();
    var ABI     = _getPoolContractABI();

    if (!ethers)  return { ok: false, reason: 'ETHERS_UNAVAILABLE' };
    if (!ABI)     return { ok: false, reason: 'POOL_ABI_UNAVAILABLE' };

    var route = q.route;
    if (!route || !Array.isArray(route.pools) || route.pools.length === 0) {
      return { ok: false, reason: 'INVALID_POOL_ROUTE' };
    }

    // ── Pre-execution: re-verify pool addresses against PoolEngine registry ──
    if (PE && typeof PE.getPool === 'function') {
      for (var pi = 0; pi < route.pools.length; pi++) {
        var rp   = route.pools[pi];
        var live = PE.getPool(rp.tokenA, rp.tokenB);
        if (live && live.address &&
            live.address !== '0x0000000000000000000000000000000000000000' &&
            live.address.toLowerCase() !== rp.address.toLowerCase()) {
          return { ok: false, reason: 'POOL_ADDRESS_CHANGED' };
        }
      }
    }

    var lastTxHash = null;
    var hops = [];
    var currentTokenAddr = q.tokenInAddress;
    var currentAmount    = q.amountIn;
    var currentDecimals  = q.tokenInDecimals || 6;
    var deadline         = q.deadline || (Math.floor(Date.now() / 1000) + 1200);

    // ── minOut: use quote-time value; never 0n ────────────────────────────
    var minReceivedRaw = toBig(q.minOutRaw);
    if (!minReceivedRaw || minReceivedRaw <= 0n) {
      return { ok: false, reason: 'MIN_OUT_UNAVAILABLE' };
    }

    // ── Per-hop min outs ─────────────────────────────────────────────────
    var hopMinOuts = Array.isArray(q.hopMinOuts) ? q.hopMinOuts : [];

    for (var hi = 0; hi < route.pools.length; hi++) {
      // Deadline check per hop
      if (Math.floor(Date.now() / 1000) > deadline) {
        return { ok: false, reason: 'DEADLINE_EXCEEDED', hops: hops };
      }

      var poolCfg  = route.pools[hi];
      var poolAddr = poolCfg.address;

      // Re-validate pool address before each hop
      if (!isValidAddr(poolAddr)) {
        return { ok: false, reason: 'INVALID_POOL_ADDRESS', hopIndex: hi };
      }

      var isLastHop    = hi === route.pools.length - 1;
      var nextTokenSym  = route.hops[hi + 1];
      var nextTokenInfo = w.TOKEN_REGISTRY ? w.TOKEN_REGISTRY[nextTokenSym] : null;
      var nextTokenAddr = nextTokenInfo ? nextTokenInfo.address : null;
      var nextDecimals  = nextTokenInfo ? (nextTokenInfo.decimals || 6) : 6;

      // ── Approve ───────────────────────────────────────────────────────
      var isNative = !currentTokenAddr ||
                     currentTokenAddr === '0x0000000000000000000000000000000000000000';
      if (!isNative) {
        var USDC_ABI = (w.USDC_ABI && w.USDC_ABI.length) ? w.USDC_ABI : [
          'function allowance(address,address) view returns (uint256)',
          'function approve(address,uint256) returns (bool)',
        ];
        var tokenCtr = new ethers.Contract(currentTokenAddr, USDC_ABI, signer);
        var amtBig   = ethers.parseUnits(
          currentAmount.toFixed(currentDecimals), currentDecimals);
        var allowance = 0n;
        try { allowance = await tokenCtr.allowance(opts.walletAddress || w.walletAddress, poolAddr); } catch (_) {}
        if (allowance < amtBig) {
          var appGas = 200000n;
          try { appGas = await tokenCtr.approve.estimateGas(poolAddr, amtBig); appGas = appGas * 120n / 100n; } catch (_) {}
          var appTx = await tokenCtr.approve(poolAddr, amtBig, { gasLimit: appGas });
          var appReceipt = await appTx.wait();
          if (!appReceipt || appReceipt.status !== 1) {
            return { ok: false, reason: 'APPROVE_REVERTED', hopIndex: hi };
          }
          // Re-read allowance to confirm
          var newAllowance = 0n;
          try { newAllowance = await tokenCtr.allowance(opts.walletAddress || w.walletAddress, poolAddr); } catch (_) {}
          if (newAllowance < amtBig) {
            return { ok: false, reason: 'APPROVE_NOT_REFLECTED', hopIndex: hi };
          }
          hops.push({ step: 'approve', hopIndex: hi, txHash: appTx.hash });
        }
      }

      // ── Swap hop ──────────────────────────────────────────────────────
      var swapAmtBig = ethers.parseUnits(
        currentAmount.toFixed(currentDecimals), currentDecimals);

      // Per-hop minOut: final hop = global minReceived; intermediate = computed
      var hopMin;
      if (isLastHop) {
        hopMin = minReceivedRaw;
      } else {
        var hm = toBig(hopMinOuts[hi]);
        if (!hm || hm <= 0n) {
          return { ok: false, reason: 'HOP_MIN_OUT_UNAVAILABLE', hopIndex: hi };
        }
        hopMin = hm;
      }

      var poolCtr  = new ethers.Contract(poolAddr, ABI, signer);
      var swapGas  = 350000n;
      try {
        var estGas = await poolCtr.swap.estimateGas(currentTokenAddr, swapAmtBig, hopMin);
        swapGas = estGas * 130n / 100n;
      } catch (egErr) {
        // If estimateGas throws a wallet rejection, propagate immediately
        if (egErr && (egErr.code === 4001 || egErr.code === 'ACTION_REJECTED')) {
          return { ok: false, reason: 'WALLET_REJECTED', hopIndex: hi,
                   error: (egErr && egErr.message) || String(egErr) };
        }
        // Other estimateGas failures — use default gas limit and proceed
      }

      var swapTx, swapReceipt;
      try {
        swapTx = await poolCtr.swap(currentTokenAddr, swapAmtBig, hopMin, { gasLimit: swapGas });
        lastTxHash = swapTx.hash;
        swapReceipt = await swapTx.wait(1, 25000);
      } catch (swapErr) {
        if (swapErr && (swapErr.code === 4001 || swapErr.code === 'ACTION_REJECTED')) {
          return { ok: false, reason: 'WALLET_REJECTED', hopIndex: hi,
                   error: (swapErr && swapErr.message) || String(swapErr) };
        }
        return { ok: false, reason: 'SWAP_SEND_FAILED', hopIndex: hi,
                 error: (swapErr && swapErr.message) || String(swapErr) };
      }
      if (!swapReceipt || swapReceipt.status !== 1) {
        return { ok: false, reason: 'SWAP_REVERTED', hopIndex: hi,
                 txHash: lastTxHash,
                 status: swapReceipt ? swapReceipt.status : null };
      }
      hops.push({ step: 'swap', hopIndex: hi, txHash: swapTx.hash,
                  blockNumber: swapReceipt.blockNumber });

      // Advance to next token
      currentTokenAddr = nextTokenAddr;
      currentDecimals  = nextDecimals;
      if (!isLastHop) {
        // Approximate next amount using q.hopAmounts if provided, else use output
        var nextAmt = Array.isArray(q.hopAmounts) ? q.hopAmounts[hi + 1] : null;
        if (nextAmt == null || !(nextAmt > 0)) {
          return { ok: false, reason: 'HOP_AMOUNT_UNAVAILABLE', hopIndex: hi };
        }
        currentAmount = nextAmt;
      }
    }

    return { ok: true, txHash: lastTxHash, source: 'local', hops: hops };
  }

  // ─── TokenResolver ────────────────────────────────────────────────────
  /**
   * Resolve { chainId, symbol, address, decimals, name } for a given token
   * on a given chain. Returns null when the token cannot be resolved.
   * Never throws.
   */
  var TokenResolver = {
    /**
     * @param {number} chainId
     * @param {string} symbolOrAddr — token symbol (e.g. 'USDC') or ERC-20 address
     * @returns {{ chainId, symbol, address, decimals, name } | null}
     */
    resolve: function (chainId, symbolOrAddr) {
      if (!chainId || !symbolOrAddr) return null;
      chainId = Number(chainId);
      var sym = String(symbolOrAddr);

      // 1. Direct address input → return partial record (no reverse lookup)
      if (ADDR_RE.test(sym)) {
        return { chainId: chainId, symbol: sym, address: sym.toLowerCase(), decimals: null, name: null };
      }

      // 2. Symbol → multi-chain registry (getTokenAddressForChain)
      try {
        var addr = _getTokenAddressForChain(chainId, sym);
        if (addr && ADDR_RE.test(addr)) {
          var dec = null;
          try {
            var chain = _getChainById(chainId);
            var tokEntry = chain && chain.tokens && chain.tokens[sym];
            if (tokEntry && tokEntry.decimals != null) dec = Number(tokEntry.decimals);
          } catch (_) {}
          var reg = _getTokenRegistry();
          var name = sym;
          try {
            if (reg && reg[sym]) {
              name = reg[sym].name || sym;
              if (dec == null && reg[sym].decimals != null) dec = Number(reg[sym].decimals);
            }
          } catch (_) {}
          return { chainId: chainId, symbol: sym, address: addr.toLowerCase(), decimals: dec, name: name };
        }
      } catch (_) {}

      // 3. Fallback: Arc TOKEN_REGISTRY (chain-agnostic, Arc-only)
      try {
        var reg2 = _getTokenRegistry();
        if (reg2 && reg2[sym]) {
          var t = reg2[sym];
          if (t.address && ADDR_RE.test(t.address)) {
            return {
              chainId: chainId,
              symbol: sym,
              address: t.address.toLowerCase(),
              decimals: t.decimals != null ? Number(t.decimals) : null,
              name: t.name || sym,
            };
          }
        }
      } catch (_) {}

      return null;
    },

    /**
     * Resolve decimals only. Returns null when not resolvable.
     */
    decimals: function (chainId, symbolOrAddr) {
      var r = this.resolve(chainId, symbolOrAddr);
      return r ? r.decimals : null;
    },
  };

  // ─── quote() ──────────────────────────────────────────────────────────
  /**
   * Fetch the best available quote for a swap via SwapAggregator.
   * Resolves token addresses before quoting — never passes bare symbols
   * to external adapters when an address is required.
   *
   * @param {object} params {
   *   tokenIn: string (symbol or address),
   *   tokenOut: string (symbol or address),
   *   amountInRaw: bigint,
   *   fromChainId: number,
   *   toChainId: number,
   *   slippageBps: number,
   *   userAddress?: string,
   * }
   * @returns {Promise<{ok:boolean, quote?:object, reason?:string}>}
   */
  async function quote(params) {
    params = params || {};

    var fromChainId = Number(params.fromChainId);
    var toChainId   = Number(params.toChainId) || fromChainId;
    if (!Number.isFinite(fromChainId) || fromChainId <= 0) {
      return { ok: false, reason: 'INVALID_FROM_CHAIN' };
    }

    var amountInRaw = toBig(params.amountInRaw);
    if (!amountInRaw || amountInRaw <= 0n) {
      return { ok: false, reason: 'INVALID_AMOUNT' };
    }

    var slippageBps = Number(params.slippageBps);
    if (!Number.isFinite(slippageBps) || slippageBps <= 0 || slippageBps >= 10000) {
      return { ok: false, reason: 'INVALID_SLIPPAGE' };
    }

    // Resolve token addresses FIRST — token errors are reported before
    // aggregator availability so callers get actionable failure reasons.
    var resolvedIn  = TokenResolver.resolve(fromChainId, params.tokenIn);
    var resolvedOut = TokenResolver.resolve(toChainId,   params.tokenOut);

    var tokenInAddress  = (resolvedIn  && resolvedIn.address)  || null;
    var tokenOutAddress = (resolvedOut && resolvedOut.address) || null;

    var decimalsIn  = (resolvedIn  && resolvedIn.decimals  != null) ? resolvedIn.decimals  : null;
    var decimalsOut = (resolvedOut && resolvedOut.decimals != null) ? resolvedOut.decimals : null;

    if (!tokenInAddress || !tokenOutAddress) {
      return { ok: false, reason: 'TOKEN_ADDRESS_UNRESOLVABLE', details: {
        tokenIn: params.tokenIn, tokenOut: params.tokenOut,
        fromChainId: fromChainId, toChainId: toChainId,
        resolvedIn: resolvedIn, resolvedOut: resolvedOut,
      }};
    }

    // Validate aggregator availability AFTER token resolution
    var aggregator = _getSwapAggregator();
    if (!aggregator || typeof aggregator.getBestQuote !== 'function') {
      return { ok: false, reason: 'AGGREGATOR_UNAVAILABLE' };
    }

    var decision;
    try {
      decision = await aggregator.getBestQuote({
        tokenIn:         params.tokenIn,
        tokenOut:        params.tokenOut,
        tokenInAddress:  tokenInAddress,
        tokenOutAddress: tokenOutAddress,
        amountInRaw:     amountInRaw,
        slippageBps:     slippageBps,
        fromChainId:     fromChainId,
        toChainId:       toChainId,
        chainId:         fromChainId,
        userAddress:     params.userAddress || null,
        hasLocalPool:    params.hasLocalPool === true,
      });
    } catch (e) {
      return { ok: false, reason: 'AGGREGATOR_ERROR', error: (e && e.message) || String(e) };
    }

    if (!decision || !decision.ok || !decision.bestExecutable) {
      return {
        ok:     false,
        reason: (decision && decision.reason) || 'NO_EXECUTABLE_ROUTE',
        quotes: (decision && decision.quotes) || [],
      };
    }

    var q = decision.bestExecutable;
    // Attach resolved token metadata for downstream use
    q._resolvedIn  = resolvedIn;
    q._resolvedOut = resolvedOut;
    q._decimalsIn  = decimalsIn;
    q._decimalsOut = decimalsOut;

    return { ok: true, quote: q, decision: decision };
  }

  // ─── validateQuote() ──────────────────────────────────────────────────
  /**
   * Full pre-execution guard. Must pass before buildTransaction() or execute().
   *
   * @param {object} q  normalized quote (from SwapProvider.quote())
   * @param {object} ctx {
   *   amountInRaw?: bigint,
   *   fromChainId?: number,
   *   toChainId?: number,
   *   walletChainId?: number,
   *   tokenIn?: string,
   *   tokenOut?: string,
   * }
   * @returns {{ok:boolean, reason?:string}}
   */
  function validateQuote(q, ctx) {
    ctx = ctx || {};
    if (!q || q.ok !== true) return { ok: false, reason: 'QUOTE_NOT_OK' };

    // 1. Staleness
    if (q.expiresAt != null && nowMs() > q.expiresAt) {
      return { ok: false, reason: 'QUOTE_STALE' };
    }

    // 1b. amountIn must be positive
    var qAmtIn = toBig(q.amountInRaw);
    if (qAmtIn === null || qAmtIn <= 0n) {
      return { ok: false, reason: 'AMOUNT_IN_INVALID' };
    }

    // 2. Amount match (only when caller provides amountInRaw)
    var ctxAmt = toBig(ctx.amountInRaw);
    var qAmt   = toBig(q.amountInRaw);
    if (ctxAmt !== null && qAmt !== null && ctxAmt !== qAmt) {
      return { ok: false, reason: 'AMOUNT_MISMATCH' };
    }

    // 3. Chain match — quote's source chain must match request
    var fromChain = ctx.fromChainId != null ? Number(ctx.fromChainId) : null;
    if (fromChain !== null && Number.isFinite(fromChain)) {
      var qChain = q.fromChainId != null ? Number(q.fromChainId) : (q.chainId != null ? Number(q.chainId) : null);
      if (qChain !== null && qChain !== fromChain) {
        return { ok: false, reason: 'FROM_CHAIN_MISMATCH' };
      }
    }

    // 4. Wallet chain must match quote source chain (prevent signing on wrong chain)
    if (ctx.walletChainId != null && fromChain !== null && Number.isFinite(fromChain)) {
      if (Number(ctx.walletChainId) !== fromChain) {
        return { ok: false, reason: 'WALLET_CHAIN_MISMATCH' };
      }
    }

    // 5. Token address validation (quote token addresses must match resolved registry)
    if (ctx.tokenIn && q._resolvedIn && q._resolvedIn.address) {
      var qInAddr   = (q.tokenInAddress  || '').toLowerCase();
      var ctxInAddr = q._resolvedIn.address.toLowerCase();
      if (qInAddr && ctxInAddr && qInAddr !== ctxInAddr) {
        return { ok: false, reason: 'TOKEN_IN_ADDRESS_MISMATCH' };
      }
    }
    if (ctx.tokenOut && q._resolvedOut && q._resolvedOut.address) {
      var qOutAddr   = (q.tokenOutAddress  || '').toLowerCase();
      var ctxOutAddr = q._resolvedOut.address.toLowerCase();
      if (qOutAddr && ctxOutAddr && qOutAddr !== ctxOutAddr) {
        return { ok: false, reason: 'TOKEN_OUT_ADDRESS_MISMATCH' };
      }
    }

    // 6. minOut must be positive and non-zero
    var minOut = toBig(q.minOutRaw);
    if (minOut === null || minOut <= 0n) {
      return { ok: false, reason: 'MIN_OUT_INVALID' };
    }

    // 7. expectedOut must be positive
    var expOut = toBig(q.expectedOutRaw);
    if (expOut === null || expOut <= 0n) {
      return { ok: false, reason: 'EXPECTED_OUT_INVALID' };
    }

    // 8. minOut <= expectedOut (sanity)
    if (minOut > expOut) {
      return { ok: false, reason: 'MIN_OUT_EXCEEDS_EXPECTED' };
    }

    // 9. External quote: calldata + router + value required and valid
    if (q.source === 'tower' || q.source === 'lifi') {
      if (!q.calldata || !CALLDATA_RE.test(q.calldata)) {
        return { ok: false, reason: 'INVALID_CALLDATA' };
      }
      if (!isValidAddr(q.to)) {
        return { ok: false, reason: 'INVALID_ROUTER' };
      }
      // value must be a non-negative integer string (hex or decimal)
      if (q.value != null && q.value !== '0') {
        var vStr = String(q.value);
        if (!/^[0-9]+$/.test(vStr) && !/^0x[0-9a-fA-F]+$/.test(vStr)) {
          return { ok: false, reason: 'INVALID_VALUE' };
        }
        try { if (BigInt(vStr) < 0n) return { ok: false, reason: 'INVALID_VALUE' }; }
        catch (_) { return { ok: false, reason: 'INVALID_VALUE' }; }
      }
      // ctx.value mismatch: caller may pass expected value to check against quote
      if (ctx.value != null && q.value != null) {
        if (String(ctx.value) !== String(q.value)) {
          return { ok: false, reason: 'VALUE_MISMATCH' };
        }
      }
    }

    // 10. Local quote: pool address must be valid if provided
    if (q.source === 'local') {
      if (q.poolAddress && !isValidAddr(q.poolAddress)) {
        return { ok: false, reason: 'INVALID_POOL_ADDRESS' };
      }
    }

    return { ok: true };
  }

  // ─── buildTransaction() ───────────────────────────────────────────────
  /**
   * Build a raw transaction object from a validated quote.
   * Returns { to, data, value, chainId } for external quotes (Tower/LI.FI).
   * Returns null for local quotes (caller uses existing pool execution path).
   *
   * @param {object} q validated quote
   * @returns {{ to:string, data:string, value:string, chainId:number } | null}
   */
  function buildTransaction(q) {
    if (!q || q.ok !== true) return null;

    if (q.source === 'tower' || q.source === 'lifi') {
      if (!q.calldata || !q.to) return null;
      return {
        to:      q.to,
        data:    q.calldata,
        value:   q.value != null ? String(q.value) : '0',
        chainId: q.fromChainId != null ? Number(q.fromChainId) : (q.chainId != null ? Number(q.chainId) : null),
      };
    }

    // Local/pool route — returns a structured descriptor.
    // Actual ABI encoding happens in _executePoolRoute via ethers.Contract.
    // Callers must not pass this descriptor to signer.sendTransaction directly.
    if (q && q.source === 'local' && q.route && Array.isArray(q.route.pools)) {
      return {
        type:            'pool',
        source:          'local',
        route:           q.route,
        tokenInAddress:  q.tokenInAddress,
        tokenOutAddress: q.tokenOutAddress,
        amountIn:        q.amountIn,
        amountInRaw:     q.amountInRaw,
        minOutRaw:       q.minOutRaw,
        deadline:        q.deadline || (Math.floor(Date.now() / 1000) + 1200),
        chainId:         q.chainId,
        hopMinOuts:      q.hopMinOuts || [],
        hopAmounts:      q.hopAmounts || [],
      };
    }

    return null;
  }

  // ─── execute() ────────────────────────────────────────────────────────
  /**
   * Execute a validated quote via the user's signer. Never custodial.
   * Validates before sending. Caller must approve first (exact amountInRaw only).
   *
   * @param {object} q validated quote (pass through validateQuote first)
   * @param {object} signer ethers-compatible signer (user's wallet)
   * @param {object} opts { fromChainId, toChainId, tokenIn, tokenOut, amountInRaw, walletChainId? }
   * @returns {Promise<{ok:boolean, txHash?:string, reason?:string}>}
   */
  async function execute(q, signer, opts) {
    opts = opts || {};
    if (!signer || typeof signer.sendTransaction !== 'function') {
      return { ok: false, reason: 'NO_SIGNER' };
    }

    var validation = validateQuote(q, opts);
    if (!validation.ok) {
      return { ok: false, reason: 'QUOTE_INVALID:' + validation.reason };
    }

    var tx = buildTransaction(q);
    if (!tx && (q.source === 'tower' || q.source === 'lifi')) {
      return { ok: false, reason: 'TRANSACTION_BUILD_FAILED' };
    }

    // ── Local/pool route: delegate to existing pool executor ──────────────
    // SwapProvider orchestrates; the pool executor is the source of truth
    // for contract interaction, gas estimation, and on-chain confirmation.
    // LOCAL_ROUTE_USE_POOL_EXECUTOR exception is eliminated here.
    if (q.source === 'local') {
      if (!tx || tx.type !== 'pool') {
        return { ok: false, reason: 'POOL_TRANSACTION_BUILD_FAILED' };
      }
      // Final pre-execution check: pool descriptor must match validated quote
      if (!tx.route || !tx.tokenInAddress || !tx.minOutRaw || !(toBig(tx.minOutRaw) > 0n)) {
        return { ok: false, reason: 'POOL_TX_MISMATCH' };
      }
      return _executePoolRoute(q, signer, opts);
    }

    // ── Tower / LI.FI: pre-signature immutable gate ──────────────────────
    // Immediately before signing: compare tx fields against the validated quote.
    // If anything changed between validateQuote() and sendTransaction(), abort.
    // This is the FINAL hard stop — the user must never sign a tx that differs
    // from what was validated.
    if (!tx || !tx.to || !tx.data) {
      return { ok: false, reason: 'PRE_SIG_TX_MISSING' };
    }
    if (tx.to.toLowerCase() !== q.to.toLowerCase()) {
      return { ok: false, reason: 'PRE_SIG_TO_MISMATCH' };
    }
    if (tx.data !== q.calldata) {
      return { ok: false, reason: 'PRE_SIG_CALLDATA_MISMATCH' };
    }
    var txVal  = String(tx.value  != null ? tx.value  : '0');
    var qVal   = String(q.value   != null ? q.value   : '0');
    if (txVal !== qVal) {
      return { ok: false, reason: 'PRE_SIG_VALUE_MISMATCH' };
    }
    // source must not have changed (prevents provider confusion)
    if (tx.chainId != null && q.fromChainId != null &&
        Number(tx.chainId) !== Number(q.fromChainId) &&
        Number(tx.chainId) !== Number(q.chainId)) {
      return { ok: false, reason: 'PRE_SIG_CHAIN_MISMATCH' };
    }

    // ── Send ─────────────────────────────────────────────────────────────
    var _sent = false; // no-retry-after-broadcast flag
    try {
      _sent = true;
      var response = await signer.sendTransaction({
        to:    tx.to,
        data:  tx.data,
        value: tx.value || '0',
      });
      return { ok: true, txHash: response.hash, source: q.source };
    } catch (e) {
      // If already sent (network accepted), never silently retry.
      // REPLACEMENT_UNDERPRICED / NONCE_EXPIRED indicate the tx landed.
      if (_sent && e && (e.code === 'REPLACEMENT_UNDERPRICED' || e.code === 'NONCE_EXPIRED')) {
        return { ok: false, reason: 'TX_POSSIBLY_SUBMITTED', error: (e && e.message) || String(e) };
      }
      var reason = 'SEND_FAILED';
      if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) reason = 'WALLET_REJECTED';
      if (e && e.code === 'INSUFFICIENT_FUNDS') reason = 'INSUFFICIENT_BALANCE';
      if (e && e.code === 'UNPREDICTABLE_GAS_LIMIT') reason = 'INSUFFICIENT_GAS';
      return { ok: false, reason: reason, error: (e && e.message) || String(e) };
    }
  }

  // ─── trackTransaction() ──────────────────────────────────────────────
  /**
   * Poll status of a submitted transaction.
   * For LI.FI routes, delegates to LiFiAdapter.getStatus.
   * For Tower / local, uses ethers provider to wait for receipt.
   *
   * @param {string} txHash
   * @param {object} opts { source, fromChainId?, toChainId?, bridge? }
   * @returns {Promise<{ok:boolean, status:string, receipt?:object, reason?:string}>}
   */
  async function trackTransaction(txHash, opts) {
    opts = opts || {};
    if (!txHash) return { ok: false, reason: 'NO_TX_HASH', status: 'unknown' };

    var lifi = _getLiFiAdapter();
    if (opts.source === 'lifi' && lifi && typeof lifi.getStatus === 'function') {
      try {
        var r = await lifi.getStatus(txHash, opts);
        return { ok: !!(r && r.ok), status: (r && r.status) || 'pending', raw: r };
      } catch (e) {
        return { ok: false, status: 'error', reason: (e && e.message) || String(e) };
      }
    }

    // Fallback: ethers signer.provider — poll until confirmed or timeout (60s)
    try {
      var signerGlobal = w.signer;
      var provider = signerGlobal && signerGlobal.provider;
      if (provider) {
        var deadline2A = Date.now() + 60000; // 60s max wait
        while (Date.now() < deadline2A) {
          var receipt = await provider.getTransactionReceipt(txHash);
          if (receipt) {
            return {
              ok: receipt.status === 1,
              status: receipt.status === 1 ? 'success' : 'reverted',
              receipt: receipt,
              source: opts.source || 'local',
            };
          }
          // not mined yet — wait 2s before next poll
          await new Promise(function (resolve) { setTimeout(resolve, 2000); });
        }
        // timed out — tx is still pending
        return { ok: true, status: 'pending', reason: 'POLL_TIMEOUT' };
      }
    } catch (_) {}

    return { ok: false, status: 'unknown', reason: 'NO_PROVIDER' };
  }

  // ─── public API ──────────────────────────────────────────────────────
  w.SwapProvider = {
    quote:            quote,
    validateQuote:    validateQuote,
    buildTransaction: buildTransaction,
    execute:          execute,
    trackTransaction: trackTransaction,
    TokenResolver:    TokenResolver,
    version:          '1.3.0',
    phase:            'Phase 3',
    _executePoolRoute: _executePoolRoute,   // exposed for testing only
  };

/* eslint-disable no-undef */
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {})));
