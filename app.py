import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO
from flask_cors import CORS
import json
import time
import os
import threading
import paramiko
import stat

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret!'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- CONFIGURAZIONE SSH ---
SSH_HOST = "lambda-iot.uniud.it"
SSH_USER = "gaspari"
SSH_PASS = os.environ.get("SSH_PASSWORD") # Prende la password da Render Env Vars
REMOTE_LOG_DIR = "/home/gaspari/data/"

sensors_data = {}

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({'sensors': sensors_data})

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data
    sensors_data = {}
    socketio.emit('data_cleared', {}, broadcast=True)
    return jsonify({'status': 'cleared'}), 200

# =========================================================
# GESTIONE CONNESSIONE SSH
# =========================================================
def create_ssh_client():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SSH_HOST, username=SSH_USER, password=SSH_PASS, timeout=10)
        return client
    except Exception as e:
        print(f"❌ Errore connessione SSH: {e}")
        return None

def get_latest_remote_file(sftp):
    """Trova il file più recente nella cartella remota"""
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        # Filtra solo i file che finiscono con _session_log.txt
        log_files = [f for f in files if f.filename.endswith('_session_log.txt')]
        
        if not log_files:
            return None
            
        # Ordina per data di modifica (st_mtime) decrescente
        latest = max(log_files, key=lambda f: f.st_mtime)
        return os.path.join(REMOTE_LOG_DIR, latest.filename)
    except Exception as e:
        print(f"⚠️ Errore ricerca file remoto: {e}")
        return None

# =========================================================
# THREAD WATCHER REMOTO
# =========================================================
def watch_remote_log():
    print(f"🚀 Avvio SSH Watcher verso {SSH_HOST}...")
    
    current_file = None
    ssh = None
    sftp = None
    remote_file = None
    
    while True:
        try:
            # 1. Connessione / Riconnessione
            if not ssh or not ssh.get_transport().is_active():
                print("🔄 Connessione SSH...")
                ssh = create_ssh_client()
                if not ssh:
                    time.sleep(5)
                    continue
                sftp = ssh.open_sftp()
                print("✅ SSH Connesso!")

            # 2. Cerca file più recente
            latest = get_latest_remote_file(sftp)
            
            # Se cambia file, riapri
            if latest and latest != current_file:
                print(f"📂 Trovato nuovo log: {latest}")
                if remote_file: remote_file.close()
                current_file = latest
                remote_file = sftp.open(current_file, 'r')
                # Vai alla fine per il real-time
                remote_file.seek(0, 2) 

            # 3. Leggi dati
            if remote_file:
                # Legge riga
                # Nota: Paramiko file object non ha readline bloccante, 
                # quindi leggiamo a blocchi o controlliamo stat
                line = remote_file.readline()
                if line:
                    try:
                        line = line.strip()
                        if not line: continue
                        
                        data = json.loads(line)
                        sensor_name = data.get('sensor_name', 'Unknown')
                        sensors_data[sensor_name] = data
                        
                        socketio.emit('sensor_update', {
                            'sensor_name': sensor_name,
                            'data': data
                        })
                    except json.JSONDecodeError:
                        continue
                else:
                    # Nessuna nuova riga, controlla se file è cresciuto
                    # Per evitare polling aggressivo, sleep breve
                    time.sleep(0.05) # 50ms (20Hz max refresh rate per non saturare SSH)
            else:
                print("⏳ In attesa di file log remoto...", end='\r')
                time.sleep(2)
                
        except Exception as e:
            print(f"❌ Errore Watcher SSH: {e}")
            # Reset connessione per forzare riconnessione
            try:
                if ssh: ssh.close()
            except: pass
            ssh = None
            time.sleep(3)

# Avvia thread
t = threading.Thread(target=watch_remote_log)
t.daemon = True
t.start()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
