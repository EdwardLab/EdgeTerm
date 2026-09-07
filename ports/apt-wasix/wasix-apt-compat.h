#ifndef EDGETERM_WASIX_APT_COMPAT_H
#define EDGETERM_WASIX_APT_COMPAT_H

#include <sys/types.h>
#include <sys/stat.h>
#include <stdio.h>

#ifndef F_RDLCK
#define F_RDLCK 0
#endif
#ifndef F_WRLCK
#define F_WRLCK 1
#endif
#ifndef F_UNLCK
#define F_UNLCK 2
#endif
#ifndef F_GETLK
#define F_GETLK 5
#endif
#ifndef F_SETLK
#define F_SETLK 6
#endif
#ifndef F_SETLKW
#define F_SETLKW 7
#endif
#ifndef O_NDELAY
#define O_NDELAY O_NONBLOCK
#endif
#ifndef GLOB_TILDE
#define GLOB_TILDE 0
#endif
#ifndef TIOCSCTTY
#define TIOCSCTTY 0x540E
#endif

#ifdef __cplusplus
extern "C" {
#endif

int getgroups(int size, gid_t list[]);
int chroot(const char *path);
int setresuid(uid_t real_uid, uid_t effective_uid, uid_t saved_uid);
int setresgid(gid_t real_gid, gid_t effective_gid, gid_t saved_gid);
int getresuid(uid_t *real_uid, uid_t *effective_uid, uid_t *saved_uid);
int getresgid(gid_t *real_gid, gid_t *effective_gid, gid_t *saved_gid);
int unlockpt(int file_descriptor);
char *ptsname(int file_descriptor);
int ptsname_r(int file_descriptor, char *buffer, size_t buffer_size);
int posix_openpt(int flags);
int grantpt(int file_descriptor);
int mkfifo(const char *path, mode_t mode);
int mknod(const char *path, mode_t mode, dev_t device);
int edgeterm_rename(const char *source, const char *destination);
int edgeterm_unlink(const char *path);
int edgeterm_stat(const char *path, struct stat *status);
int edgeterm_lstat(const char *path, struct stat *status);
FILE *edgeterm_fopen(const char *path, const char *mode);
int edgeterm_exit(int status);
pid_t edgeterm_vfork(void);
int edgeterm_spawn(
    pid_t *pid,
    const char *path,
    char *const arguments[],
    int input_fd,
    int output_fd,
    int error_fd
);

#define rename edgeterm_rename
#define unlink edgeterm_unlink
#define stat(path, status) edgeterm_stat((path), (status))
#define lstat(path, status) edgeterm_lstat((path), (status))
#define fopen(path, mode) edgeterm_fopen((path), (mode))

#ifdef __cplusplus
}

#include <chrono>
#include <sys/time.h>

template <typename Clock>
inline typename Clock::time_point edgeterm_clock_now()
{
    struct timeval value = {};
    gettimeofday(&value, nullptr);
    const auto elapsed = std::chrono::seconds(value.tv_sec) +
        std::chrono::microseconds(value.tv_usec);
    return typename Clock::time_point(
        std::chrono::duration_cast<typename Clock::duration>(elapsed));
}
#endif

#endif
