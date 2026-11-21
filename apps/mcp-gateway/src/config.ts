export interface GatewayConfig {
  port: number;
  /** Public base URL of the gateway (the MCP endpoint is `${gatewayUrl}/mcp`). */
  gatewayUrl: string;
  /** AIX API (authorization server + business API). */
  apiUrl: string;
  /** Requests per minute per user. */
  rateLimitPerMinute: number;
}

export function loadGatewayConfig(env = process.env): GatewayConfig {
  return {
    port: Number(env.GATEWAY_PORT ?? env.PORT ?? 4100),
    gatewayUrl: (env.AIX_GATEWAY_URL ?? "http://localhost:4100").replace(/\/$/, ""),
    apiUrl: (env.AIX_API_URL ?? "http://localhost:4000").replace(/\/$/, ""),
    rateLimitPerMinute: Number(env.GATEWAY_RATE_LIMIT ?? 120),
  };
}
