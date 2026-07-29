/* =========================================================================
   나만의 어항 · 금붕어 먹이 주기
   -------------------------------------------------------------------------
   ▷ 어항 / 물고기 / 장식은 assets 폴더의 "원본 3D 렌더 이미지"를 그대로 사용.
       - assets/bowl.png : 유리 어항        (핑크 배경 위 1장)
       - assets/fish.png : 금붕어           (측면 + 정면, 회색 글로우 배경)
       - assets/deco.png : 수초/조개/크리스탈 등 10종 (5x2, 어두운 배경)

   ▷ 원본 파일에는 배경이 "구워져(baked)" 있으므로, 캔버스에 스프라이트로
     합성하려면 배경을 제거해야 한다. 기하 도형으로 새로 그리지 않고,
     로드한 이미지의 픽셀 데이터를 직접 조작(getImageData/putImageData)하여
     배경만 투명 처리한 뒤 "원본 픽셀 그대로" 사용한다.

   구성
     1) 이미지 로드
     2) 배경 제거(그라디언트 추종 flood-fill) + 스프라이트 크롭
     3) 물 영역(어항 내부 타원) 지오메트리
     4) 물고기 / 먹이 클래스 & 캔버스 애니메이션 루프
     5) 먹이 주기 입력 (마우스 폴백 / 웹캠 핀치)
     6) 장식 커스텀 & 초기화
     7) MediaPipe 손 인식
     8) 부트스트랩
   ========================================================================= */

'use strict';

/* ===== 에셋 경로 =========================================================== */
const ASSETS = {
  bowl: 'assets/bowl.png',
  fish: 'assets/fish.png',
  deco: 'assets/deco.png'
};

/* 물 영역 타원(어항 내부). bowl.png(정사각) 기준 0~1 비율.
   물고기가 유리 밖으로 나가면 이 값만 미세 조정. */
const WATER_FIT = { cx: 0.505, cy: 0.60, rx: 0.395, ry: 0.35 };

/* 장식 시트(5열 x 2행) 이름 (왼→오, 위→아래) */
const DECO_NAMES = [
  '청록 수초', '초록 수풀', '켈프', '보라 수초', '잔디',        // 윗줄
  '진주 조개', '유적 아치', '항아리', '크리스탈', '바위 동굴'   // 아랫줄
];
const DECO_COLS = 5, DECO_ROWS = 2;

/* =========================================================================
   DOM 참조
   ========================================================================= */
const bowl        = document.getElementById('bowl');
const bowlImg     = document.getElementById('bowlImg');
const decoLayer   = document.getElementById('decoLayer');
const canvas      = document.getElementById('fishCanvas');
const ctx         = canvas.getContext('2d');
const paletteEl   = document.getElementById('palette');
const hintEl      = document.getElementById('hint');
const camBtn      = document.getElementById('camBtn');
const addFishBtn  = document.getElementById('addFishBtn');
const resetBtn    = document.getElementById('resetBtn');
const restartBtn  = document.getElementById('restartBtn');
const camWrap     = document.getElementById('camWrap');
const camVideo    = document.getElementById('cam');
const handCursor  = document.getElementById('handCursor');
const placeBanner = document.getElementById('placeBanner');
const placeBannerText = document.getElementById('placeBannerText');
const placeCancel = document.getElementById('placeCancel');
const assetNote   = document.getElementById('assetNote');
const loadingEl   = document.getElementById('loading');

/* =========================================================================
   유틸
   ========================================================================= */
const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist  = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('load fail: ' + src));
    im.src = src;
  });
}

/* =========================================================================
   2. 배경 제거 (그라디언트 추종 flood-fill)
   -------------------------------------------------------------------------
   원본 배경은 "부드러운 그라디언트 + 글로우"라서 고정 색 chroma-key 로는
   못 지운다. 대신 테두리에서 시작해, 각 픽셀을 "바로 옆 배경 픽셀"과만
   비교하며 확산한다(지역 허용오차 tol).
     · 배경 그라디언트: 픽셀간 색차가 작아 tol 안에서 계속 확산 → 전부 제거
     · 물체 경계: 색이 급격히 점프 → tol 초과로 확산이 멈춤 → 물체 보존
   내부의 밝은 부분(진주/크리스탈/비늘 하이라이트)은 테두리와 연결되지
   않으므로 그대로 보존된다. 순수 픽셀 조작이며 도형을 새로 그리지 않는다.
   ========================================================================= */
