import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: let phones/laptops on the local network open `next dev`
  // by IP (e.g. http://192.168.1.5:3000). Without this, Next blocks the
  // dev scripts for that origin and the page never becomes interactive.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
};

export default nextConfig;
