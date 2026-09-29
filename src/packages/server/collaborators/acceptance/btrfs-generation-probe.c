/* Read-only proof spike, not a production no-change detector.
 * Copyright (c) 2026 Sagemath, Inc. License: MS-RSL.
 */
#include <fcntl.h>
#include <inttypes.h>
#include <linux/btrfs.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { perror("open"); return 1; }
  struct btrfs_ioctl_get_subvol_info_args info = {0};
  int result = ioctl(fd, BTRFS_IOC_GET_SUBVOL_INFO, &info);
  close(fd);
  if (result < 0) { perror("BTRFS_IOC_GET_SUBVOL_INFO"); return 1; }
  printf("{\"generation\":\"%" PRIu64 "\",\"tree_id\":\"%" PRIu64 "\",\"uuid\":\"",
         (uint64_t)info.generation, (uint64_t)info.treeid);
  for (int i = 0; i < BTRFS_UUID_SIZE; i++) printf("%02x", info.uuid[i]);
  puts("\"}");
  return 0;
}
