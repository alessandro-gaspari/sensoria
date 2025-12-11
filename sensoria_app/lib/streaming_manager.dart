import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:async';
import '../utils/tcp_client.dart';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 100;

  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>> _latestData = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, String> _deviceProtocols = {};

  // ==================== HRM VARIABLES ====================
  int? _currentHeartRate;
  int? get currentHeartRate => _currentHeartRate;
  
  String? _hrmDeviceId;
  String? _hrmDeviceName; // Nuova variabile per il nome
  String? get hrmDeviceName => _hrmDeviceName;

  bool get isSshConnected => _tcpSender?.isConnected ?? false;

  IO.Socket? _socket;
  bool _isSocketConnected = false;

  TCPDataSender? _tcpSender;
  bool _isTrackingActive = false;

  bool get isStreaming => _activeStreams.isNotEmpty;
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  bool get isTrackingActive => _isTrackingActive;
  bool _isServerReachable = false;
  bool get isServerReachable => _isServerReachable;
  Timer? _serverCheckTimer;

  Map<String, bool> get streamingStatus =>
      Map.from(_activeStreams.map((key, value) => MapEntry(key, true)));
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  StreamingManager() {
    _connectWebSocket();
    _startServerCheck();
  }

  void _startServerCheck() {
    _checkServer();
    _serverCheckTimer = Timer.periodic(const Duration(seconds: 5), (_) => _checkServer());
  }

  Future<void> _checkServer() async {
    final checker = TCPDataSender();
    final isUp = await checker.checkConnection();
    
    if (isUp != _isServerReachable) {
      _isServerReachable = isUp;
      notifyListeners();
      debugPrint('SSH Server status changed: $isUp');
    }
  }

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    stopTracking();
    stopAll();
    _socket?.disconnect();
    _socket?.dispose();
    _serverCheckTimer?.cancel();
    super.dispose();
  }

  // ==================== HRM LOGIC ====================
  
  // Aggiornato per prendere anche il nome
  void setHrmConnection(String deviceId, String deviceName, int bpm) {
    _hrmDeviceId = deviceId;
    _hrmDeviceName = deviceName;
    updateHeartRate(bpm);
  }

  void updateHeartRate(int bpm) {
    _currentHeartRate = bpm;
    notifyListeners();

    if (_isTrackingActive && _tcpSender != null && _tcpSender!.isConnected) {
       final timestamp = DateTime.now().toUtc().toIso8601String();
       _tcpSender!.sendData("HRM", {
         "timestamp": timestamp,
         "bpm": bpm,
         "sensor_name": _hrmDeviceName ?? "HRM_GENERIC"
       });
    }
  }

  void clearHrmConnection() {
    _hrmDeviceId = null;
    _hrmDeviceName = null;
    _currentHeartRate = null;
    notifyListeners();
  }

  // ==================== TRACKING LOGIC ====================

  void startTracking() {
    if (_isTrackingActive) {
      debugPrint('⚠️ Tracking già attivo');
      return;
    }
    
    _isTrackingActive = true;
    _tcpSender = TCPDataSender();
    _tcpSender?.connect();
    debugPrint('📍 Tracking avviato - dati salvati su server SSH');
    notifyListeners();
  }

  void stopTracking() {
    if (!_isTrackingActive) {
      return;
    }
    
    _isTrackingActive = false;
    _tcpSender?.disconnect();
    _tcpSender = null;
    debugPrint('⏹️ Tracking fermato');
    notifyListeners();
  }

  // ==================== WEBSOCKET & SENSORIA LOGIC ====================

  void _connectWebSocket() {
    if (_socket != null && _isSocketConnected) {
      debugPrint('✅ WebSocket già connesso');
      return;
    }

    debugPrint('🔌 Connessione WebSocket a $SERVER_URL...');
    _socket = IO.io(SERVER_URL, IO.OptionBuilder()
        .setTransports(['websocket'])
        .enableAutoConnect()
        .setReconnectionDelay(1000)
        .setReconnectionAttempts(5)
        .build());

    _socket!.onConnect((_) {
      debugPrint('✅ WebSocket CONNESSO');
      _isSocketConnected = true;
    });

    _socket!.onDisconnect((_) {
      debugPrint('❌ WebSocket DISCONNESSO');
      _isSocketConnected = false;
    });

    _socket!.onConnectError((error) {
      debugPrint('❌ WebSocket errore connessione: $error');
      _isSocketConnected = false;
    });

    _socket!.onError((error) {
      debugPrint('❌ WebSocket errore: $error');
    });
  }

  String _getProtocolForDevice(String deviceName, int packetLength) {
    final name = deviceName.toLowerCase();
    
    debugPrint('🔍 AUTO-DETECT PROTOCOLLO:');
    debugPrint('   Nome: "$deviceName"');
    debugPrint('   Lunghezza pacchetto: $packetLength byte');
    
    if (name.contains('ginocchio') || name.contains('core') || name.contains('knee')) {
      if (packetLength != 20) {
        debugPrint('   ⚠️ CORE dovrebbe avere 20 byte!');
      }
      debugPrint('   ✅ CORE → F20 (NO pressioni, IMU completo con mag)');
      return 'F20';
    }
    
    if (packetLength == 32) {
      debugPrint('   ✅ CALZINO → L32 (8 pressioni + IMU completo)');
      return 'L32';
    } else {
      debugPrint('   ✅ CALZINO → H20 (4 pressioni + IMU completo)');
      return 'H20';
    }
  }

  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    await startAllStreaming(
      {device.remoteId.toString(): device},
      {device.remoteId.toString(): deviceName},
    );
  }

  Future<void> startAllStreaming(
      Map<String, BluetoothDevice> connectedDevices,
      Map<String, String> deviceNames) async {
    if (connectedDevices.isEmpty) return;

    debugPrint('\n🚀 INIZIO STREAMING @${TARGET_HZ}Hz');
    debugPrint('📊 Dispositivi: ${connectedDevices.length}');
    debugPrint('🎯 Protocolli: F20 (Core) | H20/L32 (Calzini)');

    if (!_isSocketConnected) {
      _connectWebSocket();
      await Future.delayed(const Duration(seconds: 1));
    }

    for (var entry in connectedDevices.entries) {
      final deviceId = entry.key;
      final device = entry.value;
      final deviceName = deviceNames[deviceId] ?? 'Unknown';

      if (_activeStreams.containsKey(deviceId)) {
        debugPrint('⚠️ [$deviceName] Già in streaming, skip\n');
        continue;
      }

      try {
        final connectionState = await device.connectionState.first;
        if (connectionState != BluetoothConnectionState.connected) {
          debugPrint('❌ [$deviceName] Non connesso, skip\n');
          continue;
        }

        debugPrint('🔍 [$deviceName] Discovery servizi...');
        final services = await device.discoverServices();

        BluetoothCharacteristic? rxChar;
        for (var service in services) {
          for (var characteristic in service.characteristics) {
            final uuid = characteristic.uuid.toString().toLowerCase();

            if (uuid == '1cac0003-656e-696c-4b5f-6e6572726157' &&
                characteristic.properties.notify) {
              rxChar = characteristic;
              debugPrint('   ✅ TROVATO: 1cac0003 (Channel 0)');
              break;
            }
          }
          if (rxChar != null) break;
        }

        if (rxChar == null) {
          debugPrint('   ❌ Characteristic non trovata, skip\n');
          continue;
        }

        try {
          final mtu = await device.requestMtu(512);
          debugPrint('📶 [$deviceName] MTU: $mtu bytes');
        } catch (e) {
          debugPrint('⚠️ MTU request failed: $e');
        }

        await _setupStreaming(
          deviceId: deviceId,
          deviceName: deviceName,
          rxChar: rxChar,
          device: device,
        );
      } catch (e) {
        debugPrint('❌ [$deviceName] Errore: $e\n');
      }
    }

    debugPrint('🎉 Streaming attivo: ${_activeStreams.length}/${connectedDevices.length}');
    debugPrint('📊 Sensori tracciati: ${_latestData.keys.toList()}\n');
    notifyListeners();
  }

  Future<void> _setupStreaming({
    required String deviceId,
    required String deviceName,
    required BluetoothCharacteristic rxChar,
    required BluetoothDevice device,
  }) async {
    await rxChar.setNotifyValue(false);
    await Future.delayed(const Duration(milliseconds: 200));
    await rxChar.setNotifyValue(true);
    await Future.delayed(const Duration(milliseconds: 200));

    _packetCounts[deviceId] = 0;
    _latestData[deviceId] = {
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'sensor_name': deviceName
    };
    _lastSendTime[deviceId] = DateTime.now();

    bool protocolDetected = false;
    
    final subscription = rxChar.lastValueStream.listen(
      (value) {
        if (value.isEmpty) return;

        if (!protocolDetected) {
          final protocol = _getProtocolForDevice(deviceName, value.length);
          _deviceProtocols[deviceId] = protocol;
          protocolDetected = true;
          
          debugPrint('\n📡 [$deviceName] PROTOCOLLO FINALE: $protocol');
          debugPrint('   Lunghezza: ${value.length} byte');
          debugPrint('   Tipo: ${protocol == "F20" ? "CORE" : (protocol == "L32" ? "CALZINO (L32)" : "CALZINO (H20)")}');
          debugPrint('   Streaming attivo!\n');
        }

        final protocol = _deviceProtocols[deviceId]!;

        final expectedLength = protocol == 'L32' ? 32 : 20;
        if (value.length != expectedLength) {
          if (_packetCounts[deviceId]! % 50 == 0) {
            debugPrint('⚠️ [$deviceName] Pacchetto invalido: ${value.length} byte '
                '(atteso: $expectedLength per $protocol)');
          }
          return;
        }

        final parsed = parseSensoriaPacket(value, protocol: protocol);
        if (parsed.isEmpty) return;
        
        _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;

        final isCoreDevice = protocol == 'F20';

        Map<String, dynamic> dataToSend = {
          'timestamp': DateTime.now().toUtc().toIso8601String(),
          'sensor_name': deviceName,
          'accel_x': parsed['accel_x'],
          'accel_y': parsed['accel_y'],
          'accel_z': parsed['accel_z'],
          'gyro_x': parsed['gyro_x'],
          'gyro_y': parsed['gyro_y'],
          'gyro_z': parsed['gyro_z'],
          'mag_x': parsed['mag_x'],
          'mag_y': parsed['mag_y'],
          'mag_z': parsed['mag_z'],
        };

        if (!isCoreDevice) {
          for (int i = 0; i <= 7; i++) {
            final key = 'pressure_$i';
            if (parsed.containsKey(key)) {
              final value = parsed[key];
              if (value != null && value != 0.0) {
                dataToSend[key] = value;
              }
            }
          }
        }

        _latestData[deviceId] = dataToSend;
        _lastSendTime[deviceId] = DateTime.now();

        if (_packetCounts[deviceId]! % 100 == 0) {
          final pressureCount = dataToSend.keys.where((k) => k.startsWith('pressure_')).length;
          if (isCoreDevice) {
            debugPrint('   #${_packetCounts[deviceId]} [CORE-$protocol] | '
                'AX=${parsed['accel_x']?.toStringAsFixed(0)} '
                'GX=${parsed['gyro_x']?.toStringAsFixed(0)} '
                'MX=${parsed['mag_x']?.toStringAsFixed(0)}');
          } else {
            debugPrint('   #${_packetCounts[deviceId]} [SOCK-$protocol] | '
                'Pressioni: $pressureCount | '
                'P0=${parsed['pressure_0']?.toStringAsFixed(0)} '
                'AX=${parsed['accel_x']?.toStringAsFixed(0)} '
                'MX=${parsed['mag_x']?.toStringAsFixed(0)}');
          }
        }

        _sendData(deviceId, deviceName, dataToSend);
        notifyListeners();
      },
      onError: (error) {
        debugPrint('❌ [$deviceName] Stream error: $error');
        _cleanupStreaming(deviceId);
        notifyListeners();
      },
      onDone: () {
        debugPrint('⚠️ [$deviceName] Stream done');
        _cleanupStreaming(deviceId);
        notifyListeners();
      },
    );
    _activeStreams[deviceId] = subscription;
  }

  void _sendData(String deviceId, String deviceName, Map<String, dynamic> data) {
    if (_isTrackingActive && _tcpSender != null) {
      _tcpSender!.sendData(deviceName, data);
    }
  }

  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId);
    _lastSendTime.remove(deviceId);
    _deviceProtocols.remove(deviceId);
  }

  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    try {
      await _activeStreams[deviceId]?.cancel();
      _cleanupStreaming(deviceId);
      debugPrint('🛑 STOP STREAMING: $deviceId');
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Errore stoppando $deviceId: $e');
    }
  }

  Future<void> stopAll() async {
    debugPrint('\n🛑 STOP ALL STREAMS');
    for (var deviceId in _activeStreams.keys.toList()) {
      try {
        await _activeStreams[deviceId]?.cancel();
      } catch (e) {
        debugPrint('❌ Errore disabling notify per $deviceId: $e');
      }
    }
    _activeStreams.clear();
    _packetCounts.clear();
    _latestData.clear();
    _lastSendTime.clear();
    _deviceProtocols.clear();
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }

    // ==================== GPS LOGIC ====================
  
  /// Invia le coordinate GPS al server SSH
  void sendGpsData(double latitude, double longitude, double accuracy) {
    debugPrint("🌍 [GPS] sendGpsData chiamato: lat=$latitude, lon=$longitude, acc=$accuracy");
    
    // Verifica prerequisiti
    if (!_isTrackingActive) {
      debugPrint("⚠️ [GPS] Tracking non attivo, GPS non inviato");
      return;
    }
    
    if (_tcpSender == null) {
      debugPrint("⚠️ [GPS] _tcpSender è null");
      return;
    }
    
    if (!_tcpSender!.isConnected) {
      debugPrint("⚠️ [GPS] _tcpSender non è connesso al server");
      return;
    }
    
    final timestamp = DateTime.now().toUtc().toIso8601String();
    
    try {
      _tcpSender!.sendData("GPS", {
        "timestamp": timestamp,
        "sensor_name": "PHONE_GPS",
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy
      });
      
      debugPrint("✅ [GPS] Dati GPS inviati al server");
    } catch (e) {
      debugPrint("❌ [GPS] Errore invio: $e");
    }
  }

}

