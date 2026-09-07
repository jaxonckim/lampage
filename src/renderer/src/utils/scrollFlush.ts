/**
 * Per-document scroll flushers so tab switches can persist browse position
 * synchronously *before* activeId changes (unmount cleanup alone races setActive).
 */
const flushers = new Map<string, () => void>()

export function registerScrollFlusher(docId: string, flush: () => void): () => void {
  flushers.set(docId, flush)
  return () => {
    if (flushers.get(docId) === flush) flushers.delete(docId)
  }
}

/** Flush the active viewer's scroll into the OpenDoc store (no-op if none registered). */
export function flushScrollFor(docId: string | null | undefined): void {
  if (!docId) return
  flushers.get(docId)?.()
}
