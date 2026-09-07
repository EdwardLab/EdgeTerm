#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

int main(void)
{
    pid_t child = -1;
    char *const arguments[] = {"echo", "spawn-child-ok", NULL};
    const int spawn_result = posix_spawnp(&child, "echo", NULL, NULL, arguments, environ);
    if (spawn_result != 0) {
        fprintf(stderr, "posix_spawnp failed: %d\n", spawn_result);
        return 71;
    }

    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        perror("waitpid");
        return 72;
    }
    if (!WIFEXITED(status)) {
        return 73;
    }
    printf("spawn-wait-ok:%d\n", WEXITSTATUS(status));
    return WEXITSTATUS(status);
}
