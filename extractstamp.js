/*
 * OpenCV-backed, browser-only stamp extraction.
 * The image remains in the browser: no file is uploaded or stored remotely.
 */

let engineReadyPromise;

const CLEANUP_PROFILES = {
  strict: { red: [115, 150], cool: [68, 62] },
  balanced: { red: [58, 58], cool: [36, 36] },
};

function initOpenCV(callback) {
  if (!engineReadyPromise) {
    engineReadyPromise = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('OpenCV 加载超时。请检查网络后刷新页面重试。'));
      }, 20000);
      if (!window.__openCvReady) {
        window.clearTimeout(timeout);
        reject(new Error('OpenCV 加载器未启动。请刷新页面后重试。'));
        return;
      }
      window.__openCvReady.then(() => { const loadedCv = window.__openCvInstance || window.cv;
        window.clearTimeout(timeout);
        if (!loadedCv || typeof loadedCv.Mat !== 'function') {
          reject(new Error('OpenCV 未能正确初始化。请刷新页面后重试。'));
          return;
        }
        window.cv = loadedCv;
        resolve(loadedCv);
      }, (error) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('OpenCV 加载失败。'));
      });
    });
  }
  if (callback) engineReadyPromise.then(() => callback(true), () => callback(false));
  return engineReadyPromise;
}

function hsvRanges(color, cleanup) {
  const profile = CLEANUP_PROFILES[cleanup] || CLEANUP_PROFILES.strict;
  const [saturation, value] = color === 'red' ? profile.red : profile.cool;
  const ranges = {
    red: [[0, 12], [168, 180]],
    blue: [[92, 140]],
    green: [[38, 90]],
    purple: [[110, 174]],
    auto: [[92, 174]],
  };
  return (ranges[color] || ranges.auto).map(([lowHue, highHue]) => ({
    low: [lowHue, saturation, value, 0],
    high: [highHue, 255, 255, 255],
  }));
}

function buildMask(cv, rgba, color, cleanup) {
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const mask = cv.Mat.zeros(rgba.rows, rgba.cols, cv.CV_8UC1);
  const temporary = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    hsvRanges(color, cleanup).forEach(({ low, high }) => {
      const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), low);
      const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), high);
      cv.inRange(hsv, lower, upper, temporary);
      cv.bitwise_or(mask, temporary, mask);
      lower.delete();
      upper.delete();
    });
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    return mask;
  } finally {
    rgb.delete();
    hsv.delete();
    temporary.delete();
    kernel.delete();
  }
}

function fullBounds(cv, mask) {
  let left = mask.cols;
  let top = mask.rows;
  let right = -1;
  let bottom = -1;
  let matches = 0;
  for (let y = 0; y < mask.rows; y += 1) {
    for (let x = 0; x < mask.cols; x += 1) {
      if (!mask.data[y * mask.cols + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      matches += 1;
    }
  }
  return matches >= 20 ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null;
}

function stampBounds(cv, mask) {
  // Text crossing an outline can split it into contours. The union preserves
  // the entire circular or oval stamp instead of retaining one half.
  return fullBounds(cv, mask);
}

function padBounds(bounds, width, height, padding) {
  const left = Math.max(0, bounds.x - padding);
  const top = Math.max(0, bounds.y - padding);
  const right = Math.min(width, bounds.x + bounds.width + padding);
  const bottom = Math.min(height, bounds.y + bounds.height + padding);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function cropToEllipse(cv, mask, bounds) {
  const ellipseMask = cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1);
  try {
    const center = new cv.Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const axes = new cv.Size(Math.max(1, bounds.width / 2), Math.max(1, bounds.height / 2));
    cv.ellipse(ellipseMask, center, axes, 0, 0, 360, new cv.Scalar(255), -1);
    cv.bitwise_and(mask, ellipseMask, mask);
  } finally {
    ellipseMask.delete();
  }
}

function paintResult(cv, rgba, mask, bounds, outputColor) {
  const result = cv.Mat.zeros(bounds.height, bounds.width, cv.CV_8UC4);
  const sourceRoi = rgba.roi(bounds);
  const maskRoi = mask.roi(bounds);
  try {
    if (!outputColor || outputColor === 'original') {
      sourceRoi.copyTo(result, maskRoi);
    } else {
      const value = String(outputColor).replace('#', '');
      const rgb = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
      const red = Number.parseInt(rgb.slice(0, 2), 16) || 0;
      const green = Number.parseInt(rgb.slice(2, 4), 16) || 0;
      const blue = Number.parseInt(rgb.slice(4, 6), 16) || 0;
      result.setTo(new cv.Scalar(red, green, blue, 255), maskRoi);
    }
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, result);
    return canvas.toDataURL('image/png');
  } finally {
    sourceRoi.delete();
    maskRoi.delete();
    result.delete();
  }
}

function extractStampWithImage(image, outputColor = 'original', color = 'auto', shape = 'ellipse', cleanup = 'strict') {
  const cv = window.cv;
  if (!cv || typeof cv.imread !== 'function') throw new Error('OpenCV 尚未就绪。');
  const rgba = cv.imread(image);
  let mask;
  try {
    mask = buildMask(cv, rgba, color, cleanup);
    const detected = stampBounds(cv, mask);
    if (!detected) return [];
    const bounds = padBounds(detected, rgba.cols, rgba.rows, shape === 'ellipse' ? 6 : 2);
    if (shape === 'ellipse') cropToEllipse(cv, mask, bounds);
    return [paintResult(cv, rgba, mask, bounds, outputColor)];
  } finally {
    if (mask) mask.delete();
    rgba.delete();
  }
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
