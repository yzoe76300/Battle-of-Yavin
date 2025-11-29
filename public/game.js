(() => {
  // Parse query params: ?roomId=...&role=player1|player2&username=optional
  const params = new URLSearchParams(location.search);
  const roomId = params.get('roomId') || 'dev_room';

  // Start with hint from query string; server will confirm/override
  let role = (params.get('role') === 'player2') ? 'player2' : 'player1';
  const username = params.get('username') || `pilot_${Math.random().toString(36).slice(2, 6)}`;

  // Use a stable userId if have one saved by login; fallback to ephemeral
  const stored = JSON.parse(localStorage.getItem('boY_user') || '{}');
  const userId = stored.id || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // UI elements
  const roomBadge = document.getElementById('roomBadge');
  const roleBadge = document.getElementById('roleBadge');
  const youBadge  = document.getElementById('youBadge');
  const opBadge   = document.getElementById('opBadge');
  const cheatBadge= document.getElementById('cheatBadge');
  const returnBtn = document.getElementById('returnBtn');

  roomBadge.textContent = `Room: ${roomId}`;
  roleBadge.textContent = `Role: ${role}`;
  youBadge.textContent  = `You: ${username}`;

  // Connect socket and join the room
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    socket.emit('joinGameRoom', { roomId, username, userId, role });
  });

  socket.on('roleAssigned', ({ role: finalRole }) => {
    role = finalRole;                // authoritative role from server
    roleBadge.textContent = `Role: ${role}`;
  });

  socket.on('roomJoined', ({ roomId: r }) => {
    roomBadge.textContent = `Room: ${r}`;
  });

  socket.on('roomRoster', (roster) => {
    // roster is an array with role info [{role,userId,username}, ...]
    const opp = roster.find(p => p.role !== role && p.userId);
    opBadge.textContent = `Opponent: ${opp ? `${opp.username} (${opp.role})` : 'waiting…'}`;
  });

  // Game state
  const state = {
    width: 3200, height: 1800, // internal canvas resolution (scaled by CSS)
    my: {
      angle: 0, // radians
      cheat: false
    },
    op: {
      angle: 0,
      cheat: false
    },
    lastSendTs: 0,
    myHealth: 100,
    opHealth: 100,
    projectiles: [],
    enemyFighters: [],
    explosions: []
  };

  // Projectiles
  const FIRE_COOLDOWN_MS = 180;        // fire rate limit
  const BULLET_SPEED = 1800;           // px/sec
  const BULLET_LIFETIME = 2.2;         // seconds
  const BULLET_LEN = 24;               // drawing length
  state.projectiles = [];              // {x,y,vx,vy,ts,side}
  state.lastFireTs = 0;

  // Canvas setup (auto-resize to device pixel ratio)
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // === Preload destroyer images ===
  const imgDestroyerLeft = new Image();
  const imgDestroyerRight = new Image();
  imgDestroyerLeft.src = 'data/destroyer_left.png';
  imgDestroyerRight.src = 'data/destroyer_right.png';
  const imgEmpireFighter = new Image();
  const imgRebelFighter = new Image();
  imgEmpireFighter.src = 'data/empire_fighter.png';
  imgRebelFighter.src = 'data/rebel_fighter.png';

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = state.width * ratio;
    canvas.height = state.height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(); // redraw on resize
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // Input handling: Up/Down to rotate
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
      keys.add(e.key);
      e.preventDefault();
    }

    // Allow holding Space (auto-fire handled in tick)
    if (e.code === 'Space') {
      keys.add('Space');
      e.preventDefault();
    }

    // Cheat toggle
    if ((e.key === 'S' || e.key === 's') && e.shiftKey) {
      state.my.cheat = !state.my.cheat;
      cheatBadge.style.display = state.my.cheat ? 'inline-block' : 'none';
      socket.emit('cheatToggle', { roomId, enabled: state.my.cheat });
    }
  });

  window.addEventListener('keyup', (e) => {
    if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
      keys.delete(e.key);
      e.preventDefault();
    }
    if (e.code === 'Space') {
      keys.delete('Space');
      e.preventDefault();
    }
  });

  // Opponent updates
  socket.on('opponentTurret', ({ angle /*, ts*/ }) => {
    state.op.angle = angle;
  });

  socket.on('opponentFire', ({ x, y, vx, vy, ts }) => {
    const opponentSide = (role === 'player1') ? 'player2' : 'player1';
    state.projectiles.push({ x, y, vx, vy, ts, side: opponentSide });
    if (state.projectiles.length > 400) state.projectiles.splice(0, state.projectiles.length - 400);
  });
  
  socket.on('opponentCheat', ({ enabled }) => {
    state.op.cheat = !!enabled;
  });

  // Return button
  returnBtn.addEventListener('click', () => {
    location.href = 'lobby.html';
  });

  // === drawMothership draws destroyer images ===
  function drawMothership(x, y, side, cheatOn) {
    ctx.save();
    ctx.translate(x, y);

    // Choose image by side
    let img = side === 'left' ? imgDestroyerLeft : imgDestroyerRight;

    // Desired on-canvas size
    const drawW = 1000;   // width in pixels
    const drawH = 500;   // height in pixels
    const halfW = drawW / 2;
    const halfH = drawH / 2;

    // Draw the provided side image centered at (x, y)
    // Note: we already translated to (x, y) above.
    ctx.drawImage(img, -halfW, -halfH, drawW, drawH);

    // Big shields in front of the ship

    // Direction: left ship faces +X (dir=+1), right ship faces -X (dir=-1)
    const dir = side === 'left' ? 1 : -1;

    // Ellipse radii sized to fully protect the ship
    const rx = drawW * 0.5;   // horizontal radius
    const ry = drawH * 1.5;   // vertical radius

    // Center the shield slightly ahead of the bow so the half-oval is “in front”
    const cx = dir * (drawW * 0.05); // push forward of ship center
    const cy = 0;

    // Visuals
    ctx.lineWidth = 5;
    ctx.strokeStyle = cheatOn ? 'rgba(78,205,196,0.95)' : 'rgba(78,205,196,0.4)';
    ctx.shadowColor = cheatOn ? 'rgba(78,205,196,0.9)' : 'rgba(78,205,196,0.35)';
    ctx.shadowBlur = cheatOn ? 18 : 8;

    // For the left ship (facing right) draw the RIGHT half of the ellipse;
    // for the right ship (facing left) draw the LEFT half.
    const start = (dir === 1) ? -Math.PI / 2 :  Math.PI / 2;
    const end   = (dir === 1) ?  Math.PI / 2 : -Math.PI / 2;

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, start, end, false);
    ctx.stroke();

    // cleanup
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawTurret(baseX, baseY, angle, side) {
    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate(angle);

    // base
    ctx.fillStyle = '#343434';
    ctx.fillRect(-18, -14, 36, 28);

    // barrel
    ctx.fillStyle = '#696969';
    ctx.fillRect(0, -6, 100, 12);

    // glowing tip
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.arc(100, 0, 6, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

  // Compute turret base position and shot direction for my cannon
  function getMyTurretBaseAndDir() {
    // Recompute same anchors used by draw()
    const midY   = state.height * 0.5;
    const leftX  = state.width  * 0.17;
    const rightX = state.width  * 0.83;

    // Turret bases (match drawTurret calls)
    const baseLeft  = { x: leftX  + 300, y: midY + 90 };
    const baseRight = { x: rightX - 300, y: midY + 90 };

    // Direction reference: player1 faces +X, player2 faces -X
    const dir = (role === 'player1') ? 1 : -1;
    const a = state.my.angle; // already measured from each side's forward
    const dx = Math.cos(a) * dir;
    const dy = Math.sin(a);

    const base = (role === 'player1') ? baseLeft : baseRight;

    // Offset to the barrel tip (match barrel lengths in drawTurret: 100)
    const tip = { x: base.x + dx * 100, y: base.y + dy * 100 };

    return { base, dir: { dx, dy }, tip };
  }

  // Shield geometry must match drawMothership
  const SHIP_W = 1000, SHIP_H = 500;
  const SHIELD_RX = SHIP_W * 0.5;
  const SHIELD_RY = SHIP_H * 1.5;
  const SHIELD_CX_OFFSET = SHIP_W * 0.05;

  // Anchors used across draw and collision
  function getSceneAnchors() {
    const midY   = state.height * 0.5;
    const leftX  = state.width  * 0.17;
    const rightX = state.width  * 0.83;
    return { midY, leftX, rightX };
  }

  // Return shield ellipse for a given side ('left' ship for player1, 'right' ship for player2)
  function getShieldForSide(side) {
    const { midY, leftX, rightX } = getSceneAnchors();
    const dir = (side === 'left') ? 1 : -1; // +X for left ship (player1), -X for right ship (player2)
    const shipX = (side === 'left') ? leftX : rightX;
    const cx = shipX + dir * SHIELD_CX_OFFSET;
    const cy = midY;
    return { cx, cy, rx: SHIELD_RX, ry: SHIELD_RY, dir };
  }

  // Check if a point (bullet) is inside the "front half" of the shield ellipse
  function hitsShield(px, py, shield) {
    const { cx, cy, rx, ry, dir } = shield;
    // Inside ellipse?
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    const inside = (nx*nx + ny*ny) <= 1;
    if (!inside) return false;
    // Front-half check: for left ship (dir=+1) front is x > cx; for right ship (dir=-1) front is x < cx
    const front = (dir === 1) ? (px - cx) > 0 : (px - cx) < 0;
    return front;
  }

  function fireBullet() {
    const { tip, dir: v } = getMyTurretBaseAndDir();
    const b = {
      x: tip.x,
      y: tip.y,
      vx: v.dx * BULLET_SPEED,
      vy: v.dy * BULLET_SPEED,
      ts: performance.now() / 1000,
      side: role // 'player1' or 'player2'
    };

    // local spawn
    state.projectiles.push(b);
    if (state.projectiles.length > 400) state.projectiles.splice(0, state.projectiles.length - 400);

    // tell the room
    socket.emit('fire', {
      roomId,
      x: b.x, y: b.y, vx: b.vx, vy: b.vy, ts: b.ts
    });
  }

  function stepProjectiles(dt) {
    const now = performance.now() / 1000;
    const w = state.width, h = state.height;

    // Precompute both shields
    const leftShield  = getShieldForSide('left');
    const rightShield = getShieldForSide('right');

    state.projectiles = state.projectiles.filter(p => {
      // Integrate
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Lifetime / bounds cull
      const alive = (now - p.ts) < BULLET_LIFETIME;
      const onscreen = p.x > -200 && p.x < w + 200 && p.y > -200 && p.y < h + 200;
      if (!alive || !onscreen) return false;
      const hitEnemy = hitsEnemy(p);
      if (hitEnemy) {
          createExplosion(p.x, p.y);
          state.enemyFighters.splice(hitEnemy.index, 1);
          return false; // remove bullet on hit
      }
      // Collision: bullet only interacts with the opponent shield
      const targetShield = (p.side === 'player1') ? rightShield : leftShield;

      // Simple point-in-ellipse test at bullet tip
      const hit = hitsShield(p.x, p.y, targetShield);
      
      if (hit) return false; // remove bullet on hit

      return true; // keep bullet
    });
  }

  function drawProjectiles(ctx) {
    for (const p of state.projectiles) {
      // bolt color per side
      const c = (p.side === 'player1') ? 'rgba(78,205,196,0.95)' : 'rgba(255,190,111,0.95)';
      const ang = Math.atan2(p.vy, p.vx);

      ctx.save(); // keep the DPI transform and all state

      // gradient along bolt direction
      const g = ctx.createLinearGradient(p.x, p.y, p.x - p.vx * 0.01, p.y - p.vy * 0.01);
      g.addColorStop(0, c);

      ctx.translate(p.x, p.y);
      ctx.rotate(ang);

      // core bolt
      ctx.fillStyle = g;
      ctx.fillRect(0, -2, BULLET_LEN, 4);

      // glow
      ctx.shadowColor = c;
      ctx.shadowBlur = 12;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(0, -1.5, BULLET_LEN, 3);

      ctx.restore(); // restores transform, alpha, shadow, etc.
    }
  }

    function generateEnemyFighter() {
        const side = Math.random() < 0.5 ? 'left' : 'right';

        let x, y, vx, targetSide;
        const midY = state.height * 0.5;

        if (side === 'left') {
            x = -200;
            y = midY + (Math.random() - 0.5) * 600;
            vx = 400;
            targetSide = 'right';
        } else {
            x = state.width + 200;
            y = midY + (Math.random() - 0.5) * 600;
            vx = -400;
            targetSide = 'left';
        }

        const type = side === 'left' ? 'rebel' : 'empire';
        state.enemyFighters.push({
            x, y, vx,
            targetSide,
            size: 30,
            color: side === 'left' ? '#FFD700' : '#FF4500',
            type: type
        });
    }

    function stepEnemyFighters(dt) {
        const now = performance.now() / 1000;

        state.enemyFighters = state.enemyFighters.filter(fighter => {
            fighter.x += fighter.vx * dt;
            fighter.y += (Math.random() - 0.5) * 50 * dt;

            let shield;
            if (fighter.targetSide === 'left') {
                shield = getShieldForSide('left');
            } else {
                shield = getShieldForSide('right');
            }

            if (hitsShield(fighter.x, fighter.y, shield)) {
                const damage = 15;

                if (role === 'player1') {
                    if (fighter.targetSide === 'left') {
                        state.myHealth -= damage;
                    } else {
                        state.opHealth -= damage;
                    }
                } else { // player2
                    if (fighter.targetSide === 'left') {
                        state.opHealth -= damage;
                    } else {
                        state.myHealth -= damage;
                    }
                }
                return false;
            }

            return fighter.x > -200 && fighter.x < state.width + 200 &&
                fighter.y > -200 && fighter.y < state.height + 200;
        });
    }

    function drawEnemyFighters() {
        for (const fighter of state.enemyFighters) {
            const img = fighter.type === 'rebel' ? imgRebelFighter : imgEmpireFighter;

            const drawW = 50;
            const drawH = 30;

            if (img.complete) {
                ctx.drawImage(
                    img,
                    fighter.x - drawW / 2,
                    fighter.y - drawH / 2,
                    drawW,
                    drawH
                );
            }
        }
    }

    function hitsEnemy(bullet) {
        for (let i = 0; i < state.enemyFighters.length; i++) {
            const fighter = state.enemyFighters[i];
            const dx = bullet.x - fighter.x;
            const dy = bullet.y - fighter.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // 检查是否击中小飞机（距离小于小飞机半径）
            if (distance < fighter.size) {
                return { index: i, fighter };
            }
        }
        return null;
    }

    function createExplosion(x, y) {
        state.explosions.push({
            x: x,
            y: y,
            size: 5,
            max_size: 20,
            ts: performance.now() / 1000
        });
    }

    function drawExplosions() {
        for (const explosion of state.explosions) {
            ctx.beginPath();
            ctx.arc(explosion.x, explosion.y, explosion.size, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.fill();
        }
    }
  // Game loop
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000); // cap dt
    last = now;

    // Handle input: change angle
    const speed = 1.2; // radians per second
    if (keys.has('ArrowUp'))  state.my.angle -= speed * dt;
    if (keys.has('ArrowDown')) state.my.angle += speed * dt;

    // Clamp angles to +/- ~70°
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const minLim = -Math.PI * 0.39;
    const maxLim =  Math.PI * 0.39;
    state.my.angle = clamp(state.my.angle, minLim, maxLim);

    stepEnemyFighters(dt);
    // Throttle network sends to ~30 Hz
    const ts = now | 0;
    if (ts - state.lastSendTs > 33) {
      socket.emit('turretUpdate', { roomId, angle: state.my.angle, ts });
      state.lastSendTs = ts;
    }

    // Auto-fire while Space is held (respects cooldown)
    const nowMs = performance.now();
    if (keys.has('Space') && (nowMs - state.lastFireTs >= FIRE_COOLDOWN_MS))
    {
      fireBullet();
      state.lastFireTs = nowMs;
    }

    stepProjectiles(dt);

    draw();
    requestAnimationFrame(tick);
  }

  function draw() {
    ctx.clearRect(0, 0, state.width, state.height);

    // lightweight star speckles
    ctx.save();
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * state.width;
      const y = Math.random() * state.height;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.fillStyle = 'white';
    ctx.font = '18px Arial';
    ctx.fillText(`Your Health: ${state.myHealth}`, 20, 30);
    ctx.fillText(`Opponent Health: ${state.opHealth}`, 20, 60);
    ctx.restore();
    drawEnemyFighters();

    drawExplosions();

    const midY = state.height * 0.5;
    const leftX = state.width * 0.17;
    const rightX = state.width * 0.83;

    // Motherships and shields
    const myCheat = state.my.cheat;
    const opCheat = state.op.cheat;
    drawMothership(leftX,  midY, 'left',  role === 'player1' ? myCheat : opCheat);
    drawMothership(rightX, midY, 'right', role === 'player2' ? myCheat : opCheat);

    // Projectiles
    drawProjectiles(ctx);

    // Angles for drawing:
    // Reference: for the left ship, 0 rad points +X; for the right ship, 0 rad points -X.
    const leftAngle  = (role === 'player1') ? state.my.angle : state.op.angle;
    const rightAngle = (role === 'player2') ? state.my.angle : state.op.angle;

    // Convert right gun angle from our reference into canvas rotation:
    const leftDrawAngle  = leftAngle;                // already relative to +X
    const rightDrawAngle = Math.PI - rightAngle;     // flip for -X baseline

    // Turrets
    drawTurret(leftX + 300,  midY + 90, leftDrawAngle,  'left');
    drawTurret(rightX - 300, midY + 90, rightDrawAngle, 'right');
  }

  requestAnimationFrame(tick);

  // Pause send on hidden tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) state.lastSendTs = performance.now() | 0;
  });
  setInterval(generateEnemyFighter, 2500);
})();