export interface GatewayConfig {
  port: number;
  /** Public base URL of the gateway (the MCP endpoint is `${gatewayUrl}/mcp`). */
  gatewayUrl: string;
  /** AIX API (authorization server + business API). */
  apiUrl: string;
  /** Requests per minute per user. */
  rateLimitPerMinute: number;
  /** Shared secret proving to the API that a request comes from this gateway (AIX_GATEWAY_SERVICE_SECRET). */
  serviceSecret?: string | undefined;
  /** Refuse downstream app URLs that resolve to private/loopback addresses (on in production). */
  blockPrivateUrls?: boolean;
}

export function loadGatewayConfig(env = process.env): GatewayConfig {
  return {
    port: Number(env.GATEWAY_PORT ?? env.PORT ?? 4100),
    gatewayUrl: (env.AIX_GATEWAY_URL ?? "http://localhost:4100").replace(/\/$/, ""),
    apiUrl: (env.AIX_API_URL ?? "http://localhost:4000").replace(/\/$/, ""),
    rateLimitPerMinute: Number(env.GATEWAY_RATE_LIMIT ?? 120),
    serviceSecret: env.AIX_GATEWAY_SERVICE_SECRET,
    blockPrivateUrls: env.NODE_ENV === "production" || env.GATEWAY_BLOCK_PRIVATE_URLS === "1",
  };
}
