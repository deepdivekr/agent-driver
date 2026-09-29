/* scene: agent-office 첫 실행 (한국어) — 설치 한 줄부터 첫 업무 접수까지.
   Stage: left onboarding rail (7 steps), right hero window (terminal → Control Center → work), bottom live log.
   Shots: install | agents (MCP 등록) | runtime (로컬 실행 승인) | ai + jev | intake (한 줄 업무) | detail (에이전트 이어받기).
   Every completed step sends a token to the rail; the rail and the log are the only other places the eye goes. */
const SHOTS = SB.shots || [];
const SEQ = sequence(SHOTS.map(s => ({ name: s.name, sec: s.sec || 8, intro: s.intro || 0 })));
const RAIL = { x:60, y:184, w:230, h:826 }, HERO = { x:310, y:184, w:710, h:826 }, LOG = { x:60, y:1034, w:960, h:226 };
const CX = HERO.x + 24, CW = HERO.w - 48, CR = CX + CW, CY = HERO.y + 39;
const RI = meta.rail || { items: [] }, ITEMS = RI.items || [], LOGS = SB.logs || [];
const ST = meta.settings || {}, WK = meta.work || {}, DT = meta.detail || {};
const railY = i => RAIL.y + 96 + i*102, RDX = RAIL.x + 30;
const gAt = (shot, at) => SEQ.starts[shot] + at;
const pad2 = n => String(n).padStart(2, '0');
const BF = `600 13px ${M}`;
// intake / settings geometry shared by camera focus and drawing
const ROW0 = 532, ROWH = 70;
const SCR = { y:540, h:222 }, DIA = { y:640, h:176 };
const INTAKE = { y:290, h:104 }, CARD = { y:448, h:142 }, GRID = { y:644, th:100, gap:10 };
const COLW = (CW - 3*16) / 4;
const FG = 16;   // gap between the client → mcp → local flow boxes

function prepare() {}

function draw(t) {
  if (!SHOTS.length) return;
  const E = SEQ.at(t), s = SHOTS[E.i], tm = mod(t, SEQ.period);
  const { cam, f } = camFor(s, E);
  beginCamera(cam, f);
  header(t, E.i);
  stepCounter(s, E);
  rail(tm, t);
  hero(s, E, t, tm);
  logStrip(tm, t, s);
  footer();
  endCamera(cam, { x:f.x - 6, y:f.y - 6, w:f.w + 12, h:f.h + 12 });
}

// ---------- camera: intro push on what is typed, one mid-shot push on what matters ----------
function focusOf(s) {
  if (s.kind === 'install') return { x:HERO.x, y:HERO.y + 40, w:HERO.w, h:112 };
  if (s.kind === 'agents') return { x:CX - 10, y:ROW0 + ROWH - 4, w:CW + 20, h:ROWH + 8 };
  if (s.kind === 'runtime') return { x:CX - 10, y:SCR.y - 8, w:CW + 20, h:SCR.h + 16 };
  if (s.kind === 'ai') return { x:CX - 10, y:DIA.y - 8, w:CW + 20, h:DIA.h + 16 };
  if (s.kind === 'intake') return { x:CX - 10, y:INTAKE.y - 6, w:CW + 20, h:INTAKE.h + 12 };
  if (s.kind === 'detail') return { x:CX - 10, y:300, w:CW + 20, h:244 };
  return HERO;
}
function camFor(s, E) {
  const f = focusOf(s), r = E.r;
  if (E.I > 0 && r < E.I) return { cam: cameraAmount(r, E.I), f };
  if (s.push && r >= s.push[0] && r < s.push[1]) return { cam: cameraAmount(r - s.push[0], s.push[1] - s.push[0]), f };
  return { cam: 0, f };
}

// ---------- shared small parts ----------
function stepCounter(s, E) {
  txt(meta.stepLabel || 'STEP', 1020, 64, { font:`400 12px ${M}`, color:C.dim, align:'right', ls:1 });
  txt(`${pad2(E.i + 1)} / ${pad2(SHOTS.length)}`, 1020, 100, { font:`600 34px ${M}`, color:C.acc, align:'right' });
  const a = appear(E.r, 0.05, 0);
  txt(s.title || '', 1020, 136 + (1 - a)*6, { font:`600 15px ${S}`, color:C.text, align:'right', alpha:a });
}
function btnW(label) { return mw(label, BF) + 28; }
// kind: 'primary' (accent) | 'ghost' | 'done' (ok outline). Returns the rect.
function button(x, y, label, kind, press = 0, spin = null) {
  const w = btnW(label) + (spin != null ? 22 : 0) + (kind === 'done' ? 18 : 0), h = 34;
  const sh = press * 2;
  if (kind === 'primary') { fillR(x, y + sh, w, h, 7, C.acc); }
  else if (kind === 'done') { fillR(x, y, w, h, 7, hexA(C.ok, 0.12)); strokeR(x + .5, y + .5, w - 1, h - 1, 7, C.ok, 1, 0.8); }
  else { fillR(x, y, w, h, 7, '#222831'); strokeR(x + .5, y + .5, w - 1, h - 1, 7, C.line2, 1); }
  const col = kind === 'primary' ? C.bg : kind === 'done' ? C.ok : '#c3c9d2';
  if (spin != null) spinner(x + 18, y + h/2 + sh, spin, kind === 'primary' ? C.bg : C.acc, 6);
  txt(label, x + (spin != null ? 36 : 14), y + 22 + sh, { font:BF, color:col });
  return { x, y, w, h };
}
function badgeR(xr, y, text, col, a = 1) { const w = mw(text, `500 12px ${M}`) + 20; pill(xr - w, y, text, col, a); return w; }
// Control Center status badge: "● 설치 필요" (dashed while idle, solid once it matters). Returns width.
function statusPill(x, y, text, col, dashed, a = 1) {
  col = colorOf(col); const f = `500 12px ${M}`, w = mw(text, f) + 34;
  if (!dashed) fillR(x, y, w, 22, 11, hexA(col, 0.14*a));
  strokeR(x + .5, y + .5, w - 1, 21, 11, col, 1, (dashed ? 0.8 : 0.75)*a, dashed ? [3, 3] : null);
  dot(x + 12, y + 11, 3, col, a); txt(text, x + 22, y + 15, { font:f, color:col, alpha:a }); return w;
}
// KO chip with a small Taegukgi, as in the Control Center header.
function langChip(xr, y) {
  const w = 62, x = xr - w; fillR(x, y, w, 26, 13, C.surf2); strokeR(x + .5, y + .5, w - 1, 25, 13, C.line2, 1);
  const fx = x + 10, fy = y + 6; fillR(fx, fy, 21, 14, 2, '#f4f5f7');
  ctx.save(); ctx.globalAlpha = GA; const cx = fx + 10.5, cy = fy + 7;
  ctx.beginPath(); ctx.arc(cx, cy, 3.6, Math.PI, 0); ctx.fillStyle = '#cd2e3a'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 3.6, 0, Math.PI); ctx.fillStyle = '#0047a0'; ctx.fill();
  ctx.strokeStyle = '#101317'; ctx.lineWidth = 1.2;
  [[fx + 3, fy + 3], [fx + 18, fy + 3], [fx + 3, fy + 11], [fx + 18, fy + 11]].forEach(([px, py]) => { ctx.beginPath(); ctx.moveTo(px - 1.5, py - 1); ctx.lineTo(px + 1.5, py + 1); ctx.stroke(); });
  ctx.restore();
  txt(meta.lang || 'KO', xr - 11, y + 18, { font:`600 12px ${M}`, color:C.text, align:'right' });
}
// Select box as in the settings form; value dims while it is a placeholder.
function selectBox(x, y, w, value, placeholder, open) {
  fillR(x, y, w, 40, 7, C.bg); strokeR(x + .5, y + .5, w - 1, 39, 7, open ? C.acc : C.line2, 1);
  txt(value, x + 16, y + 26, { font:`${placeholder ? 400 : 500} 15px ${S}`, color: placeholder ? C.faint : C.text });
  const cx = x + w - 20, cy = y + 20; ln(cx - 5, cy - 2, cx, cy + 3, C.dim, 1.6); ln(cx, cy + 3, cx + 5, cy - 2, C.dim, 1.6);
}
function check(x, y, col, a = 1, sz = 5) { ctx.save(); ctx.globalAlpha = a*GA; ctx.strokeStyle = colorOf(col); ctx.lineWidth = 2.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - sz, y); ctx.lineTo(x - sz*0.3, y + sz*0.7); ctx.lineTo(x + sz, y - sz*0.8); ctx.stroke(); ctx.restore(); }
function cross(x, y, col, a = 1, sz = 7) { ln(x - sz, y - sz, x + sz, y + sz, colorOf(col), 3, a); ln(x + sz, y - sz, x - sz, y + sz, colorOf(col), 3, a); }
function checkbox(x, y, on, a = 1) {
  fillR(x, y, 18, 18, 4, on > 0 ? hexA(C.acc, 0.9*on) : C.bg, a); strokeR(x + .5, y + .5, 17, 17, 4, on > 0 ? C.acc : C.line2, 1, a);
  if (on > 0) check(x + 9, y + 9, C.bg, on*a, 4.5);
}
// Mouse moves from `from` to the target between t0 and t1, clicks at t1 + 0.1.
function mouse(r, t0, t1, from, to, until) {
  if (r < t0 - 0.2 || r > until) return;
  const q = ease(win(r, t0, t1)), x = lerp(from[0], to[0], q), y = lerp(from[1], to[1], q);
  const c = win(r, t1 + 0.1, t1 + 0.6);
  if (c > 0 && c < 1) ripple(to[0], to[1], c, C.acc, 4, 30);
  GA = win(r, t0 - 0.2, t0) * (1 - win(r, until - 0.2, until)); cursor(x, y); GA = 1;
}
const press = (r, at) => band(r, at, at + 0.22, 0.08);
// A token flies from a point in the hero to the rail dot of item i, landing at shot-time `at`.
function toRail(r, at, from, i, col = 'ok') {
  const q = win(r, at - 0.5, at); if (q <= 0 || q >= 1) return;
  const to = [RDX, railY(i)], mid = [lerp(from[0], to[0], 0.5), Math.min(from[1], to[1]) - 40];
  const pts = [from, mid, to], p = along(pts, ease(q));
  for (let k = 1; k < pts.length; k++) ln(pts[k-1][0], pts[k-1][1], pts[k][0], pts[k][1], hexA(col, 0.25), 1, 1, [3, 5]);
  token(p[0], p[1], col);
}
function flyTo(r, a, b, from, to, col = 'acc') {
  const q = win(r, a, b); if (q <= 0 || q >= 1) return;
  const p = along([from, to], ease(q)); ln(from[0], from[1], p[0], p[1], hexA(col, 0.5), 1.5, 1, [4, 4]); token(p[0], p[1], col);
}

