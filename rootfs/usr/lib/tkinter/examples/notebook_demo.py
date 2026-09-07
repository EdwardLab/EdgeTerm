import tkinter as tk
from tkinter import ttk

root = tk.Tk()
root.title("Notebook Demo")
book = ttk.Notebook(root)
for name in ("General", "Advanced"):
    frame = ttk.Frame(book)
    ttk.Label(frame, text=name).pack()
    book.add(frame, text=name)
book.pack()
root.mainloop()
