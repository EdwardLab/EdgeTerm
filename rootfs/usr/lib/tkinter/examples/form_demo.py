import tkinter as tk

root = tk.Tk()
root.title("Form Demo")
name = tk.StringVar()
enabled = tk.BooleanVar(value=True)
tk.Label(root, text="Name").grid(row=0, column=0)
tk.Entry(root, textvariable=name).grid(row=0, column=1)
tk.Checkbutton(root, text="Enabled", variable=enabled).grid(row=1, column=1)
tk.Button(root, text="Submit", command=lambda: print(name.get(), enabled.get())).grid(row=2, column=1)
root.mainloop()
