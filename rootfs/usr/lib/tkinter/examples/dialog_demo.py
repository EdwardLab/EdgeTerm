import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox, simpledialog

root = tk.Tk()
root.title("Dialogs")
tk.Button(root, text="Info", command=lambda: messagebox.showinfo("Info", "Hello")).pack()
tk.Button(root, text="File", command=lambda: print(filedialog.askopenfilename())).pack()
tk.Button(root, text="String", command=lambda: print(simpledialog.askstring("Name", "Name?"))).pack()
tk.Button(root, text="Color", command=lambda: print(colorchooser.askcolor())).pack()
root.mainloop()
