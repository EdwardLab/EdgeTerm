"""
users — print currently logged-in users.
Shows EDGE_USER or "user".
"""
import sys
import os


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: users")
        print("Print the usernames of users currently logged in.")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    username = os.environ.get("EDGE_USER", "user")
    print(username)


if __name__ == "__main__":
    main(sys.argv[1:])
