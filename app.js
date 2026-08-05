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
    "https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js",
    "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js"
  ];

  const PIECE_SHAPES = {
    p: '<circle cx="22.5" cy="13" r="6"/><polygon points="17,19 28,19 30,26 15,26"/><polygon points="10,33 35,33 32,39 13,39"/><rect x="8" y="39" width="29" height="3"/>',
    n: '<polygon points="13,36 32,36 30,24 33,18 27,10 20,12 18,16 12,20 14,26 11,30" stroke-linejoin="round"/><rect x="9" y="36" width="27" height="4"/>',
    b: '<circle cx="22.5" cy="14" r="7"/><polygon points="16,20 29,20 31,33 14,33"/><circle cx="22.5" cy="5" r="2.3"/><rect x="9" y="33" width="27" height="5"/>',
    r: '<rect x="12" y="10" width="5" height="7"/><rect x="20" y="10" width="5" height="7"/><rect x="28" y="10" width="5" height="7"/><rect x="12" y="15" width="21" height="4"/><polygon points="12,34 33,34 31,19 14,19"/><rect x="9" y="34" width="27" height="5"/>',
    q: '<rect x="13" y="20" width="19" height="7"/><circle cx="14" cy="14" r="3"/><circle cx="19" cy="12" r="3"/><circle cx="22.5" cy="10" r="3"/><circle cx="26" cy="12" r="3"/><circle cx="31" cy="14" r="3"/><polygon points="13,27 32,27 30,34 15,34"/><rect x="9" y="34" width="27" height="5"/>',
    k: '<rect x="21" y="4" width="3" height="10"/><rect x="18" y="7" width="9" height="3"/><path d="M13,20 Q22.5,15 32,20 L32,27 Q22.5,24 13,27 Z"/><polygon points="13,27 32,27 30,34 15,34"/><rect x="9" y="34" width="27" height="5"/>'
  };

  function pieceSvgMarkup(pieceCode) {
    const color = pieceCode[0]; // w | b
    const type = pieceCode[1];  // p n b r q k
    return `<svg class="piece-svg piece--${color}" viewBox="0 0 45 45" stroke-linejoin="round" stroke-width="1.3">${PIECE_SHAPES[type]}</svg>`;
  }

  const FILES = ["a","b","c","d","e","f","g","h"];

  /* ---------------- State ---------------- */

  const state = {
    username: null,
    games: [],           // list from chess.com API
    archives: [],
    archiveCursor: 0,
    gameBuffer: [],
    totalSeenAllTime: 0,
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
    squareEls: [],
    showArrow: true,
    clocks: [],           // per-ply seconds remaining, if the PGN included them
    bookLength: 0,          // number of plies classified as opening theory
    openingName: null,
    engineTimeouts: []       // debug/telemetry: per-ply movetime actually used
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
    loadMoreBtn: el("load-more-btn"),
    boardEmpty: el("board-empty"),
    analysis: el("analysis"),
    gameMeta: el("game-meta"),
    materialRow: el("material-row"),
    criticalMoment: el("critical-moment"),
    verdict: el("verdict"),
    accuracySummary: el("accuracy-summary"),
    ribbonWrap: el("ribbon-wrap"),
    ribbon: el("ribbon"),
    evalBar: el("eval-bar"),
    evalBarFill: el("eval-bar-fill"),
    evalBarLabel: el("eval-bar-label"),
    board: el("board"),
    filesRow: el("files-row"),
    ranksCol: el("ranks-col"),
    flipBtn: el("flip-btn"),
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

  async function initArchives(username) {
    const uname = username.trim().toLowerCase();
    const archivesRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(uname)}/games/archives`);
    if (!archivesRes.ok) {
      if (archivesRes.status === 404) throw new Error(`No Chess.com account found for "${username}". Check the spelling — this is the login username, not a display name.`);
      throw new Error(`Chess.com API returned ${archivesRes.status} while fetching archives.`);
    }
    const archivesData = await archivesRes.json();
    const archives = archivesData.archives || [];
    if (archives.length === 0) throw new Error(`"${username}" has never played a game on Chess.com (no archives exist).`);
    state.archives = archives;
    state.archiveCursor = archives.length;
    state.gameBuffer = [];
    state.totalSeenAllTime = 0;
  }

  async function drainMoreGames(count) {
    let monthsChecked = 0;
    while (state.gameBuffer.length < count && state.archiveCursor > 0 && monthsChecked < 12) {
      state.archiveCursor--;
      monthsChecked++;
      const res = await fetch(state.archives[state.archiveCursor]);
      if (!res.ok) continue;
      const data = await res.json();
      const allGames = data.games || [];
      state.totalSeenAllTime += allGames.length;
      const games = allGames.filter(g => g.rules === "chess"); // standard chess only
      state.gameBuffer = state.gameBuffer.concat(games);
    }
    state.gameBuffer.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
    const batch = state.gameBuffer.slice(0, count);
    state.gameBuffer = state.gameBuffer.slice(count);
    return batch;
  }

  function hasMoreGames() {
    return state.archiveCursor > 0 || state.gameBuffer.length > 0;
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

  // A small curated table of common opening lines (well-established mainline
  // theory only — not exhaustive, but covers what shows up in most club games).
  // Used to (a) tag early moves "Book" instead of grading them against the
  // engine, and (b) skip deep analysis on them entirely.
  const OPENING_BOOK = [
    { name: "Ruy Lopez", moves: ["e4","e5","Nf3","Nc6","Bb5","a6","Ba4","Nf6","O-O","Be7"] },
    { name: "Italian Game", moves: ["e4","e5","Nf3","Nc6","Bc4","Bc5"] },
    { name: "Petrov's Defense", moves: ["e4","e5","Nf3","Nf6"] },
    { name: "Philidor Defense", moves: ["e4","e5","Nf3","d6"] },
    { name: "Bishop's Opening", moves: ["e4","e5","Bc4"] },
    { name: "King's Gambit", moves: ["e4","e5","f4"] },
    { name: "Sicilian Defense: Najdorf", moves: ["e4","c5","Nf3","d6","d4","cxd4","Nxd4","Nf6","Nc3"] },
    { name: "Sicilian Defense: Open", moves: ["e4","c5","Nf3","Nc6"] },
    { name: "Sicilian Defense: Taimanov", moves: ["e4","c5","Nf3","e6"] },
    { name: "Sicilian Defense: Closed", moves: ["e4","c5","Nc3"] },
    { name: "Caro-Kann Defense", moves: ["e4","c6","d4","d5"] },
    { name: "French Defense", moves: ["e4","e6","d4","d5"] },
    { name: "Scandinavian Defense", moves: ["e4","d5"] },
    { name: "Modern Defense", moves: ["e4","g6"] },
    { name: "Queen's Gambit Declined", moves: ["d4","d5","c4","e6"] },
    { name: "Slav Defense", moves: ["d4","d5","c4","c6"] },
    { name: "Queen's Gambit Accepted", moves: ["d4","d5","c4","dxc4"] },
    { name: "London System", moves: ["d4","d5","Bf4"] },
    { name: "Veresov Attack", moves: ["d4","d5","Nc3"] },
    { name: "King's Indian Defense", moves: ["d4","Nf6","c4","g6","Nc3","Bg7","e4","d6"] },
    { name: "Nimzo-Indian Defense", moves: ["d4","Nf6","c4","e6","Nc3","Bb4"] },
    { name: "Queen's Indian Defense", moves: ["d4","Nf6","c4","e6","Nf3","b6"] },
    { name: "Dutch Defense", moves: ["d4","f5"] },
    { name: "English Opening", moves: ["c4","e5"] },
    { name: "Reti Opening", moves: ["Nf3","d5","g3"] }
  ];

  function stripCheckSymbol(san) { return (san || "").replace(/[+#]/g, ""); }

  function matchOpeningBook(sanMoves) {
    // sanMoves is 1-indexed with sanMoves[0] = null.
    let best = { name: null, length: 0 };
    for (const entry of OPENING_BOOK) {
      let matched = 0;
      for (let i = 0; i < entry.moves.length; i++) {
        const actual = stripCheckSymbol(sanMoves[i + 1]);
        if (actual !== entry.moves[i]) break;
        matched++;
      }
      if (matched > best.length) best = { name: entry.name, length: matched };
    }
    return best; // { name, length } — length is how many plies are "book"
  }

  function extractMoves(pgnRaw) {
    let text = pgnRaw;
    text = text.replace(/\[[^\]]*\]/g, " ");      // drop [Header "..."] lines
    // Capture clock comments before stripping them.
    const clocks = [];
    text = text.replace(/\{[^}]*\}/g, (m) => {
      const clkMatch = m.match(/%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (clkMatch) {
        const secs = parseInt(clkMatch[1], 10) * 3600 + parseInt(clkMatch[2], 10) * 60 + parseFloat(clkMatch[3]);
        clocks.push(secs);
      } else {
        clocks.push(null);
      }
      return " ";
    });
    text = text.replace(/\$\d+/g, " ");             // drop NAGs like $1
    text = text.replace(/\d+\.(\.\.)?/g, " ");        // drop move numbers "12." / "12..."
    text = text.replace(/1-0|0-1|1\/2-1\/2|\*/g, " ");  // drop result token
    const sans = text.split(/\s+/).map(s => s.trim().replace(/[!?]+$/, "")).filter(Boolean);
    return { sans, clocks: clocks.length === sans.length ? clocks : [] };
  }

  function loadGame(game) {
    if (typeof Chess === "undefined") {
      setStatus("The chess.js library didn't load (probably blocked by network/adblock/CDN issue) — the board can't work without it. Try disabling any ad/script blocker and reload.", "error");
      return;
    }

    try {
      resetAnalysisState();

      const { sans: sanList, clocks: clockList } = extractMoves(game.pgn);
      const chess = new Chess();
      const verboseMoves = [];
      const fens = [chess.fen()];
      const sanMoves = [null];

      for (let i = 0; i < sanList.length; i++) {
        const moveObj = chess.move(sanList[i], { sloppy: true });
        if (!moveObj) {
          throw new Error(`Couldn't parse move ${i + 1} ("${sanList[i]}") of this game.`);
        }
        verboseMoves.push(moveObj);
        fens.push(chess.fen());
        sanMoves.push(moveObj.san);
      }

      if (verboseMoves.length === 0) {
        throw new Error("This game has no moves to analyze.");
      }

      const myUsername = (state.username || "").toLowerCase();
      state.boardFlipped = game.black.username.toLowerCase() === myUsername;
      state.squareEls = [];
      state.clocks = clockList;

      const bookMatch = matchOpeningBook(sanMoves);
      state.bookLength = bookMatch.length;
      state.openingName = bookMatch.name || openingNameFromPgn(game.pgn);

      state.chess = chess;
      state.fens = fens;
      state.sanMoves = sanMoves;
      state.verboseMoves = verboseMoves;
      state.currentPly = 0;

      dom.boardEmpty.hidden = true;
      dom.analysis.hidden = false;
      dom.accuracySummary.hidden = true;
      dom.ribbonWrap.hidden = true;
      dom.moveDetail.hidden = true;
      dom.criticalMoment.hidden = true;
      dom.verdict.hidden = true;
      dom.analyzeBtn.disabled = false;
      dom.analyzeBtn.textContent = "Re-run analysis";

      renderGameMeta(game);
      renderMoveList();
      renderBoard(state.currentPly);
      renderEvalBar(null);
      setStatus(null);

      // Auto-run analysis as soon as the game opens.
      runAnalysis();
    } catch (err) {
      setStatus("Couldn't open this game: " + (err.message || err), "error");
    }
  }

  function openingNameFromPgn(pgnRaw) {
    const m = pgnRaw.match(/\[ECOUrl\s+"[^"]*\/openings\/([^"]+)"\]/i);
    if (!m) return null;
    // chess.com slugs look like "Italian-Game-Giuoco-Piano-3...Nf6" — keep the
    // readable words, drop any trailing bare move-notation segment.
    return m[1]
      .split("-")
      .filter(seg => !/^\d/.test(seg) && seg.length > 0)
      .join(" ");
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
      ${result ? "&middot; " + escapeHtml(result[1]) : ""}
      ${state.openingName ? "&middot; " + escapeHtml(state.openingName) : ""}`;
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

  function buildBoardGrid() {
    dom.board.innerHTML = "";
    state.squareEls = [];
    for (let i = 0; i < 64; i++) {
      const r = Math.floor(i / 8), c = i % 8;
      const sq = document.createElement("div");
      sq.className = "sq " + (((r + c) % 2 === 0) ? "sq--light" : "sq--dark");
      const wrap = document.createElement("span");
      wrap.className = "piece-wrap";
      sq.appendChild(wrap);
      dom.board.appendChild(sq);
      state.squareEls.push({ el: sq, wrap, piece: null });
    }
  }

  function renderCoordLabels() {
    const files = state.boardFlipped ? [...FILES].reverse() : FILES;
    const ranks = state.boardFlipped ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];
    dom.filesRow.innerHTML = files.map(f => `<span>${f}</span>`).join("");
    dom.ranksCol.innerHTML = ranks.map(r => `<span>${r}</span>`).join("");
  }

  function renderBoard(ply) {
    const fen = state.fens[ply];
    const grid = fenToGrid(fen);
    if (!state.squareEls || state.squareEls.length === 0) buildBoardGrid();
    renderCoordLabels();

    const move = ply > 0 ? state.verboseMoves[ply - 1] : null;

    // Detect check: find the king of the side to move, if in check.
    let checkSquare = null;
    try {
      const probe = new Chess(fen);
      const sideToMove = (ply % 2 === 0) ? "w" : "b";
      if (probe.in_check && probe.in_check()) {
        outer:
        for (let gr = 0; gr < 8; gr++) {
          for (let gc = 0; gc < 8; gc++) {
            if (grid[gr][gc] === sideToMove + "k") {
              checkSquare = FILES[gc] + (8 - gr);
              break outer;
            }
          }
        }
      }
    } catch (e) { /* non-fatal */ }

    for (let i = 0; i < 64; i++) {
      const r = Math.floor(i / 8), c = i % 8;
      const gr = state.boardFlipped ? 7 - r : r;
      const gc = state.boardFlipped ? 7 - c : c;
      const fileIdx = gc;
      const rankNum = 8 - gr;
      const squareName = FILES[fileIdx] + rankNum;

      const cell = state.squareEls[i];
      cell.el.classList.toggle("sq--from", !!(move && squareName === move.from));
      cell.el.classList.toggle("sq--to", !!(move && squareName === move.to));
      cell.el.classList.toggle("sq--check", squareName === checkSquare);

      const pieceCode = grid[gr][gc];
      if (pieceCode !== cell.piece) {
        cell.piece = pieceCode;
        cell.wrap.classList.remove("is-visible");
        if (pieceCode) {
          cell.wrap.innerHTML = pieceSvgMarkup(pieceCode);
          // eslint-disable-next-line no-unused-expressions
          cell.wrap.offsetWidth; // force reflow so the transition below actually fires
          requestAnimationFrame(() => cell.wrap.classList.add("is-visible"));
        } else {
          cell.wrap.innerHTML = "";
        }
      }
    }

    // Best-move arrow overlay
    const oldArrow = dom.board.querySelector(".board__arrow-layer");
    if (oldArrow) oldArrow.remove();
    if (state.showArrow && state.analysis[ply] && state.analysis[ply].bestMoveUci) {
      drawArrow(state.analysis[ply].bestMoveUci);
    }

    updateMoveListHighlight(ply);
    renderEvalBar(ply);
    renderMoveDetail(ply);
    renderMaterial(ply);
  }

  function squareCenter(squareName) {
    const file = FILES.indexOf(squareName[0]);
    const rank = parseInt(squareName[1], 10);
    const boardSize = dom.board.clientWidth || 420;
    const cell = boardSize / 8;
    const col = state.boardFlipped ? 7 - file : file;
    const row = state.boardFlipped ? rank - 1 : 8 - rank;
    const x = col * cell + cell / 2;
    const y = row * cell + cell / 2;
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

  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const STARTING_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

  function renderMaterial(ply) {
    const grid = fenToGrid(state.fens[ply]);
    const counts = { w: { p:0,n:0,b:0,r:0,q:0 }, b: { p:0,n:0,b:0,r:0,q:0 } };
    grid.forEach(row => row.forEach(cell => {
      if (!cell) return;
      const color = cell[0], type = cell[1];
      if (counts[color][type] !== undefined) counts[color][type]++;
    }));

    const valueOf = (side) => Object.keys(PIECE_VALUE).reduce((s, t) => s + counts[side][t] * PIECE_VALUE[t], 0);
    const diff = valueOf("w") - valueOf("b");

    const capturedBy = (winnerColor) => {
      // Pieces the opponent has lost = starting count minus what's left on their side.
      const loserColor = winnerColor === "w" ? "b" : "w";
      const pieces = [];
      Object.keys(STARTING_COUNT).forEach(t => {
        const lost = STARTING_COUNT[t] - counts[loserColor][t];
        for (let i = 0; i < lost; i++) pieces.push(winnerColor + t);
      });
      return pieces;
    };

    const rowHtml = (color) => capturedBy(color).map(pc =>
      `<span class="captured-piece">${pieceSvgMarkup(pc)}</span>`
    ).join("");

    dom.materialRow.innerHTML = `
      <div class="material-side">${rowHtml("w")}</div>
      <div class="material-diff">${diff === 0 ? "=" : (diff > 0 ? "White +" + diff : "Black +" + (-diff))}</div>
      <div class="material-side">${rowHtml("b")}</div>
    `;
  }

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
    // Always computed and displayed from White's perspective — light fill = White's
    // share of the win probability, full stop, regardless of which way the board
    // is oriented. Flipping this along with board orientation is what caused the
    // "black is winning but the bar looks white" confusion.
    const sideToMove = (ply % 2 === 0) ? "w" : "b";
    let cpWhite;
    let label;
    if (a.mate !== null && a.mate !== undefined) {
      const mateWhitePerspective = sideToMove === "w" ? a.mate : -a.mate;
      cpWhite = mateWhitePerspective > 0 ? 100000 : -100000;
      label = (mateWhitePerspective > 0 ? "M" : "-M") + Math.abs(a.mate);
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

  function evaluateFen(fen, movetimeMs) {
    return new Promise((resolve) => {
      let lastCp = null;
      let lastMate = null;
      let lastPv = null;

      const handler = (e) => {
        const line = typeof e.data === "string" ? e.data : "";
        if (line.startsWith("info")) {
          const cpMatch = line.match(/score cp (-?\d+)/);
          const mateMatch = line.match(/score mate (-?\d+)/);
          const pvMatch = line.match(/\spv\s+(.+)$/);
          if (mateMatch) {
            lastMate = parseInt(mateMatch[1], 10);
            lastCp = null;
          } else if (cpMatch) {
            lastCp = parseInt(cpMatch[1], 10);
            lastMate = null;
          }
          if (pvMatch) lastPv = pvMatch[1].trim().split(/\s+/);
        } else if (line.startsWith("bestmove")) {
          const parts = line.split(" ");
          const bestMoveUci = parts[1] && parts[1] !== "(none)" ? parts[1] : null;
          state.engine.removeEventListener("message", handler);
          resolve({ cp: lastCp, mate: lastMate, bestMoveUci, pv: lastPv || [] });
        }
      };

      state.engine.addEventListener("message", handler);
      state.engine.postMessage("position fen " + fen);
      state.engine.postMessage("go movetime " + movetimeMs);
    });
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // "Adapt to the position": spend the engine's time budget where it matters —
  // more on positions with many reasonable options, less on forced sequences,
  // simplified endgames, or moves still inside known opening theory.
  function adaptiveMovetime(ply, baseMs) {
    if (ply <= state.bookLength) return Math.min(60, baseMs);
    let legalCount = 20;
    try { legalCount = new Chess(state.fens[ply]).moves().length; } catch (e) { /* fall back to default */ }
    if (legalCount <= 1) return Math.max(50, Math.round(baseMs * 0.3));

    const grid = fenToGrid(state.fens[ply]);
    let nonPawnPieces = 0;
    grid.forEach(row => row.forEach(c => { if (c && c[1] !== "p" && c[1] !== "k") nonPawnPieces++; }));

    let factor = clamp(legalCount / 28, 0.5, 1.6);
    if (nonPawnPieces <= 6) factor *= 0.65; // simplified endgame — less to calculate
    return Math.round(clamp(baseMs * factor, 60, baseMs * 2));
  }

  function materialValue(fen, color) {
    const grid = fenToGrid(fen);
    let total = 0;
    grid.forEach(row => row.forEach(c => {
      if (c && c[0] === color && PIECE_VALUE[c[1]]) total += PIECE_VALUE[c[1]];
    }));
    return total;
  }

  async function runAnalysis() {
    if (state.engineBusy) return;
    const movetimeMs = parseInt(dom.depthSelect.value, 10);

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
        const thisMovetime = adaptiveMovetime(i, movetimeMs);
        const result = await evaluateFen(fens[i], thisMovetime);
        results.push(result);
        state.analysis[i] = result;
        // Keep the board eval bar live if the user is looking at this ply already.
        if (state.currentPly === i) renderEvalBar(i);
      }

      computePerMoveStats();
      applyClassificationTags();
      renderAccuracySummary();
      renderRibbon();
      renderCriticalMoment();
      renderVerdict();
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

      if (i <= state.bookLength) {
        perMove.push({
          mover, classification: "Book", drop: 0, accuracy: 100,
          cpBefore, cpAfterMover, bestMoveUci: before.bestMoveUci, isBook: true
        });
        continue;
      }

      const playedUci = moveToUci(state.verboseMoves[i - 1]);
      const isBest = before.bestMoveUci && playedUci === before.bestMoveUci;

      let classification;
      if (isBest) classification = "Best";
      else if (drop < 2) classification = "Excellent";
      else if (drop < 5) classification = "Good";
      else if (drop < 10) classification = "Inaccuracy";
      else if (drop < 20) classification = "Mistake";
      else classification = "Blunder";

      let onlyMove = false;
      try { onlyMove = new Chess(state.fens[i - 1]).moves().length === 1; } catch (e) { /* ignore */ }

      // Heuristic "Brilliant": a near-best move that gives up material for the
      // mover but still leaves them clearly winning — the classic sacrifice
      // pattern. Approximate, not a full look-ahead like chess.com's engine.
      let isBrilliant = false;
      if ((classification === "Best" || classification === "Excellent") && !onlyMove) {
        const matBefore = materialValue(state.fens[i - 1], mover);
        const matAfter = materialValue(state.fens[i], mover);
        if (matAfter < matBefore && wpAfter >= 60) {
          isBrilliant = true;
          classification = "Brilliant";
        }
      }

      perMove.push({
        mover,
        classification,
        drop,
        accuracy: accuracyFromDrop(drop),
        cpBefore,
        cpAfterMover,
        bestMoveUci: before.bestMoveUci,
        pv: before.pv || [],
        isOnlyMove: onlyMove,
        isBrilliant
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

  function renderCriticalMoment() {
    let worst = null;
    for (let ply = 1; ply < state.perMove.length; ply++) {
      const info = state.perMove[ply];
      if (!info || info.classification === "Book") continue;
      if (!worst || info.drop > worst.info.drop) worst = { ply, info };
    }
    if (!worst || worst.info.drop < 15) { dom.criticalMoment.hidden = true; return; }

    const moverName = worst.info.mover === "w"
      ? state.games[state.activeGameIdx].white.username
      : state.games[state.activeGameIdx].black.username;
    const san = state.sanMoves[worst.ply];
    const moveNum = Math.ceil(worst.ply / 2);

    dom.criticalMoment.hidden = false;
    dom.criticalMoment.innerHTML = `This is where the game turned: move <b>${moveNum}${worst.info.mover === "b" ? "..." : "."} ${escapeHtml(san)}</b> by ${escapeHtml(moverName)} swung the win probability by <b>${worst.info.drop.toFixed(0)} points</b>. Click to jump there.`;
    dom.criticalMoment.onclick = () => { state.currentPly = worst.ply; renderBoard(worst.ply); };
  }

  function renderVerdict() {
    const activeGame = state.games[state.activeGameIdx];
    const myUsername = (state.username || "").toLowerCase();
    const myColor = activeGame.black.username.toLowerCase() === myUsername ? "b" : "w";
    const myMoves = state.perMove.filter(m => m && m.mover === myColor && m.classification !== "Book");
    if (myMoves.length === 0) { dom.verdict.hidden = true; return; }

    const avgAcc = myMoves.reduce((s, m) => s + m.accuracy, 0) / myMoves.length;
    const blunders = myMoves.filter(m => m.classification === "Blunder").length;
    const mistakes = myMoves.filter(m => m.classification === "Mistake").length;
    const brilliants = myMoves.filter(m => m.isBrilliant).length;

    let tier;
    if (avgAcc >= 90) tier = "very clean";
    else if (avgAcc >= 78) tier = "solid";
    else if (avgAcc >= 62) tier = "shaky in places";
    else tier = "rough";

    let sentence = `A ${tier} game (${avgAcc.toFixed(1)}% accuracy)`;
    if (state.openingName) sentence += ` out of the ${state.openingName}`;
    sentence += ".";

    if (brilliants > 0) {
      sentence += ` Found ${brilliants} brilliant sacrifice-style move${brilliants > 1 ? "s" : ""}.`;
    }
    if (blunders > 0) {
      sentence += ` ${blunders} blunder${blunders > 1 ? "s" : ""}${mistakes > 0 ? ` and ${mistakes} other mistake${mistakes > 1 ? "s" : ""}` : ""} stand out as the main thing to review.`;
    } else if (mistakes > 0) {
      sentence += ` ${mistakes} mistake${mistakes > 1 ? "s" : ""} crept in, but nothing game-losing.`;
    } else {
      sentence += " No real mistakes to speak of.";
    }

    // Time-trouble correlation, if the PGN included clock data.
    if (state.clocks && state.clocks.length === state.sanMoves.length) {
      const lowClockBlunders = [];
      for (let ply = 1; ply < state.perMove.length; ply++) {
        const info = state.perMove[ply];
        if (info && info.mover === myColor && (info.classification === "Blunder" || info.classification === "Mistake")) {
          const clk = state.clocks[ply];
          if (typeof clk === "number") lowClockBlunders.push(clk);
        }
      }
      if (lowClockBlunders.length >= 2) {
        const avgClk = lowClockBlunders.reduce((a, b) => a + b, 0) / lowClockBlunders.length;
        if (avgClk < 30) {
          sentence += ` Most of those happened with under ${Math.round(avgClk)}s on the clock \u2014 time pressure looks like a factor.`;
        }
      }
    }

    dom.verdict.hidden = false;
    dom.verdict.textContent = sentence;
  }

  function renderAccuracySummary() {
    const whiteMoves = state.perMove.filter(m => m && m.mover === "w" && m.classification !== "Book");
    const blackMoves = state.perMove.filter(m => m && m.mover === "b" && m.classification !== "Book");

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
      Inaccuracy: "#D9C25A", Mistake: "#D68C3C", Blunder: "#B5473A",
      Book: "#7E9284", Brilliant: "#5B9BAA"
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
      if (!info || info.classification === "Best" || info.classification === "Excellent" || info.classification === "Good" || info.classification === "Book") continue;
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

  function uciPvToSan(fen, pvUci, maxPlies) {
    try {
      const temp = new Chess(fen);
      const sans = [];
      for (let i = 0; i < Math.min(pvUci.length, maxPlies); i++) {
        const from = pvUci[i].slice(0, 2), to = pvUci[i].slice(2, 4), promotion = pvUci[i].slice(4, 5) || undefined;
        const m = temp.move({ from, to, promotion });
        if (!m) break;
        sans.push(m.san);
      }
      return sans;
    } catch (e) { return []; }
  }

  function renderMoveDetail(ply) {
    const info = state.perMove[ply];
    if (!info) { dom.moveDetail.hidden = true; return; }

    dom.moveDetail.hidden = false;
    const san = state.sanMoves[ply];
    const moverName = info.mover === "w"
      ? state.games[state.activeGameIdx].white.username
      : state.games[state.activeGameIdx].black.username;

    if (info.classification === "Book") {
      dom.moveDetail.innerHTML = `
        <div class="move-detail__headline c-book">${escapeHtml(san)} \u2014 Book</div>
        <div class="move-detail__row">${escapeHtml(moverName)} \u00b7 known opening theory${state.openingName ? " (" + escapeHtml(state.openingName) + ")" : ""}, not graded against the engine.</div>
      `;
      return;
    }

    let noteLine = "";
    if (info.isOnlyMove) {
      noteLine += `<div class="move-detail__row">This was the only legal move that avoided immediate disaster.</div>`;
    }
    if (info.isBrilliant) {
      noteLine += `<div class="move-detail__row">Gives up material but stays clearly winning \u2014 a sacrifice pattern (heuristic detection, not a full look-ahead).</div>`;
    }

    let bestLine = "";
    if (info.classification !== "Best" && info.classification !== "Brilliant" && info.bestMoveUci) {
      const bestSan = uciPvToSan(state.fens[ply - 1], [info.bestMoveUci], 1)[0] || info.bestMoveUci;
      bestLine = `<div class="move-detail__row">Engine preferred: <span>${escapeHtml(bestSan)}</span></div>`;
    }

    let pvLine = "";
    if (info.pv && info.pv.length > 1) {
      const pvSan = uciPvToSan(state.fens[ply - 1], info.pv, 6);
      if (pvSan.length > 1) {
        pvLine = `<div class="move-detail__row">Engine line: <span>${escapeHtml(pvSan.join(" "))}</span></div>`;
      }
    }

    dom.moveDetail.innerHTML = `
      <div class="move-detail__headline c-${info.classification.toLowerCase()}">${escapeHtml(san)} \u2014 ${info.classification}</div>
      <div class="move-detail__row">${escapeHtml(moverName)} \u00b7 win% dropped by <span>${info.drop.toFixed(1)}</span> \u00b7 move accuracy <span>${info.accuracy.toFixed(1)}%</span></div>
      ${noteLine}
      ${bestLine}
      ${pvLine}
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

  // Mobile: swipe left/right across the board to step through moves.
  (function setupSwipe() {
    let startX = null, startY = null;
    dom.board.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    dom.board.addEventListener("touchend", (e) => {
      if (startX === null) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - startX, dy = endY - startY;
      startX = null; startY = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // not a clean horizontal swipe
      if (!state.chess) return;
      if (dx < 0) goToPly(state.currentPly + 1); // swipe left → next move
      else goToPly(state.currentPly - 1);          // swipe right → previous move
    }, { passive: true });
  })();

  document.addEventListener("keydown", (e) => {
    if (!state.chess) return;
    if (e.key === "ArrowLeft") goToPly(state.currentPly - 1);
    if (e.key === "ArrowRight") goToPly(state.currentPly + 1);
  });

  dom.toggleArrow.addEventListener("change", () => {
    state.showArrow = dom.toggleArrow.checked;
    renderBoard(state.currentPly);
  });

  dom.flipBtn.addEventListener("click", () => {
    state.boardFlipped = !state.boardFlipped;
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
    dom.loadMoreBtn.hidden = true;
    dom.boardEmpty.hidden = false;
    dom.analysis.hidden = true;

    try {
      await initArchives(username);
      const games = await drainMoreGames(10);
      if (games.length === 0) {
        if (state.totalSeenAllTime === 0) {
          throw new Error(`"${username}" has no games in recent months. They may not have played recently.`);
        } else {
          throw new Error(`"${username}" has ${state.totalSeenAllTime} recent game(s), but none are standard chess (they look like variants: Chess960, Crazyhouse, etc., which this tool doesn't support yet).`);
        }
      }
      state.username = username;
      state.games = games;
      renderGameList();
      dom.loadMoreBtn.hidden = !hasMoreGames();
      setStatus(null);
    } catch (err) {
      setStatus(err.message || "Something went wrong.", "error");
      dom.gameList.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || "Couldn't load games.")}</p></div>`;
    } finally {
      dom.submitBtn.disabled = false;
    }
  });

  dom.loadMoreBtn.addEventListener("click", async () => {
    dom.loadMoreBtn.disabled = true;
    dom.loadMoreBtn.textContent = "Loading\u2026";
    try {
      const more = await drainMoreGames(10);
      state.games = state.games.concat(more);
      renderGameList();
    } catch (err) {
      setStatus(err.message || "Couldn't load more games.", "error");
    } finally {
      dom.loadMoreBtn.disabled = false;
      dom.loadMoreBtn.textContent = "Load 10 more";
      dom.loadMoreBtn.hidden = !hasMoreGames();
    }
  });

})();
