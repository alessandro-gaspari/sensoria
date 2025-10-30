import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:async';
import 'dart:convert';

class ConnectedDevicesProvider extends ChangeNotifier {
  final Map<String, String> _deviceNames = {};
  final Map<String, String> _deviceIcons = {};
  final Map<String, BluetoothDevice> _connectedDevices = {};
  final Map<String, StreamSubscription<BluetoothConnectionState>> _connectionSubscriptions = {};

  Map<String, BluetoothDevice> get connectedDevices => Map.from(_connectedDevices);
  Map<String, String> get deviceNames => Map.from(_deviceNames);
  static const int maxDevices = 6;

  int get connectedCount => _connectedDevices.length;
  bool get canConnectMore => _connectedDevices.length < maxDevices;

  ConnectedDevicesProvider() {
    _loadDevices();
  }
  
  String getDeviceName(BluetoothDevice device) {
    final deviceId = device.remoteId.toString();
    if (_deviceNames.containsKey(deviceId)) {
      return _deviceNames[deviceId]!;
    }
    if (device.platformName.isNotEmpty) {
      return device.platformName;
    }
    return 'Dispositivo ${_connectedDevices.length + 1}';
  }
  
  String? getDeviceIconType(BluetoothDevice device) {
    final deviceId = device.remoteId.toString();
    return _deviceIcons[deviceId];
  }
  
  bool isConnected(BluetoothDevice device) {
    return _connectedDevices.containsKey(device.remoteId.toString());
  }

  Future<void> connectDevice(BluetoothDevice device) async {
    if (!canConnectMore) {
      throw Exception('Massimo 6 sensori raggiunto');
    }
    
    final deviceId = device.remoteId.toString();
    
    try {
      await device.connect(timeout: const Duration(seconds: 15));
      
      _connectedDevices[deviceId] = device;
      
      if (!_deviceNames.containsKey(deviceId)) {
        _deviceNames[deviceId] = device.platformName.isNotEmpty 
            ? device.platformName 
            : 'Dispositivo ${_connectedDevices.length}';
      }
      
      _connectionSubscriptions[deviceId] = device.connectionState.listen((state) {
        if (state == BluetoothConnectionState.disconnected) {
          debugPrint('🔌 Dispositivo disconnesso: $deviceId');
          _connectedDevices.remove(deviceId);
          _connectionSubscriptions[deviceId]?.cancel();
          _connectionSubscriptions.remove(deviceId);
          _saveDevices();
          notifyListeners();
        }
      });
      
      await _saveDevices();
      notifyListeners();
      
      debugPrint('✅ Connesso: ${_deviceNames[deviceId]}');
    } catch (e) {
      debugPrint('❌ Errore connessione: $e');
      throw Exception('Impossibile connettere');
    }
  }

  Future<void> disconnectDevice(BluetoothDevice device) async {
    final deviceId = device.remoteId.toString();
    
    try {
      _connectionSubscriptions[deviceId]?.cancel();
      _connectionSubscriptions.remove(deviceId);
      
      await device.disconnect();
      _connectedDevices.remove(deviceId);
      await _saveDevices();
      notifyListeners();
      
      debugPrint('🔌 Disconnesso: $deviceId');
    } catch (e) {
      debugPrint('❌ Errore disconnessione: $e');
    }
  }

  void updateDeviceName(BluetoothDevice device, String newName) {
    final deviceId = device.remoteId.toString();
    _deviceNames[deviceId] = newName;
    _saveDevices();
    notifyListeners();
  }

  void updateDeviceIcon(BluetoothDevice device, String iconType) {
    final deviceId = device.remoteId.toString();
    _deviceIcons[deviceId] = iconType;
    _saveDevices();
    notifyListeners();
    debugPrint('💾 Icona salvata: $iconType');
  }

  Future<void> disconnectAll() async {
    for (var device in _connectedDevices.values) {
      try {
        final deviceId = device.remoteId.toString();
        _connectionSubscriptions[deviceId]?.cancel();
        await device.disconnect();
      } catch (e) {
        debugPrint('❌ Errore: $e');
      }
    }
    _connectionSubscriptions.clear();
    _connectedDevices.clear();
    await _saveDevices();
    notifyListeners();
  }

  Future<void> _saveDevices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('device_names', jsonEncode(_deviceNames));
      await prefs.setString('device_icons', jsonEncode(_deviceIcons));
      debugPrint('✅ Salvati: ${_connectedDevices.length} dispositivi');
    } catch (e) {
      debugPrint('❌ Errore salvataggio: $e');
    }
  }

  Future<void> _loadDevices() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      
      final namesJson = prefs.getString('device_names');
      if (namesJson != null) {
        final namesMap = jsonDecode(namesJson) as Map<String, dynamic>;
        _deviceNames.addAll(namesMap.map((k, v) => MapEntry(k, v.toString())));
      }
      
      final iconsJson = prefs.getString('device_icons');
      if (iconsJson != null) {
        final iconsMap = jsonDecode(iconsJson) as Map<String, dynamic>;
        _deviceIcons.addAll(iconsMap.map((k, v) => MapEntry(k, v.toString())));
      }
      
      debugPrint('✅ Caricati: ${_deviceNames.length} nomi, ${_deviceIcons.length} icone');
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
