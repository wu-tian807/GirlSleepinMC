// furnace-ui.js — Minecraft furnace GUI interaction

const SMELT_DURATION = 1800;   // 30 min per item (real seconds, scaled)

// 燃料热量持续时长（秒）：点燃后 furnaceLevel 从 100→0 的总时间
// 按原版比例 wood:charcoal = 300:1600 ticks，映射到 charcoal=24h → wood≈4.5h
// furnaceLevel >= 10 时可以烧制；furnaceLevel 就是唯一的火力状态
const FUEL_HEAT = {
  oak_log: 16200, spruce_log: 16200, birch_log: 16200,
  jungle_log: 16200, acacia_log: 16200, dark_oak_log: 16200,
  mangrove_log: 16200, cherry_log: 16200, pale_oak_log: 16200,
  charcoal: 86400,
};

// 向后兼容：FUEL_BURN 保留引用（_onSlotClick 校验"可燃物"用到它）
const FUEL_BURN = FUEL_HEAT;

const LOG_TYPES = [
  'oak_log','spruce_log','birch_log','jungle_log','acacia_log',
  'dark_oak_log','mangrove_log','cherry_log','pale_oak_log',
];

const MAX_STACK = 64;
const ITEM_TEX  = (item) => `textures/items/${item}.png`;
const ITEM_TOP  = (item) => `textures/items/${item}_top.png`;

// ── 等距 3D 方块渲染 ─────────────────────────────────────────────────
const _texCache = {};
function _loadTex(url) {
  if (_texCache[url]) return _texCache[url];
  const img = new Image(); img.src = url;
  _texCache[url] = img; return img;
}

function _drawIsoBlock(cv, sideImg, topImg, S) {
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  cv.width = S; cv.height = S;
  c.clearRect(0, 0, S, S);
  const T = 16;
  // 右侧面
  c.save();
  c.setTransform(S/(2*T), -S/(4*T), 0, S/(2*T), S/2, S/2);
  c.drawImage(sideImg, 0, 0, T, T); c.restore();
  // 左侧面
  c.save();
  c.setTransform(S/(2*T), S/(4*T), 0, S/(2*T), 0, S/4);
  c.drawImage(sideImg, 0, 0, T, T); c.restore();
  // 顶面
  c.save();
  c.setTransform(S/(2*T), -S/(4*T), S/(2*T), S/(4*T), 0, S/4);
  c.drawImage(topImg, 0, 0, T, T); c.restore();
}

function _renderItemCanvas(el, item, size) {
  // 清除旧 canvas/img，重建
  el.querySelectorAll('canvas, img').forEach(n => n.remove());
  const cv = document.createElement('canvas');
  cv.className = 'fslot-canvas';
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;display:block;';
  el.appendChild(cv);

  // 尝试绘制：所有纹理就绪且 canvas 仍在 DOM 时才绘制，返回是否已绘制
  const tryDraw = () => {
    if (!cv.isConnected) return true;  // canvas 已脱离 DOM，停止重试

    if (item === 'charcoal') {
      const img = _loadTex(ITEM_TEX('charcoal'));
      if (!img.complete) return false;
      const c = cv.getContext('2d'); c.imageSmoothingEnabled = false;
      cv.width = size; cv.height = size;
      c.clearRect(0, 0, size, size);
      c.drawImage(img, 0, 0, size, size);
      return true;
    }

    const side = _loadTex(ITEM_TEX(item));
    const top  = _loadTex(ITEM_TOP(item));
    if (!side.complete || !top.complete) return false;
    _drawIsoBlock(cv, side, top, size);
    return true;
  };

  // 若纹理尚未就绪，逐帧轮询直到绘制成功（最多 120 帧 ≈ 2s，避免无限循环）
  if (!tryDraw()) {
    let retries = 0;
    const poll = () => {
      if (tryDraw() || ++retries > 120) return;
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }
}

// ── DOM refs ─────────────────────────────────────────────────────────
let _gui, _inner, _slotInput, _slotFuel, _slotOutput;
let _fireBarImg, _arrowImg, _heldDiv, _smeltLabel;
let _domReady = false;
let _inputRefreshTimer = null;

function _initDom() {
  if (_domReady) return;
  _gui        = document.getElementById('furnace-gui');
  _inner      = document.getElementById('furnace-gui-inner');
  _slotInput  = document.getElementById('fslot-input');
  _slotFuel   = document.getElementById('fslot-fuel');
  _slotOutput = document.getElementById('fslot-output');
  _fireBarImg  = document.querySelector('#ffuel-bar img');
  _arrowImg    = document.querySelector('#fsmelt-arrow img');
  _heldDiv     = document.getElementById('furnace-held');
  _smeltLabel  = document.getElementById('fsmelt-label');
  _domReady    = true;
}

// ── Open / Close ──────────────────────────────────────────────────────
function openFurnaceUI() {
  _initDom();
  if (!_gui) return;
  furnaceUIOpen = true;
  _gui.classList.remove('hidden');
  _buildInventoryDom();    // 确保背包 DOM 已创建
  _applyFurnaceLayout();   // 应用布局配置（含槽位定位）
  renderFurnace();
  document.addEventListener('mousemove', _onFurnaceMouseMove);
  if (DEBUG_FURNACE_LAYOUT) _startFurnaceLayoutDebug();
}

function closeFurnaceUI() {
  _initDom();
  if (!_gui) return;
  furnaceUIOpen = false;
  _gui.classList.add('hidden');
  if (furnaceHeldItem) { furnaceHeldItem = null; _updateHeld(); }
  document.removeEventListener('mousemove', _onFurnaceMouseMove);
  saveFurnace();
  saveInventory();
}

window.openFurnaceUI  = openFurnaceUI;
window.closeFurnaceUI = closeFurnaceUI;

// ── Slot rendering ────────────────────────────────────────────────────
function _renderSlot(el, stack) {
  if (!stack || stack.count <= 0) {
    // 清空：移除内容 + 属性
    el.innerHTML = '';
    el.removeAttribute('data-cur-item');
    el.classList.remove('has-item');
    return;
  }
  el.classList.add('has-item');
  // item 类型变化 OR canvas 缺失时重绘（防止 onload 画到已脱离 DOM 的旧 canvas）
  if (el.getAttribute('data-cur-item') !== stack.item || !el.querySelector('canvas')) {
    el.setAttribute('data-cur-item', stack.item);
    _renderItemCanvas(el, stack.item, Math.max(16, _FL.itemSize));
  }
  let badge = el.querySelector('.fslot-count');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'fslot-count';
    el.appendChild(badge);
  }
  badge.textContent = stack.count > 1 ? stack.count : '';
}