// ---------- rail: the onboarding checklist, lit as each step completes ----------
function rail(tm, t) {
  panel(RAIL.x, RAIL.y, RAIL.w, RAIL.h);
  const done = ITEMS.map(it => tm >= gAt(it.shot, it.at)), nDone = done.filter(Boolean).length, act = done.indexOf(false);
  txt(RI.title || '', RAIL.x + 20, RAIL.y + 36, { font:`600 16px ${S}`, color:C.text });
  txt(`${nDone}/${ITEMS.length}`, RAIL.x + RAIL.w - 20, RAIL.y + 36, { font:`500 13px ${M}`, color: nDone === ITEMS.length ? C.ok : C.dim, align:'right' });
  progressBar(RAIL.x + 20, RAIL.y + 52, RAIL.w - 40, nDone / Math.max(1, ITEMS.length), 'ok');
  ITEMS.forEach((it, i) => {
    const y = railY(i), g = gAt(it.shot, it.at), d = ease(win(tm, g, g + 0.3));
    if (i < ITEMS.length - 1) { ln(RDX, y + 14, RDX, railY(i + 1) - 14, C.line2, 2); if (d > 0) ln(RDX, y + 14, RDX, lerp(y + 14, railY(i + 1) - 14, d), C.ok, 2); }
    if (done[i]) { dot(RDX, y, 11, C.ok, 0.25 + 0.75*d); check(RDX, y, C.bg, d, 5); if (tm < g + 0.7) ripple(RDX, y, win(tm, g, g + 0.7), C.ok, 11, 34); }
    else if (i === act) pulseRing(RDX, y, C.acc, t*2.2);
    else { ctx.beginPath(); ctx.arc(RDX, y, 8, 0, Math.PI*2); ctx.strokeStyle = C.line2; ctx.lineWidth = 2; ctx.stroke(); }
    const lit = done[i] || i === act;
    txt(it.label, RDX + 24, y + 6, { font:`600 15px ${S}`, color: lit ? C.text : C.dim });
    if (done[i]) txt(fitText(it.sub || '', `400 12px ${S}`, RAIL.w - 64), RDX + 24, y + 29, { font:`400 12px ${S}`, color:C.dim, alpha:d });
    else if (i === act) txt(RI.active || '', RDX + 24, y + 29, { font:`500 12px ${S}`, color:C.acc });
  });
  const lit = ITEMS.reduce((m, it) => Math.max(m, band(tm, gAt(it.shot, it.at) - 0.5, gAt(it.shot, it.at) + 0.9, 0.2)), 0);
  spot(RAIL.x - 4, RAIL.y - 4, RAIL.w + 8, RAIL.h + 8, lit);
}

// ---------- live log: 연결 작업 기록 during setup, 업무 기록 once work exists ----------
function logStrip(tm, t, s) {
  const kind = (s.kind === 'intake' || s.kind === 'detail') ? 'work' : 'setup';
  panel(LOG.x, LOG.y, LOG.w, LOG.h);
  txt((meta.logTitles || {})[kind] || '', LOG.x + 20, LOG.y + 34, { font:`600 15px ${S}`, color:C.text });
  pulseRing(LOG.x + LOG.w - 30 - mw(meta.logLive || '', `400 12px ${M}`) - 14, LOG.y + 29, C.ok, t*1.6);
  txt(meta.logLive || '', LOG.x + LOG.w - 20, LOG.y + 34, { font:`400 12px ${M}`, color:C.dim, align:'right' });
  ln(LOG.x + 16, LOG.y + 50.5, LOG.x + LOG.w - 16, LOG.y + 50.5, C.line, 1);
  const shown = LOGS.filter(l => l.log === kind && tm >= gAt(l.shot, l.at));
  const lh = 38, base = LOG.y + 82, last = shown.slice(-5), newest = shown[shown.length - 1];
  const an = newest ? ease(win(tm, gAt(newest.shot, newest.at), gAt(newest.shot, newest.at) + 0.28)) : 1;
  const keep = last.length > 4 ? last.slice(1) : last, leaving = last.length > 4 ? last[0] : null;
  ctx.save(); ctx.beginPath(); ctx.rect(LOG.x, LOG.y + 52, LOG.w, LOG.h - 54); ctx.clip();
  const row = (l, j, a) => {
    const y = base + j*lh + (1 - an)*lh, col = l.state === 'run' ? C.dim : l.state === 'acc' ? C.acc : C.ok;
    if (l === newest) fillR(LOG.x + 10, y - 24, LOG.w - 20, lh - 4, 6, hexA(col, 0.10*band(tm, gAt(l.shot, l.at), gAt(l.shot, l.at) + 1.4, 0.3)));
    dot(LOG.x + 30, y - 6, 4.5, col, a);
    txt(fitText(l.text, `400 14px ${S}`, LOG.w - 190), LOG.x + 46, y, { font:`400 14px ${S}`, color: l.state === 'run' ? C.dim : C.text, alpha:a });
    txt(l.area || '', LOG.x + LOG.w - 24, y, { font:`400 12px ${M}`, color:C.faint, align:'right', alpha:a });
  };
  if (leaving) row(leaving, -1, 1 - an);
  keep.forEach((l, j) => row(l, j, l === newest ? an : 1));
  ctx.restore();
  const lit = newest ? band(tm, gAt(newest.shot, newest.at) - 0.05, gAt(newest.shot, newest.at) + 1.2, 0.2) : 0;
  spot(LOG.x - 4, LOG.y - 4, LOG.w + 8, LOG.h + 8, lit);
}

