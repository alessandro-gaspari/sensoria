import 'dart:io';
import 'dart:convert';

class TCPDataSender {
  Socket? _socket;
  final String host = 'lambda-iot.uniud.it';
  final int port = 25000;
  
  bool _isConnected = false;
  bool _isConnecting = false; // ✅ Flag per evitare riconnessioni sovrapposte

  bool get isConnected => _isConnected;
  
  Future<bool> connect() async {
    if (_isConnecting) return false; // Se sta già connettendo, aspetta
    if (_isConnected) return true;

    _isConnecting = true;
    
    try {
      // Timeout ridotto a 3 secondi per essere più reattivi
      _socket = await Socket.connect(host, port, timeout: const Duration(seconds: 3));
      _isConnected = true;
      
      // Gestione chiusura lato server
      _socket!.done.then((_) {
        print('🔌 TCP Server ha chiuso la connessione');
        _handleDisconnection();
      }).catchError((e) {
        print('❌ Errore socket stream: $e');
        _handleDisconnection();
      });

      print('✅ Connesso a TCP server $host:$port');
      return true;
    } catch (e) {
      print('❌ Errore connessione TCP: $e');
      _isConnected = false;
      return false;
    } finally {
      _isConnecting = false;
    }
  }

  void _handleDisconnection() {
    _isConnected = false;
    _socket?.destroy();
    _socket = null;
  }

  Future<void> sendData(String sensorName, Map<String, dynamic> data) async {
    // Se disconnesso, prova a riconnettere (ma solo se non sta già provando)
    if (!_isConnected) {
      if (!_isConnecting) {
        await connect();
      } else {
        // Stiamo connettendo, droppa questo pacchetto per non bloccare
        return; 
      }
    }

    if (!_isConnected || _socket == null) return;

    try {
      final payload = {
        'timestamp': DateTime.now().toIso8601String(),
        'sensor_name': sensorName,
        ...data
      };

      // ✅ Aggiunge newline fondamentale per il server
      final jsonLine = jsonEncode(payload) + '\n';
      
      // ✅ Usa add(utf8.encode) che è più sicuro di write()
      _socket!.add(utf8.encode(jsonLine));
      
      // ❌ RIMOSSO await flush() -> troppo lento per 100Hz!
      // Il sistema operativo gestirà il buffer da solo.
      
    } catch (e) {
      print('❌ Errore invio TCP: $e');
      _handleDisconnection();
    }
  }

  void disconnect() {
    _handleDisconnection();
    print('🔌 Disconnesso manualmente da TCP server');
  }
}
