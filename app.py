from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from tcp_forwarder import TCPDataForwarder
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_2024'
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# ✅ Inizializza TCP forwarder per il server del prof
tcp_forwarder = TCPDataForwarder(
    host='lambda-iot.uniud.it',
    port=22729  # ✅ PORTA CORRETTA
)
tcp_forwarder.start()

# Storage locale sensori (per dashboard)
sensors_data = {}

@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/sensors')
def get_sensors():
    """Restituisce sensori attualmente connessi"""
    return jsonify({'sensors': sensors_data})

@app.route('/api/clear', methods=['POST'])
def clear_sensors():
    """Pulisce dati sensori"""
    global sensors_data
    sensors_data = {}
    socketio.emit('data_cleared', broadcast=True)
    print('🗑️ Dati sensori puliti')
    return jsonify({'success': True})

@socketio.on('connect')
def handle_connect():
    print(f'✅ Client connesso: {request.sid}')
    emit('connection_response', {'sensors': sensors_data})

@socketio.on('disconnect')
def handle_disconnect():
    print(f'⚠️ Client disconnesso: {request.sid}')

@socketio.on('sensor_update')
def handle_sensor_update(data):
    """
    Riceve dati dai sensori via Socket.IO
    Formato atteso da app Flutter:
      {
        "sensor_name": "Calzino DX",
        "data": {
            "accel_x": 123, "accel_y": 456, "accel_z": 789,
            "gyro_x": 12, "gyro_y": 34, "gyro_z": 56,
            "mag_x": 1, "mag_y": 2, "mag_z": 3,
            "pressure_0": 500, "pressure_1": 600, "pressure_2": 700,
            "timestamp": "2024-11-24T09:56:00.123Z"
        }
      }
    """
    try:
        sensor_name = data.get("sensor_name")
        sensor_data = data.get("data")
        
        if not sensor_name or not sensor_data:
            print("⚠️ Dati sensore incompleti")
            return
        
        # Aggiorna storage locale
        sensors_data[sensor_name] = sensor_data
        
        # ✅ Inoltra al server TCP del prof (NON BLOCCANTE)
        tcp_forwarder.send_sensor_data(sensor_name, sensor_data)
        
        # Broadcast ai client dashboard web
        emit('sensor_update', {
            'sensor_name': sensor_name,
            'data': sensor_data
        }, broadcast=True)
        
        # Log ridotto per non intasare console
        if sensor_data.get('accel_x') is not None:
            print(f"📊 {sensor_name}: accel({sensor_data.get('accel_x')}, {sensor_data.get('accel_y')}, {sensor_data.get('accel_z')})")
        
        # ✅ Log conferma invio TCP
        print(f"📤 Inoltrato a TCP server: {sensor_name}")
        
    except Exception as e:
        print(f"❌ Errore handle_sensor_update: {e}")
        import traceback
        traceback.print_exc()

@socketio.on('sensor_disconnected')
def handle_sensor_disconnected(data):
    """Gestisce disconnessione sensore"""
    sensor_name = data.get('sensor_name')
    if sensor_name and sensor_name in sensors_data:
        del sensors_data[sensor_name]
        emit('sensor_disconnected', {'sensor_name': sensor_name}, broadcast=True)
        print(f"🔌 Sensore disconnesso: {sensor_name}")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    
    print('=' * 60)
    print('🚀 Sensoria Server')
    print('=' * 60)
    print(f'📡 Server Flask su porta {port}')
    print(f'🔗 TCP Forwarder -> lambda-iot.uniud.it:22729')  
    print('=' * 60)
    
    try:
        socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True)
    finally:
        print('🛑 Shutting down...')
        tcp_forwarder.stop()
        print('✅ Server terminato')
