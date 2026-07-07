import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024

/**
 * Legacy HTTP+SSE transport (2024-11-05 MCP spec revision), kept for clients
 * that have not migrated to Streamable HTTP yet. Mirrors the transport
 * previously vendored inside `workers-mcp`.
 */
export class SseEdgeTransport implements Transport {
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null
	private readonly stream: ReadableStream<Uint8Array>
	private closed = false

	sessionId: string
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage) => void

	constructor(
		private readonly messageUrl: string,
		sessionId: string,
	) {
		this.sessionId = sessionId
		this.stream = new ReadableStream({
			start: (controller) => {
				this.controller = controller
			},
			cancel: () => {
				this.closed = true
				this.onclose?.()
			},
		})
	}

	async start(): Promise<void> {
		if (this.closed) {
			throw new Error('SSE transport already closed!')
		}
		if (!this.controller) {
			throw new Error('Stream controller not initialized')
		}
		const endpointMessage = `event: endpoint\ndata: ${encodeURI(this.messageUrl)}?sessionId=${this.sessionId}\n\n`
		this.controller.enqueue(new TextEncoder().encode(endpointMessage))
	}

	get sseResponse(): Response {
		return new Response(this.stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		})
	}

	async handlePostMessage(request: Request): Promise<Response> {
		if (this.closed || !this.controller) {
			return new Response('SSE connection not established', { status: 500 })
		}
		try {
			const contentType = request.headers.get('content-type') || ''
			if (!contentType.includes('application/json')) {
				throw new Error(`Unsupported content-type: ${contentType}`)
			}
			const contentLength = parseInt(
				request.headers.get('content-length') || '0',
				10,
			)
			if (contentLength > MAXIMUM_MESSAGE_SIZE) {
				throw new Error(`Request body too large: ${contentLength} bytes`)
			}
			const body = await request.json()
			await this.handleMessage(body)
			return new Response('Accepted', { status: 202 })
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)))
			return new Response(String(error), { status: 400 })
		}
	}

	async handleMessage(message: unknown): Promise<void> {
		let parsedMessage: JSONRPCMessage
		try {
			parsedMessage = JSONRPCMessageSchema.parse(message)
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)))
			throw error
		}
		this.onmessage?.(parsedMessage)
	}

	async close(): Promise<void> {
		if (!this.closed && this.controller) {
			this.controller.close()
			this.closed = true
			this.onclose?.()
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (this.closed || !this.controller) {
			throw new Error('Not connected')
		}
		const messageText = `event: message\ndata: ${JSON.stringify(message)}\n\n`
		this.controller.enqueue(new TextEncoder().encode(messageText))
	}
}
