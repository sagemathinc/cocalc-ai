// Isolated benchmark child resource usage, independent of an installed GNU time.
#define _DEFAULT_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  pid_t child = fork();
  if (child < 0) { perror("fork"); return 2; }
  if (child == 0) {
    execv(argv[2], argv + 2);
    perror("execv");
    _exit(127);
  }
  int status;
  struct rusage usage;
  while (wait4(child, &status, 0, &usage) < 0) {
    if (errno == EINTR) continue;
    perror("wait4");
    return 2;
  }
  FILE *output = fopen(argv[1], "wx");
  if (!output) { perror("fopen"); return 2; }
  int result = fprintf(output,
      "{\"maxRssKiB\":%ld,\"userSeconds\":%.6f,\"systemSeconds\":%.6f}\n",
      usage.ru_maxrss,
      usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1000000.0,
      usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1000000.0);
  if (fclose(output) != 0 || result < 0) return 2;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
