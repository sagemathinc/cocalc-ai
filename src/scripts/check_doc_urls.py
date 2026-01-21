#!/usr/bin/env python
"""
Check that all links to the documentation are valid.
"""
import os
import re
import requests as r
import threading
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from multiprocessing.pool import ThreadPool

BASE_URL = "https://doc.cocalc.com"
DEFAULT_TIMEOUT = 10
MAX_RETRIES = 3
BACKOFF_FACTOR = 0.5
STATUS_FORCELIST = (429, 500, 502, 503, 504)

_thread_local = threading.local()

# change the working directory to the parent directory, of there this file is
curdir = os.path.dirname(os.path.abspath(__file__))
parentdir = os.path.dirname(curdir)
os.chdir(parentdir)


def extract_urls(fn):
    with open(fn) as f:
        content = f.read()
        pattern = fr'''({BASE_URL}[^\s'"\\\n)]+)'''
        urls = re.findall(pattern, content)

        for url in urls:
            # remove anchors
            if '#' in url:
                url = url[:url.index('#')]
            # remove query parameters
            if '?' in url:
                url = url[:url.index('?')]
            yield url


def get_all_urls():
    """
    use git grep to find all files, that contain the BASE_URL
    and then extract all urls from those files
    """
    cmd = f"git grep -lI {BASE_URL}"
    output = os.popen(cmd).read()
    files = output.split()
    # combine all urls into one set
    all_url = set()
    for fn in files:
        for url in extract_urls(fn):
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
        print(f"✓ {url}")
        res.close()
        return True
    except Exception as ex:
        print(f"✗ {url}: {ex}")
        return False


def main():
    """
    Check all URLs. We use HEAD requests, so that we don't download the whole file.
    """
    all_url = get_all_urls()
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
