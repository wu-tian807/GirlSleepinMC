// music-player.js — 基于 MUSIC_MANIFEST 的目录式音乐播放器

// ── 状态 ──────────────────────────────────────────────────────────────
var _mpStack    = [];   // 导航栈 [{ label, node }]
var _mpItems    = [];   // 当前层全部条目 [entry, ...]（随导航刷新）
var _mpOffset   = 0;   // 视口起始索引
var _mpCurrent  = null; // 正在播放的 track path
var _mpAudio    = null;
var _mpSelected = -1;   // 当前选中的视口内槽位索引（0~8）

// 滚动条淡出定时器
var _mpSbTimer  = null;

// ── 导航状态持久化（接口由 save.js 提供）────────────────────────────
function _mpSaveNav() {
  saveNav(_mpStack.map(s => s.label), _mpOffset);
}

// 从 root 开始按 label 路径重建 _mpStack，找不到就停在已走到的位置
function _mpRestoreNav() {
  _mpStack = [];
  try {
    const saved = loadNav();
    if (saved) {
      const { path, offset } = saved;
      if (Array.isArray(path)) {
        let entries = _mpRootEntries();
        for (const label of path) {
          const match = entries.find(e => e.type === 'folder' && e.label === label);
          if (!match) break;
          _mpStack.push({ label: match.label, node: match });
          entries = Object.values(match.children || {});
          entries = [
            ...entries.filter(e => e.type === 'folder'),
            ...entries.filter(e => e.type === 'track'),
          ];
        }
        _mpRefreshItems();
        const maxOff = Math.max(0, _mpItems.length - WB_SLOT_COUNT);
        _mpOffset = Math.max(0, Math.min(maxOff, offset || 0));
        return;
      }
    }
  } catch (e) {}
  // 无存档或解析失败：回到根目录
  _mpRefreshItems();
}

// ── 数据工具 ──────────────────────────────────────────────────────────
function _mpRootEntries() {
  if (typeof MUSIC_MANIFEST === 'undefined') return [];
  // 文件夹优先，再曲目
  const entries = Object.values(MUSIC_MANIFEST);
  return [
    ...entries.filter(e => e.type === 'folder'),
    ...entries.filter(e => e.type === 'track'),
  ];
}

function _mpRefreshItems() {
  if (_mpStack.length === 0) {
    _mpItems = _mpRootEntries();
  } else {
    const node = _mpStack[_mpStack.length - 1].node;
    const ch = Object.values(node.children || {});
    _mpItems = [
      ...ch.filter(e => e.type === 'folder'),
      ...ch.filter(e => e.type === 'track'),
    ];
  }
  _mpOffset   = 0;
  _mpSelected = -1;
}

// ── 栏位几何（沿用 shared.js 中的参数）────────────────────────────────
function mpGetSlotRect(i) {
  const a0 = WB_SLOT_REF[0];
  const a1 = WB_SLOT_REF[1];
  const dt = a1.t - a0.t;
  let t = a0.t + i * dt;
  if (i >= WB_SLOT_LOWER_FROM) t -= WB_SLOT_LOWER_U;
  return {
    l: a0.l,
    t: t,
    w: (a0.w + a1.w) / 2,
    h: (a0.h + a1.h) / 2,
  };
}

function mpApplySlotRect(el, i) {
  const r = mpGetSlotRect(i);
  el.style.left   = (r.l * 100) + '%';
  el.style.top    = (r.t * 100) + '%';
  el.style.width  = (r.w * 100) + '%';
  el.style.height = (r.h * 100) + '%';
}

// ── DOM 构建 ──────────────────────────────────────────────────────────
function mpCreateItem(label, icon, playing) {
  const item = document.createElement('div');
  item.className = 'wb-menu-item' + (playing ? ' playing' : '') + (!label ? ' blank' : '');

  if (icon) {
    const iconEl = document.createElement('span');
    iconEl.className = 'wb-menu-icon';
    iconEl.textContent = icon;
    item.appendChild(iconEl);
  }
  if (label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'wb-menu-label';
    labelEl.textContent = label;
    item.appendChild(labelEl);
  }
  return item;
}

