/* Quotenlabor – Dashboard. Liest data/state.json (von GitHub Actions geschrieben)
   und Live-Stände direkt von der öffentlichen ESPN-Scoreboard-API. */
(() => {
  "use strict";
  const TZ = "Europe/Berlin";
  const DUR = { "Fußball": 2.0, "Basketball": 2.75, "Eishockey": 3.0, "American Football": 3.75 };
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const sgn = (n) => (n > 0.004 ? "+" : n < -0.004 ? "−" : "");
  const eur = (n, sign) => (n == null ? "–" : (sign ? sgn(n) : n < -0.004 ? "−" : "") + nf2.format(Math.abs(n)) + " €");
  const eur0 = (n) => (Number.isInteger(n) ? n.toLocaleString("de-DE") : nf2.format(n)) + " €";
  const pct = (x, sign) => (x == null ? "–" : (sign ? sgn(x) : x < 0 ? "−" : "") + nf1.format(Math.abs(x * 100)) + " %");
  const odds = (o) => (o == null ? "–" : nf2.format(o));
  const fmt = (iso, opts) => new Intl.DateTimeFormat("de-DE", { timeZone: TZ, ...opts }).format(new Date(iso));
  const hhmm = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
  const wd = (iso) => fmt(iso, { weekday: "short" }).replace(".", "");
  const berlinDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

  let state = null;
  let selectedDay = null;
  let view = decodeURIComponent(location.hash.slice(1)) || "vergleich";
  const P = () => state.players[view] || state.players.analyst;
  const myBets = () => (view === "vergleich" ? state.bets : state.bets.filter((b) => b.player === P().id));
  const pName = (id) => state.players[id]?.name || id;
  let firstRender = true;
  const open = new Set();
  const live = {};          // betId -> {home_score, away_score, detail, state}
  const matches = {};       // ESPN-Event-ID -> Live-Stand
  let hubUpdated = null;
  let sportFilter = "Alle";
  let showAllEvents = false;
  const fresh = new Set();  // in dieser Sitzung neu abgerechnete Wetten -> Stempel-Animation

  // ------------------------------------------------------------------ Laden
  async function load() {
    try {
      const r = await fetch(`data/state.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state = await r.json();
      detectNewResults();
      render();
      firstRender = false;
      pollLive();
    } catch (e) {
      console.error(e);
      $("topStatus").textContent = "Daten konnten nicht geladen werden. Die Seite versucht es in einer Minute erneut.";
    }
  }

  // ------------------------------------------------------------------ Neue Ergebnisse feiern
  function detectNewResults() {
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem("pv_seen") || "null"); } catch (_) { /* privat */ }
    const now = {};
    const news = [];
    for (const b of state.bets) {
      now[b.id] = b.status;
      if (seen && b.status !== "open" && seen[b.id] !== b.status) news.push(b);
    }
    try { localStorage.setItem("pv_seen", JSON.stringify(now)); } catch (_) { /* egal */ }
    news.forEach((b) => fresh.add(b.id));
    // Vollbild-Moment: im Vergleich der größte Knaller aller Spieler, sonst der des gewählten Spielers
    const pool = news.filter((b) => !state.players[view] || b.player === view);
    const bigWin = pool.filter((b) => b.status === "won" && (b.profit >= 40 || b.odds >= 3.5)).sort((a, b) => b.profit - a.profit)[0];
    const beat = pool.filter((b) => nearMiss(b)).sort((a, b) => a.profit - b.profit)[0];
    if (bigWin) setTimeout(() => showMoment("win", bigWin), 700);
    else if (beat) setTimeout(() => showMoment("beat", beat), 700);
    const mine = news.filter((b) => b.player === (state.players[view] ? view : "analyst"));
    if (!mine.length) return;
    const who = pName(state.players[view] ? view : "analyst");
    const won = mine.filter((b) => b.status === "won");
    const lost = mine.filter((b) => b.status === "lost");
    const sum = mine.reduce((a, b) => a + (b.profit || 0), 0);
    const parts = [];
    if (won.length) parts.push(`${won.length} gewonnen`);
    if (lost.length) parts.push(`${lost.length} verloren`);
    toast(`${who}: ${parts.join(", ") || `${mine.length} Wetten`} neu abgerechnet, zusammen <b>${eur(sum, true)}</b>`, sum < 0);
    if (won.length) setTimeout(() => coins(won.length), 500);
    if (won.length && !bigWin) sfx("win");
  }

  function toast(html, neg) {
    const t = el("div", "toast" + (neg ? " t-l" : ""), html);
    t.setAttribute("role", "status");
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function coins(n, origin) {
    if (REDUCED) return;
    const fx = $("fx");
    const ox = origin?.x ?? window.innerWidth / 2;
    const oy = origin?.y ?? Math.min(window.innerHeight * 0.45, 320);
    const count = Math.min(10 + n * 6, 36);
    for (let i = 0; i < count; i++) {
      const c = el("span", "coin", "€");
      c.style.left = `${ox - 11}px`; c.style.top = `${oy - 11}px`;
      c.style.setProperty("--dx", `${(Math.random() - 0.5) * 520}px`);
      c.style.setProperty("--up", `${-120 - Math.random() * 220}px`);
      c.style.animationDelay = `${Math.random() * 0.25}s`;
      fx.appendChild(c);
      setTimeout(() => c.remove(), 1800);
    }
  }

  // ------------------------------------------------------------------ Live
  // Spiele, auf die gerade Wetten laufen (Kombi-Spiele einzeln). pid = null: alle Spieler
  function matchEntries(pid = null) {
    const map = new Map();
    const add = (src, pick) => {
      const key = src.espn ? `e${src.espn.id}` : `o${src.event_id}`;
      if (!map.has(key)) map.set(key, { key, espn: src.espn || null, league: src.league, group: src.group, home: src.home, away: src.away, commence: src.commence, picks: [] });
      map.get(key).picks.push(pick);
    };
    for (const b of state?.bets || []) {
      if (b.status !== "open" || (pid && b.player !== pid)) continue;
      if (b.market === "combo") {
        for (const l of b.legs) if (l.status === "open") add(l, { id: `${b.id}-${l.event_id}`, player: b.player, label: l.label, odds: l.odds, stake: b.stake, market: l.market, key: l.key, point: l.point, p: l.p, combo: b.label });
      } else add(b, { id: b.id, player: b.player, label: b.label, odds: b.odds, stake: b.stake, market: b.market, key: b.key, point: b.point, p: b.p });
    }
    const rank = (id) => state.order.indexOf(id);
    const out = [...map.values()];
    out.forEach((e) => e.picks.sort((x, y) => rank(x.player) - rank(y.player)));
    return out.sort((x, y) => x.commence.localeCompare(y.commence));
  }
  const inPlayWindow = (e) => {
    const now = Date.now(), t = new Date(e.commence).getTime();
    return now >= t - 5 * 60e3 && now <= t + ((DUR[e.group] || 2.5) + 1.5) * 3600e3;
  };

  let lastFullPoll = 0;
  async function pollLive() {
    if (!state) return;
    const full = Date.now() - lastFullPoll > 5 * 60e3;
    const soon = (e) => new Date(e.commence).getTime() - Date.now() < 36 * 3600e3;
    const pool = [...matchEntries(), ...recentEntries()].filter((e) => e.espn && (inPlayWindow(e) || (full && soon(e))));
    const goals = new Set();
    if (pool.length) {
      if (full) lastFullPoll = Date.now();
      const want = new Map();
      for (const e of pool) {
        const t = new Date(e.commence);
        for (const h of [-8, 0]) {
          const d = new Date(t.getTime() + h * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
          want.set(`${e.espn.path}|${d}`, [e.espn.path, d]);
        }
      }
      const events = {};
      await Promise.all([...want.values()].map(async ([path, d]) => {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${d}`);
          const j = await r.json();
          for (const ev of j.events || []) events[ev.id] = ev;
        } catch (_) { /* nächster Versuch */ }
      }));
      for (const e of pool) {
        const ev = events[e.espn.id];
        if (!ev) continue;
        const c = ev.competitions[0];
        const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
        const h = side("home"), a = side("away");
        const nv = {
          home_score: +h.score || 0, away_score: +a.score || 0,
          detail: ev.status.type.shortDetail, state: /POSTPONED|CANCELED|SUSPENDED|ABANDONED|DELAYED/.test(ev.status.type.name) ? "pre" : ev.status.type.state, name: ev.status.type.name,
          clock: ev.status.displayClock, period: ev.status.period,
          home_abbr: h.team.abbreviation, away_abbr: a.team.abbreviation,
          home_color: h.team.color, away_color: a.team.color, home_id: h.team.id, away_id: a.team.id,
          details: c.details || [],
        };
        const old = matches[e.espn.id];
        if (old && old.state === "in" && (old.home_score !== nv.home_score || old.away_score !== nv.away_score)) { goals.add(e.key); localFeed(e, old, nv); }
        if (old && old.state === "pre" && nv.state === "in") pushFeed({ id: `ko-${e.key}`, t: Date.now(), kind: "info", tag: "Anpfiff", text: `${e.home} – ${e.away}`, league: e.league });
        if (old && old.state === "in" && nv.state === "post") pushFeed({ id: `ft-${e.key}`, t: Date.now(), kind: "info", tag: "Abpfiff", text: `${e.home} ${nv.home_score}:${nv.away_score} ${e.away}`, league: e.league });
        matches[e.espn.id] = nv;
      }
      for (const b of state.bets) if (b.espn && matches[b.espn.id]) live[b.id] = matches[b.espn.id];
      hubUpdated = new Date();
    }
    if (goals.size) sfx("goal");
    renderStage(goals);
    renderHub(goals);
    renderScorebar();
    renderFeed();
    if (pool.length) {
      if (view !== "vergleich") { renderSlips(); renderDays(); }
      renderTop();
    }
  }

  // ------------------------------------------------------------------ Wett-Hilfen
  function grade(b, hs, as) {
    const k = b.key, pt = b.point;
    if (b.market === "h2h") { const r = hs > as ? "home" : as > hs ? "away" : "draw"; return r === k ? "won" : "lost"; }
    if (b.market === "totals") { const t = hs + as; if (t === pt) return "push"; return (t > pt) === (k === "over") ? "won" : "lost"; }
    if (b.market === "spreads") { const m = hs - as + pt; if (m === 0) return "push"; return (m > 0) === (k === "home") ? "won" : "lost"; }
    return null;
  }
  const isLive = (b) => live[b.id] && live[b.id].state === "in" && b.status === "open";

  function stamp(b) {
    const lv = live[b.id];
    const slam = fresh.has(b.id) ? " slam" : "";
    if (b.status === "won") return `<span class="stamp st-won${slam}">Gewonnen<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "lost") return `<span class="stamp st-lost${slam}">Verloren<small>${eur(b.profit, true)}</small></span>`;
    if (b.status === "push" || b.status === "void") return `<span class="stamp st-push">${b.status === "push" ? "Push" : "Abgesagt"}<small>Einsatz zurück</small></span>`;
    if (lv && lv.state === "in") return `<span class="stamp st-live">Live ${lv.home_score}:${lv.away_score}<small>${esc(lv.detail)}</small></span>`;
    if (lv && lv.state === "post") return `<span class="stamp st-open">Wird abgerechnet<small>${lv.home_score}:${lv.away_score}</small></span>`;
    return `<span class="stamp st-open">Offen<small data-countdown="${b.commence}">${countdownText(b.commence)}</small></span>`;
  }

  function countdownText(iso) {
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return "läuft";
    if (s > 6 * 3600) return `${wd(iso)} ${hhmm(iso)}`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `in ${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `in ${m}:${String(sec).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------------ Render
  function render() {
    const cmp = view === "vergleich";
    $("boardCompare").hidden = !cmp; $("compareView").hidden = !cmp;
    $("boardPlayer").hidden = cmp; $("playerView").hidden = cmp;
    if (cmp) $("bookBand").after($("board")); else $("bookBand").before($("board"));
    renderTabs();
    renderTop();
    renderJackpot();
    renderStage();
    renderMini();
    renderHub();
    renderScorebar();
    renderFeed();
    if (cmp) { renderCompare(); renderMethod(); renderSys(); return; }
    renderBoard();
    renderChart();
    renderDayChart();
    renderDays();
    renderSlips();
    renderLeagues();
    renderClv();
    renderHits();
    renderSkill();
    renderMethod();
    renderSys();
  }

  function renderTop() {
    if (!state) return;
    const today = berlinDate();
    const i = state.days.findIndex((d) => d.date === today);
    const lv = matchEntries().filter((e) => e.espn && matches[e.espn.id]?.state === "in").length;
    let txt, short;
    if (i >= 0) { txt = `<b>Tag ${i + 1}</b> von ${state.experiment.days}`; short = `<b>Tag ${i + 1}</b>/${state.experiment.days}`; }
    else if (today < state.days[0].date) { txt = `Start am ${fmt(state.days[0].date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" })}`; short = `Start ${fmt(state.days[0].date + "T12:00:00", { weekday: "short", day: "numeric", month: "numeric" })}`; }
    else { txt = "Experiment beendet"; short = "Beendet"; }
    const lvTxt = lv ? `, <b>${lv} ${lv === 1 ? "Spiel" : "Spiele"} live</b>` : "";
    $("topStatus").innerHTML = `<span class="dot ${lv ? "is-live" : ""}"></span><span class="st-long">${txt}${lvTxt}, aktualisiert ${hhmm(state.generated_at)} Uhr</span><span class="st-short">${short}${lvTxt}</span>`;
  }

  // Zahlenwalzen für den Kontostand
  function odometer(node, text) {
    const chars = [...text];
    const shape = chars.map((c) => (/\d/.test(c) ? "d" : c)).join("");
    if (node.dataset.shape !== shape) {
      node.innerHTML = "";
      chars.forEach((c) => {
        if (/\d/.test(c)) {
          const reel = el("span", "reel");
          const strip = el("span", "reel-strip");
          for (let k = 0; k < 20; k++) strip.appendChild(el("span", null, String(k % 10)));
          reel.appendChild(strip);
          node.appendChild(reel);
        } else node.appendChild(el("span", "reel-static", esc(c)));
      });
      node.appendChild(el("span", "cur", "€"));
      node.dataset.shape = shape;
    }
    const strips = node.querySelectorAll(".reel-strip");
    setTimeout(() => {
      let di = 0;
      chars.forEach((c) => {
        if (!/\d/.test(c)) return;
        const s = strips[di++];
        s.style.transitionDelay = `${di * 70}ms`;
        s.style.transform = `translateY(-${(10 + +c) * 5}%)`;
      });
    }, 40);
  }

  function renderBoard() {
    const t = P().totals;
    const settled = t.won + t.lost + t.push;
    const bal = $("balance");
    bal.className = "balance" + (t.profit > 0.004 ? " pos" : t.profit < -0.004 ? " neg" : "");
    bal.setAttribute("aria-label", `Gewinn ${eur(t.profit, true)}`);
    odometer(bal, sgn(t.profit) + nf2.format(Math.abs(t.profit)));
    $("heroKicker").innerHTML = avatar(P().id) + (settled ? `${esc(P().name)}: Gewinn nach ${settled} abgerechneten ${settled === 1 ? "Wette" : "Wetten"}` : `${esc(P().name)}: noch keine Wette abgerechnet`);
    const total = state.experiment.total_budget;
    let line = `<b>${eur0(total)} Spielgeld</b>, ${state.experiment.days} Tage, jeden Tag genau ${eur0(state.experiment.daily_budget)} gesetzt.`;
    if (t.staked) line += ` Bisher ${eur(t.staked)} im Spiel, <b>${eur(t.returned)}</b> kamen zurück.`;
    else line += " Die ersten Wetten gehen am Starttag um 11:00 Uhr raus.";
    $("heroLine").innerHTML = line;
    $("bSettled").style.width = `${(t.staked_settled / total) * 100}%`;
    $("bOpen").style.width = `${(t.open_stake / total) * 100}%`;
    $("budgetLegend").innerHTML = `<span style="--c:var(--pen)">abgerechnet ${eur0(t.staked_settled)}</span><span style="--c:var(--live)">offen ${eur0(t.open_stake)}</span><span style="--c:var(--board-2)">übrig ${eur0(Math.max(0, total - t.staked))}</span>`;

    const next = myBets().filter((b) => b.status === "open" && new Date(b.commence) > new Date()).sort((a, b) => a.commence.localeCompare(b.commence))[0];
    const roiCls = t.roi > 0 ? "k-gain" : t.roi < 0 ? "k-loss" : "";
    const clvCls = t.avg_clv > 0 ? "k-gain" : t.avg_clv < 0 ? "k-loss" : "";
    const kpis = [
      ["Rendite", t.roi == null ? "–" : pct(t.roi, true), `auf ${eur0(t.staked_settled)} Einsatz`, roiCls],
      ["Trefferquote", t.hit_rate == null ? "–" : pct(t.hit_rate), t.won + t.lost ? `${t.won} von ${t.won + t.lost} Wetten` : "noch keine", ""],
      ["Ø Quote", t.avg_odds ? odds(t.avg_odds) : "–", "über alle Wetten", ""],
      ["Ø Closing Line Value", t.avg_clv == null ? "–" : pct(t.avg_clv, true), t.n_clv ? `${t.clv_positive} von ${t.n_clv} besser als Schluss` : "noch keine Schlusskurse", clvCls],
      ["Mögliche Auszahlung", t.open_stake ? eur(t.open_potential) : "–", t.open_stake ? `bei ${eur0(t.open_stake)} Einsatz` : "nichts offen", ""],
      ["Nächster Anpfiff", next ? `<span data-countdown="${next.commence}">${countdownText(next.commence)}</span>` : "–", next ? `${esc(next.home)} – ${esc(next.away)}` : "keine offenen Spiele", "k-count"],
    ];
    $("facts").innerHTML = kpis.map(([k, v, s, c]) => `<div><dt>${k}</dt><dd class="${c}">${v}<small>${s}</small></dd></div>`).join("");
  }

  // ------------------------------------------------------------------ Score-Leiste
  function recentEntries() {
    const map = new Map();
    const cut = Date.now() - 20 * 3600e3;
    for (const b of state?.bets || []) {
      if (b.status === "open" || b.market === "combo" || !b.result || b.result.home == null || new Date(b.commence).getTime() < cut) continue;
      const key = b.espn ? `e${b.espn.id}` : `o${b.event_id}`;
      if (!map.has(key)) map.set(key, { key, espn: b.espn || null, league: b.league, group: b.group, home: b.home, away: b.away, commence: b.commence, final: { home: b.result.home, away: b.result.away }, profit: 0, picks: [] });
      const e = map.get(key);
      if (b.player === "analyst") e.profit += b.profit || 0;
      e.picks.push(b);
    }
    return [...map.values()].sort((x, y) => y.commence.localeCompare(x.commence));
  }
  const abbr = (name) => name.replace(/^(FC|SC|SV|VfB|VfL|TSG|FSV|1\.|AS|AC|RB)\s+/g, "").slice(0, 3).toUpperCase();
  const hue = (t) => { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 38%)`; };
  function teamBadge(name, m, side) {
    const ab = m?.[`${side}_abbr`] || abbr(name);
    const col = m?.[`${side}_color`] ? `#${m[`${side}_color`]}` : hue(name);
    return `<i class="tm" style="--t:${col}">${esc(ab)}</i>`;
  }
  function sbTile(e, kind) {
    const m = e.espn ? matches[e.espn.id] : null;
    const hs = kind === "final" ? (e.final?.home ?? m?.home_score) : m?.home_score;
    const as = kind === "final" ? (e.final?.away ?? m?.away_score) : m?.away_score;
    const head = kind === "live" ? `<b class="sb-live">${esc(clockDe(m))}</b>` : kind === "final" ? "Endstand" : `${wd(e.commence)} ${hhmm(e.commence)}`;
    let bet = "";
    if (kind === "live") {
      let sum = 0, n = 0;
      for (const p of e.picks) if (!p.combo) { sum += betStory(p, e, hs, as).profit; n++; }
      if (n) bet = `<span class="sb-bet ${sum > 0 ? "up" : sum < 0 ? "down" : ""}">${sum > 0 ? "▲" : sum < 0 ? "▼" : "■"} ${eur(sum, true)}</span>`;
    } else if (kind === "next") bet = `<span class="sb-bet">${plural(e.picks.length, "Wette", "Wetten")}</span>`;
    const score = (v) => (v == null || kind === "next" ? "" : `<b>${v}</b>`);
    return `<a class="sb-tile ${kind === "live" ? "is-live" : ""}" href="#m-${esc(e.key)}">
      <span class="sb-head"><span>${esc(e.league)}</span><span>${head}</span></span>
      <span class="sb-row">${teamBadge(e.home, m, "home")}<span class="sb-name">${esc(e.home)}</span>${score(hs)}</span>
      <span class="sb-row">${teamBadge(e.away, m, "away")}<span class="sb-name">${esc(e.away)}</span>${score(as)}</span>${bet}</a>`;
  }
  let sbOffset = 0, sbBase = 0, sbPaused = false, sbLast = 0, sbHtml = "";
  function renderScorebar() {
    if (!state) return;
    const all = matchEntries();
    const st = (e) => (e.espn && matches[e.espn.id] ? matches[e.espn.id].state : null);
    const running = all.filter((e) => st(e) === "in");
    const next = all.filter((e) => st(e) !== "in" && st(e) !== "post" && new Date(e.commence) > new Date()).slice(0, 10);
    const done = recentEntries().slice(0, 8);
    const tiles = [...running.map((e) => sbTile(e, "live")), ...next.map((e) => sbTile(e, "next")), ...done.map((e) => sbTile(e, "final"))];
    $("sbLabel").textContent = running.length ? "Live" : "Scores";
    $("sbLabel").classList.toggle("is-live", !!running.length);
    const track = $("sbTrack");
    if (!tiles.length) { track.innerHTML = `<span class="sb-empty">Die nächsten Wetten werden um 11:00 Uhr gesetzt.</span>`; sbBase = 0; sbHtml = ""; return; }
    const repeat = Math.max(2, Math.ceil(window.innerWidth / (tiles.length * 190)) + 1);
    const html = tiles.join("");
    if (html === sbHtml && track.children.length) return;
    sbHtml = html;
    track.innerHTML = Array(repeat).fill(html).join("");
    sbBase = track.scrollWidth / repeat;
    if (sbOffset >= sbBase) sbOffset = 0;
  }
  function sbFrame(ts) {
    if (sbLast && !sbPaused && sbBase) {
      sbOffset += (ts - sbLast) * 0.04;
      if (sbOffset >= sbBase) sbOffset -= sbBase;
      $("sbTrack").style.transform = `translateX(${-sbOffset}px)`;
    }
    sbLast = ts;
    requestAnimationFrame(sbFrame);
  }

  // ------------------------------------------------------------------ Live-Ticker (Tore, Karten, An-/Abpfiff)
  const feedItems = new Map();
  const feedSeen = new Set();
  const pushFeed = (item) => { if (!feedItems.has(item.id)) feedItems.set(item.id, item); };
  function localFeed(e, old, nv) {
    if (e.group === "Fußball") return; // kommt aus den ESPN-Details
    const lead = (m) => Math.sign(m.home_score - m.away_score);
    if (e.group === "Basketball" && lead(old) === lead(nv)) return;
    const tag = e.group === "Basketball" ? "Führungswechsel" : e.group === "Eishockey" ? "Tor" : "Punkte";
    pushFeed({ id: `s-${e.key}-${nv.home_score}-${nv.away_score}`, t: Date.now(), kind: tag === "Führungswechsel" ? "info" : "goal", tag, text: `${e.home} ${nv.home_score}:${nv.away_score} ${e.away}`, league: e.league, ekey: e.key, clock: clockDe(nv) });
  }
  function collectDetails() {
    for (const e of matchEntries()) {
      const m = e.espn ? matches[e.espn.id] : null;
      if (!m || m.state === "pre") continue;
      const lastGoal = [...m.details].reverse().find((d) => d.scoringPlay);
      for (const d of m.details) {
        const kind = d.scoringPlay ? "goal" : d.redCard ? "red" : d.yellowCard ? "yellow" : null;
        if (!kind) continue;
        const min = parseInt(d.clock?.displayValue, 10) || 0;
        const who = (d.athletesInvolved || []).map((a) => a.displayName).join(", ");
        const team = d.team?.id === m.home_id ? e.home : e.away;
        const tag = d.ownGoal ? "Eigentor" : d.penaltyKick && d.scoringPlay ? "Elfmeter" : kind === "goal" ? "Tor" : kind === "red" ? "Rot" : "Gelb";
        const t = new Date(e.commence).getTime() + (min + (min > 45 ? 15 : 0)) * 60e3;
        const id = `${e.key}-${kind}-${d.clock?.displayValue}-${who}`;
        feedItems.set(id, { id, t, kind, tag, clock: d.clock?.displayValue, text: who ? `${who} (${team})` : team, league: `${e.home} – ${e.away}`, ekey: d === lastGoal ? e.key : null });
      }
    }
  }
  function goalImpact(ekey) {
    const pid = state.players[view] ? view : null;
    const e = matchEntries(pid).find((x) => x.key === ekey);
    const m = e && e.espn ? matches[e.espn.id] : null;
    if (!m) return "";
    const parts = e.picks.filter((p) => !p.combo).slice(0, 3).map((p) => {
      const s = betStory(p, e, m.home_score, m.away_score);
      return `<span class="${s.g === "won" ? "up" : s.g === "lost" ? "down" : ""}">${esc(shortName(p.player))} ${s.g === "won" ? "▲" : s.g === "lost" ? "▼" : "■"} ${eur(s.profit, true)}</span>`;
    });
    return `<span class="fd-impact"><b>${m.home_score}:${m.away_score}</b> ${parts.join(" ")}</span>`;
  }
  function renderFeed() {
    if (!state) return;
    collectDetails();
    const items = [...feedItems.values()].sort((a, b) => b.t - a.t).slice(0, 30);
    const firstPaint = !feedSeen.size;
    $("feed").innerHTML = items.length ? items.map((it) => {
      const isNew = !firstPaint && !feedSeen.has(it.id);
      return `<li class="fd fd-${it.kind} ${isNew ? "fd-new" : ""}"><span class="fd-ico" aria-hidden="true"></span><span class="fd-min">${esc(it.clock || hhmm(new Date(it.t).toISOString()))}</span><div class="fd-body"><span class="fd-tag">${esc(it.tag)}</span> ${esc(it.text)}<small>${esc(it.league)}</small>${it.ekey ? goalImpact(it.ekey) : ""}</div></li>`;
    }).join("") : `<li class="fd-empty">Sobald unsere Spiele laufen, erscheinen hier Tore, Karten und Abpfiffe.</li>`;
    items.forEach((it) => feedSeen.add(it.id));
  }

  // ------------------------------------------------------------------ Live-Siegchance und Cash-out
  // Vorab-Wahrscheinlichkeit der Wette + Spielstand + Restzeit = aktuelle Chance.
  // Fußball/Eishockey: Poisson-Modell. Basketball/Football: Normalverteilung.
  const CASHOUT_MARGIN = 0.95;
  const pois = (k, l) => { if (l <= 0) return k === 0 ? 1 : 0; let v = Math.exp(-l); for (let i = 1; i <= k; i++) v *= l / i; return v; };
  const normCdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp((-x * x) / 2); const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - q : q; };
  const normInv = (p) => { let lo = -6, hi = 6; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
  const outcomeOf = (p, group) => (h, a) => {
    if (p.market === "h2h") {
      if (h === a) return p.key === "draw" ? 1 : group === "Eishockey" ? 0.5 : 0;
      return (h > a) === (p.key === "home") && p.key !== "draw" ? 1 : 0;
    }
    if (p.market === "totals") { const t = h + a; if (t === p.point) return 0.5; return (t > p.point) === (p.key === "over") ? 1 : 0; }
    return 0;
  };
  function poisChance(p, group, lh, la, hs, as) {
    const test = outcomeOf(p, group), max = group === "Eishockey" ? 12 : 10;
    let sum = 0;
    for (let i = 0; i <= max; i++) { const pi = pois(i, lh); for (let j = 0; j <= max; j++) sum += pi * pois(j, la) * test(hs + i, as + j); }
    return sum;
  }
  const fitCache = new Map();
  function fitGoals(p, group) {
    const key = `${group}|${p.market}|${p.key}|${p.point}|${p.p}`;
    if (fitCache.has(key)) return fitCache.get(key);
    const T0 = group === "Eishockey" ? 6 : 2.7, target = Math.min(0.98, Math.max(0.02, p.p));
    const lam = (T, s) => [Math.max(0.05, (T + s) / 2), Math.max(0.05, (T - s) / 2)];
    const bisect = (lo, hi, f) => { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) < target) lo = m; else hi = m; } return (lo + hi) / 2; };
    let fit;
    if (p.market === "h2h" && p.key !== "draw") {
      const sign = p.key === "home" ? 1 : -1;
      const sx = bisect(-5, 5, (x) => { const [h, a] = lam(T0, sign * x); return poisChance(p, group, h, a, 0, 0); });
      fit = lam(T0, sign * sx);
    } else if (p.market === "h2h") {
      const T = bisect(-9, -0.5, (x) => { const [h, a] = lam(-x, 0.3); return poisChance(p, group, h, a, 0, 0); });
      fit = lam(-T, 0.3);
    } else {
      const sign = p.key === "over" ? 1 : -1;
      const x = bisect(sign > 0 ? 0.4 : -14, sign > 0 ? 14 : -0.4, (v) => { const [h, a] = lam(Math.abs(v), 0.3); return poisChance(p, group, h, a, 0, 0); });
      fit = lam(Math.abs(x), 0.3);
    }
    fitCache.set(key, fit);
    return fit;
  }
  function chanceAt(p, group, hs, as, progress) {
    if (p.p == null) return null;
    const rem = Math.min(1, Math.max(0.004, 1 - progress / 100));
    if (group === "Fußball" || group === "Eishockey") {
      if (p.market === "spreads") return null;
      const [lh, la] = fitGoals(p, group);
      return poisChance(p, group, lh * rem, la * rem, hs, as);
    }
    const nfl = group === "American Football";
    const sdM = nfl ? 13.5 : 12, sdT = nfl ? 13 : 18, z = normInv(Math.min(0.98, Math.max(0.02, p.p)));
    if (p.market === "totals") {
      const m = p.key === "over" ? p.point + sdT * z : p.point - sdT * z;
      const pOver = normCdf((hs + as + m * rem - p.point) / (sdT * Math.sqrt(rem)));
      return p.key === "over" ? pOver : 1 - pOver;
    }
    const pt = p.market === "spreads" ? p.point : 0;
    const mu = p.key === "home" ? sdM * z - pt : -pt - sdM * z;
    const pHome = normCdf((hs - as + mu * rem + pt) / (sdM * Math.sqrt(rem)));
    return p.key === "home" ? pHome : 1 - pHome;
  }
  const liveChance = (p, e, m) => chanceAt(p, e.group, m.home_score, m.away_score, gameProgress(e, m));
  const cashoutOf = (p, c) => Math.min(p.stake * p.odds, p.stake * p.odds * c * CASHOUT_MARGIN);
  function goalsFromDetails(m) {
    const out = [];
    for (const d of m?.details || []) {
      if (!d.scoringPlay) continue;
      out.push({ min: parseInt(d.clock?.displayValue, 10) || 0, side: d.team?.id === m.home_id ? "home" : "away", og: !!d.ownGoal });
    }
    if (out.length && out.filter((g) => g.side === "home").length !== m.home_score) out.forEach((g) => { if (g.og) g.side = g.side === "home" ? "away" : "home"; });
    return out.sort((a, b) => a.min - b.min);
  }
  function curveFromGoals(p, group, goals, upto) {
    const mins = new Set([0, upto]);
    for (let i = 3; i < upto; i += 3) mins.add(i);
    goals.forEach((g) => { if (g.min <= upto) { mins.add(Math.max(0, g.min - 0.01)); mins.add(g.min); } });
    return [...mins].sort((a, b) => a - b).map((min) => {
      let h = 0, a = 0;
      goals.forEach((g) => { if (g.min <= min) { if (g.side === "home") h++; else a++; } });
      return { min, x: Math.min(100, (min / 90) * 100), c: chanceAt(p, group, h, a, Math.min(100, (min / 90) * 100)) };
    });
  }
  const liveCurves = {};
  function chanceCurve(p, e, m) {
    if (e.group === "Fußball") return curveFromGoals(p, e.group, goalsFromDetails(m), Math.min(90, parseInt(m.clock, 10) || (/HALFTIME/.test(m.name || "") ? 45 : 0)));
    const store = (liveCurves[p.id] ||= [{ x: 0, c: p.p }]);
    const x = gameProgress(e, m), c = liveChance(p, e, m);
    if (c != null && (!store.length || x > store[store.length - 1].x + 0.2)) store.push({ x, c });
    return store;
  }
  function cashoutReview(b) {
    if (b.group !== "Fußball" || b.market === "combo" || !["won", "lost"].includes(b.status)) return "";
    const m = b.espn ? matches[b.espn.id] : null;
    const goals = b.result?.goals || (m?.state === "post" ? goalsFromDetails(m) : null);
    if (!goals) return "";
    const pts = curveFromGoals(b, b.group, goals, 90).filter((x) => x.c != null);
    if (!pts.length) return "";
    const best = pts.reduce((a, x) => (x.c > a.c ? x : a), pts[0]);
    const val = cashoutOf(b, best.c);
    const better = val > b.payout + 0.005;
    return `<p class="co-review"><b>Cash-out-Rückblick:</b> Am höchsten stand er bei ${eur(val)} in Minute ${Math.round(best.min)}. Am Ende wurden es ${eur(b.payout)}. ${better ? "Auscashen hätte sich gelohnt." : "Durchhalten war richtig."}</p>`;
  }

  // ------------------------------------------------------------------ Figuren
  const FACE = (body, bg) => `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="${bg}"/>${body}</svg>`;
  const SKIN = "#FFDFC2", INK = "#101A33";
  const AVATARS = {
    analyst: () => FACE(`<path d="M9 48c1-9 7-13 15-13s14 4 15 13z" fill="#fff"/><circle cx="24" cy="23" r="12" fill="${SKIN}"/><path d="M12 22c-1-9 6-13 13-13 6 0 11 4 11 12-5 0-9-2-12-6-2 4-7 7-12 7z" fill="#5B3A1E"/><circle cx="19" cy="24" r="4.4" fill="#fff" stroke="${INK}" stroke-width="2"/><circle cx="29" cy="24" r="4.4" fill="#fff" stroke="${INK}" stroke-width="2"/><path d="M23.4 24h1.2" stroke="${INK}" stroke-width="2"/><circle cx="19" cy="24" r="1.5" fill="${INK}"/><circle cx="29" cy="24" r="1.5" fill="${INK}"/><path d="M21 31c2 1.3 4 1.3 6 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`, "#2a78d6"),
    banker: () => FACE(`<path d="M8 48c1-9 7-13 16-13s15 4 16 13z" fill="${INK}"/><path d="M19 35l5 7 5-7z" fill="#fff"/><path d="M24 37l-2 3 2 8 2-8z" fill="#E5233B"/><circle cx="24" cy="22" r="12" fill="${SKIN}"/><path d="M12 20c0-8 6-11 12-11s12 3 12 11c-3-4-7-6-12-6s-9 2-12 6z" fill="#2B2B33"/><circle cx="19.5" cy="23" r="1.7" fill="${INK}"/><circle cx="28.5" cy="23" r="1.7" fill="${INK}"/><path d="M19 29h10" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`, "#eb6834"),
    zocker: () => FACE(`<path d="M8 48c1-9 7-13 16-13s15 4 16 13z" fill="#F5D547"/><circle cx="24" cy="24" r="12" fill="${SKIN}"/><path d="M11 21c0-9 6-13 13-13s13 4 13 13z" fill="#E5233B"/><path d="M34 19h9c1 1 1 3-1 3H34z" fill="#B3142B"/><rect x="13" y="21" width="9.5" height="6" rx="2" fill="${INK}"/><rect x="25.5" y="21" width="9.5" height="6" rx="2" fill="${INK}"/><path d="M22 23h4" stroke="${INK}" stroke-width="2"/><path d="M18 31c3 3 9 3 12 0z" fill="#fff" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`, "#1baf7a"),
    kombi: () => FACE(`<path d="M8 48c1-9 7-13 16-13s15 4 16 13z" fill="#7A1FA2"/><circle cx="24" cy="26" r="12" fill="${SKIN}"/><path d="M12 28c1 9 6 13 12 13s11-4 12-13c-3 3-7 3-12 3s-9 0-12-3z" fill="#8B5A2B"/><path d="M12 18l-1-12 7 6 6-9 6 9 7-6-1 12z" fill="#FFD60A" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="19.5" cy="25" r="1.7" fill="${INK}"/><circle cx="28.5" cy="25" r="1.7" fill="${INK}"/>`, "#eda100"),
    stammtisch: () => FACE(`<path d="M8 48c1-9 7-13 16-13s15 4 16 13z" fill="#2E7D4F"/><circle cx="24" cy="24" r="12" fill="${SKIN}"/><path d="M10 19c1-7 7-10 14-10s13 3 14 10z" fill="#6B7C5A"/><path d="M8 19h32v2.5H8z" fill="#55644A"/><circle cx="19.5" cy="24" r="1.7" fill="${INK}"/><circle cx="28.5" cy="24" r="1.7" fill="${INK}"/><circle cx="24" cy="27" r="2.6" fill="#E98A7A"/><path d="M13 32c3-3 8-3 11-1 3-2 8-2 11 1-3 2-8 2-11 0-3 2-8 2-11 0z" fill="#3D2A1A"/>`, "#e87ba4"),
    affe: () => FACE(`<circle cx="10" cy="24" r="6" fill="#8D5A34"/><circle cx="38" cy="24" r="6" fill="#8D5A34"/><circle cx="10" cy="24" r="3" fill="#E7B98F"/><circle cx="38" cy="24" r="3" fill="#E7B98F"/><circle cx="24" cy="24" r="15" fill="#8D5A34"/><path d="M14 22c0-6 5-8 10-5 5-3 10-1 10 5 0 7-5 13-10 13s-10-6-10-13z" fill="#E7B98F"/><circle cx="19.5" cy="22" r="2" fill="${INK}"/><circle cx="28.5" cy="22" r="2" fill="${INK}"/><path d="M22 27h4" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/><path d="M18 31c3 2.5 9 2.5 12 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`, "#008300"),
  };
  const MOTTO = {
    analyst: "Die Zahlen lügen nicht. Nur die Stürmer.", banker: "Kleine Quote, ruhiger Schlaf.", zocker: "Wer nicht alles setzt, hat schon verloren.",
    kombi: "Vier Spiele, eine Krone.", stammtisch: "Der Favorit gewinnt immer. Prost.", affe: "Ook.",
  };
  const avatar = (id, cls = "") => `<span class="av ${cls}">${AVATARS[id]?.() || ""}</span>`;

  // ------------------------------------------------------------------ Pokale und Serien
  const ICONS = {
    cup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v7a5 5 0 0 1-10 0z"/><path d="M7 5H3v2a4 4 0 0 0 4 4M17 5h4v2a4 4 0 0 1-4 4M12 15v4M8 21h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4 3-7 1 2 2 2 3 3 1-3 0-5 0-8z"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.8"/></svg>',
    skull: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a9 9 0 0 0-5 16.5V21h10v-2.5A9 9 0 0 0 12 2z"/><circle cx="9" cy="12" r="2" fill="#fff"/><circle cx="15" cy="12" r="2" fill="#fff"/></svg>',
    chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l6-6 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function computeAwards() {
    const done = state.bets.filter((b) => ["won", "lost"].includes(b.status)).sort((a, b) => (a.result?.t || a.commence).localeCompare(b.result?.t || b.commence));
    const stats = {};
    for (const id of state.order) stats[id] = { cur: 0, best: 0, cups: 0 };
    for (const b of done) {
      const st = stats[b.player];
      if (b.status === "won") { st.cur++; st.best = Math.max(st.best, st.cur); } else st.cur = 0;
    }
    const dayRows = [];
    state.days.forEach((d, i) => {
      const rows = state.order.map((id) => ({ id, ...state.players[id].days[i] }));
      if (d.placed && rows.every((r) => r.n_bets && r.settled === r.n_bets)) {
        const top = rows.reduce((a, r) => (r.profit > a.profit ? r : a), rows[0]);
        stats[top.id].cups++;
        dayRows.push(...rows);
      }
    });
    const list = [];
    const add = (icon, title, id, value, text) => list.push({ icon, title, id, value, text });
    const matchOf = (b) => (b.market === "combo" ? b.league : `${b.home} – ${b.away}`);
    if (done.length) {
      const hit = done.filter((b) => b.status === "won").sort((a, b) => b.profit - a.profit)[0];
      if (hit) add("bolt", "Größter Treffer", hit.player, eur(hit.profit, true), `${hit.label} zu ${odds(hit.odds)}, ${matchOf(hit)}`);
      const lost = done.filter((b) => b.status === "lost").sort((a, b) => a.profit - b.profit || b.odds - a.odds)[0];
      if (lost) add("skull", "Teuerster Fehler", lost.player, eur(lost.profit, true), `${lost.label} zu ${odds(lost.odds)}, ${matchOf(lost)}`);
      const wide = done.filter((b) => b.status === "won").sort((a, b) => b.odds - a.odds)[0];
      if (wide) add("target", "Höchste Quote getroffen", wide.player, odds(wide.odds), `${wide.label}, ${matchOf(wide)}`);
      const streaker = state.order.reduce((a, id) => (stats[id].best > stats[a].best ? id : a), state.order[0]);
      if (stats[streaker].best > 1) add("flame", "Längste Serie", streaker, `${stats[streaker].best} Siege`, "Treffer in Folge");
      const shots = state.order.map((id) => ({ id, t: state.players[id].totals })).filter((x) => x.t.won + x.t.lost >= 5).sort((a, b) => b.t.hit_rate - a.t.hit_rate)[0];
      if (shots) add("target", "Scharfschütze", shots.id, pct(shots.t.hit_rate), `${shots.t.won} von ${shots.t.won + shots.t.lost} Wetten getroffen`);
      const clv = state.order.map((id) => ({ id, t: state.players[id].totals })).filter((x) => x.t.n_clv >= 5).sort((a, b) => b.t.avg_clv - a.t.avg_clv)[0];
      if (clv) add("chart", "Bester Marktschläger", clv.id, pct(clv.t.avg_clv, true), "im Schnitt besser als der faire Schlusskurs");
    }
    if (dayRows.length) {
      const up = [...dayRows].sort((a, b) => b.profit - a.profit)[0], down = [...dayRows].sort((a, b) => a.profit - b.profit)[0];
      add("cup", "Bester Tag", up.id, eur(up.profit, true), fmt(up.date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" }));
      add("skull", "Schlimmster Tag", down.id, eur(down.profit, true), fmt(down.date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" }));
    }
    return { stats, list };
  }
  function renderAwards() {
    const { stats, list } = computeAwards();
    const shelf = state.order.map((id) => ({ id, s: stats[id] })).sort((a, b) => b.s.cups - a.s.cups || b.s.best - a.s.best);
    $("awards").innerHTML = `<div class="cups">${shelf.map(({ id, s }) => `<div class="cup-row"><span class="cup-who">${avatar(id)}<b>${esc(shortName(id))}</b></span><span class="cup-items">${s.cups ? Array(s.cups).fill(`<i class="ic ic-cup">${ICONS.cup}</i>`).join("") : '<span class="cup-none">noch kein Tagessieg</span>'}</span>${s.cur >= 2 ? `<span class="flame">${ICONS.flame}${s.cur}</span>` : ""}</div>`).join("")}</div>
      <div class="badges">${list.length ? list.map((a) => `<article class="badge"><i class="ic ic-${a.icon}">${ICONS[a.icon]}</i><div class="b-body"><span class="b-title">${esc(a.title)}</span><span class="b-value">${esc(a.value)}</span><span class="b-who">${avatar(a.id, "av-s")}${esc(shortName(a.id))}</span><small>${esc(a.text)}</small></div></article>`).join("") : '<p class="fd-empty">Die ersten Abzeichen gibt es nach den ersten Ergebnissen.</p>'}</div>`;
    return stats;
  }

  // ------------------------------------------------------------------ Die Kabine
  function renderTalk() {
    const day = state.talk?.[0];
    if (!day) { $("talk").innerHTML = `<p class="fd-empty">Heute herrscht noch Stille in der Kabine.</p>`; return; }
    let side = {};
    let next = 0;
    $("talk").innerHTML = `<p class="talk-date">${fmt(day.date + "T12:00:00", { weekday: "long", day: "numeric", month: "long" })}</p>` + day.messages.map((m) => {
      if (side[m.from] == null) { side[m.from] = next % 2; next++; }
      const pl = state.players[m.from];
      if (!pl) return "";
      return `<div class="msg ${side[m.from] ? "right" : ""}">${avatar(m.from)}<div class="bubble"><span class="m-who">${esc(pl.name)}${state.players[m.to] ? `<small> an ${esc(shortName(m.to))}</small>` : ""}</span>${esc(m.text)}</div></div>`;
    }).join("");
  }

  // ------------------------------------------------------------------ Zukunftsmaschine (Monte-Carlo)
  let simKey = "", simResult = null;
  function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function simulate() {
    const N = 10000, ids = state.order;
    const settledCount = state.bets.filter((b) => b.status !== "open").length;
    const key = `${settledCount}|${state.bets.length}`;
    if (key === simKey && simResult) return simResult;
    const rand = mulberry(settledCount * 7919 + state.bets.length + 13);
    const idx = new Map(), probs = [];
    const slot = (src, id) => { const k = `${src.event_id}|${src.market}|${src.key}|${src.point}`; if (!idx.has(k)) { idx.set(k, probs.length); probs.push(src.p ?? 0.5); } return idx.get(k); };
    const open = state.bets.filter((b) => b.status === "open").map((b) => ({ player: b.player, stake: b.stake, odds: b.odds, slots: b.market === "combo" ? b.legs.filter((l) => l.status === "open").map((l) => slot(l)) : [slot(b)], combo: b.market === "combo" }));
    const lastPlaced = state.days.reduce((m, d, i) => (d.placed ? i : m), -1);
    const remaining = state.days.length - 1 - lastPlaced;
    const templates = {};
    for (const id of ids) {
      const byDay = {};
      state.bets.filter((b) => b.player === id).forEach((b) => { (byDay[b.day] ||= []).push({ stake: b.stake, odds: b.odds, p: b.p ?? 1 / b.odds }); });
      templates[id] = Object.values(byDay);
    }
    const base = Object.fromEntries(ids.map((id) => [id, state.players[id].totals.profit]));
    const finals = Object.fromEntries(ids.map((id) => [id, new Float32Array(N)]));
    const wins = Object.fromEntries(ids.map((id) => [id, 0]));
    const draw = new Float32Array(probs.length);
    const score = {};
    for (let n = 0; n < N; n++) {
      for (let i = 0; i < probs.length; i++) draw[i] = rand() < probs[i] ? 1 : 0;
      for (const id of ids) score[id] = base[id];
      for (const b of open) score[b.player] += b.slots.every((i) => draw[i]) ? b.stake * (b.odds - 1) : -b.stake;
      for (const id of ids) {
        const tpl = templates[id];
        if (tpl.length) for (let d = 0; d < remaining; d++) for (const b of tpl[Math.floor(rand() * tpl.length)]) score[id] += rand() < b.p ? b.stake * (b.odds - 1) : -b.stake;
        finals[id][n] = score[id];
      }
      let best = ids[0];
      for (const id of ids) if (score[id] > score[best]) best = id;
      wins[best]++;
    }
    const rows = ids.map((id) => {
      const a = finals[id].slice().sort();
      const plus = a.reduce((c, v) => c + (v > 0 ? 1 : 0), 0);
      return { id, win: wins[id] / N, plus: plus / N, p10: a[Math.floor(N * 0.1)], p50: a[Math.floor(N * 0.5)], p90: a[Math.floor(N * 0.9)] };
    }).sort((x, y) => y.win - x.win);
    simKey = key;
    simResult = { rows, remaining, open: open.length, N };
    return simResult;
  }
  function renderSim() {
    const { rows, remaining, open, N } = simulate();
    let lo = Math.min(0, ...rows.map((r) => r.p10)), hi = Math.max(0, ...rows.map((r) => r.p90));
    const pad = (hi - lo) * 0.04; lo -= pad; hi += pad;
    const X = (v) => ((v - lo) / (hi - lo)) * 100;
    $("sim").innerHTML = `<div class="sim-head"><span>Spieler</span><span>Wochensieg</span><span>Ende der Woche: wahrscheinlicher Bereich</span><span class="num">Chance auf Plus</span></div>` + rows.map((r) => {
      const c = state.players[r.id].color;
      return `<div class="sim-row"><span class="sim-who">${avatar(r.id)}<b>${esc(shortName(r.id))}</b></span>
        <span class="sim-win"><b>${pct(r.win)}</b><i style="width:${(r.win * 100).toFixed(1)}%;background:${c}"></i></span>
        <span class="sim-track" title="80 % aller Simulationen enden zwischen ${eur(r.p10, true)} und ${eur(r.p90, true)}"><span class="sim-zero" style="left:${X(0).toFixed(1)}%"></span><span class="sim-range" style="left:${X(r.p10).toFixed(1)}%;width:${(X(r.p90) - X(r.p10)).toFixed(1)}%;background:${c}"></span><span class="sim-med" style="left:${X(r.p50).toFixed(1)}%"></span><span class="sim-l" style="left:${X(r.p10).toFixed(1)}%">${r.p10 < 0 ? "−" : r.p10 > 0 ? "+" : ""}${Math.abs(Math.round(r.p10))} €</span><span class="sim-r" style="left:${X(r.p90).toFixed(1)}%">${r.p90 > 0 ? "+" : ""}${Math.round(r.p90)} €</span></span>
        <span class="sim-plus num">${pct(r.plus)}</span></div>`;
    }).join("");
    $("simNote").textContent = `${N.toLocaleString("de-DE")} simulierte Wochen, ${plural(open, "offene Wette", "offene Wetten")} und ${plural(remaining, "weiterer Tag", "weitere Tage")}. Der Balken zeigt, wo 80 % der Simulationen enden, der Strich den Mittelwert. Grundlage sind unsere eigenen Wahrscheinlichkeiten, das echte Ergebnis kann deutlich abweichen.`;
  }

  // ------------------------------------------------------------------ Casino: Sound
  let audio = null, soundOn = false;
  try { soundOn = localStorage.getItem("pv_sound") === "1"; } catch (_) { /* egal */ }
  function tone(freq, start, dur, type = "square", vol = 0.05) {
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + start;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function sfx(name) {
    if (!soundOn || !audio || audio.state !== "running") return;
    const seq = (notes, step, type, vol) => notes.forEach((n, i) => tone(n, i * step, step * 1.6, type, vol));
    if (name === "tick") tone(1250, 0, 0.03, "square", 0.025);
    else if (name === "chip") { tone(2300, 0, 0.04, "triangle", 0.09); tone(1700, 0.05, 0.05, "triangle", 0.07); }
    else if (name === "win") seq([523, 659, 784, 1047], 0.09, "square", 0.05);
    else if (name === "big") seq([523, 659, 784, 1047, 784, 1047, 1319, 1568], 0.09, "square", 0.06);
    else if (name === "beat") seq([392, 349, 311, 233], 0.2, "sawtooth", 0.05);
    else if (name === "goal") { seq([440, 554, 659, 880], 0.08, "sawtooth", 0.05); tone(220, 0, 0.7, "sawtooth", 0.05); }
  }
  function paintSound() {
    const b = $("soundBtn");
    b.setAttribute("aria-pressed", soundOn);
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/>${soundOn ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : '<path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'}</svg>`;
  }
  function unlockAudio() {
    if (!audio) { const A = window.AudioContext || window.webkitAudioContext; if (A) audio = new A(); }
    if (audio?.state === "suspended") audio.resume();
  }
  function initSound() {
    paintSound();
    $("soundBtn").addEventListener("click", () => {
      soundOn = !soundOn;
      try { localStorage.setItem("pv_sound", soundOn ? "1" : "0"); } catch (_) { /* egal */ }
      unlockAudio(); paintSound();
      setTimeout(() => sfx("chip"), 60);
    });
    document.addEventListener("pointerdown", () => { if (soundOn) unlockAudio(); }, { once: true });
  }

  // ------------------------------------------------------------------ Casino: Jackpot, Chips, Zittern, Momente
  const pokerChip = (v) => `<span class="pchip" title="${eur0(v)} Einsatz"><b>${Math.round(v)}</b></span>`;
  function renderJackpot() {
    const open = state.bets.filter((b) => b.status === "open");
    const pot = open.reduce((a, b) => a + b.potential_payout, 0);
    const node = $("jpNum");
    node.setAttribute("aria-label", `${eur(pot)} im Topf`);
    odometer(node, nf2.format(pot));
    const top = [...open].sort((a, b) => b.potential_payout - a.potential_payout)[0];
    $("jpSide").innerHTML = top ? `<b>${plural(open.length, "Wette", "Wetten")}</b> laufen<br>Dickster Schein: <b>${eur(top.potential_payout)}</b> (${esc(shortName(top.player))}, Quote ${odds(top.odds)})` : "Der Topf füllt sich täglich um 11:00 Uhr";
  }
  function isSweating(p, e, m) {
    if (gameProgress(e, m) < 70) return false;
    const c = liveChance(p, e, m);
    return c != null && c > 0.07 && c < 0.93;
  }
  function sweatCall(e, m) {
    const hot = e.picks.filter((p) => isSweating(p, e, m));
    if (!hot.length) return null;
    const unit = e.group === "Fußball" || e.group === "Eishockey" ? "1 Tor" : "ein Korb";
    const close = Math.abs(m.home_score - m.away_score) <= 1;
    return close && (e.group === "Fußball" || e.group === "Eishockey") ? `Zittern! ${unit} entscheidet alles` : `Zittern! Noch ist alles drin`;
  }
  function nearMiss(b) {
    if (b.status !== "lost") return false;
    if (b.market === "combo") { const st = b.legs.map((l) => l.status); return st.filter((x) => x === "lost").length === 1 && st.includes("won"); }
    const r = b.result; if (!r || r.home == null) return false;
    if (b.market === "totals") return Math.abs(r.home + r.away - b.point) <= (b.group === "Basketball" || b.group === "American Football" ? 3 : 0.5);
    if (b.market === "h2h") {
      const d = r.home - r.away;
      if (b.key === "draw") return Math.abs(d) === 1;
      const ours = b.key === "home" ? d : -d;
      return b.group === "Basketball" || b.group === "American Football" ? ours >= -3 : ours >= -1;
    }
    return false;
  }
  function showMoment(kind, b) {
    const box = $("moment");
    const win = kind === "win", jack = win && b.odds >= 5;
    const line = b.market === "combo" ? b.league : `${b.home} – ${b.away}`;
    box.className = `moment ${win ? "m-win" : "m-beat"}`;
    box.hidden = false;
    box.innerHTML = `<div class="m-card" role="status">${avatar(b.player, "av-l")}<p class="m-big">${jack ? "JACKPOT!" : win ? "BIG WIN!" : "BAD BEAT!"}</p><p class="m-sum" id="mSum">${eur(0, true)}</p><p class="m-info"><b>${esc(pName(b.player))}</b>: ${esc(b.label)} zu ${odds(b.odds)}<br>${esc(line)}${b.result?.home != null ? `, ${b.result.home}:${b.result.away}` : ""}</p>${win ? "" : `<p class="m-info">So knapp. Das tut weh.</p>`}</div>`;
    sfx(win ? "big" : "beat");
    if (win) { coins(6); setTimeout(() => coins(6), 500); }
    const start = performance.now(), total = b.profit, sumEl = $("mSum");
    const step = (t) => { const k = Math.min(1, (t - start) / 1200); sumEl.textContent = eur(total * (1 - Math.pow(1 - k, 3)), true); if (k < 1 && !box.hidden) requestAnimationFrame(step); };
    if (REDUCED || document.hidden) sumEl.textContent = eur(total, true); else requestAnimationFrame(step);
    const close = () => { box.hidden = true; };
    box.onclick = close;
    setTimeout(close, 4200);
  }

  // ------------------------------------------------------------------ Casino: Der Tisch
  const CHIP_START = 1000;
  let wallet = null, tableMkt = "day", tableDenom = 50;
  function loadWallet() {
    if (wallet) return wallet;
    try { wallet = JSON.parse(localStorage.getItem("pv_wallet") || "null"); } catch (_) { wallet = null; }
    if (!wallet || typeof wallet.chips !== "number") wallet = { chips: CHIP_START, bets: [] };
    return wallet;
  }
  const saveWallet = () => { try { localStorage.setItem("pv_wallet", JSON.stringify(wallet)); } catch (_) { /* egal */ } };
  const chipsFmt = (n) => Math.round(n).toLocaleString("de-DE");
  let dayKey = "", dayResult = null;
  function simulateDay() {
    const idx = state.days.reduce((m, d, i) => (state.bets.some((b) => b.day === d.date && b.status === "open") ? i : m), -1);
    if (idx < 0) return null;
    const date = state.days[idx].date, settled = state.bets.filter((b) => b.status !== "open").length, key = `${date}|${settled}`;
    if (key === dayKey && dayResult) return dayResult;
    const N = 4000, rand = mulberry(settled * 104729 + idx + 7), ids = state.order;
    const slotIdx = new Map(), probs = [];
    const slot = (src) => { const k = `${src.event_id}|${src.market}|${src.key}|${src.point}`; if (!slotIdx.has(k)) { slotIdx.set(k, probs.length); probs.push(src.p ?? 0.5); } return slotIdx.get(k); };
    const open = state.bets.filter((b) => b.status === "open" && b.day === date).map((b) => ({ player: b.player, stake: b.stake, odds: b.odds, slots: b.market === "combo" ? b.legs.filter((l) => l.status === "open").map(slot) : [slot(b)] }));
    const base = Object.fromEntries(ids.map((id) => [id, state.players[id].days[idx].profit]));
    const wins = Object.fromEntries(ids.map((id) => [id, 0])), draw = new Float32Array(probs.length), score = {};
    for (let n = 0; n < N; n++) {
      for (let i = 0; i < probs.length; i++) draw[i] = rand() < probs[i] ? 1 : 0;
      for (const id of ids) score[id] = base[id];
      for (const b of open) score[b.player] += b.slots.every((i) => draw[i]) ? b.stake * (b.odds - 1) : -b.stake;
      let best = ids[0];
      for (const id of ids) if (score[id] > score[best]) best = id;
      wins[best]++;
    }
    dayKey = key;
    dayResult = { date, idx, rows: Object.fromEntries(ids.map((id) => [id, wins[id] / N])) };
    return dayResult;
  }
  const payoutOdds = (p) => Math.min(60, Math.max(1.05, Math.round((0.92 / Math.max(p, 0.012)) * 100) / 100));
  function settleWallet() {
    let won = 0, count = 0;
    for (const w of loadWallet().bets) {
      if (w.status) continue;
      let winner = null;
      if (w.mkt === "day") {
        const i = state.days.findIndex((d) => d.date === w.day);
        const rows = state.order.map((id) => ({ id, ...state.players[id].days[i] }));
        if (i >= 0 && rows.every((r) => r.n_bets && r.settled === r.n_bets)) winner = rows.reduce((a, r) => (r.profit > a.profit ? r : a), rows[0]).id;
      } else if (state.days.every((d) => d.placed) && state.bets.every((b) => b.status !== "open")) {
        winner = ranked()[0].id;
      }
      if (!winner) continue;
      w.status = winner === w.player ? "won" : "lost";
      w.winner = winner;
      if (w.status === "won") { const pay = Math.round(w.chips * w.odds); wallet.chips += pay; won += pay; }
      count++;
    }
    if (count) {
      saveWallet();
      if (won) { toast(`Der Tisch zahlt: <b>+${chipsFmt(won)} Chips</b>`); coins(4); sfx("win"); } else toast("Deine Chips sind weg. Das Haus gewinnt.", true);
    }
  }
  function renderTable() {
    settleWallet();
    const w = loadWallet();
    const day = simulateDay();
    const weekOpen = state.bets.some((b) => b.status === "open") || state.days.some((d) => !d.placed);
    const probs = tableMkt === "day" ? day?.rows : weekOpen ? Object.fromEntries(simulate().rows.map((r) => [r.id, r.win])) : null;
    const chipsOn = (id) => w.bets.filter((b) => !b.status && b.player === id && b.mkt === tableMkt && (tableMkt === "week" || b.day === day?.date)).reduce((a, b) => a + b.chips, 0);
    const felt = $("felt");
    const denoms = [10, 50, 100, "all"];
    const stackN = Math.min(9, Math.ceil(w.chips / 200));
    const openBets = w.bets.filter((b) => !b.status);
    const recent = w.bets.filter((b) => b.status).slice(-4).reverse();
    felt.innerHTML = `<div class="felt-top">
        <div class="stack" aria-hidden="true">${Array(stackN).fill(0).map((_, i) => `<i style="--n:${i}"></i>`).join("")}</div>
        <div class="stack-num"><b>${chipsFmt(w.chips)}</b><span>Chips</span></div>
        <div class="mkts" role="tablist">${[["day", "Tagessieger"], ["week", "Wochensieger"]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tableMkt}" data-m="${k}">${l}</button>`).join("")}</div>
      </div>
      <div class="denoms" role="group" aria-label="Einsatz">${denoms.map((d) => `<button type="button" class="dn dn-${d}" aria-pressed="${d === tableDenom}" data-d="${d}">${d === "all" ? "All-in" : d}</button>`).join("")}</div>
      <div class="spots">${probs ? state.order.map((id) => {
        const on = chipsOn(id), odd = payoutOdds(probs[id] || 0);
        return `<button type="button" class="spot" data-p="${id}" data-o="${odd}">${avatar(id, "av-m")}<span class="sp-name">${esc(shortName(id))}</span><span class="sp-odds">${nf2.format(odd)}</span>${on ? `<span class="sp-on">${chipsFmt(on)}</span>` : ""}</button>`;
      }).join("") : `<p class="felt-empty">${tableMkt === "day" ? "Gerade läuft kein Spieltag. Um 11:00 Uhr öffnet der Tisch wieder." : "Die Woche ist entschieden."}</p>`}</div>
      <div class="felt-foot">${openBets.length ? `<span>Im Spiel: ${openBets.map((b) => `${chipsFmt(b.chips)} auf ${esc(shortName(b.player))} (${b.mkt === "day" ? "Tag" : "Woche"})`).join(", ")}</span>` : "<span>Noch nichts gesetzt. Chips antippen, dann Spieler wählen.</span>"}${recent.length ? `<span class="felt-hist">${recent.map((b) => `<em class="${b.status}">${b.status === "won" ? "+" + chipsFmt(b.chips * b.odds) : "−" + chipsFmt(b.chips)}</em>`).join(" ")}</span>` : ""}${w.chips < 10 && !openBets.length ? `<button type="button" class="refill" id="refill">Pleite? Das Haus gibt 200 Chips aus</button>` : ""}</div>`;
    felt.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => { tableMkt = b.dataset.m; renderTable(); }));
    felt.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { tableDenom = b.dataset.d === "all" ? "all" : +b.dataset.d; sfx("chip"); renderTable(); }));
    felt.querySelectorAll(".spot").forEach((b) => b.addEventListener("click", () => {
      const amt = tableDenom === "all" ? w.chips : Math.min(tableDenom, w.chips);
      if (amt < 1) { toast("Keine Chips mehr. Der Automat oder das Haus hilft dir aus.", true); return; }
      w.chips -= amt;
      w.bets.push({ id: `${Date.now()}`, mkt: tableMkt, day: tableMkt === "day" ? day.date : null, player: b.dataset.p, chips: amt, odds: +b.dataset.o });
      if (w.bets.length > 40) w.bets = w.bets.slice(-40);
      saveWallet(); sfx("chip"); renderTable(); renderSlot();
    }));
    $("refill")?.addEventListener("click", () => { w.chips += 200; saveWallet(); sfx("chip"); renderTable(); renderSlot(); });
  }

  // ------------------------------------------------------------------ Casino: Einarmiger Bandit
  const SLOT_COST = 10, SLOT_H = 62, COIN_SYM = '<span class="sym-coin">€</span>';
  const symbols = () => [...state.order.map((id) => avatar(id, "av-sym")), COIN_SYM];
  let spinning = false, slotBuilt = false;
  function renderSlot() {
    const box = $("slot");
    if (!slotBuilt) {
      const syms = symbols();
      const strip = () => Array(24).fill(0).map((_, i) => `<div class="sym" data-s="${i % syms.length}">${syms[i % syms.length]}</div>`).join("");
      box.innerHTML = `<div class="sl-head"><span class="sl-title">Einarmiger Bandit</span><span class="sl-cost">${SLOT_COST} Chips pro Dreh</span></div>
        <div class="sl-window">${[0, 1, 2].map(() => `<div class="reel-col"><div class="reel-str">${strip()}</div></div>`).join("")}<span class="sl-line" aria-hidden="true"></span></div>
        <p class="sl-msg" id="slMsg" aria-live="polite">Hebel ziehen und hoffen.</p>
        <button type="button" class="lever" id="lever">Hebel ziehen</button>
        <p class="sl-pay">3 gleiche: ×20, 3 Affen: ×40, 2 gleiche: ×1,4</p>`;
      slotBuilt = true;
      $("lever").addEventListener("click", spin);
    }
    $("lever").disabled = spinning || loadWallet().chips < SLOT_COST;
  }
  function spin() {
    const w = loadWallet();
    if (spinning || w.chips < SLOT_COST) return;
    spinning = true;
    w.chips -= SLOT_COST;
    saveWallet();
    renderTable();
    $("lever").disabled = true;
    $("slMsg").textContent = "Dreht …";
    const n = symbols().length;
    const picks = [0, 1, 2].map(() => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; });
    const cols = document.querySelectorAll(".reel-str");
    cols.forEach((c, i) => {
      const land = picks[i] + n * 2;
      c.style.transition = "none";
      c.style.transform = "translateY(0)";
      void c.offsetHeight;
      c.style.transition = REDUCED ? "none" : `transform ${900 + i * 450}ms cubic-bezier(.12, .8, .2, 1)`;
      c.style.transform = `translateY(-${(land - 1) * SLOT_H}px)`;
    });
    if (!REDUCED) for (let t = 0; t < 14; t++) setTimeout(() => sfx("tick"), t * 130);
    setTimeout(() => {
      const [a, b, c] = picks, ape = state.order.indexOf("affe");
      let mult = 0, msg;
      if (a === b && b === c) { mult = a === ape ? 40 : 20; msg = a === ape ? "DREI AFFEN! Ook ook ook!" : "JACKPOT!"; }
      else if (a === b || b === c || a === c) { mult = 1.4; msg = "Zwei gleiche. So knapp!"; }
      else msg = "Nichts. Nochmal?";
      const pay = Math.round(SLOT_COST * mult);
      if (pay) w.chips += pay;
      saveWallet();
      spinning = false;
      $("slMsg").textContent = pay ? `${msg} +${chipsFmt(pay)} Chips` : msg;
      $("slMsg").className = `sl-msg ${mult >= 20 ? "is-jack" : ""}`;
      if (mult >= 20) { coins(8); sfx("big"); } else if (mult) sfx("win");
      renderTable(); renderSlot();
    }, REDUCED ? 50 : 1950);
  }

  // ------------------------------------------------------------------ Anzeigetafel (Spiel im Fokus)
  let stageKey = null, stagePinned = 0;
  function teamBg(m, side, name) {
    const raw = m?.[`${side}_color`];
    if (!raw || raw.length !== 6) return hue(name);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 0.12) return hue(name); // Schwarz/Weiß/Grau: eigene Farbe aus dem Namen
    const sat = d / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return `hsl(${h.toFixed(0)} ${Math.round(Math.max(sat, 0.55) * 100)}% ${Math.round(Math.min(40, Math.max(28, l * 100)))}%)`;
  }
  const entryStake = (e) => e.picks.reduce((a, p) => a + (p.combo ? 0 : p.stake), 0);
  function stagePool() {
    const pid = state.players[view] ? view : null;
    const all = matchEntries(pid);
    const st = (e) => (e.espn && matches[e.espn.id] ? matches[e.espn.id].state : null);
    const running = all.filter((e) => st(e) === "in").sort((a, b) => entryStake(b) - entryStake(a));
    const next = all.filter((e) => new Date(e.commence) > new Date() && st(e) !== "in" && st(e) !== "post");
    return { running, next };
  }
  function ticket(p, e, m, idx, selected) {
    const c = state.players[p.player].color;
    let cls = "", res = p.combo ? `Teil der ${esc(p.combo)}` : `${eur0(p.stake)} Einsatz`, story = "", chanceHtml = "";
    if (m && m.state !== "pre") {
      const s = betStory(p, e, m.home_score, m.away_score);
      cls = s.g === "won" ? "up" : s.g === "lost" ? "down" : "";
      res = `${s.g === "won" ? "▲" : s.g === "lost" ? "▼" : "■"} ${p.combo ? (s.g === "won" ? "passt" : s.g === "lost" ? "wackelt" : "offen") : s.g === "push" ? "0,00 €" : eur(s.profit, true)}`;
      story = `<small>${esc(s.text)}</small>`;
      const ch = liveChance(p, e, m);
      if (ch != null) chanceHtml = `<span class="tk-chance"><span>Siegchance <b>${Math.round(ch * 100)} %</b></span>${p.combo ? "" : `<span>Cash-out <b>${eur(cashoutOf(p, ch))}</b></span>`}</span><span class="tk-bar"><i style="width:${(ch * 100).toFixed(0)}%"></i></span>`;
    }
    const hot = m?.state === "in" && isSweating(p, e, m);
    return `<button type="button" class="tk ${cls} ${selected ? "is-sel" : ""} ${hot ? "is-hot" : ""}" data-pi="${idx}" style="--c:${c}">${p.combo ? "" : pokerChip(p.stake)}<span class="tk-who">${avatar(p.player, "av-xs")}${esc(shortName(p.player))}</span><span class="tk-tip">${esc(p.label)}</span><span class="tk-foot"><b>${odds(p.odds)}</b><span class="tk-res">${res}</span></span>${story}${chanceHtml}</button>`;
  }
  const stagePick = {};
  function tensionChart(e, m, p) {
    const pts = chanceCurve(p, e, m).filter((x) => x.c != null);
    if (pts.length < 2) return `<div class="jb-line" aria-hidden="true"><span class="jb-fill" style="width:${gameProgress(e, m).toFixed(1)}%"></span></div>`;
    const line = pts.map((q) => `${q.x.toFixed(2)},${(100 - q.c * 100).toFixed(2)}`).join(" ");
    const last = pts[pts.length - 1];
    let marks = "";
    if (e.group === "Fußball") for (const d of m.details || []) {
      const kind = d.scoringPlay ? "goal" : d.redCard ? "red" : d.yellowCard ? "yellow" : null;
      if (kind) marks += `<i class="tl-${kind}" style="left:${Math.min(100, ((parseInt(d.clock?.displayValue, 10) || 0) / 90) * 100).toFixed(1)}%"></i>`;
    }
    return `<div class="jb-tension"><div class="jb-t-head"><span>Spannungskurve: ${esc(shortName(p.player))}, ${esc(p.label)}</span><b>${Math.round(last.c * 100)} %</b></div>
      <div class="jb-chart" data-pts='${JSON.stringify(pts.map((q) => [q.x, q.c, q.min ?? null]))}' role="img" aria-label="Verlauf der Siegchance, aktuell ${Math.round(last.c * 100)} Prozent">
        <span class="jb-50"></span><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="0,100 ${line} ${last.x.toFixed(2)},100" class="jb-area"/><polyline points="${line}" class="jb-curve"/></svg>
        <span class="jb-dot" style="left:${last.x.toFixed(2)}%;top:${(100 - last.c * 100).toFixed(2)}%"></span>${marks}<span class="jb-tip" hidden></span></div></div>`;
  }
  function renderStage(goals = new Set()) {
    if (!state) return;
    const { running, next } = stagePool();
    const goalE = running.find((e) => goals.has(e.key));
    if (goalE) { stageKey = goalE.key; stagePinned = Date.now() + 15000; }
    const pool = running.length ? running : next.slice(0, 1);
    if (!pool.find((e) => e.key === stageKey)) stageKey = pool[0]?.key || null;
    const box = $("stageMain");
    const e = pool.find((x) => x.key === stageKey);
    if (!e) {
      box.innerHTML = `<article class="jumbo jumbo-empty"><p class="jb-idle">Gerade laufen keine Wetten</p><p class="jb-idle-sub">Täglich um 11:00 Uhr gehen 6 Spieler mit je 100 € an den Start.</p></article>`;
      return;
    }
    const m = e.espn ? matches[e.espn.id] : null;
    const live = m?.state === "in";
    const hit = goals.has(e.key);
    const center = live
      ? `<div class="jb-nums ${hit ? "pop" : ""}"><span>${m.home_score}</span><em>:</em><span>${m.away_score}</span></div>`
      : `<div class="jb-count"><small>Anstoß</small><b data-countdown="${e.commence}">${countdownText(e.commence)}</b><small>${wd(e.commence)} ${hhmm(e.commence)} Uhr</small></div>`;
    if (stagePick[e.key] == null || stagePick[e.key] >= e.picks.length) { let bi = 0; e.picks.forEach((p, i) => { if (!p.combo && p.stake > (e.picks[bi].combo ? 0 : e.picks[bi].stake)) bi = i; }); stagePick[e.key] = bi; }
    const selIdx = stagePick[e.key] < 4 ? stagePick[e.key] : 0;
    const extra = e.picks.length > 4 ? `<div class="tk tk-more">+${e.picks.length - 4} weitere</div>` : "";
    const banner = hit ? `<div class="jb-goal" aria-hidden="true"><span>${e.group === "Fußball" || e.group === "Eishockey" ? "TOR!" : "SCORE!"}</span></div>` : "";
    const sw = running.length > 1 ? `<div class="jb-switch" role="tablist" aria-label="Live-Spiele">${running.map((x) => {
      const mm = matches[x.espn.id];
      return `<button type="button" role="tab" aria-selected="${x.key === stageKey}" data-k="${esc(x.key)}">${esc(mm.home_abbr || abbr(x.home))} <b>${mm.home_score}:${mm.away_score}</b> ${esc(mm.away_abbr || abbr(x.away))}</button>`;
    }).join("")}</div>` : "";
    const bgH = teamBg(m, "home", e.home);
    let bgA = teamBg(m, "away", e.away);
    const hueOf = (c) => parseInt(c.match(/hsl\((\d+)/)?.[1] || "0", 10);
    const diff = Math.abs(hueOf(bgH) - hueOf(bgA));
    if (Math.min(diff, 360 - diff) < 45) bgA = `hsl(${(hueOf(bgH) + 150) % 360} 62% 34%)`; // zu ähnlich: Gegenfarbe
    const sweat = live ? sweatCall(e, m) : null;
    box.innerHTML = `<article class="jumbo ${live ? "is-live" : "is-next"} ${sweat ? "is-sweat" : ""}" style="--h:${bgH};--a:${bgA}">
      <div class="jb-bg" aria-hidden="true"><i></i><i></i></div>
      <div class="jb-top"><span class="jb-tag">${live ? "LIVE" : "ALS NÄCHSTES"}</span><span class="jb-league">${esc(e.league)}</span>${live ? `<span class="jb-clock">${esc(clockDe(m))}</span>` : ""}</div>
      ${sweat ? `<div class="jb-sweat"><span>${esc(sweat)}</span></div>` : ""}
      <div class="jb-mid">
        <div class="jb-team"><span class="jb-crest">${esc(m?.home_abbr || abbr(e.home))}</span><span class="jb-name">${esc(e.home)}</span></div>
        ${center}
        <div class="jb-team"><span class="jb-crest">${esc(m?.away_abbr || abbr(e.away))}</span><span class="jb-name">${esc(e.away)}</span></div>
      </div>
      ${live ? tensionChart(e, m, e.picks[selIdx]) : ""}
      <div class="jb-tickets">${e.picks.slice(0, 4).map((p, i) => ticket(p, e, m, i, i === selIdx && live)).join("")}${extra}</div>
      ${banner}
    </article>${sw}`;
    box.querySelectorAll(".tk[data-pi]").forEach((t) => t.addEventListener("click", () => { stagePick[e.key] = +t.dataset.pi; stagePinned = Date.now() + 60000; renderStage(); }));
    const chart = box.querySelector(".jb-chart");
    if (chart) {
      const pts = JSON.parse(chart.dataset.pts), tip = chart.querySelector(".jb-tip");
      chart.addEventListener("pointermove", (ev) => {
        const r = chart.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * 100;
        const q = pts.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a), pts[0]);
        tip.hidden = false; tip.style.left = `${Math.min(88, Math.max(8, q[0]))}%`;
        tip.textContent = `${q[2] != null ? `Minute ${Math.round(q[2])}: ` : ""}${Math.round(q[1] * 100)} %`;
      });
      chart.addEventListener("pointerleave", () => { tip.hidden = true; });
    }
    box.querySelectorAll(".jb-switch button").forEach((b) => b.addEventListener("click", () => { stageKey = b.dataset.k; stagePinned = Date.now() + 60000; renderStage(); }));
  }
  function stageRotate() {
    if (!state || Date.now() < stagePinned || document.hidden) return;
    const { running } = stagePool();
    if (running.length < 2) return;
    const i = running.findIndex((e) => e.key === stageKey);
    stageKey = running[(i + 1) % running.length].key;
    renderStage();
  }

  // ------------------------------------------------------------------ Rangliste neben der Tafel
  function sparkline(p) {
    const last = p.days.reduce((m, d, i) => (d.settled ? i : m), -1);
    const v = [0, ...p.days.slice(0, last + 1).map((d) => d.cum_profit)];
    if (v.length < 2) return `<svg class="spark" viewBox="0 0 64 22" aria-hidden="true"><line x1="0" x2="64" y1="11" y2="11"/></svg>`;
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * 62 + 1).toFixed(1)},${(20 - ((x - lo) / span) * 18).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 64 22" aria-hidden="true"><polyline points="${pts}" style="stroke:${p.color}"/></svg>`;
  }
  function renderMini() {
    const rows = ranked();
    const any = rows.some((p) => p.totals.staked_settled);
    const { stats } = computeAwards();
    $("miniBoard").innerHTML = rows.map((p, i) => {
      const t = p.totals;
      return `<li><button type="button" class="mn ${i === 0 && any ? "is-top" : ""} ${view === p.id ? "is-me" : ""}" data-v="${p.id}">
        <span class="mn-rank">${any ? i + 1 : "–"}</span>${avatar(p.id)}
        <span class="mn-name">${esc(shortName(p.id))}${stats[p.id].cups ? `<em class="mn-cup">${ICONS.cup}${stats[p.id].cups}</em>` : ""}${stats[p.id].cur >= 2 ? `<em class="flame">${ICONS.flame}${stats[p.id].cur}</em>` : ""}</span>${sparkline(p)}
        <b class="${t.profit > 0.004 ? "pos" : t.profit < -0.004 ? "neg" : ""}">${t.staked_settled ? eur(t.profit, true) : "–"}</b></button></li>`;
    }).join("");
    $("miniBoard").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { setView(view === b.dataset.v ? "vergleich" : b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
  }

  // ------------------------------------------------------------------ Wettschein-Spalte
  function renderSlipRail() {
    const pid = state.players[view] ? view : null;
    const open = state.bets.filter((b) => b.status === "open" && (!pid || b.player === pid));
    const stake = open.reduce((a, b) => a + b.stake, 0), pot = open.reduce((a, b) => a + b.potential_payout, 0);
    let body;
    if (!open.length) body = `<p class="fd-empty">Gerade sind keine Wetten offen.</p>`;
    else if (!pid) {
      body = `<ul class="rs-list">${state.order.map((id) => {
        const bs = open.filter((b) => b.player === id);
        if (!bs.length) return "";
        return `<li><button type="button" class="rs-player" data-v="${id}"><i style="background:${state.players[id].color}"></i><span>${esc(pName(id))}<small>${plural(bs.length, "Wette", "Wetten")} offen</small></span><b>${eur(bs.reduce((a, b) => a + b.potential_payout, 0))}</b></button></li>`;
      }).join("")}</ul>`;
    } else {
      const sorted = [...open].sort((a, b) => a.commence.localeCompare(b.commence));
      body = `<ul class="rs-list">${sorted.slice(0, 10).map((b) => `<li class="rs-bet"><div><b>${esc(b.label)}</b><small>${b.market === "combo" ? esc(b.league) : `${esc(b.home)} – ${esc(b.away)}`}</small></div><span class="rs-odds">${odds(b.odds)}</span><span class="rs-stake">${pokerChip(b.stake)}</span></li>`).join("")}</ul>${sorted.length > 10 ? `<p class="fd-empty">und ${sorted.length - 10} weitere</p>` : ""}`;
    }
    $("slipRail").innerHTML = `${body}<dl class="rs-total"><div><dt>Einsatz offen</dt><dd>${eur(stake)}</dd></div><div><dt>Mögliche Auszahlung</dt><dd class="rs-pot">${eur(pot)}</dd></div></dl>`;
    $("slipRail").querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
    const bar = $("slipbar");
    bar.hidden = !open.length;
    bar.innerHTML = `<span>Wettschein: <b>${plural(open.length, "Wette", "Wetten")}</b> offen</span><span>Möglich <b>${eur(pot)}</b></span>`;
  }

  // ------------------------------------------------------------------ Chart-Hilfen
  const NS = "http://www.w3.org/2000/svg";
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function scale(vals, ticks = 4) {
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const step = niceStep((hi - lo || 10) / ticks);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    if (lo === hi) hi = lo + step;
    return { lo, hi, step };
  }
  const yTick = (v, unit = " €") => `${sgn(v)}${Math.abs(Math.round(v))}${unit}`;
  function svgIn(box, W, H, inner) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = inner;
    box.appendChild(svg);
    const tip = el("div", "tip"); tip.hidden = true; box.appendChild(tip);
    return { svg, tip };
  }
  function bindMarkTips(svg, tip, W, H, getHtml) {
    svg.querySelectorAll(".hit[data-i]").forEach((m) => {
      m.addEventListener("pointerenter", () => {
        svg.querySelectorAll(".is-hover").forEach((x) => x.classList.remove("is-hover"));
        const target = svg.querySelector(`.mark[data-i="${m.dataset.i}"]`);
        if (target) target.classList.add("is-hover");
        tip.hidden = false;
        tip.style.left = `${(+m.dataset.x / W) * 100}%`;
        tip.style.top = `${(+m.dataset.y / H) * 100}%`;
        tip.innerHTML = getHtml(+m.dataset.i);
      });
    });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; svg.querySelectorAll(".is-hover").forEach((x) => x.classList.remove("is-hover")); });
  }
  const anim = (cls) => (firstRender && !REDUCED ? cls : "");
  function gridAxis(lo, hi, step, y, m, W, unit) {
    let s = `<g class="grid">`;
    for (let v = lo; v <= hi + 1e-9; v += step) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `</g><g class="axis">`;
    for (let v = lo; v <= hi + 1e-9; v += step) s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${yTick(v, unit)}</text>`;
    return s + `</g>`;
  }

  // ------------------------------------------------------------------ Kontoverlauf
  function series() {
    const done = myBets().filter((b) => b.status !== "open")
      .sort((a, b) => (a.result?.t || a.commence).localeCompare(b.result?.t || b.commence) || a.commence.localeCompare(b.commence));
    const pts = [{ i: 0, real: 0, exp: 0, bet: null }];
    let r = 0, e = 0;
    done.forEach((b, i) => { r += b.profit || 0; e += (b.ev || 0) * b.stake; pts.push({ i: i + 1, real: r, exp: e, bet: b }); });
    return pts;
  }

  function renderChart() {
    const box = $("chart");
    const pts = series();
    box.innerHTML = "";
    if (pts.length < 2) {
      box.innerHTML = `<div class="chart-empty">Sobald die erste Wette abgerechnet ist, erscheint hier die Kurve: der echte Kontostand gegen den Gewinn, den die Mathematik im Schnitt erwarten würde.</div>`;
      $("chartTable").innerHTML = "";
      return;
    }
    const W = box.clientWidth || 700, H = box.clientHeight || 280;
    const m = { l: 52, r: 78, t: 12, b: 26 };
    const { lo, hi, step } = scale(pts.flatMap((p) => [p.real, p.exp]));
    const n = pts.length - 1;
    const x = (i) => m.l + (i / n) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    let g = gridAxis(lo, hi, step, y, m, W, " €") + `<g class="axis">`;
    let lastDay = null;
    pts.forEach((p) => {
      if (!p.bet || p.bet.day === lastDay) return;
      lastDay = p.bet.day;
      g += `<text x="${x(p.i)}" y="${H - 6}" text-anchor="middle">${wd(p.bet.day + "T12:00:00")}</text>`;
    });
    g += `</g>`;
    const path = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
    const last = pts[n];
    const ly = [y(last.real), y(last.exp)];
    if (Math.abs(ly[0] - ly[1]) < 16) { const mid = (ly[0] + ly[1]) / 2, up = ly[0] <= ly[1]; ly[0] = mid + (up ? -8 : 8); ly[1] = mid + (up ? 8 : -8); }
    const { svg, tip } = svgIn(box, W, H, `${g}
      <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
      <path class="area" d="${path("real")}L${x(n)},${y(0)}L${x(0)},${y(0)}Z"/>
      <path class="exp ${anim("draw")}" d="${path("exp")}"/>
      <path class="real ${anim("draw")}" d="${path("real")}"/>
      <circle cx="${x(n)}" cy="${y(last.exp)}" r="4" fill="var(--ochre)" class="hoverdot"/>
      <circle cx="${x(n)}" cy="${y(last.real)}" r="4.5" fill="var(--pen)" class="hoverdot"/>
      <text class="lbl-strong" x="${x(n) + 10}" y="${ly[0] + 4}">${eur(last.real, true)}</text>
      <text class="lbl" x="${x(n) + 10}" y="${ly[1] + 4}">${eur(last.exp, true)}</text>
      <g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/>
        <circle r="4" fill="var(--ochre)" class="hoverdot hd-exp"/><circle r="4.5" fill="var(--pen)" class="hoverdot hd-real"/></g>`);
    svg.querySelectorAll(".draw").forEach((p) => p.style.setProperty("--len", p.getTotalLength()));
    const hover = svg.querySelector(".hover");
    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n, Math.round(((px - m.l) / (W - m.l - m.r)) * n)));
      const p = pts[i];
      hover.style.display = "";
      hover.querySelector(".cross").setAttribute("x1", x(i)); hover.querySelector(".cross").setAttribute("x2", x(i));
      const hr = hover.querySelector(".hd-real"), he = hover.querySelector(".hd-exp");
      hr.setAttribute("cx", x(i)); hr.setAttribute("cy", y(p.real)); he.setAttribute("cx", x(i)); he.setAttribute("cy", y(p.exp));
      tip.hidden = false;
      tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(Math.min(y(p.real), y(p.exp)) / H) * 100}%`;
      tip.innerHTML = p.bet ? `Nach Wette ${i}: ${esc(p.bet.home)} – ${esc(p.bet.away)}<br><b>Echt ${eur(p.real, true)}</b>, erwartet ${eur(p.exp, true)}` : "Start: 0 €";
    });
    svg.addEventListener("pointerleave", () => { hover.style.display = "none"; tip.hidden = true; });
    $("chartTable").innerHTML = `<table><thead><tr><th>Nr.</th><th>Spiel</th><th>Ergebnis</th><th class="num">Echt</th><th class="num">Erwartet</th></tr></thead><tbody>${pts.slice(1).map((p) =>
      `<tr><td>${p.i}</td><td>${esc(p.bet.home)} – ${esc(p.bet.away)}</td><td>${p.bet.status === "won" ? "Gewonnen" : p.bet.status === "lost" ? "Verloren" : "Zurück"}</td><td class="num">${eur(p.real, true)}</td><td class="num">${eur(p.exp, true)}</td></tr>`).join("")}</tbody></table>`;
  }

  // Balken mit 4px runder Datenkante, gerade an der Nulllinie
  function barPath(cx, bw, y0, y1) {
    const up = y1 < y0, h = Math.max(2, Math.abs(y1 - y0)), r = Math.min(4, h / 2, bw / 2);
    const l = cx - bw / 2, rt = cx + bw / 2;
    if (up) { const t = y0 - h; return `M${l},${y0}V${t + r}Q${l},${t} ${l + r},${t}H${rt - r}Q${rt},${t} ${rt},${t + r}V${y0}Z`; }
    const b = y0 + h; return `M${l},${y0}V${b - r}Q${l},${b} ${l + r},${b}H${rt - r}Q${rt},${b} ${rt},${b - r}V${y0}Z`;
  }

  // ------------------------------------------------------------------ Bilanz pro Tag
  function renderDayChart() {
    const box = $("dayChart");
    box.innerHTML = "";
    const days = P().days;
    if (!days.some((d) => d.settled)) {
      box.innerHTML = `<div class="chart-empty">Hier erscheint für jeden der 7 Tage ein Balken: grün im Plus, orange im Minus.</div>`;
      return;
    }
    const W = box.clientWidth || 340, H = box.clientHeight || 280;
    const m = { l: 44, r: 6, t: 22, b: 26 };
    // 18 % Luft über/unter den Balken für die Wertbeschriftung
    const { lo, hi, step } = scale(days.flatMap((d) => [d.profit * 1.18]));
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / days.length;
    const bw = Math.min(24, band * 0.6);
    let s = gridAxis(lo, hi, step, y, m, W, " €");
    days.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      s += `<text class="lbl" x="${cx}" y="${H - 6}" text-anchor="middle">${wd(d.date + "T12:00:00")}</text>`;
      if (!d.settled) {
        if (d.n_bets) s += `<rect class="bar-open" x="${cx - bw / 2}" y="${y(0) - 3}" width="${bw}" height="6" rx="2"/>`;
        return;
      }
      const v = d.profit;
      s += `<path class="mark ${v >= 0 ? "bar-gain" : "bar-loss"} ${anim("grow")}" style="--origin:${v >= 0 ? "bottom" : "top"};--d:${i * 70}ms" data-i="${i}" d="${barPath(cx, bw, y(0), y(v))}"/>`;
      s += `<text class="lbl-strong" x="${cx}" y="${v >= 0 ? Math.min(y(v), y(0) - 2) - 6 : Math.max(y(v), y(0) + 2) + 14}" text-anchor="middle">${sgn(v)}${Math.abs(Math.round(v))}</text>`;
      s += `<rect class="hit" data-i="${i}" data-x="${cx}" data-y="${Math.min(y(v), y(0))}" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}"/>`;
    });
    s += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const d = days[i];
      return `Tag ${i + 1}, ${fmt(d.date + "T12:00:00", { weekday: "long" })}<br><b>${eur(d.profit, true)}</b> bei ${eur0(d.staked)} Einsatz, ${d.n_bets} Wetten`;
    });
  }

  // ------------------------------------------------------------------ Wettbewerbe
  function renderLeagues() {
    const box = $("leagueChart");
    const settled = myBets().filter((b) => b.status !== "open");
    if (!settled.length) { box.innerHTML = `<div class="empty-small">Erscheint nach den ersten Ergebnissen.</div>`; return; }
    const by = {};
    for (const b of settled) {
      const o = by[b.league] ||= { league: b.league, stake: 0, profit: 0, n: 0, won: 0 };
      o.stake += b.stake; o.profit += b.profit || 0; o.n++; if (b.status === "won") o.won++;
    }
    const rows = Object.values(by).sort((a, b) => b.stake - a.stake);
    const max = Math.max(...rows.map((r) => Math.abs(r.profit)), 1);
    box.innerHTML = rows.map((r, i) => {
      const w = (Math.abs(r.profit) / max) * 50;
      const cls = r.profit >= 0 ? "gain" : "loss";
      const left = r.profit >= 0 ? 50 : 50 - w;
      return `<div class="hb-name">${esc(r.league)}<small>${r.n} Wetten, ${r.won} gewonnen</small></div>
        <div class="hb-track"><span class="hb-mid" style="left:50%"></span><span class="hb-bar ${cls} ${anim("growx")} ${r.profit < 0 ? "from-right" : ""}" style="left:${left}%;width:${Math.max(w, 0.6)}%;--d:${i * 60}ms"></span></div>
        <div class="hb-val">${eur(r.profit, true)}<small>${eur0(Math.round(r.stake * 100) / 100)} gesetzt</small></div>`;
    }).join("");
  }

  // ------------------------------------------------------------------ CLV je Wette
  function renderClv() {
    const box = $("clvChart");
    box.innerHTML = "";
    const bets = myBets().filter((b) => b.clv != null).sort((a, b) => a.commence.localeCompare(b.commence));
    if (!bets.length) { box.innerHTML = `<div class="chart-empty">Kurz vor jedem Anpfiff wird der faire Schlusskurs erfasst. Dann erscheint hier je Wette ein Balken.</div>`; return; }
    const W = box.clientWidth || 500, H = box.clientHeight || 230;
    const m = { l: 44, r: 6, t: 10, b: 10 };
    const vals = bets.map((b) => b.clv * 100);
    const { lo, hi, step } = scale(vals);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / bets.length;
    const bw = Math.max(2, Math.min(18, band - 2));
    let s = gridAxis(lo, hi, step, y, m, W, " %");
    bets.forEach((b, i) => {
      const v = vals[i], cx = m.l + band * i + band / 2;
      s += `<path class="mark ${v >= 0 ? "bar-gain" : "bar-loss"} ${anim("grow")}" style="--origin:${v >= 0 ? "bottom" : "top"};--d:${i * 25}ms" data-i="${i}" d="${barPath(cx, bw, y(0), y(v))}"/>`;
      s += `<rect class="hit" data-i="${i}" data-x="${cx}" data-y="${Math.min(y(v), y(0))}" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}"/>`;
    });
    s += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const b = bets[i];
      return `${esc(b.home)} – ${esc(b.away)}<br>${esc(b.label)} zu ${odds(b.odds)}, fair zum Schluss ${odds(b.closing?.fair_odds)}<br><b>CLV ${pct(b.clv, true)}</b>`;
    });
  }

  // ------------------------------------------------------------------ Treffer nach Quotenbereich
  function renderHits() {
    const box = $("hitChart");
    const settled = myBets().filter((b) => b.status === "won" || b.status === "lost");
    if (!settled.length) { box.innerHTML = `<div class="empty-small">Erscheint nach den ersten Ergebnissen.</div>`; return; }
    const buckets = [["bis 1,60", 0, 1.6], ["1,60–2,20", 1.6, 2.2], ["2,20–3,00", 2.2, 3.0], ["über 3,00", 3.0, 99]];
    const rows = buckets.map(([name, a, z]) => {
      const bs = settled.filter((b) => b.odds >= a && b.odds < z);
      return { name, n: bs.length, exp: bs.reduce((s, b) => s + (b.p || 1 / b.odds), 0), real: bs.filter((b) => b.status === "won").length };
    }).filter((r) => r.n);
    const max = Math.max(...rows.map((r) => Math.max(r.exp, r.real)), 1);
    box.innerHTML = `<div class="hb-legend"><span style="--c:var(--ochre)">erwartete Treffer</span><span style="--c:var(--pen)">echte Treffer</span></div>` + rows.map((r, i) => `
      <div class="hb-name">Quote ${r.name}<small>${r.n} Wetten</small></div>
      <div class="hb-track"><span class="hb-bar exp ${anim("growx")}" style="left:0;width:${(r.exp / max) * 100}%;--d:${i * 60}ms"></span><span class="hb-bar real ${anim("growx")}" style="left:0;width:${Math.max((r.real / max) * 100, 0.6)}%;--d:${i * 60 + 80}ms"></span></div>
      <div class="hb-val">${r.real} von ${r.n}<small>erwartet ${nf1.format(r.exp)}</small></div>`).join("");
  }

  // ------------------------------------------------------------------ Woche
  function renderDays() {
    const today = berlinDate();
    if (!selectedDay) {
      const withBets = P().days.filter((d) => d.n_bets);
      selectedDay = state.days.find((d) => d.date === today)?.date || withBets.at(-1)?.date || state.days[0].date;
    }
    const box = $("days");
    box.innerHTML = "";
    P().days.forEach((d, i) => {
      const b = el("button", "day" + (d.date === today ? " d-today" : ""));
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", d.date === selectedDay);
      const dt = d.date + "T12:00:00";
      let val, meta;
      if (!d.n_bets) { val = `<span class="d-profit" style="opacity:.45">–</span>`; meta = d.date < today ? "keine Wetten" : "Wetten ab 11:00"; }
      else {
        const cls = d.profit > 0 ? "d-pos" : d.profit < 0 ? "d-neg" : "";
        val = `<span class="d-profit ${cls}">${d.settled ? eur(d.profit, true) : "offen"}</span>`;
        meta = d.settled === d.n_bets ? `${d.n_bets} Wetten, fertig` : `${d.settled} von ${d.n_bets} fertig`;
      }
      const dbets = myBets().filter((x) => x.day === d.date);
      const spark = dbets.length ? `<span class="d-spark">${dbets.map((x) => `<i class="${x.status === "won" ? "w" : x.status === "lost" ? "l" : isLive(x) ? "o" : ""}"></i>`).join("")}</span>` : "";
      b.innerHTML = `<span class="d-name">Tag ${i + 1}</span><span class="d-date">${wd(dt)}, ${fmt(dt, { day: "numeric", month: "short" })}</span>${val}<span class="d-meta">${meta}</span>${spark}`;
      b.addEventListener("click", () => { selectedDay = d.date; renderDays(); renderSlips(); });
      box.appendChild(b);
    });
  }

  // ------------------------------------------------------------------ Wettscheine
  function renderSlips() {
    if (!state) return;
    const d = state.days.find((x) => x.date === selectedDay);
    if (!d) return;
    const idx = state.days.indexOf(d);
    const bets = myBets().filter((b) => b.day === selectedDay).sort((a, b) => a.commence.localeCompare(b.commence));
    $("dayTitle").textContent = `Wetten an Tag ${idx + 1}`;
    const dt = d.date + "T12:00:00";
    let meta = `${P().name}, ${fmt(dt, { weekday: "long", day: "numeric", month: "long" })}. Spiele von 12 Uhr bis 12 Uhr am Folgetag.`;
    if (d.n_outcomes) meta += ` Geprüft: ${d.n_outcomes} Wettmöglichkeiten, davon ${d.n_value} mit Vorteil.`;
    $("dayMeta").textContent = meta;
    const box = $("slips");
    box.innerHTML = "";
    if (d.research?.summary) box.appendChild(el("p", "research-note", `<strong>Recherche vor dem Spieltag:</strong> ${esc(d.research.summary)}`));
    if (d.summary?.text) box.appendChild(el("div", "research-note", `<strong>Tagesauswertung:</strong> ${esc(d.summary.text)}${d.summary.lessons ? `<p class="lesson">${esc(d.summary.lessons)}</p>` : ""}`));
    if (!bets.length) {
      const future = d.date >= berlinDate();
      box.appendChild(el("div", "empty", future
        ? `<strong>Für diesen Tag ist noch nichts gesetzt.</strong>Um 8:30 Uhr holt das System die Quoten, danach recherchiert Claude die News. Um 11:00 Uhr werden die 100 € verteilt.`
        : `<strong>An diesem Tag wurden keine Wetten platziert.</strong>`));
    }
    bets.forEach((b) => box.appendChild(slip(b)));
    // Gewinn-Stempel: Münzen springen aus dem Stempel
    box.querySelectorAll(".st-won.slam").forEach((s, i) => setTimeout(() => {
      const r = s.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) coins(1, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }, 450 + i * 250));
    fresh.clear();
    const near = P().id === "analyst" ? d.near_misses || [] : [];
    $("nearWrap").hidden = !near.length;
    $("near").innerHTML = near.length ? `<table><thead><tr><th>Spiel</th><th>Wette</th><th class="num">Quote</th><th class="num">Unsere Wkt.</th><th class="num">Vorteil</th></tr></thead><tbody>${near.map((n) =>
      `<tr><td>${esc(n.home)} – ${esc(n.away)}<br><small>${esc(n.league)}, ${wd(n.commence)} ${hhmm(n.commence)}</small></td><td>${esc(n.label)}</td><td class="num">${odds(n.odds)}<br><small>${esc(n.book_name)}</small></td><td class="num">${pct(n.p)}</td><td class="num">${pct(n.ev, true)}</td></tr>`).join("")}</tbody></table>` : "";
  }

  function slip(b) {
    const cls = b.status === "won" ? " s-won" : b.status === "lost" ? " s-lost" : isLive(b) ? " s-live" : "";
    const s = el("article", "slip" + cls);
    const row = el("button", "slip-row");
    row.setAttribute("aria-expanded", open.has(b.id));
    row.innerHTML = `
      <div class="s-time">${wd(b.commence)}<b>${hhmm(b.commence)}</b></div>
      <div class="s-main"><div class="s-league">${esc(b.league)}</div>${b.market === "combo"
        ? `<ul class="legs">${b.legs.map((l) => `<li><span class="lg-st ${l.status === "won" ? "lg-won" : l.status === "lost" ? "lg-lost" : ""}">${l.status === "won" ? "✓" : l.status === "lost" ? "✗" : "·"}</span>${esc(l.home)} – ${esc(l.away)}: ${esc(l.label)} (${odds(l.odds)})</li>`).join("")}</ul>`
        : `<div class="s-match">${esc(b.home)} – ${esc(b.away)}</div>`}
        <div class="s-pick">${esc(b.label)}${b.kind === "filler" ? `<span class="s-filler">Füllwette</span>` : ""}</div></div>
      <div class="s-odds"><b>${odds(b.odds)}</b><span>${esc(b.book_name)}</span>${b.ev > 0 ? `<span class="s-edge" title="Erwartungswert">${pct(b.ev, true)}</span>` : ""}</div>
      <div class="s-stake"><b>${eur0(b.stake)}</b><span>möglich ${eur(b.potential_payout)}</span></div>
      <div class="s-state">${nearMiss(b) ? '<span class="near-tag">Knapp vorbei!</span>' : ""}${stamp(b)}<span class="s-chev" aria-hidden="true"></span></div>`;
    const det = el("div", "slip-detail");
    det.hidden = !open.has(b.id);
    det.innerHTML = detail(b);
    row.addEventListener("click", () => {
      open.has(b.id) ? open.delete(b.id) : open.add(b.id);
      row.setAttribute("aria-expanded", open.has(b.id));
      det.hidden = !open.has(b.id);
    });
    s.append(row, det);
    return s;
  }

  function detail(b) {
    const pr = (name, v, cls = "") => v == null ? "" : `<span>${name}</span><span class="pbar ${cls}"><i style="width:${(v * 100).toFixed(1)}%"></i></span><span>${pct(v)}</span>`;
    let res = "";
    if (b.status !== "open") {
      const sc = b.result && b.result.home != null ? `Endstand ${b.result.home}:${b.result.away}. ` : "";
      const st = { won: "Gewonnen", lost: "Verloren", push: "Push, Einsatz zurück", void: "Abgesagt, Einsatz zurück" }[b.status];
      res = `<div class="result-box ${b.status}"><strong>${st}.</strong> ${sc}Auszahlung ${eur(b.payout)}, Ergebnis ${eur(b.profit, true)}.</div>`;
    }
    const clv = b.clv != null ? `<p>Schlusskurs: fair ${odds(b.closing?.fair_odds)}, unsere Quote ${odds(b.odds)}. Closing Line Value <strong>${pct(b.clv, true)}</strong>.</p>` : b.closing?.missed ? `<p>Der Schlusskurs konnte nicht erfasst werden.</p>` : b.status === "open" ? `<p>Der Schlusskurs wird kurz vor Anpfiff erfasst.</p>` : "";
    const an = b.analysis ? `<p>${esc(b.analysis.text)}</p>${b.analysis.lesson ? `<p class="lesson">${esc(b.analysis.lesson)}</p>` : ""}` : b.auto_analysis ? `<p>${esc(b.auto_analysis)}</p>` : "";
    let liveLine = "";
    if (b.status === "open" && b.market !== "combo" && b.espn && matches[b.espn.id]?.state === "in") {
      const m = matches[b.espn.id], ch = liveChance(b, b, m);
      if (ch != null) liveLine = `<div class="result-box live-co">Siegchance jetzt <strong>${Math.round(ch * 100)} %</strong>, Cash-out <strong>${eur(cashoutOf(b, ch))}</strong></div>`;
    }
    const left = `
      <div><h4>Warum diese Wette</h4><p class="reason">${esc(b.reason)}</p>
      <div class="probs">${pr("Markt (fair)", b.fair_market)}${pr("Tor-Modell", b.model_p)}${pr("Unser Wert", b.p, "p-final")}</div>
      ${res}${liveLine}${cashoutReview(b)}<div class="analysis">${clv}${an}</div></div>`;
    const entries = Object.entries(b.books || {}).sort((a, c) => c[1] - a[1]);
    const max = entries.length ? entries[0][1] : b.odds;
    const min = entries.length ? entries.at(-1)[1] : b.odds;
    const lo = Math.max(1, min - (max - min) * 0.6 - 0.05);
    const w = (v) => Math.max(2, ((v - lo) / (max - lo)) * 100);
    const fairO = b.fair_market ? 1 / b.fair_market : null;
    const fairPos = fairO ? Math.min(100, Math.max(0, w(fairO))) : null;
    const rows = entries.map(([bk, v], i) => {
      const hl = bk === b.book_name || bk === "Tipico" || bk === "Pinnacle";
      return `<span class="bk ${hl ? "hl" : ""}">${esc(bk)}</span><span class="bbar ${bk === b.book_name ? "best" : ""} ${fairPos != null ? "fair" : ""}" style="--fair:${fairPos}%;--i:${i}"><i style="width:${w(v)}%"></i></span><span class="bv">${odds(v)}</span>`;
    }).join("");
    const right = `<div><h4>Quotenvergleich für „${esc(b.label)}“</h4><div class="books">${rows}</div>
      <p class="books-note"><span class="fair-key"></span>Faire Quote ${odds(fairO)}. Alles rechts davon ist eine Wette mit Vorteil.${b.tipico_odds ? ` Tipico bot ${odds(b.tipico_odds)}.` : ""}</p></div>`;
    return left + right;
  }

  // ------------------------------------------------------------------ Live-Bereich (Startseite)
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const unitsOf = (g) => (g === "Fußball" || g === "Eishockey" ? ["Tor", "Tore"] : ["Punkt", "Punkte"]);
  const clockDe = (m) => {
    if (/HALFTIME/.test(m.name || "") || /^(HT|Halftime)$/i.test(m.detail || "")) return "Halbzeit";
    return (m.detail || "").replace(/^FT$/, "Abpfiff").replace(/^Final.*/, "Abpfiff").replace(/^End of /, "Ende ").replace(/ Quarter$/, ". Viertel");
  };
  function gameProgress(e, m) {
    if (m.state !== "in") return m.state === "post" ? 100 : 0;
    if (/HALFTIME/.test(m.name || "")) return 50;
    if (e.group === "Fußball") return Math.min(100, ((parseInt(m.clock, 10) || 0) / 90) * 100);
    const periods = e.group === "Eishockey" ? 3 : 4;
    const len = e.group === "Eishockey" ? 20 : e.group === "American Football" ? 15 : e.league === "EuroLeague" ? 10 : 12;
    const [mm, ss] = String(m.clock || "0:00").split(":").map(Number);
    const left = (mm || 0) + (ss || 0) / 60;
    return Math.min(100, Math.max(0, (((m.period || 1) - 1 + (1 - left / len)) / periods) * 100));
  }
  function betStory(p, e, hs, as) {
    const g = grade(p, hs, as);
    const [one, many] = unitsOf(e.group);
    let text = "";
    if (p.market === "h2h") {
      if (p.key === "draw") {
        const d = Math.abs(hs - as);
        text = d ? `${plural(d, one, many)} bis zum Ausgleich` : "Steht unentschieden";
      } else {
        const d = p.key === "home" ? hs - as : as - hs;
        text = d > 0 ? `Führt mit ${plural(d, one === "Tor" ? "Tor" : "Punkt", one === "Tor" ? "Toren" : "Punkten")}` : d < 0 ? `Liegt ${plural(-d, one, many)} zurück` : "Noch kein Vorsprung";
      }
    } else if (p.market === "totals") {
      const t = hs + as, pt = p.point;
      if (p.key === "over") {
        const need = Math.floor(pt) + 1 - t;
        text = t > pt ? "Linie ist schon geknackt" : `Noch ${plural(need, one, many)} nötig`;
      } else if (t > pt) text = "Linie ist überschritten";
      else {
        const left = Math.ceil(pt) - 1 - t;
        text = left > 0 ? `Noch ${plural(left, one, many)} Luft` : `Kein weiteres ${one} erlaubt`;
      }
    } else if (p.market === "spreads") {
      const m = (hs - as + p.point) * (p.key === "home" ? 1 : -1);
      text = m > 0 ? `Handicap ${plural(Math.ceil(m), one, many)} im Plus` : m < 0 ? `Handicap ${plural(Math.ceil(-m), one, many)} im Minus` : "Handicap genau getroffen";
    }
    const profit = p.combo ? null : g === "won" ? p.stake * (p.odds - 1) : g === "lost" ? -p.stake : 0;
    return { g, text, profit };
  }
  const shortName = (id) => pName(id).replace(/^Der /, "");
  function oddsChip(p, e, m) {
    const c = state.players[p.player].color;
    const head = `<span class="oc-who" style="--c:${c}">${esc(shortName(p.player))}</span><span class="oc-odds">${odds(p.odds)}</span><span class="oc-tip">${esc(p.label)}</span>`;
    if (!m || m.state === "pre") return `<div class="oc">${head}<span class="oc-state">${p.combo ? `Teil der ${esc(p.combo)}` : `${eur0(p.stake)} Einsatz`}</span></div>`;
    const s = betStory(p, e, m.home_score, m.away_score);
    const cls = s.g === "won" ? "up" : s.g === "lost" ? "down" : "";
    const res = p.combo ? (s.g === "won" ? "passt" : s.g === "lost" ? "wackelt" : "offen") : s.g === "push" ? "0,00 €" : eur(s.profit, true);
    const ch = liveChance(p, e, m);
    const bar = ch != null ? `<span class="oc-bar"><i style="width:${(ch * 100).toFixed(0)}%"></i></span>` : "";
    return `<div class="oc ${cls}">${head}<span class="oc-state"><span>${esc(s.text)}${ch != null ? `, ${Math.round(ch * 100)} %` : ""}</span><b>${s.g === "won" ? "▲" : s.g === "lost" ? "▼" : "■"} ${res}</b></span>${bar}</div>`;
  }
  function eventRow(e, goals) {
    const m = e.espn ? matches[e.espn.id] : null;
    const isLive = m?.state === "in", post = m?.state === "post";
    const started = new Date(e.commence).getTime() <= Date.now();
    const goal = goals.has(e.key);
    let state_;
    if (isLive) state_ = `<span class="badge-live">Live</span><span class="ev-clock">${esc(clockDe(m))}</span>`;
    else if (post) state_ = `<span class="ev-final">Abpfiff</span><span class="ev-sub">wird abgerechnet</span>`;
    else if (started) state_ = `<span class="ev-final">Läuft</span><span class="ev-sub">kein Live-Stand</span>`;
    else state_ = `<span class="ev-time">${hhmm(e.commence)}</span><span class="ev-sub" data-countdown="${e.commence}">${countdownText(e.commence)}</span>`;
    const score = (v) => (isLive || post ? `<b class="ev-score ${goal ? "score-pop" : ""}">${v}</b>` : "");
    return `<article class="ev ${isLive ? "is-live" : ""} ${goal ? "goal-flash" : ""}" id="m-${esc(e.key)}">
      <div class="ev-state">${state_}</div>
      <div class="ev-teams">
        <div class="ev-team">${teamBadge(e.home, m, "home")}<span>${esc(e.home)}</span>${score(m?.home_score)}</div>
        <div class="ev-team">${teamBadge(e.away, m, "away")}<span>${esc(e.away)}</span>${score(m?.away_score)}</div>
        ${isLive ? `<div class="ev-progress" aria-hidden="true"><i style="width:${gameProgress(e, m).toFixed(0)}%"></i></div>` : ""}
      </div>
      <div class="ev-bets">${e.picks.map((p) => oddsChip(p, e, m)).join("")}</div>
    </article>`;
  }
  function renderHub(goals = new Set()) {
    if (!state) return;
    const pid = state.players[view] ? view : null;
    const all = matchEntries(pid);
    const st = (e) => (e.espn && matches[e.espn.id] ? matches[e.espn.id].state : null);
    const rank = (e) => (st(e) === "in" ? 0 : st(e) === "post" ? 2 : new Date(e.commence) <= new Date() ? 1 : 3);
    const visible = all.filter((e) => inPlayWindow(e) || new Date(e.commence) > new Date());
    const groups = ["Fußball", "Basketball", "Eishockey", "American Football"].filter((g) => visible.some((e) => e.group === g));
    if (sportFilter !== "Alle" && !groups.includes(sportFilter)) sportFilter = "Alle";
    const liveCount = (g) => visible.filter((e) => st(e) === "in" && (g === "Alle" || e.group === g)).length;
    $("sportChips").innerHTML = ["Alle", ...groups].map((g) => {
      const n = visible.filter((e) => g === "Alle" || e.group === g).length, l = liveCount(g);
      return `<button type="button" class="chip" role="tab" aria-selected="${g === sportFilter}" data-g="${g}">${g === "American Football" ? "Football" : g}<span>${n}</span>${l ? `<em>${l} live</em>` : ""}</button>`;
    }).join("");
    $("sportChips").querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { sportFilter = b.dataset.g; renderHub(); }));
    const sorted = visible.filter((e) => sportFilter === "Alle" || e.group === sportFilter).sort((a, b) => rank(a) - rank(b) || a.commence.localeCompare(b.commence));
    const liveN = sorted.filter((e) => rank(e) < 3).length;
    const limit = pid || showAllEvents ? sorted.length : liveN + 6;
    const list = sorted.slice(0, limit);
    const byLeague = new Map();
    for (const e of list) { const k = `${rank(e) === 0 ? 0 : 1}|${e.league}`; if (!byLeague.has(k)) byLeague.set(k, []); byLeague.get(k).push(e); }
    $("hubTrack").innerHTML = list.length ? [...byLeague.entries()].map(([k, evs]) => `<section class="ev-group"><h3 class="ev-league"><span>${esc(evs[0].league)}</span><span>${k[0] === "0" ? "Live" : plural(evs.length, "Spiel", "Spiele")}</span></h3>${evs.map((e) => eventRow(e, goals)).join("")}</section>`).join("")
      : `<p class="hub-empty">Gerade laufen keine Wetten. Die nächsten werden täglich um 11:00 Uhr gesetzt.</p>`;
    if (!pid && sorted.length > liveN + 6) {
      const more = el("button", "ev-more", showAllEvents ? "Weniger Spiele zeigen" : `Alle ${sorted.length} Spiele zeigen`);
      more.type = "button";
      more.addEventListener("click", () => { showAllEvents = !showAllEvents; renderHub(); });
      $("hubTrack").appendChild(more);
    }
    const running = visible.filter((e) => st(e) === "in");
    $("hubDot").hidden = !running.length;
    $("hubTitleText").textContent = running.length ? plural(running.length, "Spiel", "Spiele") : "Nächste Spiele";
    let sum = 0, stake = 0;
    for (const e of running) {
      const m = matches[e.espn.id];
      for (const p of e.picks) if (!p.combo) { sum += betStory(p, e, m.home_score, m.away_score).profit; stake += p.stake; }
    }
    $("hubSum").innerHTML = running.length
      ? `Stand jetzt <b class="${sum > 0 ? "lb-pos" : sum < 0 ? "lb-neg" : ""}">${eur(sum, true)}</b> bei ${eur0(stake)} Einsatz`
      : "";
    renderSlipRail();
  }

  // ------------------------------------------------------------------ Können/Glück, Methode, System
  function renderSkill() {
    const t = P().totals;
    const expSettled = myBets().filter((b) => b.status !== "open").reduce((a, b) => a + (b.ev || 0) * b.stake, 0);
    const items = [
      ["Ø Closing Line Value", t.avg_clv == null ? "–" : pct(t.avg_clv, true), t.n_clv ? `aus ${t.n_clv} Schlusskursen` : "noch keine Schlusskurse"],
      ["Besser als Schlusskurs", t.n_clv ? `${t.clv_positive} von ${t.n_clv}` : "–", "Wetten mit echtem Vorteil"],
      ["Ø Erwartungswert", t.avg_ev == null ? "–" : pct(t.avg_ev, true), "beim Platzieren, nach Einsatz gewichtet"],
      ["Echt minus erwartet", t.staked_settled ? eur(t.profit - expSettled, true) : "–", "positiv: Glück auf unserer Seite"],
    ];
    $("skillStats").innerHTML = items.map(([k, v, s]) => `<div><dt>${k}</dt><dd>${v}<small>${s}</small></dd></div>`).join("");
  }

  function renderMethod() {
    const r = state.rules;
    if (r) {
      $("mw").textContent = `${Math.round(r.model_weight[1] * 100)}–${Math.round(r.model_weight[2] * 100)} %`;
      $("adjcap").textContent = Math.round(r.adj_cap * 100);
      $("minev").textContent = pct(r.min_ev, true);
    }
    const bt = state.backtest;
    if (!bt) return;
    const svs = bt.sharp_vs_soft?.by_threshold?.["0.02"];
    const ll = (bt.model || []).map((m) => {
      const base = m.logloss["0.0"], best = Object.entries(m.logloss).sort((a, c) => a[1] - c[1])[0];
      return { league: m.league, gain: base - best[1] };
    });
    const names = { D1: "Bundesliga", E0: "Premier League", D2: "2. Bundesliga", E1: "Championship", SP1: "La Liga", I1: "Serie A" };
    $("evidence").innerHTML = `<h3>Was der Backtest zeigt</h3>
      ${svs ? `<p>Die Kernstrategie haben wir an der Saison 2024/25 getestet: Pinnacle-Quote entmargen und bei der besten Quote am Markt wetten, wenn der Vorteil über 2 % liegt. Das ergab in 10 Ligen ${svs.bets} Wetten mit <strong>${pct(svs.roi, true)} Rendite</strong>. Im Schnitt lag die Quote ${pct(svs.clv)} über dem fairen Schlusskurs.</p>` : ""}
      <p>Das Tor-Modell allein hat den Markt in der Saison 2025/26 nicht geschlagen. Den Log-Loss der Pinnacle-Schlussquote verbessert es nur in ${ll.filter((x) => x.gain > 0.0001).map((x) => names[x.league] || x.league).join(", ") || "keiner Liga"}. Deshalb bekommt es nur ein kleines Gewicht. Den größten Teil des Vorteils liefert der Quotenvergleich, nicht die eigene Prognose.</p>`;
  }

  function renderSys() {
    const s = state.system || {};
    const parts = [`Stand der Daten: ${fmt(state.generated_at, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} Uhr`];
    if (s.credits_remaining != null) parts.push(`Quoten-API: ${s.credits_remaining} von 500 Abrufen übrig`);
    const la = (s.last_actions || []).at(-1);
    if (la) parts.push(`Letzte Aktion: ${la.a} (${hhmm(la.t)} Uhr)`);
    $("sys").textContent = parts.join(". ") + ".";
  }

  // ------------------------------------------------------------------ Spieler-Tabs & Vergleich
  const ranked = () => state.order.map((id) => state.players[id])
    .sort((a, b) => (b.totals.profit - a.totals.profit) || ((b.totals.expected_profit || 0) - (a.totals.expected_profit || 0)));

  function setView(v) {
    view = v;
    history.replaceState(null, "", v === "vergleich" ? location.pathname : `#${v}`);
    selectedDay = null;
    open.clear();
    firstRender = true;
    render();
    firstRender = false;
    pollLive();
  }

  function renderTabs() {
    const box = $("tabs");
    const tabs = [["vergleich", "Vergleich", null], ...state.order.map((id) => [id, state.players[id].name, state.players[id]])];
    box.innerHTML = tabs.map(([id, name, pl]) => {
      const t = pl?.totals;
      const val = t && t.staked_settled ? `<b class="${t.profit > 0 ? "t-pos" : t.profit < 0 ? "t-neg" : ""}">${eur(t.profit, true)}</b>` : "";
      return `<button class="tab" role="tab" aria-selected="${id === view}" data-v="${id}" style="--c:${pl ? pl.color : "#fff"}">${pl ? "<i></i>" : ""}${esc(name)} ${val}</button>`;
    }).join("");
    box.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
    const act = box.querySelector('.tab[aria-selected="true"]');
    if (act) box.scrollTo({ left: act.offsetLeft - box.clientWidth / 2 + act.clientWidth / 2, behavior: firstRender ? "auto" : "smooth" });
  }

  function renderCompare() {
    const rows = ranked();
    const anyBets = rows.some((p) => p.totals.n_bets);
    const head = `<div class="lb-row lb-head" role="row"><span class="lb-rank">#</span><span>Spieler</span><span class="lb-num">Kontostand</span><span class="lb-num lb-roi">Rendite</span><span class="lb-num lb-hide-s">Treffer</span><span class="lb-num lb-hide-m lb-hide-s">Ø Quote</span><span class="lb-num lb-hide-m lb-hide-s">Größter Rückgang</span></div>`;
    $("leaderboard").innerHTML = head + rows.map((p, i) => {
      const t = p.totals;
      const cls = t.profit > 0.004 ? "lb-pos" : t.profit < -0.004 ? "lb-neg" : "";
      return `<div class="lb-row is-link ${anim("slide-in")}" role="row" data-v="${p.id}" style="--d:${i * 80}ms">
        <span class="lb-rank">${anyBets ? i + 1 : "–"}</span>
        <span class="lb-name" style="--c:${p.color}">${avatar(p.id)}<span><b>${esc(p.name)}</b><small>Risiko ${esc(p.risk)}<span class="lb-tagline">. ${esc(p.tagline)}</span></small></span></span>
        <span class="lb-num big ${cls}">${t.staked_settled ? eur(t.profit, true) : "–"}<small class="lb-sub">${t.roi == null ? "" : `Rendite ${pct(t.roi, true)}`}</small></span>
        <span class="lb-num lb-roi ${cls}">${t.roi == null ? "–" : pct(t.roi, true)}</span>
        <span class="lb-num lb-hide-s">${t.won + t.lost ? `${t.won}<small>von ${t.won + t.lost}</small>` : "–"}</span>
        <span class="lb-num lb-hide-m lb-hide-s">${t.avg_odds ? odds(t.avg_odds) : "–"}</span>
        <span class="lb-num lb-hide-m lb-hide-s">${t.staked_settled ? eur(-t.max_drawdown) : "–"}</span></div>`;
    }).join("");
    $("leaderboard").querySelectorAll(".lb-row.is-link").forEach((r) => r.addEventListener("click", () => setView(r.dataset.v)));
    renderTable();
    renderSlot();
    renderTalk();
    renderAwards();
    renderSim();
    renderCompareChart();
    renderRiskChart();
    $("playerCards").innerHTML = state.order.map((id) => {
      const p = state.players[id], t = p.totals;
      return `<article class="pcard" style="--c:${p.color}"><div class="pc-head">${avatar(id, "av-l")}<div><h3>${esc(p.name)}</h3><p class="pc-motto">„${esc(MOTTO[id])}“</p><small class="pc-risk">Risiko ${esc(p.risk)}</small></div></div>
        <p class="pc-tag">${esc(p.tagline)}</p>
        <details class="pc-desc"><summary>So spielt er</summary><p>${esc(p.desc)}</p></details>
        <div class="pc-stats"><span><b>${t.n_bets}</b>Wetten</span><span><b>${t.staked_settled ? eur(t.profit, true) : "–"}</b>Ergebnis</span><span><b>${t.avg_ev == null ? "–" : pct(t.avg_ev, true)}</b>Ø Erwartung</span></div>
        <button class="linkish" data-v="${id}">Alle Wetten ansehen</button></article>`;
    }).join("");
    $("playerCards").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { setView(b.dataset.v); window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" }); }));
  }

  function renderCompareChart() {
    const box = $("compareChart");
    box.innerHTML = "";
    const today = berlinDate();
    // Punkte: Start (0) + Ende jedes Tages, der schon Ergebnisse hat
    const lastIdx = Math.max(-1, ...state.order.map((id) => state.players[id].days.reduce((m, d, i) => (d.settled ? i : m), -1)));
    if (lastIdx < 0) {
      box.innerHTML = `<div class="chart-empty">Sobald die ersten Wetten abgerechnet sind, läuft hier für jeden Spieler eine Linie: Wer liegt vorn?</div>`;
      $("compareLegend").innerHTML = "";
      return;
    }
    const n = lastIdx + 1;
    const lines = state.order.map((id) => { const p = state.players[id]; return { p, v: [0, ...p.days.slice(0, n).map((d) => d.cum_profit)] }; });
    const W = box.clientWidth || 700, H = box.clientHeight || 280;
    const narrow = W < 520;
    const m = { l: narrow ? 44 : 52, r: narrow ? 12 : 124, t: 12, b: 26 };
    const { lo, hi, step } = scale(lines.flatMap((l) => l.v));
    $("compareLegend").innerHTML = [...lines].sort((a, b) => b.v[n] - a.v[n]).map((l) => `<span style="--c:${l.p.color}"><i></i>${esc(l.p.name.replace("Der ", ""))} <b>${eur(l.v[n], true)}</b></span>`).join("");
    const x = (i) => m.l + (i / n) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    let s = gridAxis(lo, hi, step, y, m, W, " €") + `<g class="axis">`;
    s += `<text x="${x(0)}" y="${H - 6}" text-anchor="middle">Start</text>`;
    for (let i = 1; i <= n; i++) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${wd(state.days[i - 1].date + "T12:00:00")}</text>`;
    s += `</g><line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    // Endlabels ohne Überlappung
    const ends = lines.map((l) => ({ l, y: y(l.v[n]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    lines.forEach((l) => {
      const d = l.v.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      s += `<path class="${anim("draw")}" d="${d}" fill="none" stroke="${l.p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      s += `<circle cx="${x(n)}" cy="${y(l.v[n])}" r="4" fill="${l.p.color}" class="hoverdot"/>`;
    });
    if (!narrow) ends.forEach((e) => { s += `<text class="lbl" x="${x(n) + 10}" y="${e.y + 4}"><tspan class="lbl-strong">${eur(e.l.v[n], true)}</tspan> ${esc(e.l.p.name.replace("Der ", ""))}</text>`; });
    s += `<g class="hover" style="display:none"><line class="cross" y1="${m.t}" y2="${H - m.b}"/></g>`;
    const { svg, tip } = svgIn(box, W, H, s);
    svg.querySelectorAll(".draw").forEach((p) => p.style.setProperty("--len", p.getTotalLength()));
    const hover = svg.querySelector(".hover");
    svg.addEventListener("pointermove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n, Math.round(((px - m.l) / (W - m.l - m.r)) * n)));
      hover.style.display = "";
      hover.querySelector(".cross").setAttribute("x1", x(i)); hover.querySelector(".cross").setAttribute("x2", x(i));
      tip.hidden = false;
      tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(m.t / H) * 100 + 8}%`;
      const label = i ? `Nach Tag ${i}` : "Start";
      tip.innerHTML = `${label}<br>` + [...lines].sort((a, b) => b.v[i] - a.v[i]).map((l) => `<span style="color:${l.p.color}">●</span> ${esc(l.p.name)}: <b>${eur(l.v[i], true)}</b>`).join("<br>");
      tip.style.transform = "translate(-50%, 0)";
    });
    svg.addEventListener("pointerleave", () => { hover.style.display = "none"; tip.hidden = true; });
    void today;
  }

  function renderRiskChart() {
    const box = $("riskChart");
    box.innerHTML = "";
    const pl = state.order.map((id) => state.players[id]).filter((p) => p.totals.staked_settled);
    if (!pl.length) { box.innerHTML = `<div class="chart-empty">Zeigt nach den ersten Ergebnissen, welche Strategie wie viel Rendite für wie viel Risiko bringt.</div>`; return; }
    const W = box.clientWidth || 340, H = box.clientHeight || 280;
    const m = { l: 50, r: 16, t: 14, b: 30 };
    const rois = pl.map((p) => p.totals.roi * 100), dds = pl.map((p) => p.totals.max_drawdown);
    const ys = scale(rois);
    const xmax = niceStep(Math.max(...dds, 10) / 4) * 4;
    const x = (v) => m.l + (v / xmax) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * (H - m.t - m.b);
    let s = gridAxis(ys.lo, ys.hi, ys.step, y, m, W, " %") + `<g class="axis">`;
    for (let v = 0; v <= xmax + 1e-9; v += xmax / 4) s += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle">${Math.round(v)} €</text>`;
    s += `</g><line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    // Beschriftungen ohne Überlappung: nach y sortieren und auseinanderschieben
    const pts = pl.map((p, i) => ({ p, i, cx: x(p.totals.max_drawdown), cy: y(p.totals.roi * 100) }));
    const lab = [...pts].sort((a, b) => a.cy - b.cy);
    lab.forEach((q, k) => { q.ly = q.cy; if (k && q.ly - lab[k - 1].ly < 14 && Math.abs(q.cx - lab[k - 1].cx) < 110) q.ly = lab[k - 1].ly + 14; });
    pts.forEach(({ p, i, cx, cy, ly }) => {
      s += `<circle class="mark" data-i="${i}" cx="${cx}" cy="${cy}" r="7" fill="${p.color}" stroke="var(--sheet)" stroke-width="2"/>`;
      const right = cx > W - 100;
      s += `<text class="lbl" x="${cx + (right ? -12 : 12)}" y="${ly + 4}" text-anchor="${right ? "end" : "start"}">${esc(p.name.replace("Der ", ""))}</text>`;
      s += `<circle class="hit" data-i="${i}" data-x="${cx}" data-y="${cy - 6}" cx="${cx}" cy="${cy}" r="16"/>`;
    });
    const { svg, tip } = svgIn(box, W, H, s);
    bindMarkTips(svg, tip, W, H, (i) => {
      const t = pl[i].totals;
      return `<b>${esc(pl[i].name)}</b><br>Rendite ${pct(t.roi, true)}, Ergebnis ${eur(t.profit, true)}<br>größter Rückgang ${eur(-t.max_drawdown)}`;
    });
  }

  // ------------------------------------------------------------------ Start
  $("tableToggle").addEventListener("click", (e) => {
    const t = $("chartTable"), c = $("chart");
    const show = t.hidden;
    t.hidden = !show; c.hidden = show;
    e.target.setAttribute("aria-expanded", show);
    e.target.textContent = show ? "Als Diagramm" : "Als Tabelle";
  });
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!state) return; if (view === "vergleich") { renderCompareChart(); renderRiskChart(); } else { renderChart(); renderDayChart(); renderClv(); } }, 150);
  });
  setInterval(() => document.querySelectorAll("[data-countdown]").forEach((n) => { n.textContent = countdownText(n.dataset.countdown); }), 1000);
  load();
  setInterval(load, 60_000);
  setInterval(pollLive, 20_000);
  setInterval(stageRotate, 9000);
  initSound();
  const sbV = $("sbView");
  sbV.addEventListener("pointerenter", () => { sbPaused = true; });
  sbV.addEventListener("pointerleave", () => { sbPaused = false; sbLast = 0; });
  if (!REDUCED) requestAnimationFrame(sbFrame); else sbV.style.overflowX = "auto";
})();
