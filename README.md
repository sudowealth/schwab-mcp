# Schwab MCP Server

A Model Context Protocol (MCP) server that enables AI assistants like Claude to
securely interact with Charles Schwab accounts and market data through the
official Schwab API.

## What You Can Do

Ask Claude to:

- "Show me my Schwab account balances and positions"
- "Get real-time quotes for AAPL, GOOGL, and MSFT"
- "What are today's market movers in the $SPX?"
- "Show me the options chain for TSLA with Greeks"
- "Get my transactions from the last 30 days"
- "Search for ETFs related to technology"
- "Check if the markets are open"

## Unofficial MCP Server

This is an unofficial, community-developed TypeScript MCP server for Charles
Schwab. It has not been approved, endorsed, or certified by Charles Schwab. It
is provided as-is, and its functionality may be incomplete or unstable. Use at
your own risk, especially when dealing with financial data or transactions.

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
be prompted to authenticate with Schwab.

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

Connect to `http://localhost:8788/mcp` using the MCP Inspector for testing.

## Architecture

### Technology Stack

- **Runtime**: Cloudflare Workers with Durable Objects
- **Authentication**: OAuth 2.0 with PKCE via
  `@cloudflare/workers-oauth-provider`
- **API Client**: `@sudowealth/schwab-api` for type-safe Schwab API access
- **MCP Framework**: `@modelcontextprotocol/sdk` with `workers-mcp` adapter
- **State Management**: KV storage for tokens, Durable Objects for session state

### Security Features

1. **OAuth 2.0 with PKCE**: Secure authentication flow preventing authorization
   code interception
2. **Enhanced Token Management**:
   - Centralized KV token store with automatic migration
   - Automatic token refresh (5 minutes before expiration)
   - 31-day token persistence with TTL
3. **Account Scrubbing**: Sensitive account identifiers are automatically
   replaced with display names
4. **State Security**: HMAC-SHA256 signatures for state parameter integrity
5. **Cookie Encryption**: Client approval state encrypted with AES-256
6. **Secret Redaction**: Automatic masking of sensitive data in logs

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

4. **Token refresh issues**
   - The server automatically refreshes tokens 5 minutes before expiration
   - Tokens are migrated from clientId to schwabUserId keys automatically
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
