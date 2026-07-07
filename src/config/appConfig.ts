import { z } from 'zod'
import { type Env, type ValidatedEnv } from '../../types/env'
import { logger } from '../shared/log'

const envSchema = z.object({
	SCHWAB_CLIENT_ID: z
		.string({
			required_error: 'SCHWAB_CLIENT_ID is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_ID cannot be empty'),

	SCHWAB_CLIENT_SECRET: z
		.string({
			required_error:
				'SCHWAB_CLIENT_SECRET is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_SECRET cannot be empty'),

	COOKIE_ENCRYPTION_KEY: z
		.string({
			required_error:
				'COOKIE_ENCRYPTION_KEY is required for secure cookie storage',
		})
		.min(1, 'COOKIE_ENCRYPTION_KEY cannot be empty'),

	TOKEN_ENCRYPTION_KEY: z
		.string({
			required_error:
				'TOKEN_ENCRYPTION_KEY is required to encrypt Schwab tokens in KV',
		})
		.regex(
			/^[0-9a-fA-F]{64}$/,
			'TOKEN_ENCRYPTION_KEY must be 64 hex characters (generate with: openssl rand -hex 32)',
		),

	SCHWAB_REDIRECT_URI: z
		.string({
			required_error: 'SCHWAB_REDIRECT_URI is required for OAuth callback',
		})
		.url('SCHWAB_REDIRECT_URI must be a valid URL'),

	OAUTH_KV: z.any().refine((v) => !!v, {
		message: 'OAUTH_KV binding is required for token storage',
	}),

	LOG_LEVEL: z
		.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
		.optional()
		.default('info'),

	ENVIRONMENT: z
		.enum(['development', 'staging', 'production'])
		.optional()
		.default('production'),
})

function buildConfigInternal(env: Env): ValidatedEnv {
	try {
		const validated = envSchema.parse(env)
		return Object.freeze(validated) as ValidatedEnv
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map((issue) => {
					const path = issue.path.join('.')
					return `  - ${path}: ${issue.message}`
				})
				.join('\n')

			const msg = `Environment validation failed:\n${issues}`
			logger.error(msg)
			throw new Error(msg)
		}
		throw error
	}
}

// Memoized singleton config getter
export const getConfig = (() => {
	let cachedConfig: ValidatedEnv | null = null
	let cachedEnvHash: string | null = null

	return (env: Env): ValidatedEnv => {
		// Create a simple hash of the env object for memoization
		// Exclude OAUTH_PROVIDER to avoid circular reference issues
		const envHash = JSON.stringify(
			Object.keys(env)
				.filter((key) => key !== 'OAUTH_PROVIDER') // Exclude circular reference
				.sort()
				.map((key) => [key, (env as any)[key]]),
		)

		if (cachedConfig && cachedEnvHash === envHash) {
			return cachedConfig
		}

		cachedConfig = buildConfigInternal(env)
		cachedEnvHash = envHash
		return cachedConfig
	}
})()
