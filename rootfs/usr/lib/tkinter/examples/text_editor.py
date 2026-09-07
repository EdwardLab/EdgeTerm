import tkinter as tk
from tkinter import filedialog

root = tk.Tk()
root.title("Text Editor")
text = tk.Text(root, width=60, height=18)
text.pack()

def open_file():
    path = filedialog.askopenfilename()
    if path:
        text.delete("1.0", "end")
        text.insert("1.0", open(path, encoding="utf-8").read())

tk.Button(root, text="Open", command=open_file).pack()
root.mainloop()
