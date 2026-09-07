import tkinter as tk

root = tk.Tk()
root.title("Canvas Paint")
canvas = tk.Canvas(root, width=360, height=220, background="white")
canvas.pack()
last = [None]

def down(event):
    last[0] = (event.x, event.y)

def drag(event):
    if last[0]:
        x, y = last[0]
        canvas.create_line(x, y, event.x, event.y, fill="black")
        last[0] = (event.x, event.y)

canvas.bind("<Button-1>", down)
canvas.bind("<Motion>", drag)
root.mainloop()
