'use strict';
const input = document.getElementById('imageInput');
const status = document.getElementById('status');
const preview = document.getElementById('sourceCanvas');
let currentImage = null, busy = false, picking = false, lastFile = null;
const mode = document.getElementById('mode');
const processButton = document.getElementById('processButton');
function setBusy(value) {
  busy = value;
  document.getElementById('controls').disabled = value;
  input.disabled = value;
  processButton.disabled = value || !currentImage;
  document.getElementById('loading').style.display = value ? 'block' : 'none';
}
function updateMode() {
  document.getElementById('colorOptions').hidden = mode.value === 'legacy';
  document.getElementById('modeHelp').textContent = mode.value === 'legacy' ? '保持原版红色筛选、圆形检测与红色输出不变。' : '提取最大的彩色椭圆章。先从边框取色；保留原色指保留照片中的实际像素颜色，不是还原拍摄前的颜色。';
  if (currentImage) status.textContent = '参数已变更，请点击“重新提取”。';
  picking = false; preview.style.cursor = 'default';
}
function syncColor(from, to) {
  try { stampColor.parseColor(from.value); to.value = from.value; from.setCustomValidity(''); }
  catch (_) { from.setCustomValidity('请使用 #RRGGBB 格式'); }
}
for (const prefix of ['source', 'output']) {
  const picker = document.getElementById(prefix + 'Color');
  const hex = document.getElementById(prefix + 'Hex');
  picker.addEventListener('input', () => { hex.value = picker.value; hex.setCustomValidity(''); });
  hex.addEventListener('input', () => syncColor(hex, picker));
}
mode.addEventListener('change', updateMode);
updateMode();
document.getElementById('pickButton').onclick = () => {
  if (!currentImage) { status.textContent = '请先选择图片，再点击章的边框取色。'; return; }
  picking = !picking; preview.style.cursor = picking ? 'crosshair' : 'default';
  status.textContent = picking ? '请点击下方原图中清晰的印章边框，避开黑字和马赛克。' : '已取消取色。';
};
preview.addEventListener('click', event => {
  if (!picking || busy || !currentImage) return;
  const rect = preview.getBoundingClientRect();
  const x = Math.min(preview.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * preview.width / rect.width)));
  const y = Math.min(preview.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * preview.height / rect.height)));
  const data = preview.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), Math.min(5, preview.width - Math.max(0, x - 2)), Math.min(5, preview.height - Math.max(0, y - 2))).data;
  const colors = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0) colors.push([data[i], data[i + 1], data[i + 2]]);
  colors.sort((a, b) => stampColor.colorHsv(b).s - stampColor.colorHsv(a).s);
  const selected = colors.slice(0, Math.max(1, Math.ceil(colors.length / 2)));
  if (!selected.length) return;
  const rgb = [0, 1, 2].map(c => selected.map(p => p[c]).sort((a,b) => a-b)[Math.floor(selected.length / 2)]);
  const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  document.getElementById('sourceColor').value = hex;
  document.getElementById('sourceHex').value = hex;
  document.getElementById('sourceHex').setCustomValidity('');
  picking = false; preview.style.cursor = 'default';
  status.textContent = '已取色 ' + hex.toUpperCase() + '，请点击“重新提取”。';
});
function displayImages(list) {
  const container = document.getElementById('imageContainer'); container.replaceChildren();
  list.forEach((src, i) => {
    const figure = document.createElement('figure');
    const image = new Image(); image.src = src; image.alt = '提取的印章 ' + (i + 1);
    const link = document.createElement('a'); link.href = src; link.download = 'stamp-' + (i + 1) + '.png'; link.textContent = '下载透明 PNG';
    figure.append(image, link); container.append(figure);
  });
}
async function selectImage() {
  const file = input.files[0];
  if (!file || busy) return;
  lastFile = file; currentImage = null;
  setBusy(true); displayImages([]);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片解码失败，请选择有效图片。')); image.src = url; });
    if (image.naturalWidth * image.naturalHeight > 25000000) throw new Error('图片超过 2500 万像素，请先裁剪到印章附近再试。');
    currentImage = image;
    preview.width = image.naturalWidth; preview.height = image.naturalHeight;
    preview.getContext('2d').drawImage(image, 0, 0);
    preview.hidden = false;
    document.getElementById('fileName').textContent = file.name + ' · ' + preview.width + ' × ' + preview.height;
    // Legacy behavior stays automatic. New mode allows sampling before processing.
    if (mode.value === 'legacy') { setBusy(false); await processImage(); }
    else status.textContent = '图片已加载。请取色或填写颜色，然后点击“重新提取”。';
  } catch (error) { status.textContent = '加载失败：' + error.message; preview.hidden = true; }
  finally { URL.revokeObjectURL(url); input.value = ''; setBusy(false); }
}
async function processImage() {
  if (!currentImage || busy) return;
  setBusy(true); displayImages([]); status.textContent = '正在处理图片…';
  try {
    await initOpenCV();
    await new Promise(resolve => setTimeout(resolve, 30));
    let list;
    if (mode.value === 'legacy') {
      list = await extractStampWithFile(lastFile, '#ff0000');
      status.textContent = list.length ? '提取完成。' : '未检测到圆形红色印章。';
    } else {
      const result = stampColor.extractColorEllipse(preview, {
        sourceColor: document.getElementById('sourceHex').value.trim(),
        tolerance: document.getElementById('tolerance').value,
        minSaturation: document.getElementById('minSaturation').value,
        outputMode: document.getElementById('outputMode').value,
        outputColor: document.getElementById('outputHex').value.trim(),
      });
      list = result.images; status.textContent = result.message;
    }
    displayImages(list);
  } catch (error) { status.textContent = '处理失败：' + (error.message || String(error)); }
  finally { setBusy(false); }
}
processButton.onclick = processImage;
if (typeof initOpenCV !== 'function' || !window.stampColor) status.textContent = '处理脚本加载失败，请确保解压完整文件夹。';
else initOpenCV().then(() => { input.disabled = false; status.textContent = '已就绪，请选择模式并加载图片。'; }).catch(error => { status.textContent = error.message; });
