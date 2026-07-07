# Schwab MCP Server

A Model Context Protocol (MCP) server that enables AI assistants like Claude to
securely interact with Charles Schwab accounts and market data through the
official Schwab API.

**Invited by someone who runs this server?** You don't need to read the
technical parts — jump straight to the
[Guide for Invited Users](#guide-for-invited-users-no-coding-required).

## What You Can Do

Ask Claude to:

- "Get real-time quotes for AAPL, GOOGL, and MSFT"
- "What are today's market movers in the $SPX?"
- "Show me the options chain for TSLA with Greeks"
- "Search for ETFs related to technology"
- "Check if the markets are open"

And with full access (account tools are off by default — see
[per-user tool scoping](#access-control-invite-only-enrollment)):

- "Show me my Schwab account balances and positions"
- "Get my transactions from the last 30 days"

## Unofficial MCP Server

This is an unofficial, community-developed TypeScript MCP server for Charles
Schwab. It has not been approved, endorsed, or certified by Charles Schwab. It
is provided as-is, and its functionality may be incomplete or unstable. Use at
your own risk, especially when dealing with financial data or transactions.

## Guide for Invited Users (No Coding Required)

Someone you know runs this server and invited you to use it. Once connected,
you can ask your AI assistant (Claude or ChatGPT) things like _"Get quotes
for AAPL and MSFT"_, _"Show me the TSLA options chain"_, or _"Are the markets
open today?"_ — and it answers with live data from Schwab.

This guide takes you from invite to first quote. No technical knowledge
needed.

### Market data only — account access is disabled by default

Even though you log in with your Schwab brokerage account, your assistant
only gets **market data** tools. Nothing that touches your accounts is made
available to it unless the server owner explicitly enables that for you.

**What the assistant can do:**

- Look up real-time quotes for stocks, ETFs, and indexes
- Get historical price data
- Retrieve options chains and expiration dates
- List the day's market movers
- Check market hours
- Search for instruments (e.g. find ETFs by keyword)

**What the assistant cannot do (disabled by default):**

- See your account balances, positions, or holdings
- See your transaction history
- Place, change, or cancel orders — no trading of any kind
- See your account numbers or preferences

These aren't just blocked — the account tools are never handed to the
assistant in the first place. If you ask "what's in my portfolio?", it
simply has no tool that could answer, the same as if the server didn't
support accounts at all.

Why log in with your Schwab account then? Two reasons: it proves to the
server who you are, and Schwab uses your account's entitlements to decide
whether you get real-time or delayed quotes.

If you later want the assistant to see your accounts, ask the server owner —
they can enable full access for you specifically, and it takes effect the
next time you log in to Schwab.

### What you need

1. A **Charles Schwab brokerage login** (the same one you use at schwab.com).
2. From the server owner: the **server link** (looks like
   `https://something.workers.dev/mcp`) and a **one-time invite code**. The
   code is single-use and expires after 7 days, so connect soon after
   receiving it — if it expires, just ask for a new one.
3. A **Claude** (claude.ai) or **ChatGPT** (chatgpt.com) plan that supports
   custom connectors. Both currently require a paid plan for this.

### Connect in Claude (web or desktop)

1. Open **Settings → Connectors** and choose **Add custom connector**.
2. Give it a name (e.g. "Schwab") and paste the server link from the owner,
   then click **Add** and **Connect**.
3. An approval page from the server appears. **Click into the invite code
   field** (the page auto-continues after a few seconds; clicking pauses it),
   enter your invite code, and continue.
4. You are sent to **schwab.com** to log in — your password goes to Schwab,
   never to this server. Accept Schwab's terms.
5. Schwab asks you to **select one or more accounts to link**. This is a
   required step in Schwab's login and mainly determines your quote
   entitlements — remember the assistant gets no account tools by default,
   so it can't read what's in the account you pick.
6. You land back in Claude. Start a new chat and try: _"Get a quote for
   AAPL"_.

### Connect in ChatGPT (web)

ChatGPT calls these "connectors" too, but hides custom ones behind developer
mode (exact menu names shift as ChatGPT updates; if you don't see an option,
look for anything named "connectors" in settings):

1. Open **Settings → Apps & Connectors** (or **Connectors**) →
   **Advanced settings**, and turn on **Developer mode**.
2. Back in **Connectors**, choose **Create** (or **Add custom connector**).
3. Give it a name, paste the server link as the **MCP server URL**, select
   **OAuth** as authentication, and save.
4. The same approval page appears: click into the invite code field, enter
   your code, continue, then log in at schwab.com and select accounts (see
   the Claude steps above — same flow, same privacy notes).
5. In a new chat, enable the connector (via the tools/plus menu) and try:
   _"Get a quote for AAPL"_.

### Once a week: log in again

Schwab expires the connection every **7 days** — this is Schwab's rule, not
the server's. When the assistant tells you authentication expired, go back to
the connector settings and reconnect. You'll repeat the Schwab login, but
**no invite code is needed** after the first time.

### If something goes wrong

- **"Access denied" page after logging in:** your invite code was wrong,
  expired, or already used. Ask the owner for a fresh code and reconnect.
- **"Schwab authentication expired":** the weekly login lapsed — reconnect
  from the connector settings.
- **The assistant says it can't see your accounts:** that's by design (see
  above). Ask the owner for full access if you want it.
- **Anything else:** ask the person who invited you — they can see the
  server's logs.

### Privacy, briefly

You log in on schwab.com directly; this server never sees your password. It
stores encrypted Schwab tokens so you don't have to log in for every
question, and by default it exposes no account tools to your assistant. The
server is operated by the person who invited you — connecting means trusting
them to run it, the same way you'd trust any app you authorize with Schwab.

## Overview

This MCP server acts as a bridge between AI assistants and the Schwab API,
providing:

- **Secure OAuth Authentication**: Implements Schwab's OAuth 2.0 flow with PKCE
  for secure authentication
- **Comprehensive Trading Tools**: Access to accounts, orders, quotes, and
  transactions
- **Market Data Tools**: Real-time quotes, price history, market hours, movers,
  and options chains
- **Account Privacy**: Built-in account identifier scrubbing to protect
  sensitive information
- **Enterprise-Ready**: Deployed on Cloudflare Workers with Durable Objects for
  state management

## Features

Tool visibility is per-user: enrollments default to market-data-only, and
the trading tools below are registered only for users enrolled with
`"scope": "full"` (see
[Access Control](#access-control-invite-only-enrollment)). `getQuotes` and
`getQuoteBySymbolId` are market-data tools and available to everyone.

### Trading Tools

- **Account Management**
  - `getAccounts`: Retrieve all account information with positions and balances
  - `getAccountNumbers`: Get list of account identifiers
- **Order Management**
  - `getOrder`: Get order by ID
  - `getOrders`: Fetch orders with filtering by status, time range, and symbol
  - `getOrdersByAccountNumber`: Get orders by account number
  - `cancelOrder`: Cancel an order (Experimental)
  - `placeOrder`: Place an order (Experimental)
  - `replaceOrder`: Replace an order (Experimental)
- **Market Quotes**
  - `getQuotes`: Get real-time quotes for multiple symbols
  - `getQuoteBySymbolId`: Get detailed quote for a single symbol
- **Transaction History**
  - `getTransactions`: Retrieve transaction history across all accounts with
    date filtering
- **User Preferences**
  - `getUserPreference`: Retrieve user trading preferences and settings

### Market Data Tools

- **Instrument Search**
  - `searchInstruments`: Search for securities by symbol with
    fundamental/reference data
- **Price History**
  - `getPriceHistory`: Get historical price data with customizable periods and
    frequencies
- **Market Hours**
  - `getMarketHours`: Check market operating hours by date
  - `getMarketHoursByMarketId`: Get specific market information
- **Market Movers**
  - `getMovers`: Find top market movers by index ($SPX, $COMPX, $DJI)
- **Options Chains**
  - `getOptionChain`: Retrieve full options chain data with Greeks
  - `getOptionExpirationChain`: Get option expiration dates

## Prerequisites

1. **Schwab Developer Account**: Register at
   [Schwab Developer Portal](https://developer.schwab.com)
2. **Cloudflare Account**: For deployment (Workers paid plan required for
   Durable Objects)
3. **Node.js**: Version 22.x or higher
4. **Wrangler CLI**: Installed via npm (included in dev dependencies)

## Getting Started

### Quick Setup

```bash
git clone <repository-url>
cd schwab-mcp
npm install

# Authenticate with Cloudflare (first time only)
npx wrangler login

# Create KV namespace for OAuth token storage
npx wrangler kv:namespace create "OAUTH_KV"
# Note the ID from the output - you'll need it for configuration

# Set up your personal configuration
cp wrangler.example.jsonc wrangler.jsonc
# Edit wrangler.jsonc to:
# 1. Replace YOUR_KV_NAMESPACE_ID_HERE with the ID from above
# 2. Change the name to something unique (e.g., "schwab-mcp-yourname")

# Set your secrets
npx wrangler secret put SCHWAB_CLIENT_ID      # Your Schwab App Key
npx wrangler secret put SCHWAB_CLIENT_SECRET  # Your Schwab App Secret
npx wrangler secret put SCHWAB_REDIRECT_URI   # https://your-worker-name.workers.dev/callback
npx wrangler secret put COOKIE_ENCRYPTION_KEY # Generate with: openssl rand -hex 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY  # Generate with: openssl rand -hex 32 (encrypts Schwab tokens in KV)

# Deploy
npm run deploy
```

### Configuration Notes

- `wrangler.example.jsonc` - Template configuration (committed)
- `wrangler.jsonc` - Your personal config (git-ignored, created from template)
- `.dev.vars` - Local development secrets (git-ignored, optional)

Since `wrangler.jsonc` is git-ignored, you can safely develop and test with your
personal configuration without exposing secrets.

### Detailed Configuration

#### 1. Create a Schwab App

1. Log in to the [Schwab Developer Portal](https://developer.schwab.com)
2. Create a new app with:
   - **App Name**: Your MCP server name
   - **Callback URL**:
     `https://schwab-mcp.<your-subdomain>.workers.dev/callback`
   - **App Type**: Personal or third-party based on your use case
3. Note your **App Key** (Client ID) and generate an **App Secret**

#### 2. Set Environment Variables

The same secrets from Quick Setup need to be set (see above).

### Access Control: Invite-Only Enrollment

The server is invite-only. Anyone can reach the OAuth endpoints, but
authorization only completes for Schwab customers that are enrolled in a KV
allowlist. Identity is the stable `schwabClientCustomerId` that Schwab
returns after login, so users never need to know their own ID — the server
captures it automatically the first time they connect with a valid invite
code.

#### Owner: creating invite codes

Each invite code is a one-time-use KV entry. Generate one per person
(including yourself, for your very first connection after deploying):

```bash
# Generate and store an invite code (the note is just a label for you).
# --ttl makes the unredeemed code self-delete after 7 days.
CODE="<name>-$(date '+%Y_%m_%d')-$(openssl rand -hex 6)"
npx wrangler kv key put "invite:$CODE" '{"note":"for <name>"}' \
  --ttl 604800 --namespace-id <YOUR_OAUTH_KV_ID> --remote
echo "Invite code: $CODE"
```

By default an invite enrolls the person with **market-data-only** access:
quotes, price history, option chains, movers, market hours, instrument
search. The trader tools (accounts, orders, transactions) are not even
registered for them. To grant full access — e.g. for yourself — add
`"scope": "full"` to the invite value:

```bash
npx wrangler kv key put "invite:$CODE" '{"note":"for me","scope":"full"}' \
  --ttl 604800 --namespace-id <YOUR_OAUTH_KV_ID> --remote
```

Send the code to the person over a private channel. It is consumed on first
use, so a leaked code is worthless after redemption — and an unredeemed code
expires on its own after 7 days (KV deletes the key, and the server treats a
missing key as an invalid code).

#### User: connecting with an invite code

For a friendlier, step-by-step version to send to invitees, see the
[Guide for Invited Users](#guide-for-invited-users-no-coding-required).

1. Add the server URL (`https://<your-worker>.workers.dev/mcp`) as a custom
   connector in claude.ai or Claude Desktop.
2. On the approval screen, enter the invite code in the **Invite code**
   field. (The screen auto-continues after a few seconds; clicking into the
   field pauses it.)
3. Log in to Schwab as usual.

That's it — the server enrolls the account and deletes the invite code.
Subsequent re-authentications (Schwab requires one every 7 days) need no
code. Anyone who completes a Schwab login without being enrolled gets a
403 page, and their just-issued Schwab tokens are deleted immediately.

#### Owner: managing enrollment

Each `allowed:` key carries the invite code and note as KV metadata, so the
list command shows which person each enrolled customer ID belongs to:

```bash
# List enrolled customers with who-is-who metadata
npx wrangler kv key list --namespace-id <YOUR_OAUTH_KV_ID> --remote \
  | jq '.[] | select(.name | startswith("allowed:"))'
# → { "name": "allowed:ce62...", "metadata": { "inviteCode": "alex-2026_07_05-...", "note": "for alex", ... } }

# List outstanding (unredeemed) invite codes
npx wrangler kv key list --namespace-id <YOUR_OAUTH_KV_ID> --remote | grep invite:

# Revoke a user (they can no longer complete authorization;
# also delete their token:<customerId> entry to kill the active session)
npx wrangler kv key delete "allowed:<customerId>" --namespace-id <YOUR_OAUTH_KV_ID> --remote
npx wrangler kv key delete "token:<customerId>" --namespace-id <YOUR_OAUTH_KV_ID> --remote

# Cancel an unredeemed invite
npx wrangler kv key delete "invite:<code>" --namespace-id <YOUR_OAUTH_KV_ID> --remote
```

#### Owner: changing a user's tool scope

The enrollment record's `scope` field controls which tools the user sees:
`"market"` (or absent — the default) exposes market data only; `"full"` adds
the trader tools. To change it, rewrite the `allowed:` record preserving its
other fields:

```bash
# Inspect the current record
npx wrangler kv key get "allowed:<customerId>" --namespace-id <YOUR_OAUTH_KV_ID> --remote

# Upgrade to full access (keep the existing fields, add/replace scope)
npx wrangler kv key put "allowed:<customerId>" \
  '{"enrolledAt":"<keep>","inviteCode":"<keep>","note":"<keep>","scope":"full"}' \
  --namespace-id <YOUR_OAUTH_KV_ID> --remote
```

A scope change takes effect the next time the user re-authorizes with
Schwab (at most 7 days, when their refresh token expires), because the
scope is baked into the OAuth grant at authorization time. Enrollments
created before scopes existed have no `scope` field and are market-only.

### GitHub Actions Deployment

For automated deployments, add these GitHub repository secrets:

1. **`CLOUDFLARE_API_TOKEN`**: Your Cloudflare API token
2. **`OAUTH_KV_ID`**: Your KV namespace ID

The workflow handles validation and deployment when pushing to `main`.
Cloudflare secrets must still be set via `wrangler secret`.

### Testing with Inspector

Test your deployment using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Enter `https://schwab-mcp.<your-subdomain>.workers.dev/mcp` and connect. You'll
be prompted to authenticate with Schwab. (A legacy `/sse` endpoint is also
available for clients that haven't migrated to the current MCP Streamable
HTTP transport.)

## Usage

### Claude Desktop Configuration

### 1. Use Claude Integrations

1. Go to the [Claude Desktop](https://www.anthropic.com/docs/claude-desktop)
   settings
2. Click on the "Integrations" tab
3. Click on the "Add Custom Integration" button
4. Enter the integration name "Schwab"
5. Enter the MCP Server URL:
   `https://schwab-mcp.<your-subdomain>.workers.dev/mcp`
6. Click on the "Add" button
7. Click "Connect" and the Schwab Authentication flow will start.

### 2. Add the MCP Server to your Claude Desktop configuration

Add the following to your Claude Desktop configuration file:

```json
{
	"mcpServers": {
		"schwab": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"https://schwab-mcp.<your-subdomain>.workers.dev/mcp"
			]
		}
	}
}
```

Restart Claude Desktop. When you first use a Schwab tool, a browser window will
open for authentication.

### Example Commands

Once connected, you can ask Claude to:

- "Show me my Schwab account balances"
- "Get a quote for AAPL"
- "What are today's market movers in the $SPX?"
- "Show me the options chain for TSLA"
- "Get my recent transactions from the last week"

### Local Development

For local development, create a `.dev.vars` file (automatically ignored by git):

```env
SCHWAB_CLIENT_ID=your_development_app_key
SCHWAB_CLIENT_SECRET=your_development_app_secret
SCHWAB_REDIRECT_URI=http://localhost:8788/callback
COOKIE_ENCRYPTION_KEY=your_random_key_here
LOG_LEVEL=DEBUG  # Optional: Enable debug logging
```

Run locally:

```bash
npm run dev
# Server will be available at http://localhost:8788
```

Connect to `http://localhost:8788/mcp` using the MCP Inspector for testing
(`/sse` also still works for legacy clients).

## Architecture

### Technology Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Authentication**: OAuth 2.0 with PKCE via
  `@cloudflare/workers-oauth-provider`
- **API Client**: `@sudowealth/schwab-api` for type-safe Schwab API access
- **MCP Framework**: `@modelcontextprotocol/sdk` with `workers-mcp` adapter
- **State Management**: KV storage for tokens, Durable Objects for session state

### Security Features

1. **Invite-Only Access**: Authorization only completes for Schwab customers
   enrolled in a KV allowlist; first-time users enroll with a one-time invite
   code (see [Access Control](#access-control-invite-only-enrollment))
2. **Registration Lockdown**: Dynamic client registration (`/register`) only
   accepts redirect URIs on known MCP client hosts (claude.ai, claude.com,
   anthropic.com, chatgpt.com, openai.com, or localhost for dev tools), so
   authorization codes can't be routed to arbitrary callbacks. Edit
   `ALLOWED_REDIRECT_HOSTS` in `src/shared/constants.ts` to change the list.
3. **Auth Endpoint Rate Limiting**: `/register`, `/authorize`, `/token`, and
   `/callback` are limited to 15 requests/minute per IP via the Workers rate
   limiting binding (see `unsafe.bindings` in `wrangler.example.jsonc`;
   limiting is skipped if the binding is not configured)
4. **OAuth 2.0 with PKCE**: Secure authentication flow preventing authorization
   code interception
5. **Enhanced Token Management**:
   - Schwab tokens are AES-256-GCM encrypted (via the `TOKEN_ENCRYPTION_KEY`
     secret) before being written to KV, so KV read access alone cannot
     yield usable brokerage tokens
   - Centralized KV token store
   - Automatic token refresh (5 minutes before expiration)
   - 31-day token persistence with TTL
6. **Account Scrubbing**: Sensitive account identifiers are automatically
   replaced with display names
7. **State Security**: HMAC-SHA256 signatures for state parameter integrity
8. **Cookie Encryption**: Client approval state encrypted with AES-256
9. **Secret Redaction**: Automatic masking of sensitive data in logs

### Token Lifecycle & Re-authentication

The server sits between two independent OAuth relationships, each with its
own tokens:

| Token | Held by | Lifetime | Renewed by |
| --- | --- | --- | --- |
| MCP access token | MCP client (claude.ai, ChatGPT, ...) | 1 hour | Client, silently, via its refresh token at `/token` |
| MCP refresh token | MCP client | until revoked | Rotated on each refresh |
| Schwab access token | This worker (encrypted in KV) | ~30 minutes | Worker, automatically, 5 minutes before expiry |
| Schwab refresh token | This worker (encrypted in KV) | 7 days (Schwab hard limit) | Cannot be renewed — requires a fresh Schwab login |

The MCP client never sees Schwab tokens; the worker exchanges its own tokens
for Schwab API calls per request. Schwab tokens live in KV under
`token:<schwabClientCustomerId>` so all of a user's sessions (e.g. claude.ai
and ChatGPT) share one Schwab login.

**Weekly re-authentication is unavoidable**: Schwab expires refresh tokens
after 7 days and no code can extend that. When the worker finds the Schwab
leg dead (refresh token expired, or the token record is missing or
unreadable), it responds to `POST /mcp` with `401` and a `WWW-Authenticate`
header per the MCP spec. That is the signal MCP clients understand: the
client automatically re-runs its OAuth flow — approval screen, Schwab login
— and the worker stores fresh tokens. Enrolled users just complete the
Schwab login; no invite code is needed after the first time.

The corresponding log line is
`Schwab tokens unavailable; returning 401 to trigger client re-auth`. A
Schwab-side failure on an individual API call (e.g. access revoked at
schwab.com mid-session) still surfaces as a tool error until the locally
cached token expires (≤30 minutes), after which the 401 path takes over.

## Development

### Available Scripts

```bash
npm run dev          # Start development server on port 8788
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # Run TypeScript type checking
npm run lint         # Run ESLint with automatic fixes
npm run format       # Format code with Prettier
npm run validate     # Run typecheck and lint together
```

### Debugging

The server includes comprehensive logging with configurable levels:

- **Development**: Terminal output with colored logs
- **Production**: Cloudflare dashboard → Workers → Logs
- **Log Levels**: DEBUG, INFO, WARN, ERROR (set via LOG_LEVEL env var)

Enable debug logging to see detailed OAuth flow and API interactions:

```bash
# For local development
echo "LOG_LEVEL=DEBUG" >> .dev.vars

# For production
npx wrangler secret put LOG_LEVEL --secret="DEBUG"
```

### Error Handling

The server implements robust error handling with specific error types:

- **Authentication Errors (401)**: Prompt for re-authentication
- **Client Errors (400)**: Invalid parameters, missing data
- **Server Errors (500)**: API failures, configuration issues
- **Network Errors (503)**: Automatic retry with backoff
- All errors include request IDs for Schwab API troubleshooting

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT

## Troubleshooting

### Common Issues

1. **"KV namespace not found" error**

   - Ensure you created the KV namespace and updated `wrangler.jsonc`
   - Run `npx wrangler kv:namespace list` to verify

2. **Authentication failures**

   - Verify your redirect URI matches exactly in Schwab app settings
   - Check that all secrets are set correctly with `npx wrangler secret list`
   - Enable debug logging to see detailed OAuth flow

3. **"Durable Objects not available" error**

   - Ensure you have a paid Cloudflare Workers plan
   - Durable Objects are not available on the free tier

4. **Token refresh issues / repeated re-authentication prompts**
   - The server automatically refreshes Schwab access tokens 5 minutes before
     expiration; a re-auth prompt roughly every 7 days is expected (Schwab's
     refresh-token limit — see
     [Token Lifecycle](#token-lifecycle--re-authentication))
   - A 401 from `/mcp` with `Schwab tokens unavailable` in the logs means the
     client should re-run OAuth automatically; if it doesn't, disconnect and
     reconnect the connector manually
   - `Discarding non-envelope token record` in the logs means a token record
     predates encryption (or `TOKEN_ENCRYPTION_KEY` changed) — one
     re-authentication replaces it
   - Check KV namespace for stored tokens:
     `npx wrangler kv:key list --namespace-id=<your-id>`

## Recent Updates

- **Enhanced Token Management**: Centralized KV token store prevents token
  divergence
- **Improved Security**: HMAC-SHA256 state validation and automatic secret
  redaction
- **Better Error Handling**: Structured error types with Schwab API error
  mapping
- **Configurable Logging**: Debug mode for troubleshooting OAuth and API issues

## Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Uses [Model Context Protocol](https://modelcontextprotocol.io/)
- Powered by
  [@sudowealth/schwab-api](https://www.npmjs.com/package/@sudowealth/schwab-api)
