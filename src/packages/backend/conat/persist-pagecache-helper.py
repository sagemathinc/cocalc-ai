# This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
# License: MS-RSL - see LICENSE.md for details
#
# The persist server's page-cache helper (finding 028, DESIGN v1.21 §3.2.11).
# It acts ONLY on file descriptor 3, which the persist server opened itself
# (with its hostile-path checks) and passed in.  It reads no path, no argv and
# no environment.  It drops the file's pages from the page cache
# (POSIX_FADV_DONTNEED), then counts the pages still resident (mmap + mincore,
# through libc) and prints exactly one line:
#   {"v":1,"page_size":4096,"pages":<int>,"resident_after":<int>}
# Run as `/usr/bin/python3 -I -S -`, with these exact bytes on stdin (the
# server checks their sha256 first).  Stdlib only.
import ctypes
import os
import sys

FD = 3
PAGE = 4096
PROT_READ = 1
MAP_SHARED = 1
MAP_FAILED = ctypes.c_void_p(-1).value


def main():
    size = os.fstat(FD).st_size
    os.posix_fadvise(FD, 0, 0, os.POSIX_FADV_DONTNEED)
    pages = (size + PAGE - 1) // PAGE
    resident = 0
    if size > 0:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.mmap.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_long,
        ]
        libc.mmap.restype = ctypes.c_void_p
        libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p]
        libc.mincore.restype = ctypes.c_int
        libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        libc.munmap.restype = ctypes.c_int
        addr = libc.mmap(None, size, PROT_READ, MAP_SHARED, FD, 0)
        if addr is None or addr == MAP_FAILED:
            raise OSError(ctypes.get_errno(), "mmap")
        try:
            vec = ctypes.create_string_buffer(pages)
            if libc.mincore(ctypes.c_void_p(addr), ctypes.c_size_t(size), vec) != 0:
                raise OSError(ctypes.get_errno(), "mincore")
            resident = sum(1 for b in vec.raw[:pages] if b & 1)
        finally:
            libc.munmap(ctypes.c_void_p(addr), ctypes.c_size_t(size))
    sys.stdout.write(
        '{"v":1,"page_size":%d,"pages":%d,"resident_after":%d}\n'
        % (PAGE, pages, resident)
    )


main()
