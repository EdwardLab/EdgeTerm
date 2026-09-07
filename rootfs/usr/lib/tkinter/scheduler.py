import itertools
import time


class Scheduler:
    def __init__(self):
        self._ids = itertools.count(1)
        self._tasks = {}

    def after(self, ms, callback=None, *args):
        ident = f"after#{next(self._ids)}"
        due = time.monotonic() + max(0, int(ms or 0)) / 1000.0
        self._tasks[ident] = (due, callback, args)
        return ident

    def after_idle(self, callback, *args):
        return self.after(0, callback, *args)

    def after_cancel(self, ident):
        self._tasks.pop(ident, None)

    def run_due(self):
        now = time.monotonic()
        due = [item for item, task in list(self._tasks.items()) if task[0] <= now]
        for ident in due:
            _, callback, args = self._tasks.pop(ident, (0, None, ()))
            if callback is not None:
                callback(*args)
        return len(due)

    def has_tasks(self):
        return bool(self._tasks)


default_scheduler = Scheduler()