function renderFurnace() {
  _initDom();
  if (!_gui) return;
  _renderSlot(_slotInput,  furnaceInputSlot);
  _renderSlot(_slotFuel,   furnaceFuelSlot);
  _renderSlot(_slotOutput, furnaceOutputSlot);

  // 火焰高度条：直接用 furnaceLevel（0-100）
  if (_fireBarImg) {
    _fireBarImg.style.clipPath = `inset(${((1 - Math.min(furnaceLevel / 100, 1)) * 100).toFixed(1)}% 0 0 0)`;
  }

  // 烧制进度箭头（从左向右展开）
  const smelting   = furnaceLevel >= 10
    && furnaceInputSlot  && furnaceInputSlot.count  > 0
    && !(furnaceOutputSlot && furnaceOutputSlot.count >= MAX_STACK);
  const smeltRatio = smelting ? Math.min(smeltProgress / SMELT_DURATION, 1) : 0;
  if (_arrowImg) {
    _arrowImg.style.clipPath = `inset(0 ${((1-smeltRatio)*100).toFixed(1)}% 0 0)`;
  }

  // 进度文字：显示烧制剩余时间 / 火力值
  if (_smeltLabel) {
    if (smelting) {
      const remain = Math.ceil(SMELT_DURATION - smeltProgress);
      const m = Math.floor(remain / 60), s = remain % 60;
      _smeltLabel.textContent = `Smelting: ${m}:${String(s).padStart(2,'0')}`;
    } else if (furnaceLevel < 10) {
      _smeltLabel.textContent = furnaceLevel > 0 ? `Fire too low (${Math.round(furnaceLevel)}%)` : 'No fuel';
    } else {
      _smeltLabel.textContent = '';
    }
  }

  _renderInventory();
  _updateHeld();
}
window.renderFurnace = renderFurnace;

// ── 点燃下一块燃料 ───────────────────────────────────────────────────
// 触发条件：
//   1. 没有活跃燃烧（decayRate=0）
//   2. 火力已低于烧制阈值（<10），即使还在衰减也需要补燃料
function _tryAutoStartFuel() {
  // 火力充足（>=10）且正在燃烧（decayRate>0）→ 排队等待
  if (furnaceLevelDecayRate > 0 && furnaceLevel >= 10) return;
  // 输入槽必须有物品，否则燃料留在槽里等待
  if (!furnaceInputSlot || furnaceInputSlot.count <= 0) return;

  let candidate = null;
  if (furnaceFuelSlot && furnaceFuelSlot.count > 0) {
    candidate = furnaceFuelSlot;
  } else if (fuelQueue.length > 0) {
    furnaceFuelSlot = fuelQueue.shift();
    candidate = furnaceFuelSlot;
  }
  if (!candidate) return;

  const heatDur = FUEL_HEAT[candidate.item] || 0;
  if (!heatDur) return;

  // 点燃：furnaceLevel 跳至 100，设置每秒衰减率，同步重置锚点
  furnaceLevel             = 100;
  furnaceLevelDecayRate    = 100 / heatDur;
  _furnaceLevelAnchorValue = 100;
  _furnaceLevelAnchorTs    = Date.now();

  candidate.count--;
  if (candidate.count <= 0) furnaceFuelSlot = null;

  if (furnaceUIOpen) renderFurnace();
  saveFurnace();
}
window._tryAutoStartFuel = _tryAutoStartFuel;

// ── 输入槽自动补货（几乎即时）────────────────────────────────────────
function _scheduleInputRefresh() {
  clearTimeout(_inputRefreshTimer);
  _inputRefreshTimer = setTimeout(() => {
    if (!furnaceInputSlot || furnaceInputSlot.count <= 0) {
      const nextType = LOG_TYPES[Math.floor(Math.random() * LOG_TYPES.length)];
      furnaceInputSlot = { item: nextType, count: 1 };
      // 输入槽补货后，如果有燃料但还没点燃，尝试点燃
      if (furnaceLevel <= 0) _tryAutoStartFuel();
      else saveFurnace();   // _tryAutoStartFuel 内部会 save；未点燃时手动保存
      if (furnaceUIOpen) renderFurnace();
    }
  }, 100);
}

// 跟踪上一帧输入槽物品类型，用于检测变化（变化时归零烧制进度）
// undefined = 尚未初始化（首帧不触发归零，保留 localStorage 恢复的进度）
let _tickPrevInputType = undefined;