// ---------- hero window ----------
function hero(s, E, t, tm) {
  const k = s.kind, url = k === 'install' ? meta.terminalTitle : k === 'intake' ? meta.workUrl : k === 'detail' ? meta.detailUrl : meta.settingsUrl;
  windowChrome(HERO.x, HERO.y, HERO.w, HERO.h, url, { lock: k !== 'install' });
  if (k === 'install') install(s, E, t);
  else if (k === 'intake') intake(s, E, t);
  else if (k === 'detail') detail(s, E, t);
  else { settingsFrame(s, E, tm); GA = ease(win(E.r, 0.05, 0.35));
    if (k === 'agents') agents(s, E, t); else if (k === 'runtime') runtime(s, E, t); else if (k === 'ai') ai(s, E, t);
    GA = 1; }
}

// shot 1: the agent runs the one-line installer
function install(s, E, t) {
  const r = E.r, x = CX, lh = 27, f = `400 14px ${M}`;
  txt(s.session, x, CY + 34, { font:`400 12px ${M}`, color:C.faint });
  const tf = typeProgress(r, E.I), py = CY + 76;
  fillR(x - 12, py - 26, CW + 24, 42, 8, C.surf2); strokeR(x - 11.5, py - 25.5, CW + 23, 41, 8, tf < 1 ? C.acc : C.line2, 1, tf < 1 ? 0.7 : 1);
  txt('>', x, py, { font:`600 17px ${M}`, color:C.acc });
  const shown = s.prompt.slice(0, Math.floor(s.prompt.length * tf)), pf = `400 17px ${M}`;
  txt(shown, x + 24, py, { font:pf, color:C.text });
  if (r < E.I && Math.floor(t*4) % 2 === 0) { ctx.fillStyle = C.acc; ctx.fillRect(x + 26 + mw(shown, pf), py - 16, 9, 20); }
  const T0 = E.I + 0.15, TC = T0 + 0.3, TL = T0 + 0.65, STEP = 0.3, N = s.lines.length, TJ = TL + N*STEP + 0.05;
  let y = CY + 122;
  const line = (at, fn) => { const a = appear(r, at, 0); if (a > 0) { GA = a; fn(y + (1 - a)*5); GA = 1; } y += lh; };
  line(T0, yy => txt(s.reply, x, yy, { font:`500 14px ${S}`, color:C.acc }));
  line(TC, yy => txt(s.command, x, yy, { font:f, color:C.text }));
  const pw = mw(s.prefix + ' ', f), ys = [];
  s.lines.forEach((l, j) => { ys.push(y); line(TL + j*STEP, yy => { txt(s.prefix, x, yy, { font:f, color:C.link }); txt(l.text, x + pw, yy, { font:f, color: l.kind === 'ok' ? C.ok : C.text }); }); });
  if (r > TC && r < TJ) { const j = clamp(Math.floor((r - TL)/STEP), 0, N - 1); spinner(CR - 10, ys[j] - 5, t, C.acc, 6); }
  s.json.forEach((l, j) => line(TJ + j*0.15, yy => txt(l, x, yy, { font:f, color:C.acc })));
  // what the installer set up, lit as each line lands
  const by = CY + 552;
  ln(x, by, CR, by, C.line, 1);
  txt(s.chipsTitle || '', x, by + 32, { font:`600 14px ${S}`, color:C.text });
  const cw = (CW - 24) / 3;
  (s.chips || []).forEach((c, j) => {
    const cx = x + j*(cw + 12), cy = by + 50, on = ease(win(r, TL + c.line*STEP, TL + c.line*STEP + 0.25));
    fillR(cx, cy, cw, 64, 10, C.surf2); strokeR(cx + .5, cy + .5, cw - 1, 63, 10, on > 0 ? C.ok : C.line2, 1, on > 0 ? 0.4 + 0.6*on : 1);
    dot(cx + 22, cy + 32, 10, on > 0 ? C.ok : C.line2, on > 0 ? on : 1); if (on > 0) check(cx + 22, cy + 32, C.bg, on, 4.5);
    txt(fitText(c.text, `500 13px ${S}`, cw - 52), cx + 42, cy + 37, { font:`500 13px ${S}`, color: on > 0.5 ? C.text : C.dim });
  });
  const cmdA = appear(r, TJ + 0.35, 0);
  if (cmdA > 0) { GA = cmdA;
    txt('관제센터', x, by + 160, { font:`400 12px ${M}`, color:C.dim }); txt('~/.local/bin/agent-office connect', x + 90, by + 160, { font:`500 14px ${M}`, color:C.text });
    txt('MCP', x, by + 192, { font:`400 12px ${M}`, color:C.dim }); txt('agent-office mcp', x + 90, by + 192, { font:`500 14px ${M}`, color:C.text });
    GA = 1; }
  const it = ITEMS[0];
  if (it && it.shot === E.i) toRail(r, it.at, [x - 6, ys[7] - 6], 0);
  spot(x - 16, by + 40, CW + 32, 84, win(r, TL - 0.3, TL));
}

