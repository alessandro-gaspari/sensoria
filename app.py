from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)

# ⭐ RIMUOVI async_mode='eventlet'
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

@app.route('/api/data', methods=['POST'])
def receive_data():
    try:
        data = request.json
        sensor_name = data.get('sensor_name', 'Unknown')
        
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
        
        sensors_data[sensor_name] = sensor_reading
        sensors_status[sensor_name] = 'connected'
        
        socketio.emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_reading
        }, namespace='/')
        
        return jsonify({'status': 'success'}), 200
        
    except Exception as e:
        print(f'❌ Error: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data, sensors_status
    sensors_data = {}
    sensors_status = {}
    socketio.emit('data_cleared', {}, namespace='/')
    return jsonify({'status': 'success'}), 200

@socketio.on('connect')
def handle_connect():
    print('✅ Client connesso')
    emit('connection_response', {
        'status': 'connected',
        'sensors': sensors_data,
        'timestamp': datetime.now().isoformat()
    })

@socketio.on('disconnect')
def handle_disconnect():
    print('❌ Client disconnesso')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
