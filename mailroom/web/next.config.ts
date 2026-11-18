import type { NextConfig } from "next";

// Production: static export served by bus/bus.py (no Node at runtime).
// Development: `npm run dev` proxies the API to a bus started with `serve --admin-port` (BUS_URL).
const isDev = process.env.NODE_ENV === "development";
const busUrl = process.env.BUS_URL ?? "http://127.0.0.1:8778";

const nextConfig: NextConfig = {
  ...(isDev
    ? {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${busUrl}/api/:path*` },
            { source: "/attach/:path*", destination: `${busUrl}/attach/:path*` },
            { source: "/repo/:path*", destination: `${busUrl}/repo/:path*` },
          ];
        },
      }
    : { output: "export" }),
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
