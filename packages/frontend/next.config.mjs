import bundleAnalyzer from '@next/bundle-analyzer';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@arbitra/shared', '@arbitra/backend'],
  async redirects() {
    return [
      {
        source: '/cases',
        destination: '/board',
        permanent: false,
      },
      {
        source: '/intelligence',
        destination: '/observatory/intelligence',
        permanent: false,
      },
    ];
  },
};

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer(nextConfig);
