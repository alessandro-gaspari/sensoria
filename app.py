from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from datetime import datetime
import os
import socket
import threading
import json
import time

app = Flask(__name__)
app.config['SECRET_KEY'] = 'sensoria_secret_key_2024'
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*")

sensors_data = {}
sensors_status = {}

# ⭐ SOCKET SERVER (TCP)
TCP_HOST = '0.0.0.0'
TCP_PORT = 9001
tcp_socket = None
tcp_clients = []
tcp_lock = threading.Lock()


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


@app.route('/api/clear', methods=['POST'])
def clear_data():
    global sensors_data, sensors_status
    sensors_data = {}
    sensors_status = {}
    socketio.emit('data_cleared', {}, namespace='/')
    return jsonify({'status': 'success'}), 200


def handle_tcp_client(client_socket, client_address):
    """Gestisce la connessione di un client TCP"""
    print(f'✅ Nuovo client TCP connesso: {client_address}')

    with tcp_lock:
        tcp_clients.append(client_socket)

    try:
        while True:
            # Ricevi dati dal client
            data = client_socket.recv(1024).decode('utf-8').strip()

            if not data:
                break

            # ⭐ PARSA JSON
            try:
                json_data = json.loads(data)
                sensor_name = json_data.get('sensor_name', 'Unknown')

                print(f'\n🔵 TCP DATA RICEVUTO da {sensor_name}:')
                print(f'   {json_data}')

                # Salva i dati
                sensor_reading = {
                    'timestamp': json_data.get('timestamp', datetime.utcnow().isoformat()),
                    'accel_x': json_data.get('accel_x'),
                    'accel_y': json_data.get('accel_y'),
                    'accel_z': json_data.get('accel_z'),
                    'gyro_x': json_data.get('gyro_x'),
                    'gyro_y': json_data.get('gyro_y'),
                    'gyro_z': json_data.get('gyro_z'),
                    'mag_x': json_data.get('mag_x'),
                    'mag_y': json_data.get('mag_y'),
                    'mag_z': json_data.get('mag_z'),
                }

                sensors_data[sensor_name] = sensor_reading
                sensors_status[sensor_name] = 'connected'

                # ⭐ INVIA ACK AL CLIENT
                ack_response = json.dumps({'status': 'OK'}) + '\n'
                client_socket.send(ack_response.encode('utf-8'))
                print(f'   📤 ACK inviato')

                # ⭐ EMETTI VIA SOCKET.IO AI CLIENT WEB
                socketio.emit('sensor_update', {
                    'sensor_name': sensor_name,
                    'data': sensor_reading
                }, namespace='/')

                print(f'🟢 Dati processati e inviati via Socket.IO\n')

            except json.JSONDecodeError as e:
                print(f'❌ Errore parsing JSON: {e}')
                error_response = json.dumps({'status': 'ERROR', 'message': 'Invalid JSON'}) + '\n'
                client_socket.send(error_response.encode('utf-8'))

    except Exception as e:
        print(f'❌ Errore nel client TCP {client_address}: {e}')

    finally:
        print(f'🛑 Client TCP disconnesso: {client_address}')
        with tcp_lock:
            if client_socket in tcp_clients:
                tcp_clients.remove(client_socket)
        client_socket.close()


def start_tcp_server():
    """Avvia il server TCP in un thread separato"""
    global tcp_socket

    try:
        tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        tcp_socket.bind((TCP_HOST, TCP_PORT))
        tcp_socket.listen(5)

        print(f'\n✅ TCP Server avviato su {TCP_HOST}:{TCP_PORT}')

        while True:
            try:
                client_socket, client_address = tcp_socket.accept()
                # Gestisci ogni client in un thread separato
                client_thread = threading.Thread(
                    target=handle_tcp_client,
                    args=(client_socket, client_address),
                    daemon=True
                )
                client_thread.start()

            except Exception as e:
                print(f'❌ Errore accettando client: {e}')
                break

    except Exception as e:
        print(f'❌ Errore avviamento TCP Server: {e}')

    finally:
        if tcp_socket:
            tcp_socket.close()


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

    # ⭐ AVVIA TCP SERVER IN UN THREAD
    tcp_thread = threading.Thread(target=start_tcp_server, daemon=True)
    tcp_thread.start()

    # Attendi un momento che il TCP server si avvii
    time.sleep(1)

    # Avvia Flask + SocketIO
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)