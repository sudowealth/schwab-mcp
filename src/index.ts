import OAuthProvider from '@cloudflare/workers-oauth-provider'
import {
	McpServer,
	type RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import {
	createApiClient,
	sanitizeKeyForLog,
	type SchwabApiClient,
	type EnhancedTokenManager,
	type SchwabApiLogger,
	type TokenData,
} from '@sudowealth/schwab-api'
import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { type ValidatedEnv } from '../types/env'
import { SchwabHandler, initializeSchwabAuthClient } from './auth'
import { type ToolScope } from './auth/allowlist'
import { validateClientRegistration } from './auth/registration'
import { getConfig } from './config'
import {
	APP_NAME,
	API_ENDPOINTS,
	LOGGER_CONTEXTS,
	TOOL_NAMES,
	ENVIRONMENTS,
	CONTENT_TYPES,
	APP_SERVER_NAME,
} from './shared/constants'
import { makeKvTokenStore, type TokenIdentifiers } from './shared/kvTokenStore'
import { logger, buildLogger, type PinoLogLevel } from './shared/log'
import { logOnlyInDevelopment } from './shared/secureLogger'
import { createTool, toolError, toolSuccess } from './shared/toolBuilder'
import { marketToolSpecs, traderToolSpecs, type ToolSpec } from './tools'
import { SseEdgeTransport } from './transports/sseEdgeTransport'
import { StreamableHttpEdgeTransport } from './transports/streamableHttpTransport'

/**
 * DO props now contain only IDs needed for token key derivation
 * Tokens are stored exclusively in KV to prevent divergence
 */
type MyMCPProps = {
	/** Stable Schwab customer ID when available (preferred for token key) */
	schwabCustomerId?: string
	/** OAuth client ID (fallback for token key) */
	clientId?: string
	/**
	 * Tool families this grant may use. Absent on grants issued before
	 * scopes existed; those are treated as market-only until the weekly
	 * Schwab re-auth rewrites the grant props from the allowlist record.
	 */
	toolScope?: ToolScope
}

export class MyMCP extends DurableObject<Env> {
	props: MyMCPProps = {}
	private initRun = false
	private registeredScope?: ToolScope
	private traderToolHandles: RegisteredTool[] = []
	private sseTransport?: SseEdgeTransport
	private streamableTransport?: StreamableHttpEdgeTransport
	private tokenManager!: EnhancedTokenManager
	private client!: SchwabApiClient
	private validatedConfig!: ValidatedEnv
	private mcpLogger = logger.child(LOGGER_CONTEXTS.MCP_DO)

	server = new McpServer({
		name: APP_NAME,
		version: '0.0.1',
	})

	async _init(props: MyMCPProps) {
		this.props = props
		if (!this.initRun) {
			this.initRun = true
			await this.init()
		} else if (this.registeredScope !== undefined) {
			// A warm DO outlives re-authorization: when the Schwab re-auth
			// rewrites the grant props with a changed scope, pick it up here
			// instead of waiting for DO eviction.
			this.applyToolScope(props.toolScope === 'full' ? 'full' : 'market')
		}
	}

	/** Wraps a ToolSpec into an McpServer tool and returns the SDK handle. */
	private registerSpec(spec: ToolSpec<any>): RegisteredTool {
		return createTool(this.client, this.server, {
			name: spec.name,
			description: spec.description,
			schema: spec.schema,
			handler: async (params, c) => {
				try {
					const data = await spec.call(c, params)
					return toolSuccess({
						data,
						source: spec.name,
						message: `Successfully executed ${spec.name}`,
					})
				} catch (error) {
					return toolError(error, { source: spec.name })
				}
			},
		})
	}

	/**
	 * Adds or removes the trader tools so the registered set matches the
	 * grant's scope. Market tools are the always-present baseline; trader
	 * tools (accounts, orders, transactions) exist only under full scope.
	 */
	private applyToolScope(scope: ToolScope) {
		if (this.registeredScope === scope) return
		if (scope === 'full') {
			this.traderToolHandles = traderToolSpecs.map((spec) =>
				this.registerSpec(spec),
			)
		} else {
			this.traderToolHandles.forEach((handle) => handle.remove())
			this.traderToolHandles = []
		}
		this.mcpLogger.info('Tool scope applied', {
			from: this.registeredScope,
			to: scope,
		})
		this.registeredScope = scope
	}

	async init() {
		try {
			// Register a minimal tool synchronously to ensure Claude Desktop detects tools
			this.server.tool(
				TOOL_NAMES.STATUS,
				'Check Schwab MCP server status',
				{},
				async () => ({
					content: [
						{
							type: CONTENT_TYPES.TEXT,
							text: `${APP_SERVER_NAME} is running. Use tool discovery to see all available tools.`,
						},
					],
				}),
			)
			this.validatedConfig = getConfig(this.env)
			// Initialize logger with configured level
			const logLevel = this.validatedConfig.LOG_LEVEL as PinoLogLevel
			const newLogger = buildLogger(logLevel)
			// Replace the singleton logger instance
			Object.assign(logger, newLogger)
			const redirectUri = this.validatedConfig.SCHWAB_REDIRECT_URI

			this.mcpLogger.debug('[MyMCP.init] STEP 0: Start')
			this.mcpLogger.debug('[MyMCP.init] STEP 1: Env initialized.')

			// Create KV token store - single source of truth
			const kvToken = makeKvTokenStore(
				this.validatedConfig.OAUTH_KV,
				this.validatedConfig.TOKEN_ENCRYPTION_KEY,
			)

			// Ensure clientId is stored in props for token key derivation
			if (!this.props.clientId) {
				this.props.clientId = this.validatedConfig.SCHWAB_CLIENT_ID
				this.props = { ...this.props }
			}

			const getTokenIds = (): TokenIdentifiers => ({
				customId: this.props.schwabCustomerId,
				clientId: this.props.clientId,
			})

			// Debug token IDs during initialization
			logOnlyInDevelopment(
				this.mcpLogger,
				'debug',
				'[MyMCP.init] Token identifiers',
				{
					hasSchwabCustomerId: !!this.props.schwabCustomerId,
					hasClientId: !!this.props.clientId,
					expectedKeyPrefix: sanitizeKeyForLog(kvToken.kvKey(getTokenIds())),
				},
			)

			// Token save function uses KV store exclusively
			const saveTokenForETM = async (tokenSet: TokenData) => {
				await kvToken.save(getTokenIds(), tokenSet)
				this.mcpLogger.debug('ETM: Token save to KV complete', {
					keyPrefix: sanitizeKeyForLog(kvToken.kvKey(getTokenIds())),
				})
			}

			// Token load function uses KV store exclusively
			const loadTokenForETM = async (): Promise<TokenData | null> => {
				const tokenIds = getTokenIds()
				this.mcpLogger.debug('[ETM Load] Attempting to load token', {
					hasSchwabCustomerId: !!tokenIds.customId,
					hasClientId: !!tokenIds.clientId,
					expectedKeyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)),
				})

				const tokenData = await kvToken.load(tokenIds)
				this.mcpLogger.debug('ETM: Token load from KV complete', {
					keyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)),
				})
				return tokenData
			}

			this.mcpLogger.debug(
				'[MyMCP.init] STEP 2: Storage and event handlers defined.',
			)

			// 1. Create ETM instance (synchronous)
			const hadExistingTokenManager = !!this.tokenManager
			this.mcpLogger.debug('[MyMCP.init] STEP 3A: ETM instance setup', {
				hadExisting: hadExistingTokenManager,
			})
			if (!this.tokenManager) {
				this.tokenManager = initializeSchwabAuthClient(
					this.validatedConfig,
					redirectUri,
					loadTokenForETM,
					saveTokenForETM,
				) // This is synchronous
			}
			this.mcpLogger.debug('[MyMCP.init] STEP 3B: ETM instance ready', {
				wasReused: hadExistingTokenManager,
			})

			const mcpLogger: SchwabApiLogger = {
				debug: (message: string, ...args: any[]) =>
					this.mcpLogger.debug(message, args.length > 0 ? args[0] : undefined),
				info: (message: string, ...args: any[]) =>
					this.mcpLogger.info(message, args.length > 0 ? args[0] : undefined),
				warn: (message: string, ...args: any[]) =>
					this.mcpLogger.warn(message, args.length > 0 ? args[0] : undefined),
				error: (message: string, ...args: any[]) =>
					this.mcpLogger.error(message, args.length > 0 ? args[0] : undefined),
			}
			this.mcpLogger.debug('[MyMCP.init] STEP 4: MCP Logger adapted.')

			// 2. Proactively initialize ETM to load tokens BEFORE creating client
			this.mcpLogger.debug(
				'[MyMCP.init] STEP 5A: Proactively calling this.tokenManager.initialize() (async)...',
			)
			const etmInitSuccess = this.tokenManager.initialize()
			this.mcpLogger.debug(
				`[MyMCP.init] STEP 5B: Proactive ETM initialization complete. Success: ${etmInitSuccess}`,
			)

			// The auth callback stores tokens under the customerId key before any
			// grant exists, so no clientId->customerId migration is needed here.

			// 3. Create SchwabApiClient AFTER tokens are loaded
			this.client = createApiClient({
				config: {
					environment: ENVIRONMENTS.PRODUCTION,
					logger: mcpLogger,
					enableLogging: true,
					logLevel:
						this.validatedConfig.ENVIRONMENT === 'production'
							? 'info'
							: 'debug',
				},
				auth: this.tokenManager,
			})
			this.mcpLogger.debug('[MyMCP.init] STEP 6: SchwabApiClient ready.')

			// 4. Register tools (this.server.tool calls are synchronous).
			// Trader tools (accounts, orders, transactions) are only exposed to
			// grants with full scope; everyone else gets market data only.
			this.mcpLogger.debug('[MyMCP.init] STEP 7A: Calling registerTools...')
			if (this.registeredScope === undefined) {
				marketToolSpecs.forEach((spec) => void this.registerSpec(spec))
				this.registeredScope = 'market'
			}
			this.applyToolScope(this.props.toolScope === 'full' ? 'full' : 'market')
			this.mcpLogger.debug('[MyMCP.init] STEP 7B: registerTools completed.', {
				toolScope: this.registeredScope,
			})
			this.mcpLogger.debug(
				'[MyMCP.init] STEP 8: MyMCP.init FINISHED SUCCESSFULLY',
			)
		} catch (error: any) {
			this.mcpLogger.error(
				'[MyMCP.init] FINAL CATCH: UNHANDLED EXCEPTION in init()',
				{
					error: error.message,
					stack: error.stack,
				},
			)
			throw error // Re-throw to ensure DO framework sees the failure
		}
	}

	async onReconnect() {
		this.mcpLogger.info('Handling reconnection in MyMCP instance')
		try {
			if (!this.tokenManager) {
				this.mcpLogger.warn(
					'Token manager not initialized, attempting full initialization',
				)
				await this.init()
				return true
			}
			this.mcpLogger.info('Attempting reconnection via token manager')

			try {
				this.mcpLogger.info('Attempting to fetch access token as recovery test')
				const token = await this.tokenManager.getAccessToken()
				if (token) {
					this.mcpLogger.info(
						'Successfully retrieved access token during reconnection',
					)
					return true
				}
			} catch (tokenError) {
				this.mcpLogger.warn('Failed to get access token during reconnection', {
					error:
						tokenError instanceof Error
							? tokenError.message
							: String(tokenError),
				})
			}

			try {
				this.mcpLogger.info(
					'Attempting proactive reinitialization of token manager',
				)
				const initResult = await this.tokenManager.initialize()
				this.mcpLogger.info(
					`Token manager reinitialization ${initResult ? 'succeeded' : 'failed'}`,
				)
				if (initResult) {
					return true
				}
			} catch (initError) {
				this.mcpLogger.warn('Token manager reinitialization failed', {
					error:
						initError instanceof Error ? initError.message : String(initError),
				})
			}

			try {
				this.mcpLogger.info('Token manager state during reconnection', {
					hasTokenManager: !!this.tokenManager,
				})
			} catch (stateError) {
				this.mcpLogger.warn(
					'Failed to check token manager state during reconnection',
					{
						error:
							stateError instanceof Error
								? stateError.message
								: String(stateError),
					},
				)
			}

			this.mcpLogger.warn(
				'Reconnection recovery attempts failed, performing full reinitialization',
			)
			await this.init()
			return true
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const stack = error instanceof Error ? error.stack : undefined
			this.mcpLogger.error('Critical error during reconnection handling', {
				error: message,
				stack,
			})
			try {
				this.mcpLogger.warn(
					'Attempting emergency reinitialization after reconnection failure',
				)
				await this.init()
				return true
			} catch (initError) {
				const initMessage =
					initError instanceof Error ? initError.message : String(initError)
				this.mcpLogger.error('Emergency reinitialization also failed', {
					error: initMessage,
				})
				return false
			}
		}
	}

	/** POST /mcp - Streamable HTTP transport (current MCP spec) */
	async onMcpPost(request: Request): Promise<Response> {
		this.mcpLogger.debug('Streamable HTTP request received')
		// _init() fully initializes a cold DO; the token manager refreshes
		// tokens on demand per API call, so warm requests need no recovery
		// dance here (unlike the long-lived legacy SSE connections).
		if (!this.tokenManager) {
			await this.onReconnect()
		}
		// If the Schwab leg is dead (no tokens, unreadable record, or refresh
		// token expired), answer HTTP 401 so the MCP client re-runs its OAuth
		// flow. A Schwab failure surfaced as an in-band tool error keeps this
		// layer's token valid and gives the client no signal to re-authorize.
		let schwabAuthAlive = false
		try {
			schwabAuthAlive = !!(await this.tokenManager.getAccessToken())
		} catch {
			schwabAuthAlive = false
		}
		if (!schwabAuthAlive) {
			this.mcpLogger.warn(
				'Schwab tokens unavailable; returning 401 to trigger client re-auth',
			)
			const resourceMetadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp`
			return new Response('Schwab authentication expired; please re-authorize', {
				status: 401,
				headers: {
					'WWW-Authenticate': `Bearer error="invalid_token", error_description="Schwab authentication expired", resource_metadata="${resourceMetadata}"`,
				},
			})
		}
		if (!this.streamableTransport) {
			this.streamableTransport = new StreamableHttpEdgeTransport(
				this.ctx.id.toString(),
			)
			await this.server.connect(this.streamableTransport)
		}
		return await this.streamableTransport.handleRequest(request)
	}

	/** DELETE /mcp - explicit session termination */
	async onMcpDelete(): Promise<Response> {
		if (this.streamableTransport) {
			const response = await this.streamableTransport.handleDeleteRequest()
			// The DO is shared per user; drop the closed transport so the next
			// request gets a fresh one instead of 503s forever.
			this.streamableTransport = undefined
			return response
		}
		return new Response(null, { status: 200 })
	}

	/** GET /sse - legacy HTTP+SSE transport, kept for clients that haven't migrated */
	async onSSE(): Promise<Response> {
		this.mcpLogger.info('SSE connection established or reconnected')
		await this.onReconnect()
		this.sseTransport = new SseEdgeTransport(
			API_ENDPOINTS.SSE_MESSAGE,
			this.ctx.id.toString(),
		)
		await this.server.connect(this.sseTransport)
		return this.sseTransport.sseResponse
	}

	/** POST /sse/message - companion to the legacy SSE transport */
	async onSSEMessage(request: Request): Promise<Response> {
		if (!this.sseTransport) {
			return new Response('SSE connection not established', { status: 500 })
		}
		return await this.sseTransport.handlePostMessage(request)
	}
}

/** OAuthProvider attaches the authenticated grant's props to the execution context at runtime. */
function propsFromExecutionCtx(ctx: unknown): MyMCPProps {
	return (ctx as { props: MyMCPProps }).props
}

const mcpApp = new Hono<{ Bindings: Env }>()

/**
 * Route a request to its Durable Object. A client that echoes our
 * Mcp-Session-Id header is routed straight back to its DO. Without the
 * header (claude.ai does not echo it), derive a stable per-user DO from the
 * OAuth grant's identity so repeat requests reuse a warm, initialized
 * instance instead of paying full init on a fresh one each time.
 */
function mcpObjectFor(
	env: Env,
	sessionId: string | undefined,
	props: MyMCPProps,
) {
	const ns = env.MCP_OBJECT
	if (sessionId) {
		try {
			return ns.get(ns.idFromString(sessionId))
		} catch {
			return null // malformed session id from client
		}
	}
	const name = props.schwabCustomerId
		? `user:${props.schwabCustomerId}`
		: props.clientId
			? `client:${props.clientId}`
			: null
	return ns.get(name ? ns.idFromName(name) : ns.newUniqueId())
}

mcpApp.post(API_ENDPOINTS.MCP, cors(), async (c) => {
	const props = propsFromExecutionCtx(c.executionCtx)
	const object = mcpObjectFor(c.env, c.req.header('Mcp-Session-Id'), props)
	if (!object) {
		return new Response('Invalid Mcp-Session-Id', { status: 400 })
	}
	await object._init(props)
	return await object.onMcpPost(c.req.raw)
})

mcpApp.get(API_ENDPOINTS.MCP, cors(), async () => {
	return new Response(null, { status: 405, headers: { Allow: 'POST' } })
})

mcpApp.delete(API_ENDPOINTS.MCP, cors(), async (c) => {
	const sessionId = c.req.header('Mcp-Session-Id')
	if (!sessionId) {
		return new Response('Missing Mcp-Session-Id', { status: 400 })
	}
	const object = mcpObjectFor(c.env, sessionId, {})
	if (!object) {
		return new Response('Invalid Mcp-Session-Id', { status: 400 })
	}
	return await object.onMcpDelete()
})

mcpApp.get(API_ENDPOINTS.SSE, cors(), async (c) => {
	const object = c.env.MCP_OBJECT.get(c.env.MCP_OBJECT.newUniqueId())
	await object._init(propsFromExecutionCtx(c.executionCtx))
	return await object.onSSE()
})

mcpApp.post(API_ENDPOINTS.SSE_MESSAGE, cors(), async (c) => {
	const sessionId = c.req.query('sessionId')
	if (!sessionId) {
		return new Response(
			'Missing sessionId. Expected GET to /sse to initiate one',
			{ status: 400 },
		)
	}
	const object = c.env.MCP_OBJECT.get(c.env.MCP_OBJECT.idFromString(sessionId))
	return await object.onSSEMessage(c.req.raw)
})

const oauthProvider = new OAuthProvider({
	apiRoute: [API_ENDPOINTS.MCP, API_ENDPOINTS.SSE, API_ENDPOINTS.SSE_MESSAGE],
	apiHandler: mcpApp as any, // Hono app satisfies the { fetch } handler shape OAuthProvider expects
	defaultHandler: SchwabHandler as any, // Cast remains
	authorizeEndpoint: API_ENDPOINTS.AUTHORIZE,
	tokenEndpoint: API_ENDPOINTS.TOKEN,
	clientRegistrationEndpoint: API_ENDPOINTS.REGISTER, // This was missing in origin repo.
	clientRegistrationCallback: validateClientRegistration,
})

/**
 * Public, unauthenticated auth endpoints get a per-IP rate limit. The MCP
 * endpoints are excluded: they require a bearer token, and legitimate tool
 * traffic can burst well past any limit suitable for the auth surface.
 */
const RATE_LIMITED_PATHS = new Set<string>([
	API_ENDPOINTS.REGISTER,
	API_ENDPOINTS.AUTHORIZE,
	API_ENDPOINTS.TOKEN,
	API_ENDPOINTS.CALLBACK,
])

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Skip OPTIONS so rate limiting can't break CORS preflights
		if (request.method !== 'OPTIONS' && env.AUTH_RATE_LIMITER) {
			const { pathname } = new URL(request.url)
			if (RATE_LIMITED_PATHS.has(pathname)) {
				const key = request.headers.get('CF-Connecting-IP') ?? 'unknown'
				const { success } = await env.AUTH_RATE_LIMITER.limit({ key })
				if (!success) {
					return new Response('Too many requests', {
						status: 429,
						headers: { 'Retry-After': '60' },
					})
				}
			}
		}
		return oauthProvider.fetch(request, env, ctx)
	},
}
