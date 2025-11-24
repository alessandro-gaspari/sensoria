import socket
import json
import threading
import time
from queue import Queue
from datetime import datetime

class TCPDataForwarder:
    def __init__(self, host='localhost', port=9001, reconnect_delay=5):
        self.host = host
        self.port = port
        self.reconnect_delay = reconnect_delay
        self.data_queue = Queue()
        self.is_running = False
        self.thread = None
        self.socket = None
        self.connected = False
        
    def start(self):
        if self.is_running:
            return
        self.is_running = True
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()
        print(f"✅ TCP Forwarder started -> {self.host}:{self.port}")
        
    def stop(self):
        self.is_running = False
        if self.thread:
            self.thread.join(timeout=5)
        self._disconnect()
        print("🛑 TCP Forwarder stopped")
        
    def send_sensor_data(self, sensor_name, data_dict):
        timestamp = datetime.now().isoformat()
        record = {
            "timestamp": timestamp,
            "sensor_name": sensor_name,
            **data_dict  # inserisce automaticamente tutte le chiavi/valori del dict
        }
        self.data_queue.put(record)
        
    def _connect(self):
        try:
            if self.socket:
                self._disconnect()
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(10)
            self.socket.connect((self.host, self.port))
            self.connected = True
            print(f"✅ Connected to TCP server {self.host}:{self.port}")
            return True
        except Exception as e:
            print(f"❌ TCP connection failed: {e}")
            self.connected = False
            return False
            
    def _disconnect(self):
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.connected = False
        
    def _send_record(self, record):
        try:
            json_line = json.dumps(record) + '\n'
            self.socket.sendall(json_line.encode('utf-8'))
            response = self.socket.recv(4096).decode('utf-8')
            if 'OK' in response:
                return True
            else:
                print(f"⚠️ Server response: {response}")
                return False
        except Exception as e:
            print(f"❌ Send error: {e}")
            self.connected = False
            return False
            
    def _worker(self):
        while self.is_running:
            try:
                if not self.connected:
                    if not self._connect():
                        time.sleep(self.reconnect_delay)
                        continue
                
                if not self.data_queue.empty():
                    record = self.data_queue.get(timeout=0.1)
                    if not self._send_record(record):
                        self.data_queue.put(record)
                        self._disconnect()
                        time.sleep(self.reconnect_delay)
                else:
                    time.sleep(0.01)
                    
            except Exception as e:
                print(f"❌ TCP Forwarder worker error: {e}")
                time.sleep(1)
