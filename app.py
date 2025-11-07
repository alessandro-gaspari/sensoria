from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os
import socket
import threading
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*")

sensors_data = {}
sensors_status = {}

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

# ⭐ ENDPOINT CHE MANCAVA!
@app.route('/api/data', methods=['POST'])
def receive_data():
    """Riceve dati da Flutter via HTTP POST"""
    try:
        data = request.json
        sensor_name = data.get('sensor_name', 'Unknown')
        sensor_data = data.get('data', {})
        
        print(f'\n🔵 HTTP POST RICEVUTO da {sensor_name}:')
        print(f'   {sensor_data}')
        
        # Salva i dati
        sensor_reading = {
            'timestamp': sensor_data.get('timestamp', datetime.utcnow().isoformat()),
            'accel_x': sensor_data.get('accel_x'),
            'accel_y': sensor_data.get('accel_y'),
            'accel_z': sensor_data.get('accel_z'),
            'gyro_x': sensor_data.get('gyro_x'),
            'gyro_y': sensor_data.get('gyro_y'),
            'gyro_z': sensor_data.get('gyro_z'),
            'mag_x': sensor_data.get('mag_x'),
            'mag_y': sensor_data.get('mag_y'),
            'mag_z': sensor_data.get('mag_z'),
        }
        
        sensors_data[sensor_name] = sensor_reading
        sensors_status[sensor_name] = 'connected'
        
        print(f'   ✅ Salvato')
        
        # ⭐ EMETTI VIA SOCKET.IO AL DASHBOARD
        socketio.emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_reading
        }, namespace='/')
        
        print(f'🟢 Inviato via Socket.IO al dashboard\n')
        
        return jsonify({'status': 'success'}), 200
        
    except Exception as e:
        print(f'❌ Errore: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data, sensors_status
    sensors_data = {}
    sensors_status = {}
    socketio.emit('data_cleared', {}, namespace='/')
    print('🗑️ Dati puliti')
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
    print(f'\n🚀 Flask + SocketIO avviato su porta {port}')
    print(f'📊 Endpoint: /api/data (POST)')
    print(f'📡 WebSocket: enabled\n')
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
