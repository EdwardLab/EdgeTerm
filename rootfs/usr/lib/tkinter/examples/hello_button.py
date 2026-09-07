import tkinter as tk
from tkinter import messagebox

root = tk.Tk()
root.title("Hello Button")
tk.Label(root, text="EdgeTerm tkinter").pack(padx=8, pady=6)
tk.Button(root, text="Say hello", command=lambda: messagebox.showinfo("Hello", "Hello from tkinter")).pack(padx=8, pady=6)
root.mainloop()
