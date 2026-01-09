import sys
sys.stdout.reconfigure(line_buffering=True)
import eventlet
eventlet.monkey_patch()
from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO
from flask_cors import CORS
import json
import time
import os
import re
from datetime import datetime, timezone
from flask import Flask, render_template, jsonify, request, Response, stream_with_context
import paramiko

# --------------------------------------------------------------------
# FLASK SETUP
# --------------------------------------------------------------------
app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret!'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --------------------------------------------------------------------
# SSH CONFIG
# --------------------------------------------------------------------
SSH_HOST = "lambda-iot.uniud.it"
SSH_USER = "gaspari"
SSH_PORT = 22729
SSH_PASS = os.environ.get("SSH_PASSWORD")
REMOTE_LOG_DIR = "/home/gaspari/data/"
LOG_SUFFIX = "_session_log.txt"

# --------------------------------------------------------------------
# IN-MEMORY DATABASE (LIVE)
# --------------------------------------------------------------------
sensors_data = {}       # Sensori (accelerometro / pressione)
last_profile_data = {}  # Profilo atleta
last_gps_data = {}      # GPS
last_bpm_data = 0       # Battito cardiaco


# --------------------------------------------------------------------
# ROUTES
# --------------------------------------------------------------------
@app.route('/')
def index():
    return render_template('dashboard.html')

@app.get("/api/logs/raw")
def api_logs_raw():
    try:
        name = request.args.get("name", "").strip()
        if not _safe_filename(name) or not name.endswith(LOG_SUFFIX):
            return jsonify(error="bad_name"), 400

        ssh = create_ssh_client()
        if not ssh:
            return jsonify(error="ssh_connect_failed"), 500

        sftp = None
        f = None
        try:
            sftp = ssh.open_sftp()
            remote_path = os.path.join(REMOTE_LOG_DIR, name)

            st = sftp.stat(remote_path)
            total = int(getattr(st, "st_size", 0) or 0)

            f = sftp.open(remote_path, "rb")

            def gen():
                try:
                    while True:
                        chunk = f.read(64 * 1024)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    try:
                        if f: f.close()
                    except:
                        pass
                    try:
                        if sftp: sftp.close()
                    except:
                        pass
                    try:
                        if ssh: ssh.close()
                    except:
                        pass

            resp = Response(stream_with_context(gen()), mimetype="text/plain; charset=utf-8")
            resp.headers["X-Total-Bytes"] = str(total)
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["X-Accel-Buffering"] = "no"
            return resp

        except FileNotFoundError:
            try:
                if f: f.close()
            except:
                pass
            try:
                if sftp: sftp.close()
            except:
                pass
            try:
                ssh.close()
            except:
                pass
            return jsonify(error="not_found"), 404

    except Exception as e:
        print("api_logs_raw error:", repr(e), flush=True)
        return jsonify(error=str(e)), 500


@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({
        'sensors': sensors_data,
        'profile': last_profile_data,
        'gps': last_gps_data,
        'bpm': last_bpm_data
    })


# --------------------------------------------------------------------
# NEW: LOG BROWSER API
# --------------------------------------------------------------------
def _safe_filename(name: str) -> bool:
    if not name:
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    # consenti solo caratteri "safe"
    return re.fullmatch(r"[A-Za-z0-9._-]+", name) is not None


def _parse_time_ms(obj: dict):
    """
    Tenta di estrarre un timestamp in ms.
    Supporta:
    - t (ms o sec)
    - timestamp (ISO string o epoch)
    - time (sec o ms)
    """
    if not isinstance(obj, dict):
        return None

    for key in ("t", "time", "ts"):
        if key in obj:
            try:
                v = obj[key]
                if isinstance(v, (int, float)):
                    # euristica: se < 1e12 probabilmente è in secondi
                    return int(v * 1000) if v < 1e12 else int(v)
                if isinstance(v, str) and v.strip().isdigit():
                    n = int(v.strip())
                    return int(n * 1000) if n < 1e12 else n
            except:
                pass

    if "timestamp" in obj:
        v = obj["timestamp"]
        try:
            if isinstance(v, (int, float)):
                return int(v * 1000) if v < 1e12 else int(v)
            if isinstance(v, str):
                s = v.strip()
                if s.isdigit():
                    n = int(s)
                    return int(n * 1000) if n < 1e12 else n
                # ISO: gestisce anche ...Z
                s2 = s.replace("Z", "+00:00")
                dt = datetime.fromisoformat(s2)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return int(dt.timestamp() * 1000)
        except:
            return None

    return None


def _extract_json_from_line(line: str):
    """Prende solo la parte tra la prima '{' e l'ultima '}'."""
    if not line:
        return None
    idx_start = line.find("{")
    idx_end = line.rfind("}")
    if idx_start == -1 or idx_end == -1 or idx_end <= idx_start:
        return None
    try:
        return json.loads(line[idx_start: idx_end + 1])
    except:
        return None

