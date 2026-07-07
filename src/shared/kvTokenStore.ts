// Full `import type` (vs inline `{ type }`) keeps this module runnable
// outside the worker bundler for unit tests: inline specifiers still emit a
// runtime import of the SDK, whose ESM dist needs bundler-style resolution.
// eslint-disable-next-line import/consistent-type-specifier-style
import type { TokenIdentifiers } from '@sudowealth/schwab-api'
import { TOKEN_KEY_PREFIX, TTL_31_DAYS, LOGGER_CONTEXTS } from './constants'
import { logger } from './log'
import {
	encryptJson,
	decryptJson,
	isEncryptedEnvelope,
} from './tokenCrypto'

export interface KvTokenStore<T = any> {
	load(ids: TokenIdentifiers): Promise<T | null>
	save(ids: TokenIdentifiers, data: T): Promise<void>
	delete(ids: TokenIdentifiers): Promise<void>
	kvKey(ids: TokenIdentifiers): string
}

/** Show prefix and suffix only, matching the SDK's sanitizeKeyForLog. */
function sanitizeKey(key: string): string {
	if (key.length <= 15) return key
	return `${key.substring(0, 10)}...${key.substring(key.length - 5)}`
}

/**
 * KV-backed token store with AES-256-GCM encryption at rest.
 *
 * Key priority mirrors the previous SDK store: customId > schwabUserId >
 * clientId. load() checks each identifier's key in that order, so callers
 * holding only a clientId (the auth callback, before the customer ID is
 * known) and callers holding both (the Durable Object) read consistently.
 *
 * Only encrypted envelopes are readable; anything else (including records
 * written before encryption was introduced) is treated as missing, which
 * sends the user through re-authentication.
 */
export function makeKvTokenStore<T = any>(
	kv: KVNamespace,
	encryptionKey: string,
): KvTokenStore<T> {
	const storeLogger = logger.child(LOGGER_CONTEXTS.KV_TOKEN_STORE)

	const kvKey = (ids: TokenIdentifiers): string => {
		const identifier = ids.customId || ids.schwabUserId || ids.clientId
		if (!identifier) {
			throw new Error(
				'Token identifiers must include customId, schwabUserId, or clientId',
			)
		}
		return `${TOKEN_KEY_PREFIX}${identifier}`
	}

	const save = async (ids: TokenIdentifiers, data: T): Promise<void> => {
		const envelope = await encryptJson(encryptionKey, data)
		await kv.put(kvKey(ids), JSON.stringify(envelope), {
			expirationTtl: TTL_31_DAYS,
		})
	}

	const load = async (ids: TokenIdentifiers): Promise<T | null> => {
		const candidateKeys = [
			...new Set(
				[ids.customId, ids.schwabUserId, ids.clientId]
					.filter((id): id is string => !!id)
					.map((id) => `${TOKEN_KEY_PREFIX}${id}`),
			),
		]
		for (const key of candidateKeys) {
			const raw = await kv.get(key)
			if (!raw) continue
			try {
				const parsed = JSON.parse(raw) as unknown
				if (isEncryptedEnvelope(parsed)) {
					return await decryptJson<T>(encryptionKey, parsed)
				}
				storeLogger.warn('Discarding non-envelope token record', {
					keyPrefix: sanitizeKey(key),
				})
			} catch (error) {
				// Wrong key (e.g. rotated secret) or corrupt record: treat as
				// missing so the user is sent through re-authentication.
				storeLogger.error('Failed to read token record', {
					keyPrefix: sanitizeKey(key),
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return null
	}

	return {
		load,
		save,
		delete: async (ids: TokenIdentifiers) => {
			await kv.delete(kvKey(ids))
		},
		kvKey,
	}
}

// Re-export the type for backward compatibility
export type { TokenIdentifiers }
