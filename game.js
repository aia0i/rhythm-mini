// Minimal rhythm game logic for 4 lanes, click/tap to hit notes
(function(){
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const stageEl = document.getElementById('stage');
  const hitLineEl = document.querySelector('.hitline');
  const hitLineDebug = document.getElementById('hitlineDebug');
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
  const bgmVolume = document.getElementById('bgmVolume');
  const bgmVolumeValue = document.getElementById('bgmVolumeValue');
  const uiScale100 = document.getElementById('uiScale100');
  const uiScale125 = document.getElementById('uiScale125');
  const uiScale150 = document.getElementById('uiScale150');
  const pauseBtn = document.getElementById('pauseBtn');
  const pauseOverlay = document.getElementById('pauseOverlay');
  const resumeBtn = document.getElementById('resumeBtn');
  const backToSettingsBtn = document.getElementById('backToSettingsBtn');

  const BASE_W = 1280;
  const BASE_H = 720;
  const LANES = 4;
  const HIT_LINE_OFFSET = 120; // base design offset from bottom
  const HIT_LINE_RATIO = (BASE_H - HIT_LINE_OFFSET) / BASE_H;
  const SPAWN_INTERVAL = 700; // ms
  const NOTE_SPEED = 320; // px per second

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
  const DEFAULT_BGM_VOLUME = 80;
  const BGM_VOLUME_STORAGE_KEY = 'rhythm_bgm_volume';
  const DEFAULT_UI_SCALE = 1.5;
  const UI_SCALE_STORAGE_KEY = 'rhythm_ui_scale';

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let stageRect = null;
  let hitLineY = BASE_H * HIT_LINE_RATIO;
  let travelTime = (hitLineY + 24) / NOTE_SPEED;
  let laneXs = [];
  let laneWidthStage = 0;
  function applyDPR(rect){
    const targetRect = rect || stageRect || (stageEl ? stageEl.getBoundingClientRect() : null);
    if(!targetRect) return;
    canvas.width = BASE_W * dpr;
    canvas.height = BASE_H * dpr;
    canvas.style.width = targetRect.width + 'px';
    canvas.style.height = targetRect.height + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function updateLayoutMetrics(reason){
    if(!stageEl) return;
    stageRect = stageEl.getBoundingClientRect();
    const stageHeight = Math.max(1, stageRect.height);
    const stageWidth = Math.max(1, stageRect.width);
    const hitLineYStage = stageHeight * HIT_LINE_RATIO;
    hitLineY = (hitLineYStage / stageHeight) * BASE_H;
    travelTime = (hitLineY + 24) / NOTE_SPEED;
    laneWidthStage = stageWidth / LANES;
    laneXs = Array.from({length: LANES}, (_, i) => i * laneWidthStage);

    if(hitLineEl){
      hitLineEl.style.top = `${hitLineYStage - 2}px`;
      hitLineEl.style.bottom = 'auto';
    }
    if(hitLineDebug){
      hitLineDebug.textContent = `hitLineY=${hitLineYStage.toFixed(1)}px`;
      hitLineDebug.style.top = `${Math.max(6, hitLineYStage - 26)}px`;
    }

    dpr = Math.max(1, window.devicePixelRatio || 1);
    applyDPR(stageRect);

    if(isMobileUi()){
      console.log('[layout] updateLayoutMetrics', reason || '');
    }
  }

  window.addEventListener('resize', ()=>{ updateLayoutMetrics('resize'); });
  window.addEventListener('orientationchange', ()=>{ updateLayoutMetrics('orientationchange'); });
  window.addEventListener('DOMContentLoaded', ()=>{ updateLayoutMetrics('domcontentloaded'); });

  // Game state
  let notes = [];
  let spawnTimer = 0;
  updateLayoutMetrics('init');

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
  let paused = false;
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
  let bgmVolumeValueState = DEFAULT_BGM_VOLUME;
  let uiScaleValue = DEFAULT_UI_SCALE;

  const PERFECT_WINDOW = 22;
  const GOOD_WINDOW = 55;
  const MISS_WINDOW = 80;

  let judgement = null; // {text, t, alpha}

  function getMediaTime(){
    return bgVideo ? bgVideo.currentTime : 0;
  }

  function clampVolume(value, fallback){
    if(Number.isNaN(value)) return fallback;
    return Math.max(0, Math.min(100, value));
  }

  function isMobileUi(){
    if(!window.matchMedia) return false;
    return window.matchMedia('(max-width: 720px)').matches || window.matchMedia('(pointer: coarse)').matches;
  }

  function getDefaultUiScale(){
    return isMobileUi() ? 1.5 : DEFAULT_UI_SCALE;
  }

  function normalizeUiScale(value, fallback){
    const allowed = [1, 1.25, 1.5];
    const base = fallback === undefined ? DEFAULT_UI_SCALE : fallback;
    if(Number.isNaN(value)) return base;
    for(const option of allowed){
      if(Math.abs(option - value) < 0.001) return option;
    }
    return base;
  }

  function readStoredUiScale(){
    if(!window.localStorage) return getDefaultUiScale();
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if(raw === null) return getDefaultUiScale();
    return normalizeUiScale(Number(raw), getDefaultUiScale());
  }

  function hasStoredUiScale(){
    if(!window.localStorage) return false;
    return window.localStorage.getItem(UI_SCALE_STORAGE_KEY) !== null;
  }

  function writeStoredUiScale(value){
    if(!window.localStorage) return;
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(value));
  }

  function applyUiScale(value, persist){
    uiScaleValue = normalizeUiScale(value, getDefaultUiScale());
    document.documentElement.style.setProperty('--ui-scale', String(uiScaleValue));
    if(uiScale100) uiScale100.checked = uiScaleValue === 1;
    if(uiScale125) uiScale125.checked = uiScaleValue === 1.25;
    if(uiScale150) uiScale150.checked = uiScaleValue === 1.5;
    if(persist) writeStoredUiScale(uiScaleValue);
  }

  function readStoredBgmVolume(){
    if(!window.localStorage) return DEFAULT_BGM_VOLUME;
    const raw = window.localStorage.getItem(BGM_VOLUME_STORAGE_KEY);
    return clampVolume(Number(raw), DEFAULT_BGM_VOLUME);
  }

  function hasStoredBgmVolume(){
    if(!window.localStorage) return false;
    return window.localStorage.getItem(BGM_VOLUME_STORAGE_KEY) !== null;
  }

  function writeStoredBgmVolume(value){
    if(!window.localStorage) return;
    window.localStorage.setItem(BGM_VOLUME_STORAGE_KEY, String(value));
  }

  function applyBgmVolume(value, persist){
    bgmVolumeValueState = clampVolume(value, DEFAULT_BGM_VOLUME);
    if(bgmVolume) bgmVolume.value = String(bgmVolumeValueState);
    if(bgmVolumeValue) bgmVolumeValue.textContent = String(bgmVolumeValueState);
    if(!bgVideo){
      console.error('[audio] bgVideo not found');
      if(persist) writeStoredBgmVolume(bgmVolumeValueState);
      return;
    }
    bgVideo.volume = Math.min(1, Math.max(0, bgmVolumeValueState / 100));
    console.log('[audio] set bgm volume:', bgVideo.volume);
    if(persist) writeStoredBgmVolume(bgmVolumeValueState);
  }

  function initVolumeControl(){
    if(!bgmVolume) return;
    applyBgmVolume(readStoredBgmVolume(), !hasStoredBgmVolume());
    bgmVolume.addEventListener('input', () => {
      applyBgmVolume(Number(bgmVolume.value), true);
    });
  }

  function initUiScaleControl(){
    applyUiScale(readStoredUiScale(), !hasStoredUiScale());
    const handler = (event) => {
      const value = Number(event.target.value);
      applyUiScale(value, true);
    };
    if(uiScale100) uiScale100.addEventListener('change', handler);
    if(uiScale125) uiScale125.addEventListener('change', handler);
    if(uiScale150) uiScale150.addEventListener('change', handler);
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

  let wsSocket = null;
  let wsReady = false;
  function setupWebSocket(){
    if(wsSocket && wsReady) return;
    try{
      wsSocket = new WebSocket(WS_URL);
    } catch (err){
      wsSocket = null;
      return;
    }
    wsReady = true;
    wsSocket.addEventListener('open', ()=>{
      console.log('[ws] connected');
    });
    wsSocket.addEventListener('message', (event)=>{
      if(mode !== 'streamer'){
        console.log('[ws] ignored (not streamer mode)');
        return;
      }
      if(!started || ended || paused) return;
      let payload = null;
      try{
        payload = JSON.parse(event.data);
      } catch (err){
        return;
      }
      if(!payload || payload.type !== 'spawn_notes' || !payload.jammer) return;
      console.log('[ws] received spawn_notes');
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
        const spawnTime = entry.t - travelTime;
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
      if(n.y > hitLineY + MISS_WINDOW){
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
      const dist = Math.abs(n.y - hitLineY);
      if(dist < bestDist){ bestDist = dist; bestIndex = i; }
    }
    if(bestIndex === -1){ showJudgement('MISS'); registerMiss(); return; }
    const dist = Math.abs(notes[bestIndex].y - hitLineY);
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
    if(ended || paused) return;
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
    ctx.fillRect(0,hitLineY-2,BASE_W,4);

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
    if(paused){
      lastTime = now;
      requestAnimationFrame(loop);
      return;
    }
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
    paused = false;
    if(pauseBtn) pauseBtn.disabled = true;
    if(pauseOverlay) pauseOverlay.style.display = 'none';
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
    paused = false;
    judgement = null;
    judgEl.textContent = '';
    judgEl.style.opacity = '0';
    chartIndex = 0;
    jammerQueue = [];
    lastJammerAt = -Infinity;
    if(toastTimer){
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if(toastEl) toastEl.style.display = 'none';
    if(resultOverlay) resultOverlay.style.display = 'none';
    if(pauseOverlay) pauseOverlay.style.display = 'none';
    if(pauseBtn) pauseBtn.textContent = 'Pause';
    updateLifeHud();
  }

  function startGame(selectedMode){
    if(started && !ended) return;
    mode = selectedMode;
    started = true;
    resetGameState();
    applyBgmVolume(bgmVolumeValueState, false);
    if(startOverlay){
      startOverlay.style.display = 'none';
      startOverlay.style.pointerEvents = 'none';
    }
    updateLayoutMetrics('startGame');
    if(pauseBtn) pauseBtn.disabled = false;
    lastTime = performance.now();
    baseVideoTime = null;

    if(bgVideo){
      bgVideo.currentTime = 0;
      applyBgmVolume(bgmVolumeValueState, false);
      bgVideo.play().catch(()=>{});
    }

    if(mode === 'streamer'){
      setupWebSocket();
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
      if(startOverlay){
        startOverlay.style.display = 'flex';
        startOverlay.style.pointerEvents = 'auto';
      }
      started = false;
      mode = null;
      paused = false;
      if(pauseOverlay) pauseOverlay.style.display = 'none';
      if(pauseBtn) pauseBtn.textContent = 'Pause';
      if(pauseBtn) pauseBtn.disabled = true;
      applyBgmVolume(bgmVolumeValueState, false);
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
  initVolumeControl();
  initUiScaleControl();
  if(pauseBtn) pauseBtn.disabled = true;

  if(bgVideo){
    bgVideo.addEventListener('loadedmetadata', () => {
      applyBgmVolume(bgmVolumeValueState, false);
    });
    bgVideo.addEventListener('canplay', () => {
      applyBgmVolume(bgmVolumeValueState, false);
    });
  }

  if(pauseBtn){
    pauseBtn.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      if(!started || ended) return;
      if(paused){
        paused = false;
        if(pauseOverlay) pauseOverlay.style.display = 'none';
        pauseBtn.textContent = 'Pause';
        if(bgVideo){
          applyBgmVolume(bgmVolumeValueState, false);
          bgVideo.play().catch(()=>{});
          baseVideoTime = bgVideo.currentTime;
        }
        lastTime = performance.now();
        return;
      }
      paused = true;
      if(bgVideo) bgVideo.pause();
      if(pauseOverlay) pauseOverlay.style.display = 'flex';
      pauseBtn.textContent = 'Resume';
    });
  }

  if(resumeBtn){
    resumeBtn.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      if(!started || ended || !paused) return;
      paused = false;
      if(pauseOverlay) pauseOverlay.style.display = 'none';
      if(pauseBtn) pauseBtn.textContent = 'Pause';
      if(bgVideo){
        applyBgmVolume(bgmVolumeValueState, false);
        bgVideo.play().catch(()=>{});
        baseVideoTime = bgVideo.currentTime;
      }
      lastTime = performance.now();
    });
  }

  if(backToSettingsBtn){
    backToSettingsBtn.addEventListener('pointerdown', (e)=>{
      e.preventDefault();
      if(bgVideo){
        bgVideo.pause();
        bgVideo.currentTime = 0;
      }
      resetGameState();
      started = false;
      mode = null;
      paused = false;
      ended = true;
      baseVideoTime = null;
      if(startOverlay){
        startOverlay.style.display = 'flex';
        startOverlay.style.pointerEvents = 'auto';
      }
      if(pauseOverlay) pauseOverlay.style.display = 'none';
      if(pauseBtn){
        pauseBtn.textContent = 'Pause';
        pauseBtn.disabled = true;
      }
      applyBgmVolume(bgmVolumeValueState, false);
    });
  }

  // expose for debugging
  window._rhythm = {notes};

})();

