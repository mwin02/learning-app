import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Caveat, Kalam } from "next/font/google";
import "./globals.css";

// IBM Plex is the app-wide brand font. next/font exposes the families as CSS
// variables; globals.css wires them into Tailwind's --font-sans / --font-mono
// theme tokens, so the `font-sans` / `font-mono` utilities resolve to Plex.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Notebook UI handwriting pair (frontend redesign): Caveat for display/headings
// ("hand"), Kalam for running text ("script"). globals.css maps them to the
// `font-hand` / `font-script` utilities.
const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const kalam = Kalam({
  variable: "--font-kalam",
  subsets: ["latin"],
  weight: ["300", "400", "700"],
});

export const metadata: Metadata = {
  title: "Adaptive Learning Path",
  description: "Personalized, AI-curated learning paths.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${caveat.variable} ${kalam.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