// ── Tick（每帧由 updateFurnaceDecay 调用）────────────────────────────
function tickFurnace() {
  // 以下两种情况都尝试点燃：
  // 1. 上一块燃料刚耗尽（decayRate 还没清零）
  // 2. 没有燃烧会话（decayRate=0）且槽里有燃料和原料等待
  if (furnaceLevel <= 0 && furnaceLevelDecayRate > 0) {
    furnaceLevelDecayRate = 0;
  }
  // 无活跃燃烧 或 火力已跌破烧制阈值 → 尝试点燃下一块
  if ((furnaceLevelDecayRate === 0 || furnaceLevel < 10)
      && furnaceFuelSlot && furnaceFuelSlot.count > 0
      && furnaceInputSlot && furnaceInputSlot.count > 0) {
    _tryAutoStartFuel();
  }

  // 检测输入槽物品是否变化 → 重置烧制锚点
  const curInputType = furnaceInputSlot ? furnaceInputSlot.item : null;
  if (_tickPrevInputType === undefined) {
    // 首帧：静默初始化，不归零（从 localStorage 恢复的锚点已含进度）
    _tickPrevInputType = curInputType;
  } else if (curInputType !== _tickPrevInputType) {
    smeltProgress  = 0;
    _smeltStartTs  = 0;
    _smeltIsActive = false;
    _tickPrevInputType = curInputType;
  }

  const canSmelt = furnaceLevel >= 10
    && furnaceInputSlot && furnaceInputSlot.count > 0
    && !(furnaceOutputSlot && furnaceOutputSlot.count >= MAX_STACK);

  if (!canSmelt) {
    // 暂停烧制：保存当前进度，清除激活锚点
    if (_smeltIsActive) {
      if (_smeltStartTs > 0) {
        smeltProgress = Math.min((Date.now() - _smeltStartTs) / 1000, SMELT_DURATION - 0.001);
      }
      _smeltIsActive = false;
      _smeltStartTs  = 0;
    }
    if (furnaceUIOpen) renderFurnace();
    return;
  }

  // ── canSmelt 为真：用 wall-clock 锚点驱动进度 ────────────────────────
  if (!_smeltIsActive) {
    // 启动/恢复烧制——虚拟开始时间往回拨 smeltProgress 秒
    _smeltIsActive = true;
    _smeltStartTs  = Date.now() - Math.round(smeltProgress * 1000);
  }

  const rawElapsed    = (Date.now() - _smeltStartTs) / 1000;
  const completedCount = Math.floor(rawElapsed / SMELT_DURATION);

  if (completedCount > 0) {
    // 处理完成的烧制周期（含 WE 暂停 / 离线期间的批量追赶）
    for (let i = 0; i < completedCount; i++) {
      if (!furnaceInputSlot || furnaceInputSlot.count <= 0) break;
      furnaceInputSlot.count--;
      if (furnaceInputSlot.count <= 0) {
        furnaceInputSlot = null;
        _scheduleInputRefresh();
      }
      if (furnaceOutputSlot && furnaceOutputSlot.count >= MAX_STACK) break;
      furnaceOutputSlot = furnaceOutputSlot
        ? { item: 'charcoal', count: Math.min(furnaceOutputSlot.count + 1, MAX_STACK) }
        : { item: 'charcoal', count: 1 };
    }
    smeltProgress = rawElapsed % SMELT_DURATION;

    // 重检条件：产物满或输入空则暂停
    const stillCanSmelt = furnaceLevel >= 10
      && furnaceInputSlot && furnaceInputSlot.count > 0
      && !(furnaceOutputSlot && furnaceOutputSlot.count >= MAX_STACK);
    if (stillCanSmelt) {
      _smeltStartTs = Date.now() - Math.round(smeltProgress * 1000);
    } else {
      _smeltIsActive = false;
      _smeltStartTs  = 0;
    }
    saveFurnace();
  } else {
    smeltProgress = rawElapsed;
  }

  if (furnaceUIOpen) renderFurnace();
}
window.tickFurnace = tickFurnace;

// ── ItemStack 交互 ────────────────────────────────────────────────────
function _onSlotClick(slotName, e) {
  e.preventDefault();
  e.stopPropagation();
  const isRight = e.button === 2;

  // ── 产物槽：只能取出 ──────────────────────────────────────────────
  if (slotName === 'output') {
    if (!furnaceOutputSlot || furnaceOutputSlot.count <= 0) return;
    if (!furnaceHeldItem) {
      furnaceHeldItem = isRight
        ? { item: furnaceOutputSlot.item, count: Math.ceil(furnaceOutputSlot.count / 2) }
        : { ...furnaceOutputSlot };
      furnaceOutputSlot = isRight
        ? { item: furnaceOutputSlot.item, count: furnaceOutputSlot.count - Math.ceil(furnaceOutputSlot.count/2) }
        : null;
    } else if (furnaceHeldItem.item === 'charcoal' && furnaceHeldItem.count < MAX_STACK) {
      const take = Math.min(isRight ? 1 : furnaceOutputSlot.count, MAX_STACK - furnaceHeldItem.count, furnaceOutputSlot.count);
      furnaceHeldItem.count += take;
      furnaceOutputSlot.count -= take;
    }
    if (furnaceOutputSlot && furnaceOutputSlot.count <= 0) furnaceOutputSlot = null;
    renderFurnace();
    saveFurnace();
    return;
  }

  const isInput  = slotName === 'input';
  const isValid  = (item) => isInput ? LOG_TYPES.includes(item) : (item in FUEL_BURN);
  const getSlot  = () => isInput ? furnaceInputSlot  : furnaceFuelSlot;
  const setSlot  = (v) => { if (isInput) furnaceInputSlot = v; else furnaceFuelSlot = v; };

  let slot = getSlot();

  if (!furnaceHeldItem) {
    // ── 无持有：从槽里拿 ────────────────────────────────────────────
    if (!slot) return;
    const prevItem = slot.item;
    if (isRight) {
      const half = Math.ceil(slot.count / 2);
      furnaceHeldItem = { item: slot.item, count: half };
      slot = slot.count - half > 0 ? { item: slot.item, count: slot.count - half } : null;
    } else {
      furnaceHeldItem = { ...slot };
      slot = null;
    }
    setSlot(slot);
    // 输入槽被取空时自动补货
    if (isInput && !furnaceInputSlot) {
      _scheduleInputRefresh();
    }
  } else {
    // ── 持有物品：放入槽 ────────────────────────────────────────────
    if (!isValid(furnaceHeldItem.item)) { renderFurnace(); return; }

    if (!slot) {
      const place = isRight ? 1 : furnaceHeldItem.count;
      slot = { item: furnaceHeldItem.item, count: place };
      furnaceHeldItem.count -= place;
    } else if (slot.item === furnaceHeldItem.item) {
      const place    = isRight ? 1 : furnaceHeldItem.count;
      const canPlace = Math.min(place, MAX_STACK - slot.count);
      slot.count            += canPlace;
      furnaceHeldItem.count -= canPlace;
    } else if (!isRight) {
      // 不同类型左键：置换
      const tmp = { ...slot };
      slot = { ...furnaceHeldItem };
      furnaceHeldItem = tmp;
    }
    if (furnaceHeldItem && furnaceHeldItem.count <= 0) furnaceHeldItem = null;
    if (slot && slot.count <= 0) slot = null;
    setSlot(slot);

    // 放入任何槽后尝试点燃（furnaceLevel=0 且两槽都有料才会真正点燃）
    _tryAutoStartFuel();
  }

  renderFurnace();
  saveFurnace();
}

