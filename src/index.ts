import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
	createApiClient,
	sanitizeKeyForLog,
	type SchwabApiClient,
	type EnhancedTokenManager,
	type SchwabApiLogger,
	type TokenData,
} from '@sudowealth/schwab-api'
import { DurableMCP } from 'workers-mcp'
import { type Env, type ValidatedEnv } from '../types/env'
import { SchwabHandler, initializeSchwabAuthClient } from './auth'
import { getConfig } from './config'
import {
	APP_NAME,
	API_ENDPOINTS,
	LOGGER_CONTEXTS,
	TOOL_NAMES,
	ENVIRONMENTS,
	CONTENT_TYPES,
	APP_SERVER_NAME,
	TOKEN_KEY_PREFIX,
	TTL_31_DAYS,
} from './shared/constants'
import { makeKvTokenStore, type TokenIdentifiers } from './shared/kvTokenStore'
import { logger, buildLogger, type PinoLogLevel } from './shared/log'
import { logOnlyInDevelopment } from './shared/secureLogger'
import { createTool, toolError, toolSuccess } from './shared/toolBuilder'
import { allToolSpecs, type ToolSpec } from './tools'

/**
 * DO props now contain only IDs needed for token key derivation
 * Tokens are stored exclusively in KV to prevent divergence
 */
type MyMCPProps = {
	/** Schwab user ID when available (preferred for token key) */
	schwabUserId?: string
	/** OAuth client ID (fallback for token key) */
	clientId?: string
}

export class MyMCP extends DurableMCP<MyMCPProps, Env> {
	private tokenManager!: EnhancedTokenManager
	private client!: SchwabApiClient
	private validatedConfig!: ValidatedEnv
	private mcpLogger = logger.child(LOGGER_CONTEXTS.MCP_DO)
	
	server = new McpServer({
		name: APP_NAME,
		version: '0.0.1',
	})

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
			const kvToken = makeKvTokenStore(this.validatedConfig.OAUTH_KV)

			// Ensure clientId is stored in props for token key derivation
			if (!this.props.clientId) {
				this.props.clientId = this.validatedConfig.SCHWAB_CLIENT_ID
				this.props = { ...this.props }
			}

			const getTokenIds = (): TokenIdentifiers => ({
				schwabUserId: this.props.schwabUserId,
				clientId: this.props.clientId,
			})

