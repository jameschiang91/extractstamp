/* Pure frontend stamp extraction. It uses Canvas so GitHub Pages does not need a heavy OpenCV runtime. */

let engineReadyPromise;

const COLOR_RANGES = {
  auto: { ranges: [{ min: 160, max: 345 }], minSaturation: 0.04, maxValue: 0.86 },
  red: { ranges: [{ min: 0, max: 22 }, { min: 338, max: 360 }], minSaturation: 0.12, maxValue: 1 },
  blue: { ranges: [{ min: 180, max: 275 }], minSaturation: 0.06, maxValue: 1 },
  green: { ranges: [{ min: 70, max: 180 }], minSaturation: 0.08, maxValue: 1 },
  purple: { ranges: [{ min: 210, max: 345 }], minSaturation: 0.04, maxValue: 0.90 },
};

function initOpenCV(callback) {
  if (!engineReadyPromise) {
    engineReadyPromise = Promise.resolve().then(() => {
      callback?.(true);
      return true;
    });
  }
  return engineReadyPromise;
}

function hexToRgb(hex) {
  const value = String(hex || '#0000ff').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [
    parseInt(normalized.slice(0, 2), 16) || 0,
    parseInt(normalized.slice(2, 4), 16) || 0,
    parseInt(normalized.slice(4, 6), 16) || 0,
  ];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
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
  return [hue, max ? delta / max : 0, max];
}

function isTargetPixel(r, g, b, color) {
  const [hue, saturation, value] = rgbToHsv(r, g, b);
  const config = COLOR_RANGES[color] || COLOR_RANGES.auto;
  if (saturation < config.minSaturation || value < 0.10 || value > config.maxValue) return false;
  return config.ranges.some(({ min, max }) => hue >= min && hue <= max);
}

function createResultData(source, width, height, bounds, targetColor, outputColor) {
  const output = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  const preserveOriginal = !outputColor || outputColor === 'original';
  const [red, green, blue] = preserveOriginal ? [0, 0, 0] : hexToRgb(outputColor);
  let matched = 0;
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const sourceIndex = ((bounds.top + y) * width + bounds.left + x) * 4;
      const targetIndex = (y * bounds.width + x) * 4;
      if (!isTargetPixel(source[sourceIndex], source[sourceIndex + 1], source[sourceIndex + 2], targetColor)) continue;
      output[targetIndex] = preserveOriginal ? source[sourceIndex] : red;
      output[targetIndex + 1] = preserveOriginal ? source[sourceIndex + 1] : green;
      output[targetIndex + 2] = preserveOriginal ? source[sourceIndex + 2] : blue;
      output[targetIndex + 3] = 255;
      matched += 1;
    }
  }
  return { output, matched };
}

function extractStampWithImage(img, setColor = 'original', color = 'auto', shape = 'ellipse') {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器不支持 Canvas 图像处理。');
  context.drawImage(img, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (!isTargetPixel(data[index], data[index + 1], data[index + 2], color)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return [];
  const padding = shape === 'ellipse' ? Math.max(2, Math.round(Math.max(right - left, bottom - top) * 0.04)) : 0;
  const bounds = {
    left: Math.max(0, left - padding),
    top: Math.max(0, top - padding),
    width: Math.min(width, right + padding + 1) - Math.max(0, left - padding),
    height: Math.min(height, bottom + padding + 1) - Math.max(0, top - padding),
  };
  const result = createResultData(data, width, height, bounds, color, setColor);
  if (!result.matched) return [];

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = bounds.width;
  outputCanvas.height = bounds.height;
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw new Error('浏览器不支持 Canvas 图像处理。');
  outputContext.putImageData(new ImageData(result.output, bounds.width, bounds.height), 0, 0);
  return [outputCanvas.toDataURL('image/png')];
}

function extractStampWithFile(file, setColor = 'original', color = 'auto', shape = 'ellipse') {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('请选择图片文件。'));
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      try {
        resolve(extractStampWithImage(img, setColor, color, shape));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片加载失败，请换一张图片。'));
    };
    img.src = objectUrl;
  });
}

window.initOpenCV = initOpenCV;
window.extractStampWithFile = extractStampWithFile;