def _normalize_sensor_fields(d: dict) -> dict:
    if not isinstance(d, dict):
        return d
    out = dict(d)

    # accel (underscore -> no underscore)
    if "accel_x" in out: out["accelx"] = out.get("accel_x")
    if "accel_y" in out: out["accely"] = out.get("accel_y")
    if "accel_z" in out: out["accelz"] = out.get("accel_z")

    # gyro
    if "gyro_x" in out: out["gyrox"] = out.get("gyro_x")
    if "gyro_y" in out: out["gyroy"] = out.get("gyro_y")
    if "gyro_z" in out: out["gyroz"] = out.get("gyro_z")

    # mag
    if "mag_x" in out: out["magx"] = out.get("mag_x")
    if "mag_y" in out: out["magy"] = out.get("mag_y")
    if "mag_z" in out: out["magz"] = out.get("mag_z")

    return out

def create_ssh_client():
    print("🔄 [SSH] Connessione...", flush=True)
    if not SSH_PASS:
        print("❌ [SSH] SSH_PASSWORD non impostata!", flush=True)
        return None

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        client.connect(
            SSH_HOST,
            port=SSH_PORT,
            username=SSH_USER,
            password=SSH_PASS,
            timeout=10
        )
        print("✅ [SSH] Connesso!", flush=True)
        return client
    except Exception as e:
        print(f"❌ [SSH] Errore connessione: {e}", flush=True)
        return None


def list_remote_logs(sftp):
    """
    Ritorna lista di dict: {name, size, mtime}
    Filtra solo *_session_log.txt
    """
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        out = []
        for f in files:
            if not f.filename.endswith(LOG_SUFFIX):
                continue
            out.append({
                "name": f.filename,
                "size": int(getattr(f, "st_size", 0) or 0),
                "mtime": int(getattr(f, "st_mtime", 0) or 0),
            })
        # più recente prima: preferisco mtime, fallback nome
        out.sort(key=lambda x: (x.get("mtime", 0), x.get("name", "")), reverse=True)
        return out
    except Exception as e:
        print(f"❌ [SSH] list_remote_logs error: {e}", flush=True)
        return []


def get_latest_remote_file(sftp):
    """Restituisce il file log più recente (preferendo mtime)."""
    logs = list_remote_logs(sftp)
    if not logs:
        return None
    return os.path.join(REMOTE_LOG_DIR, logs[0]["name"])

@app.post("/api/clear")
def api_clear():
    global lastprofiledata, lastgpsdata, lastbpmdata
    sensors_data.clear()
    lastprofiledata = {}
    lastgpsdata = {}
    lastbpmdata = 0
    socketio.emit("datacleared")
    return jsonify({"ok": True})


@app.get("/api/logs")
def api_logs_list():
    ssh = create_ssh_client()
    if not ssh:
        return jsonify({"logs": [], "error": "ssh_connect_failed"}), 500

    sftp = None
    try:
        sftp = ssh.open_sftp()
        logs = list_remote_logs(sftp)
        return jsonify({"logs": logs})
    except Exception as e:
        return jsonify({"logs": [], "error": str(e)}), 500
    finally:
        try:
            if sftp:
                sftp.close()
        except:
            pass
        try:
            ssh.close()
        except:
            pass


