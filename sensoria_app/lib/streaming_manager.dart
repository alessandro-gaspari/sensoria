import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';
import 'package:sensoria_cs/utils/sensor_filter.dart';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ; // 10ms
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  
  // ⭐ FILTRI EMA
  final Map<String, SensorFilter> _sensorFilters = {};
  
  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));

  /// ⭐ GETTER per TrackingScreen
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    stopAll();
    super.dispose();
  }

  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    await startAllStreaming(
      {device.remoteId.toString(): device},
      {device.remoteId.toString(): deviceName},
    );
  }
  
  Future<void> startAllStreaming(
    Map<String, BluetoothDevice> connectedDevices,
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;
    
    debugPrint('\n🚀 INIZIO STREAMING MULTI-SENSORE @ ${TARGET_HZ}Hz');
    debugPrint('📊 Dispositivi: ${connectedDevices.length}');
    debugPrint('🌐 Server: $SERVER_URL');
    debugPrint('🔧 Filtro EMA: alpha=0.12\n');
    
    int successCount = 0;
    
    for (var entry in connectedDevices.entries) {
      final deviceId = entry.key;
      final device = entry.value;
      final deviceName = deviceNames[deviceId] ?? 'Unknown';
      
      if (_activeStreams.containsKey(deviceId)) {
        debugPrint('⚠️ [$deviceName] Già in streaming\n');
        continue;
      }
      
      try {
        final connectionState = await device.connectionState.first;
        if (connectionState != BluetoothConnectionState.connected) {
          debugPrint('❌ [$deviceName] Non connesso\n');
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
          debugPrint('   ❌ Channel 0 non trovato\n');
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} sensori @ ${TARGET_HZ}Hz');
    debugPrint('📡 Stream attivi: ${_activeStreams.length}\n');
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
      _latestData[deviceId] = null;
      _Hz[deviceId] = 0;
      _lastSendTime[deviceId] = DateTime.now();
      
      // ⭐ CREA IL FILTRO PER QUESTO SENSORE
      _sensorFilters[deviceId] = SensorFilter(alpha: 0.12);
      
      debugPrint('🎬 [$deviceName] Streaming @ ${TARGET_HZ}Hz (${INTERVAL_MS}ms interval)');
      debugPrint('🔧 [$deviceName] Filtro EMA inizializzato');
      
      _startSendTimer(deviceId, deviceName);
      
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
          final packetNum = _packetCounts[deviceId]!;
          
          if (value.length >= 20) {
            try {
              // ⭐ PARSE E FILTRA I DATI CON EMA
              final data = _parseAndFilterIMUData(value, deviceId);
              
              _latestData[deviceId] = {
                'timestamp': DateTime.now().toUtc().toIso8601String(),
                'sensor_name': deviceName,
                ...data,
              };
              
              final now = DateTime.now();
              final elapsed = now.difference(_lastSendTime[deviceId]!).inMilliseconds;
              if (elapsed > 0) {
                _Hz[deviceId] = (1000 ~/ elapsed);
              }
              
              debugPrint(
                '📦 [$deviceName] #$packetNum @ ${_Hz[deviceId]} Hz | '
                'AX=${data['accel_x']?.toStringAsFixed(4)}, '
                'AY=${data['accel_y']?.toStringAsFixed(4)}, '
                'AZ=${data['accel_z']?.toStringAsFixed(4)}'
              );
              
              // ⭐ NOTIFICA I LISTENER (UI si aggiorna @ 100Hz)
              notifyListeners();
              
            } catch (e) {
              debugPrint('   ⚠️ Parse error: $e');
            }
          }
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
      debugPrint('🟢 [$deviceName] STREAMING ATTIVO!\n');
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
      (timer) {
        _sendData(deviceId, deviceName);
      },
    );
  }
  
  /// ⭐ PARSE, FILTRA CON EMA E INVIA DATI VIA HTTP POST
  Future<void> _sendData(String deviceId, String deviceName) async {
    final latestData = _latestData[deviceId];
    
    if (latestData == null) {
      return;
    }
    
    try {
      final jsonData = {
        'sensor_name': deviceName,
        'data': {
          'timestamp': latestData['timestamp'],
          'accel_x': latestData['accel_x'],
          'accel_y': latestData['accel_y'],
          'accel_z': latestData['accel_z'],
          'gyro_x': latestData['gyro_x'],
          'gyro_y': latestData['gyro_y'],
          'gyro_z': latestData['gyro_z'],
          'mag_x': latestData['mag_x'],
          'mag_y': latestData['mag_y'],
          'mag_z': latestData['mag_z'],
        }
      };
      
      final response = await http.post(
        Uri.parse(SERVER_URL),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode(jsonData),
      ).timeout(
        const Duration(seconds: 5),
        onTimeout: () => http.Response('timeout', 408),
      );
      
      if (response.statusCode == 200) {
        debugPrint('✅ [$deviceName] Data sent successfully');
      } else {
        debugPrint('⚠️ [$deviceName] Response: ${response.statusCode}');
      }
      
      _lastSendTime[deviceId] = DateTime.now();
      
    } catch (e) {
      debugPrint('❌ [$deviceName] Send error: $e');
    }
  }
  
  /// ⭐ PARSE RAW E FILTRA CON EMA
  Map<String, double> _parseAndFilterIMUData(
    List<int> data,
    String deviceId,
  ) {
    if (data.length < 20) return {};
    
    int readInt16LE(int offset) {
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }
    
    // ⭐ LEGGI RAW
    final rawAccelX = readInt16LE(2);
    final rawAccelY = readInt16LE(4);
    final rawAccelZ = readInt16LE(6);
    final rawGyroX = readInt16LE(8);
    final rawGyroY = readInt16LE(10);
    final rawGyroZ = readInt16LE(12);
    final rawMagX = readInt16LE(14);
    final rawMagY = readInt16LE(16);
    final rawMagZ = readInt16LE(18);
    
    // ⭐ FILTRA CON EMA (il filtro è già creato in _setupStreaming)
    final filter = _sensorFilters[deviceId];
    if (filter == null) {
      debugPrint('⚠️ Filtro non trovato per $deviceId');
      return {};
    }
    
    return filter.filterIMUData(
      rawAccelX: rawAccelX,
      rawAccelY: rawAccelY,
      rawAccelZ: rawAccelZ,
      rawGyroX: rawGyroX,
      rawGyroY: rawGyroY,
      rawGyroZ: rawGyroZ,
      rawMagX: rawMagX,
      rawMagY: rawMagY,
      rawMagZ: rawMagZ,
    );
  }
  
  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId);
    _sendTimers[deviceId]?.cancel();
    _sendTimers.remove(deviceId);
    _Hz.remove(deviceId);
    _lastSendTime.remove(deviceId);
    _sensorFilters.remove(deviceId);
  }
  
  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    
    try {
      await _activeStreams[deviceId]?.cancel();
      _cleanupStreaming(deviceId);
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Error: $e');
    }
  }
  
  Future<void> stopAll() async {
    debugPrint('\n🛑 STOP ALL STREAMS');
    
    for (var timer in _sendTimers.values) {
      timer.cancel();
    }
    _sendTimers.clear();
    
    for (var id in _activeStreams.keys.toList()) {
      try {
        await _activeStreams[id]?.cancel();
      } catch (e) {
        debugPrint('❌ Error stopping $id: $e');
      }
    }
    
    _activeStreams.clear();
    _packetCounts.clear();
    _latestData.clear();
    _Hz.clear();
    _lastSendTime.clear();
    _sensorFilters.clear();
    
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}
