import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  experimental: {
    strictRouteTypes: true,
  },
};

export default config;
