'use strict';
// ---------------------------------------------------------------------------
// シチョウ（ladder）の判定
//
// 盤面の石（[色, x, y] の配列。色は 'B' / 'W'）について、呼吸点が 2 つの連を、
// 相手が先にアタリをかけ続けて取れるか（シチョウが成立するか）を読む。
// 守る側は、呼吸点に伸びるか、アタリになっている攻める側の石を取って逃げる。
// 伸びて呼吸点が 3 つ以上になれば逃げ切り、1 つになれば取られる。
// ---------------------------------------------------------------------------
const Ladder = (() => {
  const SIZE = 19;
  const MAX_DEPTH = 120;     // 盤の端から端まで伸びても足りる手数
  const MAX_NODES = 20000;   // 1 回の読みで調べる局面の上限（超えたら「不明」）
  const other = (c) => (c === 'B' ? 'W' : 'B');
  // 読みの途中で見た点。ほかの石を足しても、ここに重ならなければ読みの結果は変わらない
  let touch = null;
  const nbrs = (i) => {
    const x = i % SIZE, y = (i - x) / SIZE, out = [];
    if (x > 0) out.push(i - 1);
    if (x < SIZE - 1) out.push(i + 1);
    if (y > 0) out.push(i - SIZE);
    if (y < SIZE - 1) out.push(i + SIZE);
    return out;
  };

  function toBoard(stones) {
    const b = new Array(SIZE * SIZE).fill(null);
    for (const [c, x, y] of stones) b[y * SIZE + x] = c;
    return b;
  }
  /** i を含む連の石と呼吸点 */
  function chain(b, i) {
    const c = b[i], stones = [], libs = new Set(), seen = new Set([i]), stack = [i];
    while (stack.length) {
      const j = stack.pop();
      stones.push(j);
      if (touch) touch.add(j);
      for (const k of nbrs(j)) {
        if (touch) touch.add(k);
        if (b[k] === null) libs.add(k);
        else if (b[k] === c && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    return { stones, libs: [...libs] };
  }
  /** c が i に打つ。取った石を取り除き、着手禁止（自殺手）なら null。盤は書き換える（戻すための記録を返す） */
  function play(b, i, c) {
    if (b[i] !== null) return null;
    if (touch) { touch.add(i); for (const k of nbrs(i)) touch.add(k); }
    b[i] = c;
    const removed = [];
    for (const k of nbrs(i)) {
      if (b[k] === other(c)) {
        const g = chain(b, k);
        if (!g.libs.length) for (const s of g.stones) { if (b[s] !== null) { removed.push(s); b[s] = null; } }
      }
    }
    if (!chain(b, i).libs.length) { b[i] = null; for (const s of removed) b[s] = other(c); return null; }
    return { i, c, removed };
  }
  function undo(b, mv) { b[mv.i] = null; for (const s of mv.removed) b[s] = other(mv.c); }

  /**
   * 攻める側の手番で、target（連の 1 つの石）をシチョウで取れるか。
   * 戻り値: true = 取れる、false = 逃げられる、null = 読み切れない
   */
  function attackerWins(b, target, depth, budget) {
    if (--budget.n < 0) return null;
    if (b[target] === null) return true;
    const g = chain(b, target);
    if (g.libs.length === 1) return true;   // 攻める側の手番でアタリ → 取れる
    if (g.libs.length >= 3) return false;
    if (depth > MAX_DEPTH) return null;
    const def = b[target], att = other(def);
    let unknown = false;
    for (const lib of g.libs) {
      const mv = play(b, lib, att);
      if (!mv) continue;
      // 攻めた石がすぐ取られる形（打った石の連がアタリ）でも、守る側の手として下で調べる
      const r = defenderEscapes(b, target, depth + 1, budget);
      undo(b, mv);
      if (r === false) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  /** 守る側の手番（target はアタリ）で逃げられるか。true = 逃げられる、false = 取られる、null = 不明 */
  function defenderEscapes(b, target, depth, budget) {
    if (--budget.n < 0) return null;
    if (b[target] === null) return false;
    const g = chain(b, target);
    if (g.libs.length >= 2) { const a = attackerWins(b, target, depth, budget); return a === null ? null : !a; }
    const def = b[target], att = other(def);
    // 候補: 呼吸点に伸びる、target に接するアタリの攻め石を取る
    const moves = new Set(g.libs);
    for (const s of g.stones) for (const k of nbrs(s)) {
      if (b[k] === att) { const a = chain(b, k); if (a.libs.length === 1) moves.add(a.libs[0]); }
    }
    let unknown = false;
    for (const m of moves) {
      const mv = play(b, m, def);
      if (!mv) continue;
      const h = chain(b, target);
      let r;
      if (h.libs.length >= 3) r = true;
      else if (h.libs.length <= 1) r = false;
      else { const a = attackerWins(b, target, depth + 1, budget); r = a === null ? null : !a; }
      undo(b, mv);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }

  /**
   * 盤面 stones のうち、区域 area（x, y → bool）にある連で、シチョウになりうるもの（呼吸点 2 つ、
   * または手番の黒の連が呼吸点 1 つ）を探し、それぞれシチョウが成立するかを返す。
   * toMove: 手番（'B'）。呼吸点 2 つの連は相手が先に打つとして読む（黒の連なら白が打てたら、の意味）。
   * 戻り値: [{ color, size, at: [x, y], libs, captured: true / false / null }]
   */
  function find(stones, area, toMove = 'B') {
    const b = toBoard(stones);
    const seen = new Set(), out = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (b[i] === null || seen.has(i)) continue;
      const g = chain(b, i);
      g.stones.forEach((s) => seen.add(s));
      if (!g.stones.some((s) => area(s % SIZE, Math.floor(s / SIZE)))) continue;
      const color = b[i];
      const n = g.libs.length;
      let captured;
      const budget = { n: MAX_NODES };
      if (n === 2) captured = attackerWins(b, i, 0, budget);
      else if (n === 1 && color === toMove) captured = !defenderEscapesFirst(b, i, budget);
      else continue;
      // 石を取ったり逃げたりがすぐ決まる（読みが 1〜2 手で終わる）連はシチョウではないので除く
      if (MAX_NODES - budget.n <= 3) continue;
      const top = g.stones.reduce((a, s) => (s < a ? s : a), g.stones[0]);
      out.push({ color, size: g.stones.length, at: [top % SIZE, Math.floor(top / SIZE)], key: g.stones.slice().sort((p, q) => p - q).join(','), libs: n, captured });
    }
    return out;
  }
  function defenderEscapesFirst(b, i, budget) {
    const r = defenderEscapes(b, i, 0, budget);
    return r === null ? true : r;
  }
  /** stones の盤面で、key（連の石の位置）の連についてだけ読む。連が変わっていれば null */
  function check(stones, chainKey, color, toMove = 'B') {
    const b = toBoard(stones);
    const pts = chainKey.split(',').map(Number);
    if (pts.some((p) => b[p] !== color)) return null;
    const g = chain(b, pts[0]);
    if (g.stones.length !== pts.length) return null;  // ほかの石とつながった
    const budget = { n: MAX_NODES };
    if (g.libs.length === 2) return attackerWins(b, pts[0], 0, budget);
    if (g.libs.length === 1 && color === toMove) return !defenderEscapesFirst(b, pts[0], budget);
    if (g.libs.length === 1) return true;
    return false;
  }
  /** check と同じ。読みで見た点（盤の位置 y * 19 + x の Set）も返す */
  function checkEx(stones, chainKey, color, toMove = 'B') {
    touch = new Set();
    try { return { result: check(stones, chainKey, color, toMove), touched: touch }; } finally { touch = null; }
  }
  return { find, check, checkEx };
})();