function cutoutBackground(img, tol = 40, feather = true) {
  const w = img.width, h = img.height, N = w * h;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const id = x.getImageData(0, 0, w, h);
  const d = id.data;

  // 각 큐 항목이 "비교 기준"으로 삼는 이웃(배경) 색 — 지역 그라디언트 추종용
  const refR = new Uint8Array(N), refG = new Uint8Array(N), refB = new Uint8Array(N);
  const visited = new Uint8Array(N);
  const stack = new Int32Array(N);   // 인덱스 스택 (재귀 대신)
  let sp = 0;

  const seed = (idx, r, g, b) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    refR[idx] = r; refG[idx] = g; refB[idx] = b;
    stack[sp++] = idx;
  };

  // 테두리 픽셀을 시드로 (기준색 = 자기 자신 → 항상 배경으로 시작)
  for (let px = 0; px < w; px++) {
    let i = px;            let p = i * 4; seed(i, d[p], d[p + 1], d[p + 2]);
    i = (h - 1) * w + px;  p = i * 4;     seed(i, d[p], d[p + 1], d[p + 2]);
  }
  for (let py = 0; py < h; py++) {
    let i = py * w;        let p = i * 4; seed(i, d[p], d[p + 1], d[p + 2]);
    i = py * w + (w - 1);  p = i * 4;     seed(i, d[p], d[p + 1], d[p + 2]);
  }

  const tol2 = tol * tol;
  while (sp > 0) {
    const idx = stack[--sp];
    const p = idx * 4;
    // 기준(이웃 배경)색과의 거리 검사 → 초과하면 물체 경계이므로 확산 중단
    const dr = d[p]     - refR[idx];
    const dg = d[p + 1] - refG[idx];
    const db = d[p + 2] - refB[idx];
    if (dr * dr + dg * dg + db * db > tol2) continue;

    d[p + 3] = 0; // 배경 → 투명
    const px = idx % w, py = (idx / w) | 0;
    const r = d[p], g = d[p + 1], b = d[p + 2]; // 이 픽셀 색이 다음 비교 기준
    if (px > 0)     seed(idx - 1, r, g, b);
    if (px < w - 1) seed(idx + 1, r, g, b);
    if (py > 0)     seed(idx - w, r, g, b);
    if (py < h - 1) seed(idx + w, r, g, b);
  }

  /* 경계 페더링: 물체 가장자리에 남은 옅은 배경색 프린지를 줄인다.
     투명 픽셀과 맞닿은 불투명 경계 픽셀의 알파를 한 겹 낮춰 계단현상 완화. */
  if (feather) {
    const a0 = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) a0[i] = d[i * 4 + 3];
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const idx = py * w + px;
        if (a0[idx] === 0) continue;
        const left  = px > 0     ? a0[idx - 1] : 255;
        const right = px < w - 1 ? a0[idx + 1] : 255;
        const up    = py > 0     ? a0[idx - w] : 255;
        const down  = py < h - 1 ? a0[idx + w] : 255;
        if (left === 0 || right === 0 || up === 0 || down === 0) {
          d[idx * 4 + 3] = 150; // 반투명 경계 → 부드러운 외곽선
        }
      }
    }
  }

  x.putImageData(id, 0, 0);
  return c;
}

/* --- 알파 기준 타이트 크롭 (스프라이트 시트에서 개별 개체 잘라내기) ------- */
function trim(srcCanvas, sx, sy, sw, sh, alphaMin = 24, pad = 3) {
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sx = Math.max(0, sx | 0); sy = Math.max(0, sy | 0);
  sw = Math.min(srcCanvas.width - sx, sw | 0);
  sh = Math.min(srcCanvas.height - sy, sh | 0);
  const data = sctx.getImageData(sx, sy, sw, sh).data;
  let minX = sw, minY = sh, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (data[(y * sw + x) * 4 + 3] > alphaMin) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) { minX = 0; minY = 0; maxX = sw - 1; maxY = sh - 1; }
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(sw - 1, maxX + pad); maxY = Math.min(sh - 1, maxY + pad);
  const outW = maxX - minX + 1, outH = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  out.getContext('2d').drawImage(srcCanvas, sx + minX, sy + minY, outW, outH, 0, 0, outW, outH);
  return out;
}

/* --- 작은 섬(이웃 셀에서 삐져나온 조각) 제거 -----------------------------
   장식 셀을 격자로 자를 때 옆 칸의 잎끝 등이 조금 섞여 들어올 수 있다.
   연결요소(4-이웃)를 라벨링해, 가장 큰 덩어리 대비 일정 비율 미만의
   작은 조각들만 지운다. (진주·크리스탈 조각처럼 큰 부분은 보존)         */
function keepMainBlobs(cnv, minFrac = 0.08, alphaMin = 24) {
  const w = cnv.width, h = cnv.height, N = w * h;
  const g = cnv.getContext('2d', { willReadFrequently: true });
  const id = g.getImageData(0, 0, w, h);
  const d = id.data;
  const label = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes = [];
  let cur = 0;
  const solid = (i) => d[i * 4 + 3] > alphaMin;

  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || !solid(s)) continue;
    let sp = 0, cnt = 0; stack[sp++] = s; label[s] = cur;
    while (sp > 0) {
      const idx = stack[--sp]; cnt++;
      const px = idx % w, py = (idx / w) | 0;
      const nb = [px > 0 ? idx - 1 : -1, px < w - 1 ? idx + 1 : -1,
                  py > 0 ? idx - w : -1, py < h - 1 ? idx + w : -1];
      for (const n of nb) if (n >= 0 && label[n] === -1 && solid(n)) { label[n] = cur; stack[sp++] = n; }
    }
    sizes.push(cnt); cur++;
  }
  if (!sizes.length) return cnv;
  const max = Math.max(...sizes), thresh = max * minFrac;
  for (let i = 0; i < N; i++) {
    const l = label[i];
    if (l >= 0 && sizes[l] < thresh) d[i * 4 + 3] = 0; // 작은 조각 → 투명
  }
  g.putImageData(id, 0, 0);
  return cnv;
}

/* =========================================================================
   에셋 준비물 (로드 후 채워짐)
   ========================================================================= */
let fishSide  = null;   // 측면 금붕어 (스프라이트는 오른쪽을 바라봄)
let fishFront = null;   // 정면 금붕어 (카메라를 바라봄)
const DECOS   = [];     // { name, canvas, url, aspect }

/* --- 어항 코너 색을 페이지 배경으로 → 사진과 화면 경계가 자연스럽게 --- */
function applyBowlBackground(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const px = (X, Y) => { const p = x.getImageData(X, Y, 1, 1).data; return `rgb(${p[0]},${p[1]},${p[2]})`; };
  const edge = px(6, 6);
  const mid  = px((img.width / 2) | 0, (img.height * 0.30) | 0);
  document.body.style.background =
    `radial-gradient(130% 100% at 50% 34%, ${mid} 0%, ${edge} 100%)`;
}

/* --- 물고기 시트에서 측면/정면 두 스프라이트 추출 ---
   fish.png: 왼쪽 = 측면(오른쪽 바라봄), 오른쪽 = 정면.
   배경 제거 후 좌/우 영역을 각각 알파 bbox 로 크롭. */
