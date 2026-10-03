'use strict';
// ---------------------------------------------------------------------------
// カード選択ボックス（拡張版）
//  - 属性 ▸ 動物（定石グループ） ▸ カード の多段階の折りたたみ表示
//  - テキストを直接入力して絞り込み（カード名・動物・属性・グループの説明に部分一致）
//  - 属性・動物は、一覧の見出しや上部のボタンをクリックすると「チップ」として入力欄に入り、条件として絞り込める
//    （属性・動物はそれぞれ 1 つだけ選べる。属性・動物・入力文字どうしは「かつ」）
//  - キーボード: ↑↓ で移動、Enter で決定、Esc で閉じる、入力が空のとき Backspace でチップを削除
//
// 使い方:
//   const p = new CardPicker({ getItems, onChange, placeholder });
//   container.appendChild(p.el); p.value = 'cardId';
//   getItems() は開いたときに呼ばれ、[{ id, attr, group, groupLabel, name, rank, note, disabled, title }] を返す
//   rank（1〜5）があるカードがあれば、ランクでも絞り込める（★N ちょうど、または「以上」で ★N 以上）
//   describe(id) は閉じているときの表示用に { attr, group, name } を返す
//
// 絞り込み専用（mode: 'filter'）: カードを 1 枚選ぶのではなく、属性・動物・カードのチップと入力文字を条件として持つ。
//   閉じても条件は残り、変わるたびに onFilter() を呼ぶ。p.matches(item) で条件に合うか判定できる。
// ---------------------------------------------------------------------------
class CardPicker {
  constructor({ getItems, describe, onChange, onFilter, mode = 'select', placeholder = 'カード名・動物・属性で絞り込み', noneLabel }) {
    this.mode = mode;
    this.onFilter = onFilter;
    this.placeholder = placeholder;
    noneLabel = noneLabel ?? (mode === 'filter' ? '（すべて）' : '（なし）');
    this.getItems = getItems;
    this.describe = describe;  // id → { attr, group, name }（閉じているときの表示用。軽い処理で済ませる）
    this.onChange = onChange;
    this.noneLabel = noneLabel;
    this.chips = [];          // [{ kind: 'attr' | 'group' | 'card' | 'rank', value, label, op }]
    this.rankGe = false;       // ランクの条件を「以上」にするか
    this.collapsed = new Set(); // 折りたたんだ見出し（"attr:地" / "group:地|ウサギ"）
    this._value = null;
    this._items = [];
    this.active = -1;          // キーボードで選択中の行（表示中のカード行の番号）

    const el = document.createElement('div');
    el.className = 'cp' + (mode === 'filter' ? ' filter' : '');
    el.innerHTML = `
      <div class="cp-box">
        <span class="cp-chips"></span>
        <input class="cp-input" type="text" autocomplete="off" spellcheck="false" placeholder="${placeholder}">
        <span class="cp-value"></span>
        <button type="button" class="cp-clear" title="選択を外す">×</button>
        <span class="cp-caret">▾</span>
      </div>
      <div class="cp-pop" hidden>
        <div class="cp-quick"></div>
        <div class="cp-list" role="listbox"></div>
      </div>`;
    this.el = el;
    this.box = el.querySelector('.cp-box');
    this.input = el.querySelector('.cp-input');
    this.pop = el.querySelector('.cp-pop');
    this.list = el.querySelector('.cp-list');

    this.box.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.cp-clear') || ev.target.closest('.cp-chip-x')) return;
      if (!this.isOpen) { ev.preventDefault(); this.open(); }
    });
    el.querySelector('.cp-clear').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (this.mode === 'filter') this.clearFilter(); else this.select(null);
    });
    // 文字を入力したら、最初に一致したカードを選択中にする（Enter ですぐ決定できる）
    this.input.addEventListener('input', () => {
      if (!this.isOpen) this.open();
      this.renderList(); this.active = this.rows().length > 1 ? 1 : -1; this.highlight();
      this.fireFilter();
    });
    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
    this.input.addEventListener('focus', () => { if (!this.isOpen) this.open(); });
    // 一覧・チップのクリック（入力欄のフォーカスを失わないよう mousedown で処理）
    this.pop.addEventListener('mousedown', (ev) => { ev.preventDefault(); this.onPopClick(ev); });
    el.querySelector('.cp-chips').addEventListener('mousedown', (ev) => {
      const x = ev.target.closest('.cp-chip-x');
      if (!x) return;
      ev.preventDefault(); ev.stopPropagation();
      this.chips.splice(+x.dataset.i, 1);
      this.renderChips();
      if (this.isOpen) { this.renderQuick(); this.renderList(); }
      this.fireFilter();
    });
    // クリックで一覧を描き直すと押した要素が DOM から外れるので、イベントの経路で内側かどうかを判定する
    this._outside = (ev) => { if (!ev.composedPath().includes(el)) this.close(); };
    // 一覧は画面に固定して表示する（スクロールする枠の中でも切れないように）。スクロール・リサイズに追従
    this._reposition = () => this.position();
    this.renderValue(); this.renderChips();
  }

  get isOpen() { return !this.pop.hidden; }
  get value() { return this._value; }
  set value(id) { this._value = id || null; this.renderValue(); }

  open() {
    this._items = this.getItems();
    this.pop.hidden = false;
    this.el.classList.add('open');
    this.renderValue(); this.renderChips(); this.renderQuick(); this.renderList();
    this.position();
    document.addEventListener('mousedown', this._outside);
    window.addEventListener('scroll', this._reposition, true);
    window.addEventListener('resize', this._reposition);
    this.input.focus();
    // 選択中のカードが見えるようにする
    const cur = this.list.querySelector('.cp-item.selected');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  close() {
    if (!this.isOpen) return;
    this.pop.hidden = true;
    this.el.classList.remove('open');
    if (this.mode !== 'filter') this.input.value = '';  // 絞り込み専用では入力文字も条件として残す
    this.active = -1;
    document.removeEventListener('mousedown', this._outside);
    window.removeEventListener('scroll', this._reposition, true);
    window.removeEventListener('resize', this._reposition);
    this.input.blur();
    this.renderValue(); this.renderChips();
  }
  /** 一覧の位置: 入力欄の下（入らなければ上）に、画面内に収まるように置く */
  position() {
    if (this.pop.hidden) return;
    const r = this.box.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, margin = 8;
    const width = Math.min(Math.max(r.width, 380), vw - margin * 2);
    const left = Math.min(Math.max(margin, r.left), vw - width - margin);
    const below = vh - r.bottom - margin, above = r.top - margin;
    const up = below < 260 && above > below;
    const room = Math.max(160, up ? above : below);
    Object.assign(this.pop.style, { position: 'fixed', left: left + 'px', width: width + 'px', maxHeight: room + 'px',
      top: up ? '' : (r.bottom + 2) + 'px', bottom: up ? (vh - r.top + 2) + 'px' : '' });
  }
  /** 絞り込み専用: 条件が変わったことを知らせる */
  fireFilter() { if (this.mode === 'filter') { this.renderValue(); this.onFilter?.(); } }
  /** 絞り込み専用: 条件があるか */
  get active_() { return !!(this.chips.length || this.input.value.trim()); }
  /** item（{ id, attr, group, groupLabel, name }）が条件に合うか */
  matches(x) {
    if (!x) return !this.active_;
    const norm = (t) => String(t || '').normalize('NFKC').toLowerCase();
    for (const c of this.chips) {
      if (c.kind === 'attr' && x.attr !== c.value) return false;
      if (c.kind === 'group' && x.group !== c.value) return false;
      if (c.kind === 'card' && x.id !== c.value) return false;
      if (c.kind === 'rank' && !CardPicker.rankOk(x.rank, c)) return false;
    }
    const words = norm(this.input.value).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = norm(`${x.attr} ${x.group} ${x.groupLabel || ''} ${x.name} ${x.rank ? '★' + x.rank : ''}`);
    return words.every((w) => hay.includes(w));
  }
  /** 絞り込み専用: すべての条件を外す */
  clearFilter() {
    this.chips = []; this.input.value = '';
    this.renderChips();
    if (this.isOpen) { this.renderQuick(); this.renderList(); }
    this.fireFilter();
  }

  select(id) {
    if (this.mode === 'filter') {
      // 絞り込み専用: カードを選ぶとカードのチップ（1 枚だけ）、（すべて）で条件をすべて外す
      if (!id) { this.close(); this.clearFilter(); return; }
      const x = this._items.find((it) => it.id === id);
      this.chips = this.chips.filter((c) => c.kind !== 'card');
      this.chips.push({ kind: 'card', value: id, label: x ? x.name : id });
      this.input.value = '';
      this.close();
      this.fireFilter();
      return;
    }
    this.close();
    if ((id || null) === this._value) return;
    this._value = id || null;
    this.renderValue();
    this.onChange?.(this._value);
  }

  // ---- 表示 ----
  renderValue() {
    const v = this.el.querySelector('.cp-value');
    if (this.mode === 'filter') {
      // 絞り込み専用: 条件（チップ・入力欄）を常に表示し、条件があるときだけ × を出す
      v.hidden = true;
      this.el.querySelector('.cp-clear').hidden = !this.active_;
      return;
    }
    const item = this._value && (this.describe ? this.describe(this._value) : this.getItems().find((x) => x.id === this._value));
    v.innerHTML = item ? `${CardPicker.badge(item.attr)} <span class="cp-muted">${CardPicker.esc(item.group)}</span> ${CardPicker.esc(item.name)}`
      : `<span class="cp-muted">${CardPicker.esc(this.noneLabel)}</span>`;
    v.hidden = this.isOpen;
    this.el.querySelector('.cp-clear').hidden = !this._value || this.isOpen;
  }
  renderChips() {
    const wrap = this.el.querySelector('.cp-chips');
    const show = this.isOpen || this.mode === 'filter';
    wrap.innerHTML = show ? this.chips.map((c, i) =>
      `<span class="cp-chip ${c.kind === 'attr' ? 'attr ' + CardPicker.esc(c.value) : ''}${c.kind === 'card' ? ' card' : ''}">${CardPicker.esc(c.label)}<span class="cp-chip-x" data-i="${i}" title="条件を外す">×</span></span>`).join('') : '';
    this.input.placeholder = this.chips.length ? '' : this.placeholder;
  }
  renderQuick() {
    const attrs = [...new Set(this._items.map((x) => x.attr).filter(Boolean))];
    // 属性のチップがあるときは、その属性の動物だけを出す
    const selAttrs = this.chips.filter((c) => c.kind === 'attr').map((c) => c.value);
    const groups = [...new Map(this._items.filter((x) => !selAttrs.length || selAttrs.includes(x.attr)).map((x) => [x.group, x.attr])).entries()];
    const on = (kind, value) => this.chips.some((c) => c.kind === kind && c.value === value);
    this.el.querySelector('.cp-quick').innerHTML =
      `<div><span class="cp-muted">属性:</span> ${attrs.map((a) => `<span class="cp-q${on('attr', a) ? ' on' : ''}" data-kind="attr" data-value="${CardPicker.esc(a)}">${CardPicker.badge(a)}</span>`).join(' ')}</div>
       <div><span class="cp-muted">動物:</span> ${groups.map(([g, a]) => `<span class="cp-q cp-qg${on('group', g) ? ' on' : ''}" data-kind="group" data-value="${CardPicker.esc(g)}" title="${CardPicker.esc(a || '')}">${CardPicker.esc(g)}</span>`).join('')}</div>` +
      // 絞り込み専用ではランクの行を常に出す（ランクはカード一覧で設定）
      (this.mode === 'filter' || this._items.some((x) => x.rank)
        ? `<div><span class="cp-muted">ランク:</span> ${[1, 2, 3, 4, 5].map((n) => `<span class="cp-q cp-qg cp-qr${on('rank', n) ? ' on' : ''}" data-kind="rank" data-value="${n}">★${n}</span>`).join('')}
           <span class="cp-q cp-qg${this.rankGe ? ' on' : ''}" data-kind="rankop" data-value="ge" title="選んだランク以上を対象にする">以上</span></div>` : '');
  }
  /** 絞り込み後のカード（チップ・入力文字） */
  filtered() {
    const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
    const words = norm(this.input.value).split(/\s+/).filter(Boolean);
    const attrs = this.chips.filter((c) => c.kind === 'attr').map((c) => c.value);
    const groups = this.chips.filter((c) => c.kind === 'group').map((c) => c.value);
    const rank = this.chips.find((c) => c.kind === 'rank');
    return this._items.filter((x) => {
      // （カードのチップは一覧の絞り込みには使わない。ほかのカードに選び直せるように）
      if (rank && !CardPicker.rankOk(x.rank, rank)) return false;
      if (attrs.length && !attrs.includes(x.attr)) return false;
      if (groups.length && !groups.includes(x.group)) return false;
      const hay = norm(`${x.attr} ${x.group} ${x.groupLabel || ''} ${x.name}`);
      return words.every((w) => hay.includes(w));
    });
  }
  renderList() {
    const E = CardPicker.esc;
    const items = this.filtered();
    const filtering = !!(this.input.value.trim() || this.chips.length);
    const none = this.mode === 'filter' ? !this.active_ : !this._value;
    const parts = [`<div class="cp-item cp-none${none ? ' selected' : ''}" data-id="">${E(this.noneLabel)}</div>`];
    const byAttr = new Map();
    for (const x of items) {
      if (!byAttr.has(x.attr)) byAttr.set(x.attr, new Map());
      const g = byAttr.get(x.attr);
      if (!g.has(x.group)) g.set(x.group, []);
      g.get(x.group).push(x);
    }
    for (const [attr, groups] of byAttr) {
      const aKey = `attr:${attr}`;
      const aClosed = !filtering && this.collapsed.has(aKey);
      const count = [...groups.values()].reduce((t, l) => t + l.length, 0);
      parts.push(`<div class="cp-h cp-h1" data-toggle="${E(aKey)}"><span class="cp-tw">${aClosed ? '▸' : '▾'}</span>
        <span class="cp-q" data-kind="attr" data-value="${E(attr)}" title="この属性で絞り込む">${CardPicker.badge(attr)}</span><span class="cp-muted">${count}</span></div>`);
      if (aClosed) continue;
      for (const [group, list] of groups) {
        const gKey = `group:${attr}|${group}`;
        const gClosed = !filtering && this.collapsed.has(gKey);
        const desc = list[0].groupLabel && list[0].groupLabel !== group ? list[0].groupLabel.replace(/^[^（]*/, '') : '';
        parts.push(`<div class="cp-h cp-h2" data-toggle="${E(gKey)}"><span class="cp-tw">${gClosed ? '▸' : '▾'}</span>
          <span class="cp-q cp-qg" data-kind="group" data-value="${E(group)}" title="この動物で絞り込む">${E(group)}</span><span class="cp-muted">${E(desc)} ${list.length}</span></div>`);
        if (gClosed) continue;
        for (const x of list) {
          const sel = this.mode === 'filter' ? this.chips.some((c) => c.kind === 'card' && c.value === x.id) : x.id === this._value;
          parts.push(`<div class="cp-item${x.disabled ? ' disabled' : ''}${sel ? ' selected' : ''}" data-id="${E(x.id)}" title="${E(x.title || '')}">
            ${E(x.name)}${x.rank ? ` <span class="rank">★${x.rank}</span>` : ''}${x.note ? ` <span class="cp-note">${E(x.note)}</span>` : ''}</div>`);
        }
      }
    }
    if (!items.length) parts.push('<div class="cp-empty">該当するカードがありません</div>');
    this.list.innerHTML = parts.join('');
    this.highlight();
  }
  rows() { return [...this.list.querySelectorAll('.cp-item:not(.disabled)')]; }
  highlight() {
    const rows = this.rows();
    rows.forEach((r, i) => r.classList.toggle('active', i === this.active));
    if (rows[this.active]) rows[this.active].scrollIntoView({ block: 'nearest' });
  }

  // ---- 操作 ----
  addChip(kind, value) {
    if (!value) return;
    if (kind === 'rankop') {
      // 「以上」の切り替え。ランクのチップがあれば条件も切り替える
      this.rankGe = !this.rankGe;
      for (const c of this.chips) if (c.kind === 'rank') { c.op = this.rankGe ? 'ge' : 'eq'; c.label = `★${c.value}${this.rankGe ? ' 以上' : ''}`; }
      this.renderChips(); this.renderQuick(); this.renderList(); this.fireFilter();
      return;
    }
    if (kind === 'rank') {
      const n = +value;
      const had = this.chips.some((c) => c.kind === 'rank' && c.value === n);
      this.chips = this.chips.filter((c) => c.kind !== 'rank');  // ランクも 1 つだけ
      if (!had) this.chips.push({ kind: 'rank', value: n, op: this.rankGe ? 'ge' : 'eq', label: `★${n}${this.rankGe ? ' 以上' : ''}` });
      this.input.value = '';
      this.active = -1;
      this.renderChips(); this.renderQuick(); this.renderList(); this.fireFilter();
      return;
    }
    const i = this.chips.findIndex((c) => c.kind === kind && c.value === value);
    if (i >= 0) this.chips.splice(i, 1);  // もう一度クリックで外す
    else if (kind === 'attr') {
      // 属性は排他（1 つだけ）。別の属性の動物のチップも外す
      const groupAttr = new Map(this._items.map((x) => [x.group, x.attr]));
      this.chips = this.chips.filter((c) => c.kind !== 'attr' && !(c.kind === 'group' && groupAttr.get(c.value) !== value));
      this.chips.unshift({ kind, value, label: value });
    } else {
      // 動物も排他（1 つだけ）
      this.chips = this.chips.filter((c) => c.kind !== 'group');
      this.chips.push({ kind, value, label: value });
    }
    this.input.value = '';
    this.active = -1;
    this.renderChips(); this.renderQuick(); this.renderList();
    this.fireFilter();
  }
  onPopClick(ev) {
    const q = ev.target.closest('.cp-q');
    if (q) { this.addChip(q.dataset.kind, q.dataset.value); return; }
    const h = ev.target.closest('[data-toggle]');
    if (h) {
      const k = h.dataset.toggle;
      if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
      this.renderList();
      return;
    }
    const item = ev.target.closest('.cp-item');
    if (item && !item.classList.contains('disabled')) this.select(item.dataset.id);
  }
  onKey(ev) {
    const rows = this.rows();
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!this.isOpen) this.open(); this.active = Math.min(rows.length - 1, this.active + 1); this.highlight(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.active = Math.max(0, this.active - 1); this.highlight(); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const row = rows[this.active];
      if (row) this.select(row.dataset.id);
    } else if (ev.key === 'Escape') { ev.preventDefault(); this.close(); }
    else if (ev.key === 'Backspace' && !this.input.value && this.chips.length) {
      this.chips.pop(); this.renderChips(); this.renderQuick(); this.renderList(); this.fireFilter();
    } else if (ev.key === 'Tab') this.close();
  }

  /** ランクの条件に合うか（ランク未設定のカードは合わない） */
  static rankOk(rank, chip) { return !!rank && (chip.op === 'ge' ? rank >= chip.value : rank === chip.value); }
  static esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  static badge(attr) { return attr ? `<span class="attr ${CardPicker.esc(attr)}">${CardPicker.esc(attr)}</span>` : '<span class="cp-muted">属性不明</span>'; }
}
