from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import json
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Variabili globali per memorizzare i dati
sensors_data = {}
sensors_status = {}

@app.route('/')
def index():
    """Dashboard principale"""
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    """Restituisce tutti i sensori e i loro dati"""
    return jsonify({
        'sensors': sensors_data,
        'status': sensors_status,
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/sensor/<sensor_name>', methods=['GET'])
def get_sensor(sensor_name):
    """Restituisce i dati di un singolo sensore"""
    if sensor_name in sensors_data:
        return jsonify({
            'name': sensor_name,
            'data': sensors_data[sensor_name],
            'status': sensors_status.get(sensor_name, 'disconnected'),
            'timestamp': datetime.now().isoformat()
        })
    return jsonify({'error': 'Sensor not found'}), 404

@app.route('/api/data', methods=['POST'])
def receive_data():
    """Riceve i dati dall'app Flutter"""
    global sensors_data, sensors_status
    
    try:
        data = request.json
        sensor_name = data.get('sensor_name', 'Unknown')
        
        # 🔧 Correzione: nome dizionario completo
        if sensor_name not in sensors_data:
            sensors_data[sensor_name] = []
        
        sensor_reading = {
            'timestamp': datetime.now().isoformat(),
            'accel_x': data.get('accel_x'),
            'accel_y': data.get('accel_y'),
            'accel_z': data.get('accel_z'),
            'gyro_x': data.get('gyro_x'),
            'gyro_y': data.get('gyro_y'),
            'gyro_z': data.get('gyro_z'),
            'mag_x': data.get('mag_x'),
            'mag_y': data.get('mag_y'),
            'mag_z': data.get('mag_z'),
        }
        
        sensors_data[sensor_name].append(sensor_reading)
        
        # Mantiene solo gli ultimi 100 dati
        if len(sensors_data[sensor_name]) > 100:
            sensors_data[sensor_name].pop(0)
        
        sensors_status[sensor_name] = 'connected'
        
        # Aggiornamento in tempo reale via WebSocket
        socketio.emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_reading
        }, broadcast=True)
        
        return jsonify({'status': 'success', 'message': 'Data received'}), 200
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/sensor/<sensor_name>/status', methods=['POST'])
def update_sensor_status(sensor_name):
    """Aggiorna lo stato di connessione di un sensore"""
    global sensors_status
    
    try:
        data = request.json
        status = data.get('status', 'disconnected')
        sensors_status[sensor_name] = status
        
        # Notifica via WebSocket
        socketio.emit('sensor_status_update', {
            'sensor_name': sensor_name,
            'status': status,
            'timestamp': datetime.now().isoformat()
        }, broadcast=True)
        
        return jsonify({'status': 'success'}), 200
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/clear', methods=['POST'])
def clear_data():
    """Pulisce tutti i dati dei sensori"""
    global sensors_data, sensors_status
    
    sensors_data = {}
    sensors_status = {}
    
    socketio.emit('data_cleared', {}, broadcast=True)
    
    return jsonify({'status': 'success', 'message': 'All data cleared'}), 200


@socketio.on('connect')
def handle_connect():
    """Gestisce nuova connessione WebSocket"""
    print('Client connected')
    emit('connection_response', {
        'status': 'connected',
        'sensors': list(sensors_data.keys()),
        'timestamp': datetime.now().isoformat()
    })


@socketio.on('disconnect')
def handle_disconnect():
    """Gestisce disconnessione WebSocket"""
    print('Client disconnected')


@socketio.on('request_data')
def handle_data_request(data):
    """Gestisce richieste di dati specifici"""
    sensor_name = data.get('sensor_name')
    if sensor_name and sensor_name in sensors_data:
        emit('sensor_data', {
            'sensor_name': sensor_name,
            'data': sensors_data[sensor_name],
            'status': sensors_status.get(sensor_name, 'disconnected')
        })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)