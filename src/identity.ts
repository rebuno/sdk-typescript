import { createHash } from "node:crypto";

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const o = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (o < 0x20) out += "\\u" + o.toString(16).padStart(4, "0");
    else if (ch === "<") out += "\\u003c";
    else if (ch === ">") out += "\\u003e";
    else if (ch === "&") out += "\\u0026";
    else if (o === 0x2028) out += "\\u2028";
    else if (o === 0x2029) out += "\\u2029";
    else out += ch;
  }
  return out + '"';
}

/** Compare two strings by Unicode code point (matches Go's UTF-8 byte-order key sort). */
function codePointCompare(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0)! - bi[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

function encode(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return encodeString(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`cannot canonicalize non-finite number ${v}`);
    return JSON.stringify(v); // JSON-valid number literal; kernel preserves it
  }
  if (Array.isArray(v)) return "[" + v.map(encode).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort(codePointCompare);
    return "{" + keys.map((k) => encodeString(k) + ":" + encode((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof v}`);
}

/** Canonical JSON bytes matching the kernel's CanonicalizeJSON. */
export function canonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(encode(value));
}

/** hex(sha256(canonicalJson(args))). */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** hex(sha256( Σ `${len(bytes(field))}:` + bytes(field) )). */
export function computeStepId(
  executionId: string, kind: string, target: string, argsHashValue: string, occurrence: number,
): string {
  const fields = [executionId, kind, target, argsHashValue, String(occurrence)];
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const f of fields) {
    const fb = enc.encode(f);
    chunks.push(enc.encode(`${fb.length}:`), fb);
  }
  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}
