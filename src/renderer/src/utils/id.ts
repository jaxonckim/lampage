export function uid(prefix = 'doc'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function kindFromName(name: string): 'pdf' | 'md' {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  return 'md'
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  return btoa(binary)
}

export function decodeText(data: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(data)
}

export function encodeText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}
