import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:async';
import 'dart:convert';

class ConnectedDevicesProvider extends ChangeNotifier {
  // Mappa: deviceId (String) -> deviceName (String)
  final Map<String, String> _deviceNames = {};
  
  // Mappa: deviceId (String) -> iconType (String)
  final Map<String, String> _deviceIcons = {};
  
  // Mappa: deviceId (String) -> BluetoothDevice
  final Map<String, BluetoothDevice> _connectedDevices = {};
  
  // Mappa: deviceId (String) -> StreamSubscription
  final Map<String, StreamSubscription<BluetoothConnectionState>> _connectionSubscriptions = {};

  ConnectedDevicesProvider() {
    _loadDevices();
  }

  // Getter
  int get connectedCount => _connectedDevices.length;
  
  bool get canConnectMore => _connectedDevices.length < 6;
  
  String getDeviceName(BluetoothDevice device) {
    final deviceId = device.remoteId.toString();
    
    // Se ha un nome personalizzato salvato, usalo
    if (_deviceNames.containsKey(deviceId)) {
      return _deviceNames[deviceId]!;
    }
    
    // Altrimenti usa il nome del dispositivo Bluetooth
    if (device.platformName.isNotEmpty) {
      return device.platformName;
    }
    
    // Fallback: nome generico
    return 'Dispositivo ${_connectedDevices.length + 1}';
  }
  
  String? getDeviceIconType(BluetoothDevice device) {
    final deviceId = device.remoteId.toString();
    return _deviceIcons[deviceId];
  }
  
  bool isConnected(BluetoothDevice device) {
    return _connectedDevices.containsKey(device.remoteId.toString());
  }

  // Connetti dispositivo
  Future<void> connectDevice(BluetoothDevice device) async {
    if (!canConnectMore) {
      throw Exception('Massimo 6 sensori raggiunto');
    }
    
    final deviceId = device.remoteId.toString();
    
    try {
      await device.connect(timeout: const Duration(seconds: 15));
      
      _connectedDevices[deviceId] = device;
      
      // Se non ha un nome personalizzato, assegna nome default
      if (!_deviceNames.containsKey(deviceId)) {
        _deviceNames[deviceId] = device.platformName.isNotEmpty 
            ? device.platformName 
            : 'Dispositivo ${_connectedDevices.length}';
      }
      
      // Monitora disconnessioni automatiche
      _connectionSubscriptions[deviceId] = device.connectionState.listen((state) {
        if (state == BluetoothConnectionState.disconnected) {
          debugPrint('🔌 Dispositivo disconnesso automaticamente: $deviceId');
          _connectedDevices.remove(deviceId);
          _connectionSubscriptions[deviceId]?.cancel();
          _connectionSubscriptions.remove(deviceId);
          _saveDevices();
          notifyListeners();
        }
      });
      
      await _saveDevices();
      notifyListeners();
      
      debugPrint('✅ Dispositivo connesso: ${_deviceNames[deviceId]}');
    } catch (e) {
      debugPrint('❌ Errore connessione: $e');
      throw Exception('Impossibile connettere');
    }
  }

  // Disconnetti dispositivo
  Future<void> disconnectDevice(BluetoothDevice device) async {
    final deviceId = device.remoteId.toString();
    
    try {
      // Cancella subscription
      _connectionSubscriptions[deviceId]?.cancel();
      _connectionSubscriptions.remove(deviceId);
      
      await device.disconnect();
      _connectedDevices.remove(deviceId);
      await _saveDevices();
      notifyListeners();
      
      debugPrint('🔌 Dispositivo disconnesso: $deviceId');
    } catch (e) {
      debugPrint('❌ Errore disconnessione: $e');
    }
  }

  // Aggiorna nome dispositivo
  void updateDeviceName(BluetoothDevice device, String newName) {
    final deviceId = device.remoteId.toString();
    _deviceNames[deviceId] = newName;
    _saveDevices();
    notifyListeners();
  }

  // Aggiorna icona dispositivo
  void updateDeviceIcon(BluetoothDevice device, String iconType) {
    final deviceId = device.remoteId.toString();
    _deviceIcons[deviceId] = iconType;
    _saveDevices();
    notifyListeners();
    debugPrint('💾 Icona salvata: $iconType per $deviceId');
  }

  // Disconnetti tutti
  Future<void> disconnectAll() async {
    for (var device in _connectedDevices.values) {
      try {
        final deviceId = device.remoteId.toString();
        _connectionSubscriptions[deviceId]?.cancel();
        await device.disconnect();
      } catch (e) {
        debugPrint('❌ Errore disconnessione $device: $e');
      }
    }
    _connectionSubscriptions.clear();
    _connectedDevices.clear();
    await _saveDevices();
    notifyListeners();
  }

  // Salva su SharedPreferences
  Future<void> _saveDevices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      
      // Salva solo nomi e icone (NON dispositivi connessi)
      await prefs.setString('device_names', jsonEncode(_deviceNames));
      await prefs.setString('device_icons', jsonEncode(_deviceIcons));
      
      debugPrint('✅ Dispositivi salvati: ${_connectedDevices.length} connessi');
    } catch (e) {
      debugPrint('❌ Errore salvataggio: $e');
    }
  }

  // Carica da SharedPreferences
  Future<void> _loadDevices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      
      // Carica nomi
      final namesJson = prefs.getString('device_names');
      if (namesJson != null) {
        final namesMap = jsonDecode(namesJson) as Map<String, dynamic>;
        _deviceNames.addAll(namesMap.map((k, v) => MapEntry(k, v.toString())));
      }
      
      // Carica icone
      final iconsJson = prefs.getString('device_icons');
      if (iconsJson != null) {
        final iconsMap = jsonDecode(iconsJson) as Map<String, dynamic>;
        _deviceIcons.addAll(iconsMap.map((k, v) => MapEntry(k, v.toString())));
      }
      
      debugPrint('✅ Dati caricati: ${_deviceNames.length} nomi, ${_deviceIcons.length} icone');
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Errore caricamento: $e');
    }
  }
  
  @override
  void dispose() {
    for (var sub in _connectionSubscriptions.values) {
      sub.cancel();
    }
    _connectionSubscriptions.clear();
    super.dispose();
  }
}
