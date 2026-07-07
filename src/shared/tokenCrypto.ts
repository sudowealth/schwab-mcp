/**
 * AES-256-GCM encryption for token records at rest in KV.
 *
 * Cloudflare encrypts KV at the infrastructure level, but anything with KV
 * read access (dashboard, API tokens, wrangler) sees plaintext. Encrypting
 * at the application layer means a KV-scope leak alone cannot yield usable
 * brokerage tokens; an attacker would also need the TOKEN_ENCRYPTION_KEY
 * worker secret.
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Versioned envelope stored in KV in place of the plaintext record. */
export interface EncryptedEnvelope {
	v: 1
	alg: 'A256GCM'
	iv: string
	data: string
}

export function isEncryptedEnvelope(
	value: unknown,
): value is EncryptedEnvelope {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Partial<EncryptedEnvelope>
	return (
		candidate.v === 1 &&
		candidate.alg === 'A256GCM' &&
		typeof candidate.iv === 'string' &&
		typeof candidate.data === 'string'
	)
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(
			'TOKEN_ENCRYPTION_KEY must be 64 hex characters (generate with: openssl rand -hex 32)',
		)
	}
	const bytes = new Uint8Array(32)
	for (let i = 0; i < 32; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// Importing a CryptoKey is not free; cache per secret (one per isolate).
const keyCache = new Map<string, Promise<CryptoKey>>()

function getAesKey(secretHex: string): Promise<CryptoKey> {
	let cached = keyCache.get(secretHex)
	if (!cached) {
		cached = crypto.subtle.importKey(
			'raw',
			hexToBytes(secretHex),
			{ name: 'AES-GCM' },
			false,
			['encrypt', 'decrypt'],
		)
		keyCache.set(secretHex, cached)
	}
	return cached
}

export async function encryptJson(
	secretHex: string,
	value: unknown,
): Promise<EncryptedEnvelope> {
	const key = await getAesKey(secretHex)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		textEncoder.encode(JSON.stringify(value)),
	)
	return {
		v: 1,
		alg: 'A256GCM',
		iv: bytesToBase64(iv),
		data: bytesToBase64(new Uint8Array(ciphertext)),
	}
}

/** Throws if the key is wrong or the ciphertext was tampered with (GCM auth). */
export async function decryptJson<T>(
	secretHex: string,
	envelope: EncryptedEnvelope,
): Promise<T> {
	const key = await getAesKey(secretHex)
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
		key,
		base64ToBytes(envelope.data),
	)
	return JSON.parse(textDecoder.decode(plaintext)) as T
}