// ── 持有物品跟随鼠标 ──────────────────────────────────────────────────
function _updateHeld() {
  _initDom();
  if (!_heldDiv) return;
  if (!furnaceHeldItem || furnaceHeldItem.count <= 0) {
    _heldDiv.style.display = 'none';
    return;
  }
  _heldDiv.style.display = 'block';
  const heldSz = _FL.itemSize;
  // 手持物尺寸同步到槽位大小
  _heldDiv.style.width  = heldSz + 'px';
  _heldDiv.style.height = heldSz + 'px';
  if (_heldDiv.getAttribute('data-cur-item') !== furnaceHeldItem.item ||
      parseInt(_heldDiv.dataset.heldSz) !== heldSz) {
    _heldDiv.setAttribute('data-cur-item', furnaceHeldItem.item);
    _heldDiv.dataset.heldSz = heldSz;
    _heldDiv.querySelectorAll('canvas').forEach(n => n.remove());
    _renderItemCanvas(_heldDiv, furnaceHeldItem.item, heldSz);
  }
  let badge = _heldDiv.querySelector('.fslot-count');
  if (!badge) { badge = document.createElement('span'); badge.className = 'fslot-count'; _heldDiv.appendChild(badge); }
  badge.textContent = furnaceHeldItem.count > 1 ? furnaceHeldItem.count : '';
}

function _onFurnaceMouseMove(e) {
  if (!_heldDiv) return;
  // 原版：手持物以鼠标为中心，稍微偏左上（-2px 视觉对齐）
  const half = Math.round(_FL.itemSize / 2);
  _heldDiv.style.left = (e.clientX - half - 2) + 'px';
  _heldDiv.style.top  = (e.clientY - half - 2) + 'px';
}

