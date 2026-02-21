#!/usr/bin/env python3
"""
Recompute biomechanical columns in Luca_session_log.xlsx.

It overwrites only these columns in the data table:
- bongiorno index sx (T)
- bongiorno index dx (U)
- angolo tibia sx (V)
- angolo tibia dx (W)
- angolo ginocchio (X)

Logic is aligned with static/dashboard.js:
- Tibia/Ginocchio calibration offset: median of first 5 seconds
- Tibia displayed angle: moving average over 10 ms
- Knee displayed angle: moving average over 10 ms
- BI displayed value: moving average over 100 ms
"""

from __future__ import annotations

import argparse
import math
import os
import re
import statistics
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = f"{{{NS_MAIN}}}"

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
    sensor_name: str
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


def idx_to_col(idx: int) -> str:
    out = []
    x = idx
    while x > 0:
        x, r = divmod(x - 1, 26)
        out.append(chr(65 + r))
    return "".join(reversed(out))


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

    # Excel serial date: days since epoch in spreadsheet context
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
    # left side sign flip (mounted as mirror)
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


def read_cell_text(cell: ET.Element) -> str:
    t_attr = cell.attrib.get("t")
    if t_attr == "inlineStr":
        isel = cell.find(f"{NS}is")
        if isel is None:
            return ""
        return "".join((tn.text or "") for tn in isel.iter(f"{NS}t"))
    v = cell.find(f"{NS}v")
    return v.text if v is not None and v.text is not None else ""


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
        cref = c.attrib.get("r", "")
        if cref == target_ref:
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


def find_header_row_and_columns(sheet_root: ET.Element) -> Tuple[ET.Element, int, Dict[str, str]]:
    sheet_data = sheet_root.find(f"{NS}sheetData")
    if sheet_data is None:
        raise RuntimeError("sheetData not found in worksheet.")

    for row in sheet_data.findall(f"{NS}row"):
        cells = get_row_cells_map(row)
        text_by_col = {col: read_cell_text(cell).strip() for col, cell in cells.items()}
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


def recompute_columns(sheet_root: ET.Element) -> None:
    header_row, header_row_num, headers = find_header_row_and_columns(sheet_root)
    sheet_data = sheet_root.find(f"{NS}sheetData")
    if sheet_data is None:
        raise RuntimeError("sheetData not found.")

    # Ensure target headers are present at exact columns T..X.
    for name, col in HEADER_TARGETS.items():
        set_cell_inline_text(header_row, header_row_num, col, name)

    col_timestamp = headers["timestamp"]
    col_sensor = headers["sensor_name"]
    col_ax = headers.get("accel_x")
    col_ay = headers.get("accel_y")
    col_az = headers.get("accel_z")

    if not (col_ax and col_ay and col_az):
        raise RuntimeError("Missing accel_x/accel_y/accel_z columns in header.")

    # Collect records
    records: List[Record] = []
    order_idx = 0
    for row in sheet_data.findall(f"{NS}row"):
        row_num = int(row.attrib.get("r", "0"))
        if row_num <= header_row_num:
            continue
        cells = get_row_cells_map(row)

        t_raw = read_cell_text(cells[col_timestamp]) if col_timestamp in cells else ""
        s_raw = read_cell_text(cells[col_sensor]) if col_sensor in cells else ""
        sensor_norm = norm_name(s_raw)

        ax = parse_num(read_cell_text(cells[col_ax]) if col_ax in cells else "")
        ay = parse_num(read_cell_text(cells[col_ay]) if col_ay in cells else "")
        az = parse_num(read_cell_text(cells[col_az]) if col_az in cells else "")

        is_sock = ("calzino" in sensor_norm) or ("sock" in sensor_norm)
        is_left = ("sx" in sensor_norm) or ("left" in sensor_norm) or ("sinistro" in sensor_norm)
        is_right = ("dx" in sensor_norm) or ("right" in sensor_norm) or ("destro" in sensor_norm)

        rec = Record(
            row_elem=row,
            row_num=row_num,
            order_idx=order_idx,
            t_ms=parse_timestamp_to_ms(t_raw),
            sensor_name=s_raw.strip(),
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
        records.append(rec)
        order_idx += 1

    # Session start from first left/right sock samples (timestamp-ordered)
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

    # State containers
    bi_samples: Dict[str, List[Tuple[float, float]]] = {"left": [], "right": []}
    tibia_raw_samples: Dict[str, List[Tuple[float, float]]] = {"left": [], "right": []}
    tibia_calib_vals: Dict[str, List[float]] = {"left": [], "right": []}
    tibia_offset: Dict[str, Optional[float]] = {"left": None, "right": None}

    knee_last_sup: Optional[Tuple[float, float, float]] = None  # (t, ay, az)
    knee_last_inf: Optional[Tuple[float, float, float]] = None  # (t, ay, az)
    knee_calib_vals: List[float] = []
    knee_offset: Optional[float] = None
    knee_display_samples: List[Tuple[float, float]] = []

    # Clear target columns on all data rows first
    for r in records:
        set_cell_number(r.row_elem, r.row_num, "T", None)
        set_cell_number(r.row_elem, r.row_num, "U", None)
        set_cell_number(r.row_elem, r.row_num, "V", None)
        set_cell_number(r.row_elem, r.row_num, "W", None)
        set_cell_number(r.row_elem, r.row_num, "X", None)

    # Process in time order
    for rec in recs_time:
        t = float(rec.t_ms)

        # KNEE update (live-like logic)
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
                    set_cell_number(rec.row_elem, rec.row_num, "X", knee_disp if knee_disp is not None else knee_deg)

        # SOCK update (BI + TIBIA)
        side: Optional[str] = None
        if rec.is_sock and rec.is_left:
            side = "left"
        elif rec.is_sock and rec.is_right:
            side = "right"

        if side and rec.ax is not None and rec.ay is not None and rec.az is not None:
            # BI
            bi_raw = calc_bi(rec.ax, rec.ay, rec.az)
            bi_samples[side].append((t, bi_raw))
            bi_disp = moving_avg_pairs(bi_samples[side], t, BI_AVG_WINDOW_MS)
            if side == "left":
                set_cell_number(rec.row_elem, rec.row_num, "T", bi_disp if bi_disp is not None else bi_raw)
            else:
                set_cell_number(rec.row_elem, rec.row_num, "U", bi_disp if bi_disp is not None else bi_raw)

            # TIBIA
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
        xml_bytes = zin.read("xl/worksheets/sheet1.xml")
        root = ET.fromstring(xml_bytes)

        recompute_columns(root)

        new_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)

        with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename == "xl/worksheets/sheet1.xml":
                    zout.writestr(item, new_xml)
                else:
                    zout.writestr(item, zin.read(item.filename))