function mpBuildSlot(slotIdx, entry) {
  const absIdx = _mpOffset + slotIdx;
  const slot = document.createElement('div');
  slot.className = 'wb-menu-slot' + (_mpSelected === slotIdx ? ' selected' : '');
  slot.dataset.index = String(slotIdx);
  mpApplySlotRect(slot, slotIdx);

  const icon    = entry ? (entry.type === 'folder' ? '📁' : '♪') : '';
  const label   = entry ? entry.label : '';
  const playing = !!(entry && entry.type === 'track' && entry.path === _mpCurrent);

  slot.appendChild(mpCreateItem(label, icon, playing));

  slot.addEventListener('click', (e) => {
    e.stopPropagation();
    mpSelectSlot(slotIdx, entry || null);
  });

  return slot;
}

// ── 返回按钮（悬浮在 #wb-title 上，position:fixed，坐标相对 title bounding rect）
var _mpBackDrag = { active: false, sx: 0, sy: 0, snap: null, mode: '', moved: false };

function _mpTitleRect() {
  const el = document.getElementById('wb-title');
  return el ? el.getBoundingClientRect() : null;
}

function mpEnsureBackBtn() {
  let btn = document.getElementById('wb-back-btn');
  if (!btn) {
    btn = document.createElement('div');
    btn.id = 'wb-back-btn';
    btn.setAttribute('data-wb-ui', '');

    const handle = document.createElement('div');
    handle.id = 'wb-back-handle';
    handle.dataset.role = 'resize';
    btn.appendChild(handle);

    btn.addEventListener('mousedown', (e) => {
      if (!DEBUG_BACK_BTN) return;
      _mpBackDrag.active = true;
      _mpBackDrag.moved  = false;
      _mpBackDrag.sx     = e.clientX;
      _mpBackDrag.sy     = e.clientY;
      _mpBackDrag.snap   = { ...WB_BACK_BTN };
      _mpBackDrag.mode   = e.target.dataset.role === 'resize' ? 'resize' : 'move';
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_mpBackDrag.moved) { _mpBackDrag.moved = false; return; }
      if (_mpStack.length > 0) {
        mpNavigateTransition(() => {
          _mpStack.pop();
          _mpRefreshItems();
          _mpSaveNav();
          mpRender();
        });
      }
    });

    document.body.appendChild(btn);
  }
  return btn;
}

(function initBackBtnDrag() {
  window.addEventListener('mousemove', (e) => {
    if (!_mpBackDrag.active) return;
    const r = _mpTitleRect();
    if (!r || r.width <= 0 || r.height <= 0) return;

    // 像素 delta 转为相对 title 尺寸的比例
    const dx = (e.clientX - _mpBackDrag.sx) / r.width;
    const dy = (e.clientY - _mpBackDrag.sy) / r.height;
    const s  = _mpBackDrag.snap;
    const b  = WB_BACK_BTN;

    if (_mpBackDrag.mode === 'move') {
      b.l = s.l + dx;
      b.t = s.t + dy;
    } else {
      b.w = Math.max(0.02, s.w + dx);
      b.h = Math.max(0.02, s.h + dy);
    }

    const btn = document.getElementById('wb-back-btn');
    if (btn) _mpApplyBackBtnStyle(btn);
    _mpUpdateBackBtnHud();
    _mpBackDrag.moved = true;
    document.body.style.cursor = _mpBackDrag.mode === 'resize' ? 'nwse-resize' : 'grabbing';
  });

  window.addEventListener('mouseup', () => {
    if (_mpBackDrag.active) {
      _mpBackDrag.active = false;
      document.body.style.cursor = 'crosshair';
    }
  });
})();

// 用 title bounding rect + WB_BACK_BTN 的相对比例算出 fixed 像素坐标
function _mpApplyBackBtnStyle(btn) {
  const r = _mpTitleRect();
  if (!r) return;
  const b = WB_BACK_BTN;
  btn.style.left   = (r.left + b.l * r.width)  + 'px';
  btn.style.top    = (r.top  + b.t * r.height) + 'px';
  btn.style.width  = (b.w * r.width)            + 'px';
  btn.style.height = (b.h * r.height)           + 'px';
}