// ── 初始化 ─────────────────────────────────────────────────────────
(function _setupFurnaceUI() {
  function _attach() {
    _initDom();
    if (!_gui) return;

    // ── 遮罩层：拦截所有鼠标/触摸事件，防止穿透到背后元素 ──────────────
    // click/mousedown 统一在遮罩上处理，不让事件传播到 document
    _gui.addEventListener('click',      (e) => e.stopPropagation());
    _gui.addEventListener('mousedown',  (e) => {
      e.stopPropagation();
      // 只有点在遮罩本身（不是 inner GUI 内部）才触发逻辑
      if (e.target === _gui) {
        if (furnaceHeldItem) {
          // 持有物品时：丢弃物品，不关闭 UI
          furnaceHeldItem = null;
          _updateHeld();
          saveFurnace();
        } else {
          // 空手：关闭 UI
          closeFurnaceUI();
        }
      }
    });
    _gui.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

    // 槽位点击
    [['input', _slotInput], ['fuel', _slotFuel], ['output', _slotOutput]].forEach(([name, el]) => {
      if (el) el.addEventListener('mousedown', (e) => _onSlotClick(name, e));
    });
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', _attach)
    : _attach();
})();

// ══════════════════════════════════════════════════════════════════════════════
// 熔炉 UI 布局配置 & 调试编辑器
// shared.js 里 DEBUG_FURNACE_LAYOUT = true 时激活可视化拖拽调整
// ══════════════════════════════════════════════════════════════════════════════

// 布局参数（单位 px；inner 的 x/y 为相对 furnace-gui 中心的偏移）
// itemSize：三个槽位共享的图标边长（始终等比，改一处全部同步）
var _FL = {
  inner:      { x:   0, y:   0, w: 528, h: 498 },
  itemSize:   46,                                  // 槽位图标共享边长
  slotInput:  { x: 168, y:  51 },
  slotFuel:   { x: 168, y: 159 },
  slotOutput: { x: 348, y: 105 },
  fuelBar:    { x: 171, y: 111, w:  42, h:  39 },
  smeltArrow: { x: 240, y: 102, w:  72, h:  51 },
  // 背包三行（3×9）与快捷栏（1×9）布局
  // x/y 为网格左上角相对 inner 的位置；colGap/rowGap 为槽间距（格中心到格中心）
  inv:    { x: 24, y: 252, colGap: 54, rowGap: 54 },
  hotbar: { x: 24, y: 426, colGap: 54 },
};
window._FL = _FL;

// ══════════════════════════════════════════════════════════════════════════════
// 背包系统（玩家 3×9 背包 + 1×9 快捷栏）
// ══════════════════════════════════════════════════════════════════════════════

let _invEls    = [];   // 27 个背包槽 div
let _hotbarEls = [];   // 9 个快捷栏槽 div
let _invDomBuilt = false;

/** 创建背包/快捷栏的 DOM 槽位（仅首次调用时执行） */
function _buildInventoryDom() {
  if (_invDomBuilt) return;
  _initDom();
  const inner = _inner || document.getElementById('furnace-gui-inner');
  if (!inner) return;
  _invDomBuilt = true;

  for (let i = 0; i < 27; i++) {
    const el = document.createElement('div');
    el.className = 'fslot inv-slot';
    el.dataset.invIdx = String(i);
    inner.appendChild(el);
    _invEls.push(el);
    _attachInvClick(el, 'inv', i);
  }
  for (let i = 0; i < 9; i++) {
    const el = document.createElement('div');
    el.className = 'fslot hotbar-slot';
    el.dataset.hotbarIdx = String(i);
    inner.appendChild(el);
    _hotbarEls.push(el);
    _attachInvClick(el, 'hotbar', i);
  }
}

/** 根据 _FL.inv / _FL.hotbar 定位所有背包/快捷栏槽位 */
function _positionInventorySlots() {
  const sz = _FL.itemSize;
  const { x: ix, y: iy, colGap: icg, rowGap: irg } = _FL.inv;
  for (let i = 0; i < _invEls.length; i++) {
    const row = Math.floor(i / 9), col = i % 9;
    Object.assign(_invEls[i].style, {
      left: (ix + col * icg) + 'px', top: (iy + row * irg) + 'px',
      width: sz + 'px', height: sz + 'px',
      position: 'absolute',
    });
  }
  const { x: hx, y: hy, colGap: hcg } = _FL.hotbar;
  for (let i = 0; i < _hotbarEls.length; i++) {
    Object.assign(_hotbarEls[i].style, {
      left: (hx + i * hcg) + 'px', top: hy + 'px',
      width: sz + 'px', height: sz + 'px',
      position: 'absolute',
    });
  }
}

/** 渲染单个背包槽 */
function _renderInvSlot(el, stack) {
  if (!stack || stack.count <= 0) {
    el.innerHTML = '';
    el.removeAttribute('data-cur-item');
    el.classList.remove('has-item');
    return;
  }
  el.classList.add('has-item');
  if (el.getAttribute('data-cur-item') !== stack.item || !el.querySelector('canvas')) {
    el.setAttribute('data-cur-item', stack.item);
    _renderItemCanvas(el, stack.item, Math.max(16, _FL.itemSize));
  }
  let badge = el.querySelector('.fslot-count');
  if (!badge) { badge = document.createElement('span'); badge.className = 'fslot-count'; el.appendChild(badge); }
  badge.textContent = stack.count > 1 ? stack.count : '';
}

/** 渲染所有背包 + 快捷栏槽位 */
function _renderInventory() {
  for (let i = 0; i < 27; i++) _renderInvSlot(_invEls[i], inventoryData[i]);
  for (let i = 0; i < 9; i++)  _renderInvSlot(_hotbarEls[i], hotbarData[i]);
}

/** 背包/快捷栏槽位点击事件（左键 = 全取/全放/置换，右键 = 半取/放1） */
function _attachInvClick(el, type, idx) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    e.stopPropagation(); e.preventDefault();
    const data    = type === 'inv' ? inventoryData : hotbarData;
    const slot    = data[idx];
    const isRight = e.button === 2;

    if (!furnaceHeldItem) {
      // ── 无持有：从格子里拿 ────────────────────────────────────
      if (!slot || slot.count <= 0) return;
      if (isRight) {
        const half = Math.ceil(slot.count / 2);
        furnaceHeldItem = { item: slot.item, count: half };
        const rem = slot.count - half;
        data[idx] = rem > 0 ? { item: slot.item, count: rem } : null;
      } else {
        furnaceHeldItem = { ...slot };
        data[idx] = null;
      }
    } else {
      // ── 持有物品：放到格子里 ──────────────────────────────────
      if (!slot) {
        const place = isRight ? 1 : furnaceHeldItem.count;
        data[idx] = { item: furnaceHeldItem.item, count: place };
        furnaceHeldItem.count -= place;
      } else if (slot.item === furnaceHeldItem.item) {
        // 同类型堆叠
        const can = Math.min(MAX_STACK - slot.count, isRight ? 1 : furnaceHeldItem.count);
        slot.count += can;
        furnaceHeldItem.count -= can;
      } else if (!isRight) {
        // 不同类型左键：置换
        data[idx] = { ...furnaceHeldItem };
        furnaceHeldItem = slot;
      }
      if (furnaceHeldItem && furnaceHeldItem.count <= 0) furnaceHeldItem = null;
      if (data[idx] && data[idx].count <= 0) data[idx] = null;
    }

    _renderInventory();
    _updateHeld();
    saveInventory();
  });
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// 将 _positionInventorySlots 挂到 window 供 _applyFurnaceLayout 使用
window._positionInventorySlots = _positionInventorySlots;

// 将 _renderInventory 挂到 window 供 renderFurnace 使用
window._renderInventory = _renderInventory;

// 将 _buildInventoryDom 挂到 window 供 openFurnaceUI 使用
window._buildInventoryDom = _buildInventoryDom;

// 将 _invEls/_hotbarEls 暴露供调试
window._invEls    = _invEls;
window._hotbarEls = _hotbarEls;

// 将 _FL 的 inv/hotbar 暴露到 window（供调试面板读取）

// 将 _positionInventorySlots 调用接入 _applyFurnaceLayout（定义在本文件后面）

