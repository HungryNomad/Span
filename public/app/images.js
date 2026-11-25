// @ts-check
/**
 * Shrinks pasted or dropped pictures in the browser before upload, so a
 * 12 MB phone photo goes up as a ~200 KB WebP plus a small thumbnail.
 *
 * @module
 */

/** Longest side of the stored picture, in px. */
export const FULL_PX = 1200;
/** Longest side of the thumbnail, in px. */
export const THUMB_PX = 320;
/** Largest source file accepted before resizing. */
export const MAX_SOURCE = 25 * 1024 * 1024;

/**
 * Draws an image scaled so its longest side is at most `px`, and encodes it
 * as WebP (JPEG where the browser can't encode WebP, e.g. Safari).
 * @param {ImageBitmap} img
 * @param {number} px
 * @param {number} quality 0..1.
 * @returns {Promise<Blob>}
 */
async function encode(img, px, quality) {
  const k = Math.min(1, px / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  g.fillStyle = '#fff'; // JPEG has no alpha; keep transparent PNGs readable.
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  /** @param {string} type @returns {Promise<Blob | null>} */
  const blob = (type) => new Promise((ok) => c.toBlob(ok, type, quality));
  const webp = await blob('image/webp');
  if (webp?.type === 'image/webp') return webp;
  const jpeg = await blob('image/jpeg');
  if (!jpeg) throw new Error('this browser could not encode the picture');
  return jpeg;
}

/**
 * Turns a picture file into an upload-ready pair.
 * @param {Blob} file Any image the browser can decode (JPEG, PNG, WebP, HEIC on Safari…).
 * @returns {Promise<{full: Blob, thumb: Blob}>}
 * @throws {Error} If it isn't a picture, is too big, or can't be decoded.
 */
export async function prepare(file) {
  if (file.type && !file.type.startsWith('image/')) throw new Error('that file isn\'t a picture');
  if (file.size > MAX_SOURCE) throw new Error('that picture is over 25 MB');
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('this browser can\'t read that picture');
  });
  try {
    return { full: await encode(img, FULL_PX, 0.82), thumb: await encode(img, THUMB_PX, 0.72) };
  } finally {
    img.close();
  }
}
