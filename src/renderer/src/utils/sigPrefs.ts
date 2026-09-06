/** Last-used signature id + saved list order (renderer localStorage). */

const LAST_ID_KEY = 'lampage.lastSignatureId.v1'
const ORDER_KEY = 'lampage.signatureOrder.v1'

export function getLastSignatureId(): string | null {
  try {
    const v = localStorage.getItem(LAST_ID_KEY)
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function setLastSignatureId(id: string): void {
  try {
    if (!id) return
    localStorage.setItem(LAST_ID_KEY, id)
  } catch {
    /* ignore */
  }
}

export function getSignatureOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

export function setSignatureOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

/** Apply remembered order; unknown ids keep relative list order at the end. */
export function sortSignaturesByOrder<T extends { id: string }>(list: T[]): T[] {
  const order = getSignatureOrder()
  if (!order.length || list.length <= 1) return list
  const map = new Map(list.map((s) => [s.id, s]))
  const out: T[] = []
  for (const id of order) {
    const s = map.get(id)
    if (s) {
      out.push(s)
      map.delete(id)
    }
  }
  for (const s of list) {
    if (map.has(s.id)) out.push(s)
  }
  return out
}
