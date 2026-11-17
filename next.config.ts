import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Reel joining runs ffmpeg (server/reels/join.ts) and story uploads run ffprobe (server/stories/probe.ts; Linux for deploys, Windows for local builds) and story frames need the bundled fonts (server/stories/render.ts); jobs run in any API route's after(), so every v1 route ships the binary (ponytail: ~75 MB per function; move rendering to one route if size bites).
  outputFileTracingIncludes: { "/api/v1/**/*": ["./node_modules/ffmpeg-static/ffmpeg*", "./node_modules/ffprobe-static/bin/linux/x64/*", "./node_modules/ffprobe-static/bin/win32/x64/*", "./assets/fonts/*"] },
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  // This repo is its own project root. Pinned explicitly: while the folder still sits inside the old monorepo, Next
  // would otherwise pick the parent's lockfile and trace (and nest the standalone output) from there.
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
  // The mobile app's Expo web preview (dev only) calls this API cross-origin with a Bearer token.
  // Native apps need no CORS; production sends none of these headers.
  async headers() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/api/v1/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "http://localhost:8090" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Authorization, Content-Type, X-Workspace-Id" },
        ],
      },
    ];
  },
};

export default nextConfig;
