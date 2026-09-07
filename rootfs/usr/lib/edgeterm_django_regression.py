import importlib.util
import os
import runpy
import sqlite3
import sys


def run():
    if importlib.util.find_spec("django") is None:
        print("SKIP django regression: django is not installed")
        return 0

    root = "/tmp/edgeterm-django-regression"
    project = os.path.join(root, "mysite")
    _remove_tree(root)
    os.makedirs(root, exist_ok=True)
    old_cwd = os.getcwd()
    old_argv = list(sys.argv)
    old_path = list(sys.path)
    old_async = os.environ.get("DJANGO_ALLOW_ASYNC_UNSAFE")
    try:
        os.chdir(root)
        sys.argv = ["django", "startproject", "mysite"]
        runpy.run_module("django", run_name="__main__", alter_sys=True)

        manage_py = os.path.join(project, "manage.py")
        if not os.path.isfile(manage_py):
            raise AssertionError("startproject did not create manage.py")

        os.chdir(project)
        os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = "true"
        sys.argv = [manage_py, "migrate", "--noinput"]
        if sys.path:
            sys.path[0] = project
        else:
            sys.path.insert(0, project)
        runpy.run_path(manage_py, run_name="__main__")

        db_path = os.path.join(project, "db.sqlite3")
        if not os.path.isfile(db_path):
            raise AssertionError("migrate did not create db.sqlite3")
        with sqlite3.connect(db_path) as conn:
            tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        expected = {"django_migrations", "auth_user", "django_content_type"}
        missing = expected - tables
        if missing:
            raise AssertionError(f"migrate missing expected tables: {sorted(missing)}")

        wsgi = runpy.run_module("mysite.wsgi", run_name="edgeterm_wsgi_test")
        if "application" not in wsgi:
            raise AssertionError("mysite.wsgi did not expose application")
        print("PASS django regression")
        return 0
    finally:
        os.chdir(old_cwd)
        sys.argv = old_argv
        sys.path[:] = old_path
        if old_async is None:
            os.environ.pop("DJANGO_ALLOW_ASYNC_UNSAFE", None)
        else:
            os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = old_async
        _remove_tree(root)


def _remove_tree(path):
    if not os.path.exists(path):
        return
    for root, dirs, files in os.walk(path, topdown=False):
        for name in files:
            try:
                os.remove(os.path.join(root, name))
            except OSError:
                pass
        for name in dirs:
            try:
                os.rmdir(os.path.join(root, name))
            except OSError:
                pass
    try:
        os.rmdir(path)
    except OSError:
        pass


if __name__ == "__main__":
    raise SystemExit(run())
