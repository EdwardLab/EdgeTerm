#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(void)
{
    char *const args[] = {"busybox", "echo", "execv-ok", NULL};
    execv("/bin/busybox", args);
    perror("execvp");
    printf("exec errno=%d\n", errno);
    return errno;
}
