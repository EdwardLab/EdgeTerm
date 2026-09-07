#include "wasix-apt-compat.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wasi/api.h>
#undef unlink
#undef stat
#undef lstat
#undef fopen

extern int unlink(const char *path);

int edgeterm_stat(const char *path, struct stat *status)
{
    int result = stat(path, status);
    if (result != 0 && (errno == 0 || errno == EBADF))
        errno = ENOENT;
    return result;
}

int edgeterm_lstat(const char *path, struct stat *status)
{
    int result = lstat(path, status);
    if (result != 0 && (errno == 0 || errno == EBADF))
        errno = ENOENT;
    return result;
}

FILE *edgeterm_fopen(const char *path, const char *mode)
{
    FILE *stream = fopen(path, mode);
    if (stream == NULL && (errno == 0 || errno == EBADF))
        errno = ENOENT;
    return stream;
}
#ifdef EDGETERM_APT_RESOLVER_COMPAT
#include "resolv.h"
#endif

extern char **environ;

int edgeterm_exit(int status)
{
    __wasi_proc_exit((__wasi_exitcode_t)status);
}

int edgeterm_unlink(const char *path)
{
    struct stat status;

    if (path == NULL)
    {
        errno = EINVAL;
        return -1;
    }
    if (lstat(path, &status) != 0)
    {
        if (errno == 0 || errno == EBADF)
            errno = ENOENT;
        return -1;
    }

    int result = unlink(path);
    if (result != 0 && errno == 0)
        errno = EIO;
    return result;
}


int edgeterm_rename(const char *source, const char *destination)
{
    struct stat source_status;
    if (source == NULL || destination == NULL)
    {
        errno = EINVAL;
        return -1;
    }
    if (lstat(source, &source_status) != 0)
        return -1;

    if (S_ISLNK(source_status.st_mode))
    {
        size_t capacity = source_status.st_size > 0 ? (size_t)source_status.st_size + 1 : 4096;
        char *target = malloc(capacity);
        if (target == NULL)
        {
            errno = ENOMEM;
            return -1;
        }
        ssize_t length = readlink(source, target, capacity - 1);
        if (length < 0)
        {
            free(target);
            return -1;
        }
        target[length] = '\0';
        unlink(destination);
        int result = symlink(target, destination);
        int saved_errno = errno;
        free(target);
        if (result != 0)
        {
            errno = saved_errno;
            return -1;
        }
        if (unlink(source) != 0)
        {
            saved_errno = errno;
            unlink(destination);
            errno = saved_errno;
            return -1;
        }
        return 0;
    }

    if (!S_ISREG(source_status.st_mode))
    {
        errno = ENOTSUP;
        return -1;
    }

    int source_fd = open(source, O_RDONLY);
    if (source_fd < 0)
        return -1;
    int destination_fd = open(
        destination,
        O_WRONLY | O_CREAT | O_TRUNC,
        source_status.st_mode & 07777
    );
    if (destination_fd < 0)
    {
        int saved_errno = errno;
        close(source_fd);
        errno = saved_errno;
        return -1;
    }

    char buffer[32768];
    int result = 0;
    for (;;)
    {
        ssize_t count = read(source_fd, buffer, sizeof(buffer));
        if (count == 0)
            break;
        if (count < 0)
        {
            result = -1;
            break;
        }
        ssize_t offset = 0;
        while (offset < count)
        {
            ssize_t written = write(destination_fd, buffer + offset, (size_t)(count - offset));
            if (written <= 0)
            {
                result = -1;
                break;
            }
            offset += written;
        }
        if (result != 0)
            break;
    }

    int saved_errno = errno;
    if (close(source_fd) != 0 && result == 0)
    {
        result = -1;
        saved_errno = errno;
    }
    if (close(destination_fd) != 0 && result == 0)
    {
        result = -1;
        saved_errno = errno;
    }
    if (result == 0 && unlink(source) != 0)
    {
        result = -1;
        saved_errno = errno;
    }
    if (result != 0)
        unlink(destination);
    errno = saved_errno;
    return result;
}

pid_t edgeterm_vfork(void)
{
#ifdef EDGETERM_APT_RESOLVER_COMPAT
    errno = ENOTSUP;
    return -1;
#else
    return vfork();
#endif
}

