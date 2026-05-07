"""
id — print user and group info.
Usage: id [OPTION]... [USER]
For EdgeTerm: uses EDGE_USER env, uid/gid derived from username hash.
"""
import sys
import os
import hashlib


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: id [OPTION]... [USER]")
        print("  -u    print only the effective user ID")
        print("  -g    print only the effective group ID")
        print("  -G    print only the group IDs")
        print("  -n    print name instead of number")
        print("  -r    print real ID instead of effective")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    uid_only = False
    gid_only = False
    groups_only = False
    name_only = False
    real_id = False
    user = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--"):
            for ch in arg[1:]:
                if ch == 'u':
                    uid_only = True
                elif ch == 'g':
                    gid_only = True
                elif ch == 'G':
                    groups_only = True
                elif ch == 'n':
                    name_only = True
                elif ch == 'r':
                    real_id = True
                else:
                    print(f"id: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        else:
            user = arg
            i += 1

    if user:
        info = get_user_info(user)
    else:
        info = get_current_user_info()

    if not info:
        if user:
            print(f"id: {user}: no such user", file=sys.stderr)
        else:
            print("id: cannot find current user", file=sys.stderr)
        sys.exit(1)

    if uid_only:
        if name_only:
            print(info["name"])
        else:
            print(info["uid"])
        return

    if gid_only:
        if name_only:
            print(info["gid_name"])
        else:
            print(info["gid"])
        return

    if groups_only:
        group_info = []
        for g in info["groups"]:
            if name_only:
                group_info.append(g["name"])
            else:
                group_info.append(str(g["gid"]))
        print(" ".join(group_info))
        return

    # Default output
    print(f"uid={info['uid']}({info['name']}) gid={info['gid']}({info['gid_name']}) "
          f"groups={' '.join(f'{g[\"gid\"]}({g[\"name\"]})' for g in info['groups'])}")


def get_current_user_info():
    """Get info about the current user."""
    username = os.environ.get("EDGE_USER", "user")
    uid = hash_username(username)
    gid = uid

    return {
        "name": username,
        "uid": uid,
        "gid": gid,
        "gid_name": username,
        "groups": [{"name": username, "gid": gid}],
    }


def get_user_info(user):
    """Get info about a specific user."""
    username = user
    uid = hash_username(username)
    gid = uid

    return {
        "name": username,
        "uid": uid,
        "gid": gid,
        "gid_name": username,
        "groups": [{"name": username, "gid": gid}],
    }


def hash_username(username):
    """Generate a consistent UID from a username."""
    hash_obj = hashlib.md5(username.encode("utf-8"))
    # Map to a user ID range (1000-65535)
    uid = 1000 + (int(hash_obj.hexdigest()[:8], 16) % 64536)
    return uid


if __name__ == "__main__":
    main(sys.argv[1:])