def ask_input_path_cli() -> str:
    while True:
        raw = input("Percorso file Excel da modificare (.xlsx): ").strip()
        path = os.path.abspath(os.path.expanduser(raw))
        if not raw:
            print("Inserisci un percorso valido.")
            continue
        if not os.path.isfile(path):
            print(f"File non trovato: {path}")
            continue
        if not path.lower().endswith(".xlsx"):
            print("Il file deve avere estensione .xlsx")
            continue
        return path


def ask_input_path() -> str:
    # Prova dialogo grafico nativo (Finder su macOS / File dialog su Windows)
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.askopenfilename(
            title="Seleziona file Excel da modificare",
            filetypes=[("Excel Workbook", "*.xlsx"), ("All files", "*.*")],
        )
        root.destroy()

        if selected:
            path = os.path.abspath(os.path.expanduser(selected))
            if path.lower().endswith(".xlsx"):
                return path
            print("Il file selezionato non è un .xlsx. Passo alla modalità testuale.")
        else:
            print("Nessun file selezionato nella finestra grafica. Passo alla modalità testuale.")
    except Exception as exc:
        print(f"Dialogo grafico input non disponibile ({exc}). Passo alla modalità testuale.")

    return ask_input_path_cli()


def ask_output_path_cli(input_path: str) -> str:
    input_abs = os.path.abspath(os.path.expanduser(input_path))
    default_dir = os.path.dirname(input_abs) or os.getcwd()
    base_name = os.path.splitext(os.path.basename(input_abs))[0]
    default_name = f"{base_name}_modified.xlsx"

    while True:
        out_dir_raw = input(f"Cartella di salvataggio [{default_dir}]: ").strip()
        out_dir = os.path.abspath(os.path.expanduser(out_dir_raw or default_dir))
        if os.path.isdir(out_dir):
            break
        mk = input(f"La cartella '{out_dir}' non esiste. Crearla? [y/N]: ").strip().lower()
        if mk in {"y", "yes", "s", "si"}:
            os.makedirs(out_dir, exist_ok=True)
            break

    while True:
        out_name_raw = input(f"Nome file output [{default_name}]: ").strip()
        out_name = out_name_raw or default_name
        if not out_name.lower().endswith(".xlsx"):
            out_name += ".xlsx"
        if "/" in out_name or "\\" in out_name:
            print("Nome file non valido: non usare '/' o '\\'.")
            continue

        out_path = os.path.join(out_dir, out_name)
        if os.path.exists(out_path):
            ow = input(f"Il file '{out_path}' esiste già. Sovrascriverlo? [y/N]: ").strip().lower()
            if ow not in {"y", "yes", "s", "si"}:
                continue
        return out_path


def ask_output_path(input_path: str) -> str:
    input_abs = os.path.abspath(os.path.expanduser(input_path))
    default_dir = os.path.dirname(input_abs) or os.getcwd()
    base_name = os.path.splitext(os.path.basename(input_abs))[0]
    default_name = f"{base_name}_modified.xlsx"

    # Prova dialogo grafico nativo (Finder su macOS / File dialog su Windows)
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        selected = filedialog.asksaveasfilename(
            title="Salva file Excel modificato",
            initialdir=default_dir,
            initialfile=default_name,
            defaultextension=".xlsx",
            filetypes=[("Excel Workbook", "*.xlsx"), ("All files", "*.*")],
        )
        root.destroy()

        if selected:
            out_path = os.path.abspath(os.path.expanduser(selected))
            if not out_path.lower().endswith(".xlsx"):
                out_path += ".xlsx"
            return out_path

        print("Nessun file selezionato nella finestra grafica. Passo alla modalità testuale.")
    except Exception as exc:
        print(f"Dialogo grafico non disponibile ({exc}). Passo alla modalità testuale.")

    return ask_output_path_cli(input_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Recompute BI/Tibia/Knee columns in XLSX.")
    parser.add_argument(
        "--input",
        default=None,
        help="Input XLSX path (if omitted, asks interactively)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output XLSX path (if omitted, asks interactively)",
    )
    args = parser.parse_args()

    input_path = args.input if args.input else ask_input_path()
    output_path = args.output if args.output else ask_output_path(input_path)
    write_modified_xlsx(input_path, output_path)
    print(f"OK: written {output_path}")


if __name__ == "__main__":
    main()
