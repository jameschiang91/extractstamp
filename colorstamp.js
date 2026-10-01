/* Independent color/ellipse mode. The original red-circle algorithm is unchanged. */
(function () {
  'use strict';
  function parseColor(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('颜色请填写为 #RRGGBB，例如 #5C505B。');
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  function colorHsv(rgb) {
    const [r, g, b] = rgb.map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta) h = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
  }
  function findEllipse(mask) {
    const closed = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
    const k = Math.max(3, Math.round(Math.min(mask.cols, mask.rows) * 0.005) | 1);
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
    let best = null;
    try {
      // Closing is only for locating the border; never use it as output ink.
      cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
      cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        try {
          if (contour.rows < 30) continue;
          const ellipse = cv.fitEllipse(contour);
          const a = ellipse.size.width / 2, b = ellipse.size.height / 2;
          if (!Number.isFinite(a + b) || Math.min(a, b) < 12 || Math.min(a, b) / Math.max(a, b) < 0.2) continue;
          const area = Math.PI * a * b;
          if (area < mask.cols * mask.rows * 0.01 || area > mask.cols * mask.rows * 1.05) continue;
          const angle = ellipse.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
          let good = 0;
          const sectors = new Set();
          for (let j = 0; j < contour.rows; j++) {
            const dx = contour.data32S[j * 2] - ellipse.center.x, dy = contour.data32S[j * 2 + 1] - ellipse.center.y;
            const u = (dx * cos + dy * sin) / a, v = (-dx * sin + dy * cos) / b;
            if (Math.abs(Math.hypot(u, v) - 1) < 0.16) {
              good++;
              sectors.add(Math.floor((Math.atan2(v, u) + Math.PI) / (2 * Math.PI) * 24) % 24);
            }
          }
          const quality = good / contour.rows;
          if (quality < 0.65 || sectors.size < 20) continue;
          const score = area * quality;
          if (!best || score > best.score) best = { ellipse, score, quality, rect: cv.boundingRect(contour) };
        } finally { contour.delete(); }
      }
      return best;
    } finally { closed.delete(); contours.delete(); hierarchy.delete(); kernel.delete(); }
  }
  function removeSpecks(mask, minArea) {
    if (minArea <= 1) return;
    const labels = new cv.Mat(), stats = new cv.Mat(), centers = new cv.Mat();
    try {
      cv.connectedComponentsWithStats(mask, labels, stats, centers, 8, cv.CV_32S);
      for (let i = 0; i < mask.data.length; i++) {
        const label = labels.data32S[i];
        if (label === 0 || stats.data32S[label * 5 + cv.CC_STAT_AREA] < minArea) mask.data[i] = 0;
      }
    } finally { labels.delete(); stats.delete(); centers.delete(); }
  }
  function extractColorEllipse(img, options = {}) {
    const selected = colorHsv(parseColor(options.sourceColor || '#5c505b'));
    if (selected.s < 0.025) throw new Error('所选颜色太接近灰色，无法可靠区分黑字。请在有颜色的印章边框上取色。');
    const tolerance = Number(options.tolerance ?? 42);
    const minSaturation = Number(options.minSaturation ?? 5) / 100;
    if (!(tolerance >= 2 && tolerance <= 60) || !(minSaturation >= 0.01 && minSaturation <= 0.5)) throw new Error('颜色容差或去灰阈值超出范围。');
    const output = options.outputMode === 'custom' ? parseColor(options.outputColor || '#5c505b') : null;
    const source = cv.imread(img), rgb = new cv.Mat(), hsv = new cv.Mat();
    const mask = cv.Mat.zeros(source.rows, source.cols, cv.CV_8UC1);
    try {
      cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      for (let i = 0; i < mask.data.length; i++) {
        const hue = hsv.data[i * 3] * 2;
        const delta = Math.abs(hue - selected.h);
        if (Math.min(delta, 360 - delta) <= tolerance && hsv.data[i * 3 + 1] >= minSaturation * 255 && hsv.data[i * 3 + 2] >= 10 && source.data[i * 4 + 3] > 0) mask.data[i] = 255;
      }
      removeSpecks(mask, Number(options.minArea ?? 3));
      const detected = findEllipse(mask);
      if (!detected) return { images: [], message: '未找到完整的椭圆边框。请在边框上取色、适当增加颜色容差，或先裁剪到印章附近；不会自动输出整页杂色。' };
      const { ellipse, rect } = detected;
      const padding = Math.ceil(Math.max(rect.width, rect.height) * 0.015);
      const x = Math.max(0, rect.x - padding), y = Math.max(0, rect.y - padding);
      const width = Math.min(source.cols - x, rect.width + padding * 2);
      const height = Math.min(source.rows - y, rect.height + padding * 2);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(width, height);
      const angle = ellipse.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
      const a = ellipse.size.width / 2, b = ellipse.size.height / 2;
      let count = 0;
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const srcIndex = (row + y) * source.cols + col + x;
        if (!mask.data[srcIndex]) continue;
        const dx = col + x - ellipse.center.x, dy = row + y - ellipse.center.y;
        // Broken/double borders can bias fitEllipse toward the inner ring.
        // Allow a margin for the outer stroke; still copy only measured ink.
        if (Math.hypot((dx * cos + dy * sin) / a, (-dx * sin + dy * cos) / b) > 1.12) continue;
        const dstIndex = (row * width + col) * 4;
        for (let channel = 0; channel < 3; channel++) pixels.data[dstIndex + channel] = output ? output[channel] : source.data[srcIndex * 4 + channel];
        pixels.data[dstIndex + 3] = source.data[srcIndex * 4 + 3]; count++;
      }
      context.putImageData(pixels, 0, 0);
      return { images: [canvas.toDataURL('image/png')], message: '已生成实验结果，请人工检查：已知会残留背景文字，尚未达到可用标准。马赛克及完全遮挡处不会被还原。', bounds: { x, y, width, height }, inkPixels: count, quality: detected.quality, ellipse };
    } finally { source.delete(); rgb.delete(); hsv.delete(); mask.delete(); }
  }
  window.stampColor = { parseColor, colorHsv, extractColorEllipse };
})();
