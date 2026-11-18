/** Rasterize the exported scene at a requested scale using the browser renderer. */
export async function rasterize(svg, type, scale = 1) {
  // A data URL keeps the self-contained SVG origin clean even with its embedded HTML text.
  const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const image = new Image();
  image.src = source;
  await image.decode();
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) {
    throw new Error('Choose a smaller export size.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the image.');
  if (type === 'image/jpeg') {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!blob) throw new Error('Could not export the image.');
  return blob;
}
