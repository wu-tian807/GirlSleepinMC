// main.js — animateFlame loop, debug overlays, mouse tracking

    function drawTorchGlow(x, y) {
      if (x < 0) return;

      // 外层大光晕（暖橙，柔和）
      const outerR = 120;
      const outer = ctx.createRadialGradient(x, y, 0, x, y, outerR);
      outer.addColorStop(0,   'rgba(255, 180,  60, 0.18)');
      outer.addColorStop(0.4, 'rgba(255, 120,  20, 0.10)');
      outer.addColorStop(1,   'rgba(255,  80,   0, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = outer;
      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.fill();

      // 内核亮点（暖橙，柔化）
      const innerR = 28;
      const inner = ctx.createRadialGradient(x, y, 0, x, y, innerR);
      inner.addColorStop(0,   'rgba(255, 200, 100, 0.22)');
      inner.addColorStop(0.5, 'rgba(255, 140,  30, 0.12)');
      inner.addColorStop(1,   'rgba(255, 100,   0, 0)');
      ctx.fillStyle = inner;
      ctx.beginPath();
      ctx.arc(x, y, innerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 主循环
    // 窄屏跟 title；宽屏可填满高度；超出时等比缩小（不单独按高度反推宽度）
    function layoutWbPanel(titleEl) {
      const panel = document.getElementById('wb-panel');
      if (!panel || !titleEl) return;

      const tRect       = titleEl.getBoundingClientRect();
      const titleBottom = tRect.bottom;
      const maxH        = Math.max(0, window.innerHeight * 0.95 - titleBottom);
      const maxW        = window.innerWidth * 0.96;
      const isNarrow    = window.innerWidth < WB_NARROW_BREAKPOINT;
      const ratio       = isNarrow ? WB_PANEL_TITLE_W_RATIO_NARROW : WB_PANEL_TITLE_W_RATIO;

      let panelW = tRect.width * ratio;
      let panelH = panelW / WB_BODY_ASPECT;

      // 仅宽屏：若填满高度更宽，则放大到 wByFill
      if (!isNarrow) {
        const wByFill = maxH * WB_BODY_ASPECT;
        if (wByFill > panelW) {
          panelW = Math.min(wByFill, maxW);
          panelH = panelW / WB_BODY_ASPECT;
        }
      }

      // 等比 fit，避免 height 分支把宽度撑大
      const scale = Math.min(1, maxH / panelH, maxW / panelW);
      panelW *= scale;
      panelH *= scale;

      _panelW = panelW;
      _panelH = panelH;
      _panelL = (window.innerWidth - _panelW) / 2;

      panel.style.transition = 'none';
      panel.style.width      = _panelW + 'px';
      panel.style.height     = _panelH + 'px';
      panel.style.left       = _panelL + 'px';
      panel.style.top        = titleBottom + 'px';
      panel.style.transform  = 'none';
    }

    function animateFlame() {
      // 无论如何都续接下一帧，try/catch 防止单帧错误中断循环
      requestAnimationFrame(animateFlame);
      try {
      // 同步 canvas 尺寸
      if (canvas.width  !== window.innerWidth  ||
          canvas.height !== window.innerHeight) {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (typeof updateFurnaceDecay === 'function') updateFurnaceDecay();
      drawDarkness(mouseX, mouseY, lightLevel);
      if (typeof _drawFurnaceEditor === 'function') _drawFurnaceEditor();
      if (typeof _drawChestEditor   === 'function') _drawChestEditor();
      drawTorchGlow(mouseX, mouseY);
      if (typeof updateTitleLight === 'function') updateTitleLight();

      // 动态调整粒子池大小（fire 轴联动）
      const targetCount = furnaceLevel === 0 ? 0
        : Math.max(1, Math.round(Math.pow(furnaceLevel / 100, 2.6) * PARTICLE_MAX));
      while (particles.length < targetCount) particles.push(new Particle());
      while (particles.length > targetCount) particles.pop();

      particles.forEach(p => { p.update(); p.draw(); });

      // ── 熔炉开口列遮罩（编辑 or 正式）──
      const _mr = getVideoRect();
      if (_mr) {
        if (FURNACE_EDITOR) {
          drawFurnaceMaskEditor(_mr);
        } else {
          drawFurnaceMask(_mr);
        }
      }

      // ── 调试：基线 + 拱形轮廓（DEBUG_LINE = true 时可见）──
      if (DEBUG_LINE) {
        const r    = getVideoRect();
        const rad  = FIRE_ANGLE * Math.PI / 180;
        const lx   = r.left + r.width  * FIRE_FX_L;
        const ly   = r.top  + r.height * FIRE_FY;
        const len  = r.width * (FIRE_FX_R - FIRE_FX_L);
        const dirX = Math.cos(rad);
        const dirY = Math.sin(rad);
        const normX = Math.sin(rad);
        const normY = -Math.cos(rad);
        const rx   = lx + len * dirX;
        const ry   = ly + len * dirY;

        const STEPS = 40;

        ctx.save();

        // 填充拱形区域（半透明橙）
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        for (let i = 0; i <= STEPS; i++) {
          const t = i / STEPS;
          const maxPerp = r.width * ARCH_HEIGHT * Math.sin(t * Math.PI);
          const bx = lx + t * len * dirX + maxPerp * normX;
          const by = ly + t * len * dirY + maxPerp * normY;
          ctx.lineTo(bx, by);
        }
        ctx.lineTo(rx, ry);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,120,0,0.18)';
        ctx.fill();

        // 拱形边框（橙色虚线）
        ctx.strokeStyle = 'rgba(255,160,0,0.9)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        for (let i = 0; i <= STEPS; i++) {
          const t = i / STEPS;
          const maxPerp = r.width * ARCH_HEIGHT * Math.sin(t * Math.PI);
          ctx.lineTo(
            lx + t * len * dirX + maxPerp * normX,
            ly + t * len * dirY + maxPerp * normY
          );
        }
        ctx.lineTo(rx, ry);
        ctx.stroke();

        // 底边基线（青色）
        ctx.strokeStyle = 'rgba(0,255,255,0.8)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(lx, ly); ctx.lineTo(rx, ry);
        ctx.stroke();

        // 端点
        ctx.setLineDash([]);
        ctx.fillStyle = '#0ff';
        ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff0';
        ctx.beginPath(); ctx.arc(rx, ry, 4, 0, Math.PI * 2); ctx.fill();

        ctx.restore();
      }

      // ── 调试：头部可点击区域 ──────────────────────────────────────
      if (DEBUG_HEAD) {
        const r = getVideoRect();
        if (r) {
          const hx = r.left + r.width  * HEAD_CX;
          const hy = r.top  + r.height * HEAD_CY;
          const hr = r.width * HEAD_R;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,0,255,0.8)';
          ctx.lineWidth   = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle   = 'rgba(255,0,255,0.15)';
          ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }

      // ── 调试：工作台可点击区（旋转+剪切平行四边形）─────────────
      if (DEBUG_WB) {
        const r = getVideoRect();
        if (r) {
          const w   = r.width  * WB_W;
          const h   = r.height * WB_H;
          const sh  = r.width  * WB_SHEAR;
          const rad = WB_ANGLE * Math.PI / 180;
          const wcx = r.left + r.width  * WB_CX;
          const wcy = r.top  + r.height * WB_CY;

          // 局部坐标四顶点（中心为原点）：左下、右下、右上、左上
          // 左侧顶点向左延伸 WB_LEFT_EXT
          const ext = r.width * WB_LEFT_EXT;
          const locals = [
            [-w/2 - ext,      h/2],
            [ w/2,            h/2],
            [ w/2 + sh,      -h/2],
            [-w/2 - ext + sh, -h/2],
          ];
          // 旋转回世界坐标
          const pts = locals.map(([lx, ly]) => [
            wcx + lx * Math.cos(rad) - ly * Math.sin(rad),
            wcy + lx * Math.sin(rad) + ly * Math.cos(rad),
          ]);

          ctx.save();
          ctx.strokeStyle = 'rgba(0,255,100,0.9)';
          ctx.lineWidth   = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = 'rgba(0,255,100,0.08)';
          ctx.fill();
          // 中心十字
          ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(0,255,100,0.7)';
          ctx.lineWidth   = 1.5;
          ctx.beginPath();
          ctx.moveTo(wcx - 10, wcy); ctx.lineTo(wcx + 10, wcy);
          ctx.moveTo(wcx, wcy - 10); ctx.lineTo(wcx, wcy + 10);
          ctx.stroke();
          // 标签（显示在左上顶点上方）
          ctx.fillStyle = 'rgba(0,255,100,0.9)';
          ctx.font      = '11px "Courier New", monospace';
          ctx.fillText(
            `WB  cx=${WB_CX.toFixed(2)} cy=${WB_CY.toFixed(2)} angle=${WB_ANGLE}° shear=${WB_SHEAR.toFixed(3)}`,
            pts[3][0], pts[3][1] - 5
          );
          ctx.restore();
        }
      }

      // ── 工作台：hover 高光 + 拖拽编辑器 + title 定位 ────────────
      const _wbr = getVideoRect();
      if (_wbr && _wbFreeCorners) {
        // 直接由自由角点转屏幕坐标：[BL, BR, TR, TL]
        const worldPts = _wbFreeCorners.map(([vx, vy]) => [
          _wbr.left + vx * _wbr.width,
          _wbr.top  + vy * _wbr.height,
        ]);
        const [BL, BR, TR, TL] = worldPts;

        // ── 角点拖拽编辑器（DEBUG_WB_DRAG=true 时显示）────────────
        if (DEBUG_WB_DRAG) {
          ctx.save();
          ctx.strokeStyle = 'rgba(0,255,100,0.85)';
          ctx.lineWidth   = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(BL[0], BL[1]);
          worldPts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
          const CL = ['BL','BR','TR','TL'];
          worldPts.forEach(([x, y], i) => {
            ctx.fillStyle   = (_wbDragIdx === i) ? '#ffff00' : '#00ff66';
            ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI*2); ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#000'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
            ctx.fillText(CL[i], x, y + 3);
          });
          ctx.textAlign = 'left';
          ctx.fillStyle = 'rgba(0,255,100,0.95)'; ctx.font = '12px monospace';
          _wbFreeCorners.forEach(([vx, vy], i) =>
            ctx.fillText(`${CL[i]}: (${vx.toFixed(3)}, ${vy.toFixed(3)})`, 8, 22 + i * 18)
          );
          ctx.restore();
        }

        // ── hover 白色高光：顶面 + 侧面 ───────────────────────────
        if (_wbHovered) {
          const sideHL = _wbr.height * WB_SIDE_H_L;  // 左线长度
          const sideHR = _wbr.height * WB_SIDE_H_R;  // 右线长度

          // 右侧边
          const rtRad = WB_RIGHT_TILT * Math.PI / 180;
          const SBR = [
            BR[0] + Math.sin(rtRad) * sideHR,
            BR[1] + Math.cos(rtRad) * sideHR,
          ];
          // 左侧边
          const ltRad = WB_LEFT_TILT * Math.PI / 180;
          const SBL = [
            BL[0] + Math.sin(ltRad) * sideHL,
            BL[1] + Math.cos(ltRad) * sideHL,
          ];

          ctx.save();
          ctx.shadowColor = 'rgba(255,255,255,0.6)';
          ctx.shadowBlur  = 14;
          ctx.strokeStyle = 'rgba(255,255,255,0.90)';
          ctx.lineWidth   = 4;
          ctx.setLineDash([]);
          ctx.lineJoin    = 'round';

          // ① 顶面四边形
          ctx.beginPath();
          ctx.moveTo(BL[0], BL[1]);
          [BR, TR, TL].forEach(([x, y]) => ctx.lineTo(x, y));
          ctx.closePath();
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();

          // ② 左竖边
          ctx.beginPath(); ctx.moveTo(BL[0], BL[1]); ctx.lineTo(SBL[0], SBL[1]); ctx.stroke();
          // ③ 右竖边
          ctx.beginPath(); ctx.moveTo(BR[0], BR[1]); ctx.lineTo(SBR[0], SBR[1]); ctx.stroke();
          // ④ 底边
          ctx.beginPath(); ctx.moveTo(SBL[0], SBL[1]); ctx.lineTo(SBR[0], SBR[1]); ctx.stroke();

          // ⑤ 侧面淡白填充
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
          ctx.beginPath();
          ctx.moveTo(BL[0], BL[1]); ctx.lineTo(BR[0], BR[1]);
          ctx.lineTo(SBR[0], SBR[1]); ctx.lineTo(SBL[0], SBL[1]);
          ctx.closePath(); ctx.fill();

          ctx.restore();
        }

        // ── title 定位 ────────────────────────────────────────────
        const titleEl = document.getElementById('wb-title');
        if (titleEl) {
          // 工作台位置（三个分支都需要）
          const topCX  = (TR[0] + TL[0]) / 2;
          const topCY  = (TR[1] + TL[1]) / 2;
          const titleW = Math.hypot(TR[0]-TL[0], TR[1]-TL[1]) * 1.1;
          const wbLeft = (topCX + _wbr.width  * 0.03) + 'px';
          const wbTop  = (topCY + _wbr.height * 0.11) + 'px';

          if (_wbExpanded && !_wbClosing) {
            // ① 展开态：仅第一帧写入，CSS transition 接管
            if (!titleEl._wbExpandApplied) {
              titleEl._wbExpandApplied = true;
              titleEl.style.transition =
                'left 0.55s cubic-bezier(0.25,0.46,0.45,0.94),' +
                'top  0.55s cubic-bezier(0.25,0.46,0.45,0.94),' +
                'width 0.5s cubic-bezier(0.25,0.46,0.45,0.94),' +
                'opacity 0.3s, filter 0.3s';
              titleEl.style.left  = '50vw';
              titleEl.style.top   = '50vh';
              titleEl.style.width = WB_TITLE_EXPAND_VW + 'vw';

              // Phase 2：Phase 1 结束后，title 上移 + panel 从底边同步上移后抽屉滑出
              titleEl._phase2Timer = setTimeout(() => {
                if (!_wbExpanded || _wbClosing) return;
                _wbPhase2 = true;

                // title 上移（用 vh，随视口缩放）
                titleEl.style.transition =
                  'top 0.4s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.3s, filter 0.3s';
                titleEl.style.top = '17vh';

                // 等 title 上移完成后触发抽屉弹出
                const panel = document.getElementById('wb-panel');
                if (panel) {
                  layoutWbPanel(titleEl);
                  setTimeout(() => {
                    if (!_wbExpanded || _wbClosing) return;
                    panel.classList.add('open');
                  }, 450);
                }
              }, 580);
            }
            titleEl.classList.add('expanded');
            titleEl.classList.remove('closing', 'hovered');

            // 每帧同步 panel 与 title（Phase2 开始后，含 F12 缩放）
            if (_wbPhase2) {
              titleEl.style.width = WB_TITLE_EXPAND_VW + 'vw';
              titleEl.style.left  = '50vw';
              layoutWbPanel(titleEl);
              if (typeof slotEditRefresh  === 'function') slotEditRefresh();
              if (typeof mpUpdateBackBtn  === 'function') mpUpdateBackBtn();
              if (typeof mpUpdateSongLabel === 'function') mpUpdateSongLabel();
            }

          } else if (_wbClosing) {
            // ② 收起动画：仅第一帧触发，动画结束后清除状态
            if (!titleEl._wbCloseApplied) {
              titleEl._wbCloseApplied = true;
              titleEl._wbExpandApplied = false;
              clearTimeout(titleEl._phase2Timer);

              // 先关闭 panel（抽屉缩回）
              const panel = document.getElementById('wb-panel');
              if (panel) panel.classList.remove('open');

              // title 回到 50vh 中心（如果 phase2 已经上移到 17vh）
              if (_wbPhase2) {
                titleEl.style.transition =
                  'top 0.55s cubic-bezier(0.4,0,0.6,1), opacity 0.4s, filter 0.4s';
                titleEl.style.top = '50vh';
              }
              _wbPhase2 = false;
              _panelH = 0; // 停止 animateFlame 的每帧跟踪
              if (typeof mpUpdateBackBtn  === 'function') mpUpdateBackBtn();
              if (typeof mpUpdateSongLabel === 'function') mpUpdateSongLabel();

              // 等 panel + title 回中心后，再播 wb-close 飘回动画
              setTimeout(() => {
                titleEl.classList.remove('expanded');
                titleEl.classList.add('closing');
                titleEl.style.transition =
                  'left 0.85s cubic-bezier(0.4,0,0.6,1),' +
                  'top  0.85s cubic-bezier(0.4,0,0.6,1),' +
                  'width 0.75s cubic-bezier(0.4,0,0.6,1),' +
                  'opacity 0.6s, filter 0.6s';
                titleEl.style.left  = wbLeft;
                titleEl.style.top   = wbTop;
                titleEl.style.width = titleW + 'px';
                setTimeout(() => {
                  _wbExpanded = false;
                  _wbClosing  = false;
                  if (titleEl) {
                    titleEl.classList.remove('closing');
                    titleEl._wbCloseApplied = false;
                    // 恢复基础 transition，让 opacity/filter 由 class 接管
                    titleEl.style.transition = 'opacity 0.3s, filter 0.3s';
                  }
                }, 870); // 和 wb-close animation（850ms）对齐，20ms 缓冲
              }, 480); // 等 panel 缩回（panel-inner transition 0.7s，约等一半）
            }

          } else {
            // ③ idle：JS 每帧跟踪工作台位置
            titleEl._wbExpandApplied = false;
            titleEl._wbCloseApplied  = false;
            titleEl.classList.remove('expanded', 'closing');
            titleEl.style.transition = 'opacity 0.3s, filter 0.3s';
            titleEl.style.width  = titleW + 'px';
            titleEl.style.height = 'auto';
            titleEl.style.left   = wbLeft;
            titleEl.style.top    = wbTop;
            titleEl.classList.toggle('hovered', _titleHovered);
            if (typeof mpUpdateBackBtn  === 'function') mpUpdateBackBtn();
            if (typeof mpUpdateSongLabel === 'function') mpUpdateSongLabel();
          }
        }
      }

      // ── 箱子：hover 白色高光（与工作台 / 熔炉相同风格）──────────────────
      if (_chestHovered && CHEST_CORNERS && CHEST_FACES) {
        const cr = getVideoRect();
        if (cr) {
          const toScr = ([vx, vy]) => [cr.left + vx * cr.width, cr.top + vy * cr.height];
          const scr = CHEST_CORNERS.map(toScr);

          ctx.save();
          ctx.shadowColor = 'rgba(255,255,255,0.6)';
          ctx.shadowBlur  = 14;
          ctx.strokeStyle = 'rgba(255,255,255,0.90)';
          ctx.lineWidth   = 4;
          ctx.setLineDash([]);
          ctx.lineJoin    = 'round';

          for (const face of CHEST_FACES) {
            const pts = face.idx.map(i => scr[i]);
            const skip = new Set(face.skipEdges || []);
            // 半透明填充
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
            // 逐边描边（跳过 skipEdges）
            for (let i = 0; i < pts.length; i++) {
              if (skip.has(i)) continue;
              const j = (i + 1) % pts.length;
              ctx.beginPath();
              ctx.moveTo(pts[i][0], pts[i][1]);
              ctx.lineTo(pts[j][0], pts[j][1]);
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }

      // ── 熔炉：hover 白色高光（与工作台相同风格，画在 flame-canvas）────
      if (_furnaceHovered && FURNACE_CORNERS && FURNACE_FACES) {
        const fr = getVideoRect();
        if (fr) {
          const toScr = ([vx, vy]) => [fr.left + vx * fr.width, fr.top + vy * fr.height];
          const scr = FURNACE_CORNERS.map(toScr);

          ctx.save();
          ctx.shadowColor = 'rgba(255,255,255,0.6)';
          ctx.shadowBlur  = 14;
          ctx.strokeStyle = 'rgba(255,255,255,0.90)';
          ctx.lineWidth   = 4;
          ctx.setLineDash([]);
          ctx.lineJoin    = 'round';

          for (const face of FURNACE_FACES) {
            const pts = face.idx.map(i => scr[i]);
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
            if (pts.length > 2) {
              ctx.closePath();
              ctx.stroke();
              ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
            } else {
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }

      // ── 烈焰彩蛋：fire > 80 上升沿 + sleepLeft → 弹台词 + 翻身 ──────
      const _fireHigh = furnaceLevel > 80;
      if (_fireHigh && !animateFlame._fireBlindPrev
          && state === 'sleepLeft' && !animateFlame._fireBlindBusy) {
        animateFlame._fireBlindBusy = true;
        if (typeof showFireBlindBubble === 'function') {
          showFireBlindBubble(() => {
            if (state === 'sleepLeft') turn();
            // 彩蛋冷却：翻身结束后随机 15~45s 才允许再次触发
            const cooldown = (15 + Math.random() * 30) * 1000;
            setTimeout(() => { animateFlame._fireBlindBusy = false; }, cooldown);
          });
        }
      }
      // 火力下降到 80 以下时重置上升沿检测
      if (!_fireHigh) animateFlame._fireBlindPrev = false;
      else            animateFlame._fireBlindPrev = true;

      } catch(e) { console.error('flame:', e); }  // 单帧错误不中断循环
    }
    animateFlame._fireBlindPrev = false;
    animateFlame._fireBlindBusy = false;
    animateFlame();
