# agent-api — pay-per-call URL-to-text extractor

An API that an AI agent would genuinely use: **POST a URL, get back the page
title + cleaned readable text** — with basic error handling for bad URLs,
timeouts, oversized pages, and paywall detection.

Payment uses the [x402 protocol](https://www.x402.org/) (HTTP `402 Payment
Required`): an agent calls the endpoint, gets a 402 challenge, signs a $0.01
USDC payment with its wallet, retries, and the facilitator verifies + settles
it on-chain. No API keys, no accounts.

> **TEST MODE ONLY.** This project is wired to **Base Sepolia testnet**
> (`eip155:84532`) and the public testnet facilitator
> (`https://x402.org/facilitator`). **It cannot take real money.** Until you
> complete the go-live steps below, every payment is worthless testnet USDC.

## What it does

| Endpoint        | Auth      | Description                                                     |
| --------------- | --------- | --------------------------------------------------------------- |
| `GET /`         | none      | API info: price, network, usage                                 |
| `GET /health`   | none      | Liveness check                                                  |
| `POST /extract` | **$0.01** | `{ "url": "https://…" }` → `{ title, text, chars, finalUrl, paywallSuspected }` |

`POST /extract` without payment returns **HTTP 402** with the x402 v2
challenge in the `PAYMENT-REQUIRED` header. With a valid payment, the
middleware verifies it via the facilitator and settles **only after the
extraction succeeds** (you're never charged for a failed call).

Extraction details (`extract.mjs`, zero extra dependencies):
- follows redirects, 15s timeout, 2 MB download cap
- strips scripts/styles/nav/footer boilerplate, decodes HTML entities
- returns `paywallSuspected: true` when the page looks gated
- blocks `localhost` / private-network URLs (basic SSRF guard)

## Run locally

```bash
cd ~/workspace/your_files/agent-api
npm install
cp .env.example .env   # optional; defaults work out of the box
npm start
# → agent-api listening on http://localhost:4021
```

`PAY_TO_ADDRESS` defaults to a placeholder burn address with a loud warning.
That's fine for testing the 402 challenge; set a real Base Sepolia address in
`.env` to test actual settlement.

## Test the payment flow

**Step 1 — the 402 challenge (no wallet needed):**

```bash
npm run test-client -- http://localhost:4021 https://example.com
```

You should see `status: 402 Payment Required` and a decoded challenge like:

```
{ x402Version: 2, scheme: 'exact', network: 'eip155:84532',
  amount: '10000', asset: '0x036C…F7e', payTo: '0x000…dEaD', … }
```

(`amount: '10000'` = $0.01 in USDC's 6 decimals; the asset is the canonical
Base Sepolia USDC contract.)

**Step 2 — the full paid call (testnet wallet needed):**

1. The test client prints a fresh **throwaway** testnet wallet address + key
   (or set your own throwaway key via `TEST_PRIVATE_KEY=0x…`).
   **Never use a key that has touched mainnet. Never send it real funds.**
2. Fund it with free Base Sepolia USDC from a faucet
   (e.g. https://faucet.circle.com → Base Sepolia).
3. Set `PAY_TO_ADDRESS` in `.env` to a Base Sepolia address you control and
   restart the server.
4. Re-run:
   ```bash
   TEST_PRIVATE_KEY=0x… npm run test-client -- http://localhost:4021 https://example.com
   ```
   You should get `paid status: 200`, the extracted text, and a
   `PAYMENT-RESPONSE` receipt header. The facilitator settles gaslessly, so
   the buyer wallet needs USDC but no ETH.

## Go-live checklist (you must do these yourself)

Until every step is done, **this API cannot earn real money**. Nothing here
creates wallets, touches mainnet, or moves real funds.

1. **Create a receiving wallet.** Install Coinbase Wallet / MetaMask / any EVM
   wallet, create a fresh address, and back up the seed phrase. You'll only
   ever paste the *address* (never the seed/private key) into config.
2. **Deploy to a public HTTPS host.** x402 buyers must reach your API over the
   public internet.
   - **Easiest (runs this code as-is):** Render free tier — new Web Service →
     push this folder to a GitHub repo and connect it → build `npm install`,
     start `npm start`. Set env vars in the Render dashboard (step 4).
   - Cloudflare Workers / Vercel serverless: this Express code won't run
     there directly — you'd port `server.mjs` to the official
     [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) middleware,
     which the x402 docs show working on Workers.
3. **Flip the three go-live env vars** (no code changes needed):
   - `NETWORK=eip155:8453` (Base mainnet)
   - `FACILITATOR_URL=https://facilitator.payai.network` (production
     facilitator — the x402.org one is testnet-only and the server will
     refuse to start on mainnet with it)
   - `PAY_TO_ADDRESS=0x…` (your wallet address from step 1)
4. **Sanity-test with a tiny real payment** from a second wallet you control
   before telling anyone about it:
   ```bash
   NETWORK=eip155:8453 TEST_PRIVATE_KEY=0x… node test-client.mjs https://your-host https://example.com
   ```
5. **Get discovered (optional):** list the endpoint in agent directories such
   as the x402 Bazaar so agents can find and pay for it.

## Files

- `server.mjs` — Express app + official `@x402/express` payment middleware
- `extract.mjs` — URL fetch + HTML→clean-text logic, error handling
- `test-client.mjs` — proves the 402 flow, then the paid flow (official
  `@x402/fetch` buyer pattern)
- `.env.example` — `PAY_TO_ADDRESS`, `FACILITATOR_URL`, `PORT`
- `package.json` — deps: `express`, `@x402/express`, `@x402/core`, `@x402/evm`
  (dev: `@x402/fetch`, `viem` for the test client only)

## Honest limitations

- Heuristic text extraction, not a full reader-mode engine: JS-rendered
  pages and hard paywalls return errors or thin text (flagged via
  `paywallSuspected`).
- The SSRF guard is hostname-based; a production service facing the open
  internet should resolve + re-check IPs (DNS rebinding) and add rate
  limiting.
- x402 agent payments are a brand-new market. This is real, working
  infrastructure — but "agents find it and pay" is not automatic; discovery
  and demand are the hard part.
