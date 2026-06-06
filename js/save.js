// save.js — 统一 localStorage 存档管理
// 所有 key 定义、序列化/反序列化逻辑集中在此文件
// 其他模块只调用 saveFurnace() / loadFurnace() / saveNav() / loadNav()

// ── Key 常量 ────────────────────────────────────────────────────────────────
var SAVE_KEY_FURNACE = 'furnaceState';
var SAVE_KEY_NAV     = 'mc_mp_nav';

// ── 旧版 key（兼容清理用）───────────────────────────────────────────────────
var SAVE_KEY_LEGACY  = ['furnaceDecay'];

// ── 工具 ────────────────────────────────────────────────────────────────────
function _saveCleanLegacy() {
  SAVE_KEY_LEGACY.forEach(k => {
    try { localStorage.removeItem(k); } catch {}
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 熔炉存档
// ════════════════════════════════════════════════════════════════════════════

/**
 * 保存当前熔炉状态到 localStorage
 * 依赖全局变量：_furnaceLevelAnchorValue, _furnaceLevelAnchorTs,
 *              furnaceLevelDecayRate, fuelQueue,
 *              _smeltStartTs, _smeltIsActive,
 *              furnaceInputSlot, furnaceFuelSlot, furnaceOutputSlot
 *
 * 注意：存的是"锚点时间戳"而非计算后的当前值，
 *       这样即使 WE 暂停或页面关闭，下次加载时可从真实系统时间推算进度。
 */
function saveFurnace() {
  try {
    localStorage.setItem(SAVE_KEY_FURNACE, JSON.stringify({
      // furnaceLevel 锚点（恢复时由 anchorValue - decayRate*(now-anchorTs)/1000 算出）
      furnaceLevelAnchorValue : _furnaceLevelAnchorValue,
      furnaceLevelAnchorTs    : _furnaceLevelAnchorTs,
      furnaceLevelDecayRate   : furnaceLevelDecayRate,
      fuelQueue               : fuelQueue,
      // smelt 锚点（恢复时 smeltProgress = (now - smeltStartTs)/1000 % SMELT_DURATION）
      smeltStartTs            : _smeltStartTs,
      smeltIsActive           : _smeltIsActive,
      inputSlot               : furnaceInputSlot,
      fuelSlot                : furnaceFuelSlot,
      outputSlot              : furnaceOutputSlot,
      ts                      : Date.now(),
    }));
  } catch {}
}
window.saveFurnace = saveFurnace;

/**
 * 从 localStorage 读取熔炉存档，返回原始对象（调用方负责应用到全局变量）
 * 旧格式（fuelSeconds / 旧 dt-based 格式）自动清除并返回 null
 *
 * @returns {{ furnaceLevelAnchorValue, furnaceLevelAnchorTs, furnaceLevelDecayRate,
 *             fuelQueue, smeltStartTs, smeltIsActive,
 *             inputSlot, fuelSlot, outputSlot, ts } | null}
 */
function loadFurnace() {
  _saveCleanLegacy();
  try {
    const raw = localStorage.getItem(SAVE_KEY_FURNACE);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // 旧格式：有 fuelSeconds 但无 furnaceLevelAnchorTs → 丢弃
    if (s.fuelSeconds !== undefined && s.furnaceLevelAnchorTs === undefined) {
      localStorage.removeItem(SAVE_KEY_FURNACE);
      return null;
    }
    // 旧格式：有 furnaceLevel/smeltProgress 但无锚点 → 向前兼容迁移
    if (s.furnaceLevel !== undefined && s.furnaceLevelAnchorTs === undefined) {
      // 用旧 ts 推算锚点（近似）
      const elapsed = Math.max(0, (Date.now() - (s.ts || Date.now())) / 1000);
      const decayRate = s.furnaceLevelDecayRate || 0;
      const currentLevel = Math.max(0, (s.furnaceLevel || 0) - decayRate * elapsed);
      s.furnaceLevelAnchorValue = currentLevel;
      s.furnaceLevelAnchorTs    = Date.now();
      s.furnaceLevelDecayRate   = currentLevel > 0 ? decayRate : 0;
      s.smeltStartTs  = s.smeltProgress
        ? Date.now() - Math.round(s.smeltProgress * 1000)
        : 0;
      s.smeltIsActive = false; // 保守起见标记为未激活，tickFurnace 会自动重启
    }
    return s;
  } catch { return null; }
}
window.loadFurnace = loadFurnace;

// ════════════════════════════════════════════════════════════════════════════
// 背包存档
// ════════════════════════════════════════════════════════════════════════════

var SAVE_KEY_INV = 'mc_player_inv';

/**
 * 保存玩家背包 + 快捷栏到 localStorage
 * 依赖全局变量：inventoryData[27], hotbarData[9]
 */
function saveInventory() {
  try {
    localStorage.setItem(SAVE_KEY_INV, JSON.stringify({
      inv:    inventoryData,
      hotbar: hotbarData,
    }));
  } catch {}
}
window.saveInventory = saveInventory;

/**
 * 从 localStorage 读取背包存档并应用到全局变量
 */
function loadInventory() {
  try {
    const raw = localStorage.getItem(SAVE_KEY_INV);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Array.isArray(s.inv)    && s.inv.length    === 27) inventoryData = s.inv;
    if (Array.isArray(s.hotbar) && s.hotbar.length === 9)  hotbarData    = s.hotbar;
  } catch {}
}
window.loadInventory = loadInventory;

// ════════════════════════════════════════════════════════════════════════════
// 音乐播放器导航存档
// ════════════════════════════════════════════════════════════════════════════

/**
 * 保存音乐播放器当前导航位置
 * @param {string[]} path   文件夹 label 路径数组
 * @param {number}   offset 视口起始索引
 */
function saveNav(path, offset) {
  try {
    localStorage.setItem(SAVE_KEY_NAV, JSON.stringify({ path: path, offset: offset }));
  } catch {}
}
window.saveNav = saveNav;

/**
 * 读取音乐播放器导航存档
 * @returns {{ path: string[], offset: number } | null}
 */
function loadNav() {
  try {
    const raw = localStorage.getItem(SAVE_KEY_NAV);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
window.loadNav = loadNav;
