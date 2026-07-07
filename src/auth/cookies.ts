import {
	decodeOAuthState,
	createCookieTokenStore,
	type CookieTokenStoreOptions,
} from '@sudowealth/schwab-api'
import { type ValidatedEnv } from '../../types/env'
import {
	LOGGER_CONTEXTS,
	COOKIE_NAMES,
	HTTP_HEADERS,
} from '../shared/constants'
import { logger } from '../shared/log'
import { normalizeInviteCode } from './allowlist'
import { AuthErrors } from './errors'
import { ApprovedClientsSchema } from './schemas'
import { extractClientIdFromState, type StateData } from './stateUtils'

// Create scoped logger for cookie operations
const cookieLogger = logger.child(LOGGER_CONTEXTS.COOKIES)

const MCP_APPROVAL = COOKIE_NAMES.APPROVED_CLIENTS
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365

// Initialize cookie store for approved clients
let approvalCookieStore: ReturnType<typeof createCookieTokenStore> | null = null

/**
 * Get or create the approval cookie store
 */
function getApprovalCookieStore(secret: string) {
	if (!approvalCookieStore) {
		const options: CookieTokenStoreOptions = {
			encryptionKey: secret,
			cookieName: MCP_APPROVAL,
			cookieOptions: {
				httpOnly: true,
				secure: true,
				sameSite: 'strict',
				maxAge: ONE_YEAR_IN_SECONDS,
				path: '/',
			},
			validateOnLoad: false, // We'll validate with Zod schema
		}
		approvalCookieStore = createCookieTokenStore(options)
	}
	return approvalCookieStore
}

/**
 * Extracts and validates the approved clients from the cookie.
 */
async function parseApprovalCookie(
	cookieHeader: string | null,
	secret: string,
): Promise<string[] | undefined> {
	const store = getApprovalCookieStore(secret)

	try {
		// Use store's load method which handles verification
		const data = await store.load(cookieHeader)

		if (!data) {
			return undefined
		}

		// We store the client IDs as a JSON string in the accessToken field
		try {
			const approvedClients = JSON.parse(data.accessToken)
			return ApprovedClientsSchema.parse(approvedClients)
		} catch (e) {
			cookieLogger.warn('Cookie payload validation failed:', e)
			return undefined
		}
	} catch (error) {
		cookieLogger.error('Error parsing approval cookie:', error)
		return undefined
	}
}

/**
 * Sets the approval cookie with the provided client IDs.
 */
async function setApprovalCookie(
	approvedClients: string[],
	secret: string,
): Promise<string> {
	const store = getApprovalCookieStore(secret)

	// We're abusing the TokenData interface a bit here
	// Store the approved clients as a JSON string in the accessToken field
	const pseudoTokenData = {
		accessToken: JSON.stringify(approvedClients), // Store as JSON string
		refreshToken: '',
		expiresAt: Date.now() + ONE_YEAR_IN_SECONDS * 1000,
	}

	return await store.save(pseudoTokenData)
}

export async function clientIdAlreadyApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	if (!clientId) return false
	const cookieHeader = request.headers.get('Cookie')
	const approvedClients = await parseApprovalCookie(cookieHeader, cookieSecret)

	return approvedClients?.includes(clientId) ?? false
}

export interface ParsedApprovalResult {
	state: StateData
	headers: Record<string, string>
	/** One-time invite code entered on the approval dialog, if any */
	inviteCode?: string
}

/**
 * Builds a Set-Cookie header that clears the approval cookie. Used when
 * access is denied so the approval dialog (with its invite-code field)
 * is shown again on the next attempt instead of being skipped.
 */
export function buildClearApprovalCookieHeader(): string {
	return `${MCP_APPROVAL}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`
}

export async function parseRedirectApproval(
	request: Request,
	config: ValidatedEnv,
): Promise<ParsedApprovalResult> {
	const cookieSecret = config.COOKIE_ENCRYPTION_KEY
	if (request.method !== 'POST') {
		throw new AuthErrors.InvalidRequestMethod()
	}

	let encodedState: string
	let state: StateData
	let clientId: string
	let inviteCode: string | undefined

	try {
		const formData = await request.formData()
		const stateParam = formData.get('state')
		inviteCode = normalizeInviteCode(formData.get('inviteCode'))

		if (typeof stateParam !== 'string' || !stateParam) {
			throw new AuthErrors.MissingFormState()
		}

		encodedState = stateParam

		// The approval dialog uses btoa() to encode the state, which is standard base64
		// We should use atob() to decode it, not the OAuth state decoder
		// This matches how the state is encoded in src/auth/ui/approvalDialog.ts
		let decodedState: StateData
		try {
			const decodedStateJson = atob(encodedState)
			decodedState = JSON.parse(decodedStateJson) as StateData
		} catch {
			// If standard base64 decoding fails, try the OAuth decoder as fallback
			cookieLogger.warn('Standard base64 decode failed, trying OAuth decoder')
			const oauthDecoded = decodeOAuthState<StateData>(encodedState)
			if (!oauthDecoded) {
				throw new AuthErrors.InvalidState()
			}
			decodedState = oauthDecoded
		}

		state = decodedState
		clientId = extractClientIdFromState(state)
	} catch (e) {
		cookieLogger.error('Error processing form submission:', e)
		if (
			e instanceof AuthErrors.InvalidState ||
			e instanceof AuthErrors.MissingFormState ||
			e instanceof AuthErrors.ClientIdExtraction
		) {
			throw e
		}
		throw new AuthErrors.CookieDecode(e instanceof Error ? e : undefined)
	}

	// Get existing approved clients
	const cookieHeader = request.headers.get('Cookie')
	const existingApprovedClients =
		(await parseApprovalCookie(cookieHeader, cookieSecret)) ?? []

	// Add the newly approved client ID (avoid duplicates)
	const updatedApprovedClients = Array.from(
		new Set([...existingApprovedClients, clientId]),
	)

	// Create the Set-Cookie header
	const cookieHeaderValue = await setApprovalCookie(
		updatedApprovedClients,
		cookieSecret,
	)

	return {
		state,
		headers: { [HTTP_HEADERS.SET_COOKIE]: cookieHeaderValue },
		inviteCode,
	}
}
