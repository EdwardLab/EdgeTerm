import tkinter as tk

root = tk.Tk()
root.title("Menu Demo")
menu = tk.Menu(root)
menu.add_command(label="New", command=lambda: print("new"))
menu.add_separator()
menu.add_command(label="Exit", command=root.quit)
root.config(menu=menu)
tk.Label(root, text="Menu configured").pack()
root.mainloop()
