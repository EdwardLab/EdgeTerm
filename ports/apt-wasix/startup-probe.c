#include <unistd.h>

int main(void)
{
    static const char message[] = "wasix-c-main-ok\n";
    return write(STDOUT_FILENO, message, sizeof(message) - 1) < 0;
}
