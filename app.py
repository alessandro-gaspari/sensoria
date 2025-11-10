from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*", ping_timeout=60, ping_interval=25)

sensors_data = {}
sensors_status = {}
sensors_filters = {}

# ⭐ CLASSE FILTRO EMA
class SensorFilter:
    def __init__(self, alpha=0.1):
        self.alpha = alpha
        self.last_accel_x = 0.0
        self.last_accel_y = 0.0
        self.last_accel_z = 0.0
        self.last_gyro_x = 0.0
        self.last_gyro_y = 0.0
        self.last_gyro_z = 0.0
        self.last_mag_x = 0.0
        self.last_mag_y = 0.0
        self.last_mag_z = 0.0
        self.initialized = False
    
    def filter_value(self, new_value, last_value):
        """EMA: filtered = last + alpha * (new - last)"""
        return last_value + self.alpha * (new_value - last_value)
    
    def filter_imu_data(self, raw_accel_x, raw_accel_y, raw_accel_z,
                       raw_gyro_x, raw_gyro_y, raw_gyro_z,
                       raw_mag_x, raw_mag_y, raw_mag_z):
        """Filtra i dati IMU con EMA"""
        
        # Converti a valori fisici
        accel_x = raw_accel_x / 4096.0
        accel_y = raw_accel_y / 4096.0
        accel_z = raw_accel_z / 4096.0
        
        gyro_x = raw_gyro_x / 65.54
        gyro_y = raw_gyro_y / 65.54
        gyro_z = raw_gyro_z / 65.54
        
        mag_x = raw_mag_x * 0.3
        mag_y = raw_mag_y * 0.3
        mag_z = raw_mag_z * 0.3
        
        # Prima volta: inizializza senza filtro
        if not self.initialized:
            self.last_accel_x = accel_x
            self.last_accel_y = accel_y
            self.last_accel_z = accel_z
            self.last_gyro_x = gyro_x
            self.last_gyro_y = gyro_y
            self.last_gyro_z = gyro_z
            self.last_mag_x = mag_x
            self.last_mag_y = mag_y
            self.last_mag_z = mag_z
            self.initialized = True
            
            return {
                'accel_x': self.last_accel_x,
                'accel_y': self.last_accel_y,
                'accel_z': self.last_accel_z,
                'gyro_x': self.last_gyro_x,
                'gyro_y': self.last_gyro_y,
                'gyro_z': self.last_gyro_z,
                'mag_x': self.last_mag_x,
                'mag_y': self.last_mag_y,
                'mag_z': self.last_mag_z,
            }
        
        # EMA filtering
        self.last_accel_x = self.filter_value(accel_x, self.last_accel_x)
        self.last_accel_y = self.filter_value(accel_y, self.last_accel_y)
        self.last_accel_z = self.filter_value(accel_z, self.last_accel_z)
        
        self.last_gyro_x = self.filter_value(gyro_x, self.last_gyro_x)
        self.last_gyro_y = self.filter_value(gyro_y, self.last_gyro_y)
        self.last_gyro_z = self.filter_value(gyro_z, self.last_gyro_z)
        
        self.last_mag_x = self.filter_value(mag_x, self.last_mag_x)
        self.last_mag_y = self.filter_value(mag_y, self.last_mag_y)
        self.last_mag_z = self.filter_value(mag_z, self.last_mag_z)
        
        return {
            'accel_x': self.last_accel_x,
            'accel_y': self.last_accel_y,
            'accel_z': self.last_accel_z,
            'gyro_x': self.last_gyro_x,
            'gyro_y': self.last_gyro_y,
            'gyro_z': self.last_gyro_z,
            'mag_x': self.last_mag_x,
            'mag_y': self.last_mag_y,
            'mag_z': self.last_mag_z,
        }
    
    def reset(self):
        """Reset filtro"""
        self.initialized = False
        self.last_accel_x = 0.0
        self.last_accel_y = 0.0
        self.last_accel_z = 0.0
        self.last_gyro_x = 0.0
        self.last_gyro_y = 0.0
        self.last_gyro_z = 0.0
        self.last_mag_x = 0.0
        self.last_mag_y = 0.0
        self.last_mag_z = 0.0

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({
        'sensors': sensors_data,
        'status': sensors_status,
        'timestamp': datetime.now().isoformat()
    })