@app.get("/api/logs/load")
def api_logs_load():
    """
    Carica un log e restituisce JSON strutturato per il frontend:
    {
      "name": "...",
      "gps": [ {t, latitude, longitude, accuracy, ...}, ... ],
      "bpm": [ {t, bpm}, ... ],
      "profile": [ ... opzionale ... ],
      "sensors": [ ... opzionale ... ]
    }
    """
    name = request.args.get("name", "").strip()
    if not _safe_filename(name) or not name.endswith(LOG_SUFFIX):
        return jsonify({"error": "bad_name"}), 400

    ssh = create_ssh_client()
    if not ssh:
        return jsonify({"error": "ssh_connect_failed"}), 500

    sftp = None
    try:
        sftp = ssh.open_sftp()
        remote_path = os.path.join(REMOTE_LOG_DIR, name)

        # Leggi tutto il file
        with sftp.open(remote_path, "r") as f:
            raw = f.read()
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="ignore")

        gps = []
        bpm = []
        profile = []
        sensors = []

        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue

            data = _extract_json_from_line(line)
            if not data:
                continue

            tms = _parse_time_ms(data)

            # BPM
            if "bpm" in data:
                try:
                    v = int(data["bpm"])
                    if v > 0:
                        bpm.append({"t": tms, "bpm": v})
                except:
                    pass
                continue

            if "heart_rate" in data:
                try:
                    v = int(data["heart_rate"])
                    if v > 0:
                        bpm.append({"t": tms, "bpm": v})
                except:
                    pass
                continue

            # GPS
            if "latitude" in data and "longitude" in data:
                item = dict(data)
                if tms is not None:
                    item["t"] = tms
                gps.append(item)
                continue

            # Profilo
            if "name" in data and ("age" in data or "weight" in data):
                item = dict(data)
                if tms is not None:
                    item["t"] = tms
                profile.append(item)
                continue

            # Sensori (accel / gyro / mag / pressure)
            if ("accel_x" in data) or ("gyro_x" in data) or ("mag_x" in data) or ("pressure_0" in data):
                item = _normalize_sensor_fields(dict(data))
                if tms is not None:
                    item["t"] = tms
                sensors.append(item)
                continue

        # Normalizza: se manca t (None), li lasciamo così e il frontend può fare fallback su Date.now()
        return jsonify({
            "name": name,
            "gps": gps,
            "bpm": bpm,
            "profile": profile,
            "sensors": sensors
        })

    except FileNotFoundError:
        return jsonify({"error": "not_found"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            if sftp:
                sftp.close()
        except:
            pass
        try:
            ssh.close()
        except:
            pass


# --------------------------------------------------------------------
# BACKGROUND WATCHER (LIVE TAIL)
# --------------------------------------------------------------------
def background_watcher():
    global last_profile_data, last_gps_data, last_bpm_data

    print("🚀 [WATCHER] Avviato", flush=True)

    ssh = None
    sftp = None
    remote_file = None

    current_file_path = None
    last_file_size = 0

    while True:
        try:
            # 1) SSH morto -> riconnessione
            if not ssh or not ssh.get_transport() or not ssh.get_transport().is_active():
                ssh = create_ssh_client()
                if not ssh:
                    socketio.sleep(5)
                    continue
                sftp = ssh.open_sftp()

            # 2) Scopri file più recente
            latest_path = get_latest_remote_file(sftp)

            # Nuova sessione (cambio file)
            if latest_path and latest_path != current_file_path:
                print(f"📂 [FILE] Nuova sessione rilevata: {latest_path}", flush=True)

                if remote_file:
                    try:
                        remote_file.close()
                    except:
                        pass

                current_file_path = latest_path

                # Reset live in-memory
                sensors_data.clear()
                last_profile_data = {}
                last_gps_data = {}
                last_bpm_data = 0
                socketio.emit("data_cleared")

                try:
                    remote_file = sftp.open(current_file_path, "r")
                    stat = sftp.stat(current_file_path)
                    last_file_size = stat.st_size
                    remote_file.seek(last_file_size)
                except Exception as e:
                    print(f"❌ Errore apertura file remoto: {e}", flush=True)
                    current_file_path = None
                    continue

            # 3) Lettura incrementale
            if remote_file:
                try:
                    stat = sftp.stat(current_file_path)

                    if stat.st_size > last_file_size:
                        new_bytes = stat.st_size - last_file_size
                        new_data = remote_file.read(new_bytes)
                        last_file_size = stat.st_size

                        if isinstance(new_data, bytes):
                            lines = new_data.decode("utf-8", errors="ignore").split("\n")
                        else:
                            lines = str(new_data).split("\n")

                        for line in lines:
                            line = line.strip()
                            if not line:
                                continue

                            data = _extract_json_from_line(line)
                            if not data:
                                continue

                            # 1) BPM (priorità)
                            if "bpm" in data:
                                try:
                                    val = int(data["bpm"])
                                    last_bpm_data = val
                                    socketio.emit("bpm_update", val)
                                except:
                                    pass
                                continue

                            if "heart_rate" in data:
                                try:
                                    val = int(data["heart_rate"])
                                    last_bpm_data = val
                                    socketio.emit("bpm_update", val)
                                except:
                                    pass
                                continue

                            # 2) Sensori
                            if ("accel_x" in data) or ("gyro_x" in data) or ("mag_x" in data) or ("pressure_0" in data):
                                s_name = data.get("sensor_name", "Unknown")
                                norm = _normalize_sensor_fields(data)
                                sensors_data[s_name] = norm
                                socketio.emit("sensor_update", {"sensor_name": s_name, "data": norm})
                                continue

                            # 3) GPS
                            if "latitude" in data and "longitude" in data:
                                last_gps_data = data
                                socketio.emit("gps_update", data)
                                continue

                            # 4) Profilo
                            if "name" in data:
                                last_profile_data = data
                                socketio.emit("profile_update", data)
                                continue

                    else:
                        socketio.sleep(0.05)

                except Exception as e:
                    print(f"❌ Errore lettura file → riconnessione: {e}", flush=True)
                    try:
                        ssh.close()
                    except:
                        pass
                    ssh = None

            else:
                socketio.sleep(2)

        except Exception as e:
            print(f"❌ Crash watcher: {e}", flush=True)
            socketio.sleep(5)


# --------------------------------------------------------------------
# MAIN
# --------------------------------------------------------------------
if __name__ == "__main__":
    socketio.start_background_task(background_watcher)
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port)
