import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
	JSONRPCMessageSchema,
	isJSONRPCRequest,
	type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024

interface PendingBatch {
	remaining: Set<string>
	responses: JSONRPCMessage[]
	resolve: (response: Response) => void
}

interface PendingRequest {
	batch: PendingBatch
	/** The client's original JSON-RPC id, restored on the response. */
	originalId: string | number
}

/**
 * Streamable HTTP server transport (2025-03-26+ MCP spec revision) for
 * Cloudflare Workers. Unlike the reference SDK transport, this speaks the
 * Fetch API (Request/Response) directly instead of Node's http module, since
 * Workers has no IncomingMessage/ServerResponse.
 *
 * Each POST carries one JSON-RPC message (or a batch); the returned Response
 * resolves once every request in that batch has a matching reply. This
 * server never pushes unsolicited server->client messages, so the optional
 * standalone GET/SSE stream and session-termination DELETE are not
 * implemented (both are legal to omit per spec, returning 405).
 *
 * One transport instance may serve concurrent MCP sessions (the Durable
 * Object is shared per user), and independent clients can pick colliding
 * JSON-RPC ids. Request ids are therefore rewritten to a transport-unique
 * value before dispatch and restored on the response.
 */
export class StreamableHttpEdgeTransport implements Transport {
	private closed = false
	private nextInternalId = 0
	private readonly pendingByInternalId = new Map<string, PendingRequest>()

	sessionId: string
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage) => void

	constructor(sessionId: string) {
		this.sessionId = sessionId
	}

	async start(): Promise<void> {}

	async handleRequest(request: Request): Promise<Response> {
		if (this.closed) {
			return new Response('Transport closed', { status: 503 })
		}

		const contentType = request.headers.get('content-type') || ''
		if (!contentType.includes('application/json')) {
			return new Response(`Unsupported content-type: ${contentType}`, {
				status: 415,
			})
		}
		const contentLength = parseInt(
			request.headers.get('content-length') || '0',
			10,
		)
		if (contentLength > MAXIMUM_MESSAGE_SIZE) {
			return new Response('Request body too large', { status: 413 })
		}

		let body: unknown
		try {
			body = await request.json()
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)))
			return new Response('Invalid JSON', { status: 400 })
		}

		const rawMessages = Array.isArray(body) ? body : [body]
		const messages: JSONRPCMessage[] = []
		try {
			for (const raw of rawMessages) {
				messages.push(JSONRPCMessageSchema.parse(raw))
			}
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)))
			return new Response('Invalid JSON-RPC message', { status: 400 })
		}

		const requests = messages.filter(isJSONRPCRequest)

		if (requests.length === 0) {
			// Only notifications/responses from the client: nothing to reply with.
			for (const message of messages) this.onmessage?.(message)
			return new Response(null, { status: 202 })
		}

		const responsePromise = new Promise<Response>((resolve) => {
			const batch: PendingBatch = {
				remaining: new Set(),
				responses: [],
				resolve,
			}
			for (const message of requests) {
				const internalId = `i${this.nextInternalId++}`
				this.pendingByInternalId.set(internalId, {
					batch,
					originalId: message.id,
				})
				batch.remaining.add(internalId)
				message.id = internalId
			}
		})

		for (const message of messages) this.onmessage?.(message)

		return responsePromise
	}

	/** The standalone server-push stream is not supported; per spec, 405 is a valid response. */
	async handleGetRequest(): Promise<Response> {
		return new Response(null, { status: 405, headers: { Allow: 'POST' } })
	}

	async handleDeleteRequest(): Promise<Response> {
		await this.close()
		return new Response(null, { status: 200 })
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		for (const pending of this.pendingByInternalId.values()) {
			pending.batch.resolve(new Response(null, { status: 503 }))
		}
		this.pendingByInternalId.clear()
		this.onclose?.()
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!('id' in message)) return // server-initiated notification; no open stream to deliver it on

		const key = String(message.id)
		const pending = this.pendingByInternalId.get(key)
		if (!pending) return // unmatched or late response; nothing to resolve

		const { batch, originalId } = pending
		message.id = originalId
		batch.responses.push(message)
		batch.remaining.delete(key)
		this.pendingByInternalId.delete(key)

		if (batch.remaining.size === 0) {
			const body = batch.responses.length === 1 ? batch.responses[0] : batch.responses
			batch.resolve(
				Response.json(body, {
					headers: { 'Mcp-Session-Id': this.sessionId },
				}),
			)
		}
	}
}