// 将 _renderInventory 调用接入 renderFurnace（定义在本文件前面）

// 页面加载时恢复背包
(function() {
  function _doLoad() { if (typeof loadInventory === 'function') loadInventory(); }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', _doLoad)
    : _doLoad();
})();

// 将 _FL 应用到 DOM
function _applyFurnaceLayout() {
  _initDom();
  const inner = document.getElementById('furnace-gui-inner');
  if (inner) {
    inner.style.width     = _FL.inner.w + 'px';
    inner.style.height    = _FL.inner.h + 'px';
    inner.style.transform = `translate(${_FL.inner.x}px,${_FL.inner.y}px)`;
    // 背景图保持 256×256 纹理图集 3× 显示（始终是 inner 尺寸的 256/176 倍）
    const bg = document.getElementById('furnace-bg');
    if (bg) {
      const scale = _FL.inner.w / 528;   // 相对于默认 528px 的缩放比
      bg.style.width  = Math.round(768 * scale) + 'px';
      bg.style.height = Math.round(768 * scale) + 'px';
    }
  }
  const ap = (el, r) => {
    if (!el) return;
    el.style.left   = r.x + 'px'; el.style.top    = r.y + 'px';
    el.style.width  = r.w + 'px'; el.style.height = r.h + 'px';
  };
  // 槽位：位置独立，尺寸共享 itemSize（始终等比）
  const sz = _FL.itemSize;
  const _apSlot = (el, r) => {
    if (!el) return;
    const prevW = parseInt(el.style.width) || 0;
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
    el.style.width = sz + 'px'; el.style.height = sz + 'px';
    if (prevW !== sz) el.removeAttribute('data-cur-item'); // 尺寸变化时强制重绘
  };
  _apSlot(_slotInput,  _FL.slotInput);
  _apSlot(_slotFuel,   _FL.slotFuel);
  _apSlot(_slotOutput, _FL.slotOutput);
  ap(document.getElementById('ffuel-bar'),    _FL.fuelBar);
  ap(document.getElementById('fsmelt-arrow'), _FL.smeltArrow);
  // 重新定位背包/快捷栏槽位
  _positionInventorySlots();
  // 尺寸变化后重渲染槽位内容
  if (furnaceUIOpen) renderFurnace();
  // 同步调试句柄位置
  if (DEBUG_FURNACE_LAYOUT) _syncDebugHandles();
}
window._applyFurnaceLayout = _applyFurnaceLayout;

// ── 调试编辑器内部状态 ──────────────────────────────────────────────────
let _fldPanel      = null;   // 参数面板 DOM
let _fldHandles    = {};     // key → { el, resizeEl }
let _fldDrag       = null;   // { key, mode:'move'|'resize', startX, startY, origX, origY, origW, origH }

// 元素标签 & 颜色
// flPath: 若设置，则 move 时更新 _FL[flPath].x/y 而非 _FL[key].x/y
const _FLD_ITEMS = [
  { key: 'inner',        label: '内层 GUI',        color: '#4af',  canResize: true,  parent: 'gui'                         },
  { key: 'slotInput',    label: '输入槽',           color: '#4f4',  canResize: false, parent: 'inner'                       },
  { key: 'slotFuel',     label: '燃料槽',           color: '#ff4',  canResize: false, parent: 'inner'                       },
  { key: 'slotOutput',   label: '产物槽',           color: '#f84',  canResize: false, parent: 'inner'                       },
  { key: 'itemSize',     label: '图标大小(共享↔)',  color: '#0ff',  canResize: true,  parent: 'inner'                       },
  { key: 'fuelBar',      label: '火焰条',           color: '#f44',  canResize: true,  parent: 'inner'                       },
  { key: 'smeltArrow',   label: '烧制箭头',         color: '#c4f',  canResize: true,  parent: 'inner'                       },
  { key: 'invOrigin',    label: '背包↖',            color: '#0fa',  canResize: false, parent: 'inner', flPath: 'inv'        },
  { key: 'hotbarOrigin', label: '快捷栏↖',          color: '#fa0',  canResize: false, parent: 'inner', flPath: 'hotbar'     },
];

function _syncDebugHandles() {
  _initDom();
  const gui   = _gui;
  const inner = document.getElementById('furnace-gui-inner');
  if (!gui || !inner) return;

  // inner 的屏幕坐标（相对于 gui）
  const guiR   = gui.getBoundingClientRect();
  const innerR = inner.getBoundingClientRect();

  _FLD_ITEMS.forEach(({ key, color, canResize }) => {
    const h = _fldHandles[key];
    if (!h) return;
    let left, top, w, h2;

    if (key === 'inner') {
      left = innerR.left - guiR.left;
      top  = innerR.top  - guiR.top;
      w = _FL.inner.w; h2 = _FL.inner.h;
    } else if (key === 'itemSize') {
      const sz = _FL.itemSize;
      left = _FL.slotInput.x; top = _FL.slotInput.y;
      w = sz; h2 = sz;
    } else if (key === 'invOrigin') {
      left = _FL.inv.x; top = _FL.inv.y; w = 18; h2 = 18;
    } else if (key === 'hotbarOrigin') {
      left = _FL.hotbar.x; top = _FL.hotbar.y; w = 18; h2 = 18;
    } else {
      left = _FL[key].x; top = _FL[key].y;
      w = (_FL[key].w != null ? _FL[key].w : _FL.itemSize);
      h2 = (_FL[key].h != null ? _FL[key].h : _FL.itemSize);
    }
    Object.assign(h.el.style, { left: left+'px', top: top+'px', width: w+'px', height: h2+'px' });

    if (canResize && h.resizeEl) {
      Object.assign(h.resizeEl.style, {
        left: (left + w - 6) + 'px', top: (top + h2 - 6) + 'px',
      });
    }

    // 同步 inner 专属拖拽标签（定位到内层 GUI 左上角正上方）
    if (key === 'inner' && h.tabEl) {
      const tabH = 22;
      Object.assign(h.tabEl.style, {
        left: left + 'px',
        top:  (top - tabH) + 'px',
      });
    }
  });
  _fldUpdatePanel();
}

