import { exportSVG } from './scene.js';

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 32_000_000;

export async function exportRaster(store, ids, { format, scale }) {
  const box = store.selectionBox(ids);
  if (!box || !Number.isFinite(scale) || scale <= 0) throw new Error('Select a layer to export.');
  const width = Math.ceil(Math.max(1, box.w) * scale), height = Math.ceil(Math.max(1, box.h) * scale);
  if (![width, height].every(Number.isFinite) || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('This export is too large. Choose a lower scale or a smaller selection.');
  }
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const image = new Image();
  // SVG image mode isolates markup and embedded assets from the editor document.
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(exportSVG(store, ids).toWellFormed());
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot render a raster export.');
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the export.')), mime, 0.92);
  });
}
