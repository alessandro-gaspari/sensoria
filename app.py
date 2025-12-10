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
SSH_PASS = os.environ.get("SSH_PASSWORD") 
REMOTE_LOG_DIR = "/home/gaspari/data/"

sensors_data = {}

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({'sensors': sensors_data})

# =========================================================
# LOGICA WATCHER (Stessa logica, gestione thread diversa)
# =========================================================
def create_ssh_client():
    print(f"🔄 [SSH] Connessione a {SSH_HOST}...", flush=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SSH_HOST, username=SSH_USER, password=SSH_PASS, timeout=10)
        print("✅ [SSH] Connesso!", flush=True)
        return client
    except Exception as e:
        print(f"❌ [SSH] Errore: {e}", flush=True)
        return None

def get_latest_remote_file(sftp):
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        log_files = [f for f in files if f.filename.endswith('_session_log.txt')]
        if not log_files: return None
        latest = max(log_files, key=lambda f: f.st_mtime)
        return os.path.join(REMOTE_LOG_DIR, latest.filename)
    except Exception as e:
        print(f"⚠️ [SSH] Errore listdir: {e}", flush=True)
        return None

def background_watcher():
    """Task in background gestito da SocketIO"""
    print("🚀 [WATCHER] Thread avviato!", flush=True)
    
    ssh = None
    sftp = None
    remote_file = None
    current_file_path = None
    last_file_size = 0
    
    while True:
        try:
            # 1. Connessione
            if not ssh or not ssh.get_transport() or not ssh.get_transport().is_active():
                ssh = create_ssh_client()
                if not ssh:
                    socketio.sleep(5)
                    continue
                sftp = ssh.open_sftp()
            
            # 2. Cerca File
            latest_path = get_latest_remote_file(sftp)
            
            if latest_path and latest_path != current_file_path:
                print(f"📂 [WATCHER] Nuovo file: {latest_path}", flush=True)
                if remote_file: remote_file.close()
                current_file_path = latest_path
                remote_file = sftp.open(current_file_path, 'r')
                
                # Inizio lettura dalla fine
                stat = sftp.stat(current_file_path)
                last_file_size = stat.st_size
                remote_file.seek(last_file_size)
            
            # 3. Leggi dati incrementali
            if remote_file and current_file_path:
                try:
                    stat = sftp.stat(current_file_path)
                    current_size = stat.st_size
                    
                    if current_size > last_file_size:
                        # Leggi i nuovi byte
                        new_data = remote_file.read(current_size - last_file_size)
                        last_file_size = current_size
                        
                        chunk = new_data.decode('utf-8', errors='ignore')
                        lines = chunk.split('\n')
                        
                        count = 0
                        for line in lines:
                            line = line.strip()
                            if not line: continue
                            try:
                                data = json.loads(line)
                                s_name = data.get('sensor_name', 'Unknown')
                                sensors_data[s_name] = data
                                socketio.emit('sensor_update', {'sensor_name': s_name, 'data': data})
                                count += 1
                            except: pass
                        
                        if count > 0:
                            # Logghiamo solo ogni tanto per non spammare
                            # print(f"📡 [DATA] Inviati {count} update", flush=True)
                            pass
                    else:
                        socketio.sleep(0.05) # 50ms polling
                        
                except Exception as e:
                    print(f"⚠️ [WATCHER] Errore lettura: {e}", flush=True)
                    current_file_path = None # Reset
            else:
                print("⏳ [WATCHER] In attesa di file...", flush=True)
                socketio.sleep(2)
                
        except Exception as e:
            print(f"❌ [WATCHER] Crash loop: {e}", flush=True)
            ssh = None
            socketio.sleep(5)

if __name__ == '__main__':
    # AVVIA IL TASK IN BACKGROUND QUI
    socketio.start_background_task(background_watcher)
    
    port = int(os.environ.get('PORT', 5000))
    print(f"🌍 Server in ascolto su porta {port}...", flush=True)
    socketio.run(app, host='0.0.0.0', port=port)
