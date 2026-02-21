#!/usr/bin/env python3
"""
Single-file Sensoria Excel converter with GUI.

Features:
- One Python file only (GUI + conversion logic)
- Recomputes BI/Tibia/Knee columns directly in XLSX
- Friendly desktop workflow (input/output picker, status, log, quick actions)
"""

from __future__ import annotations

import math
import os
import posixpath
import re
import statistics
import subprocess
import threading
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


# ===== XLSX conversion core =====
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = f"{{{NS_MAIN}}}"
NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

ET.register_namespace("", NS_MAIN)

HEADER_TARGETS = {
    "bongiorno index sx": "T",
    "bongiorno index dx": "U",
    "angolo tibia sx": "V",
    "angolo tibia dx": "W",
    "angolo ginocchio": "X",
}

TIBIA_CALIB_MS = 5000.0
TIBIA_MIN_CALIB_SAMPLES = 8
TIBIA_AVG_WINDOW_MS = 10.0

KNEE_CALIB_MS = 5000.0
KNEE_MIN_CALIB_SAMPLES = 5
KNEE_SYNC_MAX_DT_MS = 80.0
KNEE_AVG_WINDOW_MS = 10.0

BI_AVG_WINDOW_MS = 100.0


@dataclass
class Record:
    row_elem: ET.Element
    row_num: int
    order_idx: int
    t_ms: Optional[float]
    sensor_norm: str
    is_sock: bool
    is_left: bool
    is_right: bool
    is_knee_sup: bool
    is_knee_inf: bool
    ax: Optional[float]
    ay: Optional[float]
    az: Optional[float]


def col_letters(cell_ref: str) -> str:
    m = re.match(r"([A-Z]+)", cell_ref or "")
    return m.group(1) if m else ""


