// Minimal rhythm game logic for 4 lanes, click/tap to hit notes
(function(){
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const comboEl = document.getElementById('combo');
  const judgEl = document.getElementById('judgement');
  const toastEl = document.getElementById('toast');
  const bgVideo = document.getElementById('bgVideo');
  const startStreamer = document.getElementById('startStreamer');
  const startRank = document.getElementById('startRank');
  const startOverlay = document.getElementById('startOverlay');
  const resultOverlay = document.getElementById('resultOverlay');
  const resultTitle = document.getElementById('resultTitle');
  const resultScore = document.getElementById('resultScore');
  const resultMaxCombo = document.getElementById('resultMaxCombo');
  const resultPerfect = document.getElementById('resultPerfect');
  const resultGood = document.getElementById('resultGood');
  const resultMiss = document.getElementById('resultMiss');
  const resultAccuracy = document.getElementById('resultAccuracy');
  const resultRank = document.getElementById('resultRank');
  const restartBtn = document.getElementById('restartBtn');
  const recStatus = document.getElementById('recStatus');
  const chartStatus = document.getElementById('chartStatus');
  const lifeStatus = document.getElementById('lifeStatus');
  const lifeValue = document.getElementById('lifeValue');
  const chartPanel = document.getElementById('chartPanel');
  const chartData = document.getElementById('chartData');
  const chartCopy = document.getElementById('chartCopy');

  const BASE_W = 1280;
  const BASE_H = 720;
  const LANES = 4;
  const HIT_Y = BASE_H - 120; // pixel position of hit line

  const LIFE_MAX = 100;
  const LIFE_GAIN_PERFECT = 2;
  const LIFE_GAIN_GOOD = 1;
  const LIFE_LOSS_MISS = 10;
  const RANK_THRESHOLDS = [
    {grade:'S', min:95},
    {grade:'A', min:90},
    {grade:'B', min:80},
    {grade:'C', min:70},
    {grade:'D', min:0}
  ];

  const WS_URL = 'ws://localhost:8787';
  const JAMMER_MIN_OFFSET = 0.6;
  const JAMMER_MAX_OFFSET = 1.2;
  const JAMMER_RATE_LIMIT = 1.0;

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  function applyDPR(){
    const stage = document.getElementById('stage');
    const rect = stage.getBoundingClientRect();
    canvas.width = BASE_W * dpr;
    canvas.height = BASE_H * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  applyDPR();
  window.addEventListener('resize', ()=>{ dpr = Math.max(1, window.devicePixelRatio || 1); applyDPR(); });

  // Game state
  let notes = [];
  let spawnTimer = 0;
  const SPAWN_INTERVAL = 700; // ms
  const NOTE_SPEED = 320; // px per second
  const TRAVEL_TIME = (HIT_Y + 24) / NOTE_SPEED; // seconds to reach hit line

  let lastTime = performance.now();
  let baseVideoTime = null;
  let score = 0;
  let combo = 0;
  let maxCombo = 0;
  let perfectCount = 0;
  let goodCount = 0;
  let missCount = 0;
  let started = false;
  let ended = false;
  let mode = null; // 'streamer' | 'rank'
  let life = LIFE_MAX;
  let recording = false;
  let recorded = [];
  let chartMode = 'loading'; // loading | chart | random
  let chartNotes = [];
  let chartIndex = 0;
  let jammerQueue = [];
  let lastJammerAt = -Infinity;
  let toastTimer = null;

  const PERFECT_WINDOW = 22;
  const GOOD_WINDOW = 55;
  const MISS_WINDOW = 80;

  let judgement = null; // {text, t, alpha}

  function getMediaTime(){
    return bgVideo ? bgVideo.currentTime : 0;
  }

  function setChartPanelVisible(visible){
    if(!chartPanel) return;
    chartPanel.style.display = visible ? 'flex' : 'none';
  }

  function updateChartPanel(){
    if(!chartData) return;
    chartData.value = JSON.stringify(recorded, null, 2);
  }

  function updateChartStatus(text){
    if(!chartStatus) return;
    chartStatus.textContent = text;
  }

  function updateLifeHud(){
    if(!lifeStatus || !lifeValue) return;
    if(mode === 'rank'){
      lifeStatus.style.display = 'block';
      lifeValue.textContent = Math.round(life);
    } else {
      lifeStatus.style.display = 'none';
    }
  }

  function showToast(message){
    if(!toastEl) return;
    toastEl.textContent = message;
    toastEl.style.display = 'block';
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{
      toastEl.style.display = 'none';
    }, 1500);
  }

  function toggleRecording(){
    recording = !recording;
    if(recording){
      recorded = [];
      if(recStatus) recStatus.style.display = 'block';
      setChartPanelVisible(false);
    } else {
      if(recStatus) recStatus.style.display = 'none';
      updateChartPanel();
      setChartPanelVisible(true);
    }
  }

  function recordTap(lane){
    if(!recording) return;
    const t = getMediaTime();
    recorded.push({t: Math.round(t * 1000) / 1000, lane});
  }

  function sanitizeChart(data){
    const raw = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : null);
    if(!raw) return null;
    return raw
      .filter(n => n && typeof n.t === 'number' && typeof n.lane === 'number')
      .map(n => ({t: n.t, lane: n.lane}));
  }

  fetch('assets/chart.json')
    .then(res => res.ok ? res.json() : Promise.reject(new Error('chart load failed')))
    .then(data => {
      const cleaned = sanitizeChart(data);
      if(cleaned && cleaned.length){
        chartNotes = cleaned;
        chartIndex = 0;
        chartMode = 'chart';
        updateChartStatus(`Chart: loaded (${chartNotes.length} notes)`);
      } else {
        chartMode = 'random';
        updateChartStatus('Chart: missing, using fallback');
      }
    })
    .catch(() => {
      chartMode = 'random';
      updateChartStatus('Chart: missing, using fallback');
    });

  function setupWebSocket(){
    let socket;
    try{
      socket = new WebSocket(WS_URL);
    } catch (err){
      return;
    }
    socket.addEventListener('message', (event)=>{
      if(!started || ended || mode !== 'streamer') return;
      let payload = null;
      try{
        payload = JSON.parse(event.data);
      } catch (err){
        return;
      }
      if(!payload || payload.type !== 'spawn_notes' || !payload.jammer) return;
      const mediaTime = getMediaTime();
      if(mediaTime - lastJammerAt < JAMMER_RATE_LIMIT) return;
      lastJammerAt = mediaTime;
      const count = Math.max(1, Math.min(12, Number(payload.count) || 1));
      for(let i=0;i<count;i++){
        const offset = JAMMER_MIN_OFFSET + Math.random() * (JAMMER_MAX_OFFSET - JAMMER_MIN_OFFSET);
        const lane = Math.floor(Math.random() * LANES);
        jammerQueue.push({spawnTime: mediaTime + offset, lane});
      }
      const by = payload.by ? String(payload.by) : 'anonymous';
      showToast(`Jammer notes by ${by}!`);
    });
  }
  setupWebSocket();

  function spawnRandom(){
    const lane = Math.floor(Math.random()*LANES);
    notes.push({lane, y:-24});
  }

  function updateJammerSpawns(){
    if(jammerQueue.length === 0) return;
    const mediaTime = getMediaTime();
    let i = 0;
    while(i < jammerQueue.length){
      const entry = jammerQueue[i];
      if(mediaTime >= entry.spawnTime){
        notes.push({lane: entry.lane, y:-24, jammer: true});
        jammerQueue.splice(i,1);
      } else {
        i += 1;
      }
    }
  }

  function update(dt){
    // spawn
    if(chartMode === 'random'){
      spawnTimer += dt*1000;
      if(spawnTimer >= SPAWN_INTERVAL){ spawnTimer -= SPAWN_INTERVAL; spawnRandom(); }
    } else if(chartMode === 'chart'){
      const mediaTime = getMediaTime();
      while(chartIndex < chartNotes.length){
        const entry = chartNotes[chartIndex];
        const spawnTime = entry.t - TRAVEL_TIME;
        if(mediaTime >= spawnTime){
          const lane = Math.max(0, Math.min(LANES-1, entry.lane));
          notes.push({lane, y:-24});
          chartIndex += 1;
        } else {
          break;
        }
      }
    }
    if(mode === 'streamer'){
      updateJammerSpawns();
    }

    // move notes
    for(let i=notes.length-1;i>=0;i--){
      const n = notes[i];
      n.y += NOTE_SPEED * dt;
      // miss if passes too far below hit line
      if(n.y > HIT_Y + MISS_WINDOW){
        notes.splice(i,1);
        registerMiss();
        showJudgement('MISS');
      }
    }
  }

  function registerMiss(){
    missCount += 1;
    combo = 0;
    if(mode === 'rank'){
      life = Math.max(0, life - LIFE_LOSS_MISS);
      updateLifeHud();
      if(life <= 0){
        finishGame('gameover');
      }
    }
  }

  function handleHit(lane){
    if(ended) return;
    // find nearest note in lane
    let bestIndex = -1; let bestDist = 1e9;
    for(let i=0;i<notes.length;i++){
      const n = notes[i];
      if(n.lane !== lane) continue;
      const dist = Math.abs(n.y - HIT_Y);
      if(dist < bestDist){ bestDist = dist; bestIndex = i; }
    }
    if(bestIndex === -1){ showJudgement('MISS'); registerMiss(); return; }
    const dist = Math.abs(notes[bestIndex].y - HIT_Y);
    if(dist <= PERFECT_WINDOW){
      score += 100;
      combo += 1;
      maxCombo = Math.max(maxCombo, combo);
      perfectCount += 1;
      if(mode === 'rank'){
        life = Math.min(LIFE_MAX, life + LIFE_GAIN_PERFECT);
        updateLifeHud();
      }
      showJudgement('PERFECT');
      notes.splice(bestIndex,1);
    } else if(dist <= GOOD_WINDOW){
      score += 50;
      combo += 1;
      maxCombo = Math.max(maxCombo, combo);
      goodCount += 1;
      if(mode === 'rank'){
        life = Math.min(LIFE_MAX, life + LIFE_GAIN_GOOD);
        updateLifeHud();
      }
      showJudgement('GOOD');
      notes.splice(bestIndex,1);
    } else {
      // too early/late
      showJudgement('MISS');
      registerMiss();
    }
  }

  function onLaneTap(lane){
    if(ended) return;
    recordTap(lane);
    handleHit(lane);
  }

  function showJudgement(text){
    judgement = {text, t:0, alpha:1};
    judgEl.textContent = text;
    judgEl.style.opacity = '1';
  }

  function draw(){
    // clear
    ctx.clearRect(0,0,BASE_W,BASE_H);

    // draw lanes background
    for(let i=0;i<LANES;i++){
      const x = i*(BASE_W/LANES);
      ctx.fillStyle = i%2 ? 'rgba(7,24,42,0.65)' : 'rgba(6,32,51,0.65)';
      ctx.fillRect(x,0,BASE_W/LANES,BASE_H);
    }

    // draw hit line guide
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0,HIT_Y-2,BASE_W,4);

    // draw notes
    for(const n of notes){
      const laneW = BASE_W/LANES;
      const x = n.lane*laneW + 8;
      const w = laneW - 16;
      const h = 18;
      if(n.jammer){
        ctx.strokeStyle = '#7bf7ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, n.y - h/2, w, h);
      } else {
        ctx.fillStyle = '#ffd36b';
        ctx.fillRect(x, n.y - h/2, w, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, n.y - h/2, w, h);
      }
    }

    // draw separators
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for(let i=1;i<LANES;i++){
      const x = i*(BASE_W/LANES);
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,BASE_H); ctx.stroke();
    }
  }

  function loop(now){
    if(ended) return;
    let dt = Math.min(0.05, (now - lastTime)/1000);
    lastTime = now;

    if(bgVideo){
      if(baseVideoTime === null) baseVideoTime = bgVideo.currentTime;
      const videoDelta = Math.max(0, bgVideo.currentTime - baseVideoTime);
      dt = Math.min(0.05, videoDelta);
      if(bgVideo.currentTime + 0.01 < baseVideoTime){
        finishGame('end');
        return;
      }
      baseVideoTime = bgVideo.currentTime;
    }

    update(dt);
    draw();

    // judgement fade
    if(judgement){
      judgement.t += dt*1000;
      if(judgement.t > 700){ judgEl.style.opacity = '0'; judgement = null; }
    }

    // update HUD
    scoreEl.textContent = score;
    comboEl.textContent = combo;

    requestAnimationFrame(loop);
  }

  function computeAccuracy(){
    const total = perfectCount + goodCount + missCount;
    if(total <= 0) return 0;
    const raw = (perfectCount + goodCount * 0.7) / total * 100;
    return Math.max(0, Math.min(100, raw));
  }

  function computeRank(accuracy){
    for(const entry of RANK_THRESHOLDS){
      if(accuracy >= entry.min) return entry.grade;
    }
    return 'D';
  }

  function showResultOverlay(titleText){
    const accuracy = computeAccuracy();
    const grade = computeRank(accuracy);
    if(resultTitle) resultTitle.textContent = titleText;
    if(resultScore) resultScore.textContent = score;
    if(resultMaxCombo) resultMaxCombo.textContent = maxCombo;
    if(resultPerfect) resultPerfect.textContent = perfectCount;
    if(resultGood) resultGood.textContent = goodCount;
    if(resultMiss) resultMiss.textContent = missCount;
    if(resultAccuracy) resultAccuracy.textContent = `${accuracy.toFixed(1)}%`;
    if(resultRank) resultRank.textContent = grade;
    if(resultOverlay) resultOverlay.style.display = 'flex';
  }

  function finishGame(reason){
    if(ended) return;
    ended = true;
    if(bgVideo) bgVideo.pause();
    if(reason === 'gameover'){
      showResultOverlay('GAME OVER');
    } else {
      showResultOverlay('RESULT');
    }
  }

  function resetGameState(){
    notes = [];
    spawnTimer = 0;
    score = 0;
    combo = 0;
    maxCombo = 0;
    perfectCount = 0;
    goodCount = 0;
    missCount = 0;
    life = LIFE_MAX;
    ended = false;
    judgement = null;
    judgEl.textContent = '';
    judgEl.style.opacity = '0';
    jammerQueue = [];
    lastJammerAt = -Infinity;
    if(resultOverlay) resultOverlay.style.display = 'none';
    updateLifeHud();
  }

  function startGame(selectedMode){
    if(started && !ended) return;
    mode = selectedMode;
    started = true;
    resetGameState();
    startOverlay.style.display = 'none';
    lastTime = performance.now();
    baseVideoTime = null;

    if(bgVideo){
      bgVideo.currentTime = 0;
      bgVideo.play().catch(()=>{});
    }

    requestAnimationFrame(loop);
  }

  // input handling: canvas pointer and lane buttons
  function canvasPointer(e){
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const lane = Math.floor(x / rect.width * LANES);
    onLaneTap(Math.max(0, Math.min(LANES-1, lane)));
  }
  canvas.addEventListener('pointerdown', canvasPointer);

  // overlay buttons
  document.querySelectorAll('.lane-btn').forEach(b=>{
    b.addEventListener('pointerdown', ev=>{
      ev.preventDefault();
      const lane = Number(b.dataset.lane);
      onLaneTap(lane);
    });
  });

  // keyboard shortcuts: D F J K
  window.addEventListener('keydown', (e)=>{
    const map = {'d':0,'f':1,'j':2,'k':3};
    const k = e.key.toLowerCase();
    if(k === 'r'){ toggleRecording(); return; }
    if(k in map){ onLaneTap(map[k]); }
  });

  if(startStreamer){
    startStreamer.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      startGame('streamer');
    });
  }

  if(startRank){
    startRank.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      startGame('rank');
    });
  }

  if(restartBtn){
    restartBtn.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      if(bgVideo) bgVideo.pause();
      startOverlay.style.display = 'flex';
      started = false;
      mode = null;
      updateLifeHud();
      if(resultOverlay) resultOverlay.style.display = 'none';
    });
  }

  if(chartCopy){
    chartCopy.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      if(!chartData) return;
      const text = chartData.value || '';
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).catch(()=>{});
      } else {
        chartData.focus();
        chartData.select();
        document.execCommand('copy');
      }
    });
  }

  // initial draw for static screen
  draw();
  updateLifeHud();

  // expose for debugging
  window._rhythm = {notes};

})();
