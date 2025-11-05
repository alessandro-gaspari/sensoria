from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

sensors_data = {}
sensors_status = {}
last_knee_angle = {'angle': 0, 'calibrated': False, 'timestamp': None}

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors', methods=['GET'])
def get_sensors():
    return jsonify({
        'sensors': sensors_data,
        'status': sensors_status,
        'knee_angle': last_knee_angle,
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/data', methods=['POST'])
def receive_data():
    try:
        data = request.json
        sensor_name = data.get('sensor_name', 'Unknown')

        sensor_reading = {
            'timestamp': datetime.now().isoformat(),
            'accel_x_ms2': data.get('accel_x_ms2'),
            'accel_y_ms2': data.get('accel_y_ms2'),
            'accel_z_ms2': data.get('accel_z_ms2'),
            'gyro_x_dps': data.get('gyro_x_dps'),
            'gyro_y_dps': data.get('gyro_y_dps'),
            'gyro_z_dps': data.get('gyro_z_dps'),
            'mag_x_uT': data.get('mag_x_uT'),
            'mag_y_uT': data.get('mag_y_uT'),
            'mag_z_uT': data.get('mag_z_uT'),
        }

        # Fallback compatibilità
        if sensor_reading['accel_x_ms2'] is None and data.get('accel_x') is not None:
            sensor_reading['accel_x_ms2'] = data.get('accel_x')
            sensor_reading['accel_y_ms2'] = data.get('accel_y')
            sensor_reading['accel_z_ms2'] = data.get('accel_z')
        if sensor_reading['gyro_x_dps'] is None and data.get('gyro_x') is not None:
            sensor_reading['gyro_x_dps'] = data.get('gyro_x')
            sensor_reading['gyro_y_dps'] = data.get('gyro_y')
            sensor_reading['gyro_z_dps'] = data.get('gyro_z')
        if sensor_reading['mag_x_uT'] is None and data.get('mag_x') is not None:
            sensor_reading['mag_x_uT'] = data.get('mag_x')
            sensor_reading['mag_y_uT'] = data.get('mag_y')
            sensor_reading['mag_z_uT'] = data.get('mag_z')

        sensors_data[sensor_name] = sensor_reading
        sensors_status[sensor_name] = 'connected'

        socketio.emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_reading
        })

        return jsonify({'status': 'success'}), 200
    except Exception as e:
        print(f'❌ Error: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/api/knee_angle', methods=['POST'])
def receive_knee_angle():
    try:
        data = request.json
        angle = int(data.get('knee_angle_deg', 0))
        calibrated = bool(data.get('calibrated', False))
        ts = data.get('timestamp', datetime.now().isoformat())
        last_knee_angle.update({'angle': angle, 'calibrated': calibrated, 'timestamp': ts})
        socketio.emit('knee_angle_update', last_knee_angle)
        return jsonify({'status': 'ok'}), 200
    except Exception as e:
        print(f'❌ Angle Error: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 400

@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data, sensors_status, last_knee_angle
    sensors_data = {}
    sensors_status = {}
    last_knee_angle = {'angle': 0, 'calibrated': False, 'timestamp': None}
    socketio.emit('data_cleared', {})
    return jsonify({'status': 'success'}), 200

@socketio.on('connect')
def handle_connect():
    print('✅ Client connesso')
    emit('connection_response', {
        'status': 'connected',
        'sensors': sensors_data,
        'knee_angle': last_knee_angle,
        'timestamp': datetime.now().isoformat()
    })

@socketio.on('disconnect')
def handle_disconnect():
    print('❌ Client disconnesso')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
