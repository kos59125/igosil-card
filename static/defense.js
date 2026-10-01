'use strict';
// ---------------------------------------------------------------------------
// 防御の最適化
//
// 自分は防御側（黒、右上 = A・左下 = B、カードは表示通り）。A・B それぞれ 3 枚を登録しておくと、
// 対局ごとに A から 1 枚・B から 1 枚が独立に等確率で選ばれる（9 通り、各 1/9）。
// 相手（挑戦側、白）は置かれたカードを見て、任意のカードから最善の応手（左上・右下）を選ぶ。
//
// 探索（全探索。ただし有望な組から順に評価する）
//  1. 自分の各カードの勝率 s を 50% とする
//  2. 自分の組（A カード × B カード × 向き）をバッグに入れ、重み s(A) × s(B) とする。
//     向きは「両方反転なし」と「A のみ反転」の 2 通り（両方反転は相手の配置次第で同義、B のみ反転は A のみ反転と同義）
//  3. バッグから重みつきでサンプリングし、相手の応手を全探索して最悪ケースの勝率 V を求める
//  4. s(A) = max(s(A), V)、s(B) = max(s(B), V) としてバッグの重みを更新し、その組をバッグから取り除く
//  5. バッグが空になるまで 3 に戻る（中止すれば評価済みの組で暫定の答えを出す。再実行で続きから）
//
// 3 枚 + 3 枚の選択: A・B それぞれ別カード 3 枚を選び、9 組の V の平均が最大になるものを厳密に求める。
// 3 枚の A を固定すると B は列ごとに独立に選べるので、A の 3 枚組を全列挙すればよい。
// B の向きも選べる: (A^x, B^y) は (A^(x xor y), B) と同義なので、評価済みの値から求まる。
//
// index.html のグローバル（cards, placement, buildPosition, analyze など）を使う。
// ---------------------------------------------------------------------------
(() => {
  const SET_SIZE = 3;            // A・B それぞれ登録する枚数
  const CONCURRENCY = 2;         // 同時に送る解析リクエスト数（KataGo を待たせないため）
  const RATE_KEY = 'defRate';    // 直近の解析速度（局面/秒）。実行前の所要時間の目安に使う
  const INITIAL_SCORE = 0.5;     // カードの勝率の初期値
  const PROVISIONAL_EVERY = 5000; // 暫定の 3 + 3 を計算し直す間隔（ミリ秒）

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
    <div class="row muted">相手の応手は、所持に関係なく全カード・両方の向きを全探索します（防御側と衝突するカード・向きは除外）。
      自分の組は、カードの勝率（最初は 50%、評価した組の最悪ケース勝率で更新）の積で重みづけして、有望な組から順に評価します。</div>
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
    #def-best.provisional { border-style: dashed; }
    #def-best h3 { margin: 0 0 6px; font-size: 14px; }
    .def-matrix td, .def-matrix th { text-align: center; }
    .def-matrix td.cell { cursor: pointer; font-weight: 600; }
    .def-matrix td.cell:hover { outline: 2px solid var(--accent-2); }
    .def-alt { cursor: pointer; } .def-alt:hover { background: var(--bg); } .def-alt.active { background: var(--flash); }`;
  document.head.appendChild(style);

  const st = { run: 0, running: false, cancel: false, result: null, sets: [], shownSet: 0, provisional: false };

  const log = (text, run) => {
    if (run !== undefined && run !== st.run) return;
    const el = $('#def-log');
    el.append(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })}  ${text}\n`);
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
  const stoneSig = (card, key, flip) => JSON.stringify(placedCardStones(card, key, flip).map((s) => [s.c, s.x, s.y]).sort());
  /** 隅 key に置ける候補（カード × 向き）。反転しても同じ局面になるものは 1 つにまとめる */
  function listCandidates(key, { attrs = null, ownedOnly = false, flips = [false, true] } = {}) {
    const slot = CORNERS[key].slot;
    const out = [], seen = new Set();
    for (const c of activeCards()) {
      if (c.slot !== slot || !c.moves.length) continue;
      if (attrs && !attrs.has(c.attr)) continue;
      if (ownedOnly && !isOwned(c)) continue;
      for (const flip of flips) {
        const sig = stoneSig(c, key, flip);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ id: c.id, flip });
      }
    }
    return out;
  }
  /** 自分のカード（隅 key）。sym = 反転しても同じ石の配置になるカード */
  function myCards(key, attrs, ownedOnly) {
    const slot = CORNERS[key].slot;
    return activeCards().filter((c) => c.slot === slot && c.moves.length && attrs.has(c.attr) && (!ownedOnly || isOwned(c)))
      .map((c) => ({ id: c.id, sym: stoneSig(c, key, false) === stoneSig(c, key, true) }));
  }
  function currentCandidates() {
    const attrs = new Set($$('.def-attr').filter((x) => x.checked).map((x) => x.value));
    const ownedOnly = $('#def-owned').checked, flip = $('#def-flip').checked;
    const myA = myCards('TR', attrs, ownedOnly), myB = myCards('BL', attrs, ownedOnly);
    // バッグに入れる組: 両方反転なし / A のみ反転（B は反転なしで固定）
    const items = [];
    for (const a of myA) for (const b of myB) {
      items.push({ a: { id: a.id, flip: false }, b: { id: b.id, flip: false } });
      if (flip && !a.sym) items.push({ a: { id: a.id, flip: true }, b: { id: b.id, flip: false } });
    }
    return { myA, myB, flip, items, oppA: listCandidates('TL'), oppB: listCandidates('BR') };
  }

  function updateEstimate() {
    if (!cards.length) return;
    const { myA, myB, items, oppA, oppB } = currentCandidates();
    const upper = items.length * oppA.length * oppB.length;
    const rate = store.get(RATE_KEY, 0);
    let text = `自分の候補: 右上 (A) ${myA.length} 枚 × 左下 (B) ${myB.length} 枚 → 向き込み ${items.length} 組（両方反転なし・A のみ反転）。` +
      `相手の応手: 左上 ${oppA.length} × 右下 ${oppB.length}。全部評価すると最大 ${upper.toLocaleString()} 局面`;
    if (rate) text += `（直近の速度 ${rate.toFixed(0)} 局面/秒で約 ${fmtSec(upper / rate)}。有望な組から評価するので、途中で中止しても暫定の答えが出ます）`;
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
      // 残りの局面数は、評価済みの組の平均局面数から見積もる
      const avg = s.pairsEvaluated ? s.positionsDone / s.pairsEvaluated : (s.cur?.total || 0);
      const remaining = Math.max(0, (s.cur?.total || 0) - (s.cur?.done || 0)) + avg * Math.max(0, s.items - s.pairsDone - (s.cur ? 1 : 0));
      const parts = [`組 ${s.pairsDone} / ${s.items} 完了`, `局面 ${s.positionsDone.toLocaleString()} 評価`, `経過 ${fmtSec(el)}`];
      if (rate) parts.push(`${rate.toFixed(1)} 局面/秒`, `全部終わるまで約 ${fmtSec(remaining / rate)}`);
      else parts.push('最初の結果を待っています…');
      let text = parts.join('｜');
      if (s.cur) text += `\n評価中: 右上 ${cardTxt(s.cur.item.a)} / 左下 ${cardTxt(s.cur.item.b)}（重み ${pct(s.cur.weight)}、${s.cur.done.toLocaleString()} / ${s.cur.total.toLocaleString()}）`;
      if (s.best) text += `\n最良の組 ${pct(s.best.v)}  右上 ${cardTxt(s.best.a)} / 左下 ${cardTxt(s.best.b)}`;
      $('#def-live').textContent = text;
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
   * M[r][c] = 組 (A 候補 r, B 候補 c) の V（null は未評価・評価できない組）。
   * A から別カード 3 つ、B から別カード 3 つを選び、9 マスの合計が最大の組み合わせを上位 topN 件返す。
   */
  function bestSets(rowsA, colsB, M, topN = 10) {
    const nA = rowsA.length, nB = colsB.length;
    // 列（B の候補）→ カード番号。同じカードの向き違いは同じ番号
    const cardIndex = new Map();
    const colCard = Int32Array.from(colsB, (p) => { if (!cardIndex.has(p.id)) cardIndex.set(p.id, cardIndex.size); return cardIndex.get(p.id); });
    const nCards = cardIndex.size;
    const bestVal = new Float64Array(nCards), bestCol = new Int32Array(nCards);
    const top = [];
    for (let r1 = 0; r1 < nA; r1++) for (let r2 = r1 + 1; r2 < nA; r2++) {
      if (rowsA[r2].id === rowsA[r1].id) continue;
      for (let r3 = r2 + 1; r3 < nA; r3++) {
        if (rowsA[r3].id === rowsA[r1].id || rowsA[r3].id === rowsA[r2].id) continue;
        // 3 枚の A を固定すると、B は列ごとに独立 → カードごとに良いほうの向きを取り、上位 3 カード
        bestVal.fill(-Infinity);
        for (let c = 0; c < nB; c++) {
          const a = M[r1][c], b = M[r2][c], d = M[r3][c];
          const v = a == null || b == null || d == null ? -Infinity : a + b + d;
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

  /**
   * 評価済みの組（cells: "aId|aFlip|bId" → cell、B は反転なし）から、選択用の行列を作る。
   * 行 = A のカード × 向き、列 = B のカード × 向き。(A^x, B^y) は (A^(x xor y), B) と同義として値を引く。
   */
  function buildMatrix(cand, cells) {
    const flips = cand.flip ? [false, true] : [false];
    const rowsA = cand.myA.flatMap((a) => (a.sym ? [false] : flips).map((flip) => ({ id: a.id, flip, sym: a.sym })));
    const colsB = cand.myB.flatMap((b) => (b.sym ? [false] : flips).map((flip) => ({ id: b.id, flip, sym: b.sym })));
    const lookup = (a, b) => {
      const e = a.sym ? false : (a.flip !== (b.sym ? false : b.flip));
      return cells.get(`${a.id}|${e ? 1 : 0}|${b.id}`) || null;
    };
    const M = rowsA.map((a) => colsB.map((b) => lookup(a, b)?.v ?? null));
    return { rowsA, colsB, M, lookup };
  }

  function renderBest() {
    const box = $('#def-best');
    const r = st.result;
    if (!r) { box.innerHTML = ''; return; }
    box.classList.toggle('provisional', st.provisional);
    const sets = st.sets;
    if (!sets.length) {
      box.innerHTML = st.provisional
        ? '<div class="muted">暫定の答え: まだ A・B それぞれ 3 枚の組がそろっていません（評価が進むと表示されます）。</div>'
        : `<div class="badc">A・B それぞれ ${SET_SIZE} 枚（別のカード）を選べる組み合わせがありませんでした。候補を増やしてください。</div>`;
      return;
    }
    const { rowsA, colsB, M, lookup } = r;
    const set = sets[st.shownSet] || sets[0];
    const head = set.cols.map((c) => `<th>${cardHtml(colsB[c])}</th>`).join('');
    const body = set.rows.map((ri) => `<tr><th style="text-align:left">${cardHtml(rowsA[ri])}</th>${set.cols.map((ci) => {
      const cell = lookup(rowsA[ri], colsB[ci]);
      const same = cell && (cell.a.flip !== rowsA[ri].flip || cell.b.flip !== colsB[ci].flip);
      const title = cell?.resp ? `相手の最善応手: 左上 ${cardTxt(cell.resp.TL)} / 右下 ${cardTxt(cell.resp.BR)}` +
        (same ? `\n（同義の向き 右上 ${cardTxt(cell.a)} / 左下 ${cardTxt(cell.b)} で評価）` : '') : '';
      return `<td class="cell" data-r="${ri}" data-c="${ci}" title="${esc(title)}">${pct(M[ri][ci])}</td>`;
    }).join('')}</tr>`).join('');
    const alts = sets.map((s, i) => `<tr class="def-alt${s === set ? ' active' : ''}" data-i="${i}"><td>${i + 1}</td><td><b>${pct(s.ev)}</b></td>
      <td>${s.rows.map((ri) => esc(cardById(rowsA[ri].id).name) + (rowsA[ri].flip ? '（反転）' : '')).join('、')}</td>
      <td>${s.cols.map((ci) => esc(cardById(colsB[ci].id).name) + (colsB[ci].flip ? '（反転）' : '')).join('、')}</td></tr>`).join('');
    const title = st.provisional ? `暫定の最適な防御（評価済みの ${r.evaluated} / ${r.items} 組から）` : (st.shownSet === 0 ? '最適な防御' : `${st.shownSet + 1} 位の防御`);
    box.innerHTML = `
      <h3>${title}: 期待勝率（黒） ${pct(set.ev)}</h3>
      <div class="muted">行 = 右上 (A) に登録する 3 枚、列 = 左下 (B) に登録する 3 枚。各マスは、その組が選ばれたときに相手が最善の応手をした場合の黒の勝率（各 1/9）。マスをクリックすると盤面に反映します。</div>
      <table class="def-matrix" style="margin-top:6px"><thead><tr><th>右上 (A) ＼ 左下 (B)</th>${head}</tr></thead><tbody>${body}</tbody></table>
      <details style="margin-top:8px"><summary class="muted">上位 ${sets.length} 件の組み合わせ（クリックで表示）</summary>
        <table><thead><tr><th>#</th><th>期待勝率</th><th>右上 (A)</th><th>左下 (B)</th></tr></thead><tbody>${alts}</tbody></table></details>`;
    $$('#def-best td.cell').forEach((td) => (td.onclick = () => {
      const cell = lookup(rowsA[+td.dataset.r], colsB[+td.dataset.c]);
      if (cell) applyCell(cell);  // 同義の向きのときは、評価した向きで盤面に反映する
    }));
    $$('#def-best .def-alt').forEach((tr) => (tr.onclick = () => { st.shownSet = +tr.dataset.i; renderBest(); }));
  }

  /** 評価済みの組から 3 + 3 を選んで表示する */
  function computeSets(cand, cells, { provisional, items }) {
    const t = performance.now();
    const m = buildMatrix(cand, cells);
    st.result = { ...m, evaluated: cells.size, items };
    st.sets = bestSets(m.rowsA, m.colsB, m.M);
    st.shownSet = 0;
    st.provisional = provisional;
    renderBest();
    return performance.now() - t;
  }

  // ---- キャッシュ（セッション内）。中止した場合も評価済みの組を保存し、再実行で続きから ---------------
  const sig = (p) => { const c = cardById(p.id); return [c.name, c.attr, c.slot, p.flip, c.moves]; };
  function cacheKeyOf(cand) {
    return optCache.key({
      kind: 'defense-v2', engine: { engine: engineInfo.engine, version: engineInfo.version, model: engineInfo.model },
      visits: +$('#visits').value || 1, komi: KOMI, rules: 'japanese',
      items: cand.items.map((it) => [sig(it.a), sig(it.b)]), oppA: cand.oppA.map(sig), oppB: cand.oppB.map(sig),
    });
  }
  const cellKey = (a, b) => `${a.id}|${a.flip ? 1 : 0}|${b.id}`;

  // ---- 本体 -----------------------------------------------------------------
  function clearDefense() {
    st.run++;
    if (st.running) { st.cancel = true; abortAnalyze(); st.running = false; }
    live.stop();
    resetPairs();
    $('#def-log').textContent = '';
    $('#def-context').innerHTML = '';
    st.result = null; st.sets = [];
    $('#def-best').innerHTML = '';
    $('#def-info').textContent = '';
    $('#def-progress').style.width = '0';
    $('#def-run').disabled = false; $('#def-cancel').disabled = true;
  }

  /** 重みつきサンプリング（重み = s(A) × s(B)） */
  function sample(bag, score) {
    let total = 0;
    for (const it of bag) total += score.get(it.a.id) * score.get(it.b.id);
    let x = Math.random() * total;
    for (let i = 0; i < bag.length; i++) {
      x -= score.get(bag[i].a.id) * score.get(bag[i].b.id);
      if (x <= 0) return i;
    }
    return bag.length - 1;
  }

  async function runDefense() {
    const cand = currentCandidates();
    const { myA, myB, items, oppA, oppB } = cand;
    if (myA.length < SET_SIZE || myB.length < SET_SIZE) {
      alert(`自分の候補が足りません（A・B それぞれ ${SET_SIZE} 枚以上必要です）。属性や所持の条件を見直してください。`);
      return;
    }
    await refreshEngineInfo();
    const cacheKey = cacheKeyOf(cand);
    const saved = optCache.get(cacheKey);
    const upper = items.length * oppA.length * oppB.length;
    if (!saved?.complete && upper > 200000) {
      const rate = store.get(RATE_KEY, 0);
      const doneMsg = saved ? `\n前回中止した続き（評価済み ${saved.cells.length} / ${items.length} 組）から再開します。` : '';
      if (!confirm(`全部評価すると最大 ${upper.toLocaleString()} 局面です` + (rate ? `（約 ${fmtSec(upper / rate)}）` : '') +
        '。開始しますか？\n有望な組から順に評価するので、途中で中止しても評価済みの組から暫定の答えを出します。' + doneMsg)) return;
    }
    clearDefense();
    const run = st.run;
    const alive = () => run === st.run;
    const stopped = () => !alive() || st.cancel;
    st.running = true; st.cancel = false;
    $('#def-run').disabled = true; $('#def-cancel').disabled = false;

    const ctxLines = [
      `自分（防御・黒）の候補: 右上 (A) ${myA.length} 枚・左下 (B) ${myB.length} 枚（向き込み ${items.length} 組: 両方反転なし・A のみ反転）`,
      `条件: 属性 ${$$('.def-attr').filter((x) => x.checked).map((x) => x.value).join('・') || 'なし'} / ${$('#def-owned').checked ? '所持カードのみ' : '未所持も含む'} / ${cand.flip ? '向きも探索' : '向きは表示通り'}`,
      `相手（挑戦・白）の応手: 全カード 左上 ${oppA.length} × 右下 ${oppB.length}（向き込み）を全探索`,
      `エンジン: ${engineText()} / ${+$('#visits').value || 1} visits / コミ ${KOMI}（アゲハマで調整）・日本ルール / 選択確率 A・B 独立に各 1/${SET_SIZE}`,
    ];
    $('#def-context').innerHTML = ctxLines.map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : `<div class="muted">${esc(l)}</div>`)).join('');
    log('入力パラメーター', run);
    ctxLines.forEach((l) => log('  ' + l, run));

    // カードの勝率（重み）と評価済みの組
    const score = new Map([...myA, ...myB].map((c) => [c.id, INITIAL_SCORE]));
    const cells = new Map();
    const record = (cell, animate) => {
      cells.set(cellKey(cell.a, cell.b), cell);
      if (cell.v != null) {
        insertPair(cell, animate);
        score.set(cell.a.id, Math.max(score.get(cell.a.id), cell.v));
        score.set(cell.b.id, Math.max(score.get(cell.b.id), cell.v));
      }
    };
    if (saved) {
      for (const c of saved.cells) record(c, false);
      log(saved.complete
        ? `同じ条件の解析結果があるため、キャッシュから表示しました（${saved.savedAt} 解析、${saved.cells.length} 組）`
        : `前回中止した続きから再開します（評価済み ${saved.cells.length} / ${items.length} 組）`, run);
    }
    const bag = items.filter((it) => !cells.has(cellKey(it.a, it.b)));
    const save = (complete) => optCache.set(cacheKey, {
      complete, savedAt: new Date().toLocaleTimeString('ja-JP', { hour12: false }), cells: [...cells.values()],
    });

    const L = { items: items.length, pairsDone: cells.size, pairsEvaluated: 0, positions: 0, positionsDone: 0, best: null, cur: null };
    for (const c of cells.values()) if (c.v != null && (!L.best || c.v > L.best.v)) L.best = c;
    const t0 = performance.now();
    let errors = 0, lastProvisional = performance.now();
    if (bag.length) {
      live.start(L);
      log(`開始: 残り ${bag.length} 組、相手の応手は最大 ${oppA.length * oppB.length} 通り / 組`, run);
    }

    /** 1 組について相手の応手を全探索し、最悪ケース（相手の最善応手）を返す。中止したら null */
    const evalPair = async (item, weight) => {
      const base = { TR: item.a, BL: item.b, TL: null, BR: null };
      let tls = [], brs = [];
      if (!buildPosition(base).conflicts.length) {
        tls = oppA.filter((x) => !buildPosition({ ...base, TL: x }).conflicts.length);
        brs = oppB.filter((x) => !buildPosition({ ...base, BR: x }).conflicts.length);
      }
      const cur = { item, weight, total: tls.length * brs.length, done: 0, best: null };
      L.cur = cur;
      let ji = 0;
      const next = () => {
        const size = Math.max(1, +$('#batch').value || 32);
        const batch = [];
        while (batch.length < size && ji < cur.total) {
          const tl = tls[Math.floor(ji / brs.length)], br = brs[ji % brs.length];
          ji++;
          const pl = { ...base, TL: tl, BR: br };
          const pos = buildPosition(pl);
          if (pos.conflicts.length) { cur.done++; L.positionsDone++; continue; }  // 左上と右下どうしの衝突
          batch.push({ pl, pos });
        }
        return batch;
      };
      const worker = async () => {
        while (!stopped()) {
          const batch = next();
          if (!batch.length) return;
          try {
            await analyze(batch.map((j) => j.pos), (i, r) => {
              if (!alive()) return;
              cur.done++; L.positionsDone++;
              if (r.error) { errors++; return; }
              L.positions++;
              if (!cur.best || r.winrateWhite > cur.best.w) cur.best = { w: r.winrateWhite, lead: r.scoreLeadWhite, TL: batch[i].pl.TL, BR: batch[i].pl.BR };
            }, { abortable: true });
          } catch (e) {
            if (e.name === 'AbortError') return;
            throw e;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (stopped() && cur.done < cur.total) return null;
      const b = cur.best;
      return { a: item.a, b: item.b, v: b ? 1 - b.w : null, lead: b ? -b.lead : null, resp: b ? { TL: b.TL, BR: b.BR } : null };
    };

    try {
      while (bag.length && !stopped()) {
        const i = sample(bag, score);
        const item = bag[i];
        const weight = score.get(item.a.id) * score.get(item.b.id);
        const cell = await evalPair(item, weight);
        if (!cell) break;
        bag.splice(i, 1);
        L.pairsDone++; L.pairsEvaluated++; L.cur = null;
        record(cell, true);
        if (cell.v != null && (!L.best || cell.v > L.best.v)) L.best = cell;
        log(`組 ${L.pairsDone}/${L.items}: 右上 ${cardTxt(item.a)} / 左下 ${cardTxt(item.b)} → ${pct(cell.v)}（重み ${pct(weight)}）` +
          (cell.resp ? ` 相手の最善応手 左上 ${cardTxt(cell.resp.TL)} / 右下 ${cardTxt(cell.resp.BR)}` : ''), run);
        if (L.pairsEvaluated % 10 === 0) save(false);
        if (performance.now() - lastProvisional > PROVISIONAL_EVERY) {
          lastProvisional = performance.now();
          computeSets(cand, cells, { provisional: true, items: items.length });
        }
      }
      if (!alive()) return;
      live.stop();
      const sec = (performance.now() - t0) / 1000;
      if (L.positions && sec > 1) store.set(RATE_KEY, L.positions / sec);
      const complete = !bag.length;
      if (L.pairsEvaluated) save(complete && !errors);
      const elapsed = fmtSec(sec);
      $('#def-info').textContent = `${complete ? '' : '中止: '}${L.pairsDone} / ${L.items} 組${L.pairsEvaluated ? `（今回 ${L.positionsDone.toLocaleString()} 局面、${elapsed}）` : '（キャッシュ）'}`;
      if (L.pairsEvaluated) log(`${complete ? '完了' : '中止'}: ${L.pairsDone} / ${L.items} 組、今回 ${L.positionsDone.toLocaleString()} 局面、${elapsed}${errors ? `、エラー ${errors} 件` : ''}`, run);
      if (!complete) log('同じ条件で再実行すると、続きから評価します。', run);
      $('#def-progress').style.width = (100 * L.pairsDone / L.items) + '%';
      $('#def-pairs-summary').textContent = `各組の評価（相手の最善応手に対する黒の勝率、${cells.size} / ${L.items} 組）`;
      const ms = computeSets(cand, cells, { provisional: !complete, items: items.length });
      log(`組み合わせの選択: 評価済みの ${cells.size} 組から A・B 3 枚ずつを厳密に探索（${fmtSec(ms / 1000)}）`, run);
      if (st.sets.length) {
        const s = st.sets[0], { rowsA, colsB } = st.result;
        log(`${complete ? '最適な防御' : '暫定の最適な防御'}: 期待勝率 ${pct(s.ev)}`, run);
        log(`  右上 (A): ${s.rows.map((ri) => cardTxt(rowsA[ri])).join('、')}`, run);
        log(`  左下 (B): ${s.cols.map((ci) => cardTxt(colsB[ci])).join('、')}`, run);
      }
    } catch (e) {
      if (!alive()) return;
      live.stop();
      $('#def-info').textContent = 'エラー: ' + e.message;
      log('エラー: ' + e.message, run);
      if (L.pairsEvaluated) save(false);
    } finally {
      if (alive()) { st.running = false; $('#def-run').disabled = false; $('#def-cancel').disabled = true; }
    }
  }

  window.defense = { bestSets, buildMatrix, clear: clearDefense };  // テスト・デバッグ用
  $('#def-run').onclick = () => runDefense();
  $('#def-cancel').onclick = () => { st.cancel = true; abortAnalyze(); };
})();
