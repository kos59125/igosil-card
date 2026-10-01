'use strict';
// ---------------------------------------------------------------------------
// 防御の最適化
//
// 自分は防御側（黒、右上 = A・左下 = B、カードは表示通り）。A・B それぞれ 3 枚を登録しておくと、
// 対局ごとに A から 1 枚・B から 1 枚が独立に等確率で選ばれる（9 通り、各 1/9）。
// 相手（挑戦側、白）は置かれたカードを見て、任意のカードから最善の応手（左上・右下）を選ぶ。
//
//  1. 自分の候補の組 (a, b) ごとに相手の応手を全探索し、V(a, b) = 相手の最善応手に対する黒の勝率 を求める
//  2. A から 3 枚・B から 3 枚（それぞれ別のカード）を選び、9 通りの V の平均（期待勝率）が最大になる組み合わせを求める
//     3 枚の A を固定すると B の選び方は列ごとに独立なので、A の 3 枚組を全列挙すれば厳密に最大化できる
//
// index.html のグローバル（cards, placement, buildPosition, analyze など）を使う。
// ---------------------------------------------------------------------------
(() => {
  const SET_SIZE = 3;          // A・B それぞれ登録する枚数
  const CONCURRENCY = 2;       // 同時に送る解析リクエスト数（KataGo を待たせないため）
  const RATE_KEY = 'defRate';  // 直近の解析速度（局面/秒）。実行前の所要時間の目安に使う

  // ---- UI -----------------------------------------------------------------
  $('#tab-def').innerHTML = `
    <div class="row muted">自分は防御側（黒）です。右上 (A)・左下 (B) に登録する 3 枚ずつのうち、対局ごとに 1 枚ずつがランダムに選ばれます。
      相手（白）が任意のカードで最善の応手をするとして、自分の期待勝率が最大になる 3 枚 + 3 枚を探します。</div>
    <div class="row chips"><b style="font-size:12px">自分の候補の属性:</b>
      <label><input type="checkbox" class="def-attr" value="地" checked> <span class="attr 地">地</span></label>
      <label><input type="checkbox" class="def-attr" value="宙" checked> <span class="attr 宙">宙</span></label>
      <label><input type="checkbox" class="def-attr" value="海" checked> <span class="attr 海">海</span></label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="def-owned" checked> 自分の候補は所持カードのみ</label>
      <label><input type="checkbox" id="def-flip" checked> 自分のカードの向き（反転）も探索</label>
    </div>
    <div class="row muted">相手の応手は、所持に関係なく全カード・両方の向きを全探索します（防御側と衝突するカード・向きは除外）。</div>
    <div class="row muted" id="def-estimate"></div>
    <div class="row">
      <button id="def-run" class="primary">最適な防御を探す</button>
      <button id="def-cancel" disabled>中止</button>
      <span class="muted" id="def-info"></span>
    </div>
    <div class="progress"><div id="def-progress"></div></div>
    <div class="msg" id="def-live" style="font-weight:600"></div>
    <details open style="margin-top:6px"><summary class="muted">評価ログ</summary>
      <div class="msg" id="def-log" style="font-family:ui-monospace,Consolas,monospace;max-height:180px"></div></details>
    <div id="def-context"></div>
    <div id="def-best"></div>
    <details id="def-pairs-wrap" style="margin-top:8px" open><summary class="muted" id="def-pairs-summary">各組の評価（相手の最善応手に対する黒の勝率）</summary>
      <div class="scroll"><table id="def-pairs"><thead><tr><th>#</th><th>黒勝率</th><th>右上 (A)</th><th>左下 (B)</th><th>相手の最善応手（左上 / 右下）</th></tr></thead><tbody></tbody></table></div>
      <div class="muted">行をクリックすると、その組と相手の最善応手を盤面に反映します。</div>
    </details>`;
  const style = document.createElement('style');
  style.textContent = `
    #def-context { font-size: 12px; margin-top: 8px; padding: 6px 8px; border-left: 3px solid var(--accent-2); background: var(--bg); border-radius: 0 6px 6px 0; }
    #def-context:empty, #def-best:empty { display: none; }
    #def-best { margin-top: 10px; padding: 10px; border: 1px solid var(--accent-2); border-radius: 8px; }
    #def-best h3 { margin: 0 0 6px; font-size: 14px; }
    .def-matrix td, .def-matrix th { text-align: center; }
    .def-matrix td.cell { cursor: pointer; font-weight: 600; }
    .def-matrix td.cell:hover { outline: 2px solid var(--accent-2); }
    .def-alt { cursor: pointer; } .def-alt:hover { background: var(--bg); } .def-alt.active { background: var(--flash); }`;
  document.head.appendChild(style);

  const st = { run: 0, running: false, cancel: false, matrix: null, sets: [], shownSet: 0 };

  const log = (text, run) => {
    if (run !== undefined && run !== st.run) return;
    const el = $('#def-log');
    el.textContent += `${new Date().toLocaleTimeString('ja-JP', { hour12: false })}  ${text}\n`;
    el.scrollTop = el.scrollHeight;
  };
  const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  const cardTxt = (p) => {
    if (!p) return '（なし）';
    const c = cardById(p.id);
    return `${c.name} [${c.attr || '?'}・${groupShort(c)}]${p.flip ? '（反転）' : ''}`;
  };
  const cardHtml = (p) => {
    if (!p) return '<span class="muted">（なし）</span>';
    const c = cardById(p.id);
    return `<span class="attr ${c.attr}">${c.attr}</span> <span class="muted">${esc(groupShort(c))}</span> ${esc(c.name)}${p.flip ? ' <b>(反転)</b>' : ''}`;
  };

  // ---- 候補 -----------------------------------------------------------------
  /** 隅 key に置ける候補（カード × 向き）。反転しても同じ局面になるものは 1 つにまとめる */
  function listCandidates(key, { attrs = null, ownedOnly = false, flips = [false, true] } = {}) {
    const slot = CORNERS[key].slot;
    const out = [], seen = new Set();
    for (const c of activeCards()) {
      if (c.slot !== slot || !c.moves.length) continue;
      if (attrs && !attrs.has(c.attr)) continue;
      if (ownedOnly && !isOwned(c)) continue;
      for (const flip of flips) {
        const sig = JSON.stringify(placedCardStones(c, key, flip).map((s) => [s.c, s.x, s.y]).sort());
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ id: c.id, flip });
      }
    }
    return out;
  }
  function currentCandidates() {
    const attrs = new Set($$('.def-attr').filter((x) => x.checked).map((x) => x.value));
    const mineOpts = { attrs, ownedOnly: $('#def-owned').checked, flips: $('#def-flip').checked ? [false, true] : [false] };
    return {
      mineA: listCandidates('TR', mineOpts), mineB: listCandidates('BL', mineOpts),
      oppA: listCandidates('TL'), oppB: listCandidates('BR'),
    };
  }
  const distinctCards = (list) => new Set(list.map((p) => p.id)).size;

  function updateEstimate() {
    if (!cards.length) return;
    const { mineA, mineB, oppA, oppB } = currentCandidates();
    const pairs = mineA.length * mineB.length, upper = pairs * oppA.length * oppB.length;
    const rate = store.get(RATE_KEY, 0);
    let text = `自分の候補: 右上 (A) ${distinctCards(mineA)} 枚（向き込み ${mineA.length}）× 左下 (B) ${distinctCards(mineB)} 枚（${mineB.length}）= ${pairs} 組。` +
      `相手の応手: 左上 ${oppA.length} × 右下 ${oppB.length}。評価する局面は最大 ${upper.toLocaleString()}`;
    if (rate) text += `（直近の速度 ${rate.toFixed(0)} 局面/秒で約 ${fmtSec(upper / rate)}、サーバーのキャッシュ分は速くなります）`;
    $('#def-estimate').textContent = text;
  }
  $$('.def-attr').forEach((x) => x.addEventListener('change', updateEstimate));
  $('#def-owned').addEventListener('change', updateEstimate);
  $('#def-flip').addEventListener('change', updateEstimate);
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'def') updateEstimate(); }));

  // ---- 実行中の経過 ------------------------------------------------------------
  const live = {
    timer: null, s: null,
    // s は実行中に書き換わる状態オブジェクトそのもの（コピーしない）
    start(s) { s.t0 = performance.now(); this.s = s; clearInterval(this.timer); this.timer = setInterval(() => this.render(), 1000); this.render(); },
    stop() { clearInterval(this.timer); this.timer = null; this.s = null; $('#def-live').textContent = ''; },
    render() {
      const s = this.s; if (!s) return;
      const el = (performance.now() - s.t0) / 1000;
      const rate = s.positions && el > 0 ? s.positions / el : 0;
      // 残りの局面数は、準備済みの組の平均局面数から見積もる
      const avg = s.prepared ? s.preparedPositions / s.prepared : 0;
      const remaining = Math.max(0, s.preparedPositions - s.positionsDone) + avg * (s.pairs - s.prepared);
      const parts = [`組 ${s.pairsDone} / ${s.pairs} 完了`, `局面 ${s.positionsDone.toLocaleString()} 評価`, `経過 ${fmtSec(el)}`];
      if (rate) parts.push(`${rate.toFixed(1)} 局面/秒`, `残り約 ${fmtSec(remaining / rate)}`);
      else parts.push('最初の結果を待っています…');
      let text = parts.join('｜');
      if (s.best) text += `\n暫定最良の組 ${pct(s.best.v)}  右上 ${cardTxt(s.best.a)} / 左下 ${cardTxt(s.best.b)}`;
      $('#def-live').textContent = text;
      // 進捗バーは局面数ベース（組単位だと 1 組が大きいので動きが粗い）
      const totalEst = s.positionsDone + remaining;
      $('#def-progress').style.width = (totalEst ? (100 * s.positionsDone / totalEst) : 0) + '%';
    },
  };

  // ---- 各組の表（ライブ挿入） -----------------------------------------------------
  let pairRows = [];
  const PAIR_LIMIT = 200;
  function resetPairs() { pairRows = []; $('#def-pairs tbody').innerHTML = ''; $('#def-pairs-summary').textContent = '各組の評価（相手の最善応手に対する黒の勝率）'; }
  function pairRow(cell) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.innerHTML = `<td></td><td><b>${pct(cell.v)}</b></td><td>${cardHtml(cell.a)}</td><td>${cardHtml(cell.b)}</td>
      <td>${cell.resp ? `${cardHtml(cell.resp.TL)}<br>${cardHtml(cell.resp.BR)}` : '<span class="muted">応手なし</span>'}</td>`;
    tr._cell = cell;
    return tr;
  }
  function insertPair(cell, animate = true) {
    let lo = 0, hi = pairRows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pairRows[m].v >= cell.v) lo = m + 1; else hi = m; }
    pairRows.splice(lo, 0, cell);
    if (lo >= PAIR_LIMIT) return;
    const tb = $('#def-pairs tbody');
    const tr = pairRow(cell);
    if (animate) { tr.classList.add('row-new'); tr.addEventListener('animationend', () => tr.classList.remove('row-new'), { once: true }); }
    tb.insertBefore(tr, tb.rows[lo] || null);
    if (tb.rows.length > PAIR_LIMIT) tb.deleteRow(-1);
    for (let i = lo; i < tb.rows.length; i++) tb.rows[i].cells[0].textContent = i + 1;
  }
  $('#def-pairs').addEventListener('click', (ev) => { const tr = ev.target.closest('tr'); if (tr?._cell) applyCell(tr._cell); });

  /** 組と相手の最善応手を盤面に反映する */
  function applyCell(cell) {
    placement.TR = cell.a; placement.BL = cell.b;
    placement.TL = cell.resp?.TL || null; placement.BR = cell.resp?.BR || null;
    syncCornerInputs(); onPlacementChange();
    if (!$('#auto-eval').checked) setEval({ winrateWhite: 1 - cell.v, scoreLeadWhite: -cell.lead, visits: +$('#visits').value || 1 });
  }

  // ---- 最適な 3 + 3 の選択 -------------------------------------------------------
  /**
   * M[r][c] = 組 (A 候補 r, B 候補 c) の V（null は評価できない組）。
   * A から別カード 3 つ、B から別カード 3 つを選び、9 マスの合計が最大の組み合わせを上位 topN 件返す。
   */
  function bestSets(mineA, mineB, M, topN = 10) {
    const nA = mineA.length, nB = mineB.length;
    // 列（B の候補）→ カード番号。同じカードの向き違いは同じ番号
    const cardIndex = new Map();
    const colCard = Int32Array.from(mineB, (p) => { if (!cardIndex.has(p.id)) cardIndex.set(p.id, cardIndex.size); return cardIndex.get(p.id); });
    const nCards = cardIndex.size;
    const colSum = new Float64Array(nB);
    const bestVal = new Float64Array(nCards), bestCol = new Int32Array(nCards);
    const top = [];
    for (let r1 = 0; r1 < nA; r1++) for (let r2 = r1 + 1; r2 < nA; r2++) {
      if (mineA[r2].id === mineA[r1].id) continue;
      for (let r3 = r2 + 1; r3 < nA; r3++) {
        if (mineA[r3].id === mineA[r1].id || mineA[r3].id === mineA[r2].id) continue;
        // 3 枚の A を固定すると、B は列ごとに独立 → カードごとに良いほうの向きを取り、上位 3 カード
        bestVal.fill(-Infinity);
        for (let c = 0; c < nB; c++) {
          const a = M[r1][c], b = M[r2][c], d = M[r3][c];
          const v = a == null || b == null || d == null ? -Infinity : a + b + d;
          colSum[c] = v;
          const k = colCard[c];
          if (v > bestVal[k]) { bestVal[k] = v; bestCol[k] = c; }
        }
        let k1 = -1, k2 = -1, k3 = -1;
        for (let k = 0; k < nCards; k++) {
          const v = bestVal[k];
          if (k1 < 0 || v > bestVal[k1]) { k3 = k2; k2 = k1; k1 = k; }
          else if (k2 < 0 || v > bestVal[k2]) { k3 = k2; k2 = k; }
          else if (k3 < 0 || v > bestVal[k3]) { k3 = k; }
        }
        if (k3 < 0) continue;
        const total = bestVal[k1] + bestVal[k2] + bestVal[k3];
        if (!Number.isFinite(total)) continue;
        if (top.length < topN || total > top[top.length - 1].total) {
          top.push({ total, rows: [r1, r2, r3], cols: [bestCol[k1], bestCol[k2], bestCol[k3]] });
          top.sort((x, y) => y.total - x.total);
          if (top.length > topN) top.pop();
        }
      }
    }
    return top.map((t) => ({ ...t, ev: t.total / (SET_SIZE * SET_SIZE) }));
  }

  function renderBest() {
    const { mineA, mineB, M, cellsByKey } = st.matrix;
    const sets = st.sets;
    if (!sets.length) {
      $('#def-best').innerHTML = `<div class="badc">A・B それぞれ ${SET_SIZE} 枚（別のカード）を選べる組み合わせがありませんでした。候補を増やしてください。</div>`;
      return;
    }
    const set = sets[st.shownSet];
    const head = set.cols.map((c) => `<th>${cardHtml(mineB[c])}</th>`).join('');
    const body = set.rows.map((r) => `<tr><th style="text-align:left">${cardHtml(mineA[r])}</th>${set.cols.map((c) => {
      const cell = cellsByKey.get(`${r},${c}`);
      const title = cell?.resp ? `相手の最善応手: 左上 ${cardTxt(cell.resp.TL)} / 右下 ${cardTxt(cell.resp.BR)}` : '';
      return `<td class="cell" data-r="${r}" data-c="${c}" title="${esc(title)}">${pct(M[r][c])}</td>`;
    }).join('')}</tr>`).join('');
    const alts = sets.map((s, i) => `<tr class="def-alt${i === st.shownSet ? ' active' : ''}" data-i="${i}"><td>${i + 1}</td><td><b>${pct(s.ev)}</b></td>
      <td>${s.rows.map((r) => esc(cardById(mineA[r].id).name) + (mineA[r].flip ? '（反転）' : '')).join('、')}</td>
      <td>${s.cols.map((c) => esc(cardById(mineB[c].id).name) + (mineB[c].flip ? '（反転）' : '')).join('、')}</td></tr>`).join('');
    $('#def-best').innerHTML = `
      <h3>${st.shownSet === 0 ? '最適な防御' : `${st.shownSet + 1} 位の防御`}: 期待勝率（黒） ${pct(set.ev)}</h3>
      <div class="muted">行 = 右上 (A) に登録する 3 枚、列 = 左下 (B) に登録する 3 枚。各マスは、その組が選ばれたときに相手が最善の応手をした場合の黒の勝率（各 1/9）。マスをクリックすると盤面に反映します。</div>
      <table class="def-matrix" style="margin-top:6px"><thead><tr><th>右上 (A) ＼ 左下 (B)</th>${head}</tr></thead><tbody>${body}</tbody></table>
      <details style="margin-top:8px"><summary class="muted">上位 ${sets.length} 件の組み合わせ（クリックで表示）</summary>
        <table><thead><tr><th>#</th><th>期待勝率</th><th>右上 (A)</th><th>左下 (B)</th></tr></thead><tbody>${alts}</tbody></table></details>`;
    $$('#def-best td.cell').forEach((td) => (td.onclick = () => applyCell(cellsByKey.get(`${td.dataset.r},${td.dataset.c}`))));
    $$('#def-best .def-alt').forEach((tr) => (tr.onclick = () => { st.shownSet = +tr.dataset.i; renderBest(); }));
  }

  // ---- キャッシュ（セッション内） ---------------------------------------------------
  const sig = (p) => { const c = cardById(p.id); return [c.name, c.attr, c.slot, p.flip, c.moves]; };
  function cacheKeyOf(cands) {
    return optCache.key({
      kind: 'defense', engine: { engine: engineInfo.engine, version: engineInfo.version, model: engineInfo.model },
      visits: +$('#visits').value || 1, komi: KOMI, rules: 'japanese',
      mineA: cands.mineA.map(sig), mineB: cands.mineB.map(sig), oppA: cands.oppA.map(sig), oppB: cands.oppB.map(sig),
    });
  }

  // ---- 本体 -----------------------------------------------------------------
  function clearDefense() {
    st.run++;
    if (st.running) { st.cancel = true; abortAnalyze(); st.running = false; }
    live.stop();
    resetPairs();
    $('#def-log').textContent = '';
    $('#def-context').innerHTML = '';
    $('#def-best').innerHTML = '';
    $('#def-info').textContent = '';
    $('#def-progress').style.width = '0';
    $('#def-run').disabled = false; $('#def-cancel').disabled = true;
  }

  async function runDefense() {
    const cands = currentCandidates();
    const { mineA, mineB, oppA, oppB } = cands;
    if (distinctCards(mineA) < SET_SIZE || distinctCards(mineB) < SET_SIZE) {
      alert(`自分の候補が足りません（A・B それぞれ ${SET_SIZE} 枚以上必要です）。属性や所持の条件を見直してください。`);
      return;
    }
    const upper = mineA.length * mineB.length * oppA.length * oppB.length;
    await refreshEngineInfo();
    const cacheKey = cacheKeyOf(cands);
    const hit = optCache.get(cacheKey);
    if (!hit && upper > 200000) {
      const rate = store.get(RATE_KEY, 0);
      if (!confirm(`評価する局面は最大 ${upper.toLocaleString()} です` + (rate ? `（約 ${fmtSec(upper / rate)}）` : '') + '。開始しますか？\n途中で中止しても、評価済みの局面はサーバーにキャッシュされるので、再実行時はその分速くなります。')) return;
    }
    clearDefense();
    const run = st.run;
    const alive = () => run === st.run;
    st.running = true; st.cancel = false;
    $('#def-run').disabled = true; $('#def-cancel').disabled = false;

    const ctxLines = [
      `自分（防御・黒）の候補: 右上 (A) ${distinctCards(mineA)} 枚・左下 (B) ${distinctCards(mineB)} 枚（向き込み ${mineA.length} × ${mineB.length} = ${mineA.length * mineB.length} 組）`,
      `条件: 属性 ${$$('.def-attr').filter((x) => x.checked).map((x) => x.value).join('・') || 'なし'} / ${$('#def-owned').checked ? '所持カードのみ' : '未所持も含む'} / ${$('#def-flip').checked ? '向きも探索' : '向きは表示通り'}`,
      `相手（挑戦・白）の応手: 全カード 左上 ${oppA.length} × 右下 ${oppB.length}（向き込み）を全探索`,
      `エンジン: ${engineText()} / ${+$('#visits').value || 1} visits / コミ ${KOMI}（アゲハマで調整）・日本ルール / 選択確率 A・B 独立に各 1/${SET_SIZE}`,
    ];
    $('#def-context').innerHTML = ctxLines.map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : `<div class="muted">${esc(l)}</div>`)).join('');
    log('入力パラメーター', run);
    ctxLines.forEach((l) => log('  ' + l, run));

    // M[r][c] = V、cells = 各組の詳細
    const M = mineA.map(() => new Array(mineB.length).fill(null));
    const cellsByKey = new Map();
    const t0 = performance.now();

    if (hit) {
      for (const h of hit.cells) {
        const cell = { r: h.r, c: h.c, a: mineA[h.r], b: mineB[h.c], v: h.v, lead: h.lead, resp: h.resp };
        M[h.r][h.c] = h.v; cellsByKey.set(`${h.r},${h.c}`, cell);
        if (h.v != null) insertPair(cell, false);
      }
      log(`同じ条件の解析結果があるため、キャッシュから表示しました（${hit.savedAt} 解析、所要 ${hit.elapsed}）`, run);
      $('#def-info').textContent = `${hit.cells.length} 組（キャッシュ）`;
      $('#def-progress').style.width = '100%';
      finish(run, mineA, mineB, M, cellsByKey);
      st.running = false; $('#def-run').disabled = false; $('#def-cancel').disabled = true;
      return;
    }

    // 組ごとの状態。相手の応手の候補は組ごとに（防御側と衝突しないものだけに）絞る
    const pairs = [];
    for (let r = 0; r < mineA.length; r++) for (let c = 0; c < mineB.length; c++) pairs.push({ r, c, a: mineA[r], b: mineB[c] });
    const L = { pairs: pairs.length, pairsDone: 0, prepared: 0, preparedPositions: 0, positions: 0, positionsDone: 0, best: null };
    live.start(L);
    log(`開始: ${pairs.length} 組、相手の応手は最大 ${oppA.length * oppB.length} 通り / 組`, run);

    let pi = 0, ji = 0, prep = null;
    const prepare = (p) => {
      const base = { TR: p.a, BL: p.b, TL: null, BR: null };
      const basePos = buildPosition(base);
      if (basePos.conflicts.length) { p.tls = []; p.brs = []; }
      else {
        p.tls = oppA.filter((x) => !buildPosition({ ...base, TL: x }).conflicts.length);
        p.brs = oppB.filter((x) => !buildPosition({ ...base, BR: x }).conflicts.length);
      }
      p.total = p.tls.length * p.brs.length; p.done = 0; p.best = null;
      L.prepared++; L.preparedPositions += p.total;
      if (!p.total) complete(p);
      return p;
    };
    const complete = (p) => {
      const v = p.best ? 1 - p.best.w : null;
      const cell = { r: p.r, c: p.c, a: p.a, b: p.b, v, lead: p.best ? -p.best.lead : null, resp: p.best ? { TL: p.best.TL, BR: p.best.BR } : null };
      M[p.r][p.c] = v; cellsByKey.set(`${p.r},${p.c}`, cell);
      L.pairsDone++;
      if (v != null) {
        insertPair(cell);
        if (!L.best || v > L.best.v) { L.best = cell; log(`暫定最良の組 ${pct(v)}: 右上 ${cardTxt(p.a)} / 左下 ${cardTxt(p.b)}（相手の最善応手 左上 ${cardTxt(cell.resp.TL)} / 右下 ${cardTxt(cell.resp.BR)}）`, run); }
      }
      if (L.pairsDone % Math.max(1, Math.round(L.pairs / 20)) === 0) log(`進捗: ${L.pairsDone} / ${L.pairs} 組、${L.positionsDone.toLocaleString()} 局面`, run);
    };
    const markDone = (p, r, pl) => {
      p.done++; L.positionsDone++;
      if (r && !r.error) {
        L.positions++;
        if (!p.best || r.winrateWhite > p.best.w) p.best = { w: r.winrateWhite, lead: r.scoreLeadWhite, TL: pl.TL, BR: pl.BR };
      }
      if (p.done === p.total) complete(p);
    };
    /** 次のバッチ（組をまたいで詰める） */
    const nextBatch = () => {
      const size = Math.max(1, +$('#batch').value || 32);
      const batch = [];
      while (batch.length < size && pi < pairs.length) {
        if (!prep) prep = prepare(pairs[pi]);
        if (ji >= prep.total) { pi++; ji = 0; prep = null; continue; }
        const tl = prep.tls[Math.floor(ji / prep.brs.length)], br = prep.brs[ji % prep.brs.length];
        ji++;
        const pl = { TR: prep.a, BL: prep.b, TL: tl, BR: br };
        const pos = buildPosition(pl);
        if (pos.conflicts.length) { markDone(prep, null, pl); continue; }  // 左上と右下どうしの衝突
        batch.push({ p: prep, pl, pos });
      }
      return batch;
    };
    let errors = 0;
    const worker = async () => {
      while (alive() && !st.cancel) {
        const batch = nextBatch();
        if (!batch.length) return;
        try {
          await analyze(batch.map((j) => j.pos), (i, r) => {
            if (!alive()) return;
            if (r.error) errors++;
            markDone(batch[i].p, r, batch[i].pl);
          }, { abortable: true });
        } catch (e) {
          if (e.name === 'AbortError') return;
          throw e;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (!alive()) return;
      const sec = (performance.now() - t0) / 1000;
      if (L.positions && sec > 1) store.set(RATE_KEY, L.positions / sec);
      live.stop();
      const elapsed = fmtSec(sec);
      $('#def-info').textContent = `${st.cancel ? '中止: ' : ''}${L.pairsDone} / ${L.pairs} 組、${L.positionsDone.toLocaleString()} 局面（${elapsed}）`;
      log(`${st.cancel ? '中止' : '完了'}: ${L.pairsDone} / ${L.pairs} 組、${L.positionsDone.toLocaleString()} 局面、${elapsed}${errors ? `、エラー ${errors} 件` : ''}`, run);
      $('#def-progress').style.width = (100 * L.pairsDone / L.pairs) + '%';
      if (!st.cancel && !errors) {
        optCache.set(cacheKey, {
          savedAt: new Date().toLocaleTimeString('ja-JP', { hour12: false }), elapsed,
          cells: [...cellsByKey.values()].map((x) => ({ r: x.r, c: x.c, v: x.v, lead: x.lead, resp: x.resp })),
        });
      }
      finish(run, mineA, mineB, M, cellsByKey, st.cancel);
    } catch (e) {
      if (!alive()) return;
      live.stop();
      $('#def-info').textContent = 'エラー: ' + e.message;
      log('エラー: ' + e.message, run);
    } finally {
      if (alive()) { st.running = false; $('#def-run').disabled = false; $('#def-cancel').disabled = true; }
    }
  }

  /** 各組の V から最適な 3 + 3 を求めて表示する */
  function finish(run, mineA, mineB, M, cellsByKey, partial = false) {
    $('#def-pairs-summary').textContent = `各組の評価（相手の最善応手に対する黒の勝率、${cellsByKey.size} 組）`;
    const t = performance.now();
    st.matrix = { mineA, mineB, M, cellsByKey };
    st.sets = bestSets(mineA, mineB, M);
    st.shownSet = 0;
    log(`組み合わせの選択: A ${mineA.length} × B ${mineB.length} から 3 + 3 を厳密に探索（${fmtSec((performance.now() - t) / 1000)}）${partial ? '。中止したため評価済みの組のみで計算' : ''}`, run);
    if (st.sets.length) {
      const s = st.sets[0];
      log(`最適な防御: 期待勝率 ${pct(s.ev)}`, run);
      log(`  右上 (A): ${s.rows.map((r) => cardTxt(mineA[r])).join('、')}`, run);
      log(`  左下 (B): ${s.cols.map((c) => cardTxt(mineB[c])).join('、')}`, run);
    }
    renderBest();
  }

  window.defense = { bestSets, clear: clearDefense };  // テスト・デバッグ用
  $('#def-run').onclick = () => runDefense();
  $('#def-cancel').onclick = () => { st.cancel = true; abortAnalyze(); };
})();