// Control Center frame shared by shots 2-4: title, the client → mcp → local flow, and the four tabs.
function settingsFrame(s, E, tm) {
  const r = E.r, fa = s.kind === 'agents' ? ease(win(r, 0, 0.3)) : 1;
  GA = fa;
  txt(ST.title || '', CX, CY + 44, { font:`600 22px ${S}`, color:C.text });
  langChip(CR, CY + 22);
  let tab = s.tab || 0; const jevQ = s.jevAt != null ? ease(win(r, s.jevAt, s.jevAt + 0.3)) : 0; if (jevQ >= 1) tab = 3;
  txt(`${tab + 1} / 4`, CR - 76, CY + 40, { font:`400 14px ${M}`, color:C.dim, align:'right' });
  // flow row
  const fy = CY + 66, bw = (CW - 2*FG) / 3, fl = ST.flow || [];
  const on0 = tm >= gAt(ITEMS[1].shot, ITEMS[1].at), on2 = tm >= gAt(ITEMS[2].shot, ITEMS[2].at);
  fl.forEach((b, j) => {
    const bx = CX + j*(bw + FG), col = j === 1 ? C.acc : (j === 0 ? on0 : on2) ? C.ok : C.line2;
    const subs = [].concat(b.sub), bh = 38 + subs.length*17, by = fy + 27 - bh/2;
    fillR(bx, by, bw, bh, 9, C.surf2); strokeR(bx + .5, by + .5, bw - 1, bh - 1, 9, col, j === 1 ? 1.5 : 1);
    txt(b.title, bx + 12, by + 23, { font:`600 13px ${M}`, color:C.text });
    subs.forEach((l, k) => txt(fitText(l, `400 11px ${M}`, bw - 20), bx + 12, by + 42 + k*17, { font:`400 11px ${M}`, color:C.dim }));
    if (j < 2) ln(bx + bw, fy + 27, bx + bw + FG, fy + 27, (j === 0 ? on0 : on2) ? C.ok : C.line2, 1.5);
  });
  // tabs with a sliding underline
  const ty = CY + 158, tabs = ST.tabs || [], xs = [];
  let tx = CX;
  tabs.forEach((lab, j) => { xs.push(tx); tx += 26 + mw(lab, `600 14px ${S}`) + 28; });
  const from = s.jevAt != null ? 2 : Math.max(0, (s.tab || 0) - 1), to = s.tab || 0;
  const q = s.jevAt != null ? jevQ : ease(win(r, 0.05, 0.4)), cur = s.jevAt != null ? lerp(2, 3, q) : lerp(from, to, q);
  tabs.forEach((lab, j) => {
    const act = Math.round(cur) === j;
    ctx.beginPath(); ctx.arc(xs[j] + 9, ty - 5, 9, 0, Math.PI*2); ctx.strokeStyle = act ? C.acc : C.line2; ctx.lineWidth = 1.2; ctx.globalAlpha = GA; ctx.stroke(); ctx.globalAlpha = 1;
    txt(String(j + 1), xs[j] + 9, ty - 1, { font:`500 11px ${M}`, color: act ? C.acc : C.dim, align:'center' });
    txt(lab, xs[j] + 26, ty, { font: act ? `600 14px ${S}` : `400 14px ${S}`, color: act ? C.text : C.dim });
  });
  const i0 = Math.floor(cur), i1 = Math.min(tabs.length - 1, i0 + 1), fr = cur - i0;
  const ux = lerp(xs[i0], xs[i1], fr), uw = lerp(26 + mw(tabs[i0], `600 14px ${S}`), 26 + mw(tabs[i1], `600 14px ${S}`), fr);
  ln(CX, ty + 14.5, CR, ty + 14.5, C.line, 1); fillR(ux - 4, ty + 12, uw + 8, 3, 1.5, C.acc);
  GA = 1;
  return fy;
}

function panelHead(title, sub, y = 444) {
  txt(title, CX, y, { font:`600 18px ${S}`, color:C.text });
  if (sub) txt(sub, CX, y + 26, { font:`400 13px ${S}`, color:C.dim });
}

// shot 2: register MCP in Claude Code
function agents(s, E, t) {
  const r = E.r, CLICK = 1.8, DONE = ITEMS[1].at;
  panelHead(s.heading, s.sub);
  txt(s.runtime, CX, 508, { font:`600 14px ${S}`, color:C.text });
  statusPill(CR - mw(s.runtimeBadge, `500 12px ${M}`) - 34, 492, s.runtimeBadge, 'ok', false);
  ln(CX, 522.5, CR, 522.5, C.line, 1);
  let target = null;
  s.rows.forEach((row, k) => {
    const top = ROW0 + k*ROWH, a = appear(r, 0.2, k), yy = top + (1 - a)*6;
    GA *= a;
    const flipped = row.target && r >= DONE;
    const nameY = row.note ? yy + 30 : yy + 40;
    txt(row.name, CX + 4, nameY, { font:`600 15px ${S}`, color:C.text });
    const bcol = row.target ? (flipped ? 'ok' : 'human') : 'dim';
    statusPill(CX + 136, nameY - 16, flipped ? row.badgeAfter : row.badge, bcol, !row.target);
    if (row.note) txt(flipped ? row.noteAfter : row.note, CX + 4, yy + 54, { font:`400 12px ${S}`, color: flipped ? C.ok : C.dim });
    const busy = row.target && r >= CLICK + 0.1 && r < DONE, lab = flipped ? row.done : busy ? row.busy : row.button;
    let bx = CR - btnW(lab);
    if (!row.target && s.guide) { const gf = `400 12px ${S}`, gw = mw(s.guide, gf); txt(s.guide, CR, yy + 39, { font:gf, color:C.acc, align:'right' }); ln(CR - gw, yy + 42.5, CR, yy + 42.5, C.acc, 1, 0.7); bx -= gw + 12; }
    const b = button(row.target ? CR - btnW(lab) - (busy ? 22 : 0) - (flipped ? 18 : 0) : bx, yy + 17, lab, row.target ? (flipped ? 'done' : 'primary') : 'ghost', row.target ? press(r, CLICK) : 0, busy ? t : null);
    if (flipped) check(b.x + b.w - 14, b.y + 17, C.ok, win(r, DONE, DONE + 0.2), 4);
    if (row.target) target = { b, top, badgeX: CX + 140, nameY };
    if (k < s.rows.length - 1) ln(CX, top + ROWH - 0.5, CR, top + ROWH - 0.5, C.line, 1);
    GA = 1;
  });
  // focus: the Claude Code row while it is being registered
  s.rows.forEach((row, k) => { if (!row.target) spot(CX - 8, ROW0 + k*ROWH, CW + 16, ROWH, 1 - band(r, 1.0, 4.8, 0.3)); });
  const ay = ROW0 + s.rows.length*ROWH + 22;
  button(CR - btnW(s.actions[1]), ay, s.actions[1], r >= DONE ? 'primary' : 'ghost', press(r, 5.7));
  button(CR - btnW(s.actions[1]) - 12 - btnW(s.actions[0]), ay, s.actions[0], 'ghost');
  txt(s.hint, CX, ay + 22, { font:`400 13px ${S}`, color: r >= DONE ? C.dim : C.acc });
  if (target) {
    const bc = [target.b.x + target.b.w/2, target.b.y + 17];
    mouse(r, 0.9, CLICK - 0.1, [CR - 60, 980], bc, 2.4);
    mouse(r, 5.0, 5.6, bc, [CR - btnW(s.actions[1])/2, ay + 17], 6.6);
    toRail(r, DONE, [target.badgeX + 8, target.nameY - 5], 1);
    const fy = CY + 66, bw = (CW - 2*FG) / 3;
    flyTo(r, DONE, DONE + 0.5, [CX + bw - 10, fy + 27], [CX + bw + FG + 10, fy + 27], 'ok');
  }
}

