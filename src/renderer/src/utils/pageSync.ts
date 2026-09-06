/** Suppress IntersectionObserver → currentPage updates during programmatic jumps. */
let until = 0

export function suppressPageSync(ms = 600): void {
  until = Date.now() + ms
}

export function isPageSyncSuppressed(): boolean {
  return Date.now() < until
}
