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
import { type ValidatedEnv } from '../types/env'
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

			// Token load function uses KV store exclusively
			const loadTokenForETM = async (): Promise<TokenData | null> => {
				const tokenIds = getTokenIds()
				this.mcpLogger.debug('[ETM Load] Attempting to load token', {
					hasSchwabUserId: !!tokenIds.schwabUserId,
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

			// 4. Register tools (this.server.tool calls are synchronous)
			this.mcpLogger.debug('[MyMCP.init] STEP 7A: Calling registerTools...')
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
			this.mcpLogger.debug('[MyMCP.init] STEP 7B: registerTools completed.')
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

	async onSSE(event: any) {
		this.mcpLogger.info('SSE connection established or reconnected')
		await this.onReconnect()
		return await super.onSSE(event)
	}
}

export default new OAuthProvider({
	apiRoute: API_ENDPOINTS.SSE,
	apiHandler: MyMCP.mount(API_ENDPOINTS.SSE) as any, // Cast remains due to library typing
	defaultHandler: SchwabHandler as any, // Cast remains
	authorizeEndpoint: API_ENDPOINTS.AUTHORIZE,
	tokenEndpoint: API_ENDPOINTS.TOKEN,
	clientRegistrationEndpoint: API_ENDPOINTS.REGISTER,
})
