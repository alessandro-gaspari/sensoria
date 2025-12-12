import sys
# 1. FIX LOGGING: Forza l'output immediato dei print
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
import stat

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret!'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- CONFIGURAZIONE SSH ---
SSH_HOST = "lambda-iot.uniud.it"
SSH_USER = "gaspari"
SSH_PORT = 22729
SSH_PASS = os.environ.get("SSH_PASSWORD")
REMOTE_LOG_DIR = "/home/gaspari/data/"

sensors_data = {}
last_profile_data = None
last_gps_data = None
last_bpm_data = None  # Cache BPM

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    response = {'sensors': sensors_data}
    if last_profile_data:
        response['profile'] = last_profile_data
    if last_gps_data:
        response['gps'] = last_gps_data
    if last_bpm_data:
        response['bpm'] = last_bpm_data
    return jsonify(response)

# =========================================================
# LOGICA WATCHER
# =========================================================
def create_ssh_client():
    print(f"🔄 [SSH] Connessione a {SSH_HOST}:{SSH_PORT}...", flush=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SSH_HOST, port=SSH_PORT, username=SSH_USER, password=SSH_PASS, timeout=10)
        print("✅ [SSH] Connesso!", flush=True)
        return client
    except Exception as e:
        print(f"❌ [SSH] Errore: {e}", flush=True)
        return None

def get_latest_remote_file(sftp):
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        log_files = [f for f in files if f.filename.endswith('_session_log.txt')]
        if not log_files:
            return None

        # Ordina per nome (data)
        log_files.sort(key=lambda f: f.filename, reverse=True)

        latest = log_files[0]
        return os.path.join(REMOTE_LOG_DIR, latest.filename)

    except Exception as e:
        print(f"⚠️ [SSH] Errore listdir: {e}", flush=True)
        return None


def background_watcher():
    global last_profile_data, last_gps_data, last_bpm_data
    print("🚀 [WATCHER] Thread avviato!", flush=True)

    ssh = None
    sftp = None
    remote_file = None
    current_file_path = None
    last_file_size = 0

    while True:
        try:
            if not ssh or not ssh.get_transport() or not ssh.get_transport().is_active():
                ssh = create_ssh_client()
                if not ssh:
                    socketio.sleep(5)
                    continue
                sftp = ssh.open_sftp()

            latest_path = get_latest_remote_file(sftp)

            if latest_path and latest_path != current_file_path:
                print(f"📂 [WATCHER] Monitoraggio file: {latest_path}", flush=True)

                if remote_file:
                    try:
                        remote_file.close()
                    except:
                        pass

                current_file_path = latest_path

                try:
                    remote_file = sftp.open(current_file_path, 'r')
                    stat_info = sftp.stat(current_file_path)
                    last_file_size = stat_info.st_size
                    remote_file.seek(last_file_size)

                    sensors_data.clear()
                    last_profile_data = None
                    last_gps_data = None
                    last_bpm_data = None
                    socketio.emit('data_cleared')

                except IOError as e:
                    print(f"⚠️ [WATCHER] Errore apertura file: {e}", flush=True)
                    current_file_path = None
                    socketio.sleep(2)
                    continue

            if remote_file and current_file_path:
                try:
                    stat_info = sftp.stat(current_file_path)
                    current_size = stat_info.st_size

                    if current_size > last_file_size:
                        new_data = remote_file.read(current_size - last_file_size)
                        last_file_size = current_size

                        chunk = new_data.decode('utf-8', errors='ignore')
                        lines = chunk.split('\n')

                        for line in lines:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                data = json.loads(line)

                                # A. Sensori
                                if 'sensor_name' in data:
                                    s_name = data.get('sensor_name', 'Unknown')
                                    sensors_data[s_name] = data
                                    socketio.emit(
                                        'sensor_update',
                                        {'sensor_name': s_name, 'data': data}
                                    )

                                    # BPM dentro sensore
                                    if 'heart_rate' in data:
                                        bpm_val = data['heart_rate']
                                        last_bpm_data = bpm_val
                                        socketio.emit('bpm_update', bpm_val)

                                # B. GPS
                                elif 'latitude' in data and 'longitude' in data:
                                    last_gps_data = data
                                    socketio.emit('gps_update', data)

                                # C. Profilo
                                elif 'name' in data and 'weight' in data:
                                    last_profile_data = data
                                    socketio.emit('profile_update', data)
                                    print(f"👤 [PROFILE] Rilevato utente: {data['name']}", flush=True)

                                # D. Pacchetto BPM standalone
                                elif 'bpm' in data:
                                    last_bpm_data = data['bpm']
                                    socketio.emit('bpm_update', data['bpm'])

                            except:
                                pass

                    else:
                        socketio.sleep(0.01)

                except Exception as e:
                    print(f"⚠️ [WATCHER] Errore durante lettura loop: {e}", flush=True)
                    try:
                        ssh.close()
                    except:
                        pass
                    ssh = None

            else:
                socketio.sleep(2)

        except Exception as e:
            print(f"❌ [WATCHER] Crash loop critico: {e}", flush=True)
            ssh = None
            socketio.sleep(5)


if __name__ == '__main__':
    socketio.start_background_task(background_watcher)
    port = int(os.environ.get('PORT', 5000))
    print(f"🌍 Server in ascolto su porta {port}...", flush=True)
    socketio.run(app, host='0.0.0.0', port=port)