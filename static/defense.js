'use strict';
// ---------------------------------------------------------------------------
// 防御の最適化
//
// 自分は防御側（黒、右上 = A・左下 = B、カードは表示通り）。A・B それぞれ 3 枚を登録しておくと、
// 対局ごとに A から 1 枚・B から 1 枚が独立に等確率で選ばれる（9 通り、各 1/9）。
// 相手（挑戦側、白）は置かれたカードを見て、任意のカードから最善の応手（左上・右下）を選ぶ。
//
// 探索（有望なものから順に評価し、いつ止めても暫定の答えが出る。続ければ最終的に全探索になる）
//  自分のカードの勝率 s（最初は 50%）と、相手の応手カード（左上・右下の候補 × 向き）の勝率 t（最初は 50%）を持つ。
//  1 局面ごとに
//   1. 自分の組（A × B × 向き）を重み s(A) × s(B) でサンプリング（向きは「両方反転なし」「A のみ反転」の 2 通り）
//   2. その組に対する相手の応手（左上 × 右下）を重み t(左上) × t(右下) でサンプリング（評価済み・衝突するものは引き直し）
//   3. 局面を評価し、組の値 V = これまでの応手の中で最も悪い黒の勝率 を更新（全応手を評価すると正確な最悪ケース）
//   4. s(A), s(B) = min(s, 黒の勝率)（負ける応手が見つかったカードは後回し）
//      t(左上), t(右下) = max(t, 白の勝率)（強い応手を早く見つけるため、相手のカードは最高の結果で評価）
//  重みはカードごとの値の積なので、組み合わせ全体の表（数億通り）は持たずに、各隅を独立にサンプリングできる。
//  評価済みかどうかは、組ごとのビットマップ（約 2 KB）で管理する。
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
    <div class="row"><b style="font-size:12px">探索の種類:</b>
      <label><input type="radio" name="def-mode" value="sets" checked> 6 枚の組み合わせ（A 3 枚 + B 3 枚）</label>
      <label><input type="radio" name="def-mode" value="pair"> 特定のカードと対になる 3 枚</label>
    </div>
    <div class="row"><b style="font-size:12px">評価の方法:</b>
      <label><input type="radio" name="def-eval" value="full" checked> 相手の応手まで探索（正確・時間がかかる）</label>
      <label><input type="radio" name="def-eval" value="quick"> 自分の右上・左下だけで評価（速い）</label>
      <label><input type="radio" name="def-eval" value="two"> 2 段階（速い評価で上位を選んでから、相手の応手まで探索）</label>
    </div>
    <div class="row muted" id="def-two-note">1 段目: 自分の右上・左下だけの局面で全候補を評価し、カードごとの平均勝率（相手側の各カードと組んだときの平均。向きは良いほう）で順位を付けます。
      2 段目: 上位 <input type="number" id="def-top" min="3" max="30" value="6" style="width:4em"> 枚ずつ（固定・基準のカードは別に必ず残す。1 段目の最良の組み合わせのカードも残す）だけで、相手の応手まで探索します。</div>
    <div class="row muted" id="def-quick-note">相手の隅（左上・右下）は空けたまま、自分の右上・左下の 2 枚だけを置いた局面の黒の勝率で組を評価し、同じ方法で採用するカードを選びます（1 組 1 局面）。
      相手の応手は考慮しないので、実際の勝率より高めに出ます。候補のふるい分けや、おおまかな比較に使ってください。</div>
    <div id="def-pair-wrap" class="row">
      <select id="def-anchor-side"><option value="B">左下 (B) のカード</option><option value="A">右上 (A) のカード</option></select>
      <div id="def-anchor-slot" class="picker-slot" style="flex:1;min-width:0"></div>
      <div class="muted" style="flex-basis:100%">選んだカード（種類だけを指定し、向きは解析して決めます）が選ばれたとき、反対側の 3 枚（各 1/3）で期待勝率が最大になる組み合わせを探します。
        下の属性・所持・ランクの条件は反対側の候補に使います。</div>
    </div>
    <div class="row chips"><b style="font-size:12px" id="def-attr-label">自分の候補の属性:</b>
      <label><input type="checkbox" class="def-attr" value="地" checked> <span class="attr 地">地</span></label>
      <label><input type="checkbox" class="def-attr" value="宙" checked> <span class="attr 宙">宙</span></label>
      <label><input type="checkbox" class="def-attr" value="海" checked> <span class="attr 海">海</span></label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="def-owned" checked> 自分の候補は所持カードのみ</label>
      <label class="nw" title="所持カードのうち、設定したランク以上のカードだけを候補にします（ランクはカード一覧で設定）">ランク <select id="def-min-rank"><option value="0">指定なし</option><option value="1">★1 以上</option><option value="2">★2 以上</option><option value="3">★3 以上</option><option value="4">★4 以上</option><option value="5">★5</option></select></label>
      <label><input type="checkbox" id="def-flip" checked> 自分のカードの向き（反転）も探索</label>
    </div>
    <details id="def-fixed-wrap" open style="margin:4px 0"><summary class="muted"><b>固定するカード（任意）</b> <span id="def-fixed-summary"></span></summary>
      <div class="muted">必ず採用するカードの種類を選びます（属性・所持・ランクの条件に関係なく採用）。向き（反転）は固定せず、ほかのカードと一緒に解析して決めます。残りの枚数だけを探索します。</div>
      <div class="def-fixed-grid">
        <span class="muted nw">右上 (A)</span><div class="def-fixed-side" data-side="A"></div>
        <span class="muted nw">左下 (B)</span><div class="def-fixed-side" data-side="B"></div>
      </div>
      <div class="row" style="margin:2px 0"><button id="def-fixed-clear">固定をすべて外す</button></div>
    </details>
    <div class="row muted" id="def-opp-note">相手の応手は、所持に関係なく全カード・両方の向きを全探索します（防御側と衝突するカード・向きは除外）。
      自分の組と相手の応手を、カードの勝率（最初は 50%）の積で重みづけして有望なものから順に評価するので、すぐに暫定の答えが出て、続けるほど正確になります（最後まで続ければ全探索）。</div>
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
    <div id="def-best">
      <h3 id="def-sets-title">採用する 6 枚（右上 A 3 枚 + 左下 B 3 枚）の候補</h3>
      <div class="muted" id="def-sets-note"></div>
      <div class="scroll"><table id="def-sets"><thead><tr><th>#</th><th>期待勝率（黒）</th><th id="def-sets-hA">右上 (A) 3 枚</th><th id="def-sets-hB">左下 (B) 3 枚</th><th id="def-sets-hW">最悪の組<br><span class="muted">応手の評価率</span></th></tr></thead><tbody></tbody></table></div>
      <div id="def-detail"></div>
    </div>
    <details id="def-pairs-wrap" style="margin-top:8px"><summary class="muted" id="def-pairs-summary">参考: 各組の評価（相手の最善応手に対する黒の勝率）</summary>
      <div class="scroll"><table id="def-pairs"><thead><tr><th>#</th><th>黒勝率</th><th>右上 (A)</th><th>左下 (B)</th><th>相手の最善応手（これまで）</th><th>評価済みの応手</th></tr></thead><tbody></tbody></table></div>
      <div class="muted">行をクリックすると、その組と相手の最善応手を盤面に反映します。</div>
    </details>`;
  const style = document.createElement('style');
  style.textContent = `
    .def-fixed-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px; align-items: start; margin: 4px 0; }
    .def-fixed-side { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .def-fixed-slot { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .def-fixed-slot .picker-slot { flex: 1; min-width: 0; }
    @media (max-width: 1500px) { .def-fixed-side { grid-template-columns: minmax(0, 1fr); } }
    .fixed-tag { font-size: 11px; color: #fff; background: var(--accent-2); border-radius: 4px; padding: 0 4px; margin-left: 2px; }
    #def-context { font-size: 12px; margin-top: 8px; padding: 6px 8px; border-left: 3px solid var(--accent-2); background: var(--bg); border-radius: 0 6px 6px 0; }
    #def-context:empty, #def-best.empty { display: none; }
    #def-sets td { vertical-align: top; }
    #def-sets tr.active { background: var(--flash); }
    #def-sets .cards div { white-space: nowrap; }
    #def-detail { margin-top: 10px; }
    #def-best { margin-top: 10px; padding: 10px; border: 1px solid var(--accent-2); border-radius: 8px; }
    #def-best.provisional { border-style: dashed; }
    #def-best h3 { margin: 0 0 6px; font-size: 14px; }
    .def-matrix td, .def-matrix th { text-align: center; }
    .def-matrix td.cell { cursor: pointer; font-weight: 600; }
    .def-matrix td.cell:hover { outline: 2px solid var(--accent-2); }`;
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
    return `${c.name} [${c.attr || '?'}・${groupShort(c)}]${p.flip ? '（反転）' : ''}${p.fixed ? (p.anchor ? '［基準］' : '［固定］') : ''}`;
  };
  const cardHtml = (p) => {
    if (!p) return '<span class="muted">（なし）</span>';
    const c = cardById(p.id);
    return `<span class="attr ${c.attr}">${c.attr}</span> <span class="muted">${esc(groupShort(c))}</span> ${esc(c.name)}${p.flip ? ' <b>(反転)</b>' : ''}${p.fixed ? ` <span class="fixed-tag">${p.anchor ? '基準' : '固定'}</span>` : ''}`;
  };

  // ---- 固定するカード（A・B それぞれ最大 3 枚。向きつき） ---------------------------------
  const FIXED_KEY = 'defFixed';
  const fixed = (() => {
    const v = store.get(FIXED_KEY, null);
    const norm = (list) => [0, 1, 2].map((k) => (list?.[k]?.id ? { id: list[k].id } : null));
    return { A: norm(v?.A), B: norm(v?.B) };
  })();
  const fixedPickers = { A: [], B: [] };
  const fixedList = (side) => fixed[side].filter((f) => f && cardById(f.id) && !cardById(f.id).retired && cardById(f.id).moves.length);
  function saveFixed() {
    store.set(FIXED_KEY, fixed);
    updateEstimate();
  }
  function renderFixed() {
    for (const side of ['A', 'B']) {
      const wrap = $(`.def-fixed-side[data-side="${side}"]`);
      wrap.innerHTML = '';
      fixedPickers[side] = [0, 1, 2].map((k) => {
        const slot = document.createElement('div');
        slot.className = 'def-fixed-slot';
        slot.innerHTML = '<div class="picker-slot"></div>';
        const picker = new CardPicker({
          noneLabel: '（固定しない）',
          getItems: () => {
            // 同じ側のほかの枠で固定しているカードは選べない
            const taken = new Set(fixed[side].filter((f, j) => f && j !== k).map((f) => f.id));
            return activeCards().filter((c) => c.slot === side && c.moves.length).map((c) => {
              const notes = [];
              if (!isOwned(c)) notes.push('未所持');
              if (taken.has(c.id)) notes.push('ほかの枠で固定中');
              return { id: c.id, attr: c.attr || '', group: groupShort(c), groupLabel: groupName(c), name: c.name, rank: rankOf(c.id),
                note: notes.join('・'), disabled: taken.has(c.id) };
            });
          },
          describe: (id) => { const c = cardById(id); return c && { attr: c.attr || '', group: groupShort(c), name: c.name }; },
          onChange: (id) => {
            fixed[side][k] = id ? { id } : null;
            saveFixed();
          },
        });
        picker.value = fixed[side][k]?.id || null;
        slot.querySelector('.picker-slot').appendChild(picker.el);
        wrap.appendChild(slot);
        return picker;
      });
    }
  }

  // ---- 探索の種類と、対になる 3 枚を探すときの基準のカード -----------------------------------
  const MODE_KEY = 'defMode', ANCHOR_KEY = 'defAnchor', EVAL_KEY = 'defEval';
  const evalMode = () => $$('input[name="def-eval"]').find((x) => x.checked)?.value || 'full';  // full / quick / two
  const quickEval = () => evalMode() === 'quick';
  const TOP_KEY = 'defTop';
  const topN = () => Math.max(SET_SIZE, Math.min(30, Math.round(+$('#def-top').value || 6)));
  const anchor = (() => { const v = store.get(ANCHOR_KEY, null); return { side: v?.side === 'A' ? 'A' : 'B', id: v?.id || null }; })();
  const mode = () => ($$('input[name="def-mode"]').find((x) => x.checked)?.value || 'sets');
  const anchorCard = () => { const c = anchor.id && cardById(anchor.id); return c && !c.retired && c.moves.length && c.slot === anchor.side ? { id: c.id } : null; };
  const anchorPicker = new CardPicker({
    noneLabel: '（カードを選ぶ）',
    getItems: () => activeCards().filter((c) => c.slot === anchor.side && c.moves.length).map((c) => ({
      id: c.id, attr: c.attr || '', group: groupShort(c), groupLabel: groupName(c), name: c.name, rank: rankOf(c.id), note: isOwned(c) ? '' : '未所持' })),
    describe: (id) => { const c = cardById(id); return c && { attr: c.attr || '', group: groupShort(c), name: c.name }; },
    onChange: (id) => { anchor.id = id || null; saveAnchor(); },
  });
  $('#def-anchor-slot').appendChild(anchorPicker.el);
  function saveAnchor() {
    store.set(ANCHOR_KEY, anchor);
    if (!st.running) clearDefense();
    updateEstimate();
  }
  function applyMode() {
    const pair = mode() === 'pair';
    $('#def-pair-wrap').style.display = pair ? '' : 'none';
    $('#def-fixed-wrap').style.display = pair ? 'none' : '';
    $('#def-anchor-side').value = anchor.side;
    anchorPicker.value = anchorCard()?.id || null;
    $('#def-attr-label').textContent = pair ? `${anchor.side === 'A' ? '左下 (B)' : '右上 (A)'} の候補の属性:` : '自分の候補の属性:';
    $('#def-run').textContent = pair ? '対になる 3 枚を探す' : '最適な防御を探す';
    $('#def-quick-note').style.display = quickEval() ? '' : 'none';
    $('#def-two-note').style.display = evalMode() === 'two' ? '' : 'none';
    $('#def-opp-note').style.display = quickEval() ? 'none' : '';
  }
  {
    const m = store.get(MODE_KEY, 'sets');
    $$('input[name="def-mode"]').forEach((x) => (x.checked = x.value === m));
  }
  {
    const v = store.get(EVAL_KEY, 'full');
    $$('input[name="def-eval"]').forEach((x) => (x.checked = x.value === v));
    $('#def-top').value = store.get(TOP_KEY, 6);
  }
  $('#def-top').addEventListener('change', () => { $('#def-top').value = topN(); store.set(TOP_KEY, topN()); updateEstimate(); });
  $$('input[name="def-eval"]').forEach((x) => x.addEventListener('change', () => {
    store.set(EVAL_KEY, evalMode());
    applyMode();
    if (!st.running) clearDefense();
    updateEstimate();
  }));
  $$('input[name="def-mode"]').forEach((x) => x.addEventListener('change', () => {
    store.set(MODE_KEY, mode());
    applyMode();
    if (!st.running) clearDefense();
    updateEstimate();
  }));
  $('#def-anchor-side').addEventListener('change', () => {
    anchor.side = $('#def-anchor-side').value === 'A' ? 'A' : 'B';
    if (anchor.id && cardById(anchor.id)?.slot !== anchor.side) anchor.id = null;
    applyMode();
    saveAnchor();
  });

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
  function myCards(key, attrs, ownedOnly, minRank = 0) {
    const slot = CORNERS[key].slot;
    return activeCards().filter((c) => c.slot === slot && c.moves.length && attrs.has(c.attr) && (!ownedOnly || isOwned(c)) &&
        (!minRank || (isOwned(c) && (rankOf(c.id) || 0) >= minRank)))
      .map((c) => ({ id: c.id, sym: stoneSig(c, key, false) === stoneSig(c, key, true) }));
  }
  function currentCandidates() {
    const attrs = new Set($$('.def-attr').filter((x) => x.checked).map((x) => x.value));
    const ownedOnly = $('#def-owned').checked, flip = $('#def-flip').checked, minRank = +$('#def-min-rank').value || 0;
    const isSym = (key, id) => { const c = cardById(id); return stoneSig(c, key, false) === stoneSig(c, key, true); };
    // 対になる 3 枚を探すときは、基準のカードを 1 枚だけの側として固定し、反対側の 3 枚を探す
    const pair = mode() === 'pair', anc = pair ? anchorCard() : null;
    const fixedA = pair ? (anchor.side === 'A' && anc ? [anc] : []) : fixedList('A');
    const fixedB = pair ? (anchor.side === 'B' && anc ? [anc] : []) : fixedList('B');
    const sizeA = pair && anchor.side === 'A' ? 1 : SET_SIZE, sizeB = pair && anchor.side === 'B' ? 1 : SET_SIZE;
    // 自分の候補 = 固定したカード（両方の向き）+ 条件に合うほかのカード（固定で枚数が埋まっていれば追加しない）
    const side = (key, fixedSide, size, anchorSide) => {
      const ids = new Set(fixedSide.map((f) => f.id));
      // 固定したカードは種類だけを固定し、向きは両方を解析する（反転しても同じ形のカードは 1 つ）
      const fixedRows = fixedSide.flatMap((f) => { const sym = isSym(key, f.id); return (sym ? [false] : [false, true]).map((fl) => ({ id: f.id, flip: fl, sym, fixed: true, ...(anchorSide ? { anchor: true } : {}) })); });
      const free = anchorSide || fixedSide.length >= size ? [] : myCards(key, attrs, ownedOnly, minRank).filter((c) => !ids.has(c.id));
      const freeRows = free.flatMap((c) => (c.sym || !flip ? [false] : [false, true]).map((f) => ({ id: c.id, flip: f, sym: c.sym })));
      const cardsInfo = [...fixedSide.map((f) => ({ id: f.id, sym: isSym(key, f.id), fixed: true })), ...free];
      return { rows: [...fixedRows, ...freeRows], cards: cardsInfo };
    };
    const A = side('TR', fixedA, sizeA, pair && anchor.side === 'A'), B = side('BL', fixedB, sizeB, pair && anchor.side === 'B');
    return { myA: A.cards, myB: B.cards, rowsA: A.rows, colsB: B.rows, fixedA, fixedB, flip, items: makeItems(A.rows, B.rows), sizeA, sizeB,
      quick: quickEval(), two: evalMode() === 'two',
      pair: pair ? { side: anchor.side, card: anc } : null,
      oppA: listCandidates('TL'), oppB: listCandidates('BR') };
  }


  /** バッグに入れる組（評価するのは B を反転なしにした形だけ。(A^x, B^y) は (A^(x xor y), B) と同義） */
  function makeItems(rowsA, colsB) {
    const items = [], seen = new Set();
    for (const a of rowsA) for (const b of colsB) {
      const e = a.sym ? false : (a.flip !== (b.sym ? false : b.flip));
      const key = `${a.id}|${e ? 1 : 0}|${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ a: { id: a.id, flip: e }, b: { id: b.id, flip: false } });
    }
    return items;
  }

  function updateEstimate() {
    if (!cards.length) return;
    const { myA, myB, items, oppA, oppB, fixedA, fixedB, pair, quick, two } = currentCandidates();
    const upper = quick ? items.length : items.length * oppA.length * oppB.length;
    const rate = store.get(RATE_KEY, 0);
    const a = fixedA.length, b = fixedB.length;
    if (!pair) $('#def-fixed-summary').textContent = a || b ? `（右上 ${a} 枚・左下 ${b} 枚を固定）` : '';
    if (pair && !pair.card) { $('#def-estimate').textContent = `${pair.side === 'A' ? '右上 (A)' : '左下 (B)'} のカードを選んでください。`; return; }
    const opp = quick ? `自分の 2 隅だけで評価するので、全部で ${upper.toLocaleString()} 局面`
      : `相手の応手: 左上 ${oppA.length} × 右下 ${oppB.length}。全部評価すると最大 ${upper.toLocaleString()} 局面`;
    let text = (pair
      ? `基準: ${pair.side === 'A' ? '右上 (A)' : '左下 (B)'} ${cardTxt(pair.card)}。対になる候補: ${pair.side === 'A' ? `左下 (B) ${myB.length}` : `右上 (A) ${myA.length}`} 枚 → 向き込み ${items.length} 組。`
      : `自分の候補: 右上 (A) ${myA.length} 枚${a ? `（うち固定 ${a}）` : ''} × 左下 (B) ${myB.length} 枚${b ? `（うち固定 ${b}）` : ''} → 向き込み ${items.length} 組。`) + opp;
    if (two) {
      // 2 段目の組の数の目安（向きの数はカードによるので、平均で見積もる）
      const keep = (list) => Math.min(list.length, list.filter((c) => c.fixed).length + topN());
      const nA = keep(myA), nB = keep(myB);
      const items2 = Math.round(items.length * (nA / Math.max(1, myA.length)) * (nB / Math.max(1, myB.length)));
      const upper2 = items2 * oppA.length * oppB.length;
      text = text.replace(/相手の応手: .*$/, '') + `1 段目は自分の 2 隅だけで ${items.length.toLocaleString()} 局面。` +
        `2 段目は右上 ${nA} 枚 × 左下 ${nB} 枚（向き込み約 ${items2.toLocaleString()} 組）に対して相手の応手（左上 ${oppA.length} × 右下 ${oppB.length}）まで探索し、全部で最大約 ${upper2.toLocaleString()} 局面`;
      if (rate) text += `（全探索は直近の速度 ${rate.toFixed(0)} 局面/sで約 ${fmtSec((items.length + upper2) / rate)}。途中で中止しても暫定の答えが出ます）`;
      $('#def-estimate').textContent = text;
      return;
    }
    if (rate) text += quick ? `（直近の速度 ${rate.toFixed(0)} 局面/sで約 ${fmtSec(upper / rate)}）`
      : `（全探索は直近の速度 ${rate.toFixed(0)} 局面/sで約 ${fmtSec(upper / rate)}。有望なものから評価するので、途中で中止しても暫定の答えが出ます）`;
    $('#def-estimate').textContent = text;
  }
  $$('.def-attr').forEach((x) => x.addEventListener('change', updateEstimate));
  $('#def-owned').addEventListener('change', updateEstimate);
  $('#def-min-rank').addEventListener('change', updateEstimate);
  $('#def-flip').addEventListener('change', updateEstimate);
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'def') { renderFixed(); applyMode(); updateEstimate(); } }));

  // ---- 実行中の経過 ------------------------------------------------------------
  const live = {
    timer: null, s: null,
    // s は実行中に書き換わる状態オブジェクトそのもの（コピーしない）
    start(s) { s.t0 = performance.now(); this.s = s; clearInterval(this.timer); this.timer = setInterval(() => this.render(), 1000); this.render(); },
    stop() { clearInterval(this.timer); this.timer = null; this.s = null; $('#def-live').textContent = ''; },
    render() {
      const s = this.s; if (!s) return;
      const el = (performance.now() - s.t0) / 1000;
      const rate = s.evals && el > 0 ? s.evals / el : 0;
      const parts = [`局面 ${s.evals.toLocaleString()} 評価`, `経過 ${fmtSec(el)}`,
        s.quick ? `評価済みの組 ${s.done} / ${s.items}` : `評価済みの組 ${s.touched} / ${s.items}（全応手を評価済み ${s.complete}）`,
        `全体の ${(100 * s.done / s.upper).toFixed(3)}%`];
      if (rate) parts.push(`${rate.toFixed(1)} 局面/s`, `${s.quick ? '' : '全探索の'}完了まで約 ${fmtSec(Math.max(0, s.upper - s.done) / rate)}`);
      else parts.push('最初の結果を待っています…');
      let html = liveHtml(parts);
      if (s.best) html += esc(`\n最良の組 ${vText(s.best)}  右上 ${cardTxt(s.best.a)} / 左下 ${cardTxt(s.best.b)}`);
      $('#def-live').innerHTML = html;
      $('#def-progress').style.width = Math.min(100, 100 * s.done / s.upper) + '%';
    },
  };

  // ---- 各組の表（参考。定期的に描き直す） -----------------------------------------------
  const PAIR_LIMIT = 200;
  /** 値の表示。相手の応手を全部評価していない組は「≤」（これ以上ではない＝上限）を付ける */
  const vText = (cell) => (cell.v == null ? '—' : `${cell.complete ? '' : '≤ '}${pct(cell.v)}`);
  const coverText = (cell) => (cell.total ? `${cell.n.toLocaleString()} / ${cell.total.toLocaleString()}` : '—');
  function resetPairs() { lastPairCells = null; $('#def-pairs tbody').innerHTML = ''; $('#def-pairs-summary').textContent = '参考: 各組の評価（相手の最善応手に対する黒の勝率）'; }
  /** 組と相手の応手の配置に、囲碁シル AI の記録があれば黒の勝率で返す（index.html の igosilOf） */
  const silOf = (cell) => {
    if (!cell?.resp || typeof igosilOf !== 'function') return null;
    const rec = igosilOf({ TR: cell.a, BL: cell.b, TL: cell.resp.TL || null, BR: cell.resp.BR || null });
    return rec ? 1 - rec.wrWhite : null;
  };
  const silHtml = (cell) => { const v = silOf(cell); return v == null ? '' : `<div class="muted" style="color:var(--accent)" title="囲碁シル AI で記録した黒の勝率（相手の最善応手の配置）">シル ${pct(v)}</div>`; };
  let lastPairCells = null;
  function renderPairs(cells) {
    lastPairCells = cells;
    const list = [...cells.values()].filter((c) => c.v != null).sort((x, y) => y.v - x.v).slice(0, PAIR_LIMIT);
    const tb = $('#def-pairs tbody');
    tb.innerHTML = '';
    list.forEach((cell, i) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML = `<td>${i + 1}</td><td><b>${vText(cell)}</b>${silHtml(cell)}</td><td>${cardHtml(cell.a)}</td><td>${cardHtml(cell.b)}</td>
        <td>${cell.resp ? `${cardHtml(cell.resp.TL)}<br>${cardHtml(cell.resp.BR)}` : '<span class="muted">応手なし</span>'}</td>
        <td class="muted">${coverText(cell)}</td>`;
      tr._cell = cell;
      tb.appendChild(tr);
    });
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
   * A から別カード sizeA 枚、B から別カード sizeB 枚（既定は 3 枚ずつ）を選び、マスの合計が最大の組み合わせを上位 topN 件返す。
   */
  function bestSets(rowsA, colsB, M, topN = 10, sizeA = SET_SIZE, sizeB = SET_SIZE) {
    const nB = colsB.length;
    // 固定したカード（fixed: true）は必ず含める。向きはそれぞれ良いほうを選び、残りの枚数だけを選ぶ
    const byCard = (list) => { const m = new Map(); list.forEach((x, i) => { if (!m.has(x.id)) m.set(x.id, []); m.get(x.id).push(i); }); return m; };
    const rowGroups = byCard(rowsA);
    const fixedRowCards = [...rowGroups.entries()].filter(([id]) => rowsA[rowGroups.get(id)[0]].fixed).map(([, idx]) => idx);
    const freeR = rowsA.map((r, i) => (r.fixed ? -1 : i)).filter((i) => i >= 0);
    const needR = sizeA - fixedRowCards.length;
    // 列（B の候補）→ カード番号。同じカードの向き違いは同じ番号。固定したカードは別に数える
    const cardIndex = new Map(), cardFixed = [];
    const colCard = Int32Array.from(colsB, (p) => {
      if (!cardIndex.has(p.id)) { cardIndex.set(p.id, cardIndex.size); cardFixed.push(!!p.fixed); }
      return cardIndex.get(p.id);
    });
    const nCards = cardIndex.size;
    const fixedColCards = cardFixed.map((f, k) => (f ? k : -1)).filter((k) => k >= 0);
    const needC = sizeB - fixedColCards.length;
    if (needR < 0 || needC < 0) return [];
    const bestVal = new Float64Array(nCards), bestCol = new Int32Array(nCards);
    const top = [];
    const evalRows = (rows) => {
      // A の 3 枚（向きつき）を決めると、B は列ごとに独立 → カードごとに良いほうの向きを取る
      bestVal.fill(-Infinity);
      for (let c = 0; c < nB; c++) {
        let v = 0;
        for (const r of rows) { const x = M[r][c]; if (x == null) { v = -Infinity; break; } v += x; }
        const k = colCard[c];
        if (v > bestVal[k]) { bestVal[k] = v; bestCol[k] = c; }
      }
      let total = 0;
      for (const k of fixedColCards) { if (!Number.isFinite(bestVal[k])) return; total += bestVal[k]; }
      const picked = [];
      for (let t = 0; t < needC; t++) {
        let best = -1;
        for (let k = 0; k < nCards; k++) if (!cardFixed[k] && !picked.includes(k) && (best < 0 || bestVal[k] > bestVal[best])) best = k;
        if (best < 0 || !Number.isFinite(bestVal[best])) return;
        picked.push(best);
        total += bestVal[best];
      }
      if (top.length < topN || total > top[top.length - 1].total) {
        top.push({ total, rows: [...rows], cols: [...fixedColCards, ...picked].map((k) => bestCol[k]) });
        top.sort((x, y) => y.total - x.total);
        if (top.length > topN) top.pop();
      }
    };
    // 固定したカードの向きの組み合わせ × 残りの A（別のカード）needR 枚 を列挙
    const chosen = [];
    const recFree = (from) => {
      if (chosen.length === fixedRowCards.length + needR) { evalRows(chosen); return; }
      for (let t = from; t < freeR.length; t++) {
        const r = freeR[t];
        if (chosen.some((q) => rowsA[q].id === rowsA[r].id)) continue;
        chosen.push(r); recFree(t + 1); chosen.pop();
      }
    };
    const recFixed = (k) => {
      if (k === fixedRowCards.length) { recFree(0); return; }
      for (const r of fixedRowCards[k]) { chosen.push(r); recFixed(k + 1); chosen.pop(); }
    };
    recFixed(0);
    return top.map((t) => ({ ...t, ev: t.total / (sizeA * sizeB) }));
  }



  /**
   * 評価済みの組（cells: "aId|aFlip|bId" → cell、B は反転なし）から、選択用の行列を作る。
   * 行 = A のカード × 向き、列 = B のカード × 向き。(A^x, B^y) は (A^(x xor y), B) と同義として値を引く。
   */
  function buildMatrix(cand, cells) {
    const { rowsA, colsB } = cand;  // 固定したカードは指定の向きだけ（fixed: true）
    const lookup = (a, b) => {
      const e = a.sym ? false : (a.flip !== (b.sym ? false : b.flip));
      return cells.get(`${a.id}|${e ? 1 : 0}|${b.id}`) || null;
    };
    const M = rowsA.map((a) => colsB.map((b) => lookup(a, b)?.v ?? null));
    return { rowsA, colsB, M, lookup };
  }

  /** 組み合わせのキー。mirror = すべてのカードの向きを反転したもの（(A^x, B^y) と (A^(1-x), B^(1-y)) は同義なので、同じ値になる） */
  const setKey = (set, rowsA, colsB, mirror = false) => {
    const k = (p) => `${p.id}:${(mirror && !p.sym ? !p.flip : p.flip) ? 1 : 0}`;
    return [...set.rows.map((r) => k(rowsA[r])).sort(), '|', ...set.cols.map((c) => k(colsB[c])).sort()].join(',');
  };
  let shownKeys = new Set();

  /** 6 枚の候補の表（主な出力）。新しく上位に入った組み合わせは強調表示する */
  function renderBest() {
    const box = $('#def-best');
    const r = st.result;
    box.classList.toggle('empty', !r);
    box.classList.toggle('provisional', !!r && st.provisional);
    if (!r) { $('#def-sets tbody').innerHTML = ''; $('#def-detail').innerHTML = ''; shownKeys = new Set(); return; }
    const { rowsA, colsB, M, pair, quick } = r;
    const sets = st.sets;
    const sofar = st.provisional ? `（暫定: 評価済みの ${r.evaluated} / ${r.items} 組から${r.complete != null ? `、全応手を評価済み ${r.complete} 組` : ''}）` : '';
    const other = pair && (pair.side === 'A' ? '左下 (B)' : '右上 (A)');
    $('#def-sets-hA').textContent = pair?.side === 'A' ? '右上 (A) 基準' : '右上 (A) 3 枚';
    $('#def-sets-hB').textContent = pair?.side === 'B' ? '左下 (B) 基準' : '左下 (B) 3 枚';
    $('#def-sets-hW').innerHTML = quick ? '最悪の組' : '最悪の組<br><span class="muted">応手の評価率</span>';
    $('#def-sets-title').textContent = (pair
      ? `「${cardById(pair.card.id).name}」と対になる ${other} 3 枚の候補${sofar}`
      : (st.provisional ? `採用する 6 枚の候補${sofar}` : '採用する 6 枚（右上 A 3 枚 + 左下 B 3 枚）の候補')) + (quick ? '［自分の 2 隅だけで評価］' : '');
    const le = quick ? '自分の右上・左下だけを置いた局面（相手の隅は空き）の値で、相手の応手は考慮していません。行をクリックすると内訳を表示します。'
      : '「≤」は相手の応手をまだ全部評価していない値（評価が進むと下がることがあります）。行をクリックすると内訳を表示します。';
    const reply = quick ? '' : 'で相手が最善の応手をしたとき';
    $('#def-sets-note').textContent = sets.length
      ? (pair ? `期待勝率 = 基準のカードが選ばれたとき、${other} の 3 枚（各 1/3）それぞれ${reply}の黒の勝率の平均。` + le
        : `期待勝率 = 9 通りの組（A・B から 1 枚ずつ、各 1/9）それぞれ${reply}の黒の勝率の平均。` + le)
      : (st.provisional ? (pair ? `まだ ${other} の 3 枚の組がそろっていません（評価が進むと表示されます）。` : 'まだ A・B それぞれ 3 枚の組がそろっていません（評価が進むと表示されます）。')
        : (pair ? `${other} に ${SET_SIZE} 枚（別のカード）を選べる組み合わせがありませんでした。候補を増やしてください。`
          : `A・B それぞれ ${SET_SIZE} 枚（別のカード）を選べる組み合わせがありませんでした。候補を増やしてください。`));
    const keys = new Set();
    const tb = $('#def-sets tbody');
    tb.innerHTML = '';
    sets.forEach((set, i) => {
      const key = setKey(set, rowsA, colsB);
      keys.add(key);
      let worst = Infinity, complete = true, cover = Infinity;
      for (const ri of set.rows) for (const ci of set.cols) {
        worst = Math.min(worst, M[ri][ci]);
        const cell = r.lookup(rowsA[ri], colsB[ci]);
        if (!cell?.complete) complete = false;
        cover = Math.min(cover, cell?.complete ? 1 : (cell?.total ? cell.n / cell.total : 0));
      }
      const le = complete ? '' : '≤ ';
      const tr = document.createElement('tr');
      tr.className = 'clickable' + (i === st.shownSet ? ' active' : '');
      tr.innerHTML = `<td>${i + 1}</td><td><b>${le}${pct(set.ev)}</b></td>
        <td class="cards">${set.rows.map((ri) => `<div>${cardHtml(rowsA[ri])}</div>`).join('')}</td>
        <td class="cards">${set.cols.map((ci) => `<div>${cardHtml(colsB[ci])}</div>`).join('')}</td>
        <td style="white-space:nowrap">${le}${pct(worst)}${quick ? '' : `<div class="muted">${complete ? '100%' : `最低 ${(100 * cover).toFixed(cover < 0.01 ? 2 : 1)}%`}</div>`}</td>`;
      if (!shownKeys.has(key)) { tr.classList.add('row-new'); tr.addEventListener('animationend', () => tr.classList.remove('row-new'), { once: true }); }
      tr.onclick = () => { st.shownSet = i; renderBest(); };
      tb.appendChild(tr);
    });
    shownKeys = keys;
    renderDetail();
  }

  /** 選んだ 6 枚の内訳（3 × 3 の各組と相手の最善応手） */
  function renderDetail() {
    const { rowsA, colsB, M, lookup } = st.result;
    const set = st.sets[st.shownSet];
    if (!set) { $('#def-detail').innerHTML = ''; return; }
    const head = set.cols.map((c) => `<th>${cardHtml(colsB[c])}</th>`).join('');
    const body = set.rows.map((ri) => `<tr><th style="text-align:left">${cardHtml(rowsA[ri])}</th>${set.cols.map((ci) => {
      const cell = lookup(rowsA[ri], colsB[ci]);
      const same = cell && (cell.a.flip !== rowsA[ri].flip || cell.b.flip !== colsB[ci].flip);
      const title = cell?.resp ? `相手の最善応手: 左上 ${cardTxt(cell.resp.TL)} / 右下 ${cardTxt(cell.resp.BR)}` +
        (same ? `\n（同義の向き 右上 ${cardTxt(cell.a)} / 左下 ${cardTxt(cell.b)} で評価）` : '') : '';
      return `<td class="cell" data-r="${ri}" data-c="${ci}" title="${esc(title)}">${cell ? vText(cell) : '—'}<div class="muted" style="font-weight:normal">${cell && !cell.complete ? coverText(cell) : ''}</div>${silHtml(cell)}</td>`;
    }).join('')}</tr>`).join('');
    $('#def-detail').innerHTML = `
      <div class="muted">${st.shownSet + 1} 位の内訳: 行 = 右上 (A)、列 = 左下 (B)。${st.result.quick
        ? '各マスはその組の 2 枚だけを置いた局面（相手の隅は空き）の黒の勝率。クリックすると盤面に反映します。'
        : `各マスはその組が選ばれたときの黒の勝率（相手が最善の応手をした場合）。
        マスにカーソルを合わせると相手の最善応手、クリックすると盤面に反映します。`}</div>
      <table class="def-matrix" style="margin-top:6px"><thead><tr><th>右上 (A) ＼ 左下 (B)</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
    $$('#def-detail td.cell').forEach((td) => (td.onclick = () => {
      const cell = lookup(rowsA[+td.dataset.r], colsB[+td.dataset.c]);
      if (cell) applyCell(cell);  // 同義の向きのときは、評価した向きで盤面に反映する
    }));
  }

  /** 評価済みの組から 3 + 3 を選んで表示する */
  function computeSets(cand, cells, { provisional, items }) {
    const t = performance.now();
    const m = buildMatrix(cand, cells);
    // 内訳を表示中の組み合わせは、順位が変わっても選んだままにする
    const prev = st.result && st.sets[st.shownSet] ? setKey(st.sets[st.shownSet], st.result.rowsA, st.result.colsB) : null;
    st.result = { ...m, pair: cand.pair, quick: cand.quick, evaluated: cells.size, items, complete: [...cells.values()].filter((c) => c.complete).length };
    // 全部を反転しただけの組み合わせは同じ値になるので、一覧には先に出たほうだけを載せる
    const seen = new Set();
    st.sets = bestSets(m.rowsA, m.colsB, m.M, 40, cand.sizeA, cand.sizeB).filter((x) => {
      const k = setKey(x, m.rowsA, m.colsB);
      if (seen.has(k)) return false;
      seen.add(k); seen.add(setKey(x, m.rowsA, m.colsB, true));
      return true;
    }).slice(0, 20);
    st.shownSet = Math.max(0, prev ? st.sets.findIndex((x) => setKey(x, m.rowsA, m.colsB) === prev) : 0);
    st.provisional = provisional;
    renderBest();
    return performance.now() - t;
  }

  // ---- キャッシュ（セッション内）。中止した場合も評価済みの組を保存し、再実行で続きから ---------------
  const sig = (p) => { const c = cardById(p.id); return [c.name, c.attr, c.slot, p.flip, c.moves]; };
  function cacheKeyOf(cand) {
    return optCache.key({
      kind: 'defense-v3', engine: { engine: engineInfo.engine, version: engineInfo.version, model: engineInfo.model },
      visits: +$('#visits').value || 1, komi: KOMI, rules: 'japanese',
      items: cand.items.map((it) => [sig(it.a), sig(it.b)]),
      ...(cand.quick ? { quick: true } : { oppA: cand.oppA.map(sig), oppB: cand.oppB.map(sig) }),
    });
  }
  const cellKey = (a, b) => `${a.id}|${a.flip ? 1 : 0}|${b.id}`;

  // ---- 本体 -----------------------------------------------------------------
  function clearDefense({ keepLog = false } = {}) {
    st.run++;
    if (st.running) { st.cancel = true; abortAnalyze(); st.running = false; }
    live.stop();
    resetPairs();
    if (!keepLog) $('#def-log').textContent = '';
    $('#def-context').innerHTML = '';
    st.result = null; st.sets = [];
    renderBest();
    $('#def-info').textContent = '';
    $('#def-progress').style.width = '0';
    $('#def-run').disabled = false; $('#def-cancel').disabled = true;
  }

  /** 重みの累積和と、それを使った重みつきサンプリング */
  function cumulative(n, weightOf) {
    const cum = new Float64Array(n);
    let t = 0;
    for (let i = 0; i < n; i++) { t += weightOf(i); cum[i] = t; }
    return cum;
  }
  function pick(cum) {
    const x = Math.random() * cum[cum.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  async function runDefense() {
    const cand = currentCandidates();
    const { myA, myB, pair } = cand;
    if (pair && !pair.card) { alert(`基準にする${pair.side === 'A' ? '右上 (A)' : '左下 (B)'} のカードを選んでください。`); return; }
    if (pair && (pair.side === 'A' ? myB : myA).length < SET_SIZE) {
      alert(`対になる候補が足りません（${pair.side === 'A' ? '左下 (B)' : '右上 (A)'} に ${SET_SIZE} 枚以上必要です）。属性や所持の条件を見直してください。`);
      return;
    }
    if (!pair && (myA.length < SET_SIZE || myB.length < SET_SIZE)) {
      alert(`自分の候補が足りません（固定したカードと合わせて、A・B それぞれ ${SET_SIZE} 枚以上必要です）。属性や所持の条件を見直してください。`);
      return;
    }
    if (!cand.two) { await runSearch(cand); return; }
    // 2 段階: 1 段目で自分の 2 隅だけを評価して上位のカードを選び、2 段目でそのカードだけ相手の応手まで探索する
    const first = await runSearch({ ...cand, quick: true }, { stage: '1 段目: 自分の右上・左下だけで全候補を評価' });
    if (!first?.all) return;  // 中止・クリア・エラー
    const top = topCards(first.cand, first.cells, topN(), st.sets[0] || null);  // 1 段目の最良の組み合わせは表示中のものを使う
    const run = st.run;
    log(`1 段目の結果から、2 段目の候補を選びました（カードごとの平均勝率の順。固定・基準のカードと、1 段目の最良の組み合わせのカードは必ず残す）`, run);
    for (const [label, list] of [['右上 (A)', top.A], ['左下 (B)', top.B]]) {
      log(`  ${label} ${list.length} 枚: ${list.map((c) => `${cardById(c.id).name}${c.fixed ? (c.anchor ? '［基準］' : '［固定］') : ''}${c.score != null ? ` ${pct(c.score)}` : ''}${c.inBest ? '※' : ''}`).join('、')}`, run);
    }
    if (top.A.some((c) => c.inBest) || top.B.some((c) => c.inBest)) log('  ※ = 1 段目の最良の組み合わせのカード', run);
    const keepA = new Set(top.A.map((c) => c.id)), keepB = new Set(top.B.map((c) => c.id));
    const rowsA = cand.rowsA.filter((r) => keepA.has(r.id)), colsB = cand.colsB.filter((c) => keepB.has(c.id));
    const second = { ...cand, quick: false, two: false, rowsA, colsB, items: makeItems(rowsA, colsB),
      myA: cand.myA.filter((c) => keepA.has(c.id)), myB: cand.myB.filter((c) => keepB.has(c.id)) };
    await runSearch(second, { keepLog: true,
      stage: `2 段目: 1 段目の上位（右上 ${second.myA.length} 枚・左下 ${second.myB.length} 枚）だけで、相手の応手まで探索` });
  }

  /**
   * 1 段目（自分の 2 隅だけの評価）から、2 段目に残すカードを選ぶ。
   * カードの点数 = 相手側の各カードと組んだときの勝率（相手側の向きは良いほう）の平均。自分の向きは良いほう。
   * 固定したカード（基準のカードを含む）と、1 段目の最良の組み合わせのカードは必ず残し、残りを点数の順に n 枚まで足す。
   */
  function topCards(cand, cells, n, best = undefined) {
    const { rowsA, colsB, M } = buildMatrix(cand, cells);
    if (best === undefined) best = bestSets(rowsA, colsB, M, 1, cand.sizeA, cand.sizeB)[0];
    const bestA = new Set(best ? best.rows.map((r) => rowsA[r].id) : []), bestB = new Set(best ? best.cols.map((c) => colsB[c].id) : []);
    // lines[i] = i 番目の候補（向きつき）の、相手側のカードごとの値（相手側の向きは良いほう）の平均
    const score = (n1, n2, other, get) => {
      const groups = new Map();
      other.forEach((x, j) => { if (!groups.has(x.id)) groups.set(x.id, []); groups.get(x.id).push(j); });
      return Array.from({ length: n1 }, (_, i) => {
        let sum = 0, k = 0;
        for (const js of groups.values()) {
          let m = null;
          for (const j of js) { const v = get(i, j); if (v != null && (m == null || v > m)) m = v; }
          if (m != null) { sum += m; k++; }
        }
        return k ? sum / k : null;
      });
    };
    const pickSide = (list, lines, bestIds) => {
      const byId = new Map();
      list.forEach((x, i) => {
        const v = lines[i];
        const cur = byId.get(x.id) || { id: x.id, fixed: !!x.fixed, anchor: !!x.anchor, score: null, inBest: bestIds.has(x.id) };
        if (v != null && (cur.score == null || v > cur.score)) cur.score = v;
        byId.set(x.id, cur);
      });
      const all = [...byId.values()];
      const keep = all.filter((c) => c.fixed || c.inBest);
      const rest = all.filter((c) => !c.fixed && !c.inBest && c.score != null).sort((x, y) => y.score - x.score);
      const free = keep.filter((c) => !c.fixed).length;
      return [...keep, ...rest.slice(0, Math.max(0, n - free))]
        .sort((x, y) => (y.fixed - x.fixed) || ((y.score ?? -1) - (x.score ?? -1)));
    };
    return {
      A: pickSide(rowsA, score(rowsA.length, colsB.length, colsB, (i, j) => M[i][j]), bestA),
      B: pickSide(colsB, score(colsB.length, rowsA.length, rowsA, (i, j) => M[j][i]), bestB),
    };
  }

  /** 候補 cand で 1 回探索する。最後まで（または中止まで）進んだら { all, cells, cand } を返す */
  async function runSearch(cand, { keepLog = false, stage = null } = {}) {
    const { myA, myB, items, oppA, oppB, pair, quick } = cand;
    await refreshEngineInfo();
    const cacheKey = cacheKeyOf(cand);
    const saved = optCache.get(cacheKey);
    clearDefense({ keepLog });
    const run = st.run;
    const alive = () => run === st.run;
    const stopped = () => !alive() || st.cancel;
    st.running = true; st.cancel = false;
    $('#def-run').disabled = true; $('#def-cancel').disabled = false;

    const nC = oppA.length, nD = oppB.length;
    const upper = quick ? items.length : items.length * nC * nD;
    const ctxLines = [
      ...(stage ? [stage] : []),
      pair ? `探索: ${pair.side === 'A' ? '右上 (A)' : '左下 (B)'} ${cardTxt(pair.card)} と対になる ${pair.side === 'A' ? '左下 (B)' : '右上 (A)'} 3 枚（基準のカードの向きも解析）`
        : '探索: 6 枚の組み合わせ（右上 A 3 枚 + 左下 B 3 枚）',
      `自分（防御・黒）の候補: 右上 (A) ${myA.length} 枚・左下 (B) ${myB.length} 枚（向き込み ${items.length} 組: 両方反転なし・A のみ反転）`,
      ...(pair ? [] : [`固定: ${cand.fixedA.length || cand.fixedB.length
        ? `右上 ${cand.fixedA.map((f) => cardTxt(f)).join('、') || 'なし'} / 左下 ${cand.fixedB.map((f) => cardTxt(f)).join('、') || 'なし'}` : 'なし'}`]),
      `条件: 属性 ${$$('.def-attr').filter((x) => x.checked).map((x) => x.value).join('・') || 'なし'} / ${$('#def-owned').checked ? '所持カードのみ' : '未所持も含む'}${+$('#def-min-rank').value ? ` / ランク ★${$('#def-min-rank').value}${$('#def-min-rank').value === '5' ? '' : ' 以上'}` : ''} / ${cand.flip ? '向きも探索' : '向きは表示通り'}`,
      quick ? `評価: 自分の右上・左下だけを置いた局面（相手の左上・右下は空き、相手の応手は考慮しない）。全部で ${upper.toLocaleString()} 局面`
        : `相手（挑戦・白）の応手: 全カード 左上 ${nC} × 右下 ${nD}（向き込み）から、有望な応手を重みつきで順に評価（全部で最大 ${upper.toLocaleString()} 局面）`,
      `エンジン: ${engineText()} / ${+$('#visits').value || 1} visits / コミ ${KOMI}（アゲハマで調整）・日本ルール / 選択確率 ${pair ? `基準のカードが選ばれたとき、反対側の 3 枚が各 1/${SET_SIZE}` : `A・B 独立に各 1/${SET_SIZE}`}`,
    ];
    $('#def-context').innerHTML = ctxLines.map((l, k) => (k === 0 ? `<b>${esc(l)}</b>` : `<div class="muted">${esc(l)}</div>`)).join('');
    log('入力パラメーター', run);
    ctxLines.forEach((l) => log('  ' + l, run));

    // 自分の組。評価済みの応手はビットマップで管理（組ごとに 左上 × 右下 ビット）
    const pairs = items.map((it) => ({ a: it.a, b: it.b, key: cellKey(it.a, it.b), prepared: false, tls: null, brs: null,
      total: 0, n: 0, seen: null, best: null, complete: false }));
    const pairByKey = new Map(pairs.map((p) => [p.key, p]));
    // カードの勝率: 自分 = s（min で更新）、相手の応手 = t（max で更新）
    const sMine = new Map([...myA, ...myB].map((c) => [c.id, INITIAL_SCORE]));
    const tTL = new Float64Array(nC).fill(INITIAL_SCORE), tBR = new Float64Array(nD).fill(INITIAL_SCORE);
    const L = { evals: 0, done: 0, upper, items: pairs.length, touched: 0, complete: 0, best: null, quick };
    const updateBest = (p) => {
      const v = p.best?.x;
      if (v != null && (!L.best || v > L.best.v || L.best.key === p.key)) L.best = { ...cellOf(p), key: p.key };
    };
    const cellOf = (p) => ({ a: p.a, b: p.b, v: p.best ? p.best.x : null, lead: p.best ? p.best.lead : null,
      resp: p.best?.TL || p.best?.BR ? { TL: p.best.TL, BR: p.best.BR } : null, n: p.n, total: p.total, complete: p.complete });
    const cells = () => new Map(pairs.filter((p) => p.best).map((p) => [p.key, cellOf(p)]));

    // 前回の続き: 組の値（これまでの最悪ケース）と、全応手を評価済みの組を引き継ぐ
    if (saved) {
      for (const c of saved.cells) {
        const p = pairByKey.get(cellKey(c.a, c.b));
        if (!p || c.v == null) continue;
        p.best = { x: c.v, lead: c.lead, TL: c.resp?.TL, BR: c.resp?.BR };
        if (c.complete) { p.complete = true; p.n = p.total = c.total || 0; L.complete++; if (quick) L.done++; }
        L.touched++;
        sMine.set(p.a.id, Math.min(sMine.get(p.a.id), c.v));
        sMine.set(p.b.id, Math.min(sMine.get(p.b.id), c.v));
        updateBest(p);
      }
      log(`前回の続きから再開します（評価済みの組 ${L.touched}、全応手を評価済み ${L.complete}）`, run);
    }
    const save = () => optCache.set(cacheKey, {
      savedAt: new Date().toLocaleTimeString('ja-JP', { hour12: false }),
      cells: pairs.filter((p) => p.best).map((p) => { const c = cellOf(p); return { a: c.a, b: c.b, v: c.v, lead: c.lead, resp: c.resp, complete: c.complete, total: c.total }; }),
    });

    /** 組の準備: 防御側と衝突しない応手だけに絞る */
    const prepare = (p) => {
      p.prepared = true;
      const base = { TR: p.a, BL: p.b, TL: null, BR: null };
      if (buildPosition(base).conflicts.length) { p.tls = []; p.brs = []; }
      else {
        p.tls = []; p.brs = [];
        oppA.forEach((x, k) => { if (!buildPosition({ ...base, TL: x }).conflicts.length) p.tls.push(k); });
        oppB.forEach((x, k) => { if (!buildPosition({ ...base, BR: x }).conflicts.length) p.brs.push(k); });
      }
      p.total = p.tls.length * p.brs.length;
      p.seen = new Uint8Array(Math.ceil((nC * nD) / 8));
      if (!p.total) p.complete = true;
    };
    const finishOne = (p) => {
      p.n++; L.done++;
      if (p.n >= p.total && !p.complete) { p.complete = true; L.complete++; }
    };
    /** 組 p に対する相手の応手を 1 つサンプリング（評価済み・予約済みと、左上・右下の衝突は除く） */
    const sampleReply = (p) => {
      const tryIdx = (ci, di) => {
        const bit = ci * nD + di;
        if (p.seen[bit >> 3] & (1 << (bit & 7))) return null;
        p.seen[bit >> 3] |= 1 << (bit & 7);
        const pl = { TR: p.a, BL: p.b, TL: oppA[ci], BR: oppB[di] };
        const pos = buildPosition(pl);
        if (pos.conflicts.length) { finishOne(p); return null; }  // 左上と右下どうしの衝突
        return { p, ci, di, pl, pos };
      };
      const cumC = cumulative(p.tls.length, (k) => tTL[p.tls[k]]);
      const cumD = cumulative(p.brs.length, (k) => tBR[p.brs[k]]);
      for (let attempt = 0; attempt < 30 && !p.complete; attempt++) {
        const job = tryIdx(p.tls[pick(cumC)], p.brs[pick(cumD)]);
        if (job) return job;
      }
      // 評価済みが多くて引き直しが続くときは、残りを順に探す
      for (const ci of p.tls) for (const di of p.brs) {
        if (p.complete) return null;
        const job = tryIdx(ci, di);
        if (job) return job;
      }
      return null;  // 残りはすべて評価中（結果待ち）
    };
    let open = pairs.filter((p) => !p.complete);
    // 自分の 2 隅だけで評価する: 組ごとに 1 局面（相手の隅は空き）。暫定の結果が偏らないよう順番は混ぜる
    if (quick) for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [open[i], open[j]] = [open[j], open[i]]; }
    const nextQuickBatch = () => {
      const size = Math.max(1, +$('#batch').value || 32);
      const batch = [];
      open = open.filter((p) => !p.complete);
      for (const p of open) {
        if (batch.length >= size) break;
        if (p.inflight) continue;
        const pl = { TR: p.a, BL: p.b, TL: null, BR: null };
        const pos = buildPosition(pl);
        if (pos.conflicts.length) { p.complete = true; L.done++; continue; }
        p.inflight = true;
        batch.push({ p, pl, pos });
      }
      return batch;
    };
    const onQuickResult = (job, r) => {
      const { p } = job;
      p.inflight = false; p.complete = true; p.n = p.total = 1;
      L.done++;
      if (r.error) { errors++; return; }
      L.evals++; L.touched++; L.complete++;
      p.best = { x: 1 - r.winrateWhite, lead: -r.scoreLeadWhite, TL: null, BR: null };
      updateBest(p);
    };
    const nextBatch = quick ? nextQuickBatch : () => {
      const size = Math.max(1, +$('#batch').value || 32);
      const batch = [];
      open = open.filter((p) => !p.complete);
      if (!open.length) return batch;
      const cum = cumulative(open.length, (k) => sMine.get(open[k].a.id) * sMine.get(open[k].b.id));
      for (let guard = 0; batch.length < size && guard < size * 4; guard++) {
        const p = open[pick(cum)];
        if (p.complete) continue;
        if (!p.prepared) { prepare(p); if (p.complete) continue; }
        const job = sampleReply(p);
        if (job) batch.push(job);
      }
      return batch;
    };
    const onResult = quick ? onQuickResult : (job, r) => {
      const { p } = job;
      finishOne(p);
      if (r.error) { errors++; return; }
      L.evals++;
      const x = 1 - r.winrateWhite;
      if (!p.best) L.touched++;
      if (!p.best || x < p.best.x) p.best = { x, lead: -r.scoreLeadWhite, TL: job.pl.TL, BR: job.pl.BR };
      sMine.set(p.a.id, Math.min(sMine.get(p.a.id), x));
      sMine.set(p.b.id, Math.min(sMine.get(p.b.id), x));
      tTL[job.ci] = Math.max(tTL[job.ci], r.winrateWhite);
      tBR[job.di] = Math.max(tBR[job.di], r.winrateWhite);
      updateBest(p);
    };

    let errors = 0;
    const t0 = performance.now();
    let lastPairs = 0, lastSets = 0, lastSave = performance.now();
    const refresh = (force = false) => {
      const now = performance.now();
      if (force || now - lastPairs > 2000) { lastPairs = now; renderPairs(cells()); }
      if (force || now - lastSets > PROVISIONAL_EVERY) { lastSets = now; computeSets(cand, cells(), { provisional: true, items: items.length }); }
      if (now - lastSave > 30000) { lastSave = now; save(); }
    };
    live.start(L);
    log(quick ? `開始: 自分の組 ${pairs.length}（1 組 1 局面、相手の隅は空き）を評価します`
      : `開始: 自分の組 ${pairs.length}、相手の応手は 1 組あたり最大 ${(nC * nD).toLocaleString()} 通り。有望な組・応手から順に評価します`, run);

    const worker = async () => {
      while (!stopped()) {
        const batch = nextBatch();
        if (!batch.length) {
          if (!open.length) return;
          await new Promise((res) => setTimeout(res, 50));  // 残りは他のバッチの結果待ち
          continue;
        }
        try {
          await analyze(batch.map((j) => j.pos), (k, r) => { if (alive()) onResult(batch[k], r); }, { abortable: true });
        } catch (e) {
          if (e.name === 'AbortError') return;
          throw e;
        }
        if (alive()) refresh();
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (!alive()) return;
      live.stop();
      const sec = (performance.now() - t0) / 1000;
      if (L.evals && sec > 1) store.set(RATE_KEY, L.evals / sec);
      save();
      const all = !open.length;
      const elapsed = fmtSec(sec);
      const doneText = all ? (quick ? '評価完了' : '全探索完了') : '中止';
      const pairText = quick ? `評価済みの組 ${L.touched} / ${L.items}` : `評価済みの組 ${L.touched} / ${L.items}（全応手を評価済み ${L.complete}）`;
      $('#def-info').textContent = `${doneText}: ${pairText}、今回 ${L.evals.toLocaleString()} 局面、${elapsed}`;
      log(`${doneText}: ${pairText}、今回 ${L.evals.toLocaleString()} 局面、${elapsed}${errors ? `、エラー ${errors} 件` : ''}`, run);
      if (!all) log('同じ条件で再実行すると、これまでの結果を引き継いで続けます。', run);
      $('#def-pairs-summary').textContent = `参考: 各組の評価（${quick ? '自分の 2 隅だけの局面' : '相手の最善応手に対する'}黒の勝率、評価済み ${L.touched} / ${L.items} 組）`;
      renderPairs(cells());
      const ms = computeSets(cand, cells(), { provisional: !all, items: items.length });
      log(`組み合わせの選択: 評価済みの ${L.touched} 組から${pair ? '対になる 3 枚' : ' A・B 3 枚ずつ'}を厳密に探索（${fmtSec(ms / 1000)}）`, run);
      if (st.sets.length) {
        const top = st.sets[0], { rowsA, colsB } = st.result;
        log(`${all ? '最適な防御' : '暫定の最適な防御'}${quick ? '（自分の 2 隅だけで評価）' : ''}: 期待勝率 ${all || quick ? '' : '≤ '}${pct(top.ev)}`, run);
        log(`  右上 (A): ${top.rows.map((ri) => cardTxt(rowsA[ri])).join('、')}`, run);
        log(`  左下 (B): ${top.cols.map((ci) => cardTxt(colsB[ci])).join('、')}`, run);
      }
      return { all, cells: cells(), cand };
    } catch (e) {
      if (!alive()) return;
      live.stop();
      $('#def-info').textContent = 'エラー: ' + e.message;
      log('エラー: ' + e.message, run);
      save();
    } finally {
      if (alive()) { st.running = false; $('#def-run').disabled = false; $('#def-cancel').disabled = true; }
    }
  }

  renderBest();
  renderFixed();
  saveFixed();
  applyMode();
  $('#def-fixed-clear').onclick = () => { fixed.A = [null, null, null]; fixed.B = [null, null, null]; renderFixed(); saveFixed(); };
  // refresh: 囲碁シル AI の記録が変わったときに表を描き直す
  window.defense = { bestSets, buildMatrix, topCards, clear: clearDefense,
    refresh: () => { if (st.result) renderBest(); if (lastPairCells) renderPairs(lastPairCells); } };  // テスト・デバッグ用
  $('#def-run').onclick = () => runDefense();
  $('#def-cancel').onclick = () => { st.cancel = true; abortAnalyze(); };
})();
