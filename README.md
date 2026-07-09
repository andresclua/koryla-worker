# koryla-worker

Cloudflare Worker that powers edge A/B testing for [Koryla](https://koryla.com).

Deploy this worker in front of any site — Webflow, Readymag, Framer, Netlify, or a plain HTML site — and Koryla will split traffic, assign variants, and track impressions and conversions without touching your site's code.

## How it works

```
Visitor → Cloudflare Worker → your site
               ↓
         fetches experiment config from Koryla API (cached 60s in KV)
         assigns variant via cookie (sticky sessions)
         proxies request to variant URL — no redirect, no flicker
         fires impression / conversion events to Koryla
```

## Prerequisites

- A [Koryla](https://koryla.com) account with at least one active experiment
- A Cloudflare account (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/koryla/koryla-worker
cd koryla-worker
npm install
```

### 2. Create a KV namespace

```bash
wrangler kv:namespace create KORYLA_CONFIG
```

Copy the `id` from the output and paste it in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KORYLA_CONFIG"
id = "your-kv-namespace-id-here"
```

### 3. Set your API key

In your Koryla dashboard, go to **Settings → API Keys** and create a new key. Then:

```bash
wrangler secret put KORYLA_API_KEY
# paste your koryla_live_... key when prompted
```

### 4. Configure the worker route

In `wrangler.toml`, add a route for your domain:

```toml
routes = [
  { pattern = "yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Your domain must be on Cloudflare (DNS managed by Cloudflare).

### 5. Deploy

```bash
npm run deploy
```

## Local development

```bash
npm run dev
```

The worker runs at `http://localhost:8787` and proxies to your site.

## How experiments work

Create an experiment in Koryla with:
- **Base URL**: the path to intercept (e.g. `https://yourdomain.com/pricing`)
- **Variants**: Control keeps the original URL; other variants redirect to alternate pages (e.g. `/pricing-v2`)
- **Conversion URL**: the page that signals a successful conversion (e.g. `/thank-you`)

The worker:
- Assigns each visitor to a variant on first visit (weighted random)
- Stores the assignment in a cookie (`ky_<experiment_id>`) — sticky for 30 days
- Proxies the request to the variant URL without a visible redirect
- Fires impression and conversion events to Koryla

## Environment variables

| Variable | Description |
|---|---|
| `KORYLA_API_URL` | Your Koryla instance URL (default: `https://koryla.com`) |
| `KORYLA_API_KEY` | Your workspace API key — set as a secret, never in `wrangler.toml` |
| `KORYLA_CONFIG` | KV namespace binding for experiment config cache |
