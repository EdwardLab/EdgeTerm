#include <stdexcept>

int main(void)
{
    try {
        throw std::runtime_error("probe");
    } catch (const std::runtime_error &) {
        return 0;
    }
}
