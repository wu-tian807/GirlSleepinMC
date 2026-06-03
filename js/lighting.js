// lighting.js — darkness overlay, furnace glow, torch glow, fire slider

    // ─── title 旋转感知命中检测 ───────────────────────────────────────────
    // 根本原因：wb-bob 动画有旋转，BoundingClientRect 是轴对齐包围盒（比实际元素大）
    // 修复：从 computedStyle 提取旋转角，计算实际旋转矩形的 4 个顶点，做凸多边形检测

    // debug：在全屏 canvas 上画出实际命中多边形（绿框）
    var DEBUG_TITLE_HIT = false;
    let _dbgPolyCanvas = null;

    function _titleDebugPolyDraw(pts) {
      if (!DEBUG_TITLE_HIT) {
        if (_dbgPolyCanvas) _dbgPolyCanvas.style.display = 'none';
        return;
      }
      if (!_dbgPolyCanvas) {
        _dbgPolyCanvas = document.createElement('canvas');
        _dbgPolyCanvas.style.cssText =
          'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
        document.body.appendChild(_dbgPolyCanvas);
      }
      _dbgPolyCanvas.style.display = '';
      _dbgPolyCanvas.width  = window.innerWidth;
      _dbgPolyCanvas.height = window.innerHeight;
      const c = _dbgPolyCanvas.getContext('2d');
      c.clearRect(0, 0, _dbgPolyCanvas.width, _dbgPolyCanvas.height);
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      c.fillStyle   = 'rgba(0,255,80,0.12)';
      c.strokeStyle = 'rgba(0,255,80,0.85)';
      c.lineWidth   = 2;
      c.fill();
      c.stroke();
      // 画 BoundingRect 对比（红框）
      const el = document.getElementById('wb-title');
      if (el) {
        const r = el.getBoundingClientRect();
        c.strokeStyle = 'rgba(255,60,60,0.6)';
        c.lineWidth   = 1;
        c.setLineDash([4, 4]);
        c.strokeRect(r.left, r.top, r.width, r.height);
        c.setLineDash([]);
      }
    }

    // 计算旋转矩形 4 顶点（屏幕坐标）并做凸多边形点检测
    function _titleConvexHit(titleEl, mx, my) {
      const rect = titleEl.getBoundingClientRect();
      // 快速外矩形排除
      if (mx < rect.left || mx > rect.right || my < rect.top || my > rect.bottom) {
        if (DEBUG_TITLE_HIT) _titleDebugPolyDraw(_titleCorners(titleEl, rect));
        return false;
      }

      const pts = _titleCorners(titleEl, rect);
      if (DEBUG_TITLE_HIT) _titleDebugPolyDraw(pts);

      // 凸多边形检测（与 video.js _inConvexPoly 相同逻辑）
      let winding = null;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const cross = (bx - ax) * (my - ay) - (by - ay) * (mx - ax);
        if (winding === null) winding = cross >= 0;
        else if ((cross >= 0) !== winding) return false;
      }
      return true;
    }

    // 提取 CSS transform 旋转角，然后用 BoundingRect 反推原始矩形半宽/半高
    // （比用 offsetWidth/offsetHeight 更可靠，始终与实际渲染匹配）
    function _titleCorners(titleEl, rect) {
      const cx = (rect.left + rect.right)  / 2;
      const cy = (rect.top  + rect.bottom) / 2;

      // 从 computed transform 提取旋转
      let cosA = 1, sinA = 0;
      try {
        const m   = new DOMMatrix(window.getComputedStyle(titleEl).transform);
        const len = Math.sqrt(m.a * m.a + m.b * m.b);
        if (len > 0) { cosA = m.a / len; sinA = m.b / len; }
      } catch (_) {}

      // 用 BBox 和旋转角反推原始矩形半宽 hw、半高 hh：
      //   bboxW = 2hw * |cosA| + 2hh * |sinA|
      //   bboxH = 2hw * |sinA| + 2hh * |cosA|
      // 解线性方程组（cos²A - sin²A = cos(2A) ≠ 0 时有唯一解）
      const bboxW = rect.width, bboxH = rect.height;
      const absC  = Math.abs(cosA), absS = Math.abs(sinA);
      let hw, hh;
      const det = absC * absC - absS * absS; // cos(2θ)
      if (Math.abs(det) > 0.01) {
        hw = (bboxW * absC - bboxH * absS) / (2 * det);
        hh = (bboxH * absC - bboxW * absS) / (2 * det);
      } else {
        // θ ≈ 45°：近似退化，用 offsetWidth/Height 兜底
        hw = titleEl.offsetWidth  / 2;
        hh = titleEl.offsetHeight / 2;
      }
      // 防止负值（极端退化时）
      hw = Math.max(hw, 1); hh = Math.max(hh, 1);

      const rot = (lx, ly) => [cx + lx*cosA - ly*sinA, cy + lx*sinA + ly*cosA];
      return [rot(-hw,-hh), rot(hw,-hh), rot(hw,hh), rot(-hw,hh)];
    }

    // 每帧刷新 debug 多边形（title 有浮动动画）
    (function _titleDebugLoop() {
      if (DEBUG_TITLE_HIT) {
        const el = document.getElementById('wb-title');
        if (el) _titleDebugPolyDraw(_titleCorners(el, el.getBoundingClientRect()));
      }
      requestAnimationFrame(_titleDebugLoop);
    })();

    // ─── 光照 & 火力 ─────────────────────────────────────────────────
    const darknessCanvas = document.getElementById('darkness-canvas');
    const dCtx            = darknessCanvas.getContext('2d');

    // 三点锚定指数映射：furnace 0→-104，50→-64，100→0
    // 解：x=exp(B/2)=64/40=1.6，B=2ln(1.6)，A=104/(e^B-1)，C=-A*e^B
    const _LB = 2 * Math.log(64 / 40);
    const _LA = 104 / (Math.exp(_LB) - 1);
    const _LC = -_LA * Math.exp(_LB);
    function furnaceToLight(fl) {
      return Math.round(_LA * Math.exp(_LB * fl / 100) + _LC);
    }

    // ─── 熔炉火力轴 ──────────────────────────────────────────────────
    const furnaceSlider = document.getElementById('furnace-slider');
    const furnaceValEl  = document.getElementById('furnace-val');

    furnaceSlider.addEventListener('input', () => {
      furnaceLevel = parseInt(furnaceSlider.value, 10);
      furnaceValEl.textContent = furnaceLevel;
      lightLevel = furnaceToLight(furnaceLevel);
      if (userUnmuted) _setCrackleVol();
      // 手动调节后立刻保存，作为新的衰减起点
      _furnaceDecaySave();
    });

    // ─── 熔炉自然衰减（指数衰减，24h 从 100 → ~1）────────────────────
    // λ = ln(100) / 86400 ≈ 5.33e-5 /s
    // f(t) = f0 · e^(−λ·t)，越低衰减越慢（指数曲线天然特性）
    const _DECAY_λ = Math.log(100) / (24 * 3600);

    function _furnaceDecaySave() {
      try {
        localStorage.setItem('furnaceDecay', JSON.stringify({
          level: furnaceLevel,
          ts   : Date.now(),
        }));
      } catch {}
    }

    // 页面加载时恢复并补算离线衰减
    (() => {
      try {
        const raw = localStorage.getItem('furnaceDecay');
        if (!raw) return;
        const { level, ts } = JSON.parse(raw);
        const elapsed = Math.max(0, (Date.now() - ts) / 1000);
        furnaceLevel = Math.max(0, level * Math.exp(-_DECAY_λ * elapsed));
        lightLevel   = furnaceToLight(furnaceLevel);
        furnaceSlider.value      = Math.round(furnaceLevel);
        furnaceValEl.textContent = Math.round(furnaceLevel);
      } catch {}
    })();

    // 每帧调用（由 main.js animateFlame 驱动）
    let _decayLastT  = performance.now();
    let _decaySaveTs = Date.now();
    function updateFurnaceDecay() {
      const now = performance.now();
      const dt  = (now - _decayLastT) / 1000;   // 秒
      _decayLastT = now;

      if (furnaceLevel <= 0) return;

      furnaceLevel = furnaceLevel * Math.exp(-_DECAY_λ * dt);
      if (furnaceLevel < 0.5) furnaceLevel = 0;   // 阈值截断，确保最终归零
      lightLevel   = furnaceToLight(furnaceLevel);

      // 更新 slider UI（整数显示，不驱动 input 事件）
      const rounded = Math.round(furnaceLevel);
      furnaceSlider.value      = rounded;
      furnaceValEl.textContent = rounded;

      // 音量随衰减平滑调整
      if (userUnmuted) _setCrackleVol();

      // 每 10s 持久化一次
      const nowMs = Date.now();
      if (nowMs - _decaySaveTs >= 10000) {
        _decaySaveTs = nowMs;
        _furnaceDecaySave();
      }
    }
    window.updateFurnaceDecay = updateFurnaceDecay;

    // 初始同步
    lightLevel = furnaceToLight(furnaceLevel);

    function drawDarkness(mx, my, level) {
      // 同步 canvas 尺寸
      if (darknessCanvas.width  !== window.innerWidth ||
          darknessCanvas.height !== window.innerHeight) {
        darknessCanvas.width  = window.innerWidth;
        darknessCanvas.height = window.innerHeight;
      }
      const w = darknessCanvas.width, h = darknessCanvas.height;
      dCtx.clearRect(0, 0, w, h);

      if (level < 0) {
        // ── 暗模式：先填满黑色遮罩，再切洞 ──
        const alpha = (-level / 100) * 0.92;   // 最暗 92% 不透明
        dCtx.globalCompositeOperation = 'source-over';
        dCtx.fillStyle = `rgba(0,0,0,${alpha})`;
        dCtx.fillRect(0, 0, w, h);

        // 切洞工具：destination-out 擦除遮罩
        dCtx.globalCompositeOperation = 'destination-out';

        // ① 鼠标火把照明（随距离越暗越大）
        if (mx >= 0) {
          const torchR = 80 + (-level / 100) * 160;  // 80~240px
          const tg = dCtx.createRadialGradient(mx, my, 0, mx, my, torchR);
          tg.addColorStop(0,    'rgba(0,0,0,1)');
          tg.addColorStop(0.45, 'rgba(0,0,0,0.85)');
          tg.addColorStop(0.75, 'rgba(0,0,0,0.3)');
          tg.addColorStop(1,    'rgba(0,0,0,0)');
          dCtx.fillStyle = tg;
          dCtx.beginPath(); dCtx.arc(mx, my, torchR, 0, Math.PI * 2); dCtx.fill();
        }

        // ② 熔炉火光（闪烁光源）—— fire=0 时彻底熄灭
        const r = getVideoRect();
        if (r && furnaceLevel > 0) {
          const t  = performance.now() / 1000;
          // 中低频叠加：慢基波 + 中频扰动，可见但不急促
          const flicker =
            Math.sin(t * 1.8)  * 0.40 +   // 主呼吸波 ~0.55s周期
            Math.sin(t * 4.3)  * 0.30 +   // 次级抖动
            Math.sin(t * 0.7)  * 0.20 +   // 超慢漂移
            Math.sin(t * 7.1)  * 0.10;    // 轻微高频点缀

          // 火力倍率：指数函数，50火力=×1不变，0火力≈×0.3，100火力≈×3.3
          const furnMult = Math.exp(2.4 * (furnaceLevel / 100 - 0.5));
          const baseR    = r.width * (0.06 + (-level / 100) * 0.10) * furnMult;
          const furnaceR = baseR * (1 + flicker * 0.22);  // 半径±22%，清晰可感

          // 中心轻微摇曳
          const fx = r.left + r.width  * ((FIRE_FX_L + FIRE_FX_R) / 2) + Math.sin(t * 1.7) * baseR * 0.05;
          const fy = r.top  + r.height * FIRE_FY                        + Math.sin(t * 1.2) * baseR * 0.03;

          // 渐变内核随闪烁变化
          const peakAlpha = 0.55 + flicker * 0.20;  // 0.35 ~ 0.75
          const fg = dCtx.createRadialGradient(fx, fy, 0, fx, fy, furnaceR);
          fg.addColorStop(0,    `rgba(0,0,0,${Math.min(1, peakAlpha + 0.45)})`);
          fg.addColorStop(0.4,  `rgba(0,0,0,${Math.min(1, peakAlpha)})`);
          fg.addColorStop(0.75, 'rgba(0,0,0,0.15)');
          fg.addColorStop(1,    'rgba(0,0,0,0)');
          dCtx.fillStyle = fg;
          dCtx.beginPath(); dCtx.arc(fx, fy, furnaceR, 0, Math.PI * 2); dCtx.fill();
        }

        dCtx.globalCompositeOperation = 'source-over';

      } else if (level > 0) {
        // ── 亮模式：叠加暖白光覆盖 ──
        const brightness = (level / 100) * 0.30;
        dCtx.globalCompositeOperation = 'source-over';
        dCtx.fillStyle = `rgba(255, 230, 180, ${brightness})`;
        dCtx.fillRect(0, 0, w, h);
      }
      // level === 0：clearRect 已清空，无操作
    }

    // ─── 鼠标位置追踪（mouseX/mouseY 声明在 shared.js）────────────
    window.addEventListener('mousemove', (e) => {
      mouseX = e.clientX; mouseY = e.clientY;

      // 拖动熔炉角点（优先）
      if (DEBUG_FURNACE_DRAG && _furnaceDrag.idx >= 0 && FURNACE_CORNERS) {
        const r = getVideoRect();
        if (r) {
          FURNACE_CORNERS[_furnaceDrag.idx] = [
            Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
          ];
        }
        document.body.style.cursor = 'grabbing';
        return;
      }

      // 拖动工作台角点（编辑器模式）
      if (DEBUG_WB_DRAG && _wbDragIdx >= 0 && _wbFreeCorners) {
        const r = getVideoRect();
        if (r) {
          _wbFreeCorners[_wbDragIdx] = [
            (e.clientX - r.left) / r.width,
            (e.clientY - r.top)  / r.height,
          ];
        }
        document.body.style.cursor = 'grabbing';
        return;
      }

      // 拖动箱子角点（编辑器模式）
      if (DEBUG_CHEST_DRAG && _chestDrag.idx >= 0 && CHEST_CORNERS) {
        const r = getVideoRect();
        if (r) {
          CHEST_CORNERS[_chestDrag.idx] = [
            Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
          ];
        }
        document.body.style.cursor = 'grabbing';
        return;
      }

      // title 优先：先过矩形，再做像素 alpha 采样，精准排除透明区域
      const _titleEl = document.getElementById('wb-title');
      const overTitle = !_wbExpanded && !_wbClosing && !!_titleEl
        && _titleConvexHit(_titleEl, mouseX, mouseY);

      if (overTitle) {
        _titleHovered   = true;
        _wbHovered      = false;
        _furnaceHovered = false;
        _chestHovered   = false;
      } else {
        _titleHovered   = false;
        _wbHovered      = isInWorkbench(mouseX, mouseY);
        _furnaceHovered = !_wbHovered && _isInFurnace(mouseX, mouseY);
        _chestHovered   = !_wbHovered && !_furnaceHovered && _isInChest(mouseX, mouseY);
      }
      document.body.style.cursor =
        (_wbHovered || overTitle || _furnaceHovered || _chestHovered) ? 'pointer' : 'crosshair';
    });

    window.addEventListener('mousedown', (e) => {
      const r = getVideoRect(); if (!r) return;

      // 熔炉角点编辑器（优先判断）
      if (DEBUG_FURNACE_DRAG && FURNACE_CORNERS) {
        for (let i = 0; i < FURNACE_CORNERS.length; i++) {
          const [vx, vy] = FURNACE_CORNERS[i];
          const sx = r.left + vx * r.width;
          const sy = r.top  + vy * r.height;
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 14) {
            _furnaceDrag = { idx: i };
            e.preventDefault();
            return;
          }
        }
      }

      // 箱子角点编辑器
      if (DEBUG_CHEST_DRAG && CHEST_CORNERS) {
        for (let i = 0; i < CHEST_CORNERS.length; i++) {
          const [vx, vy] = CHEST_CORNERS[i];
          const sx = r.left + vx * r.width;
          const sy = r.top  + vy * r.height;
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 14) {
            _chestDrag = { idx: i };
            e.preventDefault();
            return;
          }
        }
      }

      if (!DEBUG_WB_DRAG || !_wbFreeCorners) return;
      for (let i = 0; i < 4; i++) {
        const [vx, vy] = _wbFreeCorners[i];
        const sx = r.left + vx * r.width;
        const sy = r.top  + vy * r.height;
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 16) {
          _wbDragIdx = i;
          e.preventDefault();
          return;
        }
      }
    });

    window.addEventListener('mouseup', () => {
      _wbDragIdx = -1;
      _furnaceDrag = { idx: -1 };
      _chestDrag   = { idx: -1 };
    });

    window.addEventListener('mouseleave', () => {
      mouseX = -999; mouseY = -999;
      _wbHovered = false;
      _wbDragIdx = -1;
      _furnaceDrag = { idx: -1 };
      _chestDrag   = { idx: -1 };
      document.body.style.cursor = 'crosshair';
    });

    // ─── 箱子多边形命中检测（顶面 + 正面）────────────────────────────────────
    function _isInChest(mx, my) {
      if (!CHEST_CORNERS || !CHEST_FACES) return false;
      const r = getVideoRect(); if (!r) return false;
      const toScr = ([vx, vy]) => [r.left + vx * r.width, r.top + vy * r.height];
      for (const face of CHEST_FACES) {
        if (face.idx.length < 3) continue;
        const pts = face.idx.map(i => toScr(CHEST_CORNERS[i]));
        if (typeof _inConvexPoly === 'function' && _inConvexPoly(pts, mx, my)) return true;
      }
      return false;
    }

    // ─── 箱子 debug 编辑器：每帧绘制 ─────────────────────────────────────────
    function _drawChestEditor() {
      if (!CHEST_CORNERS || !CHEST_FACES) return;
      const r = getVideoRect(); if (!r) return;
      const toScr = ([vx, vy]) => [r.left + vx * r.width, r.top + vy * r.height];
      const scr = CHEST_CORNERS.map(toScr);

      if (!DEBUG_CHEST_DRAG) {
        const hud = document.getElementById('chest-poly-hud');
        if (hud) hud.style.display = 'none';
        return;
      }

      dCtx.save();
      for (const face of CHEST_FACES) {
        const pts = face.idx.map(i => scr[i]);
        const skip = new Set(face.skipEdges || []);
        // 填充（完整多边形区域）
        dCtx.beginPath();
        dCtx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) dCtx.lineTo(pts[i][0], pts[i][1]);
        dCtx.closePath();
        dCtx.fillStyle = face.fill;
        dCtx.fill();
        // 逐边描边（跳过 skipEdges 中的边）
        dCtx.strokeStyle = face.stroke;
        dCtx.lineWidth = 2;
        for (let i = 0; i < pts.length; i++) {
          if (skip.has(i)) continue;
          const j = (i + 1) % pts.length;
          dCtx.beginPath();
          dCtx.moveTo(pts[i][0], pts[i][1]);
          dCtx.lineTo(pts[j][0], pts[j][1]);
          dCtx.stroke();
        }
      }
      scr.forEach(([sx, sy], i) => {
        const hot = _chestDrag.idx === i;
        dCtx.beginPath();
        dCtx.arc(sx, sy, hot ? 10 : 7, 0, Math.PI * 2);
        dCtx.fillStyle   = hot ? 'rgba(255,255,160,0.95)' : 'rgba(220,220,220,0.85)';
        dCtx.strokeStyle = '#333'; dCtx.lineWidth = 1.5;
        dCtx.fill(); dCtx.stroke();
        dCtx.fillStyle = '#111'; dCtx.font = 'bold 9px monospace';
        dCtx.textAlign = 'center'; dCtx.textBaseline = 'middle';
        dCtx.fillText(String(i), sx, sy);
      });
      dCtx.restore();

      let hud = document.getElementById('chest-poly-hud');
      if (!hud) {
        hud = document.createElement('pre');
        hud.id = 'chest-poly-hud';
        hud.style.cssText =
          'position:fixed;right:8px;top:180px;background:rgba(0,0,0,0.75);color:#eee;' +
          'font:11px monospace;padding:8px 10px;border-radius:5px;z-index:99999;pointer-events:none;line-height:1.5;';
        document.body.appendChild(hud);
      }
      const f = v => v.toFixed(4);
      hud.textContent =
        'CHEST_CORNERS = [\n' +
        CHEST_CORNERS.map((p, i) => `  [${f(p[0])}, ${f(p[1])}],  // ${i}`).join('\n') +
        '\n];';
      hud.style.display = '';
    }
    window._drawChestEditor = _drawChestEditor;

    // ─── 熔炉多边形命中检测（顶面 + 正面）────────────────────────────────────
    function _isInFurnace(mx, my) {
      if (!FURNACE_CORNERS || !FURNACE_FACES) return false;
      const r = getVideoRect(); if (!r) return false;
      const toScr = ([vx, vy]) => [r.left + vx * r.width, r.top + vy * r.height];
      for (const face of FURNACE_FACES) {
        if (face.idx.length < 3) continue;
        const pts = face.idx.map(i => toScr(FURNACE_CORNERS[i]));
        if (typeof _inConvexPoly === 'function' && _inConvexPoly(pts, mx, my)) return true;
      }
      return false;
    }

    // ─── 熔炉面编辑器：每帧绘制 ─────────────────────────────────────────────
    function _drawFurnaceEditor() {
      if (!FURNACE_CORNERS || !FURNACE_FACES) return;
      const r = getVideoRect(); if (!r) return;

      const toScr = ([vx, vy]) => [r.left + vx * r.width, r.top + vy * r.height];
      const scr = FURNACE_CORNERS.map(toScr);

      if (!DEBUG_FURNACE_DRAG) {
        // 隐藏 debug HUD（如果残留）
        const hud = document.getElementById('furnace-poly-hud');
        if (hud) hud.style.display = 'none';
        return;
      }

      dCtx.save();

      // 画每个面（2点=线段，3+点=多边形）
      for (const face of FURNACE_FACES) {
        const pts = face.idx.map(i => scr[i]);
        dCtx.beginPath();
        dCtx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) dCtx.lineTo(pts[i][0], pts[i][1]);
        dCtx.strokeStyle = face.stroke;
        dCtx.lineWidth   = 2;
        if (pts.length > 2 && face.fill !== 'none') {
          dCtx.closePath();
          dCtx.fillStyle = face.fill;
          dCtx.fill();
        }
        dCtx.stroke();
      }

      // 画每个角点（7个唯一点，标号 0-6）
      scr.forEach(([sx, sy], i) => {
        const hot = _furnaceDrag.idx === i;
        dCtx.beginPath();
        dCtx.arc(sx, sy, hot ? 10 : 7, 0, Math.PI * 2);
        dCtx.fillStyle   = hot ? 'rgba(255,255,160,0.95)' : 'rgba(220,220,220,0.85)';
        dCtx.strokeStyle = '#333';
        dCtx.lineWidth   = 1.5;
        dCtx.fill();
        dCtx.stroke();
        dCtx.fillStyle    = '#111';
        dCtx.font         = 'bold 9px monospace';
        dCtx.textAlign    = 'center';
        dCtx.textBaseline = 'middle';
        dCtx.fillText(String(i), sx, sy);
      });

      dCtx.restore();

      // HUD
      let hud = document.getElementById('furnace-poly-hud');
      if (!hud) {
        hud = document.createElement('pre');
        hud.id = 'furnace-poly-hud';
        hud.style.cssText =
          'position:fixed;right:8px;top:8px;background:rgba(0,0,0,0.75);color:#eee;' +
          'font:11px monospace;padding:8px 10px;border-radius:5px;z-index:99999;pointer-events:none;line-height:1.5;';
        document.body.appendChild(hud);
      }
      const f = v => v.toFixed(4);
      hud.textContent =
        'FURNACE_CORNERS = [\n' +
        FURNACE_CORNERS.map((p, i) => `  [${f(p[0])}, ${f(p[1])}],  // ${i}`).join('\n') +
        '\n];';
      hud.style.display = '';
    }
    window._drawFurnaceEditor = _drawFurnaceEditor;

    // ─── title 光照影响（每帧调用）──────────────────────────────────────
    function updateTitleLight() {
      const imgEl = document.getElementById('wb-title-img');
      if (!imgEl) return;

      // 展开态不加，由 wb-open 动画自己管
      if (_wbExpanded) { imgEl.style.filter = ''; return; }

      const t = performance.now() / 1000;
      // 与 drawDarkness 相同的闪烁公式
      const flicker =
        Math.sin(t * 1.8) * 0.40 +
        Math.sin(t * 4.3) * 0.30 +
        Math.sin(t * 0.7) * 0.20 +
        Math.sin(t * 7.1) * 0.10;

      // furnaceLevel 0→暗, 50→正常, 100→亮
      const norm   = furnaceLevel / 100;          // 0~1
      const base   = 0.60 + 0.45 * norm;          // 0.60 ~ 1.05
      const furnMult = Math.exp(2.4 * (norm - 0.5)); // 0→0.30, 50→1.0, 100→3.3
      const flickerAmt = flicker * 0.07 * Math.min(furnMult, 1.5);
      const brightness = Math.max(0.30, Math.min(1.15, base + flickerAmt));

      // 火力高时加一点暖色调
      const sepia = Math.max(0, (norm - 0.4) * 0.18);

      imgEl.style.filter = `brightness(${brightness.toFixed(3)}) sepia(${sepia.toFixed(3)})`;
    }
    window.updateTitleLight = updateTitleLight;