// shot 3: approve the local runtime (dedicated browser, my screen untouched)
function runtime(s, E, t) {
  const r = E.r, CLICK = 1.5, DONE = ITEMS[2].at, ok = r >= DONE, q = ease(win(r, DONE, DONE + 0.4));
  panelHead(s.heading, s.sub);
  txt(s.runtime, CX, 508, { font:`600 14px ${S}`, color:C.text });
  badgeR(CR, 492, ok ? s.badgeAfter : s.badgeBefore, ok ? 'ok' : 'dim');
  ln(CX, 522.5, CR, 522.5, C.line, 1);
  const bw = (CW - 20) / 2;
  // my screen
  const L = { x:CX, y:SCR.y }, Rb = { x:CX + bw + 20, y:SCR.y };
  fillR(L.x, L.y, bw, SCR.h, 10, C.surf2); strokeR(L.x + .5, L.y + .5, bw - 1, SCR.h - 1, 10, ok ? C.ok : C.line2, 1, ok ? 0.3 + 0.5*q : 1);
  txt(s.mine.title, L.x + 16, L.y + 28, { font:`600 14px ${S}`, color:C.text });
  fillR(L.x + 16, L.y + 42, bw - 32, 128, 6, C.bg);
  fillR(L.x + 30, L.y + 56, 150, 84, 5, '#222831'); fillR(L.x + 30, L.y + 56, 150, 14, 5, '#2b3140');
  fillR(L.x + 120, L.y + 92, 150, 66, 5, '#262c35'); fillR(L.x + 120, L.y + 92, 150, 14, 5, '#303744');
  [0, 1, 2].forEach(i => fillR(L.x + 42, L.y + 82 + i*14, 90 - i*18, 5, 2, C.line2));
  cursor(L.x + 214 + Math.sin(t*1.3)*14, L.y + 118 + Math.cos(t*1.1)*8);
  txt(s.mine.note, L.x + 16, L.y + 200, { font:`400 12px ${S}`, color: ok ? C.ok : C.dim });
  // dedicated browser
  fillR(Rb.x, Rb.y, bw, SCR.h, 10, C.surf2); strokeR(Rb.x + .5, Rb.y + .5, bw - 1, SCR.h - 1, 10, ok ? C.acc : C.line2, ok ? 1.5 : 1, ok ? q : 1);
  txt(s.dedicated.title, Rb.x + 16, Rb.y + 28, { font:`600 14px ${S}`, color:C.text });
  if (ok) badgeR(Rb.x + bw - 14, Rb.y + 12, s.dedicated.ready, 'ok', q);
  const bx = Rb.x + 16, by = Rb.y + 42, bwid = bw - 32;
  fillR(bx, by, bwid, 128, 6, C.bg); fillR(bx, by, bwid, 18, 6, '#1f242c');
  [0, 1, 2].forEach(i => dot(bx + 10 + i*10, by + 9, 3, C.line2));
  fillR(bx + 44, by + 5, bwid - 60, 8, 4, '#262c35');
  const rows = [0.8, 0.6, 0.9, 0.5, 0.7];
  rows.forEach((w, i) => fillR(bx + 12, by + 32 + i*18, (bwid - 24)*w, 7, 3, ok ? hexA(C.link, 0.25 + 0.2*q) : C.line));
  if (ok) { const p = (r - DONE) / 1.6 % 1; scanLine(bx + 4, by + 22, bwid - 8, 100, p, C.acc);
    const tp = along([[bx + 20, by + 40], [bx + bwid - 30, by + 58], [bx + 60, by + 94], [bx + bwid - 50, by + 112]], ((r - DONE)/2.4) % 1); token(tp[0], tp[1], 'acc', q); }
  txt(s.dedicated.note, Rb.x + 16, Rb.y + 200, { font:`400 12px ${S}`, color: ok ? C.text : C.dim });
  // options
  const oy = SCR.y + SCR.h + 22;
  s.options.forEach((o, j) => {
    const y = oy + j*44, a = appear(r, 0.3, j);
    GA *= a; txt(o.name, CX + 4, y + 28, { font:`500 14px ${S}`, color: j === 0 ? C.text : C.dim });
    badgeR(CR, y + 11, o.badge, o.color, 1); GA = ease(win(r, 0.05, 0.35));
    if (j < s.options.length - 1) ln(CX, y + 43.5, CR, y + 43.5, C.line, 1);
  });
  spot(CX - 8, oy + 44, CW + 16, 88, 1 - band(r, 0.3, DONE + 0.2, 0.3));
  const ay = oy + 3*44 + 16;
  const b = button(CX, ay, ok ? s.button : s.button, ok ? 'done' : 'primary', press(r, CLICK), r > CLICK + 0.1 && r < DONE ? t : null);
  if (ok) check(b.x + b.w - 14, ay + 17, C.ok, q, 4);
  button(b.x + b.w + 12, ay, s.next, 'ghost');
  mouse(r, 0.5, CLICK - 0.1, [CR - 40, 990], [b.x + b.w/2, ay + 17], 2.2);
  toRail(r, DONE, [CR - 60, 500], 2);
  const fy = CY + 66, fbw = (CW - 2*FG) / 3;
  flyTo(r, DONE, DONE + 0.5, [CX + 2*fbw + FG - 10, fy + 27], [CX + 2*fbw + 2*FG + 10, fy + 27], 'ok');
}

