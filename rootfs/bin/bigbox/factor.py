"""
factor — factor numbers into prime factors.
Usage: factor [NUMBER]...
If no args, read from stdin.
"""
import math
import random
import sys


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: factor [NUMBER]...")
        print("Print prime factors of each number.")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    numbers = []
    for arg in args:
        if arg == "-":
            numbers.extend(sys.stdin.read().split())
        else:
            numbers.append(arg)

    if not numbers:
        numbers = sys.stdin.read().split()
        if not numbers:
            sys.exit(0)

    for num_str in numbers:
        num_str = num_str.strip()
        if not num_str:
            continue
        try:
            n = int(num_str)
        except ValueError:
            print(f"factor: '{num_str}' is not a valid number", file=sys.stderr)
            continue
        if n < 1:
            print(f"factor: '{num_str}' is not a positive integer", file=sys.stderr)
            continue

        if abs(n) > 10**12:
            sys.stderr.write("warning: factoring large numbers may be slow\n")
        factors = factorize(n)
        print(f"{n}: {' '.join(str(f) for f in factors)}")


def factorize(n):
    """Return list of prime factors of n (sorted)."""
    if n == 1:
        return [1]

    factors = []

    # Handle factor 2
    while n % 2 == 0:
        factors.append(2)
        n //= 2

    # Trial division for small factors
    i = 3
    while i * i <= n and i <= 100000:
        while n % i == 0:
            factors.append(i)
            n //= i
        i += 2

    if n == 1:
        return factors

    # Pollard's rho for the remaining large factor
    remaining = pollard_rho_factor(n)
    factors.extend(sorted(remaining))
    return factors


def pollard_rho_factor(n):
    """Factor n using Pollard's rho algorithm. Returns list of prime factors."""
    if n == 1:
        return []
    if is_prime(n):
        return [n]

    factors = []
    d = pollard_rho(n)
    factors.extend(pollard_rho_factor(d))
    factors.extend(pollard_rho_factor(n // d))
    factors.sort()
    return factors


def pollard_rho(n):
    """Find a non-trivial factor of n using Pollard's rho."""
    if n % 2 == 0:
        return 2
    if n % 3 == 0:
        return 3

    while True:
        c = random.randrange(1, n - 1)
        f = lambda x: (x * x + c) % n
        x = random.randrange(2, n - 1)
        y = x
        d = 1

        while d == 1:
            x = f(x)
            y = f(f(y))
            d = math.gcd(abs(x - y), n)

        if d != n:
            return d


def is_prime(n):
    """Miller-Rabin primality test."""
    if n < 2:
        return False
    if n == 2 or n == 3:
        return True
    if n % 2 == 0:
        return False

    # Write n-1 as 2^r * d
    r = 0
    d = n - 1
    while d % 2 == 0:
        r += 1
        d //= 2

    # Witnesses for deterministic Miller-Rabin for n < 2^64
    witnesses = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]
    for a in witnesses:
        if a >= n:
            continue
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


# Ensure math.gcd exists in Python's math module (3.5+ has math.gcd)
if not hasattr(math, 'gcd'):
    math.gcd = __import__('fractions').gcd


if __name__ == "__main__":
    main(sys.argv[1:])
