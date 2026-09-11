/**
 * Explicitly ESM (.mjs) rather than .js, so it loads correctly whether or not
 * package.json declares "type": "module". A CommonJS next.config.js fails with
 * "module is not defined in ES module scope" the moment that field appears.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // Escape hatch so a second dev server can be run against the same checkout
  // without two processes fighting over one .next directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
