"use client"

import { useState } from "react"

const STORAGE_KEY = "rojo-theme"

function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light"
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
}

/**
 * Light is the default; "dark" is stored in localStorage and stamped on <html>
 * before paint by the inline script in layout.tsx, so this button only has to
 * flip the attribute and keep storage in sync.
 */
export function ThemeToggle() {
  // Lazy init reads the attribute the layout script already set. On the server
  // this renders the light label; suppressHydrationWarning below covers the
  // one-word mismatch when the saved theme is dark.
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme)

  function toggle() {
    const next = theme === "dark" ? "light" : "dark"
    if (next === "dark") {
      document.documentElement.dataset.theme = "dark"
    } else {
      delete document.documentElement.dataset.theme
    }
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private mode etc. The toggle still works for this page view.
    }
    setTheme(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="btn-chip"
      aria-label="Switch between light and dark theme"
      suppressHydrationWarning
    >
      {theme === "dark" ? "☀ Light" : "🌙 Dark"}
    </button>
  )
}
