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
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DATA_DIR = os.path.join(ROOT, "data")
CARDS_PATH = os.path.join(DATA_DIR, "cards.json")
SAMPLE_CARDS_PATH = os.path.join(DATA_DIR, "cards.sample.json")
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

    def _read_stderr(self):
        for line in self.proc.stderr:
            line = line.rstrip()
            if "ready to begin handling requests" in line.lower() or "started, ready" in line.lower():
                self.ready.set()
            log("katago:", line)
        self.error = f"KataGo が終了しました (code={self.proc.poll()})"
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
            self.ready.set()
            qid = resp.get("id")
            with self.lock:
                q = self.waiters.pop(qid, None)
            if q is not None:
                q.put(resp)
            elif "warning" not in resp:
                log("unmatched response:", line[:200])

    def _fail_all(self, msg):
        with self.lock:
            waiters, self.waiters = self.waiters, {}
        for q in waiters.values():
            q.put({"error": msg})

    def status(self):
        if self.proc.poll() is not None:
            return {"engine": self.name, "ok": False, "message": self.error or "KataGo が起動していません"}
        return {"engine": self.name, "ok": True,
                "message": "準備完了" if self.ready.is_set() else "起動中 (モデル読み込み中)…"}

    def analyze(self, positions, params, timeout=600):
        """positions: [{"stones": [[color, x, y], ...]}] → [{"winrateWhite", "scoreLeadWhite", "visits"} | {"error"}]"""
        if self.proc.poll() is not None:
            raise RuntimeError(self.error or "KataGo が起動していません")
        size = params["boardSize"]
        pending = []
        for pos in positions:
            with self.lock:
                self.counter += 1
                qid = f"q{self.counter}"
                q = queue.Queue()
                self.waiters[qid] = q
            query = {
                "id": qid,
                "initialStones": [[c, to_gtp(x, y, size)] for c, x, y in pos["stones"]],
                "moves": [],
                "initialPlayer": params["nextPlayer"],
                "rules": params["rules"],
                "komi": params["komi"],
                "boardXSize": size,
                "boardYSize": size,
                "maxVisits": params["visits"],
            }
            pending.append(q)
            self.proc.stdin.write(json.dumps(query) + "\n")
        self.proc.stdin.flush()

        deadline = time.time() + timeout
        results = []
        for q in pending:
            try:
                resp = q.get(timeout=max(1, deadline - time.time()))
            except queue.Empty:
                results.append({"error": "timeout"})
                continue
            if "error" in resp:
                results.append({"error": resp["error"]})
                continue
            root = resp.get("rootInfo", {})
            wr_b = root.get("winrate")
            lead_b = root.get("scoreLead")
            results.append({
                "winrateWhite": None if wr_b is None else 1.0 - wr_b,
                "scoreLeadWhite": None if lead_b is None else -lead_b,
                "visits": root.get("visits"),
            })
        return results


class MockEngine:
    """KataGo が無い環境で UI を試すための疑似エンジン。結果に意味はない。"""

    name = "mock"

    def status(self):
        return {"engine": self.name, "ok": True, "message": "モックエンジン (勝率は疑似値です)"}

    def analyze(self, positions, params, timeout=0):
        size = params["boardSize"]
        out = []
        for pos in positions:
            score = 0.0
            for c, x, y in pos["stones"]:
                line = min(x, y, size - 1 - x, size - 1 - y) + 1
                value = {1: 0.2, 2: 0.7, 3: 1.0, 4: 1.0, 5: 0.8}.get(line, 0.6)
                score += value if c == "W" else -value
            h = hashlib.md5(json.dumps(sorted(pos["stones"])).encode()).digest()
            score += (h[0] / 255.0 - 0.5) * 3.0
            score += params["komi"] - 6.5
            if params["nextPlayer"] == "W":
                score += 6.5
            winrate = 1.0 / (1.0 + pow(2.718281828, -score / 4.0))
            out.append({"winrateWhite": winrate, "scoreLeadWhite": score, "visits": params["visits"]})
        time.sleep(0.002 * len(positions))
        return out


