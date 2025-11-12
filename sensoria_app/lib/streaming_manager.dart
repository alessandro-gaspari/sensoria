import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ;

  // Cambia qui: "G20" = solo pressione/IMU, "H20" = pressione+IMU+MAG
  String activeProtocol = "H20";       // <---- SWITCHA QUI "G20" <-> "H20"/"I20"

  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};

  IO.Socket? _socket;
  bool _isSocketConnected = false;

  bool get isStreaming => _activeStreams.isNotEmpty;
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);

  Map<String, bool> get streamingStatus =>
    Map.from(_activeStreams.map((key, value) => MapEntry(key, true)));
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);
  Iterable<String> get iterating => _latestData.keys;

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    _socket?.disconnect();
    _socket?.dispose();
    stopAll();
    super.dispose();
  }

  void _connectWebSocket() {
    if (_socket != null && _isSocketConnected) {
      debugPrint('✅ WebSocket già connesso');
      return;
    }
    debugPrint('🔌 Connessione WebSocket a $SERVER_URL...');
    _socket = IO.io(SERVER_URL,
        IO.OptionBuilder()
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

    _connectWebSocket();

    debugPrint('\n🚀 INIZIO STREAMING @${TARGET_HZ}Hz (protocollo $activeProtocol)');
    debugPrint('📊 Dispositivi: ${connectedDevices.length}');
    deviceNames.forEach((id, name) => debugPrint('   🔹 $name'));

    int successCount = 0;

    for (var entry in connectedDevices.entries) {
      final deviceId = entry.key;
      final device = entry.value;
      final deviceName = deviceNames[deviceId] ?? 'Unknown';

      if (_activeStreams.containsKey(deviceId)) {
        debugPrint('⚠️ [$deviceName] Già in streaming, skip\n');
        successCount++;
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

        await _setupStreaming(
          deviceId: deviceId,
          deviceName: deviceName,
          rxChar: rxChar,
        );

        successCount++;
      } catch (e) {
        debugPrint('❌ [$deviceName] Errore: $e\n');
      }
    }

    debugPrint(
        '🎉 Streaming attivo: $successCount/${connectedDevices.length} @ $TARGET_HZ Hz');
    debugPrint('📊 Sensori tracciati: ${_latestData.keys.toList()}\n');
    notifyListeners();
  }

  Future<void> _setupStreaming({
    required String deviceId,
    required String deviceName,
    required BluetoothCharacteristic rxChar,
  }) async {
    try {
      await rxChar.setNotifyValue(true);
      await Future.delayed(const Duration(milliseconds: 200));

      _packetCounts[deviceId] = 0;
      _latestData[deviceId] = {
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'sensor_name': deviceName,
      };
      _lastSendTime[deviceId] = DateTime.now();

      debugPrint('🎬 [$deviceName] Streaming attivo ($activeProtocol)');

      _startSendTimer(deviceId, deviceName);

      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty || value.length != 20) return;
          final parsed = parseSensoriaPacket(value, protocol: activeProtocol);
          _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
          final packetNum = _packetCounts[deviceId]!;

          _latestData[deviceId] = {
            'timestamp': DateTime.now().toUtc().toIso8601String(),
            'sensor_name': deviceName,
            ...parsed,
          };
          if (packetNum % 32 == 0) {
            debugPrint('   #$packetNum | P0=${parsed['pressure_0']} AX=${parsed['accel_x']} MX=${parsed['mag_x']}');
          }
          _lastSendTime[deviceId] = DateTime.now();
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
      debugPrint('🟢 [$deviceName] STREAMING RAW ATTIVO!\n');
      notifyListeners();
    } catch (e) {
      debugPrint('❌ [$deviceName] Setup error: $e');
      rethrow;
    }
  }

  void _startSendTimer(String deviceId, String deviceName) {
    _sendTimers[deviceId]?.cancel();
    _sendTimers[deviceId] = Timer.periodic(
      Duration(milliseconds: INTERVAL_MS),
      (timer) => _sendDataViaWebSocket(deviceId, deviceName),
    );
  }

  void _sendDataViaWebSocket(String deviceId, String deviceName) {
    final latestData = _latestData[deviceId];
    if (latestData == null || latestData.isEmpty) return;
    if (_socket == null || !_isSocketConnected) {
      _connectWebSocket();
      return;
    }
    try {
      _socket!.emit('sensor_data', {
        'sensor_name': deviceName,
        'data': latestData,
      });
    } catch (e) {
      debugPrint('❌ [$deviceName] WebSocket send error: $e');
    }
  }

  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId);
    _sendTimers[deviceId]?.cancel();
    _sendTimers.remove(deviceId);
    _lastSendTime.remove(deviceId);
  }

  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    try {
      await _activeStreams[deviceId]?.cancel();
      _cleanupStreaming(deviceId);
      debugPrint('🛑 STOP STREAMING: $deviceId');
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Error stopping $deviceId: $e');
    }
  }

  Future<void> stopAll() async {
    debugPrint('\n🛑 STOP ALL STREAMS');
    for (var timer in _sendTimers.values) timer.cancel();
    _sendTimers.clear();
    for (var id in _activeStreams.keys.toList()) {
      try { await _activeStreams[id]?.cancel(); } catch (e) {}
    }
    _activeStreams.clear();
    _packetCounts.clear();
    _latestData.clear();
    _lastSendTime.clear();
    _socket?.disconnect();
    _isSocketConnected = false;
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}

// UNIVERSAL PARSER (H20/I20 con magnetometro se richiesto)
Map<String, double> parseSensoriaPacket(List<int> data, {String protocol = "G20"}) {
  int b(int i) => data[i] & 0xFF;

  if (protocol == "H20" || protocol == "I20") {
    return {
      // Pressione channels [0-3]
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'pressure_3': (0x3FF & ((b(0) << 6) | (b(4) & 63))).toDouble(),
      'pressure_4': 0.0,
      'pressure_5': 0.0,
      'pressure_6': 0.0,
      'pressure_7': 0.0,
      // IMU
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      // Magnetometro RAW 10bit packed
      'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
    };
  } else {
    // Default G20: solo pressione/IMU, mag = 0
    var pressures = {
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'pressure_3': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'pressure_4': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'pressure_5': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
      'pressure_6': (0x3FF & ((b(0) << 6) | ((b(1) & 0xC0) >> 2) | (b(4) & 0x0F))).toDouble(),
      'pressure_7': 0.0,
    };
    var accel0 = 0x3FF & ((b(12) << 6) | (b(13) >> 2));
    var accel1 = 0x3FF & ((b(13) << 8) | b(14));
    var accel2 = 0x3FF & ((b(15) << 2) | (b(16) >> 6));
    var gyro0  = 0x3FF & ((b(16) << 4) | (b(17) >> 4));
    var gyro1  = 0x3FF & ((b(17) << 6) | (b(18) >> 2));
    var gyro2  = 0x3FF & ((b(18) << 8) | b(19));
    return {
      ...pressures,
      'accel_x': accel0.toDouble(),
      'accel_y': accel1.toDouble(),
      'accel_z': accel2.toDouble(),
      'gyro_x': gyro0.toDouble(),
      'gyro_y': gyro1.toDouble(),
      'gyro_z': gyro2.toDouble(),
      'mag_x': 0.0,
      'mag_y': 0.0,
      'mag_z': 0.0,
    };
  }
}