function _mpUpdateBackBtnHud() {
  let hud = document.getElementById('wb-back-hud');
  if (!hud) {
    hud = document.createElement('pre');
    hud.id = 'wb-back-hud';
    document.body.appendChild(hud);
  }
  const b = WB_BACK_BTN;
  const f = (n) => Number(n.toFixed(4));
  hud.textContent =
    'WB_BACK_BTN (相对 title)\n' +
    `{ l: ${f(b.l)}, t: ${f(b.t)}, w: ${f(b.w)}, h: ${f(b.h)} }`;
  hud.style.display = DEBUG_BACK_BTN ? 'block' : 'none';
}

function mpUpdateBackBtn() {
  const btn = mpEnsureBackBtn();
  if (!btn) return;

  _mpApplyBackBtnStyle(btn);

  // 收起过程中不显示高亮，让它随 panel 一起淡出
  const active  = _mpStack.length > 0 && !_wbClosing;
  const visible = _wbPhase2 || _wbExpanded;
  btn.classList.toggle('active', active);
  btn.classList.toggle('debug',  DEBUG_BACK_BTN);
  btn.style.display      = visible ? '' : 'none';
  btn.style.pointerEvents = (DEBUG_BACK_BTN || active) ? 'auto' : 'none';
  btn.style.cursor = DEBUG_BACK_BTN ? 'grab' : (active ? 'pointer' : 'default');

  _mpUpdateBackBtnHud();
}

// ── 渲染 ──────────────────────────────────────────────────────────────
function mpRender() {
  const menu = document.getElementById('wb-menu');
  if (!menu) return;
  menu.innerHTML = '';

  const slotsEl = document.createElement('div');
  slotsEl.className = 'wb-menu-slots';

  for (let i = 0; i < WB_SLOT_COUNT; i++) {
    const entry = _mpItems[_mpOffset + i] || null;
    slotsEl.appendChild(mpBuildSlot(i, entry));
  }

  menu.appendChild(slotsEl);
  mpUpdateScrollbar();
  mpUpdateBackBtn();
}

// 导航切换：淡出旧列表 → 执行回调 → 淡入新列表
var _mpNavLock = false;
function mpNavigateTransition(callback) {
  if (_mpNavLock) return;
  const menu = document.getElementById('wb-menu');
  const old  = menu && menu.querySelector('.wb-menu-slots');

  if (!old) {
    callback();
    return;
  }

  _mpNavLock = true;
  old.classList.add('fading');

  setTimeout(() => {
    callback();                                  // 更新数据 + 渲染新 DOM
    const fresh = menu.querySelector('.wb-menu-slots');
    if (fresh) {
      fresh.classList.add('fading');             // 新列表从 opacity:0 开始
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fresh.classList.remove('fading');        // 触发淡入过渡
      }));
    }
    _mpNavLock = false;
  }, 320);                                       // 与 CSS transition 时长一致
}

// ── 选中 / 导航 ───────────────────────────────────────────────────────
function mpSelectSlot(slotIdx, entry) {
  if (!entry) {
    _mpSelected = slotIdx;
    mpRender();
    return;
  }

  if (entry.type === 'folder') {
    mpNavigateTransition(() => {
      _mpStack.push({ label: entry.label, node: entry });
      _mpRefreshItems();
      _mpSaveNav();
      mpRender();
    });
    return;
  }

  if (entry.type === 'track') {
    _mpSelected = slotIdx;
    mpPlay(entry.path);
  }
}

// ── 音量渐变工具 ──────────────────────────────────────────────────────
// 使用独立 timer，每个 audio 实例维护自己的句柄
function _mpFadeTo(audio, targetVol, durationMs) {
  if (!audio) return;
  if (audio._fadeTimer) { clearInterval(audio._fadeTimer); audio._fadeTimer = null; }

  const startVol = audio.volume;
  if (Math.abs(targetVol - startVol) < 0.001) { audio.volume = targetVol; return; }

  const steps  = Math.max(60, Math.round(durationMs / 16)); // ~60fps
  const stepMs = durationMs / steps;
  let   i      = 0;

  audio._fadeTimer = setInterval(() => {
    i++;
    const t = i / steps;
    if (targetVol < startVol) {
      // 淡出：cubic ease-in，开头平缓，结尾加速消散（自然耳感）
      audio.volume = Math.max(0, startVol * Math.pow(1 - t, 2.5));
    } else {
      // 淡入：ease-out，快速起音后平滑稳定
      audio.volume = Math.min(1, startVol + (targetVol - startVol) * (1 - Math.pow(1 - t, 2)));
    }
    if (i >= steps) {
      audio.volume = targetVol;
      clearInterval(audio._fadeTimer);
      audio._fadeTimer = null;
    }
  }, stepMs);
}

