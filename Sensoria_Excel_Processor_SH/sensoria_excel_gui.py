#!/usr/bin/env python3
"""
Minimal macOS desktop app for processing Sensoria Excel logs.

It uses build_modified_excel.write_modified_xlsx to recompute:
- bongiorno index sx/dx
- angolo tibia sx/dx
- angolo ginocchio
"""

from __future__ import annotations

import os
import subprocess
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from build_modified_excel import write_modified_xlsx


APP_BG = "#0B1020"
PANEL_BG = "#121A2E"
TEXT = "#E5E7EB"
MUTED = "#9CA3AF"
ACCENT = "#22C55E"
ACCENT_ALT = "#06B6D4"
INPUT_BG = "#1E293B"
INPUT_FG = "#F8FAFC"
BTN_TEXT = "#031A11"


class SensoriaExcelApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Sensoria Excel Processor")
        self.root.geometry("860x430")
        self.root.minsize(760, 390)
        self.root.configure(bg=APP_BG)

        self.input_path = tk.StringVar(value="")
        self.output_path = tk.StringVar(value="")
        self.status_text = tk.StringVar(value="Seleziona il file .xlsx da elaborare.")

        self._build_styles()
        self._build_ui()

    def _build_styles(self) -> None:
        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "Accent.Horizontal.TProgressbar",
            troughcolor="#1F2A44",
            background=ACCENT_ALT,
            lightcolor=ACCENT_ALT,
            darkcolor=ACCENT_ALT,
            bordercolor="#1F2A44",
        )

    def _build_ui(self) -> None:
        frame = tk.Frame(self.root, bg=PANEL_BG, bd=0, highlightthickness=0)
        frame.pack(fill="both", expand=True, padx=24, pady=24)

        title = tk.Label(
            frame,
            text="Sensoria Excel Processor",
            font=("Avenir Next", 24, "bold"),
            bg=PANEL_BG,
            fg=TEXT,
            anchor="w",
        )
        title.pack(fill="x", pady=(2, 4))

        subtitle = tk.Label(
            frame,
            text="Ricalcola BI, angoli tibie e angolo ginocchio con calibrazione mediana 5s.",
            font=("Avenir Next", 12),
            bg=PANEL_BG,
            fg=MUTED,
            anchor="w",
        )
        subtitle.pack(fill="x", pady=(0, 20))

        self._path_row(
            parent=frame,
            label="File input (.xlsx)",
            var=self.input_path,
            choose_cb=self.choose_input,
        )
        self._path_row(
            parent=frame,
            label="File output (.xlsx)",
            var=self.output_path,
            choose_cb=self.choose_output,
        )

        controls = tk.Frame(frame, bg=PANEL_BG)
        controls.pack(fill="x", pady=(8, 10))

        self.run_btn = tk.Button(
            controls,
            text="Elabora File",
            command=self.run_job,
            bg=ACCENT,
            fg=BTN_TEXT,
            activebackground="#16A34A",
            activeforeground=BTN_TEXT,
            font=("Avenir Next", 13, "bold"),
            relief="flat",
            padx=16,
            pady=10,
            cursor="hand2",
        )
        self.run_btn.pack(side="left")

        self.open_out_btn = tk.Button(
            controls,
            text="Mostra Output",
            command=self.reveal_output,
            bg="#1F2A44",
            fg=TEXT,
            activebackground="#26365B",
            activeforeground=TEXT,
            font=("Avenir Next", 12, "bold"),
            relief="flat",
            padx=14,
            pady=10,
            cursor="hand2",
        )
        self.open_out_btn.pack(side="left", padx=(12, 0))

        self.progress = ttk.Progressbar(
            frame,
            mode="indeterminate",
            style="Accent.Horizontal.TProgressbar",
            length=300,
        )
        self.progress.pack(fill="x", pady=(10, 0))

        status = tk.Label(
            frame,
            textvariable=self.status_text,
            font=("Avenir Next", 11),
            bg=PANEL_BG,
            fg=MUTED,
            anchor="w",
            justify="left",
        )
        status.pack(fill="x", pady=(10, 0))

    def _path_row(
        self,
        parent: tk.Widget,
        label: str,
        var: tk.StringVar,
        choose_cb,
    ) -> None:
        outer = tk.Frame(parent, bg=PANEL_BG)
        outer.pack(fill="x", pady=(0, 14))

        lbl = tk.Label(
            outer,
            text=label,
            font=("Avenir Next", 12, "bold"),
            bg=PANEL_BG,
            fg=TEXT,
            anchor="w",
        )
        lbl.pack(fill="x", pady=(0, 6))

        row = tk.Frame(outer, bg=PANEL_BG)
        row.pack(fill="x")

        entry = tk.Entry(
            row,
            textvariable=var,
            font=("SF Mono", 11),
            bg=INPUT_BG,
            fg=INPUT_FG,
            insertbackground=INPUT_FG,
            relief="flat",
            highlightthickness=1,
            highlightbackground="#334155",
            highlightcolor=ACCENT_ALT,
        )
        entry.pack(side="left", fill="x", expand=True, ipady=10)

        btn = tk.Button(
            row,
            text="Scegli...",
            command=choose_cb,
            bg=ACCENT_ALT,
            fg="#032430",
            activebackground="#0891B2",
            activeforeground="#032430",
            font=("Avenir Next", 11, "bold"),
            relief="flat",
            padx=12,
            pady=10,
            cursor="hand2",
        )
        btn.pack(side="left", padx=(10, 0))

    def choose_input(self) -> None:
        selected = filedialog.askopenfilename(
            title="Seleziona il file Excel da modificare",
            filetypes=[("Excel Workbook", "*.xlsx"), ("All files", "*.*")],
        )
        if not selected:
            return
        self.input_path.set(selected)

        if not self.output_path.get().strip():
            folder = os.path.dirname(selected)
            base = os.path.splitext(os.path.basename(selected))[0]
            self.output_path.set(os.path.join(folder, f"{base}_modified.xlsx"))

    def choose_output(self) -> None:
        suggested = self.output_path.get().strip()
        initial_dir = os.path.dirname(suggested) if suggested else os.getcwd()
        initial_file = os.path.basename(suggested) if suggested else "output_modified.xlsx"

        selected = filedialog.asksaveasfilename(
            title="Salva file modificato",
            initialdir=initial_dir,
            initialfile=initial_file,
            defaultextension=".xlsx",
            filetypes=[("Excel Workbook", "*.xlsx"), ("All files", "*.*")],
        )
        if not selected:
            return
        if not selected.lower().endswith(".xlsx"):
            selected += ".xlsx"
        self.output_path.set(selected)

    def set_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        self.run_btn.configure(state=state)
        self.open_out_btn.configure(state=state)
        if busy:
            self.progress.start(8)
        else:
            self.progress.stop()

    def run_job(self) -> None:
        in_path = self.input_path.get().strip()
        out_path = self.output_path.get().strip()

        if not in_path:
            messagebox.showerror("Input mancante", "Seleziona un file input .xlsx.")
            return
        if not os.path.isfile(in_path):
            messagebox.showerror("Input non valido", f"File non trovato:\n{in_path}")
            return
        if not in_path.lower().endswith(".xlsx"):
            messagebox.showerror("Input non valido", "Il file input deve essere .xlsx")
            return

        if not out_path:
            messagebox.showerror("Output mancante", "Seleziona il file output .xlsx.")
            return
        if not out_path.lower().endswith(".xlsx"):
            out_path += ".xlsx"
            self.output_path.set(out_path)

        out_dir = os.path.dirname(out_path) or "."
        os.makedirs(out_dir, exist_ok=True)

        self.set_busy(True)
        self.status_text.set("Elaborazione in corso... Attendi.")

        worker = threading.Thread(
            target=self._run_worker,
            args=(in_path, out_path),
            daemon=True,
        )
        worker.start()

    def _run_worker(self, in_path: str, out_path: str) -> None:
        try:
            write_modified_xlsx(in_path, out_path)
        except Exception as exc:  # noqa: BLE001
            self.root.after(0, self._on_failed, str(exc))
            return
        self.root.after(0, self._on_done, out_path)

    def _on_done(self, out_path: str) -> None:
        self.set_busy(False)
        self.status_text.set(f"Completato: {out_path}")
        should_reveal = messagebox.askyesno(
            "Operazione completata",
            f"File creato con successo:\n{out_path}\n\nVuoi mostrarlo nel Finder?",
        )
        if should_reveal:
            self._reveal_path(out_path)

    def _on_failed(self, error_text: str) -> None:
        self.set_busy(False)
        self.status_text.set("Errore durante l'elaborazione.")
        messagebox.showerror("Errore", f"Non e' stato possibile completare l'operazione:\n{error_text}")

    def reveal_output(self) -> None:
        out_path = self.output_path.get().strip()
        if not out_path:
            messagebox.showinfo("Output non impostato", "Seleziona prima un file output.")
            return
        if os.path.exists(out_path):
            self._reveal_path(out_path)
            return
        out_dir = os.path.dirname(out_path)
        if out_dir and os.path.isdir(out_dir):
            self._open_folder(out_dir)
            return
        messagebox.showinfo("Output non trovato", "Il file/cartella output non esiste ancora.")

    @staticmethod
    def _reveal_path(path: str) -> None:
        try:
            subprocess.run(["open", "-R", path], check=False)
        except Exception:
            pass

    @staticmethod
    def _open_folder(path: str) -> None:
        try:
            subprocess.run(["open", path], check=False)
        except Exception:
            pass


def main() -> None:
    root = tk.Tk()
    app = SensoriaExcelApp(root)
    _ = app
    root.mainloop()


if __name__ == "__main__":
    main()
