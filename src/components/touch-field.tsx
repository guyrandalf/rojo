"use client"

import { useEffect, useState } from "react"

type TouchFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** How many decimals to show / allow */
  decimals?: number
  /** Optional hint under the field */
  hint?: string
}

/**
 * Mobile-friendly number control: big − / + and a free text field
 * you can wipe clean (native type=number is painful on phones).
 */
export function TouchField({
  label,
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  decimals = 0,
  hint,
}: TouchFieldProps) {
  const [text, setText] = useState(format(value, decimals))

  useEffect(() => {
    setText(format(value, decimals))
  }, [value, decimals])

  function commit(raw: string) {
    const cleaned = raw.replace(",", ".").trim()
    if (cleaned === "" || cleaned === "." || cleaned === "-") {
      setText(cleaned)
      return
    }
    const n = Number(cleaned)
    if (!Number.isFinite(n)) {
      setText(format(value, decimals))
      return
    }
    const clamped = clamp(roundTo(n, decimals), min, max)
    onChange(clamped)
    setText(format(clamped, decimals))
  }

  function bump(dir: -1 | 1) {
    const next = clamp(roundTo(value + dir * step, decimals), min, max)
    onChange(next)
    setText(format(next, decimals))
  }

  return (
    <label className="block border-b-3 border-black px-4 py-4 sm:border-r-3 lg:border-b-0">
      <span className="hud-label mb-2 block text-base">{label}</span>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => bump(-1)}
          disabled={value <= min}
          className="flex size-12 shrink-0 items-center justify-center border-3 border-black bg-panel-2 text-2xl font-black text-ink shadow-[2px_2px_0_#000] active:translate-x-px active:translate-y-px disabled:opacity-40"
        >
          −
        </button>
        <input
          type="text"
          inputMode={decimals > 0 ? "decimal" : "numeric"}
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            const v = e.target.value
            if (v === "" || /^-?\d*[.,]?\d*$/.test(v)) {
              setText(v)
            }
          }}
          onBlur={() => {
            if (text.trim() === "" || text === "." || text === "-") {
              onChange(min)
              setText(format(min, decimals))
              return
            }
            commit(text)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur()
            }
          }}
          className="min-w-0 flex-1 text-center text-xl font-bold"
        />
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => bump(1)}
          disabled={value >= max}
          className="flex size-12 shrink-0 items-center justify-center border-3 border-black bg-panel-2 text-2xl font-black text-ink shadow-[2px_2px_0_#000] active:translate-x-px active:translate-y-px disabled:opacity-40"
        >
          +
        </button>
      </div>
      {hint ? (
        <p className="mt-1.5 text-sm font-semibold text-dim">{hint}</p>
      ) : null}
    </label>
  )
}

function format(n: number, decimals: number) {
  if (!Number.isFinite(n)) return ""
  if (decimals <= 0) return String(Math.round(n))
  return n.toFixed(decimals)
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function roundTo(n: number, decimals: number) {
  if (decimals <= 0) return Math.round(n)
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
