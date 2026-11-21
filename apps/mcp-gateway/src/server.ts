import { loadGatewayConfig } from "./config.js";
import { createGatewayHttpServer } from "./http.js";

const cfg = loadGatewayConfig();
createGatewayHttpServer(cfg).listen(cfg.port, () => {
  console.log(`AIX MCP gateway on ${cfg.gatewayUrl}/mcp (authorization server: ${cfg.apiUrl})`);
});
