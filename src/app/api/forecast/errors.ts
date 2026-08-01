import "server-only"

/** Map pipeline failures to statuses + words a punter can act on. */
export function humanError(err: unknown): { status: number; error: string } {
  const message = err instanceof Error ? err.message : "Could not make code"

  if (/not enough high-conviction|no matches found/i.test(message)) {
    return { status: 422, error: message }
  }
  if (/run not found|not part of this run/i.test(message)) {
    return { status: 404, error: message }
  }
  if (
    /timed out|timeout|ETIMEDOUT/i.test(message) ||
    /UND_ERR_CONNECT/i.test(message)
  ) {
    return {
      status: 504,
      error: "Took too long. Try again — the run continues where it stopped.",
    }
  }
  if (/Could not load fixtures|ECONNREFUSED|fetch failed|network/i.test(message)) {
    return {
      status: 502,
      error:
        "Could not reach the betting site board. Try again, or switch betting site.",
    }
  }

  return { status: 502, error: message }
}
