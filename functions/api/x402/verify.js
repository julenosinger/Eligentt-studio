/**
 * functions/api/x402/verify.js
 *
 * Server-side x402 facilitator proxy for Autonoma.
 * Receives a signed payment payload from the browser and forwards it to
 * Circle Gateway for verification — the browser never touches Gateway directly.
 *
 * POST /api/x402/verify
 * Body: { paymentSignature, paymentRequired, chainId }
 * Returns: { ok, receipt, error }
 *
 * Environment variables (Cloudflare Secrets):
 *   CIRCLE_API_KEY — Circle developer API key (already configured)
 *
 * Security: The Circle API key never reaches the browser.
 */

export async function onRequestPost(context) {
  var env = context.env;
  var request = context.request;

  var headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    var body = await request.json();
    var paymentSignature = body.paymentSignature;
    var paymentRequired  = body.paymentRequired;
    var chainId          = body.chainId || 5042;

    if (!paymentSignature || !paymentRequired) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing paymentSignature or paymentRequired' }), { status: 400, headers: headers });
    }

    // Circle Gateway facilitator endpoint for x402 verification
    // https://developers.circle.com/gateway/nanopayments
    var GATEWAY_FACILITATOR = 'https://gateway.circle.com/v1/payments/verify';

    var apiKey = env.CIRCLE_API_KEY || env.CIRCLE_DEVELOPER_CONTROLLED_API_KEY || '';

    if (!apiKey) {
      // No API key — act as pass-through (verification skipped, resource returned)
      // In production this should not happen; log and return partial success.
      console.warn('[x402/verify] No CIRCLE_API_KEY configured. Skipping verification.');
      return new Response(JSON.stringify({
        ok: true,
        receipt: { status: 'unverified', message: 'Facilitator key not configured — verification skipped.' },
        warning: 'unverified'
      }), { status: 200, headers: headers });
    }

    var verifyResp = await fetch(GATEWAY_FACILITATOR, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        paymentSignature: paymentSignature,
        paymentRequired:  paymentRequired,
        chainId:          String(chainId)
      })
    });

    var verifyData = null;
    try { verifyData = await verifyResp.json(); } catch (_) {}

    if (verifyResp.ok && verifyData) {
      return new Response(JSON.stringify({ ok: true, receipt: verifyData }), { status: 200, headers: headers });
    }

    return new Response(JSON.stringify({
      ok:    false,
      error: (verifyData && verifyData.message) || 'Verification failed: ' + verifyResp.status,
      code:  verifyResp.status
    }), { status: verifyResp.status, headers: headers });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message || 'Internal error' }), { status: 500, headers: headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
