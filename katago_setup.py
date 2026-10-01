"""KataGo の実行ファイル・ネットワーク（モデル）の入手と設定

- GitHub の KataGo リリース一覧と、katagotraining.org のネットワーク一覧を取得する
- 選んだファイルをバックグラウンドでダウンロード（進捗つき）し、実行ファイルは zip を展開する
- 使う実行ファイル・モデルのパスを katago/settings.json に保存する（次回起動時も使う）

ダウンロード先は、このツールのフォルダの katago/ 以下。
"""

import html as htmllib
import json
import os
import platform
import re
import shutil
import stat
import tarfile
import threading
import time
import urllib.request
import uuid
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
KATAGO_DIR = os.path.join(ROOT, "katago")
SETTINGS_PATH = os.path.join(KATAGO_DIR, "settings.json")

# 取得元（テスト用に環境変数で差し替えられる）
RELEASES_API = os.environ.get("IGOSIL_KATAGO_RELEASES_API",
                              "https://api.github.com/repos/lightvector/KataGo/releases?per_page=10")
NETWORKS_URL = os.environ.get("IGOSIL_KATAGO_NETWORKS_URL", "https://katagotraining.org/networks/")
# ダウンロードを許可する URL（これ以外からはダウンロードしない）
ALLOWED_PREFIXES = [
    "https://github.com/lightvector/KataGo/releases/download/",
    "https://media.katagotraining.org/uploaded/networks/",
] + [p for p in os.environ.get("IGOSIL_ALLOW_DOWNLOAD_PREFIX", "").split(",") if p]

USER_AGENT = "igosil-card-optimizer (+https://github.com/kos59125/igosil-card)"


def _log(*args):
    print("[setup]", *args, flush=True)


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    return urllib.request.urlopen(req, timeout=timeout)


# ---------------------------------------------------------------------------
# 実行環境
# ---------------------------------------------------------------------------

def server_platform():
    system = platform.system()
    os_name = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}.get(system, system.lower())
    return {"os": os_name, "system": system, "machine": platform.machine(), "release": platform.release()}


# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

def load_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(**updates):
    data = load_settings()
    data.update({k: v for k, v in updates.items() if v is not None})
    os.makedirs(KATAGO_DIR, exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, SETTINGS_PATH)
    return data


# ---------------------------------------------------------------------------
# リリース・ネットワーク一覧
# ---------------------------------------------------------------------------

_cache = {}


def _cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


def classify_asset(name):
    """アセット名から OS・CPU・バックエンドを推定する。
    例: katago-v1.16.0-opencl-windows-x64.zip → windows / x64 / opencl
    """
    low = name.lower()
    if "windows" in low or low.endswith(".exe"):
        os_name = "windows"
    elif any(k in low for k in ("macos", "osx", "darwin", "-mac")):
        os_name = "macos"
    elif "linux" in low or low.endswith(".appimage"):
        os_name = "linux"
    else:
        os_name = ""
    arch = "arm64" if re.search(r"arm64|aarch64", low) else ("x64" if re.search(r"x64|x86_64|amd64", low) else "")
    stem = re.sub(r"\.(zip|tar\.gz|tgz|appimage)$", "", low)
    stem = re.sub(r"^katago-v?[\d.]+-?", "", stem)
    stem = re.sub(r"-?(windows|linux|macos|osx|darwin|mac)(-?(x64|x86_64|amd64|arm64|aarch64))?$", "", stem)
    backend = stem.strip("-") or "default"
    if backend.startswith("eigenavx2"):
        kind = "eigenavx2"
    elif backend.startswith("eigen"):
        kind = "eigen"
    elif backend.startswith("opencl"):
        kind = "opencl"
    elif backend.startswith("trt") or "tensorrt" in backend:
        kind = "tensorrt"
    elif backend.startswith("cuda"):
        kind = "cuda"
    elif "metal" in backend or "coreml" in backend:
        kind = "metal"
    elif "rocm" in backend:
        kind = "rocm"
    elif "onnx" in backend:
        kind = "onnx"
    else:
        kind = backend
    return {"os": os_name, "arch": arch, "backend": backend, "kind": kind}


