import { randomBytes } from "node:crypto";
import { generateSigningKeyPem } from "../lib/keys.js";

// Prints fresh values for .env. Never commit the output.
console.log(`AIX_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`AIX_SIGNING_PRIVATE_KEY="${generateSigningKeyPem().trim().replace(/\n/g, "\\n")}"`);
