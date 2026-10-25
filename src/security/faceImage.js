// Face image intake: accept ONLY a data:image/png;base64 payload, verify PNG magic bytes,
// reject animated PNG, decode with sharp under a pixel limit, and RE-ENCODE to a stripped
// 256x256 PNG. Client MIME/filename are never trusted. Returns a Buffer or throws.
import sharp from 'sharp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECODED_BYTES = 512 * 1024; // 512 KB decoded cap

// Decode the data URL → raw bytes, enforcing the png data-url prefix and size cap.
export function decodeFaceDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('face_not_string');
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('face_bad_dataurl');
  let buf;
  try { buf = Buffer.from(m[1], 'base64'); } catch { throw new Error('face_bad_base64'); }
  if (!buf.length) throw new Error('face_empty');
  if (buf.length > MAX_DECODED_BYTES) throw new Error('face_too_large');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('face_not_png');
  // Reject animated PNG (APNG) — presence of an acTL chunk before IDAT.
  const idat = buf.indexOf(Buffer.from('IDAT'));
  const actl = buf.indexOf(Buffer.from('acTL'));
  if (actl !== -1 && (idat === -1 || actl < idat)) throw new Error('face_animated');
  return buf;
}

// Validate + re-encode. Rejects SVG/GIF/polyglot because sharp is told to expect a raster
// and the magic-byte check above already gates on PNG. Output: metadata-stripped 256x256 PNG.
export async function processFace(dataUrl) {
  const buf = decodeFaceDataUrl(dataUrl);
  const img = sharp(buf, { limitInputPixels: 1024 * 1024, animated: false });
  const meta = await img.metadata();
  if (meta.format !== 'png') throw new Error('face_not_png');
  if (meta.pages && meta.pages > 1) throw new Error('face_animated');
  if ((meta.width || 0) > 1024 || (meta.height || 0) > 1024) throw new Error('face_dimensions');
  return img
    .resize(256, 256, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toBuffer(); // sharp output drops source metadata by default
}
