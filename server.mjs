// agent-api — pay-per-call URL-to-text extractor.
//
// Go-live is a config flip, not a code change:
//   * NETWORK env var: "eip155:84532" (Base Sepolia testnet, default) or
//     "eip155:8453" (Base mainnet).
//   * FACILITATOR_URL env var: testnet default is
//     https://x402.org/facilitator — the official x402 docs say to never
//     use it for mainnet. Point it at a production facilitator for mainnet.
//   * PAY_TO_ADDRESS env var: the wallet that receives the $0.01 payments.
// The server refuses to start on mainnet with the testnet facilitator.

import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { extractUrl, ExtractionError } from "./extract.mjs";

const PORT = Number(process.env.PORT) || 4021;
const PRICE = "$0.01";
// Default is Base Sepolia testnet. Set NETWORK=eip155:8453 for Base mainnet.
const NETWORK = process.env.NETWORK || "eip155:84532";
const IS_MAINNET = NETWORK === "eip155:8453";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const PAY_TO =
  process.env.PAY_TO_ADDRESS ||
  "0x000000000000000000000000000000000000dEaD"; // placeholder — set PAY_TO_ADDRESS

if (IS_MAINNET && FACILITATOR_URL.includes("x402.org")) {
  console.error(
    "[fatal] NETWORK is Base mainnet but FACILITATOR_URL is the x402.org\n" +
      "       TESTNET facilitator — mainnet payments through it will fail.\n" +
      "       Set FACILITATOR_URL to a production facilitator, e.g.\n" +
      "       https://facilitator.payai.network"
  );
  process.exit(1);
}

if (!process.env.PAY_TO_ADDRESS) {
  console.warn(
    "[warn] PAY_TO_ADDRESS is not set — using a placeholder burn address.\n" +
      "       Paid calls will fail at settlement. Set PAY_TO_ADDRESS to a\n" +
      "       wallet you control on the configured network."
  );
}
if (!FACILITATOR_URL.includes("x402.org")) {
  console.warn(
    `[warn] FACILITATOR_URL is not the public testnet facilitator: ${FACILITATOR_URL}`
  );
}

const app = express();
app.use(express.json({ limit: "50kb" }));

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme()
);

app.use(
  paymentMiddleware(
    {
      "POST /extract": {
        accepts: {
          scheme: "exact",
          price: PRICE,
          network: NETWORK,
          payTo: PAY_TO,
          maxTimeoutSeconds: 300,
        },
        description:
          "Extract clean readable text (page title + body) from any public URL",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

// Public (unpaid) routes
app.get("/", (_req, res) => {
  res.json({
    name: "agent-api: URL-to-text extractor",
    usage: 'POST /extract with JSON body { "url": "https://example.com/article" }',
    price: PRICE,
    network: NETWORK,
    mode: IS_MAINNET
      ? "MAINNET — real USDC payments"
      : "TESTNET — no real money changes hands",
    health: "/health",
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mainnet: IS_MAINNET, network: NETWORK, price: PRICE });
});

// Paid route — the x402 middleware above verifies + settles payment
// (settlement happens only after this handler responds successfully).
app.post("/extract", async (req, res) => {
  const { url } = req.body ?? {};
  if (typeof url !== "string" || !url.trim()) {
    return res.status(400).json({
      error: 'Missing "url". Send JSON like { "url": "https://example.com" }.',
    });
  }
  try {
    const result = await extractUrl(url.trim());
    res.json({ ...result, price: PRICE, network: NETWORK, mainnet: IS_MAINNET });
  } catch (err) {
    const status = err instanceof ExtractionError ? err.status : 500;
    res.status(status).json({ error: err.message || "Extraction failed." });
  }
});

app.listen(PORT, () => {
  console.log(`agent-api listening on http://localhost:${PORT}`);
  console.log(
    `POST /extract costs ${PRICE} on ${NETWORK} (${IS_MAINNET ? "MAINNET" : "TESTNET"})`
  );
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Pay to: ${PAY_TO}`);
});
