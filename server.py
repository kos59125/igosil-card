#!/usr/bin/env python3
"""囲碁シル 定石カードバトル 最適化ツール - ローカルサーバー

ブラウザ UI (static/index.html) を配信し、次の API を提供する。

  GET  /api/status          エンジン状態
  GET  /api/cards           カードリスト (data/cards.json)
  POST /api/cards           カードリストを保存 (UI での手動編集)
  POST /api/cards/update    gonote の記事からカードリストを再取得してマージ
                            body に {"html": "..."} を渡すと、取得の代わりにその HTML/テキストを解析
  POST /api/analyze         KataGo で局面の勝率を計算

標準ライブラリのみで動作する (Python 3.8+)。
"""

import argparse
import collections
import hashlib
import html as htmllib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import katago_setup

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DATA_DIR = os.path.join(ROOT, "data")
CARDS_PATH = os.path.join(DATA_DIR, "cards.json")
# 所持カードのランク（個人の情報なので定石データとは別に保存し、git の管理対象から外す）
RANKS_PATH = os.path.join(DATA_DIR, "ranks.json")
IGOSIL_PATH = os.path.join(DATA_DIR, "igosil.json")  # 囲碁シル AI の勝率の記録（個人のデータなので git の管理対象外）
CARD_SOURCE_URL = "https://gonote-app.com/article/TSqUCWy46aAwyoUyrix2"

GTP_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"  # I を飛ばす


def log(*args):
    print("[server]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 解析エンジン
# ---------------------------------------------------------------------------

def to_gtp(x, y, size):
    """(x, y) は左上原点 0-index。GTP 座標は左下原点で I を飛ばす。"""
    return f"{GTP_LETTERS[x]}{size - y}"


def pos_komi(pos, params):
    """局面ごとのコミ (アゲハマを織り込んだ値)。指定が無ければ共通のコミ。0.5 刻みに丸める。"""
    komi = pos.get("komi")
    komi = params["komi"] if komi is None else float(komi)
    return max(-150.0, min(150.0, round(komi * 2) / 2))


class _Tagged:
    """KataGo の応答を、要求ごとの共有キューに局面番号つきで流す。"""

    def __init__(self, q, idx):
        self.q, self.idx = q, idx

    def put(self, resp):
        self.q.put((self.idx, resp))


class KataGoEngine:
    """KataGo の analysis エンジンをサブプロセスとして常駐させる。"""

    name = "katago"

    def __init__(self, katago, model, config, extra_args=None):
        cmd = [katago, "analysis", "-config", config, "-model", model,
               # 勝率は常に黒視点で受け取り、サーバー側で白視点に変換する
               "-override-config", "reportAnalysisWinratesAs=BLACK"]
        if extra_args:
            cmd += extra_args
        log("starting:", " ".join(cmd))
        self.model = os.path.basename(model)
        self.katago, self.model_path, self.config = katago, model, config
        self.version = None  # 起動確認の応答から取得
        self.stderr_tail = collections.deque(maxlen=20)  # 異常終了時の原因表示用
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, encoding="utf-8")
        self.lock = threading.Lock()
        self.waiters = {}
        self.counter = 0
        self.ready = threading.Event()
        self.error = None
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        # KataGo はモデルの読み込みが終わってから標準入力を読み始めるので、
        # この問い合わせに応答が返ってきた時点を「準備完了」とみなす
        # (logToStderr = false の設定では "ready" のログが標準エラーに出ないため)
        self.proc.stdin.write(json.dumps({"id": "startup-probe", "action": "query_version"}) + "\n")
        self.proc.stdin.flush()

    def _read_stderr(self):
        for line in self.proc.stderr:
            line = line.rstrip()
            if line:
                self.stderr_tail.append(line)
            if "ready to begin handling requests" in line.lower() or "started, ready" in line.lower():
                self.ready.set()
            log("katago:", line)
        code = self.proc.wait()
        last = next((l for l in reversed(self.stderr_tail) if l.strip()), "")
        self.error = f"KataGo が終了しました (code={code})" + (f": {last}" if last else "")
        self.ready.set()
        self._fail_all(self.error)

    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                resp = json.loads(line)
            except ValueError:
                log("katago(stdout):", line)
                continue
            if resp.get("id") == "startup-probe":
                self.version = resp.get("version")
            if not self.ready.is_set():
                log("KataGo の準備ができました", resp.get("version", ""), f"(model: {self.model})")
            self.ready.set()
            qid = resp.get("id")
            with self.lock:
                q = self.waiters.pop(qid, None)
            if q is not None:
                q.put(resp)
            elif "error" in resp:
                log("katago error:", line[:200])

    def _fail_all(self, msg):
        with self.lock:
            waiters, self.waiters = self.waiters, {}
        for q in waiters.values():
            q.put({"error": msg})

    def stop(self):
        """KataGo を終了する（設定変更で起動し直すとき）。"""
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.proc.kill()

    def status(self):
        info = {"engine": self.name, "version": self.version, "model": self.model}
        if self.proc.poll() is not None:
            return {**info, "ok": False, "ready": False, "message": self.error or "KataGo が起動していません"}
        ready = self.ready.is_set()
        return {**info, "ok": True, "ready": ready,
                "message": "準備完了" if ready else "起動中 (モデル読み込み中)…"}

    def analyze(self, positions, params, on_result=None, timeout=600):
        """positions: [{"stones": [[color, x, y], ...], "komi"?: float}] → [{"winrateWhite", "scoreLeadWhite", "visits"} | {"error"}]

        on_result(i, result) は各局面の解析が終わるたびに (完了順で) 呼ばれる。
        """
        if self.proc.poll() is not None:
            raise RuntimeError(self.error or "KataGo が起動していません")
        size = params["boardSize"]
        done_q = queue.Queue()  # この要求の全局面の結果を完了順に受け取る
        qids = []
        for idx, pos in enumerate(positions):
            with self.lock:
                self.counter += 1
                qid = f"q{self.counter}"
                self.waiters[qid] = _Tagged(done_q, idx)
            qids.append(qid)
            query = {
                "id": qid,
                "initialStones": [[c, to_gtp(x, y, size)] for c, x, y in pos["stones"]],
                "moves": [],
                "initialPlayer": params["nextPlayer"],
                "rules": params["rules"],
                "komi": pos_komi(pos, params),
                "boardXSize": size,
                "boardYSize": size,
                "maxVisits": params["visits"],
            }
            self.proc.stdin.write(json.dumps(query) + "\n")
        self.proc.stdin.flush()

        try:
            return self._collect(positions, done_q, on_result, timeout)
        finally:
            self._terminate_unfinished(qids)

    def _terminate_unfinished(self, qids):
        """中止 (クライアント切断) やタイムアウトで残った問い合わせを KataGo 側でも打ち切る。"""
        with self.lock:
            left = [q for q in qids if self.waiters.pop(q, None) is not None]
        if not left or self.proc.poll() is not None:
            return
        log(f"  未完了の {len(left)} 局面の解析を打ち切ります")
        try:
            for q in left:
                self.proc.stdin.write(json.dumps({"id": f"t{q}", "action": "terminate", "terminateId": q}) + "\n")
            self.proc.stdin.flush()
        except OSError:
            pass

    def _collect(self, positions, done_q, on_result, timeout):
        deadline = time.time() + timeout
        results = [None] * len(positions)
        last_log = time.time()
        for done in range(len(positions)):
            if len(positions) > 1 and time.time() - last_log >= 2.0:
                last_log = time.time()
                log(f"  … KataGo 解析中 {done}/{len(positions)}")
            try:
                idx, resp = done_q.get(timeout=max(1, deadline - time.time()))
            except queue.Empty:
                break
            if "error" in resp:
                result = {"error": resp["error"]}
            else:
                root = resp.get("rootInfo", {})
                wr_b = root.get("winrate")
                lead_b = root.get("scoreLead")
                result = {
                    "winrateWhite": None if wr_b is None else 1.0 - wr_b,
                    "scoreLeadWhite": None if lead_b is None else -lead_b,
                    "visits": root.get("visits"),
                }
            results[idx] = result
            if on_result:
                on_result(idx, result)
        for idx, r in enumerate(results):
            if r is None:
                results[idx] = {"error": "timeout"}
                if on_result:
                    on_result(idx, results[idx])
        return results


