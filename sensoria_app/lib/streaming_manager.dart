import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'dart:async';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com/api/data';
  
  // Mappa: deviceId -> subscription
  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _counters = {};
  
  // Stato streaming per dispositivo
  Map<String, bool> get streamingStatus => Map.from(_activeStreams.map(
    (key, value) => MapEntry(key, true),
  ));
  
  bool isStreaming(String deviceId) => _activeStreams.containsKey(deviceId);

  

  // ⭐ AGGIUNGI: Attiva il sensore prima di leggere
  Future<void> startStreaming({
  required BluetoothDevice device,
  required String deviceName,
  required BluetoothService service,
  required BluetoothCharacteristic characteristic,
}) async {
  final deviceId = device.remoteId.toString();
  
  if (_activeStreams.containsKey(deviceId)) {
    debugPrint('⚠️ Streaming già attivo per $deviceName');
    return;
  }
  
  try {
    debugPrint('🎬 Avvio streaming per $deviceName...');
    
    // ⭐ CERCA CARATTERISTICA DI CONTROLLO (Write)
    BluetoothCharacteristic? controlChar;
    for (var char in service.characteristics) {
      if (char.properties.write || char.properties.writeWithoutResponse) {
        controlChar = char;
        debugPrint('✅ Trovata caratteristica controllo: ${char.uuid}');
        break;
      }
    }
    
    // ⭐ Se non c'è nello stesso service, cerca negli altri
    if (controlChar == null) {
      debugPrint('🔍 Cerco caratteristica write in altri servizi...');
      final allServices = await device.discoverServices();
      for (var svc in allServices) {
        for (var char in svc.characteristics) {
          if ((char.properties.write || char.properties.writeWithoutResponse) && 
              char.uuid.toString().contains('1cac0003')) {
            controlChar = char;
            debugPrint('✅ Trovata in altro servizio: ${char.uuid}');
            break;
          }
        }
        if (controlChar != null) break;
      }
    }
    
    // ⭐ INVIA COMANDO START
    if (controlChar != null) {
      try {
        // Prova diversi comandi START
        await controlChar.write([0x01], withoutResponse: true);
        debugPrint('📤 Comando START [0x01] inviato');
        await Future.delayed(Duration(milliseconds: 300));
        
        // Prova anche questo comando alternativo
        await controlChar.write([0x53, 0x54, 0x41, 0x52, 0x54], withoutResponse: true); // "START" in ASCII
        debugPrint('📤 Comando START ASCII inviato');
        await Future.delayed(Duration(milliseconds: 300));
      } catch (e) {
        debugPrint('⚠️ Errore invio comando: $e');
      }
    } else {
      debugPrint('⚠️ Nessuna caratteristica write trovata!');
    }
    
    // Abilita notifiche
    await characteristic.setNotifyValue(true);
    debugPrint('✅ Notifiche abilitate per $deviceName');
    
    _counters[deviceId] = 0;
    
    // Sottoscrivi allo stream
    final subscription = characteristic.lastValueStream.listen(
      (value) {
        _counters[deviceId] = (_counters[deviceId] ?? 0) + 1;
        
        debugPrint('📦 [$deviceName] Pacchetto ${_counters[deviceId]}: ${value.length} bytes - RAW: $value');
        
        if (value.length >= 20) {
          final imuData = _parseIMUData(value);
          _sendDataToServer(deviceName, imuData);
          
          debugPrint('📡 [$deviceName] Packet ${_counters[deviceId]}: '
              'Accel(${imuData['accel_x']}, ${imuData['accel_y']}, ${imuData['accel_z']})');
        } else if (value.isNotEmpty) {
          debugPrint('⚠️ [$deviceName] Pacchetto troppo corto: ${value.length} bytes');
        }
      },
      onError: (error) {
        debugPrint('❌ Errore stream $deviceName: $error');
      },
      cancelOnError: false,
    );
    
    _activeStreams[deviceId] = subscription;
    notifyListeners();
    
    debugPrint('✅ Streaming avviato per $deviceName (ID: $deviceId)');
  } catch (e) {
    debugPrint('❌ Errore avvio streaming $deviceName: $e');
    rethrow;
  }
}


  
  // Ferma streaming per un dispositivo
  Future<void> stopStreaming(String deviceId, BluetoothCharacteristic? characteristic) async {
    if (!_activeStreams.containsKey(deviceId)) {
      debugPrint('⚠️ Nessuno streaming attivo per $deviceId');
      return;
    }
    
    try {
      await _activeStreams[deviceId]?.cancel();
      _activeStreams.remove(deviceId);
      _counters.remove(deviceId);
      
      if (characteristic != null) {
        await characteristic.setNotifyValue(false);
        debugPrint('✅ Notifiche disabilitate per $deviceId');
      }
      
      notifyListeners();
      debugPrint('🛑 Streaming fermato per $deviceId');
    } catch (e) {
      debugPrint('❌ Errore stop streaming: $e');
    }
  }
  
  // Ferma tutti gli streaming
  Future<void> stopAll() async {
    for (var deviceId in _activeStreams.keys.toList()) {
      await stopStreaming(deviceId, null);
    }
  }
  
  // Parse IMU data
  Map<String, dynamic> _parseIMUData(List<int> value) {
    if (value.length < 20) return {};
    
    int readInt16LE(int offset) {
      int result = value[offset] | (value[offset + 1] << 8);
      return result > 32767 ? result - 65536 : result;
    }
    
    return {
      'accel_x': readInt16LE(2),
      'accel_y': readInt16LE(4),
      'accel_z': readInt16LE(6),
      'gyro_x': readInt16LE(8),
      'gyro_y': readInt16LE(10),
      'gyro_z': readInt16LE(12),
      'mag_x': readInt16LE(14),
      'mag_y': readInt16LE(16),
      'mag_z': readInt16LE(18),
    };
  }
  
  // Invia al server
  Future<void> _sendDataToServer(String sensorName, Map<String, dynamic> imuData) async {
    try {
      final response = await http.post(
        Uri.parse(SERVER_URL),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sensor_name': sensorName,
          'accel_x': imuData['accel_x'],
          'accel_y': imuData['accel_y'],
          'accel_z': imuData['accel_z'],
          'gyro_x': imuData['gyro_x'],
          'gyro_y': imuData['gyro_y'],
          'gyro_z': imuData['gyro_z'],
          'mag_x': imuData['mag_x'],
          'mag_y': imuData['mag_y'],
          'mag_z': imuData['mag_z'],
        }),
      );
      
      if (response.statusCode == 200) {
        debugPrint('🚀 [$sensorName] Dati inviati al server');
      } else {
        debugPrint('⚠️ Server error ${response.statusCode} per $sensorName: ${response.body}');
      }
    } catch (e) {
      debugPrint('❌ Errore invio $sensorName: $e');
    }
  }
  
  @override
  void dispose() {
    stopAll();
    super.dispose();
  }
}
