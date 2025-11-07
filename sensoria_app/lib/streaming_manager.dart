import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ; // 10ms per 100Hz
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>?> _latestData = {}; // ⭐ CAMBIAMENTO: Map singolo, no buffer
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);
  
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));

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
    
    debugPrint('\n🚀 INIZIO STREAMING MULTI-SENSORE @ 100Hz');
    debugPrint('📊 Dispositivi: ${connectedDevices.length}\n');
    
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} sensori @ 100Hz');
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
      _latestData[deviceId] = null; // ⭐ CAMBIAMENTO: Nessun buffer
      _Hz[deviceId] = 0;
      _lastSendTime[deviceId] = DateTime.now();
      
      debugPrint('🎬 [$deviceName] Streaming @ ${TARGET_HZ}Hz (${INTERVAL_MS}ms interval)');
      
      _startSendTimer(deviceId, deviceName);
      
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
          final packetNum = _packetCounts[deviceId]!;
          
          if (value.length >= 20) {
            try {
              final data = _parseIMUData(value);
              
              // ⭐ CAMBIAMENTO: Salva SOLO l'ultimo dato
              _latestData[deviceId] = {
                'timestamp': DateTime.now().toIso8601String(),
                ...data,
              };
              
              final now = DateTime.now();
              final elapsed = now.difference(_lastSendTime[deviceId]!).inMilliseconds;
              if (elapsed > 0) {
                _Hz[deviceId] = (1000 ~/ elapsed);
              }
              
              debugPrint(
                '📦 [$deviceName] #$packetNum @ ${_Hz[deviceId]} Hz | '
                'Accel(${data['ax']},${data['ay']},${data['az']}) '
                'Gyro(${data['gx']},${data['gy']},${data['gz']}) '
                'Mag(${data['mx']},${data['my']},${data['mz']})'
              );
              
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
      debugPrint('🟢 [$deviceName] STREAMING ATTIVO @ 100Hz!\n');
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
        _sendData(deviceId, deviceName); // ⭐ CAMBIAMENTO: Chiama _sendData
      },
    );
  }
  
  // ⭐ CAMBIAMENTO PRINCIPALE: Invia SOLO l'ultimo dato disponibile
  Future<void> _sendData(String deviceId, String deviceName) async {
    final latestData = _latestData[deviceId];
    
    // Se non ci sono dati nuovi, non inviare nulla
    if (latestData == null) return;
    
    // ⭐ IMPORTANTE: Azzera subito per evitare duplicati
    _latestData[deviceId] = null;
    
    try {
      await http.post(
        Uri.parse(SERVER_URL),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sensor_name': deviceName,
          'timestamp': latestData['timestamp'],
          'accel_x': latestData['ax'],
          'accel_y': latestData['ay'],
          'accel_z': latestData['az'],
          'gyro_x': latestData['gx'],
          'gyro_y': latestData['gy'],
          'gyro_z': latestData['gz'],
          'mag_x': latestData['mx'],
          'mag_y': latestData['my'],
          'mag_z': latestData['mz'],
        }),
      );
      
      _lastSendTime[deviceId] = DateTime.now();
      
    } catch (e) {
      debugPrint('⚠️ [$deviceName] Send error: $e');
    }
  }
  
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
  
  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId); // ⭐ CAMBIAMENTO: Rimuove _latestData
    _sendTimers[deviceId]?.cancel();
    _sendTimers.remove(deviceId);
    _Hz.remove(deviceId);
    _lastSendTime.remove(deviceId);
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
    for (var id in _activeStreams.keys.toList()) {
      await stopStreaming(id);
    }
  }
  
  @override
  void dispose() {
    stopAll();
    for (var timer in _sendTimers.values) {
      timer.cancel();
    }
    super.dispose();
  }
  // Dopo il metodo _parseIMUData, aggiungi:

void debugStreamingStatus() {
  debugPrint('\n📋 === STREAMING DEBUG ===');
  debugPrint('   Active streams: ${_activeStreams.length}');
  debugPrint('   Latest data keys: ${_latestData.keys}');
  for (var entry in _latestData.entries) {
    debugPrint('   📊 ${entry.key}: ${entry.value}');
  }
  debugPrint('=========================\n');
}

}
