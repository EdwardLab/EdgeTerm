"""
groups — print group memberships.
Usage: groups [USER]...
Wrapper that calls id with -Gn style output.
"""
import sys
import id as id_mod  # local module


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: groups [USER]...")
        print("Print group memberships for each user.")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    if args:
        for user in args:
            info = id_mod.get_user_info(user)
            if info:
                group_names = " ".join(g["name"] for g in info["groups"])
                print(f"{user} : {group_names}")
            else:
                print(f"groups: {user}: no such user", file=sys.stderr)
                sys.exit(1)
    else:
        info = id_mod.get_current_user_info()
        group_names = " ".join(g["name"] for g in info["groups"])
        print(group_names)


if __name__ == "__main__":
    main(sys.argv[1:])
