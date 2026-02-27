/**
 * Client-side encryption for API keys stored in Convex.
 * Uses AES-GCM with a key derived from a passphrase via PBKDF2.
 * 
 * For single-user: passphrase is a static secret.
 * For multi-user SaaS: passphrase will be per-user (derived from auth).
 */

const SALT = new TextEncoder().encode('clipper-dashboard-v1')
const ITERATIONS = 100000

async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function encryptKey(plaintext: string, passphrase: string): Promise<string> {
  if (!plaintext) return ''
  const key = await deriveKey(passphrase)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  )
  // Combine IV + ciphertext, base64 encode
  const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length)
  combined.set(iv)
  combined.set(new Uint8Array(encrypted), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decryptKey(ciphertext: string, passphrase: string): Promise<string> {
  if (!ciphertext) return ''
  try {
    const key = await deriveKey(passphrase)
    const combined = new Uint8Array(atob(ciphertext).split('').map(c => c.charCodeAt(0)))
    const iv = combined.slice(0, 12)
    const data = combined.slice(12)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    return '' // Decryption failed (wrong passphrase or corrupted)
  }
}

// For now, single-user static passphrase. 
// TODO: Replace with per-user key from auth when multi-tenant.
export const ENCRYPTION_PASSPHRASE = 'clipper-natal-2026'
