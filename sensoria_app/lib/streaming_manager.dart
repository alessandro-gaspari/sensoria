import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ;

  // ⭐ STORAGE
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  final Map<String, BluetoothDevice> _connectedDevices = {};
  final Map<String, String> _deviceNames = {};

  // ⭐ CALLBACK
  Function(String, int, int, int)? onGyroDataReceived;

  // ⭐ STATE
  bool isConnected = false;
  bool isStreamingActive = false;
  bool isScanning = false;

  // ⭐ GETTER
  Map<String, bool> get streamingStatus =>
      Map.from(_activeStreams.map((key, _) => MapEntry(key, true)));

  // ⭐ INIT
  void setGyroDataCallback(Function(String, int, int, int) callback) {
    onGyroDataReceived = callback;
    debugPrint('✅ Callback registrato');
  }

  // ⭐ SCANNING
  Future<void> startScanning() async {
    isScanning = true;
    notifyListeners();
    debugPrint('🔍 Inizio scansione BLE...');

    try {
      FlutterBluePlus.startScan(timeout: const Duration(seconds: 5));
      await Future.delayed(const Duration(seconds: 5));

      final results = await FlutterBluePlus.lastScanResults;

      for (var result in results) {
        final name = result.device.advName;
        if (name.isNotEmpty) {
          final deviceId = result.device.remoteId.toString();
          _connectedDevices[deviceId] = result.device;
          _deviceNames[deviceId] = name;
          debugPrint('✅ Trovato: $name');
        }
      }

      await FlutterBluePlus.stopScan();
      isScanning = false;
      notifyListeners();
      debugPrint('✅ Scansione completata - ${_connectedDevices.length} dispositivi');
    } catch (e) {
      debugPrint('❌ Errore scansione: $e');
      isScanning = false;
      notifyListeners();
    }
  }

  // ⭐ SINGLE DEVICE STREAMING
  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    final deviceId = device.remoteId.toString();
    _connectedDevices[deviceId] = device;
    _deviceNames[deviceId] = deviceName;
    await connectToDevice(deviceId);
  }

  // ⭐ CONNECT SINGLE
  Future<void> connectToDevice(String deviceId) async {
    final device = _connectedDevices[deviceId];
    if (device == null) {
      debugPrint('❌ Dispositivo non trovato');
      return;
    }

    final name = _deviceNames[deviceId] ?? 'Unknown';
    debugPrint('🔗 Connessione a $name...');

    try {
      await device.connect(autoConnect: true);
      await _setupStreaming(deviceId: deviceId, deviceName: name);

      isConnected = true;
      notifyListeners();
      debugPrint('✅ Connesso a $name');
    } catch (e) {
      debugPrint('❌ Errore connessione: $e');
      isConnected = false;
      notifyListeners();
    }
  }

  // ⭐ CONNECT ALL
  Future<void> connectToAllDevices() async {
    debugPrint('🔗 Connessione a ${_connectedDevices.length} dispositivi...');

    for (var deviceId in _connectedDevices.keys) {
      await connectToDevice(deviceId);
      await Future.delayed(const Duration(milliseconds: 500));
    }

    isConnected = true;
    notifyListeners();
  }

  // ⭐ START ALL STREAMING
  Future<void> startAllStreaming(
    Map<String, BluetoothDevice> connectedDevices,
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;

    debugPrint('\n🚀 STREAMING MULTI-SENSORE @ 100Hz');
    debugPrint('📊 Dispositivi: ${connectedDevices.length}\n');

    int successCount = 0;

    for (var entry in connectedDevices.entries) {
      final deviceId = entry.key;
      final device = entry.value;
      final deviceName = deviceNames[deviceId] ?? 'Unknown';

      if (_activeStreams.containsKey(deviceId)) {
        debugPrint('⚠️ [$deviceName] Già in streaming');
        continue;
      }

      try {
        _connectedDevices[deviceId] = device;
        _deviceNames[deviceId] = deviceName;
        await _setupStreaming(deviceId: deviceId, deviceName: deviceName);
        successCount++;
      } catch (e) {
        debugPrint('❌ [$deviceName] Errore: $e');
      }
    }

    isStreamingActive = true;
    notifyListeners();
    debugPrint('✅ Streaming attivo per $successCount dispositivi');
  }

  // ⭐ SETUP STREAMING
  Future<void> _setupStreaming({
    required String deviceId,
    required String deviceName,
  }) async {
    final device = _connectedDevices[deviceId];
    if (device == null) {
      debugPrint('❌ [$deviceName] Dispositivo non trovato');
      return;
    }

    try {
      debugPrint('🔍 [$deviceName] Discovery servizi...');
      final services = await device.discoverServices();

      BluetoothCharacteristic? rxChar;

      for (var service in services) {
        for (var characteristic in service.characteristics) {
          final uuid = characteristic.uuid.toString().toLowerCase();
          if (uuid == '1cac0003-656e-696c-4b5f-6e6572726157' &&
              characteristic.properties.notify) {
            rxChar = characteristic;
            debugPrint('✅ [$deviceName] Trovato Channel 0');
            break;
          }
        }
        if (rxChar != null) break;
      }

      if (rxChar == null) {
        debugPrint('❌ [$deviceName] Channel non trovato');
        return;
      }

      await rxChar.setNotifyValue(true);
      await Future.delayed(const Duration(milliseconds: 200));

      _packetCounts[deviceId] = 0;
      _latestData[deviceId] = null;
      _Hz[deviceId] = 0;
      _lastSendTime[deviceId] = DateTime.now();

      _startSendTimer(deviceId, deviceName);

      final subscription = rxChar.lastValueStream.listen(
        (value) => _processIMUData(deviceId, deviceName, value),
        onError: (error) {
          debugPrint('❌ [$deviceName] Stream error: $error');
          _cleanupStreaming(deviceId);
        },
        onDone: () {
          debugPrint('⚠️ [$deviceName] Stream done');
          _cleanupStreaming(deviceId);
        },
      );

      _activeStreams[deviceId] = subscription;
      isStreamingActive = true;

      debugPrint('🟢 [$deviceName] STREAMING ATTIVO @ 100Hz');
      notifyListeners();

    } catch (e) {
      debugPrint('❌ [$deviceName] Setup error: $e');
    }
  }

  // ⭐ PROCESS IMU DATA
  void _processIMUData(String deviceId, String deviceName, List<int> value) {
    if (value.isEmpty) return;

    _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;

    if (value.length >= 20) {
      try {
        final data = _parseIMUData(value);
        _latestData[deviceId] = {
          'timestamp': DateTime.now().toIso8601String(),
          ...data,
        };

        final now = DateTime.now();
        final elapsed = now.difference(_lastSendTime[deviceId]!).inMilliseconds;
        if (elapsed > 0) {
          _Hz[deviceId] = (1000 ~/ elapsed);
        }
      } catch (e) {
        debugPrint('⚠️ [$deviceName] Parse error: $e');
      }
    }
  }

  // ⭐ PARSE IMU DATA
  Map<String, int> _parseIMUData(List<int> data) {
    if (data.length < 20) return {};

    int readInt16LE(int offset) {
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }

    return {
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

    // ⭐ CALLBACK APP
    if (onGyroDataReceived != null) {
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
      await http
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
    } catch (e) {
      // Silenzioso - continua se server offline
    }
  }

  // ⭐ CLEANUP
  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId);
    _sendTimers[deviceId]?.cancel();
    _sendTimers.remove(deviceId);
    _Hz.remove(deviceId);
    _lastSendTime.remove(deviceId);

    if (_activeStreams.isEmpty) {
      isStreamingActive = false;
    }
    notifyListeners();
  }

  // ⭐ STOP STREAMING
  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;

    try {
      await _activeStreams[deviceId]?.cancel();
      _cleanupStreaming(deviceId);
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Stop error: $e');
    }
  }

  // ⭐ DISCONNECT ALL
  Future<void> disconnectAll() async {
    debugPrint('🔌 Disconnessione da tutti...');

    for (var id in _activeStreams.keys.toList()) {
      await stopStreaming(id);
    }

    for (var device in _connectedDevices.values) {
      try {
        await device.disconnect();
      } catch (e) {
        debugPrint('⚠️ Disconnect error: $e');
      }
    }

    isConnected = false;
    isStreamingActive = false;
    _connectedDevices.clear();
    _deviceNames.clear();
    notifyListeners();
    debugPrint('✅ Disconnesso');
  }

  // ⭐ GETTERS
  List<String> getConnectedDevices() => _connectedDevices.keys.toList();
  String? getDeviceName(String deviceId) => _deviceNames[deviceId];
  bool isDeviceStreaming(String deviceId) => _activeStreams.containsKey(deviceId);

  @override
  void dispose() {
    disconnectAll();
    for (var timer in _sendTimers.values) {
      timer.cancel();
    }
    super.dispose();
  }
}