function _fldUpdatePanel() {
  if (!_fldPanel) return;
  const lines = Object.entries(_FL).map(([k, r]) => {
    if (typeof r === 'number') return `  ${k.padEnd(11)}: ${r}`;
    const parts = [];
    if (r.x      != null) parts.push(`x:${String(r.x).padStart(4)}`);
    if (r.y      != null) parts.push(`y:${String(r.y).padStart(4)}`);
    if (r.w      != null) parts.push(`w:${String(r.w).padStart(4)}`);
    if (r.h      != null) parts.push(`h:${String(r.h).padStart(4)}`);
    if (r.colGap != null) parts.push(`colGap:${r.colGap}`);
    if (r.rowGap != null) parts.push(`rowGap:${r.rowGap}`);
    return `  ${k.padEnd(11)}: { ${parts.join(', ')} }`;
  });
  _fldPanel.querySelector('#fld-vals').textContent = '{\n' + lines.join(',\n') + '\n}';
  // 同步 gap 显示数字
  const icg = _fldPanel.querySelector('#fld-icg');  if (icg) icg.textContent = _FL.inv.colGap;
  const irg = _fldPanel.querySelector('#fld-irg');  if (irg) irg.textContent = _FL.inv.rowGap;
  const hcg = _fldPanel.querySelector('#fld-hcg');  if (hcg) hcg.textContent = _FL.hotbar.colGap;
}