function extractFish(cut) {
  const w = cut.width, h = cut.height;
  fishSide  = trim(cut, 0,               0, Math.round(w * 0.56), h);
  fishFront = trim(cut, Math.round(w * 0.56), 0, Math.round(w * 0.44), h);
}

/* --- 장식 시트를 5x2 격자로 잘라 개별 스프라이트로 ---
   윗줄(키 큰 수초)이 아랫줄보다 커서 행 경계를 0.62 로 둔다. */
function extractDecos(cut) {
  const w = cut.width, h = cut.height;
  const colW = w / DECO_COLS;
  const rowBounds = [
    [0, Math.round(h * 0.62)],           // 윗줄
    [Math.round(h * 0.62), h]            // 아랫줄
  ];
  let n = 0;
  for (let row = 0; row < DECO_ROWS; row++) {
    const [y0, y1] = rowBounds[row];
    for (let col = 0; col < DECO_COLS; col++) {
      const cell = keepMainBlobs(trim(cut, Math.round(col * colW), y0, Math.round(colW), y1 - y0));
      DECOS.push({
        name: DECO_NAMES[n] || ('장식 ' + (n + 1)),
        canvas: cell,
        url: cell.toDataURL('image/png'),
        aspect: cell.height / cell.width
      });
      n++;
    }
  }
}

/* =========================================================================
   3. 물 영역(타원) 지오메트리
   ========================================================================= */
const WATER = { cx: 0, cy: 0, rx: 0, ry: 0, w: 0, h: 0 };

function resize() {
  const rect = bowl.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  WATER.w = rect.width; WATER.h = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  WATER.cx = WATER_FIT.cx * rect.width;
  WATER.cy = WATER_FIT.cy * rect.height;
  WATER.rx = WATER_FIT.rx * rect.width;
  WATER.ry = WATER_FIT.ry * rect.height;
}
window.addEventListener('resize', resize);

// 타원 안으로 좌표 가두기 (margin: px)
function clampToWater(x, y, margin = 0) {
  const rx = Math.max(1, WATER.rx - margin), ry = Math.max(1, WATER.ry - margin);
  const nx = (x - WATER.cx) / rx, ny = (y - WATER.cy) / ry;
  const d = Math.hypot(nx, ny);
  if (d > 1) return { x: WATER.cx + (nx / d) * rx, y: WATER.cy + (ny / d) * ry, hit: true };
  return { x, y, hit: false };
}
function insideWater(x, y, scale = 1) {
  const nx = (x - WATER.cx) / (WATER.rx * scale), ny = (y - WATER.cy) / (WATER.ry * scale);
  return nx * nx + ny * ny <= 1;
}
function randomTarget() {
  const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * 0.82;
  return { x: WATER.cx + Math.cos(a) * WATER.rx * rr, y: WATER.cy + Math.sin(a) * WATER.ry * rr };
}

/* =========================================================================
   4. 물고기 & 먹이
   ========================================================================= */
// 측면 스프라이트에서 눈의 대략적 위치(비율) — 죽었을 때 X 표시에 사용
const EYE_SIDE = { x: 0.70, y: 0.40 };

/* 마우스 커서 추적(어항 내부 좌표). 일정 시간 움직임이 없으면 "정지"로 보고
   물고기가 커서 주위를 맴돌게 한다. pointermove 핸들러가 값을 갱신한다. */
const cursor = { x: 0, y: 0, inside: false, lastMove: 0 };
function cursorIsResting() {
  return cursor.inside && insideWater(cursor.x, cursor.y, 1.0) && (Date.now() - cursor.lastMove > 450);
}

class Fish {
  constructor(sizeFactor) {
    const p = randomTarget();
    this.x = p.x; this.y = p.y;
    this.vx = rand(-0.6, 0.6); this.vy = 0;
    this.sizeFactor = sizeFactor;      // 몸 너비 = sizeFactor * 어항너비 (고정)
    this.eaten = 0;                    // 먹은 먹이 수(참고용)
    this.dead = false; this.deadAt = 0;
    this.held = false;                 // 마우스로 잡고 드래그 중인지
    this.orbitPhase = rand(0, 6.28);   // 커서 주위를 맴돌 때 개체별 위상
    this.smileUntil = 0;               // 문질문질 → 정면(웃는 얼굴) 유지 시각
    this.target = randomTarget();
    this.retarget = rand(80, 200);
    this.face = this.vx < 0 ? -1 : 1;  // 측면 스프라이트 좌우 반전용
    this.happy = 0;                    // 먹은 직후 살짝 커지는 연출
    this.wob = rand(0, 6.28);
    this.maxSpeed = rand(1.3, 1.7);
    this.view = 'side';                // 'side' | 'front'
    this.viewHold = 0;                 // 스프라이트 전환 히스테리시스
  }
  get bodyW() { return this.sizeFactor * WATER.w; }
  get smiling() { return Date.now() < this.smileUntil; }

  // 먹이 1개 섭취 (과식 발동은 "10초 내 급여량"으로 전역 판정 → registerFeed)
  eat() {
    this.eaten++;
    this.happy = 40;
  }
  die() {
    this.dead = true; this.deadAt = Date.now();
    this.vx = rand(-0.4, 0.4); this.vy = -0.5;     // 살짝 떠오르며 시작
    if (firstDeathAt === 0) firstDeathAt = Date.now();
  }

