/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The API is a separate NestJS process. Proxying through Next keeps the
  // browser same-origin, so the refresh cookie and any future CSRF token work
  // without CORS preflights in development.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL ?? 'http://localhost:4000'}/api/:path*` }];
  },
};
