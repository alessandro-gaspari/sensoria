import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ;

  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};

  Function(String, int, int, int)? onGyroDataReceived;

  bool isConnected = false;
  bool isStreamingActive = false;
  bool isScanning = false;

  void setGyroDataCallback(Function(String, int, int, int) callback) {
    onGyroDataReceived = callback;
    debugPrint('✅ Callback registrato');
  }

  // ⭐ SCANSIONE SENZA CONNESSIONE
  Future<void> startScanning() async {
    isScanning = true;
    notifyListeners();
    debugPrint('🔍 Inizio scansione BLE...');

    try {
      FlutterBluePlus.startScan(timeout: const Duration(seconds: 5));
      await Future.delayed(const Duration(seconds: 5));
      await FlutterBluePlus.stopScan();

      isScanning = false;
      notifyListeners();
      debugPrint('✅ Scansione completata');
    } catch (e) {
      debugPrint('❌ Errore scansione: $e');
      isScanning = false;
      notifyListeners();
    }
  }

  // ⭐ GET SCANNED DEVICES
  List<Map<String, String>> getScannedDevices() {
    try {
      final results = FlutterBluePlus.lastScanResults;
      return results
          .where((r) => r.device.advName.isNotEmpty)
          .map((r) => {
                'id': r.device.remoteId.toString(),
                'name': r.device.advName,
              })
          .toList();
    } catch (e) {
      debugPrint('❌ Errore get devices: $e');
      return [];
    }
  }

  // ⭐ CONNETTI A UN DEVICE
  Future<void> connectToDevice(String deviceId, String deviceName) async {
    debugPrint('🔗 Connessione a $deviceName...');

    try {
      // ⭐ Ottieni il device dalla scansione
      final results = FlutterBluePlus.lastScanResults;
      final device = results.firstWhere(
        (r) => r.device.remoteId.toString() == deviceId,
        orElse: () => throw Exception('Device non trovato'),
      ).device;

      // ⭐ Connetti senza autoConnect
      await device.connect(timeout: const Duration(seconds: 10));
      await Future.delayed(const Duration(milliseconds: 500));

      // ⭐ Setup streaming
      await _setupStreaming(device: device, deviceName: deviceName);

      isConnected = true;
      notifyListeners();
      debugPrint('✅ Connesso a $deviceName');
    } catch (e) {
      debugPrint('❌ Errore connessione: $e');
      isConnected = false;
      notifyListeners();
    }
  }

  // ⭐ SETUP STREAMING
  Future<void> _setupStreaming({
    required BluetoothDevice device,
    required String deviceName,
  }) async {
    final deviceId = device.remoteId.toString();

    try {
      debugPrint('🔍 [$deviceName] Discovery servizi...');
      final services = await device.discoverServices();
      debugPrint('🔍 [$deviceName] Trovati ${services.length} servizi');

      BluetoothCharacteristic? rxChar;

      for (var service in services) {
        debugPrint('  📋 Service: ${service.uuid}');

        for (var char in service.characteristics) {
          final uuid = char.uuid.toString().toLowerCase();
          debugPrint('    └─ Char: $uuid (notify: ${char.properties.notify})');

          if (char.properties.notify) {
            rxChar = char;
            debugPrint('✅ [$deviceName] Trovata: $uuid');
            break;
          }
        }
        if (rxChar != null) break;
      }

      if (rxChar == null) {
        debugPrint('❌ [$deviceName] Nessuna characteristic notify trovata');
        return;
      }

      await rxChar.setNotifyValue(true);
      await Future.delayed(const Duration(milliseconds: 300));

      _latestData[deviceId] = null;
      _Hz[deviceId] = 0;
      _lastSendTime[deviceId] = DateTime.now();

      _startSendTimer(deviceId, deviceName);

      final subscription = rxChar.lastValueStream.listen(
        (value) {
          debugPrint('🔊 [$deviceName] RAW: ${value.length}B - ${value.take(20).toList()}');
          _processIMUData(deviceId, deviceName, value);
        },
        onError: (error) {
          debugPrint('❌ [$deviceName] Stream ERROR: $error');
          _cleanupStreaming(deviceId);
        },
        onDone: () {
          debugPrint('⚠️ [$deviceName] Stream DONE');
          _cleanupStreaming(deviceId);
        },
      );

      _activeStreams[deviceId] = subscription;
      isStreamingActive = true;

      debugPrint('🟢 [$deviceName] STREAMING ATTIVO');
      notifyListeners();

    } catch (e) {
      debugPrint('❌ [$deviceName] Setup error: $e');
    }
  }

  // ⭐ PROCESS IMU DATA
  void _processIMUData(String deviceId, String deviceName, List<int> value) {
    if (value.isEmpty) return;

    if (value.length >= 20) {
      try {
        int readInt16LE(int offset) {
          int val = value[offset] | (value[offset + 1] << 8);
          return val > 32767 ? val - 65536 : val;
        }

        final data = {
          'timestamp': DateTime.now().toIso8601String(),
          'ax': readInt16LE(2),
          'ay': readInt16LE(4),
          'az': readInt16LE(6),
          'gx': readInt16LE(8),
          'gy': readInt16LE(10),
          'gz': readInt16LE(12),
          'mx': readInt16LE(14),
          'my': readInt16LE(16),
          'mz': readInt16LE(18),
        };

        _latestData[deviceId] = data;

        final now = DateTime.now();
        final elapsed = now.difference(_lastSendTime[deviceId]!).inMilliseconds;
        if (elapsed > 0) {
          _Hz[deviceId] = (1000 ~/ elapsed);
        }

        debugPrint('📦 [$deviceName] GX=${data['gx']} @ ${_Hz[deviceId]}Hz');

      } catch (e) {
        debugPrint('⚠️ [$deviceName] Parse error: $e');
      }
    }
  }

  // ⭐ SEND TIMER
  void _startSendTimer(String deviceId, String deviceName) {
    _sendTimers[deviceId]?.cancel();
    _sendTimers[deviceId] = Timer.periodic(
      Duration(milliseconds: INTERVAL_MS),
      (timer) => _sendData(deviceId, deviceName),
    );
  }

  // ⭐ SEND DATA
  Future<void> _sendData(String deviceId, String deviceName) async {
    final latestData = _latestData[deviceId];
    if (latestData == null) return;

    _latestData[deviceId] = null;

    // ⭐ CALLBACK
    if (onGyroDataReceived != null) {
      debugPrint('📡 [$deviceName] CALLBACK - GX=${latestData['gx']}');
      onGyroDataReceived!(
        deviceName,
        latestData['gx'] as int,
        latestData['gy'] as int,
        latestData['gz'] as int,
      );
    }

    // ⭐ SEND SERVER
    await _sendToServer(deviceName, latestData);
  }

  // ⭐ SEND TO SERVER
  Future<void> _sendToServer(String deviceName, Map<String, dynamic> data) async {
    try {
      debugPrint('📤 [$deviceName] INVIO: ${data['gx']}');

      final response = await http
          .post(
            Uri.parse(SERVER_URL),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'sensor_name': deviceName,
              'data': {
                'timestamp': data['timestamp'],
                'accel_x': data['ax'],
                'accel_y': data['ay'],
                'accel_z': data['az'],
                'gyro_x': data['gx'],
                'gyro_y': data['gy'],
                'gyro_z': data['gz'],
                'mag_x': data['mx'],
                'mag_y': data['my'],
                'mag_z': data['mz'],
              }
            }),
          )
          .timeout(const Duration(seconds: 1));

      debugPrint('✅ [$deviceName] INVIATO - ${response.statusCode}');

    } catch (e) {
      debugPrint('❌ [$deviceName] ERRORE INVIO: $e');
    }
  }

  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _sendTimers[deviceId]?.cancel();
    _sendTimers.remove(deviceId);
    _latestData.remove(deviceId);
    _Hz.remove(deviceId);
    _lastSendTime.remove(deviceId);

    if (_activeStreams.isEmpty) {
      isStreamingActive = false;
    }
    notifyListeners();
  }

  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    await _activeStreams[deviceId]?.cancel();
    _cleanupStreaming(deviceId);
  }

  Future<void> disconnectAll() async {
    debugPrint('🔌 Disconnessione...');
    for (var id in _activeStreams.keys.toList()) {
      await stopStreaming(id);
    }
    isConnected = false;
    isStreamingActive = false;
    notifyListeners();
  }

  @override
  void dispose() {
    disconnectAll();
    for (var timer in _sendTimers.values) {
      timer.cancel();
    }
    super.dispose();
  }
}