int edgeterm_spawn(
    pid_t *pid,
    const char *path,
    char *const arguments[],
    int input_fd,
    int output_fd,
    int error_fd
)
{
    if (pid == NULL || path == NULL || arguments == NULL)
        return EINVAL;

    posix_spawn_file_actions_t actions;
    int result = posix_spawn_file_actions_init(&actions);
    if (result != 0)
        return result;

    const int source_fds[] = {input_fd, output_fd, error_fd};
    const int target_fds[] = {STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO};
    for (size_t index = 0; index < sizeof(source_fds) / sizeof(source_fds[0]); ++index)
    {
        if (source_fds[index] < 0 || source_fds[index] == target_fds[index])
            continue;
        result = posix_spawn_file_actions_adddup2(&actions, source_fds[index], target_fds[index]);
        if (result != 0)
        {
            posix_spawn_file_actions_destroy(&actions);
            return result;
        }
    }

    result = posix_spawnp(pid, path, &actions, NULL, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    return result;
}

int getservbyport_r(
    int port,
    const char *protocol,
    struct servent *entry,
    char *buffer,
    size_t buffer_size,
    struct servent **result
)
{
    struct service_mapping
    {
        int port;
        const char *name;
        const char *protocol;
    };
    static const struct service_mapping mappings[] = {
        {80, "http", "tcp"},
        {443, "https", "tcp"},
        {21, "ftp", "tcp"},
    };
    const char *requested_protocol = protocol == NULL ? "tcp" : protocol;
    int host_port = ntohs((unsigned short)port);

    if (entry == NULL || buffer == NULL || result == NULL)
        return EINVAL;

    *result = NULL;
    for (size_t index = 0; index < sizeof(mappings) / sizeof(mappings[0]); ++index)
    {
        const struct service_mapping *mapping = &mappings[index];
        if (mapping->port != host_port || strcmp(mapping->protocol, requested_protocol) != 0)
            continue;

        size_t name_size = strlen(mapping->name) + 1;
        size_t protocol_size = strlen(mapping->protocol) + 1;
        size_t aliases_offset = (name_size + protocol_size + sizeof(char *) - 1) & ~(sizeof(char *) - 1);
        size_t required_size = aliases_offset + sizeof(char *);
        if (buffer_size < required_size)
            return ERANGE;

        memcpy(buffer, mapping->name, name_size);
        memcpy(buffer + name_size, mapping->protocol, protocol_size);
        char **aliases = (char **)(void *)(buffer + aliases_offset);
        aliases[0] = NULL;

        entry->s_name = buffer;
        entry->s_aliases = aliases;
        entry->s_port = port;
        entry->s_proto = buffer + name_size;
        *result = entry;
        return 0;
    }

    return ENOENT;
}

int getgroups(int size, gid_t list[])
{
    if (size < 0)
    {
        errno = EINVAL;
        return -1;
    }
    if (size == 0)
        return 1;
    if (list == NULL)
    {
        errno = EFAULT;
        return -1;
    }

    list[0] = getgid();
    return 1;
}

int chroot(const char *path)
{
    if (path != NULL && path[0] == '/' && path[1] == '\0')
        return 0;
    errno = ENOTSUP;
    return -1;
}

int setresuid(uid_t real_uid, uid_t effective_uid, uid_t saved_uid)
{
    if (real_uid != saved_uid)
    {
        errno = ENOTSUP;
        return -1;
    }
    if (setuid(real_uid) != 0)
        return -1;
    return seteuid(effective_uid);
}

int setresgid(gid_t real_gid, gid_t effective_gid, gid_t saved_gid)
{
    if (real_gid != saved_gid)
    {
        errno = ENOTSUP;
        return -1;
    }
    if (setgid(real_gid) != 0)
        return -1;
    return setegid(effective_gid);
}

int getresuid(uid_t *real_uid, uid_t *effective_uid, uid_t *saved_uid)
{
    if (real_uid == NULL || effective_uid == NULL || saved_uid == NULL)
    {
        errno = EFAULT;
        return -1;
    }
    *real_uid = getuid();
    *effective_uid = geteuid();
    *saved_uid = *effective_uid;
    return 0;
}

int getresgid(gid_t *real_gid, gid_t *effective_gid, gid_t *saved_gid)
{
    if (real_gid == NULL || effective_gid == NULL || saved_gid == NULL)
    {
        errno = EFAULT;
        return -1;
    }
    *real_gid = getgid();
    *effective_gid = getegid();
    *saved_gid = *effective_gid;
    return 0;
}

int unlockpt(int file_descriptor)
{
    (void)file_descriptor;
    errno = ENOTSUP;
    return -1;
}

char *ptsname(int file_descriptor)
{
    (void)file_descriptor;
    errno = ENOTSUP;
    return NULL;
}

int ptsname_r(int file_descriptor, char *buffer, size_t buffer_size)
{
    (void)file_descriptor;
    (void)buffer;
    (void)buffer_size;
    errno = ENOTSUP;
    return ENOTSUP;
}

int posix_openpt(int flags)
{
    (void)flags;
    errno = ENOTSUP;
    return -1;
}

int grantpt(int file_descriptor)
{
    (void)file_descriptor;
    errno = ENOTSUP;
    return -1;
}

int mkfifo(const char *path, mode_t mode)
{
    (void)path;
    (void)mode;
    errno = ENOTSUP;
    return -1;
}

int mknod(const char *path, mode_t mode, dev_t device)
{
    (void)path;
    (void)mode;
    (void)device;
    errno = ENOTSUP;
    return -1;
}

#ifdef EDGETERM_APT_RESOLVER_COMPAT
int res_ninit(struct __res_state *state)
{
    if (state == NULL)
    {
        errno = EFAULT;
        return -1;
    }
    state->options = 0;
    return 0;
}

void res_nclose(struct __res_state *state)
{
    (void)state;
}

int res_nquery(
    struct __res_state *state,
    const char *name,
    int dns_class,
    int type,
    unsigned char *answer,
    int answer_length
)
{
    (void)state;
    (void)name;
    (void)dns_class;
    (void)type;
    (void)answer;
    (void)answer_length;
    errno = ENOTSUP;
    return -1;
}

int dn_skipname(const unsigned char *encoded, const unsigned char *end)
{
    (void)encoded;
    (void)end;
    errno = ENOTSUP;
    return -1;
}

int dn_expand(
    const unsigned char *message,
    const unsigned char *end,
    const unsigned char *encoded,
    char *destination,
    int destination_length
)
{
    (void)message;
    (void)end;
    (void)encoded;
    (void)destination;
    (void)destination_length;
    errno = ENOTSUP;
    return -1;
}
#endif
