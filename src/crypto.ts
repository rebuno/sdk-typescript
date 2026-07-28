async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** `sha256=<hex(HMAC-SHA256(secret, body))>`. */
export async function signBody(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, body as BufferSource);
  return `sha256=${toHex(sig)}`;
}

/** Constant-time string compare (equal-length only). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string,
): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const expected = await signBody(secret, body);
  return timingSafeEqual(header, expected);
}
