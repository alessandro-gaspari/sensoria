import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 100;

  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>> _latestData = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, String> _deviceProtocols = {};

  IO.Socket? _socket;
  bool _isSocketConnected = false;

  bool get isStreaming => _activeStreams.isNotEmpty;
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);

  Map<String, bool> get streamingStatus =>
      Map.from(_activeStreams.map((key, value) => MapEntry(key, true)));
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  StreamingManager() {
    _connectWebSocket();
  }

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    stopAll();
    _socket?.disconnect();
    _socket?.dispose();
    super.dispose();
  }

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

  /// Auto-detect protocollo: F20 per Core, G20/L32 per Calzini
  String _getProtocolForDevice(String deviceName, int packetLength) {
    final name = deviceName.toLowerCase();
    
    debugPrint('🔍 AUTO-DETECT PROTOCOLLO:');
    debugPrint('   Nome: "$deviceName"');
    debugPrint('   Lunghezza pacchetto: $packetLength byte');
    
    // Core/Ginocchio → F20 (20 byte, NO pressioni, IMU completo)
    if (name.contains('ginocchio') || name.contains('core') || name.contains('knee')) {
      if (packetLength != 20) {
        debugPrint('   ⚠️ CORE dovrebbe avere 20 byte!');
      }
      debugPrint('   ✅ CORE → F20 (NO pressioni, IMU completo con mag)');
      return 'F20';
    }
    
    // Calzini → L32 (32 byte) o G20 (20 byte)
    if (packetLength == 32) {
      debugPrint('   ✅ CALZINO → L32 (8 pressioni + IMU completo)');
      return 'L32';
    } else {
      debugPrint('   ✅ CALZINO → G20 (7 pressioni, NO magnetometro)');
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
    debugPrint('🎯 Protocolli: F20 (Core) | G20/L32 (Calzini)');

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

        // Auto-detect protocollo dal primo pacchetto
        if (!protocolDetected) {
          final protocol = _getProtocolForDevice(deviceName, value.length);
          _deviceProtocols[deviceId] = protocol;
          protocolDetected = true;
          
          debugPrint('\n📡 [$deviceName] PROTOCOLLO FINALE: $protocol');
          debugPrint('   Lunghezza: ${value.length} byte');
          debugPrint('   Tipo: ${protocol == "F20" ? "CORE" : (protocol == "L32" ? "CALZINO (L32)" : "CALZINO (G20)")}');
          debugPrint('   Streaming attivo!\n');
        }

        final protocol = _deviceProtocols[deviceId]!;

        // Validazione lunghezza
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

        // Dati IMU (sempre presenti)
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

        // Pressioni SOLO per calzini (non per core)
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

        // Log debug ogni 100 pacchetti
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

        _sendDataViaWebSocket(deviceId, deviceName);
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

  void _sendDataViaWebSocket(String deviceId, String deviceName) {
    final latestData = _latestData[deviceId];
    if (latestData == null || latestData.isEmpty) return;

    if (_socket == null || !_isSocketConnected) {
      return;
    }

    try {
      _socket!.emit('sensor_data', {'sensor_name': deviceName, 'data': latestData});
    } catch (e) {
      debugPrint('❌ [$deviceName] WebSocket send error: $e');
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
}

/// ========================================
/// PARSING UFFICIALE (da codice Android Sensoria SDK)
/// ========================================
Map<String, double> parseSensoriaPacket(List<int> data, {String protocol = "F20"}) {
  int b(int i) => data[i] & 0xFF;

  // ========================================
  // F20: CORE (20 byte, 3 pressioni + IMU completo)
  // Basato su F20ProtocolCommand.java
  // ========================================
  if (protocol == "F20") {
    if (data.length != 20) {
      debugPrint('⚠️ F20 richiede 20 byte, ricevuto: ${data.length}');
      return {};
    }
    
    return {
      // 3 pressioni (channels 0-2)
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      
      // Accelerometro (10-bit)
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      
      // Giroscopio (10-bit)
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      
      // Magnetometro (10-bit) - F20 CE L'HA
      'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
    };
  }
  
  // ========================================
  // G20: CALZINI (20 byte, 7 pressioni, NO magnetometro)
  // Basato su G20ProtocolCommand.java
  // ========================================
  else if (protocol == "G20") {
    if (data.length != 20) {
      debugPrint('⚠️ G20 richiede 20 byte, ricevuto: ${data.length}');
      return {};
    }
    
    return {
      // 7 pressioni (channels 0-6)
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'pressure_3': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'pressure_4': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'pressure_5': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
      'pressure_6': (0x3FF & ((b(0) << 6) | ((b(1) & 0xC0) >> 2) | (b(4) & 0x0F))).toDouble(),
      
      // Accelerometro (10-bit)
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      
      // Giroscopio (10-bit)
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      
      // NO magnetometro in G20 (dal codice ufficiale)
      'mag_x': 0.0,
      'mag_y': 0.0,
      'mag_z': 0.0,
    };
  }
  
  // ========================================
  // L32: CALZINI NUOVI (32 byte, 8 pressioni + IMU completo)
  // Basato su L32ProtocolCommand.java
  // ========================================
  else if (protocol == "L32") {
    if (data.length != 32) {
      debugPrint('⚠️ L32 richiede 32 byte, ricevuto: ${data.length}');
      return {};
    }
    
    return {
      // 8 pressioni (channels 0-7) - 10-bit
      'pressure_0': (0x3FF & ((b(21) << 2) | (b(22) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(22) << 4) | (b(23) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(23) << 6) | (b(24) >> 2))).toDouble(),
      'pressure_3': (0x3FF & (((b(24) & 0x03) << 8) | b(25))).toDouble(),
      'pressure_4': (0x3FF & ((b(26) << 2) | (b(27) >> 6))).toDouble(),
      'pressure_5': (0x3FF & ((b(27) << 4) | (b(28) >> 4))).toDouble(),
      'pressure_6': (0x3FF & ((b(28) << 6) | (b(29) >> 2))).toDouble(),
      'pressure_7': (0x3FF & (((b(29) & 0x03) << 8) | b(30))).toDouble(),
      
      // Accelerometro (16-bit in L32)
      'accel_x': (b(3) | (b(4) << 8)).toDouble(),
      'accel_y': (b(5) | (b(6) << 8)).toDouble(),
      'accel_z': (b(7) | (b(8) << 8)).toDouble(),
      
      // Giroscopio (16-bit in L32)
      'gyro_x': (b(9) | (b(10) << 8)).toDouble(),
      'gyro_y': (b(11) | (b(12) << 8)).toDouble(),
      'gyro_z': (b(13) | (b(14) << 8)).toDouble(),
      
      // Magnetometro (16-bit in L32)
      'mag_x': (b(15) | (b(16) << 8)).toDouble(),
      'mag_y': (b(17) | (b(18) << 8)).toDouble(),
      'mag_z': (b(19) | (b(20) << 8)).toDouble(),
    };
  }

    // H20: CALZINI (20 byte, 4 pressioni + IMU completo con mag)
  else if (protocol == "H20" || protocol == "I20") {
    if (data.length != 20) return {};
    
    return {
      // 4 pressioni (channels 0-3)
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'pressure_3': (0x3FF & ((b(0) << 6) | (b(4) & 0x3F))).toDouble(),
      
      // Accelerometro
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      
      // Giroscopio
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      
      // Magnetometro (H20/I20 CE L'HANNO!)
      'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
    };
  }


  debugPrint('❌ Protocollo non supportato: $protocol');
  return {};
}
