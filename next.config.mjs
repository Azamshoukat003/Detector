import { createRequire } from 'module';

const require = createRequire(import.meta.url);









/**
 * Explicitly ESM (.mjs) rather than .js, so it loads correctly whether or not
 * package.json declares "type": "module". A CommonJS next.config.js fails with
 * "module is not defined in ES module scope" the moment that field appears.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