class CachedEngine:
    def __init__(self, engine, max_entries=200000):
        self.engine = engine
        self.cache = {}
        self.max_entries = max_entries
        self.lock = threading.Lock()

    def status(self):
        s = self.engine.status()
        s["cacheSize"] = len(self.cache)
        return s

    @staticmethod
    def _key(pos, params):
        payload = json.dumps([sorted(map(list, pos["stones"])), params], sort_keys=True)
        return hashlib.sha1(payload.encode()).hexdigest()

    def analyze(self, positions, params):
        keys = [self._key(p, params) for p in positions]
        results = [None] * len(positions)
        todo = []
        with self.lock:
            for i, k in enumerate(keys):
                if k in self.cache:
                    results[i] = dict(self.cache[k], cached=True)
                else:
                    todo.append(i)
        if todo:
            fresh = self.engine.analyze([positions[i] for i in todo], params)
            with self.lock:
                if len(self.cache) > self.max_entries:
                    self.cache.clear()
                for i, r in zip(todo, fresh):
                    results[i] = r
                    if "error" not in r:
                        self.cache[keys[i]] = r
        return results


# ---------------------------------------------------------------------------
# カードリスト
# ---------------------------------------------------------------------------

ATTRS = ("地", "宙", "海")
SGF_RE = re.compile(r"\(\s*;(?:[^()\"\\]|\\.)*?(?:[BW]\[[a-s]{2}\]|A[BW]\[[a-s]{2}\])(?:[^()\"\\]|\\.)*\)")
SGF_MOVE_RE = re.compile(r"(?<![A-Z])(B|W|AB|AW)((?:\[[a-s]{0,2}\]\s*)+)")
TAG_RE = re.compile(r"<[^>]+>")


def load_cards():
    path = CARDS_PATH if os.path.exists(CARDS_PATH) else SAMPLE_CARDS_PATH
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data["isSample"] = path == SAMPLE_CARDS_PATH
    return data


def save_cards(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    data = {k: v for k, v in data.items() if k != "isSample"}
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


def parse_card_page(raw):
    """gonote の記事 (HTML / JSON 埋め込み / プレーンテキスト) から定石カードを抽出する。

    記事の正確な構造は未確認のため、次のヒューリスティックで抽出する:
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
    engine = None
    cards_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if "/api/analyze" not in (args[0] if args else ""):
            log(self.address_string(), fmt % args)

    def _json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        if self.path == "/api/status":
            return self._json(self.engine.status())
        if self.path == "/api/cards":
            with self.cards_lock:
                return self._json(load_cards())
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/analyze":
                return self._analyze()
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
            self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except Exception as e:  # noqa: BLE001 - UI にそのまま表示する
            log("error:", repr(e))
            self._json({"error": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _analyze(self):
        body = self._body()
        params = {
            "boardSize": int(body.get("boardSize", 19)),
            "komi": float(body.get("komi", 6.5)),
            "rules": str(body.get("rules", "japanese")),
            "nextPlayer": "W" if body.get("nextPlayer") == "W" else "B",
            "visits": max(1, min(10000, int(body.get("visits", 100)))),
        }
        positions = body.get("positions", [])
        results = self.engine.analyze(positions, params)
        self._json({"results": results})

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
            old = [] if data.get("isSample") else data.get("cards", [])
            merged, added, updated, removed = merge_cards(old, new_cards)
            data = {"source": source, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "cards": merged}
            save_cards(data)
        self._json({"ok": True, "added": added, "updated": updated, "removed": removed,
                    "warnings": warnings, "count": len(new_cards)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--katago", default=os.environ.get("KATAGO_PATH", "katago"), help="KataGo 実行ファイル")
    ap.add_argument("--model", default=os.environ.get("KATAGO_MODEL"), help="KataGo のモデルファイル (.bin.gz)")
    ap.add_argument("--config", default=os.environ.get("KATAGO_CONFIG", os.path.join(ROOT, "analysis.cfg")),
                    help="KataGo analysis 用の設定ファイル")
    ap.add_argument("--mock", action="store_true", help="KataGo を使わず疑似エンジンで起動 (UI 確認用)")
    args = ap.parse_args()

    if args.mock:
        engine = MockEngine()
    else:
        if not args.model:
            ap.error("--model (または環境変数 KATAGO_MODEL) を指定してください。UI だけ試す場合は --mock")
        engine = KataGoEngine(args.katago, args.model, args.config)
    Handler.engine = CachedEngine(engine)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"http://{args.host}:{args.port}/ を開いてください (engine={engine.name})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
