/* Browser-only stamp extraction with OpenCV.js. */

let cvReady = false;
let cvReadyPromise;

const COLOR_RANGES = {
  red: { low: [0, 45, 35], high: [10, 255, 255], low2: [170, 45, 35], high2: [180, 255, 255] },
  blue: { low: [90, 35, 25], high: [135, 255, 255] },
  green: { low: [35, 35, 25], high: [90, 255, 255] },
  purple: { low: [130, 25, 25], high: [169, 255, 255] },
};

function initOpenCV(callback) {
  if (cvReady) return Promise.resolve(true);
  if (cvReadyPromise) return cvReadyPromise.then(() => callback?.(true));

  cvReadyPromise = new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const runtimeReady = typeof cv !== 'undefined' &&
        (typeof cv.Mat === 'function' || cv instanceof Promise);
      if (runtimeReady) {
        Promise.resolve(cv).then((runtime) => {
          window.cv = runtime;
          cvReady = true;
          callback?.(true);
          resolve(true);
        }).catch(reject);
        return;
      }
      if (Date.now() - started > 30000) {
        reject(new Error('OpenCV.js 加载超时，请刷新页面后重试。'));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
  return cvReadyPromise;
}

function hexToRgba(hex) {
  const value = String(hex || '#0000ff').replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [parseInt(normalized.slice(0, 2), 16), parseInt(normalized.slice(2, 4), 16), parseInt(normalized.slice(4, 6), 16), 255];
}

function rangeMat(rows, cols, type, values) {
  return new cv.Mat(rows, cols, type, [...values, 0]);
}

function createColorMask(hsv, color) {
  const ranges = COLOR_RANGES[color] || COLOR_RANGES.blue;
  const mask = new cv.Mat();
  const low = rangeMat(hsv.rows, hsv.cols, hsv.type(), ranges.low);
  const high = rangeMat(hsv.rows, hsv.cols, hsv.type(), ranges.high);
  cv.inRange(hsv, low, high, mask);
  low.delete();
  high.delete();

  if (color === 'red') {
    const low2 = rangeMat(hsv.rows, hsv.cols, hsv.type(), ranges.low2);
    const high2 = rangeMat(hsv.rows, hsv.cols, hsv.type(), ranges.high2);
    const mask2 = new cv.Mat();
    cv.inRange(hsv, low2, high2, mask2);
    cv.bitwise_or(mask, mask2, mask);
    low2.delete(); high2.delete(); mask2.delete();
  }
  return mask;
}

function matToDataUrl(mat) {
  const canvas = document.createElement('canvas');
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  cv.imshow(canvas, mat);
  return canvas.toDataURL('image/png');
}

function extractStampWithColorToImage(img, setColor = '#0000ff', color = 'blue') {
  if (!cvReady) throw new Error('OpenCV.js 尚未准备好。');
  const src = cv.imread(img);
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const mask = new cv.Mat();
  const result = new cv.Mat(src.rows, src.cols, cv.CV_8UC4, [0, 0, 0, 0]);
  const colorMat = new cv.Mat(src.rows, src.cols, cv.CV_8UC4, [...hexToRgba(setColor).slice(0, 3), 255]);
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const generated = createColorMask(hsv, color);
    generated.copyTo(mask);
    generated.delete();
    colorMat.copyTo(result, mask);
    return matToDataUrl(result);
  } finally {
    src.delete(); rgb.delete(); hsv.delete(); mask.delete(); result.delete(); colorMat.delete();
  }
}

function extractStampWithImage(img, setColor = '#0000ff', color = 'blue', shape = 'ellipse') {
  const dataUrl = extractStampWithColorToImage(img, setColor, color);
  return [dataUrl];
}

function extractStampWithFile(file, setColor = '#0000ff', color = 'blue', shape = 'ellipse') {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('请选择图片文件。')); return; }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      try { resolve(extractStampWithImage(img, setColor, color, shape)); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      finally { URL.revokeObjectURL(objectUrl); }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('图片加载失败，请换一张图片。')); };
    img.src = objectUrl;
  });
}

window.initOpenCV = initOpenCV;
window.extractStampWithFile = extractStampWithFile;
