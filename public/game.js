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

    // When both players are in the room, start BGM
    const bothPresent = roster.every(p => !!p.userId);
    if (bothPresent) tryStartMusic();
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
    lastSendTs: 0
  };

  // === Background music ===
  let musicStarted = false;
  const bgm = new Audio('data/Imperial March.m4a'); // your provided m4a
  bgm.loop = true;
  bgm.preload = 'auto';
  bgm.volume = 1;

  function tryStartMusic() {
    if (musicStarted) return;
    bgm.play().then(() => {
      musicStarted = true;
      // Clean up any pending gesture listeners if we added them
      window.removeEventListener('keydown', resumeFromGesture, true);
      window.removeEventListener('mousedown', resumeFromGesture, true);
      window.removeEventListener('touchstart', resumeFromGesture, true);
    }).catch(() => {
      // Autoplay blocked: start on first user gesture
      window.addEventListener('keydown', resumeFromGesture, true);
      window.addEventListener('mousedown', resumeFromGesture, true);
      window.addEventListener('touchstart', resumeFromGesture, true);
    });
  }

  function resumeFromGesture() {
    tryStartMusic();
  }

  // Projectiles
  const FIRE_COOLDOWN_MS = 180;        // fire rate limit
  const BULLET_SPEED = 1800;           // px/sec
  const BULLET_LIFETIME = 2.2;         // seconds
  const BULLET_LEN = 24;               // drawing length
  state.projectiles = [];              // {x,y,vx,vy,ts,side}
  state.lastFireTs = 0;

  // Fighters and explosions ===
  state.fighters = [];   // {id, side:'left'|'right', x,y, vx, vy, r, alive:true}
  state.explosions = []; // {x,y, t:0..life, life}
  const FIGHTER_SPEED = 600;           // px/sec base speed
  const FIGHTER_RADIUS = 40;           // for simple circle hitbox
  const SPAWN_INTERVAL_MS = 2000;      // how often to spawn a pair
  state.lastSpawnMs = 0;

  // === Difficulty scaling ===

  // fighter speed scales with elapsed time
  function speedMultiplier() {
    const t = (performance.now() - GAME_START_MS) / 1000; // seconds
    // +1% per second capped at +200%
    return Math.min(3, 1 + 0.01 * t);
  }

  // === Lives  ===
  state.lives = { left: 20, right: 20 };  // both sides start at 15
  const GAME_START_MS = performance.now();