# ⭐ ENDPOINT CHE RICEVE DATI DA FLUTTER
@app.route('/api/data', methods=['POST'])
def receive_data():
    """Riceve dati da Flutter, filtra IMU e inoltra tutto via Socket.IO"""
    try:
        data = request.json
        sensor_name = data.get('sensor_name', 'Unknown')
        sensor_data = data.get('data', {})
        
        print(f'\n🔵 HTTP POST da {sensor_name}')
        print(f'   accel_x: {sensor_data.get("accel_x")}')
        
        # ⭐ CHECK PRESSIONI
        pressure_keys = [k for k in sensor_data.keys() if k.startswith('pressure_')]
        if pressure_keys:
            print(f'   ✅ PRESSIONI: {len(pressure_keys)} sensori')
            print(f'      p1={sensor_data.get("pressure_1")}, p2={sensor_data.get("pressure_2")}')
        else:
            print(f'   ❌ Nessuna pressione')
        
        # ⭐ CREA FILTRO SE NON ESISTE
        if sensor_name not in sensors_filters:
            sensors_filters[sensor_name] = SensorFilter(alpha=0.1)
            print(f'   ✨ Filtro EMA creato')
        
        # ⭐ FILTRA SOLO I DATI IMU
        filtered_imu = sensors_filters[sensor_name].filter_imu_data(
            raw_accel_x=int(sensor_data.get('accel_x', 0)),
            raw_accel_y=int(sensor_data.get('accel_y', 0)),
            raw_accel_z=int(sensor_data.get('accel_z', 0)),
            raw_gyro_x=int(sensor_data.get('gyro_x', 0)),
            raw_gyro_y=int(sensor_data.get('gyro_y', 0)),
            raw_gyro_z=int(sensor_data.get('gyro_z', 0)),
            raw_mag_x=int(sensor_data.get('mag_x', 0)),
            raw_mag_y=int(sensor_data.get('mag_y', 0)),
            raw_mag_z=int(sensor_data.get('mag_z', 0)),
        )
        
        # ⭐ CREA PAYLOAD COMPLETO: IMU FILTRATI + PRESSIONI RAW
        sensor_reading = {
            'timestamp': sensor_data.get('timestamp', datetime.utcnow().isoformat()),
            **filtered_imu,  # IMU filtrati
        }
        
        # ⭐ COPIA TUTTE LE PRESSIONI (RAW, senza filtro)
        for key, value in sensor_data.items():
            if key.startswith('pressure_'):
                sensor_reading[key] = value
        
        # ⭐ SALVA E INOLTRA
        sensors_data[sensor_name] = sensor_reading
        sensors_status[sensor_name] = 'connected'
        
        # ⭐ EMETTI VIA SOCKET.IO
        socketio.emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_reading  # Include IMU + pressioni
        }, namespace='/')
        
        if pressure_keys:
            print(f'   🟢 Emesso via Socket.IO (IMU + {len(pressure_keys)} pressioni)\n')
        else:
            print(f'   🟢 Emesso via Socket.IO (solo IMU)\n')
        
        return jsonify({'status': 'success'}), 200
        
    except Exception as e:
        print(f'❌ Errore: {e}')
        import traceback
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/api/clear', methods=['POST'])
def clear_data():
    """Pulisci dati e resetta filtri"""
    global sensors_data, sensors_status, sensors_filters
    sensors_data = {}
    sensors_status = {}
    
    for sensor_name in sensors_filters:
        sensors_filters[sensor_name].reset()
    sensors_filters = {}
    
    socketio.emit('data_cleared', {}, namespace='/')
    print('🗑️ Dati e filtri puliti')
    return jsonify({'status': 'success'}), 200

@socketio.on('connect')
def handle_connect():
    print('✅ Client WebSocket connesso')
    emit('connection_response', {
        'status': 'connected',
        'sensors': sensors_data,
        'timestamp': datetime.now().isoformat()
    })

@socketio.on('disconnect')
def handle_disconnect():
    print('❌ Client WebSocket disconnesso')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    print(f'\n🚀 Flask + SocketIO su porta {port}')
    print(f'📊 Endpoint: /api/data (POST)')
    print(f'🔧 Filtro EMA: alpha=0.1 (solo IMU)')
    print(f'📡 WebSocket: enabled')
    print(f'🦶 Pressioni: passthrough (no filtro)\n')
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
