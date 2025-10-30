import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  
  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);
  
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));

  /// Avvia streaming per un dispositivo
  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    await startAllStreaming(
      {device.remoteId.toString(): device},
      {device.remoteId.toString(): deviceName},
    );
  }
  
  /// Avvia streaming per TUTTI i dispositivi
  Future<void> startAllStreaming(
    Map<String, BluetoothDevice> connectedDevices,
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;
    
    debugPrint('\n🚀 INIZIO STREAMING MULTI-SENSORE');
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
        // Verifica connessione
        final connectionState = await device.connectionState.first;
        if (connectionState != BluetoothConnectionState.connected) {
          debugPrint('❌ [$deviceName] Non connesso\n');
          continue;
        }
        
        // Discovery servizi
        debugPrint('🔍 [$deviceName] Discovery servizi...');
        final services = await device.discoverServices();
        
        // Cerca RX: 1cac0003-656E-696C-4B5F-6E6572726157 (Channel 0)
        BluetoothCharacteristic? rxChar;
        for (var service in services) {
          for (var characteristic in service.characteristics) {
            final uuid = characteristic.uuid.toString().toLowerCase();
            
            // Target: 1cac0003 con notify
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
        
        // Setup streaming
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} sensori');
    debugPrint('📡 Stream attivi: ${_activeStreams.length}\n');
    notifyListeners();
  }
  
  /// Setup streaming
  Future<void> _setupStreaming({
    required String deviceId,
    required String deviceName,
    required BluetoothCharacteristic rxChar,
  }) async {
    try {
      // Abilita notifiche
      await rxChar.setNotifyValue(true);
      await Future.delayed(const Duration(milliseconds: 200));
      
      _packetCounts[deviceId] = 0;
      
      debugPrint('🎬 [$deviceName] Streaming avviato...');
      
      // Listener
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
          final packetNum = _packetCounts[deviceId]!;
          
          debugPrint('📦 [$deviceName] Pacchetto #$packetNum: ${value.length}B');
          
          // Stampa HEX
          final hexStr = value
              .map((b) => b.toRadixString(16).padLeft(2, '0').toUpperCase())
              .join(' ');
          debugPrint('   HEX: $hexStr');
          
          // Parse IMU (20 bytes)
          if (value.length >= 20) {
            try {
              final data = _parseIMUData(value);
              
              debugPrint(
                '   📊 Accel(${data['ax']},${data['ay']},${data['az']}) '
                'Gyro(${data['gx']},${data['gy']},${data['gz']}) '
                'Mag(${data['mx']},${data['my']},${data['mz']})'
              );
              
              _sendToServer(deviceName, data);
              
            } catch (e) {
              debugPrint('   ⚠️ Parse error: $e');
            }
          }
        },
        onError: (error) {
          debugPrint('❌ [$deviceName] Stream error: $error');
          _activeStreams.remove(deviceId);
          _packetCounts.remove(deviceId);
          notifyListeners();
        },
        onDone: () {
          debugPrint('⚠️ [$deviceName] Stream done');
          _activeStreams.remove(deviceId);
          _packetCounts.remove(deviceId);
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
  
  /// Parse IMU data (20 bytes)
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
  
  /// Invia al server
  Future<void> _sendToServer(String name, Map<String, int> data) async {
    try {
      await http.post(
        Uri.parse(SERVER_URL),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sensor_name': name,
          'timestamp': DateTime.now().toIso8601String(),
          'accel_x': data['ax'],
          'accel_y': data['ay'],
          'accel_z': data['az'],
          'gyro_x': data['gx'],
          'gyro_y': data['gy'],
          'gyro_z': data['gz'],
          'mag_x': data['mx'],
          'mag_y': data['my'],
          'mag_z': data['mz'],
        }),
      );
    } catch (e) {
      // Silent fail
    }
  }
  
  /// Stop streaming
  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    
    try {
      await _activeStreams[deviceId]?.cancel();
      _activeStreams.remove(deviceId);
      _packetCounts.remove(deviceId);
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Error: $e');
    }
  }
  
  /// Stop all
  Future<void> stopAll() async {
    for (var id in _activeStreams.keys.toList()) {
      await stopStreaming(id);
    }
  }
  
  @override
  void dispose() {
    stopAll();
    super.dispose();
  }
}