// host: only the current player1 runs host-only logic
  function isHost() {
    return role === 'player1';
  }
  // Canvas setup (auto-resize to device pixel ratio)
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // === Preload destroyer images ===
  const imgDestroyerLeft = new Image();
  const imgDestroyerRight = new Image();
  imgDestroyerLeft.src = 'data/destroyer_left.png';
  imgDestroyerRight.src = 'data/destroyer_right.png';

  // === Preload fighter images ===
  const imgFighterLeft  = new Image();  // spawns at left, flies right
  const imgFighterRight = new Image();  // spawns at right, flies left
  imgFighterLeft.src  = 'data/rebel_fighter.png';
  imgFighterRight.src = 'data/empire_fighter.png';

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

  // Opponent fighters spawn (relayed by server)
  socket.on('fighterSpawn', ({ fighters }) => {
    // Push exactly as received so IDs match across clients
    for (const f of fighters) state.fighters.push({ ...f, alive: true, r: FIGHTER_RADIUS });
  });

  // A fighter was destroyed (relayed)
  socket.on('fighterDown', ({ id }) => {
    const f = state.fighters.find(x => x.id === id && x.alive);
    if (f) {
      f.alive = false;
      // explosion
      state.explosions.push({ x: f.x, y: f.y, t: 0, life: 0.45 });
    }
  });

  // === Mirror opponent-reported breach ===
  socket.on('breach', ({ side }) => {
    if (!side) return;
    state.lives[side] = Math.max(0, state.lives[side] - 1);
    // Optional: create a small flash at the corresponding ship’s shield center
    const { cx, cy } = getShieldForSide(side);
    state.explosions.push({ x: cx, y: cy, t: 0, life: 0.35 });
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

  // === Draw lives ===
  function drawLives(ctx) {
    ctx.save();
    ctx.font = 'bold 64px Arial, sans-serif';
    ctx.textBaseline = 'top';

    // Left side (player1 mothership)
    ctx.fillStyle = 'rgba(78,205,196,0.95)';
    ctx.shadowColor = 'rgba(78,205,196,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText(`Life: ${state.lives.left}`, 60, 40);

    // Right side (player2 mothership)
    const text = `Life: ${state.lives.right}`;
    const metrics = ctx.measureText(text);
    ctx.fillStyle = 'rgba(255,190,111,0.95)';
    ctx.shadowColor = 'rgba(255,190,111,0.6)';
    ctx.shadowBlur = 10;
    ctx.fillText(text, state.width - metrics.width - 60, 40);

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

  // === Host-only breach check ===
  function checkShieldBreachesAndSync() {
    if (!isHost()) return;

    const leftShield  = getShieldForSide('left');
    const rightShield = getShieldForSide('right');

    for (const f of state.fighters) {
      if (!f.alive) continue;

      // Enemy of left mothership are right-side fighters; enemy of right mothership are left-side fighters
      const targetShield = (f.side === 'right') ? leftShield : rightShield;
      const breachedSide = (f.side === 'right') ? 'left' : 'right';

      // When a fighter touches the shield's front half, count exactly once
      if (hitsShield(f.x, f.y, targetShield) && !f.breached) {
        f.breached = true; // prevent multiple life deductions for the same fighter

        // Reduce appropriate life locally (fighter keeps flying; do NOT set f.alive = false)
        state.lives[breachedSide] = Math.max(0, state.lives[breachedSide] - 1);

        // Explosion on the mothership (use shield center as impact point)
        const { cx, cy } = getShieldForSide(breachedSide);
        state.explosions.push({ x: cx, y: cy, t: 0, life: 0.45 });

        // Sync to opponent
        socket.emit('breach', { roomId, side: breachedSide });
      }
    }
  }

  // === Update fighters ===
  function stepFighters(dt) {
    const w = state.width, h = state.height;

    for (const f of state.fighters)
    {
      if (!f.alive) continue;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }

    // cull off-screen (with margin)
    const M = 120;
    state.fighters = state.fighters.filter(f => {
      if (!f.alive) return true; // keep for explosion timing until we explicitly remove after effect
      return f.x > -M && f.x < w + M && f.y > -M && f.y < h + M;
    });
  }

  function drawFighters(ctx) {
    ctx.save();
    for (const f of state.fighters) {
      if (!f.alive) continue;
      // pick sprite by spawn side (also implies heading)
      const img = (f.side === 'left') ? imgFighterLeft : imgFighterRight;
      const drawW = 120, drawH = 80;
      const halfW = drawW/2, halfH = drawH/2;

      // faint shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(f.x + 6, f.y + halfH - 8, halfW*0.9, 10, 0, 0, Math.PI*2);
      ctx.fill();

      // sprite
      ctx.drawImage(img, f.x - halfW, f.y - halfH, drawW, drawH);
    }
    ctx.restore();
  }

  // === Explosions ===
  function stepExplosions(dt) {
    for (const e of state.explosions) e.t += dt;
    state.explosions = state.explosions.filter(e => e.t < e.life);
  }

  function drawExplosions(ctx) {
    ctx.save();
    for (const e of state.explosions) {
      const k = e.t / e.life;                 // 0..1
      const r = 12 + 50 * k;                  // grows
      const alpha = 1 - k;                    // fades
      // outer glow
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,200,120,${0.5*alpha})`;
      ctx.arc(e.x, e.y, r, 0, Math.PI*2);
      ctx.fill();
      // core
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,240,180,${0.9*alpha})`;
      ctx.arc(e.x, e.y, r*0.45, 0, Math.PI*2);
      ctx.fill();
      // sparks
      ctx.strokeStyle = `rgba(255,220,160,${0.7*alpha})`;
      ctx.lineWidth = 2;
      for (let i=0;i<6;i++){
        const a = (i/6)*Math.PI*2;
        const len = r * (0.6 + 0.4*Math.random());
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x + Math.cos(a)*len, e.y + Math.sin(a)*len);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function stepProjectiles(dt) {
    const now = performance.now() / 1000;
    const w = state.width, h = state.height;

    // Shields
    const leftShield  = getShieldForSide('left');
    const rightShield = getShieldForSide('right');

    state.projectiles = state.projectiles.filter(p => {
      // integrate
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // life/bounds
      const alive = (now - p.ts) < BULLET_LIFETIME;
      const onscreen = p.x > -200 && p.x < w + 200 && p.y > -200 && p.y < h + 200;
      if (!alive || !onscreen) return false;

      // shield collision (existing behavior)
      const targetShield = (p.side === 'player1') ? rightShield : leftShield;
      if (hitsShield(p.x, p.y, targetShield)) return false;

      // === Fighter collision (bullets only damage enemy fighters) ===
      const enemySide = (p.side === 'player1') ? 'right' : 'left';
      let hitId = null;

      for (const f of state.fighters) {
        if (!f.alive || f.side !== enemySide) continue;
        // circle hit test
        const dx = p.x - f.x, dy = p.y - f.y;
        if (dx*dx + dy*dy <= (f.r * f.r)) {
          hitId = f.id;
          break;
        }
      }

      if (hitId)
      {
        // Locally mark dead and spawn explosion
        const f = state.fighters.find(x => x.id === hitId && x.alive);
        if (f)
        {
          f.alive = false;
          state.explosions.push({ x: f.x, y: f.y, t: 0, life: 0.45 });
        }
        // Only the owner of the bullet notifies the server (prevents duplicate emits)
        const iAmOwner = ((p.side === 'player1') && role === 'player1') || ((p.side === 'player2') && role === 'player2');
        if (iAmOwner) socket.emit('fighterDown', { roomId, id: hitId });
        return false; // bullet consumed
      }

      return true;
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

    // === Host spawns symmetric fighters and tells the room ===
    if (isHost()) {
      const nowSpawn = performance.now();
      if (nowSpawn - state.lastSpawnMs >= SPAWN_INTERVAL_MS) {
        state.lastSpawnMs = nowSpawn;

        const { midY } = getSceneAnchors();
        // random vertical bands
        const yL = midY - 500 + Math.random() * 1000;
        const yR = midY - 500 + Math.random() * 1000;

        const idL = `L_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        const idR = `R_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        
        const m = speedMultiplier();
        const fighters = [
          { id: idL, side: 'left',  x: state.width * 0.02, y: yL, vx:  FIGHTER_SPEED * m, vy: 0, r: FIGHTER_RADIUS },
          { id: idR, side: 'right', x: state.width * 0.98, y: yR, vx: -FIGHTER_SPEED * m, vy: 0, r: FIGHTER_RADIUS },
        ];

        // local add
        fighters.forEach(f => state.fighters.push({ ...f, alive: true }));
        // sync to opponent
        socket.emit('spawnFighters', { roomId, fighters });
      }
    }

    stepProjectiles(dt);
    checkShieldBreachesAndSync();
    stepFighters(dt);
    stepExplosions(dt);

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
    ctx.restore();

    const midY = state.height * 0.5;
    const leftX = state.width * 0.17;
    const rightX = state.width * 0.83;

    // Motherships and shields
    const myCheat = state.my.cheat;
    const opCheat = state.op.cheat;
    drawMothership(leftX,  midY, 'left',  role === 'player1' ? myCheat : opCheat);
    drawMothership(rightX, midY, 'right', role === 'player2' ? myCheat : opCheat);

    // Lives
    drawLives(ctx);

    // === Fighters and explosions ===
    drawFighters(ctx);
    drawExplosions(ctx);

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
})();