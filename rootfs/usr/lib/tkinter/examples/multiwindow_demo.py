import tkinter as tk

root = tk.Tk()
root.title("Main Window")
tk.Label(root, text="Main").pack()
for i in range(2):
    win = tk.Toplevel(root)
    win.title(f"Tool {i + 1}")
    tk.Label(win, text=f"Toplevel {i + 1}").pack()
root.mainloop()
