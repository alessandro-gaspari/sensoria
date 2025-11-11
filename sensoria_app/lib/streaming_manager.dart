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
  final Map<String, Map<String, dynamic>?> _latestData = {};
  final Map<String, Timer> _sendTimers = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, int> _Hz = {};
  
  IO.Socket? _socket;
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
    debugPrint('📊 Dispositivi: ${connectedDevices.length}');
    debugPrint('⚠️ MODALITÀ RAW: ZERO FILTRI, ZERO CONVERSIONI\n');
    
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
    
    debugPrint('🎉 Streaming attivo: $successCount/${connectedDevices.length} @ ${TARGET_HZ}Hz RAW\n');
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
      
      debugPrint('🎬 [$deviceName] Streaming RAW @ ${TARGET_HZ}Hz');
      
      _startSendTimer(deviceId, deviceName);
      
      int packetCounter = 0;
      List<int>? imuBuffer;
      Map<String, double> pressureData = {};
      
      final subscription = rxChar.lastValueStream.listen(
        (value) {
          if (value.isEmpty) return;
          
          if (value.length == 20 && value[0] == 0xF0 && value[1] == 0x10) {
            packetCounter++;
            
            // ⭐ STAMPA TUTTI I PACCHETTI PER DEBUG PRESSIONI
            if (packetCounter <= 30) {  // ⭐ STAMPA SOLO I PRIMI 30 PACCHETTI
              debugPrint('🔵 [$deviceName] Pkt #$packetCounter (tipo ${packetCounter % 3}): ${value.map((b) => b.toString().padLeft(3)).join(' ')}');
            }

                        
            // Pacchetto 1 di 3: IMU
            if (packetCounter % 3 == 1) {
              imuBuffer = List.from(value);
              pressureData = {};
            }
            // Pacchetto 2 di 3: Pressioni (3 sensori)
            // Pacchetto 2 di 3: Pressioni dai bytes 6-19
            // Pacchetto 2 di 3: Pressioni dai bytes 8-13
// Pacchetto 2 di 3: Leggi TUTTI gli 8 sensori (16 bytes: 8 sensori × 2 bytes)
else if (packetCounter % 3 == 2 && imuBuffer != null) {
  // ⭐ Leggi 8 sensori di pressione da offset 2 (o 4, o 6...)
  for (int i = 0; i < 8; i++) {
    int offset = 2 + (i * 2);  // Offset: 2,4,6,8,10,12,14,16
    if (offset + 1 < value.length) {
      final val = value[offset] | (value[offset + 1] << 8);
      final pressure = val > 32767 ? val - 65536 : val;
      pressureData['pressure_$i'] = pressure.toDouble();
      if (packetCounter <= 30) debugPrint('  📍 S$i @ offset$offset: $pressure');
    }
  }
}



            // Pacchetto 3 di 3: Completamento
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
      debugPrint('🟢 [$deviceName] STREAMING RAW ATTIVO!\n');
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
      // ⭐ DATI RAW (nessuna conversione)
      final rawData = _parseRawIMUData(imuData);
      
      // ⭐ AGGIUNGI 3 PRESSIONI RAW
      rawData.addAll(pressureData);
      
      if (packetNum % 100 == 0) {
        debugPrint('📦 [$deviceName] #$packetNum | AX=${rawData['accel_x']?.toInt()}, P0=${pressureData['pressure_0']?.toInt()}, P1=${pressureData['pressure_1']?.toInt()}, P2=${pressureData['pressure_2']?.toInt()}');
      }
      
      _latestData[deviceId] = {
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'sensor_name': deviceName,
        ...rawData,
      };
      
      final now = DateTime.now();
      final lastSend = _lastSendTime[deviceId];
      if (lastSend != null) {
        final elapsed = now.difference(lastSend).inMilliseconds;
        if (elapsed > 0) {
          _Hz[deviceId] = (1000 ~/ elapsed);
        }
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
  
  void _sendDataViaWebSocket(String deviceId, String deviceName) {
    final latestData = _latestData[deviceId];
    
    if (latestData == null) return;
    
    if (_socket == null || !_isSocketConnected) {
      _connectWebSocket();
      return;
    }
    
    try {
      _socket!.emit('sensor_data', {
        'sensor_name': deviceName,
        'data': latestData,
      });
      
      _lastSendTime[deviceId] = DateTime.now();
      
    } catch (e) {
      debugPrint('❌ [$deviceName] WebSocket send error: $e');
    }
  }
  
  // ⭐ PARSING RAW CON OFFSET CORRETTI
  Map<String, double> _parseRawIMUData(List<int> data) {
    if (data.length < 20) return {};
    
    int readInt16LE(int offset) {
      if (offset + 1 >= data.length) return 0;
      int val = data[offset] | (data[offset + 1] << 8);
      return val > 32767 ? val - 65536 : val;
    }
    
    // ⭐ OFFSET CORRETTI (saltando header 0xF0 0x10 e counter bytes 2-3)
    return {
      'accel_x': readInt16LE(4).toDouble(),   // ⭐ Offset 4
      'accel_y': readInt16LE(6).toDouble(),
      'accel_z': readInt16LE(8).toDouble(),
      'gyro_x': readInt16LE(10).toDouble(),
      'gyro_y': readInt16LE(12).toDouble(),
      'gyro_z': readInt16LE(14).toDouble(),
      'mag_x': readInt16LE(16).toDouble(),
      'mag_y': readInt16LE(18).toDouble(),
      'mag_z': 0.0,  // ⭐ Non c'è spazio
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
    
    _socket?.disconnect();
    _isSocketConnected = false;
    
    debugPrint('✅ ALL STREAMS STOPPED\n');
    notifyListeners();
  }
}
