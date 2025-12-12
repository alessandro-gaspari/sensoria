import sys
sys.stdout.reconfigure(line_buffering=True)

import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS

import json
import time
import os
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

# --------------------------------------------------------------------
# IN-MEMORY DATABASE
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

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({
        'sensors': sensors_data,
        'profile': last_profile_data,
        'gps': last_gps_data,
        'bpm': last_bpm_data
    })

# --------------------------------------------------------------------
# SSH HELPERS
# --------------------------------------------------------------------

def create_ssh_client():
    print("🔄 [SSH] Connessione...", flush=True)
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


def get_latest_remote_file(sftp):
    """Restituisce il file log più recente basato sul nome (YYYY-MM-DD...)."""
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        log_files = [f for f in files if f.filename.endswith('_session_log.txt')]
        if not log_files:
            return None

        # Ordine discendente: il nome contiene la data
        log_files.sort(key=lambda f: f.filename, reverse=True)
        return os.path.join(REMOTE_LOG_DIR, log_files[0].filename)

    except Exception:
        return None

# --------------------------------------------------------------------
# BACKGROUND WATCHER
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
            # ------------------------------------------------------------
            # 1. Se SSH è morto → ricollegarsi
            # ------------------------------------------------------------
            if not ssh or not ssh.get_transport() or not ssh.get_transport().is_active():
                ssh = create_ssh_client()
                if not ssh:
                    socketio.sleep(5)
                    continue
                sftp = ssh.open_sftp()

            # ------------------------------------------------------------
            # 2. Scopri il file più recente
            # ------------------------------------------------------------
            latest_path = get_latest_remote_file(sftp)

            # ---- NUOVA SESSIONE (cambio file) ----
            if latest_path and latest_path != current_file_path:
                print(f"📂 [FILE] Nuova sessione rilevata: {latest_path}", flush=True)

                # Chiudi il file precedente
                if remote_file:
                    try:
                        remote_file.close()
                    except:
                        pass

                current_file_path = latest_path

                # Reset dati
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

            # ------------------------------------------------------------
            # 3. Lettura incrementale del file corrente
            # ------------------------------------------------------------
            if remote_file:
                try:
                    stat = sftp.stat(current_file_path)

                    if stat.st_size > last_file_size:
                        # Nuovi byte disponibili
                        new_bytes = stat.st_size - last_file_size
                        new_data = remote_file.read(new_bytes)
                        last_file_size = stat.st_size

                        # Splitta in righe JSON
                        lines = new_data.decode("utf-8", errors="ignore").split("\n")

                        for line in lines:
                            if not line.strip():
                                continue

                            try:
                                # === FIX 1: PULIZIA DEL LOG ===
                                # Il log inizia con "*** ... chunk=", quindi dobbiamo
                                # trovare dove inizia la prima parentesi graffa '{' e dove finisce '}'
                                json_str = line
                                start_idx = json_str.find("{")
                                end_idx = json_str.rfind("}")

                                # Se non troviamo le graffe, la riga non è JSON valido, saltiamo
                                if start_idx == -1 or end_idx == -1:
                                    continue
                                
                                # Estraiamo solo il JSON pulito
                                json_str = json_str[start_idx : end_idx + 1]
                                data = json.loads(json_str)

                            except Exception as e:
                                # Se fallisce ancora, è proprio una riga corrotta
                                continue 

                            # ------------------------------------------------
                            # FIX 2: LETTURA BPM (Chiave "bpm" vs "heart_rate")
                            # ------------------------------------------------
                            if "bpm" in data:
                                last_bpm_data = data["bpm"]
                                socketio.emit("bpm_update", last_bpm_data) # Modo A: numero secco
                                # socketio.emit("bpm_update", {"bpm": last_bpm_data}) # Modo B: se il JS vuole oggetto (ma il tuo JS gestisce entrambi)
                            
                            elif "heart_rate" in data:
                                last_bpm_data = data["heart_rate"]
                                socketio.emit("bpm_update", last_bpm_data)

                            # ------------------------------------------------
                            # SENSORI REALI (accel/press)
                            # ------------------------------------------------
                            elif "accel_x" in data or "pressure_0" in data:
                                s_name = data.get("sensor_name", "Unknown")
                                sensors_data[s_name] = data

                                socketio.emit("sensor_update", {
                                    "sensor_name": s_name,
                                    "data": data
                                })

                            # ------------------------------------------------
                            # GPS
                            # ------------------------------------------------
                            elif "latitude" in data and "longitude" in data:
                                last_gps_data = data
                                socketio.emit("gps_update", data)

                            # ------------------------------------------------
                            # PROFILO (name, weight, age)
                            # ------------------------------------------------
                            elif "name" in data and "weight" in data:
                                last_profile_data = data
                                socketio.emit("profile_update", data)

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