  update(foods) {
    const sf = WATER.w / 620;          // 어항 크기에 비례한 속도 보정

    // --- 죽은 물고기: 배를 위로 하고 수면으로 떠올라 흔들림 ---
    if (this.dead) {
      this.vy += (-0.35 - this.vy) * 0.03;                 // 부력(위로)
      this.vx *= 0.985;
      this.x += this.vx + Math.sin(Date.now() / 500 + this.wob) * 0.25;
      this.y += this.vy;
      const topY = WATER.cy - WATER.ry * 0.72;             // 수면 근처에서 멈춤
      if (this.y < topY) { this.y = topY; this.vy *= -0.2; }
      const c = clampToWater(this.x, this.y, this.bodyW * 0.4);
      if (c.hit) { this.x = c.x; this.vx *= -0.5; }
      this.wob += 0.05;
      return;
    }

    // --- 손으로 잡고 드래그 중: AI 정지, 위치는 드래그 핸들러가 제어 ---
    if (this.held) {
      this.view = 'front';           // 잡으면 이쪽을 바라봄
      this.vx = 0; this.vy = 0;
      this.wob += 0.1;
      return;
    }

    let feeding = false, nearest = null, nd = Infinity;
    for (const f of foods) {
      const d = dist(this.x, this.y, f.x, f.y);
      if (d < nd) { nd = d; nearest = f; }
    }

    if (nearest) {
      // 먹이가 있으면 최우선으로 다가가 먹는다
      feeding = true;
      this.target = { x: nearest.x, y: nearest.y };
      if (nd < this.bodyW * 0.45) { nearest.eaten = true; this.eat(); }
    } else if (cursorIsResting()) {
      // 마우스를 가만히 두면 커서 주위를 원을 그리며 맴돈다
      const rad = this.bodyW * 1.15 + 16 * sf;
      const ang = Date.now() * 0.0022 + this.orbitPhase;
      const t = clampToWater(cursor.x + Math.cos(ang) * rad, cursor.y + Math.sin(ang) * rad, this.bodyW * 0.4);
      this.target = { x: t.x, y: t.y };
    } else if (--this.retarget <= 0) {
      this.target = randomTarget(); this.retarget = rand(80, 220);
    }

    // 조향(steering) — 문질문질(웃는) 중이면 느긋하게 맴돈다
    const dx = this.target.x - this.x, dy = this.target.y - this.y;
    const d = Math.hypot(dx, dy) || 1;
    const calm = this.smiling ? 0.35 : 1;
    const speed = (feeding ? this.maxSpeed * 1.7 : this.maxSpeed) * sf * calm;
    const ease = feeding ? 0.10 : 0.04;
    this.vx += ((dx / d) * speed - this.vx) * ease;
    this.vy += ((dy / d) * speed - this.vy) * ease;
    if (!feeding) this.vy += Math.sin(Date.now() / 700 + this.wob) * 0.02 * sf;

    this.x += this.vx; this.y += this.vy;

    // 경계 반사
    const c = clampToWater(this.x, this.y, this.bodyW * 0.42);
    if (c.hit) { this.x = c.x; this.y = c.y; this.vx *= -0.4; this.vy *= -0.4; this.target = randomTarget(); }

    if (this.vx > 0.15) this.face = 1; else if (this.vx < -0.15) this.face = -1;
    if (this.happy > 0) this.happy--;
    this.wob += 0.2;

    /* 스프라이트 선택.
       - 문질문질(smiling) 중이면 강제로 정면(웃는 얼굴).
       - 아니면 수평 이동이 뚜렷하면 측면, 수직/정지 위주면 정면(히스테리시스). */
    if (this.smiling) { this.view = 'front'; this.viewHold = 0; }
    else {
      const sp = Math.hypot(this.vx, this.vy) + 0.001;
      const wantFront = Math.abs(this.vx) / sp < 0.42;
      if (wantFront !== (this.view === 'front')) {
        if (++this.viewHold > 16) { this.view = wantFront ? 'front' : 'side'; this.viewHold = 0; }
      } else this.viewHold = 0;
    }
  }

  draw(ctx) {
    if (this.dead) { this.drawDead(ctx); return; }

    const front = this.view === 'front' && fishFront;
    const sprite = front ? fishFront : fishSide;
    if (!sprite) return;
    const bw = this.bodyW, bh = bw * (sprite.height / sprite.width);
    const tilt = clamp(Math.atan2(this.vy, Math.abs(this.vx) + 0.001), -0.35, 0.35);
    let pop = this.happy > 0 ? 1 + (this.happy / 40) * 0.07 : 1;
    if (this.smiling) pop *= 1.06;     // 웃을 때 살짝 통통하게

    ctx.save();
    ctx.translate(this.x, this.y);
    if (front) {
      // 정면: 진행 방향으로 살짝 기울이고, 좌우 이동감만 약하게 반영
      ctx.rotate(clamp(this.vx * 0.03, -0.2, 0.2));
      ctx.scale(pop, pop);
    } else {
      // 측면: 스프라이트는 오른쪽을 보므로 왼쪽 이동시 반전
      ctx.rotate(this.face === 1 ? tilt : -tilt);
      ctx.scale(this.face * pop, pop);
    }
    ctx.drawImage(sprite, -bw / 2, -bh / 2, bw, bh);
    ctx.restore();
  }

  // 죽은 모습: 측면 스프라이트를 상하 반전(배 위로) + 회색빛 + 눈에 X
  drawDead(ctx) {
    const sprite = fishSide; if (!sprite) return;
    const bw = this.bodyW, bh = bw * (sprite.height / sprite.width);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.scale(this.face, -1);                         // 상하 반전(배 위로)
    ctx.globalAlpha = 0.92;
    const canFilter = 'filter' in ctx;
    if (canFilter) ctx.filter = 'grayscale(0.55) brightness(1.08)';
    ctx.drawImage(sprite, -bw / 2, -bh / 2, bw, bh);
    if (canFilter) ctx.filter = 'none';
    // 눈 위치에 검은 X (스프라이트와 같은 변환 공간이라 뒤집혀도 눈에 정확히 겹침)
    const ex = -bw / 2 + EYE_SIDE.x * bw, ey = -bh / 2 + EYE_SIDE.y * bh, s = bw * 0.06;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth = Math.max(1.5, bw * 0.022);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ex - s, ey - s); ctx.lineTo(ex + s, ey + s);
    ctx.moveTo(ex + s, ey - s); ctx.lineTo(ex - s, ey + s);
    ctx.stroke();
    ctx.restore();
  }
}

