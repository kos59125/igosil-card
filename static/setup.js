'use strict';
// ---------------------------------------------------------------------------
// KataGo の導入（「設定」タブ）
//  - OS はブラウザから判定（変更可）。サーバーの OS と違う場合は警告する
//  - 実行ファイルは GitHub の KataGo リリースから、ネットワークは katagotraining.org から選んでダウンロード
//  - ダウンロード・展開はサーバー側で行い、パスは katago/settings.json に保存。両方そろえば KataGo を起動する
// index.html のグローバル（$, $$, api, esc, refreshStatus, showTab など）を使う。
// ---------------------------------------------------------------------------
(() => {
  const BACKEND_HINT = {
    opencl: 'GPU 向け（NVIDIA / AMD / Intel）。追加のインストール不要。初回起動時にチューニングで数分かかります',
    cuda: 'NVIDIA GPU 向け。CUDA と cuDNN のインストールが別途必要です',
    tensorrt: 'NVIDIA GPU 向け。TensorRT のインストールが別途必要で、起動に時間がかかります',
    eigenavx2: 'GPU なし（AVX2 対応の CPU）。解析は遅め',
    eigen: 'GPU なし（AVX2 非対応の古い CPU）。解析はかなり遅め',
    metal: 'macOS（Apple Silicon）向け',
    rocm: 'AMD GPU 向け（ROCm が必要）',
    onnx: 'ONNX Runtime 向け',
  };
  const BACKEND_ORDER = ['opencl', 'eigenavx2', 'cuda', 'tensorrt', 'metal', 'eigen', 'rocm', 'onnx'];
  const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

  function detectOS() {
    const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.includes('win')) return 'windows';
    if (p.includes('mac')) return 'macos';
    if (p.includes('linux') || p.includes('x11')) return 'linux';
    return 'windows';
  }
  const mb = (n) => (n == null ? '?' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB');

  const wrap = document.createElement('section');
  wrap.id = 'katago-setup';
  wrap.innerHTML = `
    <h2 style="font-size:14px;margin:0 0 6px">KataGo の導入</h2>
    <div class="msg" id="ks-current"></div>
    <div class="row">
      <label>OS <select id="ks-os"><option value="windows">Windows</option><option value="macos">macOS</option><option value="linux">Linux</option></select></label>
      <span class="muted" id="ks-os-note"></span>
    </div>
    <h3 style="font-size:13px;margin:10px 0 4px">1. 実行ファイル（GitHub の KataGo リリース）</h3>
    <div class="row">
      <button id="ks-load-releases">リリース一覧を取得</button>
      <select id="ks-release" style="max-width:100%"></select>
      <select id="ks-asset" style="max-width:100%"></select>
      <button id="ks-dl-engine" class="primary" disabled>ダウンロードして展開</button>
    </div>
    <div class="muted" id="ks-asset-note"></div>
    <h3 style="font-size:13px;margin:10px 0 4px">2. ネットワーク（katagotraining.org）</h3>
    <div class="row">
      <button id="ks-load-networks">ネットワーク一覧を取得</button>
      <select id="ks-network" style="max-width:100%"></select>
      <button id="ks-dl-model" class="primary" disabled>ダウンロード</button>
    </div>
    <div class="row" id="ks-net-quick" hidden>
      <span class="muted">おすすめ:</span>
      <button data-pick="strongest">最も強い（strongest confidently-rated）</button>
      <button data-pick="light">軽い（b18c384nbt の最新、CPU・非力な GPU 向け）</button>
    </div>
    <div class="muted">このツールは大量の局面を 1 visit 程度で評価するので、CPU や非力な GPU では軽いネットワークのほうが速く動きます。</div>
    <div id="ks-jobs"></div>
    <h3 style="font-size:13px;margin:10px 0 4px">3. 起動</h3>
    <details><summary class="muted">パスを手動で指定する（Homebrew で入れた KataGo など）</summary>
      <div class="row"><label style="flex:1">KataGo 実行ファイル <input type="text" id="ks-katago" style="width:100%" placeholder="例: C:\\KataGo\\katago.exe / /opt/homebrew/bin/katago"></label></div>
      <div class="row"><label style="flex:1">モデル（.bin.gz） <input type="text" id="ks-model" style="width:100%"></label></div>
      <div class="row"><label style="flex:1">設定ファイル（空欄なら analysis.cfg） <input type="text" id="ks-config" style="width:100%"></label></div>
      <div class="row"><button id="ks-save">保存</button></div>
    </details>
    <div class="row">
      <button id="ks-start" class="primary">保存した設定で KataGo を起動（再起動）</button>
      <span class="muted" id="ks-start-note"></span>
    </div>
    <div class="muted" id="ks-folder"></div>
    <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">`;
  $('#tab-settings').prepend(wrap);

  const st = { releases: null, networks: null, setup: null, polling: null };
  const osSel = $('#ks-os');
  osSel.value = detectOS();

  // ---- 現在の状態 ----
  async function refreshSetup() {
    try { st.setup = await api('GET', '/api/katago/setup'); } catch (e) { $('#ks-current').textContent = 'サーバーに接続できません: ' + e.message; return; }
    const { platform, settings, current, status, jobs, folder } = st.setup;
    const srvOS = platform.os;
    $('#ks-os-note').textContent = `ブラウザから判定: ${OS_LABEL[detectOS()] || detectOS()} / サーバー: ${platform.system} ${platform.machine}` +
      (srvOS && srvOS !== osSel.value ? '（※ サーバーの OS と違います。ダウンロードしたファイルはサーバーで実行されます）' : '');
    const lines = [
      `状態: ${status.ok ? (status.ready ? '準備完了' : '起動中') : '停止・未設定'} — ${status.message}`,
      `使用中: ${current.source === 'mock' ? 'モックエンジン' : `${current.katago || '—'} / ${current.model || '—'}`}`,
      `保存済みの設定: 実行ファイル ${settings.katago || '（未設定）'} / モデル ${settings.model || '（未設定）'}${settings.config ? ` / 設定 ${settings.config}` : ''}`,
    ];
    if (current.source === 'command line') lines.push('※ コマンドライン（--katago / --model）の指定で起動中です。保存した設定で起動すると切り替わります。');
    $('#ks-current').textContent = lines.join('\n');
    $('#ks-folder').textContent = `ダウンロード先: ${folder}`;
    if (document.activeElement?.closest('#katago-setup details') == null) {
      $('#ks-katago').value = settings.katago || '';
      $('#ks-model').value = settings.model || '';
      $('#ks-config').value = settings.config || '';
    }
    renderJobs(jobs);
    const active = jobs.some((j) => j.state === 'downloading' || j.state === 'extracting');
    clearTimeout(st.polling);
    if (active) st.polling = setTimeout(refreshSetup, 700);
    return st.setup;
  }

  // ---- ダウンロードの進捗 ----
  const seenDone = new Set();
  function renderJobs(jobs) {
    $('#ks-jobs').innerHTML = jobs.slice().reverse().map((j) => {
      const p = j.total ? Math.min(100, 100 * j.done / j.total) : null;
      const state = { downloading: 'ダウンロード中', extracting: '展開中', done: '完了', error: 'エラー' }[j.state] || j.state;
      return `<div style="margin:6px 0"><div class="row" style="margin:0"><b>${esc(j.name)}</b>
        <span class="${j.state === 'error' ? 'badc' : j.state === 'done' ? 'good' : 'muted'}">${state}</span>
        <span class="muted">${mb(j.done)}${j.total ? ' / ' + mb(j.total) : ''}</span></div>
        ${j.state === 'downloading' || j.state === 'extracting' ? `<div class="progress"><div style="width:${p ?? 100}%"></div></div>` : ''}
        ${j.error ? `<div class="badc">${esc(j.error)}</div>` : ''}${j.path ? `<div class="muted">${esc(j.path)}</div>` : ''}</div>`;
    }).join('');
    // 実行ファイルとモデルがそろったら、KataGo が動いていなければ自動で起動する
    const newlyDone = jobs.filter((j) => j.state === 'done' && !seenDone.has(j.id));
    newlyDone.forEach((j) => seenDone.add(j.id));
    if (newlyDone.length && st.setup && st.setup.settings.katago && st.setup.settings.model && !st.setup.status.ok) startEngine();
  }

  // ---- リリース ----
  function pickRelease() {
    const os = osSel.value;
    const rels = st.releases || [];
    const has = (r, kind) => r.assets.some((a) => a.os === os && (!kind || a.kind === kind));
    return rels.find((r) => !r.prerelease && has(r, 'opencl')) || rels.find((r) => !r.prerelease && has(r)) || rels.find((r) => has(r));
  }
  function renderReleases() {
    const os = osSel.value;
    const rels = st.releases || [];
    const sel = $('#ks-release');
    sel.innerHTML = rels.map((r, i) => {
      const n = r.assets.filter((a) => a.os === os).length;
      return `<option value="${i}" ${n ? '' : 'disabled'}>${esc(r.tag)}（${r.published}${r.prerelease ? '・プレリリース' : ''}、${OS_LABEL[os]} 用 ${n} 件）</option>`;
    }).join('');
    const def = pickRelease();
    if (def) sel.value = rels.indexOf(def);
    renderAssets();
  }
  function renderAssets() {
    const os = osSel.value;
    const rel = (st.releases || [])[+$('#ks-release').value];
    const assets = (rel?.assets || []).filter((a) => a.os === os)
      .sort((a, b) => (BACKEND_ORDER.indexOf(a.kind) + 1 || 99) - (BACKEND_ORDER.indexOf(b.kind) + 1 || 99));
    $('#ks-asset').innerHTML = assets.map((a) => `<option value="${esc(a.url)}" data-name="${esc(a.name)}" data-kind="${esc(a.kind)}">${esc(a.backend)}${a.arch ? ' / ' + a.arch : ''}（${mb(a.size)}）</option>`).join('');
    $('#ks-dl-engine').disabled = !assets.length;
    if (!st.releases) $('#ks-asset-note').textContent = '';
    else if (!assets.length) {
      $('#ks-asset-note').textContent = os === 'macos'
        ? 'このリリースには macOS 用の実行ファイルがありません。Homebrew で「brew install katago」としてから、下の「パスを手動で指定する」で /opt/homebrew/bin/katago などを指定してください。'
        : `このリリースには ${OS_LABEL[os]} 用の実行ファイルがありません。別のリリースを選んでください。`;
    } else updateAssetNote();
  }
  function updateAssetNote() {
    const opt = $('#ks-asset').selectedOptions[0];
    const rel = (st.releases || [])[+$('#ks-release').value];
    if (!opt) return;
    $('#ks-asset-note').innerHTML = `${esc(BACKEND_HINT[opt.dataset.kind] || '')} ` +
      (rel?.url ? `<a href="${esc(rel.url)}" target="_blank" rel="noopener">リリースノート</a>` : '');
  }
  $('#ks-load-releases').onclick = async () => {
    const btn = $('#ks-load-releases');
    btn.disabled = true; $('#ks-asset-note').textContent = '取得中…';
    try { st.releases = (await api('GET', '/api/katago/releases')).releases; renderReleases(); }
    catch (e) { $('#ks-asset-note').textContent = 'リリース一覧を取得できませんでした: ' + e.message; }
    finally { btn.disabled = false; }
  };
  $('#ks-release').onchange = renderAssets;
  $('#ks-asset').onchange = updateAssetNote;
  osSel.onchange = () => { renderReleases(); refreshSetup(); };
  $('#ks-dl-engine').onclick = () => {
    const opt = $('#ks-asset').selectedOptions[0];
    if (opt) download('engine', opt.value, opt.dataset.name);
  };

  // ---- ネットワーク ----
  function renderNetworks() {
    const nets = st.networks?.networks || [];
    $('#ks-network').innerHTML = nets.map((n, i) => `<option value="${i}">${n.strongest ? '★最も強い ' : ''}${n.latest ? '★最新 ' : ''}${esc(n.name)}` +
      `${n.uploaded ? `（${n.uploaded}` : '（'}${n.elo != null ? `、Elo ${n.elo.toFixed(0)}` : ''}）</option>`).join('');
    $('#ks-dl-model').disabled = !nets.length;
    $('#ks-net-quick').hidden = !nets.length;
    pickNetwork('strongest');
  }
  function pickNetwork(kind) {
    const nets = st.networks?.networks || [];
    let i = -1;
    if (kind === 'strongest') i = nets.findIndex((n) => n.strongest);
    if (kind === 'light') {
      // b18c384nbt の中で一番新しいもの（一覧は新しい順）
      i = nets.findIndex((n) => /b18c384nbt/.test(n.name));
      if (i < 0) alert('一覧に b18c384nbt のネットワークが見つかりませんでした。');
    }
    if (i < 0 && kind === 'strongest') i = 0;
    if (i >= 0) $('#ks-network').value = i;
  }
  $$('#ks-net-quick button').forEach((b) => (b.onclick = () => pickNetwork(b.dataset.pick)));
  $('#ks-load-networks').onclick = async () => {
    const btn = $('#ks-load-networks');
    btn.disabled = true;
    try { st.networks = await api('GET', '/api/katago/networks'); renderNetworks(); }
    catch (e) { alert('ネットワーク一覧を取得できませんでした: ' + e.message); }
    finally { btn.disabled = false; }
  };
  $('#ks-dl-model').onclick = () => {
    const n = st.networks?.networks?.[+$('#ks-network').value];
    if (n) download('model', n.url, n.name + '.bin.gz');
  };

  async function download(kind, url, name) {
    try { await api('POST', '/api/katago/download', { kind, url, name }); }
    catch (e) { alert('ダウンロードを開始できませんでした: ' + e.message); return; }
    refreshSetup();
  }

  // ---- 起動 ----
  async function startEngine() {
    $('#ks-start-note').textContent = '起動しています…';
    try {
      const r = await api('POST', '/api/katago/start', {});
      $('#ks-start-note').textContent = r.status.ok ? 'KataGo を起動しました（モデルの読み込みに少し時間がかかります）' : r.status.message;
    } catch (e) { $('#ks-start-note').textContent = e.message; }
    refreshStatus();
    refreshSetup();
  }
  $('#ks-start').onclick = startEngine;
  $('#ks-save').onclick = async () => {
    try {
      await api('POST', '/api/katago/settings', { katago: $('#ks-katago').value, model: $('#ks-model').value, config: $('#ks-config').value });
      $('#ks-start-note').textContent = '保存しました。「保存した設定で KataGo を起動」で反映されます。';
    } catch (e) { alert('保存できませんでした: ' + e.message); }
    refreshSetup();
  };

  // ヘッダーのバッジから開けるようにする（未設定・停止のとき）
  $('#engine-status').style.cursor = 'pointer';
  $('#engine-status').title = 'クリックで KataGo の導入・設定を開く';
  $('#engine-status').addEventListener('click', () => { showTab('settings'); refreshSetup(); });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'settings') refreshSetup(); }));
  refreshSetup();
})();
