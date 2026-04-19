/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow images from any source (needed for the ELA heatmap data URLs)
  images: {
    unoptimized: true,
  },
  // Expose NEXT_PUBLIC_API_URL to the browser bundle
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  },
};

module.exports = nextConfig;
