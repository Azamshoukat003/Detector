/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Escape hatch so a second dev server can be run against the same checkout
  // without two processes fighting over one .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