/* 먹이 = 간단한 갈색 동그라미(사료 알갱이).
   물고기/장식은 원본 이미지를 쓰지만, 먹이는 요청에 따라 단순 도형으로 그린다. */
class Food {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.vx = rand(-0.3, 0.3); this.vy = 0.2;
    this.eaten = false; this.life = 900;
    this.r = rand(0.006, 0.009) * WATER.w;   // 알갱이 반지름 (어항 크기 비례)
  }
  update() {
    this.vy += 0.05; this.vy *= 0.96; this.vx *= 0.97;  // 물속에서 천천히 가라앉음
    this.x += this.vx; this.y += this.vy;
    const c = clampToWater(this.x, this.y, 6);
    if (c.hit) { this.x = c.x; this.y = c.y; this.vy = 0; this.vx *= 0.8; }
    this.life--;
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.life / 120);
    // 입체감 있는 갈색 알갱이: 밝은 중심 → 진한 갈색 가장자리
    const g = ctx.createRadialGradient(
      this.x - this.r * 0.35, this.y - this.r * 0.35, this.r * 0.1,
      this.x, this.y, this.r
    );
    g.addColorStop(0, '#c9915a');
    g.addColorStop(0.55, '#9c6634');
    g.addColorStop(1, '#5f3c1c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* 물방울: 바닥 근처에서 생겨 수면(타원 위쪽)으로 천천히 떠오른 뒤 사라짐.
   과하지 않게 개수/생성빈도를 제한한다. (단순 원 — 물고기/장식과 무관) */
class Bubble {
  constructor() {
    const sf = WATER.w / 620;
    // 물 영역 하단부에서 랜덤 위치 스폰
    this.x = WATER.cx + rand(-0.7, 0.7) * WATER.rx;
    this.y = WATER.cy + rand(0.45, 0.85) * WATER.ry;
    this.r = rand(1.4, 3.6) * sf;
    this.vy = -rand(0.25, 0.6) * sf;      // 위로 상승
    this.wobAmp = rand(0.2, 0.7) * sf;    // 좌우 흔들림 폭
    this.wobPhase = rand(0, 6.28);
    this.alpha = 0;                       // 서서히 나타남
    this.dead = false;
  }
  update() {
    this.wobPhase += 0.06;
    this.y += this.vy;
    this.x += Math.sin(this.wobPhase) * this.wobAmp * 0.15;
    this.alpha = Math.min(this.alpha + 0.03, 0.55);  // 페이드 인
    // 수면(타원 상단) 근처에 도달하면 사라짐
    const surfaceY = WATER.cy - WATER.ry * 0.82;
    if (this.y <= surfaceY) { this.alpha -= 0.06; if (this.alpha <= 0) this.dead = true; }
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.alpha);
    // 유리구슬 같은 물방울: 옅은 채움 + 흰 테두리 + 작은 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(0.6, this.r * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(this.x - this.r * 0.32, this.y - this.r * 0.32, this.r * 0.32, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* ---- 개체 & 루프 ---- */
const fishes = [], foods = [], bubbles = [];
const MAX_BUBBLES = 7;          // 동시 최대치(과하지 않게)
let bubbleTimer = 40;           // 다음 물방울까지 프레임 수
let firstDeathAt = 0;           // 첫 죽음 시각(0=없음) → 5초 뒤 재시작 버튼

/* 과식 이벤트: "10초(FEED_WINDOW) 안에 먹이 30개(FEED_THRESHOLD) 이상"을
   주면 발동. 그 속도에 못 미치면 발동하지 않는다. feedTimes 에 각 먹이 투하
   시각을 기록하고, 최근 10초 개수가 임계치를 넘으면 이벤트 1회 발동 후 리셋. */
const FEED_WINDOW = 10000, FEED_THRESHOLD = 30;
let feedTimes = [];

const MAX_FISH = 10;
function initScene() {
  resize();
  fishes.length = 0;
  fishes.push(new Fish(0.18));   // 기본: 금붕어 한 마리
}
// "물고기 추가" 버튼: 최대치까지 랜덤 크기 금붕어를 한 마리씩 추가
function addFish() {
  if (fishes.length >= MAX_FISH) { flashBtn(addFishBtn, '가득 찼어요'); return; }
  fishes.push(new Fish(rand(0.12, 0.19)));
}
// 버튼에 잠깐 안내 텍스트를 보여주는 소소한 피드백
let btnFlashTimer = null;
function flashBtn(btn, msg) {
  const prev = btn.dataset.label || btn.textContent;
  btn.dataset.label = prev;
  btn.textContent = msg;
  clearTimeout(btnFlashTimer);
  btnFlashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 900);
}
function loop() {
  ctx.clearRect(0, 0, WATER.w, WATER.h);

  // 물방울 스폰(간헐적) + 갱신 + 그리기 (물고기 뒤 레이어)
  if (--bubbleTimer <= 0 && bubbles.length < MAX_BUBBLES) {
    bubbles.push(new Bubble());
    bubbleTimer = rand(45, 100);   // 생성 간격을 넓게 두어 은은하게
  }
  for (const b of bubbles) { b.update(); b.draw(ctx); }
  for (let i = bubbles.length - 1; i >= 0; i--) if (bubbles[i].dead) bubbles.splice(i, 1);

  for (const f of foods) { f.update(); f.draw(ctx); }
  for (let i = foods.length - 1; i >= 0; i--) if (foods[i].eaten || foods[i].life <= 0) foods.splice(i, 1);
  for (const fish of fishes) { fish.update(foods); fish.draw(ctx); }

  // 죽은 물고기가 있으면 5초 뒤 "다시 시작하기" 버튼 노출
  const anyDead = firstDeathAt !== 0;
  if (anyDead && Date.now() - firstDeathAt >= 5000) restartBtn.hidden = false;

  requestAnimationFrame(loop);
}

/* =========================================================================
   5. 먹이 주기 입력
   ========================================================================= */
// client 좌표 → 캔버스(어항) 로컬 좌표
function canvasXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}
// 좌표 아래의 살아있는 물고기(가장 가까운 것) 찾기
function fishAt(x, y) {
  let hit = null, hd = Infinity;
  for (const f of fishes) {
    if (f.dead) continue;
    const d = dist(x, y, f.x, f.y);
    if (d < f.bodyW * 0.6 && d < hd) { hd = d; hit = f; }
  }
  return hit;
}