// ── 随机播放工具 ──────────────────────────────────────────────────────
function _mpAllTracks() {
  const list = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'track') { list.push(node.path); return; }
    if (node.children) Object.values(node.children).forEach(walk);
  }
  if (typeof MUSIC_MANIFEST !== 'undefined') Object.values(MUSIC_MANIFEST).forEach(walk);
  return list;
}

// 随机选一首，排除 excludePath（不重复当前曲目）
function _mpPickRandom(excludePath) {
  const all  = _mpAllTracks();
  const pool = all.filter(p => p !== excludePath);
  if (!pool.length) return all[0] || null;   // 只有一首时仍播放
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── 播放 ──────────────────────────────────────────────────────────────
var MP_BGM_VOLUME = 0.25;  // BGM 音量：25%

function _mpSetTitlePlaying(on) {
  const el = document.getElementById('wb-title');
  if (el) el.classList.toggle('playing', on);
}

function mpPlay(path) {
  if (_mpAudio) {
    _mpFadeTo(_mpAudio, 0, 2000);
    const old = _mpAudio;
    setTimeout(() => { old.pause(); }, 2100);
    _mpAudio = null;
  }

  _mpCurrent = path;
  const audio = new Audio(path);
  _mpAudio = audio;
  audio.volume = 0;
  audio.play().catch(() => {});
  _mpFadeTo(audio, MP_BGM_VOLUME, 2500);
  _mpSetTitlePlaying(true);

  if (typeof setCrackleDuck === 'function') setCrackleDuck(0.10, 1.5);

  audio.addEventListener('ended', () => {
    if (_mpAudio === audio) {
      const prevPath = path;
      _mpCurrent = null;
      _mpAudio   = null;
      _mpPaused  = false;
      // 自动随机播放下一首（排除刚播完的）
      const next = _mpPickRandom(prevPath);
      if (next) {
        mpPlay(next);
      } else {
        const titleEl = document.getElementById('wb-title');
        if (titleEl) {
          titleEl.style.transform = '';
          titleEl.classList.remove('paused', 'playing');
        }
        if (typeof setCrackleDuck === 'function') setCrackleDuck(1.0, 2.0);
        mpRender();
      }
    }
  });
  mpRender();
}

// ── 暂停 / 继续（title 点击触发）──────────────────────────────────────
var _mpPaused = false;

function mpTogglePause() {
  // 未播放时：随机选一首开始播放
  if (!_mpAudio || !_mpCurrent) {
    const next = _mpPickRandom(null);
    if (next) mpPlay(next);
    return;
  }

  const titleEl = document.getElementById('wb-title');

  if (_mpPaused) {
    // 继续播放
    _mpPaused = false;
    _mpAudio.play().catch(() => {});
    _mpFadeTo(_mpAudio, MP_BGM_VOLUME, 800);
    if (typeof setCrackleDuck === 'function') setCrackleDuck(0.10, 1.0); // 再次压低炉声
    if (titleEl) {
      titleEl.style.transform = '';
      titleEl.classList.remove('paused');
      titleEl.classList.add('playing');
    }
  } else {
    // 暂停
    _mpPaused = true;
    _mpFadeTo(_mpAudio, 0, 600);
    const ref = _mpAudio;
    setTimeout(() => { if (_mpPaused) ref.pause(); }, 650);
    if (typeof setCrackleDuck === 'function') setCrackleDuck(1.0, 0.8); // 恢复炉声
    if (titleEl) {
      const computed = window.getComputedStyle(titleEl).transform;
      titleEl.style.transform = computed === 'none' ? 'translateY(0)' : computed;
      titleEl.classList.remove('playing');
      titleEl.classList.add('paused');
    }
  }
}

function mpStop() {
  if (_mpAudio) {
    _mpFadeTo(_mpAudio, 0, 2000);
    const old = _mpAudio;
    setTimeout(() => { old.pause(); }, 2100);
    _mpAudio   = null;
    _mpCurrent = null;
  }
  _mpPaused = false;
  const titleEl = document.getElementById('wb-title');
  if (titleEl) {
    titleEl.style.transform = '';
    titleEl.classList.remove('paused', 'playing');
  }
  if (typeof setCrackleDuck === 'function') setCrackleDuck(1.0, 2.0);
  mpRender();
}

// ── 面板开/关 ─────────────────────────────────────────────────────────
function mpOpen() {
  _mpRestoreNav();   // 恢复上次退出时的目录和滚动位置
  mpRender();
  mpEnsureScrollbarDom();
  mpEnsureBackBtn();
}

// ── 左键拖动滚动 ─────────────────────────────────────────────────────
let _mpDragActive  = false;
let _mpDragStartY  = 0;
let _mpDragStartOff = 0;
let _mpSbForceShow = false;   // hover 期间强制显示滚动条

function mpInitDrag() {
  const panel = document.getElementById('wb-panel');
  if (!panel || panel._mpDragBound) return;
  panel._mpDragBound = true;

  // hover 时显示滚动条（提示可拖动）
  panel.addEventListener('mouseenter', () => {
    const maxOff = Math.max(0, _mpItems.length - WB_SLOT_COUNT);
    if (maxOff <= 0) return;
    _mpSbForceShow = true;
    mpEnsureScrollbarDom();
    mpUpdateScrollbar();
    const bar = document.getElementById('wb-scrollbar');
    if (bar) { clearTimeout(_mpSbTimer); bar.classList.add('visible'); }
  });

  panel.addEventListener('mouseleave', () => {
    _mpSbForceShow = false;
    if (!_mpDragActive) {
      const bar = document.getElementById('wb-scrollbar');
      if (bar) {
        _mpSbTimer = setTimeout(() => bar.classList.remove('visible'), 400);
      }
    }
  });

  // 拖动开始
  panel.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const maxOff = Math.max(0, _mpItems.length - WB_SLOT_COUNT);
    if (maxOff <= 0) return;
    _mpDragActive   = true;
    _mpDragStartY   = e.clientY;
    _mpDragStartOff = _mpOffset;
    e.preventDefault();
  });

  // 拖动中（绑在 window 防止移出 panel 后丢失）
  window.addEventListener('mousemove', (e) => {
    if (!_mpDragActive) return;

    // 用第 0、1 栏间距估算单栏像素高
    const inner  = document.getElementById('wb-panel-inner');
    const ih     = inner ? inner.clientHeight : 200;
    const r0     = mpGetSlotRect(0);
    const r1     = mpGetSlotRect(1);
    const slotPx = ih * (r1.t - r0.t);   // 单栏像素高

    const dy     = e.clientY - _mpDragStartY;
    const maxOff = Math.max(0, _mpItems.length - WB_SLOT_COUNT);

    // 向下拖 → 向上滚（offset 减小），保持颗粒感（round 锁格）
    const raw    = _mpDragStartOff - dy / slotPx;
    const next   = Math.max(0, Math.min(maxOff, Math.round(raw)));

    if (next !== _mpOffset) {
      _mpOffset  = next;
      _mpSelected = -1;
      _mpSaveNav();
      mpRender();
      mpUpdateScrollbar();          // 直接更新位置，不触发自动隐藏计时器
    }
  });

  // 拖动结束
  window.addEventListener('mouseup', () => {
    if (!_mpDragActive) return;
    _mpDragActive = false;
    // 如果鼠标已离开 panel，延迟隐藏
    if (!_mpSbForceShow) {
      const bar = document.getElementById('wb-scrollbar');
      if (bar) {
        _mpSbTimer = setTimeout(() => bar.classList.remove('visible'), 600);
      }
    }
  });
}

