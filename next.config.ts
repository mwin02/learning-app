import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone/ — Vercel ignores this; Cloud Run picks it up.
  output: 'standalone',
};

export default nextConfig;
