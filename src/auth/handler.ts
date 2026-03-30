import { type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import {
	createApiClient,
	sanitizeKeyForLog,
	sanitizeError,
	SchwabAuthError,
	SchwabApiError,
	type TokenData,
	type SchwabApiClient,
} from '@sudowealth/schwab-api'
import { Hono } from 'hono'
import { type Env, type ValidatedEnv } from '../../types/env'
import { getConfig } from '../config'
import {
	LOGGER_CONTEXTS,
	APP_SERVER_NAME,
	TOKEN_KEY_PREFIX,
	TTL_31_DAYS,
	ENVIRONMENTS,
} from '../shared/constants'
import { makeKvTokenStore } from '../shared/kvTokenStore'
import { logger } from '../shared/log'
import { initializeSchwabAuthClient, redirectToSchwab } from './client'
import { clientIdAlreadyApproved, parseRedirectApproval } from './cookies'
import { mapSchwabError } from './errorMapping'
import {
	AuthErrors,
	type AuthError,
	formatAuthError,
	createJsonErrorResponse,
} from './errors'
import { decodeAndVerifyState, extractClientIdFromState } from './stateUtils'
import { renderApprovalDialog } from './ui/approvalDialog'
import { APPROVAL_CONFIG } from './ui/config'

// Create Hono app with appropriate bindings
const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

// Create a scoped logger for OAuth handlers
const oauthLogger = logger.child(LOGGER_CONTEXTS.OAUTH_HANDLER)

// No need to store config locally, we'll build it per request

/**
 * GET /authorize - Entry point for OAuth authorization flow
 *
 * This endpoint checks if the client is already approved, and either:
 * 1. Redirects directly to Schwab if approved
 * 2. Shows the approval dialog
 */
app.get('/authorize', async (c) => {
	try {
		const config = getConfig(c.env)
		const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
		const { clientId } = oauthReqInfo

		if (!clientId) {
			const error = new AuthErrors.MissingClientId()
			const errorInfo = formatAuthError(error)
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(error)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// If client ID is already approved, redirect directly to Schwab
		if (
			await clientIdAlreadyApproved(
				c.req.raw,
				oauthReqInfo.clientId,
				config.COOKIE_ENCRYPTION_KEY,
			)
		) {
			return redirectToSchwab(c, config, oauthReqInfo)
		}

		// Show approval dialog (Cloudflare style)
		const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(clientId)
		const serverInfo = {
			name: APP_SERVER_NAME,
			logo: APPROVAL_CONFIG.SHOW_LOGO ? APPROVAL_CONFIG.LOGO_URL : undefined,
		}

		return renderApprovalDialog(c.req.raw, {
			client: clientInfo,
			server: serverInfo,
			state: { oauthReqInfo },
			config,
		})
	} catch (error) {
		const authError = new AuthErrors.AuthRequest()
		const errorInfo = formatAuthError(authError, { error })
		oauthLogger.error(errorInfo.message, { error: sanitizeError(error) })
		const jsonResponse = createJsonErrorResponse(authError)
		return c.json(jsonResponse, errorInfo.status as any)
	}
})

/**
 * POST /authorize - Handle approval dialog submission
 *
 * After the user approves the request, this endpoint processes the form submission
 * and redirects to Schwab for authentication
 */
app.post('/authorize', async (c) => {
	try {
		const config = getConfig(c.env)
		const { state, headers } = await parseRedirectApproval(c.req.raw, config)

		if (!state.oauthReqInfo) {
			const error = new AuthErrors.MissingState()
			const errorInfo = formatAuthError(error)
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(error)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// Pass the actual AuthRequest object to redirectToSchwab
		const authRequestForSchwab = state.oauthReqInfo

		// Validate required AuthRequest fields before passing to redirectToSchwab
		if (!authRequestForSchwab?.clientId || !authRequestForSchwab?.scope) {
			const error = new AuthErrors.InvalidState()
			const errorInfo = formatAuthError(error, {
				missingFields: {
					clientId: !authRequestForSchwab?.clientId,
					scope: !authRequestForSchwab?.scope,
				},
			})
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(
				error,
				undefined,
				errorInfo.details as Record<string, any>,
			)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		return redirectToSchwab(c, config, authRequestForSchwab, headers)
	} catch (error) {
		const authError = new AuthErrors.AuthApproval()
		const errorInfo = formatAuthError(authError, { error })
		oauthLogger.error(errorInfo.message, { error: sanitizeError(error) })
		const jsonResponse = createJsonErrorResponse(authError)
		return c.json(jsonResponse, errorInfo.status as any)
	}
})

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Schwab after user authentication.
 * It exchanges the temporary code for an access token and completes the
 * authorization flow.
 */
app.get('/callback', async (c) => {
	try {
		const config = getConfig(c.env)

		// Extract state and code from query parameters
		const stateParam = c.req.query('state')
		const code = c.req.query('code')

		if (!stateParam || !code) {
			const error = new AuthErrors.MissingParameters()
			const errorInfo = formatAuthError(error, {
				hasState: !!stateParam,
				hasCode: !!code,
			})
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(
				error,
				undefined,
				errorInfo.details as Record<string, any>,
			)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// Parse the state using our utility function.
		// `decodedStateAsAuthRequest` is the AuthRequest object itself that was sent to Schwab.
		const decodedStateAsAuthRequest = await decodeAndVerifyState(
			config,
			stateParam,
		)

		if (!decodedStateAsAuthRequest) {
			const error = new AuthErrors.InvalidState()
			const errorInfo = formatAuthError(error)
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(error)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// `extractClientIdFromState` will correctly get `decodedStateAsAuthRequest.clientId`.
		// This also serves as validation that clientId exists within the decoded state.
		const clientIdFromState = extractClientIdFromState(
			decodedStateAsAuthRequest,
		)

		// Validate required AuthRequest fields directly on `decodedStateAsAuthRequest`
		if (
			!decodedStateAsAuthRequest?.clientId || // Should be redundant due to extractClientIdFromState
			!decodedStateAsAuthRequest?.redirectUri ||
			!decodedStateAsAuthRequest?.scope
		) {
			const error = new AuthErrors.InvalidState()
			const errorInfo = formatAuthError(error, {
				detail:
					'Decoded state object from Schwab callback is missing required AuthRequest fields (clientId, redirectUri, or scope).',
			})
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(
				error,
				undefined,
				errorInfo.details as Record<string, any>,
			)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// Set up redirect URI and token storage using centralized KV helper
		const redirectUri = config.SCHWAB_REDIRECT_URI
		const kvToken = makeKvTokenStore(config.OAUTH_KV)

		// Initial token identifiers (before we get schwabUserId)
		const getInitialTokenIds = () => ({ clientId: clientIdFromState })

		// Capture token data as it's saved so we can re-use it for dual-key save below.
		// We cannot re-load from KV after exchangeCode because Cloudflare KV has no
		// read-after-write consistency — the get would return null immediately after the put.
		let capturedTokenData: TokenData | null = null
		const saveToken = async (tokenData: TokenData) => {
			capturedTokenData = tokenData
			await kvToken.save(getInitialTokenIds(), tokenData)
		}

		const loadToken = async (): Promise<TokenData | null> => {
			return await kvToken.load(getInitialTokenIds())
		}

		// Use the validated config for auth client to ensure consistency
		const auth = initializeSchwabAuthClient(
			config,
			redirectUri,
			loadToken,
			saveToken,
		)

		// Exchange the code for tokens with enhanced error handling
		oauthLogger.info('Exchanging authorization code for tokens')
		try {
			await auth.exchangeCode(code, stateParam)
		} catch (exchangeError) {
			oauthLogger.error('Token exchange failed', {
				error: sanitizeError(exchangeError),
				message:
					exchangeError instanceof Error
						? exchangeError.message
						: String(exchangeError),
			})
			throw new AuthErrors.TokenExchange()
		}

		// Log token exchange success (without sensitive details)
		oauthLogger.info('Token exchange successful')

		// Create API client (temporary for auth flow)
		oauthLogger.info('Creating Schwab API client')
		let client
		try {
			client = createApiClient({
				config: { environment: 'PRODUCTION' },
				auth,
			})
		} catch (clientError) {
			oauthLogger.error('Failed to create API client', {
				error: sanitizeError(clientError),
				message:
					clientError instanceof Error
						? clientError.message
						: String(clientError),
			})
			throw new AuthErrors.AuthCallback()
		}

		// Fetch user info to get the Schwab user ID
		oauthLogger.info('Fetching user preferences to get Schwab user ID')
		let userPreferences
		try {
			userPreferences = await client.trader.userPreference.getUserPreference()
		} catch (preferencesError) {
			oauthLogger.error('Failed to fetch user preferences', {
				error: sanitizeError(preferencesError),
				message:
					preferencesError instanceof Error
						? preferencesError.message
						: String(preferencesError),
			})
			throw new AuthErrors.NoUserId()
		}

		const userIdFromSchwab =
			userPreferences?.streamerInfo?.[0]?.schwabClientCorrelId

		if (!userIdFromSchwab) {
			const error = new AuthErrors.NoUserId()
			const errorInfo = formatAuthError(error)
			oauthLogger.error(errorInfo.message)
			const jsonResponse = createJsonErrorResponse(error)
			return c.json(jsonResponse, errorInfo.status as any)
		}

		// Save token under BOTH clientId and schwabUserId keys.
		// Use capturedTokenData from the saveToken callback — do NOT re-load from KV here.
		// Cloudflare KV has no read-after-write consistency, so kv.get() immediately after
		// kv.put() returns null, causing the dual-key save to be silently skipped.
		// The DO always looks up tokens by schwabUserId first, so if only the clientId key
		// exists, every subsequent connection fails with "Unauthorized".
		try {
			if (capturedTokenData) {
				// Save under schwabUserId key (primary — what the DO looks up first)
				await kvToken.save({ schwabUserId: userIdFromSchwab }, capturedTokenData)
				// Save under clientId key (fallback for sessions without schwabUserId in props)
				await kvToken.save({ clientId: clientIdFromState }, capturedTokenData)
				oauthLogger.info('Token saved under both keys', {
					clientIdKey: sanitizeKeyForLog(
						kvToken.kvKey({ clientId: clientIdFromState }),
					),
					schwabUserIdKey: sanitizeKeyForLog(
						kvToken.kvKey({ schwabUserId: userIdFromSchwab }),
					),
				})

				// Clean up stale token keys from previous auth sessions
				// This prevents accumulation that confuses the daily cron refresh
				const kv = config.OAUTH_KV
				const newKeys = new Set([
					kvToken.kvKey({ schwabUserId: userIdFromSchwab }),
					kvToken.kvKey({ clientId: clientIdFromState }),
				])
				try {
					const allKeys = await kv.list({ prefix: TOKEN_KEY_PREFIX })
					for (const key of allKeys.keys) {
						const parts = key.name.replace(TOKEN_KEY_PREFIX, '').split(':')
						if (parts.length === 1 && !newKeys.has(key.name)) {
							await kv.delete(key.name)
							oauthLogger.info('Cleaned up stale token key', {
								key: sanitizeKeyForLog(key.name),
							})
						}
					}
				} catch (cleanupErr) {
					oauthLogger.warn('Stale token cleanup failed (non-fatal)', {
						error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
					})
				}
			} else {
				oauthLogger.warn('capturedTokenData is null — token may not have been saved by exchangeCode')
			}
		} catch (migrationError) {
			oauthLogger.warn(
				'Token save failed, continuing with authorization',
				{
					error:
						migrationError instanceof Error
							? migrationError.message
							: String(migrationError),
				},
			)
		}

		// Complete the authorization flow using the decoded AuthRequest object
		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			request: decodedStateAsAuthRequest,
			userId: userIdFromSchwab,
			metadata: { label: userIdFromSchwab },
			scope: decodedStateAsAuthRequest.scope,
			props: {
				// Only store IDs for token key derivation - tokens are in KV
				schwabUserId: userIdFromSchwab,
				clientId: clientIdFromState,
			},
		})

		return Response.redirect(redirectTo)
	} catch (error) {
		const isSchwabAuthError = error instanceof SchwabAuthError
		const isSchwabApiErrorInstance = error instanceof SchwabApiError

		let mcpError: AuthError = new AuthErrors.AuthCallback() // Default MCP error for this handler
		let detailMessage = error instanceof Error ? error.message : String(error)
		let httpStatus = 500 // Default HTTP status
		let requestId: string | undefined

		if (isSchwabAuthError) {
			const schwabAuthErr = error as SchwabAuthError
			const errorMapping = mapSchwabError(
				schwabAuthErr.code,
				schwabAuthErr.message,
				schwabAuthErr.status,
			)
			mcpError = errorMapping.mcpError
			detailMessage = errorMapping.detailMessage
			httpStatus = errorMapping.httpStatus

			// Extract requestId if available
			if (typeof (schwabAuthErr as any).getRequestId === 'function') {
				requestId = (schwabAuthErr as any).getRequestId()
			}
		} else if (isSchwabApiErrorInstance) {
			const schwabApiErr = error as SchwabApiError
			mcpError = new AuthErrors.ApiResponse()
			detailMessage = `API request failed during authorization: ${schwabApiErr.message}`
			httpStatus = schwabApiErr.status || 500

			// Extract requestId if available
			if (typeof (schwabApiErr as any).getRequestId === 'function') {
				requestId = (schwabApiErr as any).getRequestId()
			}
		}

		const errorInfo = formatAuthError(mcpError, {
			error,
			sdkErrorMessage: detailMessage,
			sdkErrorCode: isSchwabAuthError
				? (error as SchwabAuthError).code
				: isSchwabApiErrorInstance
					? (error as SchwabApiError).code
					: undefined,
			sdkStatus: httpStatus,
			requestId,
		})

		oauthLogger.error(`Auth callback failed: ${errorInfo.message}`, {
			errorType: mcpError.constructor.name,
			...(requestId && { requestId }),
		})

		const jsonResponse = createJsonErrorResponse(mcpError, requestId, {})

		return c.json(jsonResponse, errorInfo.status as any)
	}
})

// ---------------------------------------------------------------------------
// REST API — for the Python stock research pipeline
// Auth: X-API-Key header (stored as worker secret SCHWAB_REST_API_KEY)
// ---------------------------------------------------------------------------

/**
 * Loads an active Schwab API client by finding the first token in KV.
 * Since there is only one user (Owais), we list token: keys and use the first.
 */
async function createRestClient(
	kv: KVNamespace,
	config: ValidatedEnv,
): Promise<SchwabApiClient | null> {
	const list = await kv.list({ prefix: TOKEN_KEY_PREFIX })
	if (list.keys.length === 0) return null

	// Prefer the key with the most recent expiration (DO refreshes schwabUserId key on every refresh).
	// Keys with metadata.expiration set are sorted by that; otherwise take the longest name
	// (schwabUserId correlIds are longer than mcp-remote clientIds).
	const sortedKeys = list.keys.slice().sort((a, b) => {
		const expA = (a.expiration ?? 0)
		const expB = (b.expiration ?? 0)
		if (expA !== expB) return expB - expA  // most recently set TTL first
		return b.name.length - a.name.length   // longer key = schwabUserId
	})
	const bestKey = sortedKeys[0]
	if (!bestKey) return null

	const tokenKey = bestKey.name

	const loadToken = async (): Promise<TokenData | null> => {
		return (await kv.get(tokenKey, 'json')) as TokenData | null
	}
	const saveToken = async (data: TokenData): Promise<void> => {
		await kv.put(tokenKey, JSON.stringify(data), { expirationTtl: TTL_31_DAYS })
	}

	const tokenManager = initializeSchwabAuthClient(
		config,
		config.SCHWAB_REDIRECT_URI,
		loadToken,
		saveToken,
	)
	await tokenManager.initialize()

	return createApiClient({
		config: { environment: ENVIRONMENTS.PRODUCTION },
		auth: tokenManager,
	})
}

function checkApiKey(c: any): Response | null {
	const apiKey = c.req.header('X-API-Key')
	if (!apiKey || apiKey !== c.env.SCHWAB_REST_API_KEY) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

/** GET /api/quotes?symbols=NVDA,PLTR&fields=quote,fundamental */
app.get('/api/quotes', async (c) => {
	const denied = checkApiKey(c)
	if (denied) return denied

	const symbolsParam = c.req.query('symbols') ?? ''
	const fieldsParam = c.req.query('fields') ?? 'quote'
	if (!symbolsParam) return c.json({ error: 'symbols parameter required' }, 400)

	const symbols = symbolsParam.split(',').map(s => s.trim())
	const fields = fieldsParam.split(',').map(s => s.trim()) as Array<'all' | 'quote' | 'fundamental' | 'extended' | 'reference' | 'regular'>

	try {
		const config = getConfig(c.env)
		const client = await createRestClient(c.env.OAUTH_KV, config)
		if (!client) return c.json({ error: 'No active Schwab authentication' }, 503)
		const data = await client.marketData.quotes.getQuotes({
			queryParams: { symbols, fields },
		})
		return c.json(data)
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
	}
})

/** GET /api/price-history?symbol=NVDA&periodType=month&period=6&frequencyType=daily */
app.get('/api/price-history', async (c) => {
	const denied = checkApiKey(c)
	if (denied) return denied

	const symbol = c.req.query('symbol') ?? ''
	const periodType = (c.req.query('periodType') ?? 'month') as any
	const period = parseInt(c.req.query('period') ?? '6', 10)
	const frequencyType = (c.req.query('frequencyType') ?? 'daily') as any
	const frequency = parseInt(c.req.query('frequency') ?? '1', 10)
	if (!symbol) return c.json({ error: 'symbol parameter required' }, 400)

	try {
		const config = getConfig(c.env)
		const client = await createRestClient(c.env.OAUTH_KV, config)
		if (!client) return c.json({ error: 'No active Schwab authentication' }, 503)
		const data = await client.marketData.priceHistory.getPriceHistory({
			queryParams: { symbol, periodType, period, frequencyType, frequency },
		})
		return c.json(data)
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
	}
})

/** GET /api/market-hours?markets=equity */
app.get('/api/market-hours', async (c) => {
	const denied = checkApiKey(c)
	if (denied) return denied

	const markets = (c.req.query('markets') ?? 'equity') as any
	const date = c.req.query('date')

	try {
		const config = getConfig(c.env)
		const client = await createRestClient(c.env.OAUTH_KV, config)
		if (!client) return c.json({ error: 'No active Schwab authentication' }, 503)
		const data = await client.marketData.marketHours.getMarketHours({
			queryParams: {
				markets,
				date: date ? new Date(date).toISOString() : undefined,
			},
		})
		return c.json(data)
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
	}
})

export { app as SchwabHandler }