// shot 4: AI connection (subscription, never auto-switch to paid API), then Jev off
function ai(s, E, t) {
  const r = E.r, J = s.jevAt, aA = 1 - ease(win(r, J, J + 0.22)), aJ = ease(win(r, J + 0.18, J + 0.42)), base = GA;
  const PICK = 1.1, CONSENT = 4.5, DONE = ITEMS[3].at;
  if (aA > 0) { GA = base*aA;
    txt(s.heading, CX, 444, { font:`600 18px ${S}`, color:C.text });
    dot(CX + 7, 465, 7, C.acc, 0.9); txt('!', CX + 7, 469.5, { font:`700 11px ${M}`, color:C.bg, align:'center' });
    txt(s.note, CX + 22, 470, { font:`500 13px ${S}`, color:C.acc });
    txt(s.modeLabel, CX, 506, { font:`400 12px ${M}`, color:C.dim });
    // the real form's <select>: click opens the list, 구독 사용 is picked
    const sy = 516, OPEN = 0.55, picked = r >= PICK, open = r >= OPEN && r < PICK + 0.12;
    selectBox(CX, sy, CW, picked ? s.modes[0] : s.modePlaceholder, !picked, open);
    if (open) { const la = ease(win(r, OPEN, OPEN + 0.15)), ly = sy + 44, lh = 38;
      GA = base*aA*la; fillR(CX, ly, CW, lh*s.modes.length + 8, 8, C.surf2); strokeR(CX + .5, ly + .5, CW - 1, lh*s.modes.length + 7, 8, C.line2, 1);
      s.modes.forEach((m, j) => { const hot = j === 0 && r >= 0.85;
        if (hot) fillR(CX + 4, ly + 4 + j*lh, CW - 8, lh, 6, hexA(C.acc, 0.16));
        txt(m, CX + 16, ly + 29 + j*lh, { font:`${hot ? 600 : 400} 15px ${S}`, color: hot ? C.acc : C.text }); });
      GA = base*aA; }
    const ca = appear(r, PICK + 0.2, 0);
    if (ca > 0) { GA = base*aA*ca;
      txt(s.client, CX, 598, { font:`400 12px ${M}`, color:C.dim }); txt(s.clientName, CX + 128, 598, { font:`600 15px ${S}`, color:C.text });
      badgeR(CR, 582, s.clientBadge, 'ok'); GA = base*aA; }
    // limits diagram: subscription → another allowed connection, never → paid API
    const dA = appear(r, 1.6, 0);
    if (dA > 0) { GA = base*aA*dA;
      txt(s.flowTitle, CX, DIA.y + 16, { font:`400 12px ${M}`, color:C.dim });
      const A = { x:CX, y:DIA.y + 58, w:236, h:62 }, B = { x:CR - 236, y:DIA.y + 30, w:236, h:52 }, Cc = { x:CR - 236, y:DIA.y + 110, w:236, h:52 };
      fillR(A.x, A.y, A.w, A.h, 10, C.surf2); strokeR(A.x + .5, A.y + .5, A.w - 1, A.h - 1, 10, C.acc, 1.5);
      txt(s.from, A.x + A.w/2, A.y + 37, { font:`600 15px ${S}`, color:C.text, align:'center' });
      const qb = ease(win(r, 2.3, 2.8)), qc = ease(win(r, 2.9, 3.3)), xs = win(r, 3.35, 3.6);
      fillR(B.x, B.y, B.w, B.h, 10, C.surf2); strokeR(B.x + .5, B.y + .5, B.w - 1, B.h - 1, 10, qb >= 1 ? C.ok : C.line2, 1);
      txt(s.handoff.title, B.x + B.w/2, B.y + 32, { font:`600 14px ${S}`, color: qb >= 1 ? C.text : C.dim, align:'center' });
      fillR(Cc.x, Cc.y, Cc.w, Cc.h, 10, C.surf2); strokeR(Cc.x + .5, Cc.y + .5, Cc.w - 1, Cc.h - 1, 10, xs > 0 ? C.human : C.line2, 1, 1, xs > 0 ? [5, 4] : null);
      txt(s.paid.title, Cc.x + Cc.w/2, Cc.y + 32, { font:`600 14px ${S}`, color: xs > 0 ? C.human : C.dim, align:'center' });
      const a0 = [A.x + A.w + 6, A.y + A.h/2], b1 = [B.x - 6, B.y + B.h/2], c1 = [Cc.x - 6, Cc.y + Cc.h/2];
      arrow(a0[0], a0[1], b1[0], b1[1], C.ok, qb, 2);
      if (qb > 0.6) txt(s.handoff.label, (a0[0] + b1[0])/2, B.y + 6, { font:`500 13px ${S}`, color:C.ok, align:'center', alpha:win(qb, 0.6, 1) });
      if (qc > 0) ln(a0[0], a0[1], lerp(a0[0], c1[0], qc), lerp(a0[1], c1[1], qc), C.human, 2, 0.8, [6, 5]);
      if (xs > 0) { const mx = (a0[0] + c1[0])/2, my = (a0[1] + c1[1])/2 + 2; if (xs < 1) ripple(mx, my, xs, C.human, 8, 36);
        dot(mx, my, 15, C.bg, 1); cross(mx, my, C.human, xs, 6);
        txt(s.paid.label, mx, Cc.y + Cc.h + 20, { font:`600 13px ${S}`, color:C.human, align:'center', alpha:xs }); }
      if (r > 3.7 && r < 4.6) { const p = along([a0, b1], ((r - 3.7)/0.9)); token(p[0], p[1], 'ok'); }
      GA = base*aA; }
    const cy = DIA.y + DIA.h + 28, on = ease(win(r, CONSENT, CONSENT + 0.2));
    fillR(CX, cy, CW, 46, 8, C.surf2); strokeR(CX + .5, cy + .5, CW - 1, 45, 8, on > 0 ? hexA(C.acc, 0.8) : C.line2, 1);
    checkbox(CX + 16, cy + 14, on); txt(s.consent, CX + 46, cy + 28, { font:`400 14px ${S}`, color: on > 0.5 ? C.text : C.dim });
    const ay = cy + 66;
    button(CR - btnW(s.actions[1]), ay, s.actions[1], 'primary', press(r, J - 0.35));
    button(CR - btnW(s.actions[1]) - 12 - btnW(s.actions[0]), ay, s.actions[0], 'ghost', press(r, CONSENT + 0.3));
    spot(CX - 8, 490, CW + 16, 124, 1 - band(r, 1.8, 4.3, 0.3));
    GA = base;
    mouse(r, 0.15, OPEN - 0.1, [CR - 40, 990], [CR - 60, 536], 0.62);
    mouse(r, 0.62, PICK - 0.1, [CR - 60, 536], [CX + 150, 579], 1.6);
    mouse(r, 4.0, CONSENT - 0.1, [CX + CW/6, 1000], [CX + 25, cy + 23], J - 0.1);
    toRail(r, DONE, [CX + 25, cy + 23], 3);
  }
  if (aJ > 0) { const jv = s.jev, JP = J + 0.9, JD = ITEMS[4].at, pk = ease(win(r, JP, JP + 0.2)); GA = base*aJ;
    txt(jv.heading, CX, 444, { font:`600 18px ${S}`, color:C.text });
    pill(CX + mw(jv.heading, `600 18px ${S}`) + 12, 427, jv.badge, 'dim');
    txt(jv.sub, CX, 470, { font:`400 13px ${S}`, color:C.dim });
    const bw = (CW - 20) / 2;
    jv.options.forEach((o, j) => {
      const x = CX + j*(bw + 20), y = 500, sel = j === 0 ? pk : 0;
      fillR(x, y, bw, 104, 12, sel > 0 ? hexA(C.acc, 0.1*sel) : C.surf2); strokeR(x + .5, y + .5, bw - 1, 103, 12, sel > 0 ? C.acc : C.line2, sel > 0 ? 1.5 : 1);
      txt(o.title, x + 20, y + 42, { font:`600 17px ${S}`, color: sel > 0.5 ? C.acc : C.text });
      txt(o.sub, x + 20, y + 72, { font:`400 13px ${S}`, color:C.dim });
      ctx.beginPath(); ctx.arc(x + bw - 26, y + 36, 9, 0, Math.PI*2); ctx.strokeStyle = sel > 0 ? C.acc : C.line2; ctx.lineWidth = 1.5; ctx.globalAlpha = GA; ctx.stroke(); ctx.globalAlpha = 1;
      if (sel > 0) dot(x + bw - 26, y + 36, 4.5, C.acc, sel);
    });
    txt(jv.planeTitle, CX, 652, { font:`400 12px ${M}`, color:C.dim });
    const pw = (CW - 3*12) / 4;
    jv.plane.forEach((p, j) => {
      const x = CX + j*(pw + 12), y = 668, off = p.off ? win(r, JD - 0.2, JD + 0.2) : 0, col = colorOf(p.color);
      fillR(x, y, pw, 82, 10, C.surf2); strokeR(x + .5, y + .5, pw - 1, 81, 10, off > 0 ? C.line : hexA(col, 0.5), 1);
      txt(p.id, x + 16, y + 34, { font:`600 18px ${M}`, color:col, alpha: 1 - 0.6*off });
      if (off > 0) ln(x + 14, y + 28, x + 16 + mw(p.id, `600 18px ${M}`)*off + 2, y + 28, C.human, 2);
      txt(p.off ? (off > 0.5 ? p.note : '') : p.note, x + 16, y + 62, { font:`400 13px ${S}`, color: p.off ? C.human : C.dim, alpha: p.off ? off : 1 });
    });
    const da = appear(r, JD + 0.3, 0);
    if (da > 0) { GA = base*aJ*da; const y = 790 + (1 - da)*8, h = 112;
      fillR(CX, y, CW, h, 12, hexA(C.ok, 0.08)); strokeR(CX + .5, y + .5, CW - 1, h - 1, 12, C.ok, 1.2);
      dot(CX + 34, y + 44, 14, C.ok); check(CX + 34, y + 44, C.bg, 1, 6);
      txt(jv.doneTitle, CX + 60, y + 44, { font:`600 18px ${S}`, color:C.text });
      txt(jv.doneBody, CX + 60, y + 72, { font:`400 13px ${S}`, color:C.dim });
      const dw = btnW(jv.doneButton); button(CR - 20 - dw, y + h/2 - 17, jv.doneButton, 'primary', press(r, s.sec - 0.55));
      GA = base; }
    GA = base;
    mouse(r, J + 0.3, JP - 0.1, [CX + 25, 1000], [CX + bw/2, 560], JD + 0.4);
    mouse(r, JD + 0.9, s.sec - 0.65, [CX + bw/2, 620], [CR - 20 - btnW(jv.doneButton)/2, 846], s.sec);
    toRail(r, JD, [CX + 20, 540], 4);
  }
}