def col_to_idx(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def parse_num(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def parse_timestamp_to_ms(value: Optional[str]) -> Optional[float]:
    v = parse_num(value)
    if v is None:
        return None

    # Excel serial date
    if 20000.0 <= v <= 70000.0:
        return v * 86400000.0

    # Unix seconds
    if abs(v) < 1e12:
        return v * 1000.0

    # Unix milliseconds
    return v


def wrap_deg_180(a: float) -> float:
    x = a
    while x > 180.0:
        x -= 360.0
    while x < -180.0:
        x += 360.0
    return x


def median_finite(vals: List[float]) -> Optional[float]:
    finite = [x for x in vals if isinstance(x, (int, float)) and math.isfinite(x)]
    if not finite:
        return None
    return float(statistics.median(finite))


def tibia_raw_deg(ay: float, az: float) -> float:
    return math.degrees(math.atan2(az, ay))


def map_tibia_deg(deg_zeroed: float, side: str) -> float:
    # Mirror-mounted sensors: flip LEFT side sign.
    return -deg_zeroed if side == "left" else deg_zeroed


def knee_tilt_deg(ay: float, az: float) -> float:
    return math.degrees(math.atan2(az, ay))


def calc_bi(ax: float, ay: float, az: float) -> float:
    norm = math.sqrt(ax * ax + ay * ay + az * az)
    if not math.isfinite(norm) or norm < 1e-6:
        return 0.0
    bi = abs(az) / norm * 100.0
    return max(0.0, min(100.0, bi))


def norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[_\-]+", " ", (name or "").lower())).strip()


def is_knee(name_norm: str) -> bool:
    return "ginocchio" in name_norm


def is_knee_sup(name_norm: str) -> bool:
    if not is_knee(name_norm):
        return False
    tokens = ["sup", "super", "superiore", "upper", "up", "alto"]
    return any(t in name_norm for t in tokens)


def is_knee_inf(name_norm: str) -> bool:
    if not is_knee(name_norm):
        return False
    tokens = ["inf", "infer", "inferiore", "lower", "down", "basso"]
    return any(t in name_norm for t in tokens)


def read_shared_strings(zin: zipfile.ZipFile) -> List[str]:
    try:
        xml_bytes = zin.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ET.fromstring(xml_bytes)
    out: List[str] = []
    for si in root.findall(f"{NS}si"):
        out.append("".join((t.text or "") for t in si.iter(f"{NS}t")))
    return out


def resolve_first_sheet_path(zin: zipfile.ZipFile) -> str:
    wb = ET.fromstring(zin.read("xl/workbook.xml"))
    rels = ET.fromstring(zin.read("xl/_rels/workbook.xml.rels"))

    rid_attr = f"{{{NS_REL_DOC}}}id"
    sheets = wb.find(f"{NS}sheets")
    if sheets is None:
        raise RuntimeError("Workbook has no sheets section.")

    first_sheet = sheets.find(f"{NS}sheet")
    if first_sheet is None:
        raise RuntimeError("Workbook has no sheet entries.")

    rid = first_sheet.attrib.get(rid_attr)
    if not rid:
        raise RuntimeError("Cannot resolve first worksheet relationship id.")

    target = None
    for rel in rels.findall(f"{{{NS_REL_PKG}}}Relationship"):
        if rel.attrib.get("Id") == rid:
            target = rel.attrib.get("Target")
            break

    if not target:
        raise RuntimeError("Cannot resolve first worksheet target.")

    if target.startswith("/"):
        target = target.lstrip("/")
    else:
        target = posixpath.normpath(posixpath.join("xl", target))

    if not target.startswith("xl/"):
        target = posixpath.normpath(posixpath.join("xl", target))

    return target


def read_cell_text(cell: ET.Element, shared_strings: List[str]) -> str:
    t_attr = cell.attrib.get("t")

    if t_attr == "inlineStr":
        isel = cell.find(f"{NS}is")
        if isel is None:
            return ""
        return "".join((tn.text or "") for tn in isel.iter(f"{NS}t"))

    v = cell.find(f"{NS}v")
    raw = v.text if v is not None and v.text is not None else ""

    if t_attr == "s":
        try:
            idx = int(float(raw))
        except (ValueError, TypeError):
            return ""
        if 0 <= idx < len(shared_strings):
            return shared_strings[idx]
        return ""

    return raw


def get_row_cells_map(row: ET.Element) -> Dict[str, ET.Element]:
    out: Dict[str, ET.Element] = {}
    for c in row.findall(f"{NS}c"):
        ref = c.attrib.get("r", "")
        col = col_letters(ref)
        if col:
            out[col] = c
    return out


def get_or_create_cell(row: ET.Element, row_num: int, col: str) -> ET.Element:
    cells = row.findall(f"{NS}c")
    target_ref = f"{col}{row_num}"
    target_idx = col_to_idx(col)

    for c in cells:
        if c.attrib.get("r", "") == target_ref:
            return c

    new_cell = ET.Element(f"{NS}c", {"r": target_ref})
    inserted = False
    for i, c in enumerate(cells):
        cidx = col_to_idx(col_letters(c.attrib.get("r", "")))
        if cidx > target_idx:
            row.insert(i, new_cell)
            inserted = True
            break
    if not inserted:
        row.append(new_cell)
    return new_cell


def set_cell_inline_text(row: ET.Element, row_num: int, col: str, text: str) -> None:
    cell = get_or_create_cell(row, row_num, col)
    for ch in list(cell):
        cell.remove(ch)
    cell.attrib["t"] = "inlineStr"
    isel = ET.SubElement(cell, f"{NS}is")
    tel = ET.SubElement(isel, f"{NS}t")
    tel.text = text


def set_cell_number(row: ET.Element, row_num: int, col: str, value: Optional[float]) -> None:
    cells = get_row_cells_map(row)
    existing = cells.get(col)
    if value is None or not math.isfinite(value):
        if existing is not None:
            row.remove(existing)
        return

    cell = existing if existing is not None else get_or_create_cell(row, row_num, col)
    for ch in list(cell):
        cell.remove(ch)
    if "t" in cell.attrib:
        del cell.attrib["t"]
    v = ET.SubElement(cell, f"{NS}v")
    v.text = f"{value:.10f}"


def find_header_row_and_columns(
    sheet_root: ET.Element,
    shared_strings: List[str],
) -> Tuple[ET.Element, int, Dict[str, str]]:
    sheet_data = sheet_root.find(f"{NS}sheetData")
    if sheet_data is None:
        raise RuntimeError("sheetData not found in worksheet.")

    for row in sheet_data.findall(f"{NS}row"):
        cells = get_row_cells_map(row)
        text_by_col = {
            col: read_cell_text(cell, shared_strings).strip()
            for col, cell in cells.items()
        }
        vals = {v.lower(): k for k, v in text_by_col.items()}
        if "timestamp" in vals and "sensor_name" in vals:
            row_num = int(row.attrib.get("r", "0"))
            return row, row_num, vals

    raise RuntimeError("Header row with timestamp/sensor_name not found.")


def moving_avg_pairs(pairs: List[Tuple[float, float]], now_t: float, window_ms: float) -> Optional[float]:
    t_min = now_t - window_ms
    vals = [v for (t, v) in pairs if t_min <= t <= now_t and math.isfinite(v)]
    if not vals:
        return None
    return sum(vals) / len(vals)


def recompute_columns(sheet_root: ET.Element, shared_strings: List[str]) -> None:
    header_row, header_row_num, headers = find_header_row_and_columns(sheet_root, shared_strings)
    sheet_data = sheet_root.find(f"{NS}sheetData")
    if sheet_data is None:
        raise RuntimeError("sheetData not found.")

    for name, col in HEADER_TARGETS.items():
        set_cell_inline_text(header_row, header_row_num, col, name)

    col_timestamp = headers["timestamp"]
    col_sensor = headers["sensor_name"]
    col_ax = headers.get("accel_x")
    col_ay = headers.get("accel_y")
    col_az = headers.get("accel_z")

    if not (col_ax and col_ay and col_az):
        raise RuntimeError("Missing accel_x/accel_y/accel_z columns in header.")

    records: List[Record] = []
    order_idx = 0
    for row in sheet_data.findall(f"{NS}row"):
        row_num = int(row.attrib.get("r", "0"))
        if row_num <= header_row_num:
            continue

        cells = get_row_cells_map(row)

        t_raw = read_cell_text(cells[col_timestamp], shared_strings) if col_timestamp in cells else ""
        s_raw = read_cell_text(cells[col_sensor], shared_strings) if col_sensor in cells else ""
        sensor_norm = norm_name(s_raw)

        ax = parse_num(read_cell_text(cells[col_ax], shared_strings) if col_ax in cells else "")
        ay = parse_num(read_cell_text(cells[col_ay], shared_strings) if col_ay in cells else "")
        az = parse_num(read_cell_text(cells[col_az], shared_strings) if col_az in cells else "")

        is_sock = ("calzino" in sensor_norm) or ("sock" in sensor_norm)
        is_left = ("sx" in sensor_norm) or ("left" in sensor_norm) or ("sinistro" in sensor_norm)
        is_right = ("dx" in sensor_norm) or ("right" in sensor_norm) or ("destro" in sensor_norm)

        records.append(
            Record(
                row_elem=row,
                row_num=row_num,
                order_idx=order_idx,
                t_ms=parse_timestamp_to_ms(t_raw),
                sensor_norm=sensor_norm,
                is_sock=is_sock,
                is_left=is_left,
                is_right=is_right,
                is_knee_sup=is_knee_sup(sensor_norm),
                is_knee_inf=is_knee_inf(sensor_norm),
                ax=ax,
                ay=ay,
                az=az,
            )
        )
        order_idx += 1

    recs_time = [r for r in records if r.t_ms is not None and math.isfinite(r.t_ms)]
    recs_time.sort(key=lambda r: (r.t_ms, r.order_idx))

    first_left = next((r.t_ms for r in recs_time if r.is_sock and r.is_left), None)
    first_right = next((r.t_ms for r in recs_time if r.is_sock and r.is_right), None)

    if first_left is not None and first_right is not None:
        session_start = max(first_left, first_right)
    else:
        session_start = recs_time[0].t_ms if recs_time else None

    if session_start is None:
        raise RuntimeError("No valid timestamps found in data rows.")

    bi_samples: Dict[str, List[Tuple[float, float]]] = {"left": [], "right": []}
    tibia_raw_samples: Dict[str, List[Tuple[float, float]]] = {"left": [], "right": []}
    tibia_calib_vals: Dict[str, List[float]] = {"left": [], "right": []}
    tibia_offset: Dict[str, Optional[float]] = {"left": None, "right": None}

    knee_last_sup: Optional[Tuple[float, float, float]] = None
    knee_last_inf: Optional[Tuple[float, float, float]] = None
    knee_calib_vals: List[float] = []
    knee_offset: Optional[float] = None
    knee_display_samples: List[Tuple[float, float]] = []

    for r in records:
        set_cell_number(r.row_elem, r.row_num, "T", None)
        set_cell_number(r.row_elem, r.row_num, "U", None)
        set_cell_number(r.row_elem, r.row_num, "V", None)
        set_cell_number(r.row_elem, r.row_num, "W", None)
        set_cell_number(r.row_elem, r.row_num, "X", None)

    for rec in recs_time:
        t = float(rec.t_ms)

        if rec.is_knee_sup and rec.ay is not None and rec.az is not None:
            knee_last_sup = (t, rec.ay, rec.az)
        if rec.is_knee_inf and rec.ay is not None and rec.az is not None:
            knee_last_inf = (t, rec.ay, rec.az)

        if (rec.is_knee_sup or rec.is_knee_inf) and knee_last_sup and knee_last_inf:
            t_sup, ay_sup, az_sup = knee_last_sup
            t_inf, ay_inf, az_inf = knee_last_inf
            if abs(t_sup - t_inf) <= KNEE_SYNC_MAX_DT_MS:
                sup_tilt = knee_tilt_deg(ay_sup, az_sup)
                inf_tilt = knee_tilt_deg(ay_inf, az_inf)
                knee_raw = wrap_deg_180(sup_tilt - inf_tilt)

                if knee_offset is None:
                    dt = t - session_start
                    if 0.0 <= dt <= KNEE_CALIB_MS:
                        knee_calib_vals.append(knee_raw)
                    med = median_finite(knee_calib_vals)
                    if (
                        dt >= KNEE_CALIB_MS
                        and len(knee_calib_vals) >= KNEE_MIN_CALIB_SAMPLES
                        and med is not None
                    ):
                        knee_offset = med
                    ref = knee_offset if knee_offset is not None else med
                    knee_deg = abs(wrap_deg_180(knee_raw - ref)) if ref is not None else None
                else:
                    knee_deg = abs(wrap_deg_180(knee_raw - knee_offset))

                if knee_deg is not None and math.isfinite(knee_deg):
                    knee_display_samples.append((t, knee_deg))
                    knee_disp = moving_avg_pairs(knee_display_samples, t, KNEE_AVG_WINDOW_MS)
                    set_cell_number(
                        rec.row_elem,
                        rec.row_num,
                        "X",
                        knee_disp if knee_disp is not None else knee_deg,
                    )

        side: Optional[str] = None
        if rec.is_sock and rec.is_left:
            side = "left"
        elif rec.is_sock and rec.is_right:
            side = "right"

        if side and rec.ax is not None and rec.ay is not None and rec.az is not None:
            bi_raw = calc_bi(rec.ax, rec.ay, rec.az)
            bi_samples[side].append((t, bi_raw))
            bi_disp = moving_avg_pairs(bi_samples[side], t, BI_AVG_WINDOW_MS)

            if side == "left":
                set_cell_number(rec.row_elem, rec.row_num, "T", bi_disp if bi_disp is not None else bi_raw)
            else:
                set_cell_number(rec.row_elem, rec.row_num, "U", bi_disp if bi_disp is not None else bi_raw)

            raw = tibia_raw_deg(rec.ay, rec.az)
            tibia_raw_samples[side].append((t, raw))

            if tibia_offset[side] is None:
                dt = t - session_start
                if 0.0 <= dt <= TIBIA_CALIB_MS:
                    tibia_calib_vals[side].append(raw)
                med = median_finite(tibia_calib_vals[side])
                if (
                    dt >= TIBIA_CALIB_MS
                    and len(tibia_calib_vals[side]) >= TIBIA_MIN_CALIB_SAMPLES
                    and med is not None
                ):
                    tibia_offset[side] = med
                ref = tibia_offset[side] if tibia_offset[side] is not None else med
            else:
                ref = tibia_offset[side]

            tibia_disp: Optional[float] = None
            if ref is not None and math.isfinite(ref):
                t_min = t - TIBIA_AVG_WINDOW_MS
                vals: List[float] = []
                for ts, raws in tibia_raw_samples[side]:
                    if t_min <= ts <= t:
                        zeroed = wrap_deg_180(raws - ref)
                        vals.append(map_tibia_deg(zeroed, side))
                if vals:
                    tibia_disp = sum(vals) / len(vals)
                else:
                    zeroed = wrap_deg_180(raw - ref)
                    tibia_disp = map_tibia_deg(zeroed, side)

            if side == "left":
                set_cell_number(rec.row_elem, rec.row_num, "V", tibia_disp)
            else:
                set_cell_number(rec.row_elem, rec.row_num, "W", tibia_disp)


def write_modified_xlsx(input_path: str, output_path: str) -> None:
    with zipfile.ZipFile(input_path, "r") as zin:
        shared_strings = read_shared_strings(zin)
        sheet_path = resolve_first_sheet_path(zin)
        xml_bytes = zin.read(sheet_path)
        root = ET.fromstring(xml_bytes)

        recompute_columns(root, shared_strings)
        new_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)

        with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == sheet_path:
                    zout.writestr(item, new_xml)
                else:
                    zout.writestr(item, zin.read(item.filename))


# ===== GUI =====
class SensoriaExcelApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Sensoria Excel Processor")
        self.root.geometry("980x620")
        self.root.minsize(900, 560)
        self.root.configure(bg="#0B1220")

        self.input_path = tk.StringVar()
        self.output_path = tk.StringVar()
        self.status_text = tk.StringVar(value="Seleziona un file .xlsx per iniziare.")
        self.keep_same_folder = tk.BooleanVar(value=True)
        self.open_after_finish = tk.BooleanVar(value=True)

        self._build_style()
        self._build_ui()
        self._bind_shortcuts()

    def _build_style(self) -> None:
        style = ttk.Style()
        style.theme_use("clam")
        style.configure(
            "Accent.Horizontal.TProgressbar",
            troughcolor="#1D2A44",
            background="#10B981",
            lightcolor="#10B981",
            darkcolor="#10B981",
            borderwidth=0,
        )

    def _build_ui(self) -> None:
        shell = tk.Frame(self.root, bg="#0B1220")
        shell.pack(fill="both", expand=True, padx=24, pady=20)

        hero = tk.Frame(shell, bg="#0F1A2E")
        hero.pack(fill="x", pady=(0, 14))
        hero.configure(highlightthickness=1, highlightbackground="#24324F", bd=0)

        tk.Label(
            hero,
            text="Sensoria Excel Processor",
            font=("Avenir Next", 24, "bold"),
            fg="#F8FAFC",
            bg="#0F1A2E",
            anchor="w",
        ).pack(fill="x", padx=18, pady=(14, 2))

        tk.Label(
            hero,
            text="File unico: GUI + conversione biomeccanica (BI, tibia sx/dx, ginocchio).",
            font=("Avenir Next", 12),
            fg="#B6C2DA",
            bg="#0F1A2E",
            anchor="w",
        ).pack(fill="x", padx=18, pady=(0, 14))

        main = tk.Frame(shell, bg="#0B1220")
        main.pack(fill="both", expand=True)

        left = tk.Frame(main, bg="#111B31", highlightthickness=1, highlightbackground="#24324F")
        left.pack(side="left", fill="both", expand=True, padx=(0, 10))

        right = tk.Frame(main, bg="#111B31", highlightthickness=1, highlightbackground="#24324F", width=290)
        right.pack(side="left", fill="y")
        right.pack_propagate(False)

        self._build_steps(left)
        self._build_side_panel(right)

    def _build_steps(self, parent: tk.Frame) -> None:
        content = tk.Frame(parent, bg="#111B31")
        content.pack(fill="both", expand=True, padx=16, pady=16)

        self._step_title(content, "1", "Seleziona file input")
        self._path_row(content, self.input_path, self.choose_input)

        self._step_title(content, "2", "Scegli dove salvare")
        self._path_row(content, self.output_path, self.choose_output)

        options = tk.Frame(content, bg="#111B31")
        options.pack(fill="x", pady=(2, 10))

        tk.Checkbutton(
            options,
            text="Salva output nella stessa cartella dell'input (auto)",
            variable=self.keep_same_folder,
            command=self._sync_output_if_needed,
            font=("Avenir Next", 11),
            fg="#DCE6F7",
            bg="#111B31",
            selectcolor="#18263F",
            activebackground="#111B31",
            activeforeground="#DCE6F7",
            highlightthickness=0,
            bd=0,
        ).pack(anchor="w", pady=(0, 6))

        tk.Checkbutton(
            options,
            text="Apri il file nel Finder al termine",
            variable=self.open_after_finish,
            font=("Avenir Next", 11),
            fg="#DCE6F7",
            bg="#111B31",
            selectcolor="#18263F",
            activebackground="#111B31",
            activeforeground="#DCE6F7",
            highlightthickness=0,
            bd=0,
        ).pack(anchor="w")

        self._step_title(content, "3", "Converti")
        actions = tk.Frame(content, bg="#111B31")
        actions.pack(fill="x", pady=(2, 8))

        self.convert_btn = tk.Button(
            actions,
            text="Converti adesso",
            command=self.run_job,
            font=("Avenir Next", 12, "bold"),
            fg="#052E1E",
            bg="#34D399",
            activebackground="#10B981",
            activeforeground="#052E1E",
            relief="flat",
            padx=16,
            pady=10,
            cursor="hand2",
        )
        self.convert_btn.pack(side="left")

        self.open_btn = tk.Button(
            actions,
            text="Apri Output",
            command=self.reveal_output,
            font=("Avenir Next", 12, "bold"),
            fg="#E5EDFF",
            bg="#1D2A44",
            activebackground="#223356",
            activeforeground="#E5EDFF",
            relief="flat",
            padx=16,
            pady=10,
            cursor="hand2",
        )
        self.open_btn.pack(side="left", padx=(10, 0))

        self.progress = ttk.Progressbar(
            content,
            mode="indeterminate",
            style="Accent.Horizontal.TProgressbar",
        )
        self.progress.pack(fill="x", pady=(8, 10))

        self.status_badge = tk.Label(
            content,
            textvariable=self.status_text,
            font=("Avenir Next", 10, "bold"),
            fg="#D7E4FF",
            bg="#172641",
            anchor="w",
            padx=10,
            pady=8,
        )
        self.status_badge.pack(fill="x")

    def _build_side_panel(self, parent: tk.Frame) -> None:
        top = tk.Frame(parent, bg="#111B31")
        top.pack(fill="x", padx=14, pady=(14, 10))

        tk.Label(
            top,
            text="Attivita",
            font=("Avenir Next", 13, "bold"),
            fg="#F8FAFC",
            bg="#111B31",
            anchor="w",
        ).pack(fill="x")

        tk.Label(
            top,
            text="Log conversione in tempo reale",
            font=("Avenir Next", 10),
            fg="#9DB0D1",
            bg="#111B31",
            anchor="w",
        ).pack(fill="x", pady=(2, 8))

        log_wrap = tk.Frame(parent, bg="#0E172A", highlightthickness=1, highlightbackground="#24324F")
        log_wrap.pack(fill="both", expand=True, padx=14, pady=(0, 10))

        self.log_text = tk.Text(
            log_wrap,
            bg="#0E172A",
            fg="#D7E4FF",
            insertbackground="#D7E4FF",
            relief="flat",
            font=("SF Mono", 10),
            padx=8,
            pady=8,
            wrap="word",
            state="disabled",
        )
        self.log_text.pack(fill="both", expand=True)

        footer = tk.Frame(parent, bg="#111B31")
        footer.pack(fill="x", padx=14, pady=(0, 14))

        tk.Button(
            footer,
            text="Pulisci Log",
            command=self.clear_log,
            font=("Avenir Next", 10, "bold"),
            fg="#D7E4FF",
            bg="#1D2A44",
            activebackground="#223356",
            activeforeground="#D7E4FF",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
        ).pack(side="left")

        tk.Button(
            footer,
            text="Apri Cartella",
            command=self.open_output_folder,
            font=("Avenir Next", 10, "bold"),
            fg="#052E1E",
            bg="#34D399",
            activebackground="#10B981",
            activeforeground="#052E1E",
            relief="flat",
            padx=12,
            pady=8,
            cursor="hand2",
        ).pack(side="right")

        self.log("Applicazione pronta.")
        self.log("Tip: Cmd/Ctrl+O input, Cmd/Ctrl+S output, Cmd/Ctrl+Enter converti.")

    @staticmethod
    def _step_title(parent: tk.Widget, n: str, label: str) -> None:
        row = tk.Frame(parent, bg="#111B31")
        row.pack(fill="x", pady=(0, 6))

        badge = tk.Label(
            row,
            text=n,
            font=("Avenir Next", 10, "bold"),
            fg="#0E172A",
            bg="#67E8F9",
            width=2,
            padx=2,
            pady=2,
        )
        badge.pack(side="left")

        tk.Label(
            row,
            text=label,
            font=("Avenir Next", 12, "bold"),
            fg="#F8FAFC",
            bg="#111B31",
            anchor="w",
        ).pack(side="left", padx=(8, 0))

    def _path_row(self, parent: tk.Widget, var: tk.StringVar, choose_cb) -> None:
        row = tk.Frame(parent, bg="#111B31")
        row.pack(fill="x", pady=(0, 12))

        entry = tk.Entry(
            row,
            textvariable=var,
            font=("SF Mono", 10),
            bg="#0E172A",
            fg="#EAF2FF",
            insertbackground="#EAF2FF",
            relief="flat",
            highlightthickness=1,
            highlightbackground="#24324F",
            highlightcolor="#38BDF8",
        )
        entry.pack(side="left", fill="x", expand=True, ipady=10)

        tk.Button(
            row,
            text="Sfoglia...",
            command=choose_cb,
            font=("Avenir Next", 10, "bold"),
            fg="#052E1E",
            bg="#67E8F9",
            activebackground="#22D3EE",
            activeforeground="#052E1E",
            relief="flat",
            padx=12,
            pady=10,
            cursor="hand2",
        ).pack(side="left", padx=(10, 0))

    def _bind_shortcuts(self) -> None:
        self.root.bind("<Command-o>", lambda e: self.choose_input())
        self.root.bind("<Control-o>", lambda e: self.choose_input())
        self.root.bind("<Command-s>", lambda e: self.choose_output())
        self.root.bind("<Control-s>", lambda e: self.choose_output())
        self.root.bind("<Command-Return>", lambda e: self.run_job())
        self.root.bind("<Control-Return>", lambda e: self.run_job())

    def log(self, text: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        line = f"[{ts}] {text}\n"
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def clear_log(self) -> None:
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def _sync_output_if_needed(self) -> None:
        if self.keep_same_folder.get():
            self._apply_auto_output_name()

    def _apply_auto_output_name(self) -> None:
        in_path = self.input_path.get().strip()
        if not in_path:
            return
        folder = os.path.dirname(in_path)
        base = os.path.splitext(os.path.basename(in_path))[0]
        self.output_path.set(os.path.join(folder, f"{base}_modified.xlsx"))

    def choose_input(self) -> None:
        selected = filedialog.askopenfilename(
            title="Seleziona il file Excel da modificare",
            filetypes=[("Excel Workbook", "*.xlsx"), ("All files", "*.*")],
        )
        if not selected:
            return

        self.input_path.set(selected)
        self.log(f"Input selezionato: {selected}")

        if self.keep_same_folder.get() or not self.output_path.get().strip():
            self._apply_auto_output_name()

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
        if self.keep_same_folder.get():
            # Manual output choice should win over auto path mode.
            self.keep_same_folder.set(False)
            self.log("Modalita auto disattivata (output scelto manualmente).")
        self.log(f"Output selezionato: {selected}")

    def set_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        self.convert_btn.configure(state=state)
        self.open_btn.configure(state=state)
        if busy:
            self.progress.start(8)
        else:
            self.progress.stop()

    def _validate_inputs(self, in_path: str, out_path: str) -> Optional[str]:
        if not in_path:
            return "Seleziona un file input .xlsx."
        if not os.path.isfile(in_path):
            return f"File input non trovato:\n{in_path}"
        if not in_path.lower().endswith(".xlsx"):
            return "Il file input deve avere estensione .xlsx"
        if not out_path:
            return "Seleziona dove salvare il file output."
        if not out_path.lower().endswith(".xlsx"):
            return "Il file output deve avere estensione .xlsx"
        return None

    def run_job(self) -> None:
        in_path = self.input_path.get().strip()
        out_path = self.output_path.get().strip()

        # Auto-generate output only when output is empty.
        if self.keep_same_folder.get() and in_path and not out_path:
            self._apply_auto_output_name()
            out_path = self.output_path.get().strip()

        error = self._validate_inputs(in_path, out_path)
        if error:
            messagebox.showerror("Controlla i dati", error)
            self.status_text.set("Input/output non validi.")
            self.log(f"Errore validazione: {error.replace(chr(10), ' | ')}")
            return

        out_dir = os.path.dirname(out_path) or "."
        os.makedirs(out_dir, exist_ok=True)

        if os.path.exists(out_path):
            overwrite = messagebox.askyesno(
                "File esistente",
                f"Il file esiste gia:\n{out_path}\n\nVuoi sovrascriverlo?",
            )
            if not overwrite:
                self.log("Operazione annullata: output gia esistente.")
                return

        self.set_busy(True)
        self.status_text.set("Elaborazione in corso...")
        self.log("Conversione avviata.")

        worker = threading.Thread(target=self._run_worker, args=(in_path, out_path), daemon=True)
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
        self.status_text.set("Completato con successo.")
        self.log(f"Conversione completata: {out_path}")

        messagebox.showinfo(
            "Fatto",
            "Conversione completata con successo.\n\n"
            f"Output:\n{out_path}",
        )

        if self.open_after_finish.get():
            self._reveal_path(out_path)

    def _on_failed(self, error_text: str) -> None:
        self.set_busy(False)
        self.status_text.set("Errore durante la conversione.")
        self.log(f"Errore: {error_text}")
        messagebox.showerror(
            "Errore",
            "Non e stato possibile completare la conversione.\n\n"
            f"Dettaglio:\n{error_text}",
        )

    def reveal_output(self) -> None:
        out_path = self.output_path.get().strip()
        if not out_path:
            messagebox.showinfo("Output mancante", "Imposta prima un file output.")
            return

        if os.path.exists(out_path):
            self._reveal_path(out_path)
            return

        out_dir = os.path.dirname(out_path)
        if out_dir and os.path.isdir(out_dir):
            self._open_folder(out_dir)
            return

        messagebox.showinfo("Output non trovato", "Il file o la cartella output non esistono ancora.")

    def open_output_folder(self) -> None:
        out_path = self.output_path.get().strip()
        if out_path:
            out_dir = os.path.dirname(out_path)
            if out_dir and os.path.isdir(out_dir):
                self._open_folder(out_dir)
                return

        in_path = self.input_path.get().strip()
        if in_path and os.path.isdir(os.path.dirname(in_path)):
            self._open_folder(os.path.dirname(in_path))
            return

        self._open_folder(os.getcwd())

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
