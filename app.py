from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", ping_timeout=60, ping_interval=25)

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
def receive_data_http():
    try:
        data = request.json or {}
        sensor_name = data.get('sensor_name', 'Unknown')
        sensor_data = data.get('data', {})
        reading = sensor_data.copy()
        sensors_data[sensor_name] = reading
        sensors_status[sensor_name] = 'connected'
        socketio.emit('sensor_update', {'sensor_name': sensor_name, 'data': reading}, broadcast=True)
        return jsonify({'status': 'success'}), 200
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400

@socketio.on('sensor_data')
def handle_sensor_data_ws(payload):
    try:
        sensor_name = payload.get('sensor_name', 'Unknown')
        sensor_data = payload.get('data', {})
        reading = sensor_data.copy()
        sensors_data[sensor_name] = reading
        sensors_status[sensor_name] = 'connected'
        emit('sensor_update', {'sensor_name': sensor_name, 'data': reading}, broadcast=True)
    except Exception as e:
        print('WS error:', e)

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data, sensors_status
    sensors_data = {}
    sensors_status = {}
    socketio.emit('data_cleared', {}, broadcast=True)
    return jsonify({'status': 'success'}), 200

@socketio.on('connect')
def handle_connect():
    emit('connection_response', {
        'status': 'connected',
        'sensors': sensors_data,
        'timestamp': datetime.now().isoformat()
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
