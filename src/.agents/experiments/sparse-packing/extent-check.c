#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Disposable Linux fixture checker, not a production backup decoder. */
static void fail(const char *s) {
  perror(s);
  exit(1);
}

static off_t seek_data(int fd, off_t pos, off_t size) {
  off_t n = lseek(fd, pos, SEEK_DATA);
  if (n < 0 && errno == ENXIO) return size;
  if (n < 0) fail("SEEK_DATA");
  return n;
}

static off_t seek_hole(int fd, off_t pos) {
  off_t n = lseek(fd, pos, SEEK_HOLE);
  if (n < 0) fail("SEEK_HOLE");
  return n;
}

static void read_exact(int fd, char *buf, size_t len, off_t pos) {
  size_t done = 0;
  while (done < len) {
    ssize_t n = pread(fd, buf + done, len - done, pos + (off_t)done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { errno = EIO; fail("pread"); }
    done += (size_t)n;
  }
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) return 2;
  int a = open(argv[1], O_RDONLY | O_NOFOLLOW);
  if (a < 0) fail("open source");
  struct stat sa;
  if (fstat(a, &sa) < 0) fail("stat source");
  if (!S_ISREG(sa.st_mode)) return 2;
  off_t data_bytes = 0, extents = 0, pos = 0;
  while ((pos = seek_data(a, pos, sa.st_size)) < sa.st_size) {
    off_t end = seek_hole(a, pos);
    if (end <= pos || end > sa.st_size || ++extents > 100000) return 3;
    data_bytes += end - pos;
    pos = end;
  }
  unsigned long long compared = 0;
  if (argc == 3) {
    int b = open(argv[2], O_RDONLY | O_NOFOLLOW);
    if (b < 0) fail("open destination");
    struct stat sb;
    if (fstat(b, &sb) < 0) fail("stat destination");
    if (!S_ISREG(sb.st_mode) || sa.st_size != sb.st_size) return 4;
    char left[65536], right[65536];
    pos = 0;
    while (pos < sa.st_size) {
      off_t da = seek_data(a, pos, sa.st_size);
      off_t db = seek_data(b, pos, sa.st_size);
      pos = da < db ? da : db;
      if (pos == sa.st_size) break;
      off_t ha = seek_hole(a, pos), hb = seek_hole(b, pos);
      off_t end = ha > hb ? ha : hb;
      if (end <= pos || end > sa.st_size) return 5;
      while (pos < end) {
        size_t n = end - pos < (off_t)sizeof(left) ? (size_t)(end - pos) : sizeof(left);
        compared += n;
        /* Fail closed if a regression unexpectedly densifies a huge fixture. */
        if (compared > 256ULL * 1024 * 1024) return 6;
        read_exact(a, left, n, pos);
        read_exact(b, right, n, pos);
        if (memcmp(left, right, n) != 0) return 7;
        pos += (off_t)n;
      }
    }
    close(b);
  }
  printf("{\"size\":%lld,\"allocated\":%lld,\"dataBytes\":%lld,\"extents\":%lld,\"comparedBytes\":%llu}\n",
         (long long)sa.st_size, (long long)sa.st_blocks * 512,
         (long long)data_bytes, (long long)extents, compared);
  close(a);
  return 0;
}