// 먹이 투하 + 급여 기록(과식 판정용)
function dropFoodAtClient(clientX, clientY) {
  const p = canvasXY(clientX, clientY);
  if (!insideWater(p.x, p.y, 1.04)) return;      // 물 밖이면 무시
  const c = clampToWater(p.x, p.y, 8);
  const now = Date.now();
  foods.push(new Food(c.x, c.y)); registerFeed(now);
  if (Math.random() < 0.6) { foods.push(new Food(c.x + rand(-8, 8), c.y - rand(4, 12))); registerFeed(now); }
  fadeHint();
}

// 급여 기록 → 최근 10초 개수가 임계치 이상이면 과식 이벤트 1회 발동
function registerFeed(now) {
  feedTimes.push(now);
  const cutoff = now - FEED_WINDOW;
  while (feedTimes.length && feedTimes[0] < cutoff) feedTimes.shift();  // 오래된 기록 제거
  if (feedTimes.length >= FEED_THRESHOLD) {
    feedTimes = [];            // 창 리셋(연속 발동 방지)
    triggerOverfeed();
  }
}

// 과식 이벤트: 살아있는 물고기 중 하나에게 랜덤으로 새끼 탄생 or 죽음
function triggerOverfeed() {
  const alive = fishes.filter(f => !f.dead && !f.held);
  if (!alive.length) return;
  const fish = alive[Math.floor(Math.random() * alive.length)];
  if (Math.random() < 0.5 && fishes.length < MAX_FISH) {
    fishes.push(new Fish(rand(0.08, 0.11)));   // 새끼 물고기 탄생
  } else {
    fish.die();                                // 과식으로 죽음
  }
}

/* ---- 포인터: 커서 추적 · 물고기 드래그 · 문질문질 · 먹이 주기 ---- */
let draggingFish = null;

bowl.addEventListener('pointerdown', (e) => {
  if (placingKey !== null) return;               // 장식 배치 모드면 배치가 처리
  if (e.target.closest('.deco')) return;         // 장식 드래그 중이면 무시
  const p = canvasXY(e.clientX, e.clientY);
  const f = fishAt(p.x, p.y);
  if (f) {                                       // 물고기를 잡으면 → 드래그 시작(먹이 X)
    draggingFish = f; f.held = true;
    try { bowl.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  dropFoodAtClient(e.clientX, e.clientY);         // 빈 물 클릭 → 먹이
});

/* pointermove: 커서 위치 갱신 + (드래그 중이면) 물고기 이동 +
   문질문질(커서를 물고기 위에서 움직이면 정면 웃는 얼굴 2초 유지). */
bowl.addEventListener('pointermove', (e) => {
  const p = canvasXY(e.clientX, e.clientY);
  cursor.x = p.x; cursor.y = p.y; cursor.inside = true; cursor.lastMove = Date.now();

  if (draggingFish) {                            // 드래그: 물고기를 물 안에서 이동
    const c = clampToWater(p.x, p.y, draggingFish.bodyW * 0.45);
    draggingFish.x = c.x; draggingFish.y = c.y;
    return;
  }
  if (placingKey !== null) return;
  for (const f of fishes) {                       // 문질문질 → 웃는 얼굴
    if (f.dead) continue;
    if (dist(p.x, p.y, f.x, f.y) < f.bodyW * 0.6) f.smileUntil = Date.now() + 2000;
  }
});

function endFishDrag(e) {
  if (!draggingFish) return;
  draggingFish.held = false;
  draggingFish.smileUntil = Date.now() + 800;     // 놓으면 잠깐 웃는 얼굴
  draggingFish = null;
  try { bowl.releasePointerCapture(e.pointerId); } catch (_) {}
}
bowl.addEventListener('pointerup', endFishDrag);
bowl.addEventListener('pointercancel', endFishDrag);
bowl.addEventListener('pointerleave', () => { cursor.inside = false; });

let hintFaded = false;
function fadeHint() { if (!hintFaded) { hintFaded = true; hintEl.style.opacity = '0'; } }

/* =========================================================================
   6. 장식 커스텀 & 초기화
   ========================================================================= */
let placingKey = null;

function buildPalette() {
  paletteEl.replaceChildren();
  DECOS.forEach((deco, i) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.type = 'button'; b.title = deco.name;
    b.setAttribute('aria-label', deco.name + ' 배치');
    const im = document.createElement('img'); im.src = deco.url; im.alt = deco.name;
    b.appendChild(im);
    b.addEventListener('click', () => selectDeco(i, b));
    paletteEl.appendChild(b);
  });
}
function selectDeco(i, btn) {
  if (placingKey === i) { cancelPlacing(); return; }
  placingKey = i;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  btn.classList.add('selected');
  bowl.classList.add('placing');
  placeBannerText.textContent = `‘${DECOS[i].name}’ 을(를) 놓을 위치를 클릭하세요`;
  placeBanner.hidden = false;
}
function cancelPlacing() {
  placingKey = null;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  bowl.classList.remove('placing');
  placeBanner.hidden = true;
}
placeCancel.addEventListener('click', cancelPlacing);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPlacing(); });

