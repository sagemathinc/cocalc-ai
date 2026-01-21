#!/usr/bin/env python
"""
Check that all links to the documentation are valid.
Optionally check all http(s) links in the repo with --all.
Use --react to limit scanning to packages that depend on react/next.
"""
import argparse
import json
import os
import re
import requests as r
import subprocess
import threading
from urllib.parse import urlparse
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from multiprocessing.pool import ThreadPool

BASE_URL = "https://doc.cocalc.com"
DEFAULT_TIMEOUT = 10
MAX_RETRIES = 3
BACKOFF_FACTOR = 0.5
STATUS_FORCELIST = (429, 500, 502, 503, 504)
REACT_DEP_NAMES = {"react", "react-dom", "next"}
SKIP_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0"}
SKIP_URL_PATTERNS = [
    # Add regex patterns here to skip known noisy URLs.
]
INVALID_URL_CHARS = set("{}[]`<>")
JS_LIKE_EXTS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
CSS_LIKE_EXTS = {".css", ".scss", ".less"}
HTML_LIKE_EXTS = {".html", ".htm", ".md", ".mdx", ".markdown"}

_thread_local = threading.local()

# change the working directory to the parent directory, of there this file is
curdir = os.path.dirname(os.path.abspath(__file__))
parentdir = os.path.dirname(curdir)
os.chdir(parentdir)
SKIP_FILE = os.path.join(curdir, "check_doc_urls.skip")


