import { type ValidatedEnv } from '../../types/env'
import { ALLOWLIST_KEY_PREFIX, INVITE_KEY_PREFIX } from '../shared/constants'
import { logger } from '../shared/log'

type KV = ValidatedEnv['OAUTH_KV']

const allowlistLogger = logger.child('allowlist')

/**
 * Invite codes are used verbatim in KV keys, so constrain them to a safe
 * charset. Anything else is treated as "no code provided".
 */
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function normalizeInviteCode(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined
	const trimmed = raw.trim()
	return INVITE_CODE_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * Which tool families a customer may use. `market` exposes only market-data
 * tools (quotes, price history, option chains, ...); `full` adds the trader
 * tools (accounts, orders, transactions).
 */
export type ToolScope = 'full' | 'market'

/**
 * Anything that isn't explicitly `full` collapses to `market`, so records
 * written before scopes existed (and malformed values) stay market-only.
 * Full access must be granted deliberately.
 */
export function normalizeToolScope(raw: unknown): ToolScope {
	return raw === 'full' ? 'full' : 'market'
}

/**
 * Returns the enrolled customer's tool scope, or null when not enrolled.
 * Enrollment records live at `allowed:<schwabClientCustomerId>`.
 */
export async function getEnrolledScope(
	kv: KV,
	schwabCustomerId: string,
): Promise<ToolScope | null> {
	const value = await kv.get(`${ALLOWLIST_KEY_PREFIX}${schwabCustomerId}`)
	if (value === null) return null
	try {
		return normalizeToolScope((JSON.parse(value) as { scope?: string }).scope)
	} catch {
		return 'market'
	}
}

/**
 * Redeems a one-time invite code (`invite:<code>`) and enrolls the customer.
 * The invite is deleted on success so a leaked code can't be reused. The
 * invite value may carry `scope: "full"` to grant trader tools; otherwise
 * the enrollment is market-only.
 *
 * @returns the enrolled scope, or null if the code was invalid
 */
export async function enrollWithInviteCode(
	kv: KV,
	inviteCode: string,
	schwabCustomerId: string,
): Promise<ToolScope | null> {
	const inviteKey = `${INVITE_KEY_PREFIX}${inviteCode}`
	const invite = await kv.get(inviteKey)
	if (invite === null) {
		allowlistLogger.warn('Invalid or already-used invite code presented', {
			inviteCode,
		})
		return null
	}

	let inviteNote: string | undefined
	let scope: ToolScope = 'market'
	try {
		const parsed = JSON.parse(invite) as { note?: string; scope?: string }
		inviteNote = parsed.note
		scope = normalizeToolScope(parsed.scope)
	} catch {
		// Invite value is free-form; a note is optional.
	}

	const enrollment = {
		enrolledAt: new Date().toISOString(),
		inviteCode,
		scope,
		...(inviteNote ? { note: inviteNote } : {}),
	}
	// Duplicate the record into KV metadata: `wrangler kv key list` returns
	// metadata inline, so the owner can see which person each enrolled
	// customer ID belongs to without fetching every value.
	await kv.put(
		`${ALLOWLIST_KEY_PREFIX}${schwabCustomerId}`,
		JSON.stringify(enrollment),
		{ metadata: enrollment },
	)
	await kv.delete(inviteKey)
	// customerIdPrefix: full customer IDs are redacted from logs by design
	allowlistLogger.info('Updated allowlist with newly enrolled customer', {
		inviteCode,
		customerIdPrefix: `${schwabCustomerId.slice(0, 8)}...`,
		scope,
		...(inviteNote ? { note: inviteNote } : {}),
	})
	return scope
}