// 배치 모드에서 어항 클릭 → 장식 생성
bowl.addEventListener('click', (e) => {
  if (placingKey === null) return;
  const rect = bowl.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  if (!insideWater(px, py, 1)) return;
  addDeco(placingKey, px / rect.width, py / rect.height);
  cancelPlacing();
});

/* 배치된 장식: 원본 이미지 <img> 를 그대로 사용(도형 변형 없음).
   물 속 깊이감을 위해 아래쪽일수록 약간 작고 어둡게(원근/수심) 처리. */
function addDeco(i, fx, fy) {
  const deco = DECOS[i];
  const el = document.createElement('div');
  el.className = 'deco';
  el.style.left = (fx * 100) + '%';
  el.style.top = (fy * 100) + '%';
  // 조개/바위처럼 넓은 것은 크게, 키 큰 수초는 살짝 작게 (종횡비로 조정)
  const baseW = deco.aspect > 1.6 ? 12 : 17;   // 어항 너비 대비 %
  el.style.width = baseW + '%';
  const im = document.createElement('img');
  im.src = deco.url; im.alt = deco.name;
  el.appendChild(im);
  applyDepth(el, fy);
  makeDraggable(el);
  el.addEventListener('dblclick', () => el.remove()); // 더블클릭 제거
  decoLayer.appendChild(el);
}

// 수심 깊이감: 물속에 잠긴 느낌(살짝 흐림 + 채도/명도 저하)
function applyDepth(el, fy) {
  const depth = clamp((fy - 0.45) / 0.5, 0, 1);   // 아래로 갈수록 1
  el.style.filter =
    `drop-shadow(0 ${3 + depth * 4}px ${5 + depth * 5}px rgba(70,40,110,.30)) ` +
    `saturate(${1 - depth * 0.12}) brightness(${1 - depth * 0.06}) blur(${depth * 0.4}px)`;
  el.style.opacity = String(0.96 - depth * 0.08);
}

function makeDraggable(el) {
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (placingKey !== null) return;
    e.stopPropagation();
    dragging = true; el.classList.add('dragging'); el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = bowl.getBoundingClientRect();
    const c = clampToWater(e.clientX - rect.left, e.clientY - rect.top, 8);
    const fx = c.x / rect.width, fy = c.y / rect.height;
    el.style.left = (fx * 100) + '%';
    el.style.top = (fy * 100) + '%';
    applyDepth(el, fy);
  });
  const end = (e) => { dragging = false; el.classList.remove('dragging'); try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

addFishBtn.addEventListener('click', addFish);

// 물고기만 건강한 한 마리로 되돌린다 (죽음/과식 상태 해제)
function respawnFish() {
  fishes.length = 0;
  fishes.push(new Fish(0.18));
  foods.length = 0;
  feedTimes = [];              // 급여 기록 초기화
  draggingFish = null;
  firstDeathAt = 0;
  restartBtn.hidden = true;
}

// 초기화: 장식·먹이 제거 + 물고기 한 마리로
resetBtn.addEventListener('click', () => {
  decoLayer.replaceChildren();   // 배치한 장식 모두 제거
  respawnFish();
  cancelPlacing();
});

// 죽었을 때 나오는 "다시 시작하기": 장식은 그대로 두고 물고기만 되살림
restartBtn.addEventListener('click', respawnFish);

/* =========================================================================
   7. 웹캠 손 인식 (MediaPipe Hands)
   -------------------------------------------------------------------------
   설계 원칙:
     · "카메라 켜기"와 "손 인식"을 분리한다. 카메라는 표준 getUserMedia 로
       먼저 켠다 → MediaPipe 로드가 실패해도 카메라 미리보기는 뜬다.
     · MediaPipe Hands 는 버전 고정 + CDN 폴백(jsdelivr→unpkg)으로 안정 로드.
     · 프레임 공급은 camera_utils 없이 자체 rAF 루프로 처리(의존성 축소).
     · 실패 원인(권한/보안컨텍스트/장치없음)을 구분해 안내한다.
   ========================================================================= */
const MP_VER = '0.4.1675469240';           // MediaPipe Hands 고정 버전
const MP_BASES = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MP_VER}`,
  `https://unpkg.com/@mediapipe/hands@${MP_VER}`
];
let camActive = false, hands = null, lastDrop = 0, noHandFrames = 0;
let camRAF = 0, sending = false, mpBaseUsed = MP_BASES[0];

camBtn.addEventListener('click', () => { camActive ? stopCam() : startCam(); });

// <script> 동적 로드 (CDN 폴백용)
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = () => res();
    s.onerror = () => rej(new Error('script load fail: ' + src));
    document.head.appendChild(s);
  });
}

// MediaPipe Hands 전역(Hands)이 준비될 때까지 여러 CDN 을 시도
async function ensureHands() {
  if (typeof Hands !== 'undefined') return true;
  for (const base of MP_BASES) {
    try {
      await loadScript(base + '/hands.js');
      if (typeof Hands !== 'undefined') { mpBaseUsed = base; return true; }
    } catch (e) { console.warn(e); }
  }
  return typeof Hands !== 'undefined';
}

// 카메라 프레임을 MediaPipe 로 계속 전달(중첩 방지 위해 sending 플래그 사용)
async function pumpFrames() {
  if (!camActive) return;
  if (hands && !sending && camVideo.readyState >= 2) {
    sending = true;
    try { await hands.send({ image: camVideo }); } catch (e) { /* 프레임 스킵 */ }
    sending = false;
  }
  camRAF = requestAnimationFrame(pumpFrames);
}

