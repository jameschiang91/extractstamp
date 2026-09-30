/*
 * Pure frontend stamp extraction for GitHub Pages.
 * It never uploads selected images and has no external runtime dependency.
 */

let engineReadyPromise;

const COLOR_RANGES = {
  auto: [{ min: 160, max: 348 }],
  red: [{ min: 0, max: 24 }, { min: 336, max: 360 }],
  blue: [{ min: 180, max: 280 }],
  green: [{ min: 70, max: 180 }],
  purple: [{ min: 210, max: 348 }],
};

// Strict mode starts from confident ink pixels, then restores only the nearby
// antialiased pixels. This rejects most neutral/grey document printing.
const CLEANUP_PROFILES = {
  strict: { coreSaturation: 0.14, edgeSaturation: 0.07 },
  balanced: { coreSaturation: 0.10, edgeSaturation: 0.045 },
};

function initOpenCV(callback) {
  // Retained for compatibility with the original public API. No OpenCV load is
  // needed, so initialization cannot leave the upload handler waiting forever.
  if (!engineReadyPromise) engineReadyPromise = Promise.resolve(true);
  if (callback) engineReadyPromise.then(() => callback(true), () => callback(false));
  return engineReadyPromise;
}

function hexToRgb(hex) {
  const value = String(hex || '#0000ff').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  return [
    parseInt(normalized.slice(0, 2), 16) || 0,
    parseInt(normalized.slice(2, 4), 16) || 0,
    parseInt(normalized.slice(4, 6), 16) || 0,
  ];
}

function rgbToHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: max ? delta / max : 0, value: max };
}

function matchesColor(red, green, blue, color, minimumSaturation) {
  const hsv = rgbToHsv(red, green, blue);
  if (hsv.value < 0.09 || hsv.saturation < minimumSaturation) return false;
  const ranges = COLOR_RANGES[color] || COLOR_RANGES.auto;
  return ranges.some(({ min, max }) => hsv.hue >= min && hsv.hue <= max);
}

function dilateMask(mask, width, height) {
  const expanded = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX;
          if (nextX >= 0 && nextX < width) expanded[nextY * width + nextX] = 255;
        }
      }
    }
  }
  return expanded;
}

function buildCleanMask(source, width, height, color, cleanup) {
  const profile = CLEANUP_PROFILES[cleanup] || CLEANUP_PROFILES.strict;
  const core = new Uint8Array(width * height);
  const edge = new Uint8Array(width * height);
  for (let pixel = 0; pixel < core.length; pixel += 1) {
    const sourceIndex = pixel * 4;
    const red = source[sourceIndex];
    const green = source[sourceIndex + 1];
    const blue = source[sourceIndex + 2];
    if (matchesColor(red, green, blue, color, profile.edgeSaturation)) edge[pixel] = 255;
    if (matchesColor(red, green, blue, color, profile.coreSaturation)) core[pixel] = 255;
  }
  const expandedCore = dilateMask(core, width, height);
  const mask = new Uint8Array(core.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (edge[pixel] && expandedCore[pixel]) mask[pixel] = 255;
  }
  return mask;
}

function getMaskBounds(mask, width, height, padding) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let matched = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      matched += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (!matched) return null;
  return {
    left: Math.max(0, left - padding),
    top: Math.max(0, top - padding),
    right: Math.min(width - 1, right + padding),
    bottom: Math.min(height - 1, bottom + padding),
    matched,
  };
}

function clipMaskToEllipse(mask, width, height, bounds) {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const radiusX = Math.max(1, (bounds.right - bounds.left + 1) / 2);
  const radiusY = Math.max(1, (bounds.bottom - bounds.top + 1) / 2);
  const tolerance = 1.06;
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const horizontal = (x - centerX) / radiusX;
      const vertical = (y - centerY) / radiusY;
      if (horizontal * horizontal + vertical * vertical > tolerance) mask[y * width + x] = 0;
    }
  }
}

function createResultData(source, width, mask, bounds, outputColor) {
  const resultWidth = bounds.right - bounds.left + 1;
  const resultHeight = bounds.bottom - bounds.top + 1;
  const output = new Uint8ClampedArray(resultWidth * resultHeight * 4);
  const preserveOriginal = !outputColor || outputColor === 'original';
  const [targetRed, targetGreen, targetBlue] = preserveOriginal ? [0, 0, 0] : hexToRgb(outputColor);
  let matched = 0;
  for (let y = 0; y < resultHeight; y += 1) {
    for (let x = 0; x < resultWidth; x += 1) {
      const sourceX = bounds.left + x;
      const sourceY = bounds.top + y;
      const sourcePixel = sourceY * width + sourceX;
      if (!mask[sourcePixel]) continue;
      const sourceIndex = sourcePixel * 4;
      const targetIndex = (y * resultWidth + x) * 4;
      output[targetIndex] = preserveOriginal ? source[sourceIndex] : targetRed;
      output[targetIndex + 1] = preserveOriginal ? source[sourceIndex + 1] : targetGreen;
      output[targetIndex + 2] = preserveOriginal ? source[sourceIndex + 2] : targetBlue;
      output[targetIndex + 3] = 255;
      matched += 1;
    }
  }
  return { output, resultWidth, resultHeight, matched };
}

function extractStampWithImage(image, outputColor = 'original', color = 'auto', shape = 'ellipse', cleanup = 'strict') {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器不支持本地图像处理。');
  context.drawImage(image, 0, 0);
  const sourceImage = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data: source, width, height } = sourceImage;
  const mask = buildCleanMask(source, width, height, color, cleanup);
  let bounds = getMaskBounds(mask, width, height, shape === 'ellipse' ? 5 : 2);
  if (!bounds || bounds.matched < 20) return [];
  if (shape === 'ellipse') {
    clipMaskToEllipse(mask, width, height, bounds);
    bounds = getMaskBounds(mask, width, height, 5);
  }
  if (!bounds || bounds.matched < 20) return [];
  const result = createResultData(source, width, mask, bounds, outputColor);
  if (!result.matched) return [];
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = result.resultWidth;
  outputCanvas.height = result.resultHeight;
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw new Error('浏览器不支持本地图像处理。');
  outputContext.putImageData(new ImageData(result.output, result.resultWidth, result.resultHeight), 0, 0);
  return [outputCanvas.toDataURL('image/png')];
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片加载失败，请换一张图片。'));
    };
    image.src = objectUrl;
  });
}

async function extractStampWithFile(file, outputColor = 'original', color = 'auto', shape = 'ellipse', cleanup = 'strict') {
  if (!file) throw new Error('请选择图片文件。');
  await initOpenCV();
  const { image, objectUrl } = await loadImage(file);
  try {
    return extractStampWithImage(image, outputColor, color, shape, cleanup);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

window.initOpenCV = initOpenCV;
window.extractStampWithFile = extractStampWithFile;
window.extractStampWithImage = extractStampWithImage;
