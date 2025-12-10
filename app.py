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
SSH_PASS = os.environ.get("SSH_PASSWORD") 
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
    print(f"🔄 Tentativo connessione SSH a {SSH_HOST}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SSH_HOST, username=SSH_USER, password=SSH_PASS, timeout=10)
        print("✅ SSH Connesso con successo!")
        return client
    except Exception as e:
        print(f"❌ Errore critico connessione SSH: {e}")
        return None

def get_latest_remote_file(sftp):
    try:
        files = sftp.listdir_attr(REMOTE_LOG_DIR)
        # Filtra solo i file che finiscono con _session_log.txt e hanno dimensione > 0
        log_files = [f for f in files if f.filename.endswith('_session_log.txt')]
        
        if not log_files:
            return None
            
        # Ordina per data di modifica decrescente
        latest = max(log_files, key=lambda f: f.st_mtime)
        full_path = os.path.join(REMOTE_LOG_DIR, latest.filename)
        return full_path
    except Exception as e:
        print(f"⚠️ Errore lista file remoti: {e}")
        return None

# =========================================================
# THREAD WATCHER REMOTO (VERSIONE ROBUSTA)
# =========================================================
def watch_remote_log():
    ssh = None
    sftp = None
    remote_file = None
    current_file_path = None
    last_file_size = 0
    
    while True:
        try:
            # 1. RICONNESSIONE SE NECESSARIO
            if not ssh or not ssh.get_transport() or not ssh.get_transport().is_active():
                if ssh: ssh.close()
                ssh = create_ssh_client()
                if not ssh:
                    socketio.sleep(5)
                    continue
                sftp = ssh.open_sftp()
            
            # 2. CERCA NUOVO FILE
            latest_path = get_latest_remote_file(sftp)
            
            # Se troviamo un file nuovo o diverso da quello aperto
            if latest_path and latest_path != current_file_path:
                print(f"📂 Trovato nuovo file log: {latest_path}")
                if remote_file: remote_file.close()
                
                current_file_path = latest_path
                remote_file = sftp.open(current_file_path, 'r')
                
                # Vai alla fine del file per iniziare il tail
                stat = sftp.stat(current_file_path)
                last_file_size = stat.st_size
                remote_file.seek(last_file_size)
                print(f"⏩ Seek alla posizione {last_file_size}")

            # 3. LEGGI DATI (POLLING SULLA DIMENSIONE)
            if remote_file and current_file_path:
                try:
                    # Controlla la dimensione attuale del file remoto
                    stat = sftp.stat(current_file_path)
                    current_size = stat.st_size
                    
                    if current_size > last_file_size:
                        # Ci sono nuovi dati! Leggiamoli tutti
                        new_data = remote_file.read(current_size - last_file_size)
                        last_file_size = current_size
                        
                        # Decodifica e splitta per righe
                        chunk = new_data.decode('utf-8', errors='ignore')
                        lines = chunk.split('\n')
                        
                        count = 0
                        for line in lines:
                            line = line.strip()
                            if not line: continue
                            
                            try:
                                data = json.loads(line)
                                sensor_name = data.get('sensor_name', 'Unknown')
                                sensors_data[sensor_name] = data
                                
                                socketio.emit('sensor_update', {
                                    'sensor_name': sensor_name,
                                    'data': data
                                })
                                count += 1
                            except json.JSONDecodeError:
                                pass # Righe incomplete o corrotte
                        
                        if count > 0:
                            print(f"📡 Inviati {count} pacchetti alla dashboard")
                            
                    else:
                        # Nessun nuovo dato, aspetta un po'
                        socketio.sleep(0.1) 
                        
                except IOError:
                    # File forse cancellato o ruotato
                    print("⚠️ Errore lettura file (forse chiuso/ruotato), reset...")
                    current_file_path = None
                    remote_file = None
            else:
                print("⏳ In attesa di file log...", end='\r')
                socketio.sleep(2)
                
        except Exception as e:
            print(f"❌ Errore generale Watcher: {e}")
            ssh = None # Forza riconnessione
            socketio.sleep(3)

# Avvia thread
t = threading.Thread(target=watch_remote_log)
t.daemon = True
t.start()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
