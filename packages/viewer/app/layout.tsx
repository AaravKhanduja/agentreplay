import type { Metadata } from 'next';

// Fontsource CSS serves `next dev`; the production single-file build strips
// these @font-face rules and embeds the same woff2 files as base64 instead
// (see scripts/inline.mjs).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentReplay',
  description: 'Visual postmortem of a Claude Code session',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
