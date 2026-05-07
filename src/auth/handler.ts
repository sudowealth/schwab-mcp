import { type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import {
	createApiClient,
	sanitizeKeyForLog,
	sanitizeError,
	SchwabAuthError,
	SchwabApiError,
	type TokenData,
} from '@sudowealth/schwab-api'
import { Hono } from 'hono'
import { type Env } from '../../types/env'
import { getConfig } from '../config'
import { LOGGER_CONTEXTS, APP_SERVER_NAME } from '../shared/constants'
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

		const saveToken = async (tokenData: TokenData) => {
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
		oauthLogger.info(
			'Exchanging authorization code for tokens with state parameter for PKCE',
		)
		try {
			// Pass the stateParam directly to EnhancedTokenManager.exchangeCode
			// EnhancedTokenManager will handle extracting the code_verifier from it
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

		// Migrate token from clientId-based key to schwabUserId-based key
		try {
			const currentTokenData = await kvToken.load({
				clientId: clientIdFromState,
			})
			if (currentTokenData) {
				// Save under schwabUserId key
				await kvToken.save({ schwabUserId: userIdFromSchwab }, currentTokenData)
				oauthLogger.info('Token migrated to schwabUserId key', {
					fromKeyPrefix: sanitizeKeyForLog(
						kvToken.kvKey({ clientId: clientIdFromState }),
					),
					toKeyPrefix: sanitizeKeyForLog(
						kvToken.kvKey({ schwabUserId: userIdFromSchwab }),
					),
				})
			}
		} catch (migrationError) {
			oauthLogger.warn(
				'Token migration failed, continuing with authorization',
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

/**
 * POST /register - Dynamic client registration endpoint
 * Allows mcp-remote and other OAuth clients to register
 */
app.post('/register', async (c) => {
	try {
		const body = await c.req.json().catch(() => ({}))
		const clientId = body.client_id || 'claude-desktop'
		const redirectUris = body.redirect_uris || []

		// Return a valid registration response
		return c.json(
			{
				client_id: clientId,
				client_secret: undefined,
				redirect_uris: redirectUris,
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code'],
				response_types: ['code'],
			},
			201,
		)
	} catch (error) {
		return c.json({ error: 'registration_failed' }, 500)
	}
})

export { app as SchwabHandler }
