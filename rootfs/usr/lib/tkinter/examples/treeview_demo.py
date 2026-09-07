import tkinter as tk
from tkinter import ttk

root = tk.Tk()
root.title("Treeview Demo")
tree = ttk.Treeview(root, columns=("size",))
tree.heading("size", text="Size")
tree.pack()
folder = tree.insert("", "end", text="project", values=("",), open=True)
tree.insert(folder, "end", text="README.md", values=("4 KB",))
tree.insert(folder, "end", text="app.py", values=("9 KB",))
root.mainloop()
