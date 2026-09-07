class Compositor:
    def __init__(self):
        self.windows = []

    def add(self, window):
        if window not in self.windows:
            self.windows.append(window)

    def lift(self, window):
        if window in self.windows:
            self.windows.remove(window)
        self.windows.append(window)

    def lower(self, window):
        if window in self.windows:
            self.windows.remove(window)
        self.windows.insert(0, window)
