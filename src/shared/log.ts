/**
 * Lightweight Pino logger wrapper for Cloudflare Workers
 * Provides structured logging with automatic secret redaction
 */

import pino from 'pino'

// Pino log levels
export type PinoLogLevel =
	| 'trace'
	| 'debug'
	| 'info'
	| 'warn'
	| 'error'
	| 'fatal'

// Logger type that matches our existing interface
interface AppLogger {
	debug: (message: string, data?: any, contextId?: string) => void
	info: (message: string, data?: any, contextId?: string) => void
	warn: (message: string, data?: any, contextId?: string) => void
	error: (message: string, data?: any, contextId?: string) => void
	child: (contextId: string) => ChildLogger
}

// Child logger interface
interface ChildLogger {
	debug: (message: string, data?: any, contextId?: string) => void
	info: (message: string, data?: any, contextId?: string) => void
	warn: (message: string, data?: any, contextId?: string) => void
	error: (message: string, data?: any, contextId?: string) => void
}

// Redaction paths for sensitive data
const REDACT_PATHS = [
	'password',
	'secret',
	'token',
	'key',
	'auth',
	'authorization',
	'cookie',
	'session',
	'accessToken',
	'refreshToken',
	'api_key',
	'apiKey',
	'client_secret',
	'clientSecret',
	'schwabUserId',
	'schwabCustomerId',
	'schwabClientCustomerId',
	'clientId',
	'accountNumber',
	'hashValue',
	'schwabClientCorrelId',
	'sourceKey',
	'expectedKey',
	'tokenKey',
	'fromKey',
	'toKey',
	'*.password',
	'*.secret',
	'*.token',
	'*.key',
	'*.auth',
	'*.authorization',
	'*.cookie',
	'*.session',
	'*.accessToken',
	'*.refreshToken',
	'*.api_key',
	'*.apiKey',
	'*.client_secret',
	'*.clientSecret',
	'*.schwabUserId',
	'*.schwabCustomerId',
	'*.schwabClientCustomerId',
	'*.clientId',
	'*.accountNumber',
	'*.hashValue',
	'*.schwabClientCorrelId',
	'*.sourceKey',
	'*.expectedKey',
	'*.tokenKey',
	'*.fromKey',
	'*.toKey',
]

// Custom serializers for additional redaction
const serializers = {
	// Redact authorization headers
	req: (req: any) => {
		const serialized = pino.stdSerializers.req(req)
		if (serialized.headers?.authorization) {
			serialized.headers.authorization = '[REDACTED]'
		}
		if (serialized.headers?.cookie) {
			serialized.headers.cookie = '[REDACTED]'
		}
		return serialized
	},
	// Redact sensitive error properties
	err: (err: any) => {
		const serialized = pino.stdSerializers.err(err)
		// Add any custom error redaction here if needed
		return serialized
	},
}

/**
 * In Workers pino runs in browser mode, where the `timestamp` option is
 * ignored and logs go straight to console without one. Write each entry
 * ourselves with an ISO timestamp (millisecond precision) as the first
 * field. `serialize: true` keeps redaction applied before write is called.
 */
const LEVEL_LABELS: Record<number, string> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal',
}

function writeLog(consoleFn: (...args: unknown[]) => void) {
	return (o: object) => {
		const { time, level, msg, ...rest } = o as {
			time?: number
			level?: number
			msg?: string
			[key: string]: unknown
		}
		const ts = new Date(time ?? Date.now()).toISOString()
		const label = LEVEL_LABELS[level ?? 30] ?? String(level)
		if (Object.keys(rest).length > 0) {
			consoleFn(`${ts} [${label}] ${msg ?? ''}`, rest)
		} else {
			consoleFn(`${ts} [${label}] ${msg ?? ''}`)
		}
	}
}

// Pino configuration for Cloudflare Workers
const pinoConfig: pino.LoggerOptions = {
	// Use browser transport for console output in Workers
	browser: {
		serialize: true,
		write: {
			trace: writeLog(console.debug),
			debug: writeLog(console.debug),
			info: writeLog(console.info),
			warn: writeLog(console.warn),
			error: writeLog(console.error),
			fatal: writeLog(console.error),
		},
	},
	// Set redaction paths
	redact: {
		paths: REDACT_PATHS,
		censor: '[REDACTED]',
	},
	// Custom serializers
	serializers,
	// Base context (env tag adds noise to every line; timestamp carries the context)
	base: undefined,
}

/**
 * Build a logger instance with the specified log level
 */
export function buildLogger(level: PinoLogLevel = 'info'): AppLogger {
	// Create base pino instance
	const baseLogger = pino({
		...pinoConfig,
		level,
	})

	// Create wrapper that matches our existing interface
	const createLogFunction = (
		logFn: pino.LogFn,
	): ((message: string, data?: any, contextId?: string) => void) => {
		return (message: string, data?: any, contextId?: string) => {
			if (contextId) {
				logFn({ contextId, ...data }, message)
			} else if (data !== undefined) {
				logFn(data, message)
			} else {
				logFn(message)
			}
		}
	}

	const logger: AppLogger = {
		debug: createLogFunction(baseLogger.debug.bind(baseLogger)),
		info: createLogFunction(baseLogger.info.bind(baseLogger)),
		warn: createLogFunction(baseLogger.warn.bind(baseLogger)),
		error: createLogFunction(baseLogger.error.bind(baseLogger)),
		child: (contextId: string): ChildLogger => {
			const childLogger = baseLogger.child({ contextId })

			const createChildLogFunction = (
				logFn: pino.LogFn,
			): ((message: string, data?: any, contextId?: string) => void) => {
				return (message: string, data?: any, additionalContextId?: string) => {
					if (additionalContextId) {
						logFn({ contextId: additionalContextId, ...data }, message)
					} else if (data !== undefined) {
						logFn(data, message)
					} else {
						logFn(message)
					}
				}
			}

			return {
				debug: createChildLogFunction(childLogger.debug.bind(childLogger)),
				info: createChildLogFunction(childLogger.info.bind(childLogger)),
				warn: createChildLogFunction(childLogger.warn.bind(childLogger)),
				error: createChildLogFunction(childLogger.error.bind(childLogger)),
			}
		},
	}

	return logger
}

// Create singleton logger instance with default level
// This will be reconfigured in MyMCP.init() with the actual level from config
export const logger = buildLogger('info')
