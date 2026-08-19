'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    imageInfo: $('imageInfo'),
    manufacturer: $('manufacturer'),
    palette: $('palette'),
    alphaRange: $('alphaRange'),
    alphaOut: $('alphaOut'),
    removeWhite: $('removeWhite'),
    whiteRange: $('whiteRange'),
    whiteOut: $('whiteOut'),
    scaleRadios: document.querySelectorAll('input[name="scale"]'),
    maxDimRow: $('maxDimRow'),
    maxDim: $('maxDim'),
    gridLines: $('gridLines'),
    showCodes: $('showCodes'),
    btnPng: $('btnPng'),
    btnCsv: $('btnCsv'),
    btnJson: $('btnJson'),
    emptyState: $('emptyState'),
    result: $('result'),
    stats: $('stats'),
    legendWrap: $('legendWrap'),
    legendTotal: $('legendTotal'),
    patternCanvas: $('patternCanvas'),
    canvasWrap: $('canvasWrap'),
    editToggle: $('editToggle'),
    editTools: $('editTools'),
    toolBtns: document.querySelectorAll('.tool-btn'),
    btnUndo: $('btnUndo'),
    btnRedo: $('btnRedo'),
    toast: $('toast'),
    errorBanner: $('errorBanner'),
  };

  /* ---------------- 状态 ---------------- */

  const state = {
    colorsData: null,      // { 厂家: [{ 'color-name', color }] }
    title: null,           // 当前厂家
    palette: null,         // [{ name, hex, r, g, b }]
    image: null,           // { canvas, w, h, hasAlpha, name, type }
    rgbCells: null,        // Int32Array: 打包 RGB 或 -1(空位)
    patternIdx: null,      // Int32Array: 色板下标或 -1
    counts: null,          // Int32Array: 各色使用次数
    patternW: 0,
    patternH: 0,
    nonEmpty: 0,
    bounds: null,          // { cw, ch } 内容包围盒（空白不计）
    savedManufacturer: null,
    editing: false,
    tool: 'brush',         // 'brush' | 'eraser' | 'bucket'
    currentColor: 0,       // 色板下标
    painting: false,
    strokeSnapshot: null,
    undoStack: [],
    redoStack: [],
  };

  /* ---------------- 工具 ---------------- */

  let toastTimer = null;
  function toast(msg, type = 'ok') {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    els.toast.classList.toggle('error', type === 'error');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
  }

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function formatType(mime) {
    const map = {
      'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP',
      'image/gif': 'GIF', 'image/bmp': 'BMP', 'image/avif': 'AVIF',
    };
    return map[mime] || '图片';
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  // 画布文字字体（含中文回退）
  const FONT = '"PingFang SC","Microsoft YaHei",system-ui,sans-serif';

  /* ---------------- 设置持久化（localStorage） ---------------- */

  const STORE_KEY = 'beansGenerator:settings';

  function saveSettings() {
    try {
      const s = {
        manufacturer: els.manufacturer.value,
        alpha: els.alphaRange.value,
        white: els.whiteRange.value,
        removeWhite: els.removeWhite.checked,
        scale: document.querySelector('input[name="scale"]:checked').value,
        maxDim: els.maxDim.value,
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch (e) { /* localStorage 不可用时静默 */ }
  }

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!s) return;
      if (s.alpha) { els.alphaRange.value = s.alpha; els.alphaOut.textContent = s.alpha; }
      if (s.white) { els.whiteRange.value = s.white; els.whiteOut.textContent = s.white; }
      if (typeof s.removeWhite === 'boolean') els.removeWhite.checked = s.removeWhite;
      if (s.scale === 'max') {
        document.querySelector('input[name="scale"][value="max"]').checked = true;
        els.maxDimRow.classList.remove('hidden');
      }
      if (s.maxDim) els.maxDim.value = s.maxDim;
      if (s.manufacturer) state.savedManufacturer = s.manufacturer;
    } catch (e) { /* 忽略损坏的存储 */ }
  }

  /* ---------------- 颜色数据加载 ---------------- */

  async function loadColors() {
    try {
      const res = await fetch('get-colors.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.colorsData = await res.json();
      fillManufacturerSelect();
    } catch (err) {
      showError('无法加载 get-colors.json（' + err.message + '）。请通过本地 HTTP 服务访问本页面，例如 <span class="mono">python -m http.server</span> 或 <span class="mono">npx serve</span>。');
    }
  }

  function fillManufacturerSelect() {
    const data = state.colorsData;
    els.manufacturer.innerHTML = '';
    for (const title of Object.keys(data)) {
      const opt = document.createElement('option');
      opt.value = title;
      opt.textContent = title + '（' + data[title].length + ' 色）';
      els.manufacturer.appendChild(opt);
    }
    if (state.savedManufacturer && data[state.savedManufacturer]) {
      els.manufacturer.value = state.savedManufacturer;
    }
    els.manufacturer.disabled = false;
    setPalette(els.manufacturer.value);
    process();
  }

  function showError(msg) {
    els.errorBanner.innerHTML =
      '<div>' + msg + '</div>' +
      '<button class="btn sm" type="button" id="retryBtn">重试加载</button>';
    els.errorBanner.classList.remove('hidden');
    $('retryBtn').addEventListener('click', () => {
      els.errorBanner.classList.add('hidden');
      loadColors();
    });
  }

  /* ---------------- 厂家色板 ---------------- */

  function setPalette(title) {
    state.title = title;
    const list = state.colorsData[title];
    state.palette = list.map((c) => {
      const v = parseInt(c.color.slice(1), 16);
      return { name: c['color-name'], hex: c.color, r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
    });
    buildPaletteUI();
  }

  let paletteEls = [];
  function buildPaletteUI() {
    els.palette.innerHTML = '';
    paletteEls = [];
    for (const c of state.palette) {
      const s = document.createElement('span');
      s.className = 'swatch';
      s.style.background = c.hex;
      s.title = c.name + ' ' + c.hex;
      els.palette.appendChild(s);
      paletteEls.push(s);
    }
  }

  function markPaletteUsed() {
    const counts = state.counts;
    if (!counts) return;
    for (let i = 0; i < paletteEls.length; i++) {
      paletteEls[i].classList.toggle('used', counts[i] > 0);
    }
  }

  /* ---------------- 图片导入 ---------------- */

  function handleFiles(files) {
    if (state.editing) return;
    const file = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (!file) { toast('请选择图片文件', 'error'); return; }
    decodeImage(file).then((img) => {
      state.image = img;
      showImageInfo(img);
      els.emptyState.classList.add('hidden');
      els.result.classList.remove('hidden');
      process();
    }).catch((e) => toast('图片读取失败：' + e.message, 'error'));
  }

  // 关键：先 clearRect 再 drawImage，不做任何白底合成，
  // getImageData 返回原始非预乘 RGBA，透明像素得以保留。
  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        let hasAlpha = false;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let p = 3; p < data.length; p += 4) {
          if (data[p] < 255) { hasAlpha = true; break; }
        }
        resolve({ canvas, w: canvas.width, h: canvas.height, hasAlpha, name: file.name || '图片', type: file.type });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码该图片')); };
      img.src = url;
    });
  }

  function showImageInfo(img) {
    const alphaText = img.hasAlpha
      ? '含透明通道'
      : '无透明通道（如需去掉白底，请勾选「白色背景视为空位」）';
    els.imageInfo.textContent =
      [img.name, img.w + '×' + img.h, formatType(img.type), alphaText].join('　');
    els.imageInfo.classList.remove('hidden');
  }

  /* ---------------- 缩放 ---------------- */

  function getPatternSize(srcW, srcH) {
    if (document.querySelector('input[name="scale"]:checked').value === 'max') {
      const maxDim = clamp(parseInt(els.maxDim.value, 10) || 64, 4, 1024);
      const m = Math.max(srcW, srcH);
      // 固定画布：超过原图则最近邻放大，小于原图则最近邻缩小
      if (m !== maxDim) {
        const f = maxDim / m;
        return {
          w: Math.max(1, Math.round(srcW * f)),
          h: Math.max(1, Math.round(srcH * f)),
          scaled: true,
        };
      }
    }
    return { w: srcW, h: srcH, scaled: false };
  }

  /* ---------------- 像素 → 空位判定 ---------------- */

  function extractCells() {
    const img = state.image;
    const { w, h, scaled } = getPatternSize(img.w, img.h);

    const ctx = img.canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, img.w, img.h).data;
    const sw = img.w, sh = img.h;

    const alphaT = parseInt(els.alphaRange.value, 10);
    const whiteT = parseInt(els.whiteRange.value, 10);
    const removeWhite = els.removeWhite.checked;

    const cells = new Int32Array(w * h);
    let nonEmpty = 0;

    if (scaled) {
      // 最近邻降采样：直接取源像素中心点，绝不平滑（像素图平滑会糊成一片）
      const fx = sw / w, fy = sh / h;
      for (let y = 0; y < h; y++) {
        const sy = Math.min(sh - 1, Math.floor((y + 0.5) * fy));
        const base = sy * sw;
        for (let x = 0; x < w; x++) {
          const sx = Math.min(sw - 1, Math.floor((x + 0.5) * fx));
          const p = (base + sx) * 4;
          const a = data[p + 3], r = data[p], g = data[p + 1], b = data[p + 2];
          const i = y * w + x;
          if (a < alphaT) { cells[i] = -1; continue; }
          if (removeWhite && r >= whiteT && g >= whiteT && b >= whiteT) { cells[i] = -1; continue; }
          cells[i] = (r << 16) | (g << 8) | b;
          nonEmpty++;
        }
      }
    } else {
      for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
        const a = data[p + 3], r = data[p], g = data[p + 1], b = data[p + 2];
        if (a < alphaT) { cells[i] = -1; continue; }
        if (removeWhite && r >= whiteT && g >= whiteT && b >= whiteT) { cells[i] = -1; continue; }
        cells[i] = (r << 16) | (g << 8) | b;
        nonEmpty++;
      }
    }

    state.patternW = w;
    state.patternH = h;
    state.rgbCells = cells;
    state.nonEmpty = nonEmpty;
  }

  /* ---------------- RGB 最近色拟合 ---------------- */

  function fit() {
    const pal = state.palette;
    if (!pal || !state.rgbCells) return;

    const n = pal.length;
    const pr = new Float64Array(n), pg = new Float64Array(n), pb = new Float64Array(n);
    for (let i = 0; i < n; i++) { pr[i] = pal[i].r; pg[i] = pal[i].g; pb[i] = pal[i].b; }

    const src = state.rgbCells;
    const idx = new Int32Array(src.length);
    const counts = new Int32Array(n);

    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v < 0) { idx[i] = -1; continue; }
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      let bi = 0, bd = Infinity;
      for (let j = 0; j < n; j++) {
        const dr = r - pr[j], dg = g - pg[j], db = b - pb[j];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = j; }
      }
      idx[i] = bi;
      counts[bi]++;
    }

    state.patternIdx = idx;
    state.counts = counts;
  }

  /* ---------------- 渲染 ---------------- */

  function previewCellPx() {
    return clamp(Math.floor(1024 / Math.max(state.patternW, state.patternH)), 4, 32);
  }

  // 画板布局尺寸（逻辑坐标）：顶部/左侧放行列数字，右侧/底部留白
  function layoutMetrics(cellPx) {
    const w = state.patternW, h = state.patternH;
    const label = cellPx >= 8 ? Math.round(cellPx * 1.35) : 0;
    const margin = label > 0 ? Math.max(8, Math.round(label * 0.5)) : 0;
    return {
      label, margin,
      px0: label, py0: label,
      px1: label + w * cellPx, py1: label + h * cellPx,
      W: label + w * cellPx + margin,
      H: label + h * cellPx + margin,
    };
  }

  // 通用画板绘制：预览与导出共用。
  // scale 用于把逻辑坐标放大到实际像素（预览按显示尺寸 + devicePixelRatio 渲染，文字不失真）
  function drawPattern(canvas, cellPx, opts, scale = 1) {
    const w = state.patternW, h = state.patternH;
    const pal = state.palette, idx = state.patternIdx;
    const grid = opts.grid && cellPx >= 5;
    const showCodes = opts.showCodes && cellPx >= 12;
    const m = layoutMetrics(cellPx);

    canvas.width = Math.max(1, Math.round(m.W * scale));
    canvas.height = Math.max(1, Math.round(m.H * scale));
    canvas.style.aspectRatio = m.W + ' / ' + m.H; // 保证 CSS 缩放不破坏 1:1
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, m.W, m.H);

    if (m.label > 0) {
      ctx.fillStyle = '#ffffff'; // 行列数字区背景统一纯白
      ctx.fillRect(0, 0, m.px1, m.label); // 顶部列号区
      ctx.fillRect(0, 0, m.label, m.py1); // 左侧行号区
    }

    // 格子（含可选色号文字）
    if (showCodes) {
      ctx.font = '600 ' + Math.max(7, Math.round(cellPx * 0.36)) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = idx[y * w + x];
        const px = m.label + x * cellPx, py = m.label + y * cellPx;
        if (v >= 0) {
          ctx.fillStyle = pal[v].hex;
          ctx.fillRect(px, py, cellPx, cellPx);
          if (showCodes) {
            ctx.fillStyle = luminance(pal[v].r, pal[v].g, pal[v].b) > 150 ? '#26262a' : '#fafafa';
            ctx.fillText(pal[v].name, px + cellPx / 2, py + cellPx / 2 + 0.5);
          }
          // 淡内描边：让白色豆与纯白空格可区分
          if (cellPx >= 6) {
            ctx.strokeStyle = 'rgba(0,0,0,0.16)';
            ctx.lineWidth = 1;
            ctx.strokeRect(px + 0.5, py + 0.5, cellPx - 1, cellPx - 1);
          }
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(px, py, cellPx, cellPx);
        }
      }
    }

    // 网格线：每 4 格加粗，与行列数字呼应
    if (grid) {
      const line = (x1, y1, x2, y2, color) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      };
      for (let x = 0; x <= w; x++) {
        const px = m.px0 + x * cellPx;
        line(px, m.py0, px, m.py1, x % 4 === 0 ? 'rgba(24,24,27,0.35)' : 'rgba(24,24,27,0.10)');
      }
      for (let y = 0; y <= h; y++) {
        const py = m.py0 + y * cellPx;
        line(m.px0, py, m.px1, py, y % 4 === 0 ? 'rgba(24,24,27,0.35)' : 'rgba(24,24,27,0.10)');
      }
    }

    // 行列数字：全部标注，每 4 个加粗（0,4,8,12,…）
    if (m.label > 0) {
      const fs = Math.max(8, Math.round(cellPx * 0.5));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let x = 0; x < w; x++) {
        const bold = x % 4 === 0;
        ctx.fillStyle = bold ? '#3f3f46' : '#a1a1aa';
        ctx.font = (bold ? '700 ' : '400 ') + fs + 'px ' + FONT;
        ctx.fillText(String(x), m.label + x * cellPx + cellPx / 2, m.label / 2 + 0.5);
      }
      ctx.textAlign = 'right';
      for (let y = 0; y < h; y++) {
        const bold = y % 4 === 0;
        ctx.fillStyle = bold ? '#3f3f46' : '#a1a1aa';
        ctx.font = (bold ? '700 ' : '400 ') + fs + 'px ' + FONT;
        ctx.fillText(String(y), m.label - 5, m.label + y * cellPx + cellPx / 2 + 0.5);
      }
    }
  }

  // 预览：按容器可用宽度 + devicePixelRatio 渲染，避免 CSS 缩放导致文字失真
  function renderPreview() {
    if (!state.palette || !state.patternIdx) return;
    const wrap = els.canvasWrap;
    const availW = Math.max(240, wrap.clientWidth - 20); // 减去内边距
    const cellPx = previewCellPx();
    const m = layoutMetrics(cellPx);
    const dispScale = Math.min(1, availW / m.W); // 不超过 1:1
    const dpr = window.devicePixelRatio || 1;
    drawPattern(els.patternCanvas, cellPx, {
      grid: els.gridLines.checked,
      showCodes: els.showCodes.checked,
    }, dispScale * dpr);
    els.patternCanvas.style.width = Math.round(m.W * dispScale) + 'px';
  }

  function render() {
    if (!state.palette || !state.patternIdx) return;

    renderPreview();
    renderLegend();
    updateStats();
    markPaletteUsed();

    const usable = state.nonEmpty > 0 && state.patternIdx.length > 0;
    const dis = state.editing || !usable; // 编辑期间禁用导出
    els.btnPng.disabled = dis;
    els.btnCsv.disabled = dis;
    els.btnJson.disabled = dis;
  }

  // 内容包围盒：空白（空位）不计入
  function computeBounds() {
    const idx = state.patternIdx, w = state.patternW;
    if (!idx || state.nonEmpty === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] >= 0) {
        const x = i % w, y = (i / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { cw: maxX - minX + 1, ch: maxY - minY + 1 };
  }

  function updateStats() {
    const total = state.patternW * state.patternH;
    const used = state.counts ? state.counts.reduce((s, c) => s + (c > 0 ? 1 : 0), 0) : 0;
    const b = state.bounds;

    const seg = (t) => '<span class="stat-seg">' + t + '</span>';
    let html = seg(state.patternW + ' × ' + state.patternH)
      + seg('拼豆 ' + state.nonEmpty)
      + seg('空位 ' + (total - state.nonEmpty))
      + seg('用色 ' + used + ' / ' + state.palette.length);

    if (b) {
      html += '<br>'
        + seg('内容 ' + b.cw + ' × ' + b.ch + '（空白不计）')
        + seg('大号 5mm ' + fmtMm(b.cw * 5) + ' × ' + fmtMm(b.ch * 5) + ' mm')
        + seg('小号 2.6mm ' + fmtMm(b.cw * 2.6) + ' × ' + fmtMm(b.ch * 2.6) + ' mm');
    } else {
      html += '<br><span class="stat-seg warn">没有可放置的拼豆像素，请调整透明/白底阈值或缩放</span>';
    }
    els.stats.innerHTML = html;
  }

  // 用到的颜色，按数量降序
  function usedColorRows() {
    if (!state.counts) return [];
    const pal = state.palette, counts = state.counts;
    const rows = [];
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) rows.push({ name: pal[i].name, hex: pal[i].hex, c: counts[i] });
    }
    rows.sort((a, b) => b.c - a.c || a.name.localeCompare(b.name, 'zh'));
    return rows;
  }

  function renderLegend() {
    const rows = usedColorRows();
    let total = 0;
    for (const r of rows) total += r.c;

    els.legendWrap.innerHTML = rows.map((r) =>
      '<div class="legend-card" title="' + r.hex + '">'
        + '<span class="legend-swatch" style="background:' + r.hex + '"></span>'
        + '<div class="legend-meta">'
        +   '<span class="legend-name">' + r.name + '</span>'
        +   '<span class="legend-count">×' + r.c + '</span>'
        + '</div>'
      + '</div>').join('');
    els.legendTotal.textContent = total > 0
      ? '共 ' + rows.length + ' 种颜色，' + total + ' 颗豆'
      : '';
  }

  /* ---------------- 主流程 ---------------- */

  let pending = false;
  function scheduleProcess() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; process(); });
  }

  function process() {
    if (!state.image || !state.palette) return;
    extractCells();
    fit();
    state.bounds = computeBounds();
    render();
  }

  /* ---------------- 编辑 ---------------- */

  function setEditing(on) {
    if (on && (!state.image || !state.patternIdx)) {
      toast('请先导入图片再开启编辑', 'error');
      els.editToggle.checked = false;
      return;
    }
    state.editing = on;
    els.editTools.classList.toggle('hidden', !on);
    // 编辑时才阻止触屏滚动（绘制用），非编辑状态画布可正常滚动页面
    els.patternCanvas.style.touchAction = on ? 'none' : 'auto';

    // 开启编辑时禁用其他功能（厂家色板颜色仍可点选）
    const controls = [
      els.dropZone, els.fileInput, els.manufacturer, els.alphaRange,
      els.whiteRange, els.removeWhite, els.maxDim,
      els.btnPng, els.btnCsv, els.btnJson,
    ];
    for (const el of controls) el.disabled = on;
    els.scaleRadios.forEach((r) => { r.disabled = on; });
    document.querySelectorAll('.chip').forEach((c) => { c.disabled = on; });
    els.dropZone.classList.toggle('disabled', on);

    if (on) {
      state.undoStack = [];
      state.redoStack = [];
      state.painting = false;
      // 默认选中一个已用颜色，否则第一个
      let first = -1;
      for (let i = 0; i < state.counts.length; i++) {
        if (state.counts[i] > 0) { first = i; break; }
      }
      state.currentColor = first >= 0 ? first : 0;
      selectPaletteColor(state.currentColor);
      els.patternCanvas.style.cursor = 'crosshair';
      updateUndoRedo();
    } else {
      paletteEls.forEach((s) => s.classList.remove('selected'));
      els.patternCanvas.style.cursor = '';
      markPaletteUsed();
    }
    if (state.patternIdx) renderPreview();
  }

  function selectPaletteColor(idx) {
    state.currentColor = idx;
    paletteEls.forEach((s, i) => s.classList.toggle('selected', i === idx));
  }

  // 指针坐标 → 格子下标（按逻辑坐标映射）
  function cellFromEvent(e) {
    const canvas = els.patternCanvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return -1;
    const cellPx = previewCellPx();
    const m = layoutMetrics(cellPx);
    const nx = ((e.clientX - rect.left) / rect.width) * m.W;
    const ny = ((e.clientY - rect.top) / rect.height) * m.H;
    const col = Math.floor((nx - m.label) / cellPx);
    const row = Math.floor((ny - m.label) / cellPx);
    if (col >= 0 && col < state.patternW && row >= 0 && row < state.patternH) {
      return row * state.patternW + col;
    }
    return -1;
  }

  function pointerDown(e) {
    if (!state.editing || !state.patternIdx) return;
    e.preventDefault();
    const i = cellFromEvent(e);
    if (i < 0) return;
    els.patternCanvas.setPointerCapture(e.pointerId);
    state.strokeSnapshot = state.patternIdx.slice();
    if (state.tool === 'bucket') {
      floodFill(i);
      pushUndo(state.strokeSnapshot);
      state.strokeSnapshot = null;
    } else {
      state.painting = true;
      applyBrush(i);
    }
  }

  function pointerMove(e) {
    if (!state.painting) return;
    e.preventDefault();
    const i = cellFromEvent(e);
    if (i >= 0) applyBrush(i);
  }

  function pointerUp() {
    if (!state.painting) return;
    state.painting = false;
    if (state.strokeSnapshot) {
      pushUndo(state.strokeSnapshot);
      state.strokeSnapshot = null;
    }
  }

  function applyBrush(i) {
    const idx = state.patternIdx;
    if (state.tool === 'eraser') {
      if (idx[i] !== -1) { idx[i] = -1; afterEdit(); }
    } else {
      if (idx[i] !== state.currentColor) { idx[i] = state.currentColor; afterEdit(); }
    }
  }

  // 油漆桶：连通区域填充（含空位）
  function floodFill(start) {
    const idx = state.patternIdx, w = state.patternW, h = state.patternH;
    const target = idx[start];
    const color = state.currentColor;
    if (target === color) return;
    const stack = [start];
    const seen = new Uint8Array(idx.length);
    seen[start] = 1;
    let changed = false;
    while (stack.length) {
      const p = stack.pop();
      if (idx[p] !== target) continue;
      idx[p] = color;
      changed = true;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (changed) afterEdit();
  }

  function pushUndo(snapshot) {
    state.undoStack.push(snapshot);
    if (state.undoStack.length > 100) state.undoStack.shift();
    state.redoStack = [];
    updateUndoRedo();
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(state.patternIdx.slice());
    state.patternIdx = state.undoStack.pop();
    afterEdit();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(state.patternIdx.slice());
    state.patternIdx = state.redoStack.pop();
    afterEdit();
  }

  function updateUndoRedo() {
    els.btnUndo.disabled = state.undoStack.length === 0;
    els.btnRedo.disabled = state.redoStack.length === 0;
  }

  // 编辑后重算统计并刷新视图
  function afterEdit() {
    state.nonEmpty = 0;
    const counts = new Int32Array(state.palette.length);
    for (let i = 0; i < state.patternIdx.length; i++) {
      const v = state.patternIdx[i];
      if (v >= 0) { counts[v]++; state.nonEmpty++; }
    }
    state.counts = counts;
    state.bounds = computeBounds();
    render();
    updateUndoRedo();
  }

  /* ---------------- 导出 ---------------- */

  function fmtMm(v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }

  function exportPNG() {
    if (!state.patternIdx || state.nonEmpty === 0) return;
    // 导出格子大小自适应，避免超大画布（目标边长 ≤ 2048）；
    // 开启色号标注时用更大的格子保证文字可读
    const max = Math.max(state.patternW, state.patternH);
    const baseCell = els.showCodes.checked
      ? clamp(Math.floor(2048 / max), 12, 24)
      : clamp(Math.floor(2048 / max), 4, 16);
    const opts = {
      grid: els.gridLines.checked,
      showCodes: els.showCodes.checked,
    };

    // 画布与下方信息块宽度一致；图案过窄时加大格子，保证信息可读
    const pat = document.createElement('canvas');
    let cell = baseCell;
    drawPattern(pat, cell, opts);
    while (pat.width < 600 && cell < 64) {
      cell += 4;
      drawPattern(pat, cell, opts);
    }

    // 图纸下方拼接：材料清单 + 参数（宽度与画布一致）
    const info = buildInfoBlock(pat.width);
    const out = document.createElement('canvas');
    out.width = pat.width;
    out.height = pat.height + info.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(pat, 0, 0);
    ctx.drawImage(info, 0, pat.height);

    out.toBlob((b) => download('拼豆图纸_' + state.title + '_' + state.patternW + 'x' + state.patternH + '.png', b), 'image/png');
  }

  // 导出 PNG 底部的信息块：材料清单（自适应宽度卡片）在上，参数在最底部
  function buildInfoBlock(width) {
    const b = state.bounds;
    const rows = usedColorRows();
    const W = width; // 与画布宽度一致
    const margin = 28;
    const gap = 10;
    const cardH = 44;

    const scaleText = document.querySelector('input[name="scale"]:checked').value === 'max'
      ? '最大边长 ' + els.maxDim.value
      : '1:1';
    const lines = [
      '厂家：' + state.title,
      '画板：' + state.patternW + ' × ' + state.patternH
        + '    拼豆：' + state.nonEmpty
        + '    空位：' + (state.patternW * state.patternH - state.nonEmpty),
      b
        ? '内容（空白不计）：' + b.cw + ' × ' + b.ch
          + '    大号 5mm：' + fmtMm(b.cw * 5) + ' × ' + fmtMm(b.ch * 5) + ' mm'
          + '    小号 2.6mm：' + fmtMm(b.cw * 2.6) + ' × ' + fmtMm(b.ch * 2.6) + ' mm'
        : '内容：无',
      '透明阈值：' + els.alphaRange.value
        + '    白底去除：' + (els.removeWhite.checked ? '开（' + els.whiteRange.value + '）' : '关')
        + '    缩放：' + scaleText,
      '生成时间：' + new Date().toLocaleString('zh-CN'),
    ];

    const headH = 26, lineH = 21, gapSection = 14;

    // 卡片：一行 5 个平铺（等宽均分）
    const cols = 5;
    const cardW = Math.floor((W - margin * 2 - gap * (cols - 1)) / cols);
    const rows2 = Math.ceil(rows.length / cols);
    const legendH = rows.length > 0 ? rows2 * (cardH + gap) - gap : 0;

    const H = margin
      + (rows.length > 0 ? headH + 2 + legendH : 0)
      + gapSection + headH + 2
      + lines.length * lineH
      + margin;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // 小节标题（与内容统一 alphabetic 基线，避免错位）
    const heading = (text, yy) => {
      ctx.fillStyle = '#1c1c1f';
      ctx.font = '700 14px ' + FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, margin, yy + headH - 8);
    };

    let yy = margin;

    // 材料清单（卡片）
    if (rows.length > 0) {
      heading('材料清单', yy);
      yy += headH + 2;
      for (let i = 0; i < rows.length; i++) {
        const cx = margin + (i % cols) * (cardW + gap);
        const cy = yy + Math.floor(i / cols) * (cardH + gap);
        drawLegendCard(ctx, cx, cy, cardW, cardH, rows[i]);
      }
      yy += legendH;
    }

    // 参数（最底部）
    yy += gapSection;
    heading('参数', yy);
    yy += headH + 2;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '12px ' + FONT;
    for (const ln of lines) {
      ctx.fillStyle = '#1c1c1f';
      ctx.fillText(ln, margin, yy + lineH - 6);
      yy += lineH;
    }

    return canvas;
  }

  // 导出用的清单卡片：色块 + 色号 + 个数
  function drawLegendCard(ctx, cx, cy, w, h, r) {
    ctx.fillStyle = '#fafafa';
    ctx.strokeStyle = '#e5e5e8';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx, cy, w, h, 8);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(cx, cy, w, h);
      ctx.strokeRect(cx + 0.5, cy + 0.5, w - 1, h - 1);
    }
    // 色块
    const sw = 20, swX = cx + 12, swY = cy + (h - sw) / 2;
    ctx.fillStyle = r.hex;
    ctx.fillRect(swX, swY, sw, sw);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.strokeRect(swX + 0.5, swY + 0.5, sw - 1, sw - 1);
    // 色号（上）与个数（下）
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1c1c1f';
    ctx.font = '600 12.5px ' + FONT;
    ctx.fillText(r.name, swX + sw + 10, cy + h / 2 - 7);
    ctx.fillStyle = '#6b6b74';
    ctx.font = '11.5px ' + FONT;
    ctx.fillText('×' + r.c, swX + sw + 10, cy + h / 2 + 8);
  }

  function exportCSV() {
    if (!state.counts) return;
    const pal = state.palette, counts = state.counts;
    const rows = [];
    let total = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) { rows.push({ name: pal[i].name, hex: pal[i].hex, c: counts[i] }); total += counts[i]; }
    }
    rows.sort((a, b) => b.c - a.c || a.name.localeCompare(b.name, 'zh'));

    let csv = '\uFEFF色号,Hex,数量,占比\r\n';
    for (const r of rows) {
      csv += r.name + ',' + r.hex + ',' + r.c + ',' + ((r.c / total) * 100).toFixed(1) + '%\r\n';
    }
    download('拼豆色号清单_' + state.title + '.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  }

  function exportJSON() {
    if (!state.patternIdx) return;
    const pal = state.palette, idx = state.patternIdx, w = state.patternW, h = state.patternH;
    const grid = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const v = idx[y * w + x];
        row.push(v >= 0 ? pal[v].name : null);
      }
      grid.push(row);
    }
    const obj = {
      tool: 'beansGenerator',
      manufacturer: state.title,
      width: w,
      height: h,
      grid: grid,
    };
    download('拼豆图纸数据_' + state.title + '.json', new Blob([JSON.stringify(obj)], { type: 'application/json' }));
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    // 上传
    ['dragenter', 'dragover'].forEach((ev) =>
      els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.remove('dragover'); }));
    els.dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
    els.dropZone.addEventListener('click', () => { if (!state.editing) els.fileInput.click(); });
    els.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!state.editing) els.fileInput.click(); }
    });
    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files.length) handleFiles(els.fileInput.files);
      els.fileInput.value = '';
    });

    // 厂家
    els.manufacturer.addEventListener('change', () => {
      setPalette(els.manufacturer.value);
      process();
      saveSettings();
    });

    // 像素处理
    const bindRange = (range, out) => {
      range.addEventListener('input', () => { out.textContent = range.value; scheduleProcess(); saveSettings(); });
    };
    bindRange(els.alphaRange, els.alphaOut);
    bindRange(els.whiteRange, els.whiteOut);

    els.removeWhite.addEventListener('change', () => { scheduleProcess(); saveSettings(); });
    els.scaleRadios.forEach((r) =>
      r.addEventListener('change', () => {
        els.maxDimRow.classList.toggle('hidden', r.value !== 'max');
        if (r.value === 'one') {
          document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        }
        scheduleProcess();
        saveSettings();
      }));
    els.maxDim.addEventListener('input', () => { scheduleProcess(); saveSettings(); });

    // 常用尺寸快捷按钮（如 160×160 一键还原为 32×32）
    document.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        document.querySelector('input[name="scale"][value="max"]').checked = true;
        els.maxDimRow.classList.remove('hidden');
        els.maxDim.value = chip.dataset.dim;
        document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
        scheduleProcess();
        saveSettings();
      }));

    // 视图（仅重绘）
    const rerender = () => { if (state.patternIdx) render(); };
    els.gridLines.addEventListener('change', rerender);
    els.showCodes.addEventListener('change', rerender);

    // 编辑
    els.editToggle.addEventListener('change', () => setEditing(els.editToggle.checked));
    els.toolBtns.forEach((btn) =>
      btn.addEventListener('click', () => {
        state.tool = btn.dataset.tool;
        els.toolBtns.forEach((b) => b.classList.toggle('active', b === btn));
      }));
    els.btnUndo.addEventListener('click', undo);
    els.btnRedo.addEventListener('click', redo);
    els.palette.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      const idx = paletteEls.indexOf(sw);
      if (idx >= 0 && state.editing) selectPaletteColor(idx);
    });
    els.patternCanvas.addEventListener('pointerdown', pointerDown);
    els.patternCanvas.addEventListener('pointermove', pointerMove);
    els.patternCanvas.addEventListener('pointerup', pointerUp);
    els.patternCanvas.addEventListener('pointercancel', pointerUp);

    // 导出
    els.btnPng.addEventListener('click', exportPNG);
    els.btnCsv.addEventListener('click', exportCSV);
    els.btnJson.addEventListener('click', exportJSON);

    // 窗口尺寸变化时按新宽度重绘预览，保持文字清晰且不拉伸
    let resizePending = false;
    window.addEventListener('resize', () => {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        if (state.patternIdx) renderPreview();
      });
    });
  }

  /* ---------------- 启动 ---------------- */

  loadSettings();
  bindEvents();
  loadColors();
})();