class NoEngine:
    """KataGo が未設定・起動できなかったときの代わり。設定タブから導入・起動できる。"""

    name = "none"

    def __init__(self, message="KataGo が未設定です（「設定」タブの「KataGo の導入」から設定してください）"):
        self.message = message

    def status(self):
        return {"engine": self.name, "version": None, "model": None, "ok": False, "ready": False,
                "setup": True, "message": self.message}

    def analyze(self, positions, params, on_result=None, timeout=0):
        raise RuntimeError(self.message)

    def stop(self):
        pass


def build_engine(katago, model, config):
    """KataGo を起動する。起動できなければ理由つきの NoEngine を返す。"""
    if not model:
        return NoEngine()
    if not os.path.exists(model):
        return NoEngine(f"モデルファイルが見つかりません: {model}")
    if os.sep in katago or (os.altsep and os.altsep in katago):
        if not os.path.exists(katago):
            return NoEngine(f"KataGo の実行ファイルが見つかりません: {katago}")
    elif not shutil.which(katago):
        return NoEngine(f"KataGo の実行ファイル「{katago}」が PATH に見つかりません")
    try:
        return KataGoEngine(katago, model, config)
    except OSError as e:
        return NoEngine(f"KataGo を起動できませんでした: {e}")


class MockEngine:
    """KataGo が無い環境で UI を試すための疑似エンジン。結果に意味はない。"""

    name = "mock"

    def __init__(self, delay=0.002):
        self.delay = delay  # 1 局面あたりの疑似的な解析時間 (秒)

    def status(self):
        return {"engine": self.name, "version": "mock", "model": "mock", "ok": True, "ready": True,
                "message": "モックエンジン (勝率は疑似値です)"}

    def analyze(self, positions, params, on_result=None, timeout=0):
        size = params["boardSize"]
        out = []
        for idx, pos in enumerate(positions):
            score = 0.0
            for c, x, y in pos["stones"]:
                line = min(x, y, size - 1 - x, size - 1 - y) + 1
                value = {1: 0.2, 2: 0.7, 3: 1.0, 4: 1.0, 5: 0.8}.get(line, 0.6)
                score += value if c == "W" else -value
            h = hashlib.md5(json.dumps(sorted(pos["stones"])).encode()).digest()
            score += (h[0] / 255.0 - 0.5) * 3.0
            score += pos_komi(pos, params) - 6.5
            if params["nextPlayer"] == "W":
                score += 6.5
            winrate = 1.0 / (1.0 + pow(2.718281828, -score / 4.0))
            out.append({"winrateWhite": winrate, "scoreLeadWhite": score, "visits": params["visits"]})
            time.sleep(self.delay)
            if on_result:
                on_result(idx, out[-1])
        return out


