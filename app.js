/* =========================================================
   Ledger — Chess.com game analyzer
   Vanilla JS, no build step. Uses:
     - chess.js (loaded via <script> tag, global `Chess`)
     - Stockfish (loaded lazily into a Web Worker via Blob,
       so it can be fetched from a CDN without cross-origin
       worker restrictions)
   ========================================================= */

(() => {
  "use strict";

  /* ---------------- Config ---------------- */

  const ENGINE_URLS = [
    "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js",
    "https://unpkg.com/stockfish.js@10.0.2/stockfish.js"
  ];

  const PIECE_GLYPH = {
    wp: "\u2659", wn: "\u2658", wb: "\u2657", wr: "\u2656", wq: "\u2655", wk: "\u2654",
    bp: "\u265F", bn: "\u265E", bb: "\u265D", br: "\u265C", bq: "\u265B", bk: "\u265A"
  };

  const FILES = ["a","b","c","d","e","f","g","h"];

  /* ---------------- State ---------------- */

  const state = {
    username: null,
    games: [],           // list from chess.com API
    activeGameIdx: null,
    chess: null,          // chess.js instance loaded with the active game
    fens: [],              // fens[0] = start position, fens[i] = after ply i
    sanMoves: [],           // SAN for ply i (1-indexed matches fens[i])
    verboseMoves: [],        // chess.js verbose move objects
    analysis: [],              // per-fen engine result {cp, mate, bestMoveUci}
    perMove: [],                 // per-ply derived {classification, accuracy, cpLoss, mover}
    currentPly: 0,
    engine: null,
    engineReady: false,
    engineBusy: false,
    boardFlipped: false,
    showArrow: true
  };

  /* ---------------- DOM refs ---------------- */

  const el = (id) => document.getElementById(id);

  const dom = {
    form: el("lookup-form"),
    usernameInput: el("username-input"),
    submitBtn: el("lookup-submit"),
    statusBar: el("status-bar"),
    gamesPanel: el("games-panel"),
    gamesCount: el("games-count"),
    gameList: el("game-list"),
    boardEmpty: el("board-empty"),
    analysis: el("analysis"),
    gameMeta: el("game-meta"),
    accuracySummary: el("accuracy-summary"),
    ribbonWrap: el("ribbon-wrap"),
    ribbon: el("ribbon"),
    evalBar: el("eval-bar"),
    evalBarFill: el("eval-bar-fill"),
    evalBarLabel: el("eval-bar-label"),
    board: el("board"),
    movelist: el("movelist"),
    analyzeBtn: el("analyze-btn"),
    progress: el("progress"),
    progressBar: el("progress-bar"),
    progressLabel: el("progress-label"),
    btnStart: el("btn-start"),
    btnPrev: el("btn-prev"),
    btnNext: el("btn-next"),
    btnEnd: el("btn-end"),
    depthSelect: el("depth-select"),
    toggleArrow: el("toggle-arrow"),
    moveDetail: el("move-detail")
  };

  /* ---------------- Global error visibility ---------------- */
  // If anything throws, show it instead of leaving the UI looking "stuck".
  window.addEventListener("error", (e) => {
    setStatus("Script error: " + (e.message || "unknown") + " (see browser console for details)", "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    setStatus("Error: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)), "error");
  });

  /* ---------------- Status helper ---------------- */

  function setStatus(message, kind) {
    if (!message) {
      dom.statusBar.hidden = true;
      dom.statusBar.textContent = "";
      dom.statusBar.className = "status-bar";
      return;
    }
    dom.statusBar.hidden = false;
    dom.statusBar.textContent = message;
    dom.statusBar.className = "status-bar" + (kind ? " is-" + kind : "");
  }

  /* =========================================================
     Chess.com API
     ========================================================= */

  async function fetchRecentGames(username) {
    const uname = username.trim().toLowerCase();
    const archivesRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(uname)}/games/archives`);
    if (!archivesRes.ok) {
      if (archivesRes.status === 404) throw new Error(`No Chess.com account found for "${username}". Check the spelling — this is the login username, not a display name.`);
      throw new Error(`Chess.com API returned ${archivesRes.status} while fetching archives.`);
    }
    const archivesData = await archivesRes.json();
    const archives = archivesData.archives || [];
    if (archives.length === 0) throw new Error(`"${username}" has never played a game on Chess.com (no archives exist).`);

    // Walk backwards through months until we have at least 10 games
    // (or we run out of months / a reasonable number of attempts).
    let collected = [];
    let totalSeenBeforeFilter = 0;
    let monthsChecked = 0;
    for (let i = archives.length - 1; i >= 0 && monthsChecked < 6 && collected.length < 10; i--) {
      monthsChecked++;
      const res = await fetch(archives[i]);
      if (!res.ok) continue;
      const data = await res.json();
      const allGames = data.games || [];
      totalSeenBeforeFilter += allGames.length;
      const games = allGames.filter(g => g.rules === "chess"); // standard chess only
      collected = collected.concat(games);
    }

    collected.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
    const result = collected.slice(0, 10);

    if (result.length === 0) {
      if (totalSeenBeforeFilter === 0) {
        throw new Error(`"${username}" has no games in the last ${monthsChecked} month(s). They may not have played recently.`);
      } else {
        throw new Error(`"${username}" has ${totalSeenBeforeFilter} recent game(s), but none are standard chess (they look like variants: Chess960, Crazyhouse, etc., which this tool doesn't support yet).`);
      }
    }

    return result;
  }

  /* =========================================================
     Rendering: game list
     ========================================================= */

  function resultFor(game, username) {
    const isWhite = game.white.username.toLowerCase() === username.toLowerCase();
    const mySide = isWhite ? game.white : game.black;
    const oppSide = isWhite ? game.black : game.white;
    const result = mySide.result; // "win", "checkmated", "agreed", "timeout", etc.
    let kind = "draw";
    if (result === "win") kind = "win";
    else if (["checkmated","timeout","resigned","lose","abandoned"].includes(result)) kind = "loss";
    return { isWhite, mySide, oppSide, kind };
  }

  function formatTimeControl(tc) {
    if (!tc) return "";
    if (tc.includes("/")) return "daily";
    const [base, inc] = tc.split("+");
    const mins = Math.round(parseInt(base, 10) / 60);
    return inc ? `${mins}+${inc}` : `${mins} min`;
  }

  function renderGameList() {
    dom.gameList.innerHTML = "";
    dom.gamesCount.textContent = state.games.length ? `${state.games.length} loaded` : "";

    if (state.games.length === 0) {
      dom.gameList.innerHTML = `<div class="empty-state"><p>No standard-chess games found in recent archives.</p></div>`;
      return;
    }

    state.games.forEach((game, idx) => {
      const { oppSide, kind } = resultFor(game, state.username);
      const date = new Date((game.end_time || 0) * 1000);
      const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

      const card = document.createElement("div");
      card.className = "game-card";
      card.dataset.idx = String(idx);
      card.innerHTML = `
        <span class="game-card__result game-card__result--${kind}"></span>
        <div class="game-card__body">
          <div class="game-card__row">
            <span class="game-card__opponent">vs ${escapeHtml(oppSide.username)}</span>
            <span class="game-card__rating">${oppSide.rating ?? ""}</span>
          </div>
          <div class="game-card__meta">
            <span>${dateStr}</span>
            <span>${escapeHtml(game.time_class || "")}</span>
            <span>${formatTimeControl(game.time_control)}</span>
          </div>
        </div>
      `;
      card.addEventListener("click", () => onSelectGame(idx));
      dom.gameList.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /* =========================================================
     Loading a game into chess.js
     ========================================================= */

  function onSelectGame(idx) {
    document.querySelectorAll(".game-card").forEach(c => c.classList.remove("is-active"));
    const card = dom.gameList.querySelector(`.game-card[data-idx="${idx}"]`);
    if (card) card.classList.add("is-active");

    state.activeGameIdx = idx;
    loadGame(state.games[idx]);
  }

  function loadGame(game) {
    if (typeof Chess === "undefined") {
      setStatus("The chess.js library didn't load (probably blocked by network/adblock/CDN issue) — the board can't work without it. Try disabling any ad/script blocker and reload.", "error");
      return;
    }

    try {
      resetAnalysisState();

      const chess = new Chess();
      const cleanedPgn = cleanPgn(game.pgn);
      const ok = chess.load_pgn(cleanedPgn, { sloppy: true });
      if (!ok) {
        setStatus("Couldn't parse this game's PGN.", "error");
        return;
      }

      const verboseMoves = chess.history({ verbose: true });

      // Replay from scratch to build the fen list.
      const replay = new Chess();
      const fens = [replay.fen()];
      const sanMoves = [null];
      verboseMoves.forEach(m => {
        replay.move(m.san);
        fens.push(replay.fen());
        sanMoves.push(m.san);
      });

      state.chess = chess;
      state.fens = fens;
      state.sanMoves = sanMoves;
      state.verboseMoves = verboseMoves;
      state.currentPly = fens.length - 1;

      dom.boardEmpty.hidden = true;
      dom.analysis.hidden = false;
      dom.accuracySummary.hidden = true;
      dom.ribbonWrap.hidden = true;
      dom.moveDetail.hidden = true;
      dom.analyzeBtn.disabled = false;
      dom.analyzeBtn.textContent = "Run engine analysis";

      renderGameMeta(game);
      renderMoveList();
      renderBoard(state.currentPly);
      renderEvalBar(null);
      setStatus(null);
    } catch (err) {
      setStatus("Couldn't open this game: " + (err.message || err), "error");
    }
  }

  function cleanPgn(pgn) {
    return pgn
      .replace(/\{[^}]*\}/g, "")   // strip {%clk ...}, {%eval ...} and other comments
      .replace(/\$\d+/g, "")        // strip NAGs like $1 $2
      .replace(/\s+/g, " ")
      .trim();
  }

  function resetAnalysisState() {
    state.analysis = [];
    state.perMove = [];
    state.currentPly = 0;
    if (state.engine && state.engineBusy) {
      // Let any in-flight analysis finish silently; a fresh game load
      // simply won't be looking at its results.
    }
  }

  function renderGameMeta(game) {
    const white = game.white.username;
    const black = game.black.username;
    const date = new Date((game.end_time || 0) * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });
    const result = game.pgn.match(/\[Result "(.*?)"\]/);
    dom.gameMeta.innerHTML = `<b>${escapeHtml(white)}</b> (${game.white.rating}) vs
      <b>${escapeHtml(black)}</b> (${game.black.rating}) &middot;
      ${escapeHtml(game.time_class || "")} &middot; ${date}
      ${result ? "&middot; " + escapeHtml(result[1]) : ""}`;
  }

  /* =========================================================
     Board rendering
     ========================================================= */

  function fenToGrid(fen) {
    const rows = fen.split(" ")[0].split("/");
    const grid = [];
    rows.forEach(row => {
      const cells = [];
      for (const ch of row) {
        if (/\d/.test(ch)) {
          for (let i = 0; i < parseInt(ch, 10); i++) cells.push(null);
        } else {
          const color = ch === ch.toUpperCase() ? "w" : "b";
          cells.push(color + ch.toLowerCase());
        }
      }
      grid.push(cells);
    });
    return grid; // grid[0] = rank 8 ... grid[7] = rank 1
  }

  function renderBoard(ply) {
    const fen = state.fens[ply];
    const grid = fenToGrid(fen);
    dom.board.innerHTML = "";

    const move = ply > 0 ? state.verboseMoves[ply - 1] : null;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = document.createElement("div");
        const isLight = (r + c) % 2 === 0;
        sq.className = "sq " + (isLight ? "sq--light" : "sq--dark");

        const fileIdx = c;
        const rankNum = 8 - r;
        const squareName = FILES[fileIdx] + rankNum;

        if (move && (squareName === move.from)) sq.classList.add("sq--from");
        if (move && (squareName === move.to)) sq.classList.add("sq--to");

        const piece = grid[r][c];
        if (piece) {
          const span = document.createElement("span");
          span.className = "piece--" + piece[0];
          span.textContent = PIECE_GLYPH[piece];
          sq.appendChild(span);
        }
        dom.board.appendChild(sq);
      }
    }

    // Best-move arrow overlay
    if (state.showArrow && state.analysis[ply] && state.analysis[ply].bestMoveUci) {
      drawArrow(state.analysis[ply].bestMoveUci);
    }

    updateMoveListHighlight(ply);
    renderEvalBar(ply);
    renderMoveDetail(ply);
  }

  function squareCenter(squareName) {
    const file = FILES.indexOf(squareName[0]);
    const rank = parseInt(squareName[1], 10);
    const boardSize = dom.board.clientWidth || 420;
    const cell = boardSize / 8;
    const x = file * cell + cell / 2;
    const y = (8 - rank) * cell + cell / 2;
    return { x, y };
  }

  function drawArrow(uciMove) {
    if (!uciMove || uciMove.length < 4) return;
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const a = squareCenter(from);
    const b = squareCenter(to);
    const boardSize = dom.board.clientWidth || 420;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "board__arrow-layer");
    svg.setAttribute("viewBox", `0 0 ${boardSize} ${boardSize}`);
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.pointerEvents = "none";

    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "4");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const markerPath = document.createElementNS(svgNS, "path");
    markerPath.setAttribute("d", "M0,0 L8,4 L0,8 Z");
    markerPath.setAttribute("fill", "rgba(201,161,90,0.9)");
    marker.appendChild(markerPath);
    const defs = document.createElementNS(svgNS, "defs");
    defs.appendChild(marker);
    svg.appendChild(defs);

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("stroke", "rgba(201,161,90,0.85)");
    line.setAttribute("stroke-width", "6");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("marker-end", "url(#arrowhead)");
    svg.appendChild(line);

    dom.board.style.position = "relative";
    dom.board.appendChild(svg);
  }

  /* =========================================================
     Move list rendering
     ========================================================= */

  function renderMoveList() {
    dom.movelist.innerHTML = "";
    const total = state.sanMoves.length - 1; // ply count
    for (let moveNum = 1; moveNum <= Math.ceil(total / 2); moveNum++) {
      const whitePly = (moveNum - 1) * 2 + 1;
      const blackPly = whitePly + 1;

      const numCell = document.createElement("div");
      numCell.className = "movelist__num";
      numCell.textContent = moveNum + ".";
      dom.movelist.appendChild(numCell);

      dom.movelist.appendChild(makeMoveButton(whitePly));
      if (blackPly <= total) {
        dom.movelist.appendChild(makeMoveButton(blackPly));
      } else {
        const filler = document.createElement("div");
        dom.movelist.appendChild(filler);
      }
    }
  }

  function makeMoveButton(ply) {
    const btn = document.createElement("button");
    btn.className = "move-btn";
    btn.dataset.ply = String(ply);
    btn.innerHTML = `<span>${escapeHtml(state.sanMoves[ply] || "")}</span>`;
    btn.addEventListener("click", () => {
      state.currentPly = ply;
      renderBoard(ply);
    });
    return btn;
  }

  function updateMoveListHighlight(ply) {
    dom.movelist.querySelectorAll(".move-btn").forEach(b => {
      b.classList.toggle("is-current", parseInt(b.dataset.ply, 10) === ply);
    });
  }

  function applyClassificationTags() {
    dom.movelist.querySelectorAll(".move-btn").forEach(btn => {
      const ply = parseInt(btn.dataset.ply, 10);
      const info = state.perMove[ply];
      const existingTag = btn.querySelector(".move-btn__tag");
      if (existingTag) existingTag.remove();
      if (info) {
        const tag = document.createElement("span");
        tag.className = "move-btn__tag tag--" + info.classification.toLowerCase();
        btn.appendChild(tag);
      }
    });
  }

  /* =========================================================
     Eval bar
     ========================================================= */

  function renderEvalBar(ply) {
    if (ply === null || !state.analysis[ply]) {
      dom.evalBarFill.style.height = "50%";
      dom.evalBarLabel.textContent = "\u2013";
      return;
    }
    const a = state.analysis[ply];
    // Convert to White's perspective for the bar.
    const sideToMove = (ply % 2 === 0) ? "w" : "b"; // fens[0] is white to move, alternates
    let cpWhite;
    let label;
    if (a.mate !== null && a.mate !== undefined) {
      const mateWhitePerspective = sideToMove === "w" ? a.mate : -a.mate;
      cpWhite = mateWhitePerspective > 0 ? 100000 : -100000;
      label = "M" + Math.abs(a.mate);
    } else {
      cpWhite = sideToMove === "w" ? a.cp : -a.cp;
      label = (cpWhite / 100).toFixed(1);
      if (cpWhite > 0) label = "+" + label;
    }
    const winPct = winPercent(cpWhite);
    dom.evalBarFill.style.height = winPct + "%";
    dom.evalBarLabel.textContent = label;
  }

  /* =========================================================
     Win% / accuracy math
     ========================================================= */

  function winPercent(cp) {
    const clamped = Math.max(-1000, Math.min(1000, cp));
    const wp = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
    return Math.max(0, Math.min(100, wp));
  }

  function accuracyFromDrop(drop) {
    const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
    return Math.max(0, Math.min(100, acc));
  }

  function mateToCp(mate) {
    if (mate > 0) return 10000 - Math.min(mate, 90) * 100;
    return -10000 - Math.max(mate, -90) * 100;
  }

  function cpOf(entry) {
    if (!entry) return 0;
    if (entry.mate !== null && entry.mate !== undefined) return mateToCp(entry.mate);
    return entry.cp || 0;
  }

  /* =========================================================
     Stockfish engine
     ========================================================= */

  function loadEngineScript() {
    return new Promise(async (resolve, reject) => {
      for (const url of ENGINE_URLS) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const text = await res.text();
          const blob = new Blob([text], { type: "application/javascript" });
          const blobUrl = URL.createObjectURL(blob);
          resolve(blobUrl);
          return;
        } catch (e) {
          // try next URL
        }
      }
      reject(new Error("Could not load the Stockfish engine from any CDN. Check your internet connection."));
    });
  }

  async function ensureEngine() {
    if (state.engineReady) return;
    setStatus("Loading Stockfish engine\u2026", "loading");
    const blobUrl = await loadEngineScript();
    const worker = new Worker(blobUrl);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Engine timed out while starting up.")), 15000);
      worker.onmessage = (e) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line.includes("uciok")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      worker.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error("Engine failed to start: " + err.message));
      };
      worker.postMessage("uci");
    });

    state.engine = worker;
    state.engineReady = true;
    setStatus(null);
  }

  function evaluateFen(fen, depth) {
    return new Promise((resolve) => {
      let lastCp = null;
      let lastMate = null;

      const handler = (e) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line.startsWith("info")) {
          const cpMatch = line.match(/score cp (-?\d+)/);
          const mateMatch = line.match(/score mate (-?\d+)/);
          if (mateMatch) {
            lastMate = parseInt(mateMatch[1], 10);
            lastCp = null;
          } else if (cpMatch) {
            lastCp = parseInt(cpMatch[1], 10);
            lastMate = null;
          }
        } else if (line.startsWith("bestmove")) {
          const parts = line.split(" ");
          const bestMoveUci = parts[1] && parts[1] !== "(none)" ? parts[1] : null;
          state.engine.removeEventListener("message", handler);
          resolve({ cp: lastCp, mate: lastMate, bestMoveUci });
        }
      };

      state.engine.addEventListener("message", handler);
      state.engine.postMessage("position fen " + fen);
      state.engine.postMessage("go depth " + depth);
    });
  }

  /* =========================================================
     Run full-game analysis
     ========================================================= */

  async function runAnalysis() {
    if (state.engineBusy) return;
    const depth = parseInt(dom.depthSelect.value, 10);

    try {
      dom.analyzeBtn.disabled = true;
      dom.analyzeBtn.textContent = "Analyzing\u2026";
      await ensureEngine();
      state.engine.postMessage("ucinewgame");

      state.engineBusy = true;
      dom.progress.hidden = false;

      const fens = state.fens;
      const results = [];
      for (let i = 0; i < fens.length; i++) {
        const pct = Math.round(((i + 1) / fens.length) * 100);
        dom.progressBar.style.width = pct + "%";
        dom.progressLabel.textContent = `Analyzing position ${i + 1} of ${fens.length}`;
        const result = await evaluateFen(fens[i], depth);
        results.push(result);
        state.analysis[i] = result;
        // Keep the board eval bar live if the user is looking at this ply already.
        if (state.currentPly === i) renderEvalBar(i);
      }

      computePerMoveStats();
      applyClassificationTags();
      renderAccuracySummary();
      renderRibbon();
      renderBoard(state.currentPly);

      dom.progress.hidden = true;
      dom.analyzeBtn.textContent = "Re-run analysis";
      dom.analyzeBtn.disabled = false;
      setStatus(null);
    } catch (err) {
      setStatus(err.message || "Analysis failed.", "error");
      dom.analyzeBtn.disabled = false;
      dom.analyzeBtn.textContent = "Run engine analysis";
    } finally {
      state.engineBusy = false;
    }
  }

  function computePerMoveStats() {
    const perMove = [null]; // index 0 unused (no move played yet)
    for (let i = 1; i < state.fens.length; i++) {
      const before = state.analysis[i - 1];
      const after = state.analysis[i];
      if (!before || !after) { perMove.push(null); continue; }

      const mover = (i % 2 === 1) ? "w" : "b"; // ply i was played by white if i is odd
      const cpBefore = cpOf(before);                 // from mover's perspective (side to move at i-1)
      const cpAfterRaw = cpOf(after);                 // from opponent's perspective (side to move at i)
      const cpAfterMover = -cpAfterRaw;                 // flip to mover's perspective

      const wpBefore = winPercent(cpBefore);
      const wpAfter = winPercent(cpAfterMover);
      const drop = Math.max(0, wpBefore - wpAfter);

      const playedUci = moveToUci(state.verboseMoves[i - 1]);
      const isBest = before.bestMoveUci && playedUci === before.bestMoveUci;

      let classification;
      if (isBest) classification = "Best";
      else if (drop < 2) classification = "Excellent";
      else if (drop < 5) classification = "Good";
      else if (drop < 10) classification = "Inaccuracy";
      else if (drop < 20) classification = "Mistake";
      else classification = "Blunder";

      perMove.push({
        mover,
        classification,
        drop,
        accuracy: accuracyFromDrop(drop),
        cpBefore,
        cpAfterMover,
        bestMoveUci: before.bestMoveUci
      });
    }
    state.perMove = perMove;
  }

  function moveToUci(verboseMove) {
    if (!verboseMove) return null;
    let uci = verboseMove.from + verboseMove.to;
    if (verboseMove.promotion) uci += verboseMove.promotion;
    return uci;
  }

  /* =========================================================
     Accuracy summary + ribbon
     ========================================================= */

  function renderAccuracySummary() {
    const whiteMoves = state.perMove.filter((m, i) => m && m.mover === "w");
    const blackMoves = state.perMove.filter((m, i) => m && m.mover === "b");

    const avg = (arr) => arr.length ? arr.reduce((s, m) => s + m.accuracy, 0) / arr.length : 0;
    const countOf = (arr, cls) => arr.filter(m => m.classification === cls).length;

    const whiteAcc = avg(whiteMoves);
    const blackAcc = avg(blackMoves);

    const game = state.games[state.activeGameIdx];

    dom.accuracySummary.hidden = false;
    dom.accuracySummary.innerHTML = `
      ${accuracyCardHtml(game.white.username, whiteAcc, whiteMoves)}
      ${accuracyCardHtml(game.black.username, blackAcc, blackMoves)}
    `;
  }

  function accuracyCardHtml(name, acc, moves) {
    const blunders = moves.filter(m => m.classification === "Blunder").length;
    const mistakes = moves.filter(m => m.classification === "Mistake").length;
    const inaccuracies = moves.filter(m => m.classification === "Inaccuracy").length;
    return `
      <div class="accuracy-card">
        <div class="accuracy-card__side">${escapeHtml(name)}</div>
        <div class="accuracy-card__value">${acc.toFixed(1)}%</div>
        <div class="accuracy-card__chips">
          <span class="chip chip--blunder"><b>${blunders}</b> blunders</span>
          <span class="chip chip--mistake"><b>${mistakes}</b> mistakes</span>
          <span class="chip chip--inaccuracy"><b>${inaccuracies}</b> inaccuracies</span>
        </div>
      </div>
    `;
  }

  function classificationColor(cls) {
    return {
      Best: "#C9A15A", Excellent: "#7FA383", Good: "#7FA383",
      Inaccuracy: "#D9C25A", Mistake: "#D68C3C", Blunder: "#B5473A"
    }[cls] || "#7E9284";
  }

  function renderRibbon() {
    dom.ribbonWrap.hidden = false;
    const svgNS = "http://www.w3.org/2000/svg";
    dom.ribbon.innerHTML = "";

    const n = state.analysis.length;
    if (n === 0) return;
    const w = 1000, h = 60;
    const points = [];

    for (let i = 0; i < n; i++) {
      const sideToMove = (i % 2 === 0) ? "w" : "b";
      const cp = cpOf(state.analysis[i]);
      const cpWhite = sideToMove === "w" ? cp : -cp;
      const wp = winPercent(cpWhite);
      const x = (i / (n - 1 || 1)) * w;
      const y = h - (wp / 100) * h;
      points.push([x, y]);
    }

    const path = document.createElementNS(svgNS, "path");
    const d = points.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#B9C2B7");
    path.setAttribute("stroke-width", "1.5");
    dom.ribbon.appendChild(path);

    // Dots colored by move classification, clickable.
    for (let ply = 1; ply < state.perMove.length; ply++) {
      const info = state.perMove[ply];
      if (!info || info.classification === "Best" || info.classification === "Excellent" || info.classification === "Good") continue;
      const [x, y] = points[ply];
      const circle = document.createElementNS(svgNS, "circle");
      circle.setAttribute("cx", x.toFixed(1));
      circle.setAttribute("cy", y.toFixed(1));
      circle.setAttribute("r", "5");
      circle.setAttribute("fill", classificationColor(info.classification));
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => {
        state.currentPly = ply;
        renderBoard(ply);
      });
      dom.ribbon.appendChild(circle);
    }

    // Zero/mid line
    const mid = document.createElementNS(svgNS, "line");
    mid.setAttribute("x1", "0"); mid.setAttribute("x2", String(w));
    mid.setAttribute("y1", String(h / 2)); mid.setAttribute("y2", String(h / 2));
    mid.setAttribute("stroke", "rgba(255,255,255,0.12)");
    mid.setAttribute("stroke-width", "1");
    dom.ribbon.insertBefore(mid, dom.ribbon.firstChild);
  }

  /* =========================================================
     Move detail panel
     ========================================================= */

  function renderMoveDetail(ply) {
    const info = state.perMove[ply];
    if (!info) { dom.moveDetail.hidden = true; return; }

    dom.moveDetail.hidden = false;
    const san = state.sanMoves[ply];
    const moverName = info.mover === "w"
      ? state.games[state.activeGameIdx].white.username
      : state.games[state.activeGameIdx].black.username;

    let bestLine = "";
    if (info.classification !== "Best" && info.bestMoveUci) {
      bestLine = `<div class="move-detail__row">Engine preferred: <span>${escapeHtml(info.bestMoveUci)}</span></div>`;
    }

    dom.moveDetail.innerHTML = `
      <div class="move-detail__headline c-${info.classification.toLowerCase()}">${escapeHtml(san)} \u2014 ${info.classification}</div>
      <div class="move-detail__row">${escapeHtml(moverName)} \u00b7 win% dropped by <span>${info.drop.toFixed(1)}</span> \u00b7 move accuracy <span>${info.accuracy.toFixed(1)}%</span></div>
      ${bestLine}
    `;
  }

  /* =========================================================
     Navigation controls
     ========================================================= */

  function goToPly(ply) {
    const clamped = Math.max(0, Math.min(state.fens.length - 1, ply));
    state.currentPly = clamped;
    renderBoard(clamped);
  }

  dom.btnStart.addEventListener("click", () => goToPly(0));
  dom.btnPrev.addEventListener("click", () => goToPly(state.currentPly - 1));
  dom.btnNext.addEventListener("click", () => goToPly(state.currentPly + 1));
  dom.btnEnd.addEventListener("click", () => goToPly(state.fens.length - 1));

  document.addEventListener("keydown", (e) => {
    if (!state.chess) return;
    if (e.key === "ArrowLeft") goToPly(state.currentPly - 1);
    if (e.key === "ArrowRight") goToPly(state.currentPly + 1);
  });

  dom.toggleArrow.addEventListener("change", () => {
    state.showArrow = dom.toggleArrow.checked;
    renderBoard(state.currentPly);
  });

  dom.analyzeBtn.addEventListener("click", runAnalysis);

  /* =========================================================
     Form submit
     ========================================================= */

  dom.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = dom.usernameInput.value.trim();
    if (!username) return;

    dom.submitBtn.disabled = true;
    setStatus(`Looking up ${username}\u2026`, "loading");
    dom.gameList.innerHTML = "";
    dom.boardEmpty.hidden = false;
    dom.analysis.hidden = true;

    try {
      const games = await fetchRecentGames(username);
      state.username = username;
      state.games = games;
      renderGameList();
      setStatus(null);
    } catch (err) {
      setStatus(err.message || "Something went wrong.", "error");
      dom.gameList.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || "Couldn't load games.")}</p></div>`;
    } finally {
      dom.submitBtn.disabled = false;
    }
  });

})();
