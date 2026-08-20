/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg is a native-ish server dependency; bundling it into the server build
  // breaks its dynamic requires.
  serverExternalPackages: ['pg'],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