			// Debug token IDs during initialization
			logOnlyInDevelopment(
				this.mcpLogger,
				'debug',
				'[MyMCP.init] Token identifiers',
				{
					hasSchwabUserId: !!this.props.schwabUserId,
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

			// Token load function - loads from KV using props identifiers
			const loadTokenForETM = async (): Promise<TokenData | null> => {
				const tokenIds = getTokenIds()
				this.mcpLogger.debug('[ETM Load] Loading token', {
					hasSchwabUserId: !!tokenIds.schwabUserId,
					hasClientId: !!tokenIds.clientId,
				})
				const tokenData = await kvToken.load(tokenIds)
				this.mcpLogger.debug('ETM: Token load complete', { found: !!tokenData })
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
			this.mcpLogger.debug('[MyMCP.init] Initializing token manager...')
			const etmInitSuccess = await this.tokenManager.initialize()
			this.mcpLogger.debug(`[MyMCP.init] Token manager initialized: ${etmInitSuccess}`)

			// 2.5. Auto-migrate tokens if we have schwabUserId but token was loaded from clientId key
			if (this.props.schwabUserId && this.props.clientId) {
				await kvToken.migrateIfNeeded(
					{ clientId: this.props.clientId },
					{ schwabUserId: this.props.schwabUserId },
				)
				this.mcpLogger.debug('[MyMCP.init] STEP 5C: Token migration completed')
			}

			// 3. Create SchwabApiClient AFTER tokens are loaded
			this.client = createApiClient({
				config: {
					environment: ENVIRONMENTS.PRODUCTION,
					logger: mcpLogger,
					enableLogging: true,
					logLevel:
						this.validatedConfig.ENVIRONMENT === 'production'
							? 'error'
							: 'debug',
				},
				auth: this.tokenManager,
			})
			this.mcpLogger.debug('[MyMCP.init] STEP 6: SchwabApiClient ready.')

			// 4. Register tools
			this.mcpLogger.debug(`[MyMCP.init] Registering ${allToolSpecs.length} tools...`)
			allToolSpecs.forEach((spec: ToolSpec<any>) => {
				createTool(this.client, this.server, {
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
			})
			this.mcpLogger.debug('[MyMCP.init] Tool registration complete')
		} catch (error: any) {
			this.mcpLogger.error('Init failed', { error: error.message })
			// Don't re-throw - allow DO to continue with basic "status" tool
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

	async onSSE(event: any) {
		// Wait for init to complete - workers-mcp doesn't await _init() before calling onSSE
		// This ensures all tools are registered before the MCP connection starts
		let attempts = 0
		while (!this.client && attempts < 50) {
			await new Promise(resolve => setTimeout(resolve, 100))
			attempts++
		}

		this.mcpLogger.info('SSE connection established or reconnected')
		await this.onReconnect()
		return await super.onSSE(event)
	}
}

const oauthProvider = new OAuthProvider({
	apiRoute: API_ENDPOINTS.SSE,
	apiHandler: MyMCP.mount(API_ENDPOINTS.SSE) as any, // Cast remains due to library typing
	defaultHandler: SchwabHandler as any, // Cast remains
	authorizeEndpoint: API_ENDPOINTS.AUTHORIZE,
	tokenEndpoint: API_ENDPOINTS.TOKEN,
	clientRegistrationEndpoint: API_ENDPOINTS.REGISTER,
	// 30-day access tokens: all three clients (Claude Code, Claude Desktop, OpenClaw) share
	// the same mcp-remote token file and race to refresh when the 1-hour default expires.
	// Long-lived tokens eliminate concurrent refresh races almost entirely.
	accessTokenTTL: 30 * 24 * 60 * 60, // 30 days
})

export default {
	fetch: oauthProvider.fetch.bind(oauthProvider),

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const cronLogger = logger.child({ context: 'cron' })
		cronLogger.info('Cron triggered', { cron: event.cron })

		try {
			const config = getConfig(env)
			const kv = config.OAUTH_KV
			const list = await kv.list({ prefix: TOKEN_KEY_PREFIX })

			// Filter to simple token:id keys (not compound token:id:grant:hash keys)
			const tokenKeys = list.keys.filter(k => {
				const parts = k.name.replace(TOKEN_KEY_PREFIX, '').split(':')
				return parts.length === 1
			})

			cronLogger.info('Token key inventory', {
				total: list.keys.length,
				simpleTokenKeys: tokenKeys.length,
				keys: tokenKeys.map(k => ({
					name: k.name.substring(0, 20) + '...',
					kvExpiration: k.expiration
						? `${((k.expiration - Date.now() / 1000) / 86400).toFixed(1)}d`
						: 'none',
				})),
			})

			if (tokenKeys.length === 0) {
				cronLogger.error('No token keys found in KV — nothing to refresh. Re-auth required.')
				return
			}

			// Pick the freshest token (highest expiration = most recently saved)
			const sorted = tokenKeys.slice().sort((a, b) =>
				(b.expiration ?? 0) - (a.expiration ?? 0)
			)
			const bestKey = sorted[0]
			const tokenKey = bestKey.name

			// Pre-refresh diagnostic: what's in this token right now?
			const preRefreshToken = (await kv.get(tokenKey, 'json')) as TokenData | null
			const accessTokenExpiry = preRefreshToken?.expiresAt
				? new Date(preRefreshToken.expiresAt).toISOString()
				: 'unknown'
			const accessTokenAge = preRefreshToken?.expiresAt
				? `${((Date.now() - preRefreshToken.expiresAt) / 60000).toFixed(0)}min ago`
				: 'unknown'
			cronLogger.info('Pre-refresh token state', {
				key: tokenKey.substring(0, 20) + '...',
				hasAccessToken: !!preRefreshToken?.accessToken,
				hasRefreshToken: !!preRefreshToken?.refreshToken,
				accessTokenExpiry,
				accessTokenAge: preRefreshToken?.expiresAt && preRefreshToken.expiresAt < Date.now()
					? `EXPIRED ${accessTokenAge}`
					: `valid (expires ${accessTokenExpiry})`,
			})

			const loadToken = async (): Promise<TokenData | null> =>
				(await kv.get(tokenKey, 'json')) as TokenData | null
			const saveToken = async (data: TokenData): Promise<void> => {
				await kv.put(tokenKey, JSON.stringify(data), { expirationTtl: TTL_31_DAYS })
			}

			const tokenManager = initializeSchwabAuthClient(
				config, config.SCHWAB_REDIRECT_URI, loadToken, saveToken,
			)
			const success = await tokenManager.initialize()

			if (success) {
				// Verify the token was actually updated by reading it back
				const postRefreshToken = (await kv.get(tokenKey, 'json')) as TokenData | null
				const newExpiry = postRefreshToken?.expiresAt
					? new Date(postRefreshToken.expiresAt).toISOString()
					: 'unknown'
				const tokenActuallyUpdated = postRefreshToken?.expiresAt !== preRefreshToken?.expiresAt

				cronLogger.info('Token refresh succeeded', {
					tokenUpdated: tokenActuallyUpdated,
					newAccessTokenExpiry: newExpiry,
					hasNewRefreshToken: !!postRefreshToken?.refreshToken,
				})

				if (!tokenActuallyUpdated) {
					cronLogger.warn('Token was NOT updated despite initialize() returning true — access token may not have been expired yet')
				}

				// Cleanup: delete all OTHER simple token keys to prevent accumulation
				const staleKeys = tokenKeys.filter(k => k.name !== tokenKey)
				if (staleKeys.length > 0) {
					cronLogger.info('Cleaning up stale token keys', { count: staleKeys.length })
					for (const stale of staleKeys) {
						try {
							await kv.delete(stale.name)
							cronLogger.info('Deleted stale key', { key: stale.name.substring(0, 20) + '...' })
						} catch {
							cronLogger.warn('Failed to delete stale key', { key: stale.name.substring(0, 20) + '...' })
						}
					}
				}
			} else {
				cronLogger.error('TOKEN REFRESH FAILED — initialize() returned false. The Schwab refresh token is likely expired. Manual re-auth required: rm -rf ~/.mcp-auth/ && npx -y mcp-remote https://schwab-mcp-owais.owais-ce6.workers.dev/sse')
			}
		} catch (error) {
			cronLogger.error('Cron failed with exception', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			})
		}
	},
}
