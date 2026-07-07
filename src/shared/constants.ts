/**
 * Application Constants
 */
export const APP_NAME = 'Schwab MCP' as const
export const APP_SERVER_NAME = 'Schwab MCP Server' as const

/**
 * Cookie Constants
 */
export const COOKIE_NAMES = {
	APPROVED_CLIENTS: 'mcp-approved-clients',
} as const

/**
 * HTTP Header Constants
 */
export const HTTP_HEADERS = {
	COOKIE: 'Cookie',
	SET_COOKIE: 'Set-Cookie',
} as const

/**
 * Logger Context Names
 */
export const LOGGER_CONTEXTS = {
	MCP_DO: 'mcp-do',
	OAUTH_HANDLER: 'oauth-handler',
	COOKIES: 'cookies',
	AUTH_CLIENT: 'auth-client',
	STATE_UTILS: 'state-utils',
	KV_TOKEN_STORE: 'kv-token-store',
} as const

/**
 * API Endpoints
 */
export const API_ENDPOINTS = {
	/** Streamable HTTP (current MCP spec transport) */
	MCP: '/mcp',
	/** Legacy HTTP+SSE transport, kept for clients that haven't migrated */
	SSE: '/sse',
	SSE_MESSAGE: '/sse/message',
	AUTHORIZE: '/authorize',
	TOKEN: '/token',
	CALLBACK: '/callback',
	REGISTER: '/register',
} as const

/**
 * Tool Names
 */
export const TOOL_NAMES = {
	STATUS: 'status',
} as const

/**
 * Environment Constants
 */
export const ENVIRONMENTS = {
	PRODUCTION: 'PRODUCTION',
} as const

/**
 * Content Types
 */
export const CONTENT_TYPES = {
	TEXT: 'text',
} as const

/**
 * KV Token Store Constants
 */
export const TOKEN_KEY_PREFIX = 'token:' as const
export const TTL_31_DAYS = 31 * 24 * 60 * 60

/**
 * Access Gating Constants
 *
 * `allowed:<schwabClientCustomerId>` marks an enrolled customer.
 * `invite:<code>` is a one-time invite code, consumed on first use.
 */
export const ALLOWLIST_KEY_PREFIX = 'allowed:' as const
export const INVITE_KEY_PREFIX = 'invite:' as const

/**
 * Hosts (and their subdomains) that dynamically registered OAuth clients may
 * use in redirect_uris. Keeps /register from being used to point auth codes
 * at arbitrary attacker-controlled callbacks. Loopback hosts are additionally
 * allowed for local dev tools like the MCP inspector.
 */
export const ALLOWED_REDIRECT_HOSTS = [
	'claude.ai',
	'claude.com',
	'anthropic.com',
	'chatgpt.com',
	'openai.com',
] as const
