import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'dart:convert';
import 'dart:async';
import 'dart:io';

class StreamingManager extends ChangeNotifier {
  // ⭐ SOCKET TCP (invece di HTTP POST)
  static const String SERVER_HOST = 'sensoria-dashboard.onrender.com';
  static const int SERVER_PORT = 9001;
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ; // 10ms
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);

  
  // ⭐ SOCKET CONNECTION
  Socket? _tcpSocket;
  bool _isServerConnected = false;
  StreamSubscription? _serverResponseSubscription;
  
  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);
    
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));

  /// ⭐ GETTER per TrackingScreen
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    stopAll();
    _disconnectFromServer();
    super.dispose();
  }

  /// ⭐ CONNESSIONE AL SERVER (una sola volta)
  Future<void> _connectToServer() async {
    if (_isServerConnected) {
      debugPrint('⚠️ Già connesso al server');
      return;
    }

    try {
      debugPrint('🔌 Connessione al server: $SERVER_HOST:$SERVER_PORT');
      
      _tcpSocket = await Socket.connect(SERVER_HOST, SERVER_PORT, timeout: const Duration(seconds: 5));
      _isServerConnected = true;
      
      debugPrint('✅ Connesso al server!');
      
      // Ascolta le risposte dal server
      _serverResponseSubscription = _tcpSocket!.listen(
        (data) {
          String response = utf8.decode(data).trim();
          debugPrint('📨 SERVER RESPONSE: $response');
        },
        onError: (error) {
          debugPrint('❌ Socket error: $error');
          _isServerConnected = false;
          _disconnectFromServer();
        },
        onDone: () {
          debugPrint('⚠️ Server disconnected');
          _isServerConnected = false;
        },
      );
      
    } catch (e) {
      debugPrint('❌ Errore connessione server: $e');
      _isServerConnected = false;
    }
  }

  Future<void> _disconnectFromServer() async {
    try {
      await _serverResponseSubscription?.cancel();
      await _tcpSocket?.close();
      _isServerConnected = false;
      _tcpSocket = null;
      debugPrint('✅ Disconnesso dal server');
    } catch (e) {
      debugPrint('❌ Errore disconnessione: $e');
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
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;
    
    // ⭐ CONNETTI AL SERVER UNA SOLA VOLTA
    await _connectToServer();
    
    debugPrint('\n🚀 INIZIO STREAMING MULTI-SENSORE @ ${TARGET_HZ}Hz');
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
              
              // ⭐ SALVA SOLO L'ULTIMO DATO
              _latestData[deviceId] = {
                'timestamp': DateTime.now().toUtc().toIso8601String(),
                ...data,
              };
              
              final now = DateTime.now();
              final elapsed = now.difference(_lastSendTime[deviceId]!).inMilliseconds;
              if (elapsed > 0) {
                _Hz[deviceId] = (1000 ~/ elapsed);
              }
              
              debugPrint(
                '📦 [$deviceName] #$packetNum @ ${_Hz[deviceId]} Hz | '
                'AX=${data['ax']}, AY=${data['ay']}, AZ=${data['az']} | '
                'GX=${data['gx']}, GY=${data['gy']}, GZ=${data['gz']} | '
                'MX=${data['mx']}, MY=${data['my']}, MZ=${data['mz']}'
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
      debugPrint('🟢 [$deviceName] STREAMING ATTIVO @ ${TARGET_HZ}Hz!\n');
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
  
  /// ⭐ INVIA DATI VIA SOCKET TCP (come Sensoria)
  Future<void> _sendData(String deviceId, String deviceName) async {
    final latestData = _latestData[deviceId];
    
    if (latestData == null || !_isServerConnected || _tcpSocket == null) {
      return;
    }
    
    // ⭐ AZZERA SUBITO PER EVITARE DUPLICATI
    _latestData[deviceId] = null;
    
    try {
      // ⭐ CREA JSON COME SENSORIA
      final jsonData = {
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
      };
      
      String jsonString = jsonEncode(jsonData) + '\n';
      
      // ⭐ INVIA VIA SOCKET
      _tcpSocket!.write(jsonString);
      await _tcpSocket!.flush();
      
      _lastSendTime[deviceId] = DateTime.now();
      
      debugPrint('📤 [$deviceName] Sent: $jsonString');
      
    } catch (e) {
      debugPrint('❌ [$deviceName] Send error: $e');
      _isServerConnected = false;
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
    _latestData.remove(deviceId);
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
    debugPrint('\n🛑 STOP ALL STREAMS');
    
    // Cancella tutti i timers PRIMA
    for (var timer in _sendTimers.values) {
      timer.cancel();
    }
    _sendTimers.clear();
    
    // Poi cancella tutti gli stream
    for (var id in _activeStreams.keys.toList()) {
      try {
        await _activeStreams[id]?.cancel();
      } catch (e) {
        debugPrint('❌ Error stopping $id: $e');
      }
    }
    
    // Pulisci tutto
    _activeStreams.clear();
    _packetCounts.clear();
    _latestData.clear();
    _Hz.clear();
    _lastSendTime.clear();
    
    // Disconnetti dal server
    await _disconnectFromServer();
    
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}