// 启动布局调试（furnaceUIOpen 时调用）
function _startFurnaceLayoutDebug() {
  _initDom();
  const gui   = _gui;
  const inner = document.getElementById('furnace-gui-inner');
  if (!gui || !inner) return;
  if (_fldPanel) { _syncDebugHandles(); return; } // 已初始化

  // ── 参数面板 ──────────────────────────────────────────────────────────
  _fldPanel = document.createElement('div');
  _fldPanel.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:99999',
    'background:rgba(0,0,0,0.88)', 'color:#ddd', 'padding:10px 12px',
    'font:12px/1.5 monospace', 'border:1px solid #555', 'border-radius:6px',
    'pointer-events:all', 'user-select:none', 'min-width:340px',
  ].join(';');
  const _btnStyle = 'background:#333;color:#fff;border:1px solid #555;padding:1px 6px;border-radius:3px;cursor:pointer;font:bold 11px monospace;line-height:1.4';
  _fldPanel.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px;color:#4af">
      🔧 熔炉布局编辑器
      <span style="font-size:10px;color:#888;margin-left:8px">拖动移动 · 右下角拖动缩放</span>
    </div>
    <pre id="fld-vals" style="margin:0 0 8px;font-size:11px;color:#af8;background:rgba(255,255,255,0.05);padding:6px;border-radius:3px;overflow:auto;max-height:180px"></pre>
    <div style="margin-bottom:6px;font-size:11px;color:#0fa;border-top:1px solid #333;padding-top:6px">
      背包/快捷栏间距（拖绿/橙↖调整整体位置）
    </div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 8px;font-size:11px;margin-bottom:6px;align-items:center">
      <span style="color:#0fa">背包列间距</span>
      <span><button id="fld-icg-m" style="${_btnStyle}">−</button>
            <span id="fld-icg" style="display:inline-block;min-width:28px;text-align:center">54</span>
            <button id="fld-icg-p" style="${_btnStyle}">+</button></span>
      <span style="color:#0fa">背包行间距</span>
      <span><button id="fld-irg-m" style="${_btnStyle}">−</button>
            <span id="fld-irg" style="display:inline-block;min-width:28px;text-align:center">54</span>
            <button id="fld-irg-p" style="${_btnStyle}">+</button></span>
      <span style="color:#fa0">快捷栏列间距</span>
      <span><button id="fld-hcg-m" style="${_btnStyle}">−</button>
            <span id="fld-hcg" style="display:inline-block;min-width:28px;text-align:center">54</span>
            <button id="fld-hcg-p" style="${_btnStyle}">+</button></span>
    </div>
    <div style="display:flex;gap:6px">
      <button id="fld-copy" style="flex:1;background:#4af;color:#000;border:none;padding:4px 8px;border-radius:3px;cursor:pointer;font:bold 11px monospace">复制参数</button>
      <button id="fld-close" style="background:#444;color:#fff;border:none;padding:4px 8px;border-radius:3px;cursor:pointer;font:11px monospace">关闭编辑器</button>
    </div>`;
  document.body.appendChild(_fldPanel);

  _fldPanel.querySelector('#fld-copy').onclick = () => {
    navigator.clipboard.writeText(
      'var _FL = ' + JSON.stringify(_FL, null, 2) + ';'
    ).then(() => { _fldPanel.querySelector('#fld-copy').textContent = '已复制 ✓'; setTimeout(() => { _fldPanel.querySelector('#fld-copy').textContent = '复制参数'; }, 1500); });
  };
  _fldPanel.querySelector('#fld-close').onclick = () => {
    if (_fldPanel) { _fldPanel.remove(); _fldPanel = null; }
    const innerEl = document.getElementById('furnace-gui-inner');
    if (innerEl) innerEl.style.zIndex = '';
    Object.values(_fldHandles).forEach(h => {
      h.el.remove();
      if (h.resizeEl) h.resizeEl.remove();
      if (h.tabEl) h.tabEl.remove();
    });
    _fldHandles = {};
    window.removeEventListener('mousemove', _fldOnMove, true);
    window.removeEventListener('mouseup',   _fldOnUp,   true);
  };

  // ── Gap 按钮事件 ─────────────────────────────────────────────────────
  const _gapBtn = (id, fn) => {
    const btn = _fldPanel.querySelector(id);
    if (btn) btn.onclick = (e) => { e.stopPropagation(); fn(); _applyFurnaceLayout(); };
  };
  _gapBtn('#fld-icg-m', () => _FL.inv.colGap    = Math.max(1, _FL.inv.colGap    - 1));
  _gapBtn('#fld-icg-p', () => _FL.inv.colGap    = _FL.inv.colGap    + 1);
  _gapBtn('#fld-irg-m', () => _FL.inv.rowGap    = Math.max(1, _FL.inv.rowGap    - 1));
  _gapBtn('#fld-irg-p', () => _FL.inv.rowGap    = _FL.inv.rowGap    + 1);
  _gapBtn('#fld-hcg-m', () => _FL.hotbar.colGap = Math.max(1, _FL.hotbar.colGap - 1));
  _gapBtn('#fld-hcg-p', () => _FL.hotbar.colGap = _FL.hotbar.colGap + 1);

  // 让 inner 层的 z-index 高于 inner 的整体句柄，使槽位句柄可接收点击
  inner.style.zIndex = '99991';

  // ── 拖拽句柄 ──────────────────────────────────────────────────────────
  _FLD_ITEMS.forEach(({ key, label, color, canResize, parent, flPath }) => {
    const container = parent === 'gui' ? gui : inner;

    // 移动句柄（透明蒙版 + 彩色边框）
    const hEl = document.createElement('div');
    hEl.title = label;
    hEl.style.cssText = [
      'position:absolute', `outline:2px dashed ${color}`,
      'box-sizing:border-box',
      // inner 整体句柄仅做视觉框，交互由专属拖拽标签负责
      key === 'inner' ? 'pointer-events:none;cursor:default' : 'pointer-events:all;cursor:move',
      'z-index:99990',
    ].join(';');

    // 标签（仅非 inner 元素显示，inner 有专属拖拽标签）
    if (key !== 'inner') {
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `position:absolute;top:2px;left:4px;font:bold 10px monospace;color:${color};pointer-events:none;white-space:nowrap;text-shadow:0 0 3px #000`;
      hEl.appendChild(lbl);

      hEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        const flTarget = flPath ? _FL[flPath] : _FL[key];
        _fldDrag = {
          key, mode: 'move', flPath: flPath || null,
          startX: e.clientX, startY: e.clientY,
          origX: flTarget.x, origY: flTarget.y,
        };
      });
    }
    container.appendChild(hEl);

    // 缩放句柄（右下角小方块）
    let rEl = null;
    if (canResize) {
      rEl = document.createElement('div');
      rEl.style.cssText = [
        'position:absolute', `background:${color}`, 'width:12px', 'height:12px',
        'cursor:se-resize', 'z-index:99992', 'pointer-events:all', 'border-radius:2px',
      ].join(';');
      rEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        _fldDrag = {
          key, mode: 'resize',
          startX: e.clientX, startY: e.clientY,
          origW: key === 'itemSize' ? _FL.itemSize : _FL[key].w,
          origH: key === 'itemSize' ? _FL.itemSize : _FL[key].h,
        };
      });
      container.appendChild(rEl);
    }

    // inner 专属拖拽标签（定位在内层 GUI 左上角外侧，不遮挡内容）
    let tabEl = null;
    if (key === 'inner') {
      tabEl = document.createElement('div');
      tabEl.textContent = '⠿ ' + label;
      tabEl.style.cssText = [
        'position:absolute', `background:rgba(30,120,255,0.9)`,
        'color:#fff', 'font:bold 11px monospace', 'padding:2px 10px',
        'cursor:move', 'z-index:99992', 'pointer-events:all',
        'border-radius:4px 4px 0 0', 'white-space:nowrap',
        'box-shadow:0 2px 6px rgba(0,0,0,0.5)',
        'user-select:none',
      ].join(';');
      tabEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        _fldDrag = {
          key: 'inner', mode: 'move',
          startX: e.clientX, startY: e.clientY,
          origX: _FL.inner.x, origY: _FL.inner.y,
        };
      });
      gui.appendChild(tabEl);
    }

    _fldHandles[key] = { el: hEl, resizeEl: rEl, tabEl };
  });

  // 全局 mousemove / mouseup（捕获阶段防止丢失）
  window.addEventListener('mousemove', _fldOnMove, true);
  window.addEventListener('mouseup',   _fldOnUp,   true);

  _applyFurnaceLayout();
}

function _fldOnMove(e) {
  if (!_fldDrag) return;
  const { key, mode, startX, startY, origX, origY, origW, origH } = _fldDrag;
  const dx = e.clientX - startX, dy = e.clientY - startY;
  if (mode === 'move') {
    if (key === 'itemSize') {
      // itemSize 没有位置，不允许移动
    } else {
      const flTarget = _fldDrag.flPath ? _FL[_fldDrag.flPath] : _FL[key];
      flTarget.x = Math.round(origX + dx);
      flTarget.y = Math.round(origY + dy);
    }
  } else { // resize
    if (key === 'itemSize') {
      // 拖横轴控制等比尺寸，三个槽位同步
      _FL.itemSize = Math.max(16, Math.round(origW + dx));
    } else {
      _FL[key].w = Math.max(10, Math.round(origW + dx));
      _FL[key].h = Math.max(10, Math.round(origH + dy));
    }
  }
  _applyFurnaceLayout();
}

function _fldOnUp() { _fldDrag = null; }
