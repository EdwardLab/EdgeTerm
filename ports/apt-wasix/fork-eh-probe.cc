#include <sys/wait.h>
#include <unistd.h>

extern "C" pid_t fork(void);

int main(void)
{
    const pid_t child = fork();
    if (child < 0) {
        return 71;
    }
    if (child == 0) {
        _exit(23);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        return 72;
    }
    return WIFEXITED(status) && WEXITSTATUS(status) == 23 ? 0 : 73;
}
