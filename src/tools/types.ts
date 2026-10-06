import { type SchwabApiClient } from '@sudowealth/schwab-api'
import { type z } from 'zod'

/**
 * Extra capabilities available to tools that need to bypass the SDK client
 * (e.g. when Schwab's real responses don't match the SDK's strict schemas).
 */
export interface ToolContext {
	getAccessToken: () => Promise<string | null>
}

export interface ToolSpec<S extends z.ZodSchema> {
	name: string
	description: string
	schema: S
	call: (
		client: SchwabApiClient,
		params: z.infer<S>,
		ctx: ToolContext,
	) => Promise<unknown>
}

// Factory function to create properly typed tool specs
export function createToolSpec<S extends z.ZodSchema>(spec: {
	name: string
	description: string
	schema: S
	call: (
		client: SchwabApiClient,
		params: z.infer<S>,
		ctx: ToolContext,
	) => Promise<unknown>
}): ToolSpec<S> {
	return spec
}
