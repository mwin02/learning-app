import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone/ — Vercel ignores this; Cloud Run picks it up.
  output: 'standalone',

  // Playground revamp renames — keep old operator bookmarks working.
  // 307s (not permanent) so a future reuse of these paths isn't cached away.
  async redirects() {
    return [
      { source: '/playground/human-review', destination: '/playground/decomposition-review', permanent: false },
      { source: '/playground/concept-maps/:path*', destination: '/playground/paths/:path*', permanent: false },
    ];
  },
};

export default nextConfig;
