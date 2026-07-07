import {
	type ClientRegistrationCallbackOptions,
	type ClientRegistrationCallbackResult,
} from '@cloudflare/workers-oauth-provider'
import { ALLOWED_REDIRECT_HOSTS } from '../shared/constants'
import { logger } from '../shared/log'

const registrationLogger = logger.child('registration')

/** Loopback redirects (MCP inspector, local dev tools) may use plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isAllowedRedirectUri(uri: string): boolean {
	let url: URL
	try {
		url = new URL(uri)
	} catch {
		return false
	}
	if (LOOPBACK_HOSTS.has(url.hostname)) {
		return url.protocol === 'http:' || url.protocol === 'https:'
	}
	if (url.protocol !== 'https:') {
		return false
	}
	return ALLOWED_REDIRECT_HOSTS.some(
		(host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
	)
}

/**
 * Registration policy for dynamic client registration (RFC 7591).
 *
 * Rejects any registration whose redirect_uris fall outside the known MCP
 * client hosts, so /register can't be used to route authorization codes to
 * attacker-controlled callbacks. Returning undefined accepts; returning a
 * result object makes the provider reject with that OAuth error.
 */
export function validateClientRegistration({
	clientMetadata,
}: ClientRegistrationCallbackOptions):
	| ClientRegistrationCallbackResult
	| undefined {
	const uris = clientMetadata.redirect_uris
	if (!Array.isArray(uris) || uris.length === 0) {
		// The provider validates presence before this callback; this guards
		// against that changing underneath us.
		return {
			code: 'invalid_client_metadata',
			description: 'redirect_uris is required',
		}
	}

	const rejected = uris.filter(
		(uri) => typeof uri !== 'string' || !isAllowedRedirectUri(uri),
	)
	if (rejected.length > 0) {
		registrationLogger.warn('Rejected client registration', {
			rejectedRedirectUris: rejected,
		})
		return {
			code: 'invalid_client_metadata',
			description:
				'redirect_uris must use https on an allowed MCP client host',
		}
	}

	registrationLogger.info('Client registration accepted', {
		redirectUris: uris,
	})
	return undefined
}