class CachedEngine:
    def __init__(self, engine, max_entries=1000000):
        self.engine = engine
        self.cache = {}
        self.max_entries = max_entries
        self.lock = threading.Lock()
        self.requests = 0

    def status(self):
        s = self.engine.status()
        s["cacheSize"] = len(self.cache)
        return s

    @staticmethod
    def _key(pos, params):
        payload = json.dumps([sorted(map(list, pos["stones"])), pos_komi(pos, params), params], sort_keys=True)
        return hashlib.sha1(payload.encode()).hexdigest()

    def analyze(self, positions, params, on_result=None):
        with self.lock:
            self.requests += 1
            req = self.requests
        t0 = time.time()
        keys = [self._key(p, params) for p in positions]
        results = [None] * len(positions)
        todo = []
        with self.lock:
            for i, k in enumerate(keys):
                if k in self.cache:
                    results[i] = dict(self.cache[k], cached=True)
                else:
                    todo.append(i)
        log(f"[解析 #{req}] {len(positions)} 局面 (キャッシュ {len(positions) - len(todo)}, "
            f"新規 {len(todo)}, {params['visits']} visits)")
        if on_result:
            for i, r in enumerate(results):
                if r is not None:
                    on_result(i, r)
        if todo:
            def fresh_result(j, r):
                i = todo[j]
                results[i] = r
                if "error" not in r:
                    with self.lock:
                        # 上限を超えたら古いものから捨てる (dict は挿入順を保つ)
                        while len(self.cache) >= self.max_entries:
                            self.cache.pop(next(iter(self.cache)))
                        self.cache[keys[i]] = r
                if on_result:
                    on_result(i, r)
            self.engine.analyze([positions[i] for i in todo], params, on_result=fresh_result)
        elapsed = time.time() - t0
        errors = sum(1 for r in results if r and "error" in r)
        rate = f", {len(todo) / elapsed:.1f} 局面/秒" if todo and elapsed > 0 else ""
        log(f"[解析 #{req}] 完了 {elapsed:.1f} 秒{rate}" + (f", エラー {errors} 件" if errors else ""))
        return results


# ---------------------------------------------------------------------------
# カードリスト
# ---------------------------------------------------------------------------

ATTRS = ("地", "宙", "海")
SGF_RE = re.compile(r"\(\s*;(?:[^()\"\\]|\\.)*?(?:[BW]\[[a-s]{2}\]|A[BW]\[[a-s]{2}\])(?:[^()\"\\]|\\.)*\)")
SGF_MOVE_RE = re.compile(r"(?<![A-Z])(B|W|AB|AW)((?:\[[a-s]{0,2}\]\s*)+)")
TAG_RE = re.compile(r"<[^>]+>")


def load_ranks():
    try:
        with open(RANKS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {k: int(v) for k, v in (data.get("ranks") or {}).items() if 1 <= int(v) <= 5}
    except (OSError, ValueError, TypeError):
        return {}


IGOSIL_LOCK = threading.Lock()


def load_igosil():
    """囲碁シル AI の勝率の記録: 配置のキー → { wrWhite: 白の勝率 (0〜1), at: 記録日時, label: 配置の説明 }"""
    try:
        with open(IGOSIL_PATH, encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for k, v in (data.get("records") or {}).items():
            w = float(v.get("wrWhite"))
            if 0 <= w <= 1:
                out[str(k)] = {"wrWhite": w, "at": str(v.get("at") or ""), "label": str(v.get("label") or "")}
        return out
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def save_igosil_record(key, wr_white, label=""):
    """1 件の記録を追加・更新する。wr_white が None なら削除"""
    key = str(key or "").strip()
    if not key or len(key) > 400:
        raise ValueError("配置のキーが正しくありません")
    with IGOSIL_LOCK:
        records = load_igosil()
        if wr_white is None:
            records.pop(key, None)
        else:
            w = float(wr_white)
            if not 0 <= w <= 1:
                raise ValueError("勝率は 0〜100% で指定してください")
            records[key] = {"wrWhite": round(w, 5), "at": time.strftime("%Y-%m-%d %H:%M"), "label": str(label or "")[:300]}
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = IGOSIL_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"records": records}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, IGOSIL_PATH)
        return records