async function startCam() {
  // 1) 보안 컨텍스트 확인 (getUserMedia 는 HTTPS 또는 localhost 필요)
  const host = location.hostname;
  const localOk = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!window.isSecureContext && !localOk) {
    alert('웹캠은 보안 연결에서만 켜집니다.\n· GitHub Pages(https) 로 접속하거나\n· 로컬은 http://localhost 로 열어주세요.\n(파일을 더블클릭한 file:// 주소로는 제한될 수 있어요.)');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('이 브라우저는 웹캠(getUserMedia)을 지원하지 않습니다.');
    return;
  }

  camBtn.disabled = true;
  camBtn.textContent = '켜는 중…';
  try {
    // 2) 카메라부터 켠다 (MediaPipe 와 무관하게 미리보기 확보)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    camVideo.srcObject = stream;
    camVideo.setAttribute('playsinline', '');
    await camVideo.play().catch(() => {});   // 자동재생 정책 대비

    camActive = true;
    camBtn.textContent = '웹캠 끄기';
    camBtn.setAttribute('aria-pressed', 'true');
    camWrap.hidden = false;

    // 3) 손 인식 로드 & 시작 (실패해도 카메라는 유지 → 클릭 폴백 안내)
    const ok = await ensureHands();
    if (ok) {
      hands = new Hands({ locateFile: (f) => `${mpBaseUsed}/${f}` });
      hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
      hands.onResults(onHandResults);
      pumpFrames();
      hintEl.textContent = '손가락을 모으면(핀치) 그 위치에 먹이가 떨어져요';
    } else {
      hintEl.textContent = '손 인식을 못 불러왔어요 — 어항을 클릭해 먹이를 줄 수 있어요';
      console.warn('MediaPipe Hands 로드 실패');
    }
    hintEl.style.opacity = '1'; hintFaded = false;
  } catch (err) {
    console.warn('웹캠 시작 실패:', err);
    // 4) 원인별 안내
    let msg = '웹캠을 사용할 수 없습니다. 어항을 클릭해 먹이를 주세요.';
    if (err && err.name === 'NotAllowedError')      msg = '카메라 권한이 거부되었어요.\n브라우저 주소창의 카메라 아이콘에서 권한을 허용해 주세요.';
    else if (err && err.name === 'NotFoundError')   msg = '연결된 카메라를 찾지 못했어요.';
    else if (err && err.name === 'NotReadableError')msg = '다른 앱이 카메라를 사용 중이에요. 해당 앱을 닫고 다시 시도해 주세요.';
    alert(msg);
    stopCam();
  } finally {
    camBtn.disabled = false;
    if (!camActive) { camBtn.textContent = '웹캠 켜기'; camBtn.setAttribute('aria-pressed', 'false'); }
  }
}

function stopCam() {
  camActive = false;
  camBtn.textContent = '웹캠 켜기';
  camBtn.setAttribute('aria-pressed', 'false');
  camWrap.hidden = true; handCursor.hidden = true;
  if (camRAF) { cancelAnimationFrame(camRAF); camRAF = 0; }
  try { hands && hands.close && hands.close(); } catch (_) {}
  hands = null; sending = false;
  const stream = camVideo.srcObject;
  if (stream) { stream.getTracks().forEach(t => t.stop()); camVideo.srcObject = null; }
}

/* 손 위치 추적 + 핀치 감지 → 3D 어항 물속 좌표로 먹이 투하.
   미리보기를 거울(scaleX(-1))로 보여주므로 x 를 반전해 화면 좌표와 맞춘다. */
function onHandResults(results) {
  if (!camActive) return;
  const lms = results.multiHandLandmarks && results.multiHandLandmarks[0];
  if (!lms) { if (++noHandFrames > 6) handCursor.hidden = true; return; }
  noHandFrames = 0;

  const thumb = lms[4], index = lms[8], wrist = lms[0], midMcp = lms[9];
  const nx = (thumb.x + index.x) / 2, ny = (thumb.y + index.y) / 2;
  const sx = (1 - nx) * window.innerWidth, sy = ny * window.innerHeight;

  handCursor.hidden = false;
  handCursor.style.left = sx + 'px';
  handCursor.style.top = sy + 'px';

  // 핀치: 엄지-검지 거리를 손 크기로 정규화 → 원근(거리) 영향 최소화
  const pinch = Math.hypot(thumb.x - index.x, thumb.y - index.y);
  const handSize = Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y) || 0.15;
  const isPinch = (pinch / handSize) < 0.55;
  handCursor.classList.toggle('pinch', isPinch);

  const now = Date.now();
  if (isPinch && now - lastDrop > 320) { lastDrop = now; dropFoodAtClient(sx, sy); }
}

/* =========================================================================
   8. 부트스트랩: 이미지 로드 → 배경제거/크롭 → 시작
   ========================================================================= */
async function boot() {
  try {
    const [bowlImage, fishImage, decoImage] = await Promise.all([
      loadImage(ASSETS.bowl), loadImage(ASSETS.fish), loadImage(ASSETS.deco)
    ]);

    // 어항: 원본 그대로 표시 + 코너색을 페이지 배경으로
    bowlImg.src = bowlImage.src;
    applyBowlBackground(bowlImage);

    // 물고기: 회색+글로우 배경 제거 (글로우가 넓어 tol 조금 크게)
    extractFish(cutoutBackground(fishImage, 46));
    // 장식: 어두운 그라디언트 배경 제거
    extractDecos(cutoutBackground(decoImage, 42));

    buildPalette();
    initScene();
    if (loadingEl) loadingEl.hidden = true;
    requestAnimationFrame(loop);
  } catch (err) {
    console.warn(err);
    if (loadingEl) loadingEl.hidden = true;
    showAssetNote();
  }
}

function showAssetNote() {
  const list = document.getElementById('assetList');
  list.innerHTML = `
    <li><code>assets/bowl.png</code> — 어항(유리 어항)</li>
    <li><code>assets/fish.png</code> — 금붕어(측면+정면)</li>
    <li><code>assets/deco.png</code> — 수초/장식(10종)</li>`;
  document.getElementById('assetPath').textContent =
    '폴더 경로: ' + location.href.replace(/index\.html.*$/, '') + 'assets/';
  assetNote.hidden = false;
}

boot();
