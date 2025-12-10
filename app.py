import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import json
import time
import os
import threading
import glob

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret!'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# ⚠️ CARTELLA DOVE IL TUO SCRIPT TCP SALVA I LOG
LOG_DIR = "/home/gaspari/data/"
# Se stai testando in locale sul tuo PC e non sul server, cambia questo percorso!
# Esempio locale: LOG_DIR = "./data/" (e crea la cartella data)

sensors_data = {}
current_log_file = None # Tiene traccia del file che stiamo leggendo

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({'sensors': sensors_data, 'active_file': current_log_file})

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data
    sensors_data = {}
    socketio.emit('data_cleared', {}, broadcast=True)
    return jsonify({'status': 'cleared'}), 200

# =========================================================
# FUNZIONE PER TROVARE L'ULTIMO LOG CREATO
# =========================================================
def get_latest_log_file():
    """Trova il file .txt modificato più di recente nella cartella LOG_DIR"""
    try:
        # Cerca tutti i file che finiscono con _session_log.txt
        pattern = os.path.join(LOG_DIR, "*_session_log.txt")
        list_of_files = glob.glob(pattern)
        
        if not list_of_files:
            return None
            
        # Trova il più recente in base al tempo di creazione/modifica
        latest_file = max(list_of_files, key=os.path.getmtime)
        return latest_file
    except Exception as e:
        print(f"Errore ricerca file: {e}")
        return None

# =========================================================
# THREAD WATCHER INTELLIGENTE
# =========================================================
def watch_log_file():
    global current_log_file
    print(f"👀 WATCHER AVVIATO: Monitoraggio cartella {LOG_DIR}...")
    
    f = None
    last_pos = 0
    
    while True:
        # 1. Se non abbiamo un file o il file attuale non cambia da molto...
        # Cerchiamo se c'è un file NUOVO (appena creato dall'app)
        latest = get_latest_log_file()
        
        if latest and latest != current_log_file:
            print(f"🔄 Rilevato NUOVO file di sessione: {latest}")
            if f: f.close()
            
            current_log_file = latest
            try:
                f = open(current_log_file, 'r')
                # Andiamo alla fine per vedere solo il real-time
                f.seek(0, 2) 
            except Exception as e:
                print(f"Errore apertura file {latest}: {e}")
                f = None
                time.sleep(1)
                continue
        
        # 2. Se abbiamo un file aperto, leggiamo le nuove righe
        if f:
            line = f.readline()
            if line:
                try:
                    line = line.strip()
                    if not line: continue
                    
                    # Parsing JSON
                    data = json.loads(line)
                    sensor_name = data.get('sensor_name', 'Unknown')
                    
                    # Aggiorna memoria
                    sensors_data[sensor_name] = data
                    
                    # Invia al frontend
                    socketio.emit('sensor_update', {
                        'sensor_name': sensor_name,
                        'data': data
                    })
                except json.JSONDecodeError:
                    continue # Ignora righe parziali
                except Exception as e:
                    print(f"Errore parsing: {e}")
            else:
                socketio.sleep(0.01) # Nessun dato nuovo, sleep breve
        else:
            # Nessun file trovato ancora, aspettiamo
            print("⏳ In attesa di file di log...", end='\r')
            time.sleep(1)

# Avvia il thread watcher
t = threading.Thread(target=watch_log_file)
t.daemon = True
t.start()

if __name__ == '__main__':
    # Assicurati che la cartella esista
    if not os.path.exists(LOG_DIR):
        try:
            os.makedirs(LOG_DIR)
            print(f"📁 Creata cartella {LOG_DIR}")
        except:
            print(f"⚠️ Attenzione: Cartella {LOG_DIR} non trovata e impossibile crearla")

    port = int(os.environ.get('PORT', 5000)) # Porta Web (default 5000)
    socketio.run(app, host='0.0.0.0', port=port)
