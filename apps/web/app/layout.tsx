import type { Metadata, Viewport } from 'next';
import './globals.css';

/* A system font stack rather than a webfont: zero network round-trips, no
   layout shift, and it already looks native on every platform. Swap in
   `next/font/local` with a self-hosted Inter if the brand needs it — self-hosted
   rather than Google Fonts, which is a third-party request on every page load. */

export const metadata: Metadata = {
  title: 'SNAPX — Capture. Connect. Share.',
  description: 'A camera-first way to share moments with the people who matter.',
  applicationName: 'SNAPX',
};

export const viewport: Viewport = {
  themeColor: '#080808',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Lets the camera fill the notch area on iOS rather than letterboxing.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-full bg-bg">{children}</body>
    </html>
  );
}
