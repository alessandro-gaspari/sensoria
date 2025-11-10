import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:async';
import 'package:sensoria_cs/utils/sensor_filter.dart';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 50;  // ⭐ 50 Hz ottimale con WebSocket
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ;
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  final Map<String, SensorFilter> _sensorFilters = {};
  
  IO.Socket? _socket;  // ⭐ WebSocket connection
  bool _isSocketConnected = false;
  
  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));

  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    _socket?.disconnect();
    _socket?.dispose();
    stopAll();
    super.dispose();
  }

  // ⭐ CONNETTI WEBSOCKET
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
        .build()
    );
    
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
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;
    
    // ⭐ CONNETTI WEBSOCKET PRIMA DI INIZIARE
    _connectWebSocket();
    
    debugPrint('\n🚀 INIZIO STREAMING @ ${TARGET_HZ}Hz via WebSocket');
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} @ ${TARGET_HZ}Hz');
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
      _sensorFilters[deviceId] = SensorFilter(alpha: 0.12);
      
      debugPrint('🎬 [$deviceName] Streaming @ ${TARGET_HZ}Hz');
      
      _startSendTimer(deviceId, deviceName);
      
      final nameLower = deviceName.toLowerCase();
      final isSocks = nameLower.contains('calzin') || 
                      nameLower.contains('sock') || 
                      nameLower.contains('piede') || 
                      nameLower.contains('foot');
      
      int packetCounter = 0;
      List<int>? imuBuffer;
      Map<String, double> pressureData = {};
      
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          if (value.length == 20 && value[0] == 0xF0 && value[1] == 0x10) {
            packetCounter++;
            
            if (packetCounter % 3 == 1) {
              imuBuffer = List.from(value);
              pressureData = {};
            }
            else if (packetCounter % 3 == 2 && imuBuffer != null) {
              for (int i = 2; i < 20; i += 2) {
                final idx = (i - 2) ~/ 2 + 1;
                final val = value[i] | (value[i + 1] << 8);
                final pressure = val > 32767 ? val - 65536 : val;
                pressureData['pressure_$idx'] = pressure.toDouble();
              }
            }
            else if (packetCounter % 3 == 0 && imuBuffer != null) {
              _processCompletePacket(imuBuffer!, pressureData, deviceId, deviceName);
              imuBuffer = null;
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
  
  void _processCompletePacket(
    List<int> imuData,
    Map<String, double> pressureData,
    String deviceId,
    String deviceName,
  ) {
    _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
    final packetNum = _packetCounts[deviceId]!;
    
    try {
      final parsedData = _parseAndFilterIMUData(imuData, deviceId, deviceName);
      parsedData.addAll(pressureData);
      
      _latestData[deviceId] = {
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'sensor_name': deviceName,
        ...parsedData,
      };
      
      final now = DateTime.now();
      final lastSend = _lastSendTime[deviceId];
      if (lastSend != null) {
        final elapsed = now.difference(lastSend).inMilliseconds;
        if (elapsed > 0) {
          _Hz[deviceId] = (1000 ~/ elapsed);
        }
      }
      
      if (packetNum % 100 == 0) {
        debugPrint(
          '📦 [$deviceName] #$packetNum @ ${_Hz[deviceId]} Hz | '
          'AX=${parsedData['accel_x']?.toStringAsFixed(4)}'
        );
      }
      
      notifyListeners();
      
    } catch (e) {
      debugPrint('   ⚠️ Parse error: $e');
    }
  }
  
  void _startSendTimer(String deviceId, String deviceName) {
    _sendTimers[deviceId]?.cancel();
    
    _sendTimers[deviceId] = Timer.periodic(
      Duration(milliseconds: INTERVAL_MS),
      (timer) {
        _sendDataViaWebSocket(deviceId, deviceName);
      },
    );
  }
  
  // ⭐ INVIA DATI VIA WEBSOCKET
  void _sendDataViaWebSocket(String deviceId, String deviceName) {
    final latestData = _latestData[deviceId];
    
    if (latestData == null) return;
    
    if (_socket == null || !_isSocketConnected) {
      debugPrint('⚠️ WebSocket non connesso, riconnetto...');
      _connectWebSocket();
      return;
    }
    
    try {
      // ⭐ EMIT via WebSocket (molto più veloce di HTTP POST)
      _socket!.emit('sensor_data', {
        'sensor_name': deviceName,
        'data': latestData,
      });
      
      _lastSendTime[deviceId] = DateTime.now();
      
    } catch (e) {
      debugPrint('❌ [$deviceName] WebSocket send error: $e');
    }
  }
  
  Map<String, double> _parseAndFilterIMUData(
    List<int> data,
    String deviceId,
    String deviceName,
  ) {
    if (data.length < 20) return {};
    
    int readInt16LE(int offset) {
      if (offset + 1 >= data.length) return 0;
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }
    
    final rawAccelX = readInt16LE(2);
    final rawAccelY = readInt16LE(4);
    final rawAccelZ = readInt16LE(6);
    final rawGyroX = readInt16LE(8);
    final rawGyroY = readInt16LE(10);
    final rawGyroZ = readInt16LE(12);
    final rawMagX = readInt16LE(14);
    final rawMagY = readInt16LE(16);
    final rawMagZ = readInt16LE(18);
    
    final filter = _sensorFilters[deviceId];
    if (filter == null) return {};
    
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
    
    // ⭐ DISCONNETTI WEBSOCKET
    _socket?.disconnect();
    _isSocketConnected = false;
    
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}