// ── 滚动指示条 ────────────────────────────────────────────────────────
function mpEnsureScrollbarDom() {
  const inner = document.getElementById('wb-panel-inner');
  if (!inner || inner.querySelector('#wb-scrollbar')) return;

  const bar   = document.createElement('div');
  bar.id      = 'wb-scrollbar';

  const thumb = document.createElement('div');
  thumb.id    = 'wb-scrollthumb';

  bar.appendChild(thumb);
  inner.appendChild(bar);
}

function mpUpdateScrollbar() {
  const bar   = document.getElementById('wb-scrollbar');
  const thumb = document.getElementById('wb-scrollthumb');
  if (!bar || !thumb) return;

  const total = _mpItems.length;
  if (total <= WB_SLOT_COUNT) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';

  // 若 hover 或拖动中，保持 visible（导航重绘后不丢失）
  if (_mpSbForceShow || _mpDragActive) {
    clearTimeout(_mpSbTimer);
    bar.classList.add('visible');
  }

  // 轨道范围：第 1 栏顶到第 9 栏底（百分比）
  const r0      = mpGetSlotRect(0);
  const r8      = mpGetSlotRect(WB_SLOT_COUNT - 1);
  const trackT  = r0.t;
  const trackB  = r8.t + r8.h;
  const trackH  = trackB - trackT;

  // 滚动条轨道本身的 % 定位
  bar.style.top    = (trackT * 100) + '%';
  bar.style.height = (trackH * 100) + '%';

  // 滑块尺寸与位置
  const thumbH   = Math.max(0.06, WB_SLOT_COUNT / total);       // 占轨道比例
  const maxScroll = total - WB_SLOT_COUNT;
  const thumbT   = maxScroll > 0 ? (_mpOffset / maxScroll) * (1 - thumbH) : 0;

  thumb.style.height = (thumbH * 100) + '%';
  thumb.style.top    = (thumbT * 100) + '%';
}