// shot 5: one line in, one Work out — AI picks the Pack family
function intake(s, E, t) {
  const r = E.r, fa = ease(win(r, 0, 0.3)), CLICK = 3.05, CARD_AT = 3.7, SCAN = [3.9, 5.2], DEF = ITEMS[5].at;
  GA = fa;
  txt(WK.title, CX, CY + 44, { font:`600 22px ${S}`, color:C.text });
  langChip(CR, CY + 22);
  // header controls: search, 목록 | 보드 (board selected)
  const vf = `500 13px ${S}`, v1 = WK.views[1], v0 = WK.views[0], v1x = CR - 62 - 18 - mw(v1, vf), v0x = v1x - 18 - mw(v0, vf);
  txt(v0, v0x, CY + 40, { font:vf, color:C.dim }); txt(v1, v1x, CY + 40, { font:`600 13px ${S}`, color:C.text });
  fillR(v1x - 6, CY + 48, mw(v1, vf) + 12, 2, 1, C.acc);
  const sw = 150, sx = v0x - 18 - sw; fillR(sx, CY + 20, sw, 30, 7, C.bg); strokeR(sx + .5, CY + 20.5, sw - 1, 29, 7, C.line2, 1);
  txt(WK.search, sx + 12, CY + 40, { font:`400 13px ${S}`, color:C.faint });
  // intake box
  const iy = INTAKE.y; panel(CX, iy, CW, INTAKE.h, 12);
  const fw = CW - 28 - 112, tf = typeProgress(r, E.I), typing = r < E.I;
  fillR(CX + 14, iy + 14, fw, 46, 8, C.bg); strokeR(CX + 14.5, iy + 14.5, fw - 1, 45, 8, typing ? C.acc : C.line2, 1, typing ? 0.8 : 1);
  const shown = s.request.slice(0, Math.floor(s.request.length * tf)), rf = `400 15px ${S}`;
  if (r > CLICK + 0.1) txt(WK.placeholder, CX + 30, iy + 43, { font:rf, color:C.faint });
  else if (shown) txt(shown, CX + 30, iy + 43, { font:rf, color:C.text });
  else txt(WK.placeholder, CX + 30, iy + 43, { font:rf, color:C.faint });
  if (typing && Math.floor(t*4) % 2 === 0) { ctx.fillStyle = C.acc; ctx.fillRect(CX + 32 + mw(shown, rf), iy + 27, 8, 20); }
  const bx = CR - 14 - 100, pr = press(r, CLICK);
  fillR(bx, iy + 14 + pr*2, 100, 46, 8, C.acc); txt(WK.button, bx + 50, iy + 43 + pr*2, { font:`600 15px ${S}`, color:C.bg, align:'center' });
  if (r > CLICK && r < CLICK + 0.5) ripple(bx + 50, iy + 37, win(r, CLICK, CLICK + 0.5), C.acc, 6, 40);
  checkbox(CX + 16, iy + 72, 0); txt(WK.deep, CX + 44, iy + 86, { font:`400 12px ${S}`, color:C.dim });
  txt(WK.import, CR - 14, iy + 86, { font:`400 12px ${S}`, color:C.dim, align:'right' });
  // board
  const hy = 432, cols = WK.columns || [];
  cols.forEach((c, j) => {
    const x = CX + j*(COLW + 16), n = j === 2 && r >= CARD_AT ? 1 : 0;
    txt(c.label, x, hy, { font:`600 14px ${S}`, color:colorOf(c.color) });
    txt(String(n), x + mw(c.label, `600 14px ${S}`) + 8, hy, { font:`400 13px ${M}`, color:C.dim });
    ln(x, hy + 10.5, x + COLW, hy + 10.5, C.line, 1);
  });
  const kx = CX + 2*(COLW + 16), ca = ease(win(r, CARD_AT, CARD_AT + 0.25)), filled = ease(win(r, DEF - 0.5, DEF - 0.2));
  if (ca > 0) { GA = fa*ca; const ky = CARD.y + (1 - ca)*8;
    fillR(kx, ky, COLW, CARD.h, 10, C.surf2); strokeR(kx + .5, ky + .5, COLW - 1, CARD.h - 1, 10, filled > 0 ? C.acc : C.line2, 1, filled > 0 ? 0.4 + 0.6*filled : 1);
    if (filled <= 0) { spinner(kx + 22, ky + 24, t, C.acc, 6); txt(WK.defining, kx + 36, ky + 29, { font:`500 12px ${S}`, color:C.acc });
      [0, 1].forEach(i => fillR(kx + 14, ky + 50 + i*20, (COLW - 28)*(0.9 - i*0.3), 9, 4, C.line)); }
    else { GA = fa*ca*filled;
      // same card as the board: pack id, title, dashed state pill, short id, received time
      txt(fitText(WK.packs[WK.pick].id, `500 13px ${M}`, COLW - 28), kx + 14, ky + 28, { font:`500 13px ${M}`, color:C.text });
      wrapText(WK.cardTitle, `600 15px ${S}`, COLW - 28, 2).forEach((l, i) => txt(l, kx + 14, ky + 55 + i*21, { font:`600 15px ${S}`, color:C.text }));
      statusPill(kx + 14, ky + 72, WK.cardPill, 'dim', true);
      txt(WK.cardId, kx + COLW - 14, ky + 87, { font:`400 11px ${M}`, color:C.faint, align:'right' });
      txt(WK.cardFoot, kx + 14, ky + 124, { font:`400 12px ${S}`, color:C.text }); txt(WK.cardAge, kx + COLW - 14, ky + 124, { font:`400 12px ${S}`, color:C.faint, align:'right' }); }
    GA = fa; }
  // Pack families: the AI scans and locks onto one
  const gy = GRID.y, tw = (CW - 2*GRID.gap) / 3, packs = WK.packs || [];
  txt(WK.packsTitle, CX, gy - 14, { font:`600 15px ${S}`, color:C.text });
  txt(WK.packsNote, CR, gy - 14, { font:`400 12px ${M}`, color:C.dim, align:'right' });
  const sq = win(r, SCAN[0], SCAN[1]), order = packs.map((_, i) => i).concat([WK.pick]);
  const cur = r >= SCAN[0] ? order[Math.min(order.length - 1, Math.floor(sq*order.length))] : -1, locked = r >= SCAN[1];
  packs.forEach((p, i) => {
    const x = CX + (i % 3)*(tw + GRID.gap), y = gy + Math.floor(i/3)*(GRID.th + GRID.gap), hot = i === cur;
    fillR(x, y, tw, GRID.th, 10, hot && locked ? hexA(C.acc, 0.12) : C.surf2);
    strokeR(x + .5, y + .5, tw - 1, GRID.th - 1, 10, hot ? C.acc : C.line2, hot ? 1.6 : 1);
    txt(fitText(p.name, `600 15px ${S}`, tw - 28), x + 16, y + 32, { font:`600 15px ${S}`, color: hot ? C.acc : C.text });
    txt(fitText(p.note, `400 12px ${S}`, tw - 28), x + 16, y + 56, { font:`400 12px ${S}`, color:C.dim });
    txt(fitText(p.id, `400 11px ${M}`, tw - 28), x + 16, y + 82, { font:`400 11px ${M}`, color: hot ? C.acc : C.faint });
    if (hot && locked && r < SCAN[1] + 0.6) ripple(x + tw - 24, y + 24, win(r, SCAN[1], SCAN[1] + 0.6), C.acc, 6, 32);
  });
  GA = fa;
  // spotlight: intake → board → grid → board
  spot(CX - 8, hy - 22, CW + 16, 190, Math.max(band(r, CLICK, SCAN[0], 0.2), win(r, DEF - 0.6, DEF - 0.3)));
  spot(CX - 8, gy - 34, CW + 16, 3*GRID.th + 2*GRID.gap + 42, band(r, SCAN[0] - 0.2, DEF - 0.6, 0.2));
  GA = 1;
  flyTo(r, CLICK + 0.1, CARD_AT, [bx + 50, iy + 60], [kx + COLW/2, CARD.y + 20], 'acc');
  const pc = [CX + (WK.pick % 3)*(tw + GRID.gap) + tw/2, gy + Math.floor(WK.pick/3)*(GRID.th + GRID.gap) + 10];
  flyTo(r, SCAN[1] + 0.1, DEF - 0.5, pc, [kx + 30, CARD.y + CARD.h - 10], 'acc');
  toRail(r, DEF, [kx + 10, CARD.y + 20], 5, 'ok');
}