// ... parseSensoriaPacket rimane identico (omesso per brevità se non richiesto, ma includilo se copia-incolli tutto)
Map<String, double> parseSensoriaPacket(List<int> data, {String protocol = "F20"}) {
  // (Incolla qui la funzione parseSensoriaPacket dal file precedente per completezza)
  int b(int i) => data[i] & 0xFF;
  // ... (codice parsing invariato)
   if (protocol == "F20") {
    if (data.length != 20) return {};
    return {
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
    };
  } else if (protocol == "G20") {
      if (data.length != 20) return {};
      return {
        'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
        'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
        'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
        'pressure_3': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
        'pressure_4': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
        'pressure_5': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
        'pressure_6': (0x3FF & ((b(0) << 6) | ((b(1) & 0xC0) >> 2) | (b(4) & 0x0F))).toDouble(),
        'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
        'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
        'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
        'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
        'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
        'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
        'mag_x': 0.0, 'mag_y': 0.0, 'mag_z': 0.0,
      };
  } else if (protocol == "L32") {
    if (data.length != 32) return {};
    return {
      'pressure_0': (0x3FF & ((b(21) << 2) | (b(22) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(22) << 4) | (b(23) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(23) << 6) | (b(24) >> 2))).toDouble(),
      'pressure_3': (0x3FF & (((b(24) & 0x03) << 8) | b(25))).toDouble(),
      'pressure_4': (0x3FF & ((b(26) << 2) | (b(27) >> 6))).toDouble(),
      'pressure_5': (0x3FF & ((b(27) << 4) | (b(28) >> 4))).toDouble(),
      'pressure_6': (0x3FF & ((b(28) << 6) | (b(29) >> 2))).toDouble(),
      'pressure_7': (0x3FF & (((b(29) & 0x03) << 8) | b(30))).toDouble(),
      'accel_x': (b(3) | (b(4) << 8)).toDouble(),
      'accel_y': (b(5) | (b(6) << 8)).toDouble(),
      'accel_z': (b(7) | (b(8) << 8)).toDouble(),
      'gyro_x': (b(9) | (b(10) << 8)).toDouble(),
      'gyro_y': (b(11) | (b(12) << 8)).toDouble(),
      'gyro_z': (b(13) | (b(14) << 8)).toDouble(),
      'mag_x': (b(15) | (b(16) << 8)).toDouble(),
      'mag_y': (b(17) | (b(18) << 8)).toDouble(),
      'mag_z': (b(19) | (b(20) << 8)).toDouble(),
    };
  } else if (protocol == "H20" || protocol == "I20") {
      if (data.length != 20) return {};
      return {
        'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
        'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
        'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
        'pressure_3': (0x3FF & ((b(0) << 6) | (b(4) & 0x3F))).toDouble(),
        'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
        'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
        'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
        'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
        'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
        'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
        'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
        'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
        'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
      };
  }
  return {};
}
