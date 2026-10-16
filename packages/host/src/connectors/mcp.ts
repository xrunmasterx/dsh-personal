/** Read-only MCP transport with Host-owned credentials and bounded responses. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Connection inputs resolved from the owning workbench's deployment config. */
export interface McpEndpoint {
  url: string
  headers: Record<string, string>
  timeoutMs: number
  signal: AbortSignal
}

/** A connection whose caller owns close and every admitted tool name. */
export class ReadOnlyMcp {
  private readonly client = new Client({ name: 'dsh-personal-workbench', version: '1.0.0' })

  private constructor(
    private readonly endpoint: McpEndpoint,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  /**
   * Connect an explicitly configured endpoint without starting a model.
   * @param endpoint - Host endpoint, credentials and cancellation.
   * @param allowed - exact server-side read tool names admitted by this consumer.
   * @returns connection owned by the caller until disconnect completes.
   */
  static async open(endpoint: McpEndpoint, allowed: ReadonlySet<string>): Promise<ReadOnlyMcp> {
    const url = new URL(endpoint.url)
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('MCP endpoint must be HTTPS without URL credentials')
    endpoint.signal.throwIfAborted()
    const session = new ReadOnlyMcp(endpoint, allowed)
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: endpoint.headers, signal: endpoint.signal },
    })
    try {
      // The SDK getter returns undefined before negotiation; its Transport declaration uses an exact optional field.
      await session.client.connect(transport as Transport, { signal: endpoint.signal, timeout: endpoint.timeoutMs })
      endpoint.signal.throwIfAborted()
      return session
    } catch (error) {
      await session.client.close()
      throw error
    }
  }

  /**
   * Invoke an admitted read tool with the connection's cancellation and deadline.
   * @param name - exact server tool name.
   * @param args - JSON arguments validated by the owning business adapter.
   * @returns the MCP content envelope, validated by the adapter.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.allowed.has(name)) throw new Error(`MCP tool is not an admitted read: ${name}`)
    this.endpoint.signal.throwIfAborted()
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      signal: this.endpoint.signal,
      timeout: this.endpoint.timeoutMs,
    })
    if (result.isError) throw new Error(`MCP read failed: ${name}`)
    return result
  }

  /** Release this connection and reject outstanding transport work. */
  async disconnect(): Promise<void> {
    await this.client.close()
  }
}

/**
 * Narrow external JSON to an object before reading transport fields.
 * @param value - untrusted decoded value.
 * @returns whether it is a non-array JSON object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Extract JSON or a download URL from the MCP envelope without discarding errors.
 * @param value - raw server response.
 * @returns decoded structured content or one textual result.
 */
export function mcpPayload(value: unknown): unknown {
  if (!isRecord(value)) throw new Error('MCP returned no result envelope')
  if (value.isError === true) throw new Error('MCP reported a failed read')
  if (value.structuredContent !== undefined) return value.structuredContent
  if (!Array.isArray(value.content)) throw new Error('MCP returned no content')
  const texts = value.content.flatMap(block =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  )
  for (const text of texts) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      /* The server can return a plain download URL instead of JSON. */
    }
  }
  if (texts.length === 1) return texts[0]
  throw new Error('MCP returned an unsupported response')
}

/**
 * Unwrap a business response, rejecting explicit service error codes.
 * @param value - decoded external JSON.
 * @returns the data object owning the requested rows.
 */
export function responseData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a JSON object from the data source')
  if (
    value.success === false ||
    (typeof value.errorCode === 'string' && value.errorCode.length > 0) ||
    (value.code !== undefined && ![0, '0', 200, '200'].includes(value.code as string | number))
  ) {
    throw new Error('The data source rejected the read request')
  }
  return isRecord(value.data) ? value.data : isRecord(value.ret) ? value.ret : value
}
