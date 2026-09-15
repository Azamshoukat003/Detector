/**
 * Asset integrity: does a file's extension match what its bytes actually are?
 *
 * The rule set is text-only, and binary files are skipped entirely — so a
 * payload dropped in as `fa-solid-400.woff2` alongside real fonts is invisible
 * to every other check in this tool. Nobody reviews a font file in a diff.
 *
 * This does not try to validate a font. It only answers one question: does the
 * file begin with the signature its extension promises? A JavaScript payload
 * renamed to .woff2 fails that immediately.
 */

export interface MagicSpec {
  /** Human name for the format, used in the finding message. */
  label: string;
  /** Byte sequences any one of which is a valid header. */
  signatures: number[][];
  /** Offset the signature starts at (EOT keeps its magic mid-header). */
  offset?: number;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export const ASSET_MAGIC: Record<string, MagicSpec> = {
  ".woff2": { label: "WOFF2 font", signatures: [ascii("wOF2")] },
  ".woff": { label: "WOFF font", signatures: [ascii("wOFF")] },
  ".otf": { label: "OpenType font", signatures: [ascii("OTTO")] },
  ".ttf": {
    label: "TrueType font",
    signatures: [[0x00, 0x01, 0x00, 0x00], ascii("true"), ascii("ttcf")],
  },
  // EOT has no leading magic; its marker sits at offset 34.
  ".eot": { label: "EOT font", signatures: [[0x4c, 0x50]], offset: 34 },
  ".png": { label: "PNG image", signatures: [[0x89, 0x50, 0x4e, 0x47]] },
  ".jpg": { label: "JPEG image", signatures: [[0xff, 0xd8, 0xff]] },
  ".jpeg": { label: "JPEG image", signatures: [[0xff, 0xd8, 0xff]] },
  ".gif": { label: "GIF image", signatures: [ascii("GIF87a"), ascii("GIF89a")] },
  ".ico": { label: "icon", signatures: [[0x00, 0x00, 0x01, 0x00]] },
  ".webp": { label: "WebP image", signatures: [ascii("RIFF")] },
  ".pdf": { label: "PDF", signatures: [ascii("%PDF-")] },
  ".zip": { label: "ZIP archive", signatures: [[0x50, 0x4b, 0x03, 0x04]] },
};

export const ASSET_EXTENSIONS = Object.keys(ASSET_MAGIC);

/** Extensions whose contents are text and can carry script (SVG). */
export const SCRIPTABLE_ASSET_EXTENSIONS = [".svg"];

export function assetExtension(path: string): string | null {
  const lower = path.toLowerCase();
  const ext = ASSET_EXTENSIONS.find((e) => lower.endsWith(e));
  return ext ?? null;
}

function startsWith(bytes: Buffer, sig: number[], offset: number): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Short hex+ascii preview of the header, for the finding excerpt. */
export function headerPreview(bytes: Buffer, n = 12): string {
  const slice = bytes.subarray(0, n);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const text = [...slice]
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
    .join("");
  return `${hex}   "${text}"`;
}

/**
 * Guess what the bytes really are when they are not what the extension claims.
 * Only needs to be good enough to tell a human where to look.
 */
export function describeActual(bytes: Buffer): string {
  const head = bytes.subarray(0, 512).toString("utf8");
  if (/^\s*<\?xml|^\s*<svg/i.test(head)) return "XML/SVG text";
  if (/^\s*<!DOCTYPE html|^\s*<html/i.test(head)) return "HTML";
  if (/^\s*[{[]/.test(head) && /["':]/.test(head)) return "JSON or JS object literal";
  if (/\b(function|const|let|var|require|import|eval|=>)\b/.test(head)) {
    return "JavaScript source";
  }
  if (/^#!/.test(head)) return "a script with a shebang";
  if (/^MZ/.test(head)) return "a Windows executable (PE)";
  if (/^\x7fELF/.test(head)) return "a Linux executable (ELF)";

  // Mostly-printable with no known signature is still suspicious for a binary
  // asset: real fonts and images are dense binary.
  const sample = bytes.subarray(0, 256);
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e)) printable++;
  }
  if (sample.length > 0 && printable / sample.length > 0.9) return "plain text";
  return "unrecognised binary";
}

export interface MagicVerdict {
  ok: boolean;
  label: string;
  actual?: string;
  preview: string;
}

/** Check one asset's bytes against the signature its extension promises. */
export function verifyAsset(path: string, bytes: Buffer): MagicVerdict | null {
  const ext = assetExtension(path);
  if (ext === null) return null;
  const spec = ASSET_MAGIC[ext];
  const offset = spec.offset ?? 0;

  const ok = spec.signatures.some((sig) => startsWith(bytes, sig, offset));
  return ok
    ? { ok: true, label: spec.label, preview: headerPreview(bytes) }
    : {
        ok: false,
        label: spec.label,
        actual: describeActual(bytes),
        preview: headerPreview(bytes),
      };
}

/** Script embedded in an SVG — SVG is XML and executes in a browser context. */
export const SVG_SCRIPT_PATTERN =
  /<script[\s>]|javascript:|\son(?:load|error|click|mouseover)\s*=/i;