def list_releases():
    def fetch():
        with _get(RELEASES_API) as resp:
            data = json.load(resp)
        out = []
        for rel in data:
            if rel.get("draft"):
                continue
            assets = []
            for a in rel.get("assets", []):
                name = a.get("name", "")
                if not re.search(r"\.(zip|tar\.gz|tgz|appimage)$", name, re.I):
                    continue
                info = classify_asset(name)
                if not info["os"]:
                    continue
                assets.append({"name": name, "url": a.get("browser_download_url"), "size": a.get("size"), **info})
            out.append({
                "tag": rel.get("tag_name"), "name": rel.get("name"), "prerelease": rel.get("prerelease", False),
                "published": (rel.get("published_at") or "")[:10], "url": rel.get("html_url"), "assets": assets,
            })
        return out
    return _cached("releases", 600, fetch)


def list_networks():
    def fetch():
        with _get(NETWORKS_URL) as resp:
            page = resp.read().decode("utf-8", errors="replace")
        link_re = r"https?://media\.katagotraining\.org/uploaded/networks/models/[\w./-]+?\.bin\.gz"
        nets, seen = [], set()
        for row in re.findall(r"(?is)<tr\b.*?</tr>", page):
            m = re.search(link_re, row)
            if not m or m.group(0) in seen:
                continue
            url = m.group(0)
            seen.add(url)
            text = htmllib.unescape(re.sub(r"<[^>]+>", " ", row))
            date = re.search(r"\d{4}-\d{2}-\d{2}", text)
            elo = re.search(r"(-?\d+(?:\.\d+)?)\s*±\s*(\d+(?:\.\d+)?)", text)
            nets.append({"name": url.rsplit("/", 1)[-1][:-len(".bin.gz")], "url": url,
                         "uploaded": date.group(0) if date else "", "elo": float(elo.group(1)) if elo else None,
                         "eloError": float(elo.group(2)) if elo else None})
        if not nets:  # 表の構造が変わった場合は、リンクだけ拾う
            for url in dict.fromkeys(re.findall(link_re, page)):
                nets.append({"name": url.rsplit("/", 1)[-1][:-len(".bin.gz")], "url": url, "uploaded": "", "elo": None})
        text = htmllib.unescape(re.sub(r"<[^>]+>", " ", page))

        def labeled(label):
            m = re.search(label + r"\s*:?\s*([\w.-]+)", text, re.I)
            return m.group(1) if m else None
        latest = labeled(r"Latest network")
        strongest = labeled(r"Strongest confidently[- ]rated network")
        for n in nets:
            n["latest"] = n["name"] == latest
            n["strongest"] = n["name"] == strongest
        return {"networks": nets, "latest": latest, "strongest": strongest, "source": NETWORKS_URL}
    return _cached("networks", 600, fetch)


# ---------------------------------------------------------------------------
# ダウンロード
# ---------------------------------------------------------------------------

def _safe_name(name):
    name = os.path.basename(name or "")
    name = re.sub(r"[^\w.+-]", "_", name)
    if not name or name.startswith("."):
        raise ValueError("ファイル名が不正です")
    return name


def _safe_extract_zip(path, dest):
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            target = os.path.realpath(os.path.join(dest, info.filename))
            if not target.startswith(os.path.realpath(dest) + os.sep) and target != os.path.realpath(dest):
                raise ValueError(f"zip に不正なパスが含まれています: {info.filename}")
        zf.extractall(dest)
        # zip に記録された実行権限を戻す（Linux / macOS）
        for info in zf.infolist():
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                try:
                    os.chmod(os.path.join(dest, info.filename), mode)
                except OSError:
                    pass