function mpShowScrollbar() {
  mpEnsureScrollbarDom();
  mpUpdateScrollbar();
  const bar = document.getElementById('wb-scrollbar');
  if (!bar) return;
  bar.classList.add('visible');
  clearTimeout(_mpSbTimer);
  // hover 或拖动中：不启动自动隐藏计时器
  if (!_mpSbForceShow && !_mpDragActive) {
    _mpSbTimer = setTimeout(() => {
      if (bar) bar.classList.remove('visible');
    }, 800);
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────
(function initMpObserver() {
  const panel = document.getElementById('wb-panel');
  if (!panel) return;

  const obs = new MutationObserver(() => {
    if (panel.classList.contains('open')) {
      mpOpen();
      mpInitDrag();
    }
  });
  obs.observe(panel, { attributes: true, attributeFilter: ['class'] });
})();

// ── 歌名标签（绝对定位在 #wb-title wrapper 内，CSS 负责位置，JS 只管内容和显隐）
function mpUpdateSongLabel() {
  const el = document.getElementById('mp-song-label');
  if (!el) return;

  if (!_mpCurrent) {
    el.style.opacity = '0';
    return;
  }

  // 从路径取文件名，格式化为可读名称
  const raw  = _mpCurrent.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const name = raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  if (el.dataset.track !== raw) {
    el.dataset.track = raw;
    el.textContent   = name;
    el.style.fontSize = '';   // 重置为 CSS 默认 9cqw，下一帧测量
    requestAnimationFrame(() => {
      const avail = el.clientWidth;
      if (avail <= 0) return;
      // 用离屏 span 测量真实文字宽（overflow:hidden 会钳制 scrollWidth）
      const cs = window.getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.cssText =
        `position:absolute;visibility:hidden;white-space:nowrap;` +
        `font-family:${cs.fontFamily};font-size:${cs.fontSize};` +
        `font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};`;
      probe.textContent = name;
      document.body.appendChild(probe);
      const textW = probe.offsetWidth;
      document.body.removeChild(probe);
      if (textW > avail) {
        // 计算并存为 cqw（相对容器宽），这样 title 缩放时字号等比缩小
        const newCqw = 9 * (avail / textW) * 0.88;
        el.style.fontSize = Math.max(1, newCqw).toFixed(2) + 'cqw';
      }
    });
  }

  el.style.opacity = _mpPaused ? '0.5' : '0.85';
}
