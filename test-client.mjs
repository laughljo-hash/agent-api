// test-client.mjs — exercise the x402 payment flow against agent-api.
//
// Step 1 (no wallet needed): sends an unpaid request and shows the 402
//         challenge the server returns.
// Step 2 (needs a funded wallet on the server's network): pays $0.01 in USDC
//         and gets the extraction result back.
//
// Usage:
//   node test-client.mjs [baseUrl] [pageUrl]
//   # e.g. node test-client.mjs http://localhost:4021 https://example.com
//
//   # Full paid test (throwaway key on testnet — NEVER a mainnet key):
//   TEST_PRIVATE_KEY=0x... node test-client.mjs http://localhost:4021 https://example.com
//
//   # Match a mainnet server:
//   NETWORK=eip155:8453 TEST_PRIVATE_KEY=0x... node test-client.mjs https://your-host https://example.com
//
// Get free Base Sepolia testnet USDC from a faucet such as
// https://faucet.circle.com (select Base Sepolia). The facilitator settles
// gaslessly, so the test wallet needs USDC but no ETH.

import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const baseUrl = (process.argv[2] || "http://localhost:4021").replace(/\/$/, "");
const pageUrl = process.argv[3] || "https://example.com";
// Match the server's network: default Base Sepolia testnet, or Base mainnet.
const NETWORK = process.env.NETWORK || "eip155:84532";
const body = JSON.stringify({ url: pageUrl });
const jsonHeaders = { "Content-Type": "application/json" };

// ---------- Step 1: prove the 402 challenge (no wallet) ----------
console.log("== Step 1: unpaid request (expect HTTP 402) ==");
const plain = await fetch(`${baseUrl}/extract`, {
  method: "POST",
  headers: jsonHeaders,
  body,
});
console.log("status:", plain.status, plain.statusText);
if (plain.status === 402) {
  const challenge = plain.headers.get("payment-required");
  console.log("PAYMENT-REQUIRED header present:", Boolean(challenge));
  if (challenge) {
    // v2 challenge is base64-encoded JSON in the header
    const decoded = JSON.parse(
      Buffer.from(challenge, "base64").toString("utf8")
    );
    const a = decoded.accepts?.[0] ?? {};
    console.log("challenge:", {
      x402Version: decoded.x402Version,
      scheme: a.scheme,
      network: a.network,
      amount: a.amount,
      asset: a.asset,
      payTo: a.payTo,
      description: decoded.resource?.description,
    });
  }
} else {
  console.log("unexpected body:", (await plain.text()).slice(0, 300));
  process.exit(1);
}

// ---------- Step 2: pay and extract (testnet wallet) ----------
console.log(
  `\n== Step 2: paid request on ${NETWORK} (${NETWORK === "eip155:8453" ? "MAINNET — real funds" : "testnet"}) ==`
);
let privateKey = process.env.TEST_PRIVATE_KEY;
if (!privateKey) {
  const fresh = generatePrivateKey();
  const acct = privateKeyToAccount(fresh);
  console.log("No TEST_PRIVATE_KEY set — generated a THROWAWAY testnet wallet:");
  console.log("  address:    ", acct.address);
  console.log("  private key:", fresh);
  console.log(
    "\n*** TESTNET ONLY. Never reuse this key anywhere real, never send it\n" +
      "*** real funds, and never use a key that has touched mainnet. ***\n"
  );
  console.log(
    "Fund it with Base Sepolia USDC from a faucet (e.g. https://faucet.circle.com),\n" +
      "then re-run with:\n  TEST_PRIVATE_KEY=<the key above> node test-client.mjs " +
      `${baseUrl} ${pageUrl}`
  );
  process.exit(0);
}

const account = privateKeyToAccount(privateKey);
console.log("paying as:", account.address);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: NETWORK,
      client: new ExactEvmScheme(account),
    },
  ],
});

try {
  const res = await fetchWithPayment(`${baseUrl}/extract`, {
    method: "POST",
    headers: jsonHeaders,
    body,
  });
  console.log("paid status:", res.status, res.statusText);
  const data = await res.json();
  if (!res.ok) {
    console.log("error:", JSON.stringify(data, null, 2).slice(0, 1000));
    process.exit(1);
  }
  console.log("title:", data.title);
  console.log("chars:", data.chars);
  console.log("paywallSuspected:", data.paywallSuspected);
  console.log("text preview:\n" + String(data.text).slice(0, 500));
  const receipt = res.headers.get("payment-response");
  console.log("\nPAYMENT-RESPONSE receipt present:", Boolean(receipt));
} catch (err) {
  console.error("paid request failed:", err.message);
  process.exit(1);
}