def _load_skip_patterns():
    patterns = list(SKIP_URL_PATTERNS)
    if os.path.exists(SKIP_FILE):
        with open(SKIP_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                patterns.append(line)
    return patterns


def _clean_url(url):
    if '#' in url:
        url = url[:url.index('#')]
    if '?' in url:
        url = url[:url.index('?')]
    return url.rstrip(".,;:")


def _is_skipped(url, skip_patterns):
    if "api" in url.lower():
        return True
    return any(re.search(pat, url) for pat in skip_patterns)


def _strip_comments(content, ext):
    if ext in JS_LIKE_EXTS:
        content = re.sub(r"/\*.*?\*/", " ", content, flags=re.S)
        content = re.sub(r"(?<!:)//.*", "", content)
        return content
    if ext in CSS_LIKE_EXTS:
        return re.sub(r"/\*.*?\*/", " ", content, flags=re.S)
    if ext in HTML_LIKE_EXTS:
        return re.sub(r"<!--.*?-->", " ", content, flags=re.S)
    return content


def _is_dynamic_url(url):
    if "${" in url or "{{" in url or "}}" in url:
        return True
    if any(ch in url for ch in INVALID_URL_CHARS):
        return True
    if "$" in url or "`" in url or "..." in url:
        return True
    return False


def _is_valid_host(url):
    parsed = urlparse(url)
    host = parsed.hostname
    if not host:
        return False
    if host in SKIP_HOSTS:
        return False
    if "." not in host:
        return False
    return True


def _find_react_paths():
    base_dir = "packages"
    if not os.path.isdir(base_dir):
        return []
    paths = []
    for entry in os.listdir(base_dir):
        pkg_dir = os.path.join(base_dir, entry)
        if not os.path.isdir(pkg_dir):
            continue
        if entry == "node_modules":
            continue
        pkg_json = os.path.join(pkg_dir, "package.json")
        if not os.path.isfile(pkg_json):
            continue
        try:
            with open(pkg_json) as f:
                data = json.load(f)
        except Exception:
            continue
        deps = {}
        for key in ("dependencies", "devDependencies", "peerDependencies"):
            deps.update(data.get(key, {}))
        if REACT_DEP_NAMES.intersection(deps):
            paths.append(pkg_dir)
    return sorted(paths)


def _git_grep_files(pattern, paths=None):
    cmd = ["git", "grep", "-lI", "-e", pattern]
    if paths:
        cmd.append("--")
        cmd.extend(paths)
    try:
        output = subprocess.check_output(
            cmd, text=True, stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError as exc:
        if exc.returncode == 1:
            return []
        raise
    return output.split()


def extract_urls(fn, pattern, skip_patterns, allowed_exts=None):
    if allowed_exts is not None:
        ext = os.path.splitext(fn)[1].lower()
        if ext not in allowed_exts:
            return
    with open(fn, errors="ignore") as f:
        content = f.read()
    ext = os.path.splitext(fn)[1].lower()
    content = _strip_comments(content, ext)
    urls = re.findall(pattern, content)

    for url in urls:
        url = _clean_url(url)
        if _is_dynamic_url(url):
            continue
        if not _is_valid_host(url):
            continue
        if _is_skipped(url, skip_patterns):
            continue
        yield url


def get_all_urls(all_links, skip_patterns, paths=None, allowed_exts=None):
    """
    use git grep to find all files, that contain the BASE_URL
    and then extract all urls from those files
    """
    if all_links:
        git_pattern = r"https\?://"
        pattern = r'''(https?://[^\s'"\\\n)\]<>\}]+)'''
    else:
        git_pattern = BASE_URL
        pattern = r"(" + re.escape(BASE_URL) + r'''[^\s'"\\\n)\]<>\}]+)'''
    files = _git_grep_files(git_pattern, paths)
    # combine all urls into one set
    all_url = set()
    for fn in files:
        for url in extract_urls(fn, pattern, skip_patterns, allowed_exts=allowed_exts):
            all_url.add(url)
    return sorted(all_url)


def _make_session():
    retry_kwargs = dict(
        total=MAX_RETRIES,
        connect=MAX_RETRIES,
        read=MAX_RETRIES,
        status=MAX_RETRIES,
        backoff_factor=BACKOFF_FACTOR,
        status_forcelist=STATUS_FORCELIST,
        raise_on_status=False,
    )
    try:
        retry = Retry(allowed_methods=frozenset(["HEAD", "GET"]), **retry_kwargs)
    except TypeError:
        retry = Retry(method_whitelist=frozenset(["HEAD", "GET"]), **retry_kwargs)
    adapter = HTTPAdapter(max_retries=retry)
    session = r.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": "cocalc-doc-link-check/1.0"})
    return session


def _get_session():
    if getattr(_thread_local, "session", None) is None:
        _thread_local.session = _make_session()
    return _thread_local.session


def _head_then_get(session, url):
    try:
        res = session.head(url, timeout=DEFAULT_TIMEOUT, allow_redirects=True)
        res.raise_for_status()
        return res
    except Exception:
        res = session.get(
            url, timeout=DEFAULT_TIMEOUT, allow_redirects=True, stream=True
        )
        res.raise_for_status()
        return res


def check_url(url):
    """
    Check the HTTP HEAD request for the given URL, to avoid
    downloading the whole file. Fall back to GET if HEAD fails.
    """
    session = _get_session()
    try:
        res = _head_then_get(session, url)
        res.close()
        return True
    except Exception as ex:
        print(f"✗ {url}: {ex}")
        return False


def main():
    """
    Check all URLs. We use HEAD requests, so that we don't download the whole file.
    """
    parser = argparse.ArgumentParser(
        description="Check doc.cocalc.com links (or all http(s) links with --all)."
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Check all http(s) URLs, not just doc.cocalc.com links.",
    )
    parser.add_argument(
        "--react",
        action="store_true",
        help="Limit search to packages that depend on react/next.",
    )
    args = parser.parse_args()
    skip_patterns = _load_skip_patterns()
    paths = _find_react_paths() if args.react else None
    allowed_exts = {".tsx", ".jsx"} if args.react else None
    if args.react and not paths:
        print("No React packages found; checking full repo.")
        paths = None
        allowed_exts = None
    all_url = get_all_urls(
        args.all, skip_patterns, paths, allowed_exts=allowed_exts
    )
    print(f"Checking {len(all_url)} URLs...")
    results = ThreadPool(16).map(check_url, all_url)
    if not all(results):
        num_failed = len([x for x in results if not x])
        print(f"{num_failed} URLs failed.")
        exit(1)
    else:
        print("All URLs are valid.")


if __name__ == '__main__':
    main()