// shot 6: the Work, defined — then the connected agent picks it up
function detail(s, E, t) {
  const r = E.r, fa = ease(win(r, 0, 0.3)), PICK = ITEMS[6].at, run = r >= PICK, q = ease(win(r, PICK, PICK + 0.3));
  GA = fa;
  txt(DT.title, CX, CY + 44, { font:`600 22px ${S}`, color:C.text });
  langChip(CR, CY + 22);
  txt(DT.back, CX, 300, { font:`400 12px ${S}`, color:C.dim });
  pill(CX, 312, run ? DT.statusAfter : DT.statusBefore, 'acc');
  if (run) spinner(CX + mw(DT.statusAfter, `500 12px ${M}`) + 36, 323, t, C.acc, 5);
  txt(DT.workLabel, CR, 318, { font:`400 11px ${M}`, color:C.dim, align:'right', ls:1 });
  txt(DT.workId, CR, 346, { font:`600 24px ${M}`, color:C.acc, align:'right' });
  txt(run ? DT.runAfter : DT.runBefore, CR, 368, { font:`400 12px ${M}`, color: run ? C.acc : C.dim, align:'right' });
  txt(WK.cardTitle, CX, 364, { font:`600 24px ${S}`, color:C.text });
  fillR(CX, 382, CW, 46, 9, C.surf2); strokeR(CX + .5, 382.5, CW - 1, 45, 9, C.line2, 1);
  fillR(CX + 12, 394, 44, 22, 6, C.bg); txt('mcp', CX + 34, 409, { font:`600 12px ${M}`, color:C.text, align:'center' });
  txt(fitText(s.request, `400 15px ${S}`, CW - 104), CX + 68, 410, { font:`400 15px ${S}`, color:C.text });
  fillR(CR - 22, 395, 8, 20, 1, C.acc);
  txt(DT.packLabel, CX, 460, { font:`400 13px ${M}`, color:C.dim });
  const pw = pill(CX + 44, 444, WK.packs[WK.pick].id, 'acc');
  txt(DT.packNote, CX + 56 + pw, 460, { font:`400 13px ${M}`, color:C.dim });
  (DT.checks || []).forEach((c, j) => { const y = 474 + j*34, a = appear(r, 0.4, j); GA = fa*a;
    fillR(CX, y, CW, 28, 6, C.bg); strokeR(CX + .5, y + .5, CW - 1, 27, 6, C.line2, 1);
    check(CX + 16, y + 14, C.ok, 1, 4); txt(fitText(c, `400 13px ${S}`, CW - 44), CX + 32, y + 19, { font:`400 13px ${S}`, color:C.text }); GA = fa; });
  // plan
  const py = 560, lw = 300;
  txt(DT.planTitle, CX, py + 22, { font:`600 15px ${S}`, color:C.text }); ln(CX, py + 36.5, CX + lw, py + 36.5, C.line, 1);
  (DT.steps || []).forEach((st, k) => {
    const y = py + 76 + k*96, a = appear(r, 0.6, k), act = k === 0 && run; GA = fa*a;
    ctx.beginPath(); ctx.arc(CX + 14, y - 5, 13, 0, Math.PI*2); ctx.strokeStyle = act ? C.acc : C.line2; ctx.lineWidth = 1.5; ctx.globalAlpha = GA; ctx.stroke(); ctx.globalAlpha = 1;
    txt(pad2(k + 1), CX + 14, y - 1, { font:`600 11px ${M}`, color: act ? C.acc : C.dim, align:'center' });
    if (act) spinner(CX + 42, y - 5, t, C.acc, 5);
    txt(act ? DT.stepRun : DT.stepWait, CX + (act ? 54 : 38), y, { font:`400 13px ${S}`, color: act ? C.acc : C.dim });
    txt(st, CX + 38, y + 25, { font:`600 15px ${S}`, color:C.text });
    txt(act ? DT.assigned : DT.unassigned, CX + 38, y + 48, { font:`400 12px ${act ? M : S}`, color: act ? C.text : C.faint, alpha: act ? q : 1 });
    if (act) progressBar(CX + 38, y + 60, lw - 50, 0.08 + 0.3*win(r, PICK + 0.2, s.sec), 'acc', q);
    if (k < DT.steps.length - 1) ln(CX + 14, y + 10, CX + 14, y + 72, C.line2, 1.5);
    GA = fa;
  });
  // control box
  const bx = CX + lw + 22, bw = CW - lw - 22, by = py, bh = 340;
  fillR(bx, by, bw, bh, 12, C.surf); strokeR(bx + .5, by + .5, bw - 1, bh - 1, 12, C.human, 1.2);
  txt(DT.controlTitle, bx + 18, by + 30, { font:`600 15px ${S}`, color:C.human });
  const pbw = mw(DT.pause, `500 13px ${S}`) + 28; fillR(bx + 18, by + 44, pbw, 30, 7, hexA(C.human, 0.1)); strokeR(bx + 18.5, by + 44.5, pbw - 1, 29, 7, C.human, 1);
  txt(DT.pause, bx + 18 + pbw/2, by + 64, { font:`500 13px ${S}`, color:C.human, align:'center' });
  const nx = bx + 18, ny = by + 90, nw = bw - 36;
  fillR(nx, ny, nw, 156, 9, C.surf2); strokeR(nx + .5, ny + .5, nw - 1, 155, 9, run ? C.acc : C.line2, run ? 1.4 : 1, run ? q : 1);
  const title = run ? DT.runTitle : DT.waitTitle, body = run ? DT.runBody : DT.waitBody, ta = run ? q : 1;
  if (run) spinner(nx + 20, ny + 25, t, C.acc, 6);
  txt(fitText(title, `600 14px ${S}`, nw - 50), nx + (run ? 36 : 16), ny + 30, { font:`600 14px ${S}`, color: run ? C.acc : C.text, alpha:ta });
  wrapText(body, `400 13px ${S}`, nw - 32, 3).forEach((l, i) => txt(l, nx + 16, ny + 56 + i*20, { font:`400 13px ${S}`, color:C.dim, alpha:ta }));
  if (!run) button(nx + 16, ny + 110, DT.copy, 'ghost');
  txt(DT.jevLine, nx, by + 282, { font:`500 13px ${S}`, color:C.text });
  txt(run ? DT.historyAfter : DT.historyBefore, nx, by + 312, { font:`400 13px ${S}`, color: run ? C.text : C.dim });
  txt(fitText(DT.footer, `400 11px ${M}`, CW), CX + CW/2, 978, { font:`400 11px ${M}`, color:C.faint, align:'center' });
  spot(CX - 8, 296, CW + 16, 272, 1 - band(r, 3.0, 99, 0.3));
  GA = 1;
  // pickup: the connected agent (rail step 2) reaches into the Work
  const q2 = win(r, PICK - 0.6, PICK);
  if (q2 > 0 && q2 < 1) { const pts = [[RDX, railY(1)], [HERO.x - 10, railY(1)], [HERO.x - 10, 548], [nx + 20, 548], [nx + 20, ny + 25]], p = along(pts, ease(q2));
    for (let k = 1; k < pts.length; k++) ln(pts[k-1][0], pts[k-1][1], pts[k][0], pts[k][1], hexA(C.acc, 0.3), 1, 1, [3, 5]);
    token(p[0], p[1], 'acc'); }
  if (r > PICK && r < PICK + 0.6) ripple(nx + 20, ny + 25, win(r, PICK, PICK + 0.6), C.acc, 8, 40);
}

boot({ clock: SEQ, count: SHOTS.length, prepare, draw, times: shotKeys(SEQ, [0.18, 0.4, 0.55, 0.72, 0.97]) });
