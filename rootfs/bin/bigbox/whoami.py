import os

def main(args):
    print(os.environ.get("EDGE_USER", "user"))