def save_ranks(ranks):
    clean = {str(k): int(v) for k, v in ranks.items() if v is not None and 1 <= int(v) <= 5}
    # 見て分かるように、カード名も添えて保存する（読み込みには使わない）
    names = {}
    try:
        names = {c["id"]: f'{c.get("slot", "")}: {c.get("name", "")}' for c in load_cards().get("cards", [])}
    except (OSError, ValueError, KeyError):
        pass
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = RANKS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ranks": clean, "names": {k: names.get(k, "") for k in clean}}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, RANKS_PATH)
    return clean


def load_cards():
    if not os.path.exists(CARDS_PATH):
        return {"cards": [], "isEmpty": True}
    with open(CARDS_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_cards(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    data = {k: v for k, v in data.items() if k != "isEmpty"}
    if os.path.exists(CARDS_PATH):
        shutil.copyfile(CARDS_PATH, CARDS_PATH + ".bak")
    tmp = CARDS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CARDS_PATH)


def sgf_moves(sgf):
    """SGF 文字列から [[color, "pd"], ...] を取り出す (分岐は無視し主線のみ)。"""
    moves = []
    for prop, values in SGF_MOVE_RE.findall(sgf):
        color = prop[-1]
        for v in re.findall(r"\[([a-s]{0,2})\]", values):
            if len(v) == 2:  # 空はパス
                moves.append([color, v])
    return moves


def sgf_prop(sgf, name):
    m = re.search(r"(?<![A-Z])" + name + r"\[((?:[^\]\\]|\\.)*)\]", sgf)
    return m.group(1).replace("\\]", "]") if m else ""


def _unescape_page(raw):
    """HTML 内に JSON 文字列として埋め込まれたデータも拾えるようにする。"""
    text = raw.replace("\\u003c", "<").replace("\\u003e", ">").replace("\\u0026", "&")
    text = text.replace('\\"', '"').replace("\\n", "\n").replace("\\/", "/")
    return text


def _to_text(fragment):
    # SGF が属性値やスクリプト中にある場合、直前の閉じていないタグ・スクリプトを除く
    fragment = re.sub(r"(?is)<(script|style)\b[^>]*>(?:(?!</\1>).)*$", " ", fragment)
    fragment = re.sub(r"<[^<>]*$", " ", fragment)
    fragment = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", fragment)
    fragment = re.sub(r"(?i)<br\s*/?>|</(p|div|h\d|li|tr|td|th|figcaption|section)>", "\n", fragment)
    fragment = htmllib.unescape(TAG_RE.sub(" ", fragment))
    return [ln.strip() for ln in fragment.splitlines() if ln.strip()]


def _info_from_lines(lines):
    """カード名・属性・配置可能箇所を周辺テキストから推定する。"""
    attr = slot = name = ""
    for ln in reversed(lines[-8:]):
        if not attr:
            m = re.search(r"([地宙海])\s*(?:属性|タイプ)|(?:属性|タイプ)\s*[:：]?\s*[【\[(（]?([地宙海])|[【\[(（]([地宙海])[】\])）]|^([地宙海])$", ln)
            if m:
                attr = next(g for g in m.groups() if g)
        if not slot:
            m = re.search(r"(?:配置|箇所|位置|タイプ|type)\s*[:：]?\s*[【\[(（]?([AB])\b|[【\[(（]([AB])[】\])）]|(?<![A-Za-z])([AB])(?:カード|配置)|[】\])）]\s*([AB])(?![A-Za-z])|^([AB])(?![A-Za-z])", ln, re.I)
            if m:
                slot = next(g for g in m.groups() if g).upper()
        if not name:
            cleaned = re.sub(r"[【\[(（][^】\])）]{0,6}[】\])）]|属性|配置可能箇所|配置|[:：]", " ", ln).strip()
            cleaned = re.sub(r"^\s*[AB](?![A-Za-z])|(?<![A-Za-z])[AB]\s*$", " ", cleaned)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if 2 <= len(cleaned) <= 40 and not re.search(r"[{}=<>\"]", cleaned) and not re.fullmatch(r"[地宙海AB\s/・,、]+", cleaned):
                name = cleaned
    return name, attr, slot


# --- SGF (分岐あり) の木構造パーサー -------------------------------------------

def parse_sgf_tree(sgf):
    """SGF を {"props": {id: [values]}, "children": [...]} の木にする。返り値は最初のノード。"""
    i, n = 0, len(sgf)

    def skip_ws():
        nonlocal i
        while i < n and sgf[i].isspace():
            i += 1

    def parse_value():
        nonlocal i
        i += 1  # '['
        buf = []
        while i < n and sgf[i] != "]":
            if sgf[i] == "\\" and i + 1 < n:
                i += 1
            buf.append(sgf[i])
            i += 1
        i += 1  # ']'
        return "".join(buf)

    def parse_node():
        nonlocal i
        i += 1  # ';'
        props = {}
        while True:
            skip_ws()
            m = re.match(r"[A-Za-z]+", sgf[i:i + 16]) if i < n else None
            if not m:
                break
            ident = m.group(0)
            i += len(ident)
            vals = []
            skip_ws()
            while i < n and sgf[i] == "[":
                vals.append(parse_value())
                skip_ws()
            props[ident] = props.get(ident, []) + vals
        return {"props": props, "children": []}

    def parse_sequence():
        """'(' から対応する ')' まで。最初のノードを返す。"""
        nonlocal i
        i += 1  # '('
        first = last = None
        while True:
            skip_ws()
            if i >= n:
                break
            ch = sgf[i]
            if ch == ";":
                node = parse_node()
                if last is None:
                    first = node
                else:
                    last["children"].append(node)
                last = node
            elif ch == "(":
                child = parse_sequence()
                if child is not None:
                    if last is None:
                        first = last = child
                    else:
                        last["children"].append(child)
            elif ch == ")":
                i += 1
                break
            else:
                i += 1
        return first

    skip_ws()
    while i < n and sgf[i] != "(":
        i += 1
    return parse_sequence() if i < n else None


def _node_moves(props):
    moves = []
    for key, color in (("AB", "B"), ("AW", "W"), ("B", "B"), ("W", "W")):
        for v in props.get(key, []):
            if len(v) == 2 and v != "tt":
                moves.append([color, v])
    return moves


def _sgf_named_lines(sgf):
    """コメント (C) が付いたノードまでの手順を [(コメント, moves), ...] で返す。"""
    root = parse_sgf_tree(sgf)
    out = []
    stack = [(root, [])] if root else []
    while stack:
        node, path = stack.pop()
        path = path + _node_moves(node["props"])
        for c in node["props"].get("C", []):
            if c.strip():
                out.append((c.strip(), path))
        for child in reversed(node["children"]):
            stack.append((child, path))
    return out


def _norm(name):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", name))


def _strip_html(s):
    return htmllib.unescape(TAG_RE.sub("", s or "")).strip()


FOCUS_TO_HOME = {"top-right": "TR", "top-left": "TL", "bottom-right": "BR", "bottom-left": "BL"}


def parse_gonote_article(raw):
    """gonote の記事データ (window.__INITIAL_DATA__) から定石カードを抽出する。

    記事は「見出し → カード表 (#, 定石カード名称, 属性, 配置) → 碁盤 (分岐つき SGF)」の繰り返しで、
    SGF の各分岐の最終手にカード名がコメントとして付いている。
    該当する構造が無ければ None を返す。
    """
    m = re.search(r"window\.__INITIAL_DATA__\s*=\s*(\{.*?\});?\s*</script>", raw, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
        items = data["data"]["contentData"]["items"]
    except (ValueError, KeyError, TypeError):
        return None

    cards, warnings = [], []
    section, table_rows = "", []

    def flush(board):
        nonlocal table_rows
        lines = _sgf_named_lines(board["sgf"]) if board else []
        home = FOCUS_TO_HOME.get(((board or {}).get("settings") or {}).get("focusMode"), "")
        used = set()
        by_name = {}
        for comment, moves in lines:
            key = _norm(comment)
            if key in by_name:
                warnings.append(f"[{section}] SGF にコメント「{comment}」が複数あります (最初の分岐を使用)")
                continue
            by_name[key] = moves
        for row in table_rows:
            name, attr, slot = row
            key = _norm(name)
            moves = by_name.get(key)
            if moves is None:  # コメントに補足が付いている場合
                moves = next((mv for k, mv in by_name.items() if key and (key in k or k in key)), None)
                if moves is not None:
                    key = next(k for k, mv in by_name.items() if mv is moves)
            if moves is None:
                warnings.append(f"[{section}] 「{name}」の手順が SGF に見つかりません (手動で入力してください)")
                moves = []
            used.add(key)
            card = {"name": name, "attr": attr, "slot": slot, "group": section, "moves": moves}
            if home:
                card["home"] = home
            cards.append(card)
        for k in by_name:
            if k not in used:
                warnings.append(f"[{section}] SGF の分岐「{k}」に対応するカードが表にありません")
        table_rows = []

    for it in items:
        kind = it.get("type")
        if kind == "text-editor":
            h = re.search(r"<h[1-3][^>]*>(.*?)</h[1-3]>", it.get("content", ""), re.S)
            if h:
                if table_rows:
                    flush(None)
                section = _strip_html(h.group(1))
        elif kind == "table-editor":
            rows = (it.get("tableData") or {}).get("rows") or []
            header = [_strip_html(c) for c in rows[0]["cells"]] if rows else []
            try:
                ci_name = next(i for i, h in enumerate(header) if "名" in h)
                ci_attr = header.index("属性")
                ci_slot = header.index("配置")
            except (StopIteration, ValueError):
                continue
            for r in rows[1:]:
                cells = [_strip_html(c) for c in r["cells"]]
                if len(cells) <= max(ci_name, ci_attr, ci_slot) or not cells[ci_name]:
                    continue
                attr = cells[ci_attr] if cells[ci_attr] in ATTRS else ""
                slot = cells[ci_slot].upper() if cells[ci_slot].upper() in ("A", "B") else ""
                if not attr or not slot:
                    warnings.append(f"[{section}] 「{cells[ci_name]}」の属性/配置が不明です: {cells[ci_attr]} / {cells[ci_slot]}")
                table_rows.append((cells[ci_name], attr, slot))
        elif kind == "go-board" and it.get("sgf"):
            flush(it)
    if table_rows:
        flush(None)
    return cards, warnings


def parse_card_page(raw):
    """gonote の記事 (HTML / JSON 埋め込み / プレーンテキスト) から定石カードを抽出する。"""
    parsed = parse_gonote_article(raw)
    if parsed and parsed[0]:
        return parsed
    cards, warnings = parse_card_page_heuristic(raw)
    warnings.insert(0, "記事データの構造を認識できなかったため、推定で抽出しました。結果を確認してください。")
    return cards, warnings


def parse_card_page_heuristic(raw):
    """記事の構造が変わった場合の予備。次のヒューリスティックで抽出する:
      1. ページ中の SGF 文字列を順に探し、各 SGF の直前のテキストからカード名・属性・A/B を推定
      2. SGF が無い場合、属性と A/B を含む行をカードとみなす (手順は手動入力)
    """
    text = _unescape_page(raw)
    cards, warnings = [], []
    pos = 0
    seen = set()
    for m in SGF_RE.finditer(text):
        sgf = m.group(0)
        lines = _to_text(text[pos:m.start()])
        pos = m.end()
        moves = sgf_moves(sgf)
        if not moves:
            continue
        key = json.dumps(moves)
        if key in seen:
            continue
        seen.add(key)
        name, attr, slot = _info_from_lines(lines)
        gn = sgf_prop(sgf, "GN") or sgf_prop(sgf, "N")
        comment = sgf_prop(sgf, "C") + " " + gn
        if not attr:
            m2 = re.search(r"[地宙海]", comment)
            attr = m2.group(0) if m2 else ""
        if not slot:
            m2 = re.search(r"(?<![A-Za-z])([AB])(?![A-Za-z])", comment)
            slot = m2.group(1) if m2 else ""
        cards.append({"name": gn or name or f"カード{len(cards) + 1}", "attr": attr, "slot": slot, "moves": moves})

    if not cards:
        warnings.append("SGF が見つからなかったため、テキストからカード名・属性・配置のみ抽出しました。手順は手動で入力してください。")
        for ln in _to_text(text):
            m_attr = re.search(r"[【\[(（]?([地宙海])(?:属性)?[】\])）]?", ln)
            m_slot = re.search(r"(?<![A-Za-z])([AB])(?![A-Za-z])", ln)
            if not (m_attr and m_slot) or len(ln) > 60:
                continue
            name = re.sub(r"[【\[(（]?[地宙海](?:属性)?[】\])）]?|(?<![A-Za-z])[AB](?![A-Za-z])|[|｜/:：]", " ", ln)
            name = re.sub(r"\s+", " ", name).strip()
            if len(name) < 2:
                continue
            cards.append({"name": name, "attr": m_attr.group(1), "slot": m_slot.group(1), "moves": []})

    for c in cards:
        if c["attr"] not in ATTRS:
            warnings.append(f"「{c['name']}」の属性を判定できませんでした")
        if c["slot"] not in ("A", "B"):
            # 石の重心から推定 (上半分 → A, 下半分 → B)
            if c["moves"]:
                ys = [ord(v[1]) - 97 for _, v in c["moves"]]
                c["slot"] = "A" if sum(ys) / len(ys) < 9 else "B"
                warnings.append(f"「{c['name']}」の配置 (A/B) を石の位置から推定しました: {c['slot']}")
            else:
                warnings.append(f"「{c['name']}」の配置 (A/B) を判定できませんでした")
    return cards, warnings


def card_id(name, slot):
    return hashlib.sha1(f"{slot}:{name}".encode()).hexdigest()[:10]


def merge_cards(old_cards, new_cards):
    """新しいリストを正としつつ、手動で入力した手順・修正は残す。"""
    by_key = {(c["name"], c.get("slot")): c for c in old_cards}
    merged, added, updated = [], [], []
    for nc in new_cards:
        oc = by_key.pop((nc["name"], nc.get("slot")), None)
        card = {"id": card_id(nc["name"], nc.get("slot", "")), **nc}
        if oc:
            card["id"] = oc.get("id", card["id"])
            if oc.get("manual"):
                # 手動で編集したカードは手順・属性を保持
                card.update({k: oc[k] for k in ("moves", "attr", "slot", "manual") if k in oc})
            elif not card["moves"] and oc.get("moves"):
                card["moves"] = oc["moves"]
            if card.get("moves") != oc.get("moves") or card.get("attr") != oc.get("attr"):
                updated.append(card["name"])
        else:
            added.append(card["name"])
        card.pop("retired", None)
        merged.append(card)
    removed = []
    for oc in by_key.values():
        # 記事から消えたカードも削除はせず、退役扱いにして残す
        removed.append(oc["name"])
        merged.append({**oc, "retired": True})
    return merged, added, updated, removed


def fetch_page(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (igosil-card-optimizer)",
        "Accept-Language": "ja,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 で接続を使い回す（keep-alive）。最適化は解析リクエストを大量に送るので、
    # リクエストごとに接続を閉じると TIME_WAIT のソケットがたまり、Windows ではポートが枯渇して
    # 「Failed to fetch」（net::ERR_NO_BUFFER_SPACE）になる。応答には必ず長さ（Content-Length か chunked）を付ける
    protocol_version = "HTTP/1.1"
    timeout = 300  # 使われなくなった接続を閉じるまでの秒数
    disable_nagle_algorithm = True  # 接続を使い回すと、小さな応答が Nagle で数十ミリ秒待たされるため
    engine = None
    cards_lock = threading.Lock()
    engine_lock = threading.Lock()
    engine_args = {"katago": None, "model": None, "config": None, "source": None}
    downloads = katago_setup.Downloads()

    @classmethod
    def switch_engine(cls, katago, model, config, source):
        """KataGo を（再）起動する。局面のキャッシュはモデルが変わるので作り直す。"""
        with cls.engine_lock:
            old = cls.engine.engine if cls.engine else None
            if old is not None and hasattr(old, "stop"):
                old.stop()
            engine = build_engine(katago, model, config)
            cls.engine = CachedEngine(engine)
            cls.engine_args = {"katago": katago, "model": model, "config": config, "source": source}
            log(f"engine: {engine.name}", engine.status().get("message", ""))
            return engine

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        # args の先頭はリクエスト行のことも、エラー時の HTTPStatus のこともあるので文字列にしてから判定する
        msg = fmt % args
        if "/api/analyze" not in msg:
            log(self.address_string(), msg)

    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def parse_request(self):
        self._raw_body = None  # 同じ接続で次のリクエストが来るたびに読み直す
        return super().parse_request()

    def _body_raw(self):
        """リクエストの本文（1 回だけ読む）"""
        if self._raw_body is None:
            length = int(self.headers.get("Content-Length") or 0)
            self._raw_body = self.rfile.read(length) if length > 0 else b""
        return self._raw_body

    def _body(self):
        raw = self._body_raw()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_GET(self):
        if self.path == "/api/status":
            return self._json(self.engine.status())
        if self.path.startswith("/api/katago/"):
            try:
                return self._katago_get(self.path[len("/api/katago/"):])
            except Exception as e:  # noqa: BLE001
                log("error:", repr(e))
                return self._json({"error": str(e)}, HTTPStatus.BAD_GATEWAY)
        if self.path == "/api/ranks":
            return self._json({"ranks": load_ranks()})
        if self.path == "/api/igosil":
            return self._json({"records": load_igosil()})
        if self.path == "/api/cards":
            with self.cards_lock:
                return self._json(load_cards())
        if self.path == "/favicon.ico":
            # <link rel="icon"> を見ずに /favicon.ico を取りに来るブラウザ向け
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", "/favicon.svg")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/analyze":
                return self._analyze()
            if self.path == "/api/igosil":
                body = self._body()
                try:
                    records = save_igosil_record(body.get("key"), body.get("wrWhite"), body.get("label"))
                except (ValueError, TypeError) as e:
                    return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
                return self._json({"records": records})
            if self.path == "/api/ranks":
                body = self._body()
                return self._json({"ranks": save_ranks(body.get("ranks") or {})})
            if self.path == "/api/cards":
                body = self._body()
                with self.cards_lock:
                    data = load_cards()
                    data["cards"] = body["cards"]
                    data["editedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                    save_cards(data)
                return self._json({"ok": True})
            if self.path == "/api/cards/update":
                return self._update_cards()
            if self.path.startswith("/api/katago/"):
                return self._katago_post(self.path[len("/api/katago/"):])
            self._body_raw()  # 本文を読み捨ててから応答する（接続を次のリクエストに使い回すため）
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except Exception as e:  # noqa: BLE001 - UI にそのまま表示する
            log("error:", repr(e))
            self.close_connection = True
            self._json({"error": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    # ---- KataGo の導入 ----
    def _katago_get(self, what):
        if what == "setup":
            settings = katago_setup.load_settings()
            return self._json({
                "platform": katago_setup.server_platform(), "settings": settings, "current": self.engine_args,
                "defaultConfig": os.path.join(ROOT, "analysis.cfg"), "status": self.engine.status(),
                "jobs": self.downloads.snapshot(), "folder": katago_setup.KATAGO_DIR,
            })
        if what == "releases":
            return self._json({"releases": katago_setup.list_releases()})
        if what == "networks":
            return self._json(katago_setup.list_networks())
        return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def _katago_post(self, what):
        body = self._body()
        if what == "download":
            try:
                job = self.downloads.start(body.get("kind"), body.get("url", ""), body.get("name"))
            except ValueError as e:
                return self._json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            return self._json({"job": job})
        if what == "settings":
            # 手動で指定したパスを保存する（空欄は変更しない）
            data = katago_setup.save_settings(**{k: (body.get(k) or "").strip() or None for k in ("katago", "model", "config")})
            return self._json({"settings": data})
        if what == "start":
            if self.engine_args.get("source") == "mock":
                return self._json({"error": "モックエンジンで起動中です。KataGo を使うには --mock を付けずに起動し直してください。"},
                                  HTTPStatus.CONFLICT)
            s = katago_setup.load_settings()
            katago = s.get("katago") or "katago"
            config = s.get("config") or os.path.join(ROOT, "analysis.cfg")
            engine = self.switch_engine(katago, s.get("model"), config, "settings")
            return self._json({"status": engine.status()})
        return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def _analyze(self):
        body = self._body()
        params = {
            "boardSize": int(body.get("boardSize", 19)),
            "komi": float(body.get("komi", 6.5)),
            "rules": str(body.get("rules", "japanese")),
            "nextPlayer": "W" if body.get("nextPlayer") == "W" else "B",
            "visits": max(1, min(10000, int(body.get("visits", 1)))),
        }
        positions = body.get("positions", [])
        if not body.get("stream"):
            return self._json({"results": self.engine.analyze(positions, params)})
        # 1 局面終わるごとに 1 行 (NDJSON) 送り、UI で経過を表示できるようにする。
        # 長さが事前に分からないので chunked で送り、接続は次のリクエストに使い回す
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send(obj):
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()
        try:
            try:
                self.engine.analyze(positions, params, on_result=lambda i, r: send({"i": i, "result": r}))
                send({"done": True})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                raise
            except Exception as e:  # noqa: BLE001
                send({"error": str(e)})
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            log("analyze: クライアントが切断しました")
            self.close_connection = True

    def _update_cards(self):
        body = self._body()
        url = body.get("url") or CARD_SOURCE_URL
        if body.get("html"):
            raw, source = body["html"], "pasted"
        else:
            try:
                raw, source = fetch_page(url), url
            except Exception as e:  # noqa: BLE001
                return self._json({"error": f"カードリストの取得に失敗しました: {e}"}, HTTPStatus.BAD_GATEWAY)
        new_cards, warnings = parse_card_page(raw)
        if not new_cards:
            return self._json({"error": "カードを抽出できませんでした。ページ構造が変わった可能性があります。",
                               "warnings": warnings}, HTTPStatus.UNPROCESSABLE_ENTITY)
        if body.get("dryRun"):
            return self._json({"cards": new_cards, "warnings": warnings})
        with self.cards_lock:
            data = load_cards()
            old = data.get("cards", [])
            merged, added, updated, removed = merge_cards(old, new_cards)
            data = {"source": source, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "cards": merged}
            save_cards(data)
        self._json({"ok": True, "added": added, "updated": updated, "removed": removed,
                    "warnings": warnings, "count": len(new_cards)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--katago", default=os.environ.get("KATAGO_PATH"),
                    help="KataGo 実行ファイル（省略時は画面からダウンロード・設定したもの、無ければ PATH の katago）")
    ap.add_argument("--model", default=os.environ.get("KATAGO_MODEL"),
                    help="KataGo のモデルファイル .bin.gz（省略時は画面からダウンロード・設定したもの）")
    ap.add_argument("--config", default=os.environ.get("KATAGO_CONFIG"),
                    help="KataGo analysis 用の設定ファイル（省略時は analysis.cfg）")
    ap.add_argument("--mock", action="store_true", help="KataGo を使わず疑似エンジンで起動 (UI 確認用)")
    ap.add_argument("--mock-delay", type=float, default=0.002, help="モックエンジンの 1 局面あたりの解析時間 (秒)")
    args = ap.parse_args()

    if args.mock:
        engine = MockEngine(args.mock_delay)
        Handler.engine = CachedEngine(engine)
        Handler.engine_args = {"katago": None, "model": None, "config": None, "source": "mock"}
    else:
        # 優先順位: コマンドライン / 環境変数 > 画面で設定したもの (katago/settings.json) > PATH の katago
        saved = katago_setup.load_settings()
        cli = bool(args.katago or args.model)
        katago = args.katago or saved.get("katago") or "katago"
        model = args.model or saved.get("model")
        config = args.config or saved.get("config") or os.path.join(ROOT, "analysis.cfg")
        engine = Handler.switch_engine(katago, model, config, "command line" if cli else "settings")
        if engine.name == "none":
            log("KataGo が未設定です。ブラウザの「設定」タブの「KataGo の導入」からダウンロード・設定できます。")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"http://{args.host}:{args.port}/ を開いてください (engine={engine.name})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
