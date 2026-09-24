/**
 * autonomaX402.js — x402 Payment Protocol client for Autonoma
 *
 * Implements the x402 HTTP payment negotiation protocol using Circle Gateway
 * Nanopayments (EIP-3009 TransferWithAuthorization, gasless, offchain signing).
 *
 * Flow:
 *   1. Client GETs a resource → server returns 402 + PAYMENT-REQUIRED header
 *   2. Client reads payment requirements (amount, payTo, network, scheme)
 *   3. Client signs EIP-3009 authorization with user's browser wallet (gasless)
 *   4. Client retries with PAYMENT-SIGNATURE header
 *   5. Server verifies via Circle Gateway facilitator → returns 200 + resource
 *
 * Security:
 *   - User signs with their own browser wallet (non-custodial)
 *   - No private keys stored or transmitted
 *   - Facilitator verification via /api/x402/verify (server-side)
 *   - Payment payload never contains the private key
 *
 * Arc Mainnet: Chain ID 5042, USDC 0x89b50...
 */
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  var FACILITATOR_URL = '/api/x402/verify';

  // USDC contract address on supported chains (mainnet)
  var USDC_ADDRESSES = {
    5042:  '0x89b508b6a6C2Ca08D03e4a7C15bDB6D9B1d2843B', // Arc Mainnet
    1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum
    8453:  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base
    42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
    10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
    137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'  // Polygon
  };

  // EIP-712 domain for TransferWithAuthorization (EIP-3009)
  // The "exact" x402 scheme uses GatewayWalletBatched domain for Nanopayments.
  // For standard EIP-3009 USDC the domain name is "USD Coin".
  var EIP3009_TYPE_HASH = '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267'; // TransferWithAuthorization

  var _history = []; // [{url, amount, token, chain, ts, status, txHash}]
  var _gatewayBalance = null; // cached gateway balance

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Parse the PAYMENT-REQUIRED header (JSON-encoded object).
   * Spec: { scheme, network, payTo, maxAmountRequired, resource }
   */
  function _parsePaymentRequired(header) {
    try {
      if (!header) return null;
      // The header may be a JSON object or a base64-encoded JSON
      var decoded = header;
      if (!header.startsWith('{')) {
        decoded = atob(header);
      }
      return JSON.parse(decoded);
    } catch (e) {
      console.warn('[x402] Failed to parse PAYMENT-REQUIRED header:', e);
      return null;
    }
  }

  /**
   * Build EIP-3009 TransferWithAuthorization typed data for signing.
   * This is the "exact" scheme payload used by Circle Nanopayments.
   */
  function _buildEIP3009Payload(opts) {
    // opts: { from, to, value (bigint), validAfter, validBefore, nonce, chainId, tokenAddress, tokenName }
    var domain = {
      name: opts.tokenName || 'USD Coin',
      version: opts.tokenVersion || '2',
      chainId: opts.chainId,
      verifyingContract: opts.tokenAddress
    };

    var types = {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' }
      ]
    };

    var message = {
      from:        opts.from,
      to:          opts.to,
      value:       opts.value.toString(),
      validAfter:  opts.validAfter.toString(),
      validBefore: opts.validBefore.toString(),
      nonce:       opts.nonce
    };

    return { domain: domain, types: types, message: message };
  }

  /**
   * Generate a random 32-byte hex nonce for EIP-3009.
   */
  function _randomNonce() {
    var arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return '0x' + Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /**
   * Get the USDC token metadata for a chain (name + version for EIP-712 domain).
   * EURC uses "EUR Coin" / version "2". USDC uses "USD Coin" / version "2".
   */
  function _getTokenMeta(chainId, token) {
    token = (token || 'USDC').toUpperCase();
    var addr = USDC_ADDRESSES[chainId];
    if (token === 'EURC') {
      // EURC addresses (mainnet)
      var EURC = {
        5042:  '0x3EE5f5DC28F13ef7a18BED70b0e1f7e03e5EB944',
        1:     '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
        8453:  '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
        42161: '0x37f77F7d3f9fb5F27d57bBb12a3cA80E9FC9Ca94'
      };
      addr = EURC[chainId] || addr;
    }
    return {
      address: addr,
      name: token === 'EURC' ? 'EUR Coin' : 'USD Coin',
      version: '2',
      decimals: token === 'EURC' ? 6 : 6
    };
  }

  /**
   * Sign the EIP-3009 payload with the user's connected wallet (MetaMask / EIP-1193).
   * Returns signature hex string.
   */
  async function _signEIP3009(typedData, fromAddress) {
    var provider = window.ethereum;
    if (!provider) throw new Error('No wallet provider found. Connect MetaMask.');

    var params = [
      fromAddress,
      JSON.stringify({
        domain: typedData.domain,
        types: Object.assign({ EIP712Domain: [
          { name: 'name',              type: 'string'  },
          { name: 'version',           type: 'string'  },
          { name: 'chainId',           type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ] }, typedData.types),
        primaryType: 'TransferWithAuthorization',
        message: typedData.message
      })
    ];

    var sig = await provider.request({
      method: 'eth_signTypedData_v4',
      params: params
    });
    return sig;
  }

  /**
   * Build the PAYMENT-SIGNATURE header value from signed EIP-3009 payload.
   * Format: base64(JSON({ scheme, payload, signature }))
   */
  function _buildPaymentSignatureHeader(scheme, typedData, signature) {
    var payload = {
      scheme:    scheme || 'exact',
      payload:   typedData.message,
      signature: signature
    };
    return btoa(JSON.stringify(payload));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * x402-aware fetch. Automatically handles the 402 negotiation flow.
   *
   * @param {string} url - Resource URL to fetch
   * @param {object} opts - fetch options + { walletAddress, chainId, token }
   * @returns {Promise<{ok, status, data, paymentMade, amount, error}>}
   */
  async function x402Fetch(url, opts) {
    opts = opts || {};
    var chainId    = opts.chainId    || 5042;
    var walletAddr = opts.walletAddress || (window._elligenttWallet && window._elligenttWallet.address);
    var token      = opts.token      || 'USDC';

    // Step 1: Initial request
    var result = { ok: false, status: 0, data: null, paymentMade: false, amount: '0', error: null };

    try {
      var resp1 = await fetch(url, {
        method:  opts.method  || 'GET',
        headers: opts.headers || {},
        body:    opts.body    || undefined
      });

      result.status = resp1.status;

      // 200: resource returned without payment
      if (resp1.ok) {
        result.ok   = true;
        result.data = await resp1.text();
        return result;
      }

      // Non-402 error
      if (resp1.status !== 402) {
        result.error = 'HTTP ' + resp1.status;
        return result;
      }

      // Step 2: Parse PAYMENT-REQUIRED header
      var prHeader = resp1.headers.get('PAYMENT-REQUIRED') ||
                     resp1.headers.get('payment-required')  ||
                     resp1.headers.get('X-Payment-Required');

      var pr = _parsePaymentRequired(prHeader);
      if (!pr) {
        // Try parsing from body
        try { pr = await resp1.json(); } catch (_) {}
      }
      if (!pr) {
        result.error = 'Missing or invalid PAYMENT-REQUIRED header';
        return result;
      }

      if (!walletAddr) {
        result.error = 'Wallet not connected. Connect your wallet to use x402 paid resources.';
        return result;
      }

      // Step 3: Build EIP-3009 authorization
      var tokenMeta  = _getTokenMeta(chainId, token);
      var amountRaw  = BigInt(pr.maxAmountRequired || pr.amount || '1000'); // base units
      var now        = Math.floor(Date.now() / 1000);
      var validAfter = 0;
      var validBefore = now + 300; // 5 min window
      var nonce      = _randomNonce();

      var typedData = _buildEIP3009Payload({
        from:         walletAddr,
        to:           pr.payTo || pr.recipient,
        value:        amountRaw,
        validAfter:   validAfter,
        validBefore:  validBefore,
        nonce:        nonce,
        chainId:      chainId,
        tokenAddress: tokenMeta.address,
        tokenName:    tokenMeta.name,
        tokenVersion: tokenMeta.version
      });

      // Step 4: Sign with user's wallet
      var signature = await _signEIP3009(typedData, walletAddr);

      // Step 5: Retry with PAYMENT-SIGNATURE
      var sigHeader = _buildPaymentSignatureHeader(pr.scheme || 'exact', typedData, signature);

      var resp2 = await fetch(url, {
        method:  opts.method  || 'GET',
        headers: Object.assign({}, opts.headers || {}, {
          'PAYMENT-SIGNATURE': sigHeader
        }),
        body: opts.body || undefined
      });

      result.status      = resp2.status;
      result.paymentMade = true;
      result.amount      = (Number(amountRaw) / Math.pow(10, tokenMeta.decimals)).toFixed(6);

      if (resp2.ok) {
        result.ok   = true;
        result.data = await resp2.text();
        // Record in history
        _history.unshift({
          url:    url,
          amount: result.amount,
          token:  token,
          chain:  chainId,
          ts:     Date.now(),
          status: 'confirmed',
          paymentResponse: resp2.headers.get('PAYMENT-RESPONSE') || null
        });
        if (_history.length > 50) _history.pop();
      } else {
        result.error = 'Payment accepted but resource returned ' + resp2.status;
        _history.unshift({
          url:    url,
          amount: result.amount,
          token:  token,
          chain:  chainId,
          ts:     Date.now(),
          status: 'failed'
        });
      }

      return result;

    } catch (e) {
      result.error = e.message || String(e);
      // User rejected signature
      if (e.code === 4001 || (e.message && e.message.includes('reject'))) {
        result.error = 'Payment signature rejected by user.';
      }
      return result;
    }
  }

  /**
   * Check if x402 is usable (wallet connected + on supported chain).
   */
  function x402IsReady() {
    var addr = window._elligenttWallet && window._elligenttWallet.address;
    var chain = window._elligenttWallet && window._elligenttWallet.chainId;
    return !!(addr && USDC_ADDRESSES[chain]);
  }

  /**
   * Get x402 payment history (most recent first).
   */
  function x402GetHistory() {
    return _history.slice();
  }

  /**
   * Format a PAYMENT-REQUIRED response for display in Autonoma chat.
   */
  function x402FormatPaymentInfo(pr) {
    if (!pr) return 'No payment info available.';
    var amount = pr.maxAmountRequired || pr.amount || '?';
    var decimals = 6;
    var usd = (Number(amount) / Math.pow(10, decimals)).toFixed(4);
    return [
      '<div class="x402-info">',
      '  <div class="x402-row"><span class="x402-label">Amount required:</span> <span class="x402-val">' + usd + ' USDC</span></div>',
      '  <div class="x402-row"><span class="x402-label">Scheme:</span> <span class="x402-val">' + (pr.scheme || 'exact') + '</span></div>',
      '  <div class="x402-row"><span class="x402-label">Pay to:</span> <span class="x402-val">' + (pr.payTo || '-') + '</span></div>',
      '</div>'
    ].join('');
  }

  // ── Expose globally ────────────────────────────────────────────────────────

  window.AutonomaX402 = {
    fetch:          x402Fetch,
    isReady:        x402IsReady,
    getHistory:     x402GetHistory,
    formatPayInfo:  x402FormatPaymentInfo,
    USDC_ADDRESSES: USDC_ADDRESSES
  };

}());
