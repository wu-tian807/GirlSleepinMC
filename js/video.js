// video.js — video layer crossfade, state machine, turn logic, unmute, HUD, rect cache

    const VIDEOS = {
      rightSleep    : 'rightSleep.webm',
      leftSleep     : 'leftSleep.webm',
      turnLeft      : 'turnleft_s.webm',
      turnRight     : 'turnright_s.webm',
      turnRightQuick: 'turn_right_quick.webm',
      shiverRight   : 'shiver_right_resize.webm',
      shiverLeft    : 'shiver_left_new.webm',
    };

    const CROSSFADE_MS  = 200;     // 过场时长

    // ─── 头部点击区域（视频帧相对坐标）──────────────────────────────
    const HEAD_CX    = 0.65;   // 头部中心 x（视频宽度比例），可调
    const HEAD_CY    = 0.38;   // 头部中心 y（视频高度比例），可调
    const HEAD_R     = 0.10;   // 可点击半径（视频宽度比例），可调
    const DEBUG_HEAD = false;  // true 时在 canvas 上显示头部点击区

    // ─── 工作台点击区域（视频帧相对坐标）────────────────────────────
    let WB_CX    = 0.20;   // 工作台中心 x（可调）
    let WB_CY    = 0.37;   // 工作台中心 y（可调）
    let WB_W     = 0.16;   // 宽度（视频宽度比例，可调）
    let WB_H     = 0.18;   // 高度（视频高度比例，可调）—— 16:9 下需要比 W 大很多才能让侧边等长
    let WB_ANGLE = -14;    // 旋转角度（度）：负=逆时针，可调
    let WB_SHEAR = -0.038;  // 旋转后叠加的平行四边形偏移量，可调
    const DEBUG_WB = false;

    // 凸多边形内部检测（叉积符号一致法，CW/CCW 自适应）
    function _inConvexPoly(pts, px, py) {
      let winding = null;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (winding === null) winding = cross >= 0;
        else if ((cross >= 0) !== winding) return false;
      }
      return true;
    }

    // 命中检测：顶面（_wbFreeCorners）OR 侧面（由底边向下延伸得到的四边形）
    function isInWorkbench(px, py) {
      if (!_wbFreeCorners) return false;
      const r = getVideoRect(); if (!r) return false;

      // 顶面角点（屏幕坐标）[BL, BR, TR, TL]
      const sc = _wbFreeCorners.map(([vx, vy]) => [
        r.left + vx * r.width,
        r.top  + vy * r.height,
      ]);
      const [BL, BR] = sc;

      // 顶面命中
      if (_inConvexPoly(sc, px, py)) return true;

      // 侧面（正面面板）命中：[BL, BR, SBR, SBL] 四边形
      const sideHL = r.height * WB_SIDE_H_L;
      const sideHR = r.height * WB_SIDE_H_R;
      const ltRad  = WB_LEFT_TILT  * Math.PI / 180;
      const rtRad  = WB_RIGHT_TILT * Math.PI / 180;
      const SBL = [BL[0] + Math.sin(ltRad) * sideHL, BL[1] + Math.cos(ltRad) * sideHL];
      const SBR = [BR[0] + Math.sin(rtRad) * sideHR, BR[1] + Math.cos(rtRad) * sideHR];
      return _inConvexPoly([BL, BR, SBR, SBL], px, py);
    }

    // ─── 双层 ────────────────────────────────────────────────────────
    front = { el: document.getElementById('layerA'), vid: document.getElementById('videoA') };
    back  = { el: document.getElementById('layerB'), vid: document.getElementById('videoB') };

    /**
     * 真正的交叉溶解：
     *  - 新层（back）z-index 固定为 2，从 opacity 0 → 1 淡入
     *  - 旧层（front）保持 opacity 1 不动，亮度全程不变
     *  - 新层完全覆盖后：旧层 opacity 瞬间置 0，引用交换，调用 onDone
     */
    function flipLayers(onDone) {
      front.el.style.zIndex    = '1';
      back.el.style.zIndex     = '2';       // 固定值，不再累加
      back.el.style.transition = `opacity ${CROSSFADE_MS}ms ease`;
      void back.el.offsetHeight;            // 强制 reflow，确保 transition 生效
      back.el.style.opacity    = '1';

      // 立即交换引用，调用方可继续使用 front/back
      [front, back] = [back, front];
      front.vid.muted = !userUnmuted;       // 新前台应用静音状态

      setTimeout(() => {
        front.el.style.transition = '';
        back.el.style.opacity     = '0';   // 旧层已被完全覆盖，瞬间隐藏
        back.vid.pause();
        back.vid.muted = true;
        if (onDone) onDone();
      }, CROSSFADE_MS);
    }

    // ─── 状态机 ──────────────────────────────────────────────────────

    const hud       = document.getElementById('hud');
    const turnBtn   = document.getElementById('turn-btn');
    const unmuteTip = document.getElementById('unmute-tip');

    function updateHud() {
      const hint = state === 'turning' ? '...' : 'click head (25%)';
      hud.innerHTML = `state: ${state}<br>${hint}`;
    }

    // ─── 翻身 ────────────────────────────────────────────────────────
    function turn() {
      if (state === 'turning') return;
      turnBtn.disabled = true;

      const fromRight  = state === 'sleepRight';
      const turnVideo  = fromRight ? 'turnLeft'  : 'turnRight';
      const sleepVideo = fromRight ? 'leftSleep' : 'rightSleep';
      const nextState  = fromRight ? 'sleepLeft' : 'sleepRight';

      state = 'turning';
      updateHud();

      // ① 睡眠循环打完当前轮再停（播到尾帧）
      front.vid.loop = false;

      // ② 同时在后台静默缓冲翻身动画（不 play）
      back.vid.pause();
      back.vid.muted = true;
      back.vid.loop  = false;
      back.vid.src   = VIDEOS[turnVideo];
      back.vid.load();

      // ③ 睡眠尾帧结束
      front.vid.addEventListener('ended', function onSleepEnd() {

        // ④ 翻身视频已缓冲，播放，等第一帧渲染
        back.vid.addEventListener('playing', function onTurnReady() {

          // ⑤ 交叉淡入翻身动画（~200ms）
          flipLayers(() => {
            // 淡出完毕，后台安全可操作，加载下段睡眠循环
            back.vid.muted = true;
            back.vid.loop  = true;
            back.vid.src   = VIDEOS[sleepVideo];
            back.vid.load();  // 翻身约 7s，足够缓冲完

            // ⑥ 翻身动画结束
            front.vid.addEventListener('ended', function onTurnEnd() {

              // ⑦ 睡眠循环已缓冲，播放，等第一帧渲染
              back.vid.addEventListener('playing', function onSleepReady() {

                // ⑧ 交叉淡入睡眠循环（~200ms）
                flipLayers(() => {
                  state = nextState;
                  turnBtn.disabled = false;
                  updateHud();
                });

              }, { once: true });

              back.vid.currentTime = 0;
              back.vid.play().catch(console.error);

            }, { once: true });
          });

        }, { once: true });

        back.vid.currentTime = 0;
        back.vid.play().catch(console.error);

      }, { once: true });
    }

    window.turn = turn;

    // ─── 快速翻身（fire-blind 彩蛋用）：立即中断 sleep loop，不等循环结束 ─
    // 仅支持 sleepLeft → sleepRight（使用 turn_right_quick.webm）
    function turnQuick() {
      if (state === 'turning') return;
      if (state !== 'sleepLeft') { turn(); return; }  // 只有 sleepLeft 有快速版
      turnBtn.disabled = true;

      state = 'turning';
      updateHud();

      // 立即停止当前 sleep 循环，切入快速翻身视频
      front.vid.loop = false;
      front.vid.pause();

      back.vid.pause();
      back.vid.muted = true;
      back.vid.loop  = false;
      back.vid.src   = VIDEOS.turnRightQuick;
      back.vid.load();

      // 后台视频准备好第一帧后立即 crossfade
      back.vid.addEventListener('playing', function onQuickTurnReady() {
        // 同时开始缓冲下段睡眠循环
        // (暂不动 back，等翻身结束再换)
        flipLayers(() => {
          // 翻身播完，切 rightSleep
          back.vid.muted = true;
          back.vid.loop  = true;
          back.vid.src   = VIDEOS.rightSleep;
          back.vid.load();

          front.vid.addEventListener('ended', function onQuickTurnEnd() {
            back.vid.addEventListener('playing', function onSleepReady() {
              flipLayers(() => {
                state = 'sleepRight';
                turnBtn.disabled = false;
                updateHud();
              });
            }, { once: true });
            back.vid.currentTime = 0;
            back.vid.play().catch(console.error);
          }, { once: true });
        });
      }, { once: true });

      back.vid.currentTime = 0;
      back.vid.play().catch(console.error);
    }
    window.turnQuick = turnQuick;

    // ─── 发抖彩蛋（冷彩蛋）：立即切入发抖视频，播完后回到原睡眠 ─────────
    function playShiver(onDone) {
      if (state !== 'sleepRight' && state !== 'sleepLeft') {
        if (onDone) onDone();
        return;
      }

      const isRight   = state === 'sleepRight';
      // shiver_right.webm = 面朝右（源自 rightSleep 首帧）→ sleepRight 时用
      // shiver_left.webm  = 面朝左（源自 leftSleep 首帧） → ​sleepLeft 时用
      const shiverSrc = isRight ? VIDEOS.shiverRight : VIDEOS.shiverLeft;
      const sleepSrc  = isRight ? VIDEOS.rightSleep  : VIDEOS.leftSleep;
      const prevState = state;

      state = 'shivering';
      updateHud();

      // 立即中断当前 sleep loop，切入发抖视频
      front.vid.loop  = false;
      front.vid.pause();

      back.vid.pause();
      back.vid.muted  = true;
      back.vid.loop   = false;   // 发抖视频只播一遍（~5s）
      back.vid.src    = shiverSrc;
      back.vid.load();

      back.vid.addEventListener('playing', function onShiverReady() {
        flipLayers(() => {
          // 发抖视频切入后，后台开始缓冲睡眠循环
          back.vid.muted = true;
          back.vid.loop  = true;
          back.vid.src   = sleepSrc;
          back.vid.load();

          front.vid.addEventListener('ended', function onShiverEnd() {
            back.vid.addEventListener('playing', function onSleepReady() {
              flipLayers(() => {
                state = prevState;
                updateHud();
                if (onDone) onDone();
              });
            }, { once: true });
            back.vid.currentTime = 0;
            back.vid.play().catch(console.error);
          }, { once: true });
        });
      }, { once: true });

      back.vid.currentTime = 0;
      back.vid.play().catch(console.error);
    }
    window.playShiver = playShiver;

    // ─── 解除静音（只作用于前台） ────────────────────────────────────
    function unmute() {
      if (userUnmuted) return;
      userUnmuted     = true;
      front.vid.muted = false;
      unmuteTip.classList.add('hidden');
      _startCrackle();   // 首次用户交互后启动炉火音效
    }

    // WE applyUserProperties 触发 autounmute 的接口（视频初始化后调用才安全）
    window._weAutoUnmuteOnReady = function() {
      if (!userUnmuted) unmute();
    };

    // ─── 初始化：只启动前台 rightSleep，后台什么都不做 ───────────────
    // 随机初始睡眠方向
    const startRight = Math.random() < 0.5;
    state = startRight ? 'sleepRight' : 'sleepLeft';
    front.vid.loop = true;
    front.vid.src  = startRight ? VIDEOS.rightSleep : VIDEOS.leftSleep;
    front.vid.play().catch(() => {});

    updateHud();

