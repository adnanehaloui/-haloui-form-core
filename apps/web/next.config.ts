import type { NextConfig } from "next";

const api = process.env.AIX_API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  // The browser only ever talks to this origin; /api/* is proxied to the AIX API so the
  // session cookie stays first-party (HttpOnly, SameSite=Lax).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
  poweredByHeader: false,
};
export default config;
