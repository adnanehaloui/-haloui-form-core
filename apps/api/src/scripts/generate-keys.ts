import { randomBytes } from "node:crypto";
import { generateSigningKeyPem } from "../lib/keys.js";

// Prints fresh values for .env. Never commit the output.
console.log(`AIX_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`AIX_GATEWAY_SERVICE_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`AIX_METRICS_TOKEN=${randomBytes(24).toString("base64url")}`);
console.log(`AIX_SIGNING_PRIVATE_KEY="${generateSigningKeyPem().trim().replace(/\n/g, "\\n")}"`);
