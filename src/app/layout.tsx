import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "Play Rojo · Betting desk",
    template: "%s · Play Rojo",
  },
  description:
    "Pick games, get a booking code for SportyBet or Football.com. Play Rojo multi ticket desk.",
  applicationName: "Play Rojo",
  authors: [{ name: "Play Rojo" }],
  keywords: [
    "Play Rojo",
    "booking code",
    "SportyBet",
    "Football.com",
    "multibet",
    "Nigeria betting",
  ],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
      { url: "/brand/icon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/brand/mark.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Play Rojo",
    title: "Play Rojo · Betting desk",
    description:
      "Pick games, get a booking code for SportyBet or Football.com.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Play Rojo" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Play Rojo",
    description: "Pick games. Get the booking code.",
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: "#e10600",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;600;700;800&family=Share+Tech+Mono&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