def _safe_extract_tar(path, dest):
    with tarfile.open(path) as tf:
        for m in tf.getmembers():
            target = os.path.realpath(os.path.join(dest, m.name))
            if not target.startswith(os.path.realpath(dest) + os.sep) or m.issym() or m.islnk():
                raise ValueError(f"アーカイブに不正なパスが含まれています: {m.name}")
        tf.extractall(dest)


def find_executable(folder):
    """展開したフォルダから KataGo の実行ファイルを探す。"""
    candidates = []
    for base, _dirs, files in os.walk(folder):
        for f in files:
            low = f.lower()
            if low in ("katago.exe", "katago") or (low.startswith("katago") and low.endswith(".appimage")):
                candidates.append(os.path.join(base, f))
    # katago.exe / katago を優先し、浅い階層を優先
    candidates.sort(key=lambda p: (not os.path.basename(p).lower() in ("katago.exe", "katago"), p.count(os.sep)))
    return candidates[0] if candidates else None


def _make_executable(path):
    if os.name != "nt":
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class Downloads:
    """バックグラウンドのダウンロードジョブ。on_done(job) は完了時に呼ばれる。"""

    def __init__(self, on_done=None):
        self.jobs = {}
        self.lock = threading.Lock()
        self.on_done = on_done

    def snapshot(self):
        with self.lock:
            return [dict(j) for j in self.jobs.values()]

    def start(self, kind, url, name):
        if kind not in ("engine", "model"):
            raise ValueError("kind は engine か model です")
        if not any(url.startswith(p) for p in ALLOWED_PREFIXES):
            raise ValueError("このツールからダウンロードできるのは、GitHub の KataGo リリースと katagotraining.org のネットワークのみです")
        name = _safe_name(name or url.rsplit("/", 1)[-1])
        with self.lock:
            for j in self.jobs.values():
                if j["url"] == url and j["state"] in ("downloading", "extracting"):
                    return j["id"]
            job = {"id": uuid.uuid4().hex[:8], "kind": kind, "name": name, "url": url, "state": "downloading",
                   "done": 0, "total": None, "error": None, "path": None, "started": time.time()}
            self.jobs[job["id"]] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job["id"]

    def _update(self, job, **kw):
        with self.lock:
            job.update(kw)

    def _run(self, job):
        sub = "engines" if job["kind"] == "engine" else "models"
        folder = os.path.join(KATAGO_DIR, sub)
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, job["name"])
        part = dest + ".part"
        try:
            _log("download:", job["url"])
            with _get(job["url"], timeout=60) as resp, open(part, "wb") as f:
                total = resp.headers.get("Content-Length")
                self._update(job, total=int(total) if total else None)
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    self._update(job, done=job["done"] + len(chunk))
            os.replace(part, dest)
            if job["kind"] == "model":
                path = dest
                save_settings(model=path)
            else:
                self._update(job, state="extracting")
                low = dest.lower()
                if low.endswith(".zip") or low.endswith((".tar.gz", ".tgz")):
                    target = re.sub(r"\.(zip|tar\.gz|tgz)$", "", dest, flags=re.I)
                    if os.path.isdir(target):
                        shutil.rmtree(target)
                    os.makedirs(target)
                    (_safe_extract_zip if low.endswith(".zip") else _safe_extract_tar)(dest, target)
                    os.remove(dest)
                    path = find_executable(target)
                    if not path:
                        raise RuntimeError("展開したファイルの中に KataGo の実行ファイルが見つかりませんでした")
                else:
                    path = dest  # AppImage など単体の実行ファイル
                _make_executable(path)
                save_settings(katago=path)
            self._update(job, state="done", path=path)
            _log("downloaded:", path)
            if self.on_done:
                self.on_done(dict(job))
        except Exception as e:  # noqa: BLE001 - UI に表示する
            _log("download failed:", repr(e))
            try:
                os.remove(part)
            except OSError:
                pass
            self._update(job, state="error", error=str(e))
