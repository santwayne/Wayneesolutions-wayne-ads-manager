import sharp from 'sharp';

/** Image QA (spec Screen 5 auto-check): dimensions + blur estimate. */
export async function analyzeImage(buffer) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  // Blur: variance of a Laplacian on a downscaled grayscale copy. Low = blurry.
  const { data, info } = await img.clone().greyscale().resize(256, 256, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width; const h = info.height;
  let sum = 0; let sumSq = 0; let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { width: meta.width, height: meta.height, format: meta.format, blurScore: Math.round(variance) };
}
