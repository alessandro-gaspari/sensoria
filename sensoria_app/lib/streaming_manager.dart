import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 100;
  static const int INTERVAL_MS = 1000 ~/ TARGET_HZ;
  
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  
  IO.Socket? _socket;
  bool _isSocketConnected = false;
  
  bool get isStreaming => _activeStreams.isNotEmpty;
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  
  Map<String, bool> get streamingStatus => Map.from(
    _activeStreams.map((key, value) => MapEntry(key, true)),
  );

  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

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
    
    _connectWebSocket();
    
    debugPrint('\n🚀 INIZIO STREAMING RAW @ ${TARGET_HZ}Hz via WebSocket');
    debugPrint('📊 Dispositivi da connettere: ${connectedDevices.length}');
    deviceNames.forEach((id, name) => debugPrint('   🔹 $name'));
    debugPrint('⚠️ MODALITÀ RAW: ZERO FILTRI, ZERO CONVERSIONI\n');
    
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} @ ${TARGET_HZ}Hz RAW');
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
      
      debugPrint('🎬 [$deviceName] Streaming RAW @ ${TARGET_HZ}Hz');
      
      _startSendTimer(deviceId, deviceName);
      
      int packetCounter = 0;
      List<int>? imuBuffer;
      Map<String, double> pressureData = {};
      
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          // ⭐ CALZINI: Header 0xF0 0x10, protocollo ciclico 3-pacchetti
          if (value.length == 20 && value[0] == 0xF0 && value[1] == 0x10) {
            packetCounter++;
            
            if (packetCounter <= 10) {
              debugPrint('🔵 [$deviceName] CALZINO Pkt #$packetCounter (tipo ${packetCounter % 3})');
            }
            
            if (packetCounter % 3 == 1) {
              imuBuffer = List.from(value);
              pressureData = {};
            }
            
            else if (packetCounter % 3 == 2 && imuBuffer != null) {
              for (int i = 0; i < 8; i++) {
                int offset = 2 + (i * 2);
                if (offset + 1 < value.length) {
                  final val = value[offset] | (value[offset + 1] << 8);
                  final pressure = val > 32767 ? val - 65536 : val;
                  pressureData['pressure_$i'] = pressure.toDouble();
                }
              }
            }
            
            else if (packetCounter % 3 == 0 && imuBuffer != null) {
              _processCompletePacket(imuBuffer!, pressureData, deviceId, deviceName);
              imuBuffer = null;
            }
          }
          
          // ⭐ SENSORIA CORE: Header 0x2A 0x59, pacchetto singolo
          else if (value.length == 20 && value[0] == 0x2A && value[1] == 0x59) {
            packetCounter++;
            
            if (packetCounter <= 10) {
              debugPrint('🟣 [$deviceName] SENSORIA CORE Pkt #$packetCounter');
            }
            
            _processSensoriaCorePacket(value, deviceId, deviceName);
          }
          
          // ⭐ HEADER SCONOSCIUTO
          else {
            if (packetCounter <= 5) {
              debugPrint('❓ [$deviceName] Header: 0x${value[0].toRadixString(16)} 0x${value[1].toRadixString(16)}');
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
      debugPrint('🟢 [$deviceName] STREAMING RAW ATTIVO!\n');
      notifyListeners();
      
    } catch (e) {
      debugPrint('❌ [$deviceName] Setup error: $e');
      rethrow;
    }
  }
  
  // ⭐ PROCESSA PACCHETTO COMPLETO (CALZINI)
  void _processCompletePacket(
    List<int> imuData,
    Map<String, double> pressureData,
    String deviceId,
    String deviceName,
  ) {
    _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
    final packetNum = _packetCounts[deviceId]!;
    
    try {
      final rawData = _parseRawIMUData(imuData);
      rawData.addAll(pressureData);
      
      _latestData[deviceId] = {
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'sensor_name': deviceName,
        ...rawData,
      };
      
      if (packetNum % 50 == 0) {
        debugPrint('📦 [$deviceName] #$packetNum | AX=${rawData['accel_x']?.toInt()}, P0=${pressureData['pressure_0']?.toInt()}');
        debugPrint('📊 MANAGER: ${_latestData.length} sensori tracciati');
      }
      
      _lastSendTime[deviceId] = DateTime.now();
      notifyListeners();
      
    } catch (e) {
      debugPrint('   ⚠️ Parse error: $e');
    }
  }
  
  // ⭐ PROCESSA PACCHETTO SENSORIA CORE (SINGOLO)
  void _processSensoriaCorePacket(
    List<int> data,
    String deviceId,
    String deviceName,
  ) {
    _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
    final packetNum = _packetCounts[deviceId]!;
    
    try {
      final rawData = _parseSensoriaCoreIMU(data);
      
      _latestData[deviceId] = {
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'sensor_name': deviceName,
        ...rawData,
      };
      
      if (packetNum % 50 == 0) {
        debugPrint('📦 [$deviceName] #$packetNum | AX=${rawData['accel_x']?.toInt()}, GX=${rawData['gyro_x']?.toInt()}');
        debugPrint('📊 MANAGER: ${_latestData.length} sensori tracciati');
      }
      
      _lastSendTime[deviceId] = DateTime.now();
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
  
  // ⭐ PARSING IMU CALZINI
  Map<String, double> _parseRawIMUData(List<int> data) {
    if (data.length < 20) return {};
    
    int readInt16LE(int offset) {
      if (offset + 1 >= data.length) return 0;
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }
    
    return {
      'accel_x': readInt16LE(4).toDouble(),
      'accel_y': readInt16LE(6).toDouble(),
      'accel_z': readInt16LE(8).toDouble(),
      'gyro_x': readInt16LE(10).toDouble(),
      'gyro_y': readInt16LE(12).toDouble(),
      'gyro_z': readInt16LE(14).toDouble(),
      'mag_x': readInt16LE(16).toDouble(),
      'mag_y': readInt16LE(18).toDouble(),
      'mag_z': 0.0,
    };
  }
  
  // ⭐ PARSING IMU SENSORIA CORE
  Map<String, double> _parseSensoriaCoreIMU(List<int> data) {
    if (data.length < 20) return {};
    
    int readInt16LE(int offset) {
      if (offset + 1 >= data.length) return 0;
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }
    
    // ⭐ OFFSET DA VERIFICARE (provo con gli stessi dei calzini)
    return {
      'accel_x': readInt16LE(4).toDouble(),
      'accel_y': readInt16LE(6).toDouble(),
      'accel_z': readInt16LE(8).toDouble(),
      'gyro_x': readInt16LE(10).toDouble(),
      'gyro_y': readInt16LE(12).toDouble(),
      'gyro_z': readInt16LE(14).toDouble(),
      'mag_x': readInt16LE(16).toDouble(),
      'mag_y': readInt16LE(18).toDouble(),
      'mag_z': 0.0,
    };
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
    _lastSendTime.clear();
    
    _socket?.disconnect();
    _isSocketConnected = false;
    
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}
