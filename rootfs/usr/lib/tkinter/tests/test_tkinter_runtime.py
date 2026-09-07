import unittest

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from tkinter.events import Event


class TkinterRuntimeTests(unittest.TestCase):
    def test_widget_lifecycle_and_layout(self):
        root = tk.Tk()
        frame = tk.Frame(root)
        frame.pack(side=tk.LEFT, fill=tk.BOTH)
        label = tk.Label(frame, text="Hello")
        label.grid(row=0, column=0)
        self.assertEqual(label.cget("text"), "Hello")
        self.assertIn(label, frame.winfo_children())
        self.assertEqual(label.grid_info()["row"], 0)
        label.destroy()
        self.assertFalse(label.winfo_exists())

    def test_variables_and_traces(self):
        seen = []
        var = tk.StringVar(value="a")
        var.trace_add("write", lambda *args: seen.append(var.get()))
        var.set("b")
        self.assertEqual(var.get(), "b")
        self.assertEqual(seen, ["b"])

    def test_event_dispatch_and_scheduler(self):
        root = tk.Tk()
        button = tk.Button(root)
        seen = []
        button.bind("<Button-1>", lambda event: seen.append(event.type))
        button.event_generate("<Button-1>")
        root.after(0, lambda: seen.append("after"))
        root.update()
        self.assertEqual(seen, ["<Button-1>", "after"])

    def test_browser_event_payload_routes_to_widget(self):
        root = tk.Tk()
        value = tk.StringVar()
        entry = tk.Entry(root, textvariable=value)
        clicked = []
        button = tk.Button(root, text="Go", command=lambda: clicked.append(value.get()))
        entry._dispatch("input", Event(widget=entry, value="abc"))
        button._dispatch("<Button-1>", Event(widget=button))
        self.assertEqual(value.get(), "abc")
        self.assertEqual(clicked, ["abc"])

    def test_canvas_behavior(self):
        root = tk.Tk()
        canvas = tk.Canvas(root, width=100, height=80)
        item = canvas.create_rectangle(1, 2, 20, 30, fill="red", tags="box")
        self.assertEqual(canvas.find_withtag("box"), (item,))
        canvas.move(item, 3, 4)
        self.assertEqual(canvas.coords(item), [4, 6, 23, 34])
        self.assertEqual(canvas.bbox("all"), (4, 6, 23, 34))

    def test_text_listbox_treeview_dialogs(self):
        root = tk.Tk()
        text = tk.Text(root)
        text.insert("1.0", "abc")
        text.delete("1.1", "1.2")
        self.assertEqual(text.get("1.0", "end"), "ac")
        box = tk.Listbox(root)
        box.insert("end", "one", "two")
        box.selection_set(1)
        self.assertEqual(box.curselection(), (1,))
        tree = ttk.Treeview(root, columns=("value",))
        iid = tree.insert("", "end", text="node", values=(42,))
        tree.selection_set(iid)
        self.assertEqual(tree.selection(), (iid,))
        self.assertEqual(messagebox.askyesno("t", "m"), True)
        self.assertIsInstance(filedialog.askdirectory(), str)

    def test_focus_and_window_stacking(self):
        root = tk.Tk()
        a = tk.Toplevel(root)
        b = tk.Toplevel(root)
        a.focus_set()
        self.assertIs(a.focus_get(), a)
        a.lower()
        b.lift()
        self.assertIn(b, root.winfo_children())


if __name__ == "__main__":
    unittest.main()
