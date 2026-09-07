import tkinter as tk

root = tk.Tk()
root.title("Calculator")
value = tk.StringVar(value="")
entry = tk.Entry(root, textvariable=value, width=24)
entry.grid(row=0, column=0, columnspan=4)

def press(token):
    if token == "=":
        try:
            value.set(str(eval(value.get(), {"__builtins__": {}}, {})))
        except Exception:
            value.set("Error")
    elif token == "C":
        value.set("")
    else:
        value.set(value.get() + token)

for i, token in enumerate("789/456*123-0.C+"):
    tk.Button(root, text=token, command=lambda t=token: press(t)).grid(row=1 + i // 4, column=i % 4)
tk.Button(root, text="=", command=lambda: press("=")).grid(row=5, column=0, columnspan=4)
root.mainloop()
