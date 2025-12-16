import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'; // Per defaultTargetPlatform
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:geolocator/geolocator.dart'; // NECESSARIO PER IL GPS
import 'dart:async';
import '../utils/tcp_client.dart';

class StreamingManager extends ChangeNotifier {
  static const String SERVER_URL = 'https://sensoria-dashboard.onrender.com';
  static const int TARGET_HZ = 100;

  final Map<String, StreamSubscription> _activeStreams = {};
  final Map<String, int> _packetCounts = {};
  final Map<String, Map<String, dynamic>> _latestData = {};
  final Map<String, DateTime> _lastSendTime = {};
  final Map<String, String> _deviceProtocols = {};

  // ==================== SENSOR FUSION DATA SYNC VARIABLES ====================
  double? _lastLat;
  double? _lastLon;
  double? _lastAccuracy;
  DateTime? _lastGpsNativeTimestamp; 

  // ==================== HRM VARIABLES ====================
  int? _currentHeartRate;
  int? get currentHeartRate => _currentHeartRate;
  
  String? _hrmDeviceId;
  String? _hrmDeviceName;
  String? get hrmDeviceName => _hrmDeviceName;

  bool get isSshConnected => _tcpSender?.isConnected ?? false;

  IO.Socket? _socket;
  bool _isSocketConnected = false;

  TCPDataSender? _tcpSender;
  bool _isTrackingActive = false;
  
  StreamSubscription<Position>? _gpsSubscription;

  bool get isStreaming => _activeStreams.isNotEmpty;
  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  bool get isTrackingActive => _isTrackingActive;
  bool _isServerReachable = false;
  bool get isServerReachable => _isServerReachable;
  Timer? _serverCheckTimer;

  Map<String, bool> get streamingStatus =>
      Map.from(_activeStreams.map((key, value) => MapEntry(key, true)));
  Map<String, Map<String, dynamic>?> get allSensorData => Map.from(_latestData);

  StreamingManager() {
    _connectWebSocket();
    _startServerCheck();
  }

  void _startServerCheck() {
    _checkServer();
    _serverCheckTimer = Timer.periodic(const Duration(seconds: 5), (_) => _checkServer());
  }

  Future<void> _checkServer() async {
    final checker = TCPDataSender();
    final isUp = await checker.checkConnection();
    
    if (isUp != _isServerReachable) {
      _isServerReachable = isUp;
      notifyListeners();
      debugPrint('SSH Server status changed: $isUp');
    }
  }

  @override
  void dispose() {
    debugPrint('🛑 StreamingManager DISPOSE');
    stopTracking();
    stopAll();
    _socket?.disconnect();
    _socket?.dispose();
    _serverCheckTimer?.cancel();
    super.dispose();
  }

  // ==================== HRM LOGIC ====================
  
  void setHrmConnection(String deviceId, String deviceName, int bpm) {
    _hrmDeviceId = deviceId;
    _hrmDeviceName = deviceName;
    updateHeartRate(bpm);
  }

  void updateHeartRate(int bpm) {
    _currentHeartRate = bpm;
    notifyListeners();
    if (_isTrackingActive && _tcpSender != null && _tcpSender!.isConnected) {
      final timestamp = DateTime.now().toUtc().toIso8601String();
      _tcpSender!.sendData("HRM", {
        "timestamp": timestamp,
        "heart_rate": bpm, 
        "sensor_name": _hrmDeviceName ?? "COOSPO"
      });
    }
  }

  void clearHrmConnection() {
    _hrmDeviceId = null;
    _hrmDeviceName = null;
    _currentHeartRate = null;
    notifyListeners();
  }

  // ==================== TRACKING & DATA PIPELINE ====================

  void startTracking() {
    if (_isTrackingActive) return;
    
    _isTrackingActive = true;
    _tcpSender = TCPDataSender();
    _tcpSender?.connect();
    
    _lastLat = null;
    _lastLon = null;
    _lastAccuracy = null;
    _lastGpsNativeTimestamp = null;

    _initGpsStream();
    
    debugPrint('📍 Tracking avviato - Data Pipeline Attiva');
    notifyListeners();
  }

  void stopTracking() {
    if (!_isTrackingActive) return;
    
    _gpsSubscription?.cancel();
    _gpsSubscription = null;
    
    _isTrackingActive = false;
    _tcpSender?.disconnect();
    _tcpSender = null;
    debugPrint('⏹️ Tracking fermato');
    notifyListeners();
  }
  
  Future<void> _initGpsStream() async {
      debugPrint("🛰️ Avvio inizializzazione GPS...");
      
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
            debugPrint("❌ Permesso GPS negato");
            return;
        }
      }

      late LocationSettings locationSettings;

      if (defaultTargetPlatform == TargetPlatform.android) {
        locationSettings = AndroidSettings(
          accuracy: LocationAccuracy.bestForNavigation, 
          distanceFilter: 0, 
          forceLocationManager: true,
          intervalDuration: const Duration(seconds: 1), // Forza aggiornamento ogni 1s
          foregroundNotificationConfig: const ForegroundNotificationConfig(
            notificationTitle: "Sensoria Tracking",
            notificationText: "Acquisizione GPS attiva",
            enableWakeLock: true,
          ),
        );
      } else if (defaultTargetPlatform == TargetPlatform.iOS) {
        locationSettings = AppleSettings(
          accuracy: LocationAccuracy.bestForNavigation,
          // CAMBIATO DA .fitness A .otherNavigation PER ESSERE PIÙ AGGRESSIVO
          activityType: ActivityType.otherNavigation, 
          distanceFilter: 0, // 0 metri = notifica ogni minimo spostamento
          pauseLocationUpdatesAutomatically: false,
          showBackgroundLocationIndicator: true, 
        );
      } else {
        locationSettings = const LocationSettings(
          accuracy: LocationAccuracy.bestForNavigation,
          distanceFilter: 0,
        );
      }

      _gpsSubscription = Geolocator.getPositionStream(locationSettings: locationSettings).listen(
        (Position? position) {
          if (position != null) {
            // LOG DI VERITÀ: Se non vedi questo print, è colpa di iOS/Segnale
            debugPrint("📍 GPS EVENT RAW: ${position.latitude}, ${position.longitude} | Acc: ${position.accuracy}");
            
            _lastLat = position.latitude;
            _lastLon = position.longitude;
            _lastAccuracy = position.accuracy;
            _lastGpsNativeTimestamp = position.timestamp; 
            
            // Invio al TCP (per debug UI)
            sendGpsData(position.latitude, position.longitude, position.accuracy, position.timestamp);
          }
        },
        onError: (e) => debugPrint("❌ Errore stream GPS: $e"),
      );
      debugPrint("🛰️ Stream GPS richiesto al sistema operativo.");
  }


  // ==================== WEBSOCKET & BLE LOGIC ====================

  void _connectWebSocket() {
    if (_socket != null && _isSocketConnected) return;
    
    _socket = IO.io(SERVER_URL, IO.OptionBuilder()
        .setTransports(['websocket'])
        .enableAutoConnect()
        .build());

    _socket!.onConnect((_) => _isSocketConnected = true);
    _socket!.onDisconnect((_) => _isSocketConnected = false);
  }

  String _getProtocolForDevice(String deviceName, int packetLength) {
    final name = deviceName.toLowerCase();
    if (name.contains('ginocchio') || name.contains('core') || name.contains('knee')) {
      return 'F20';
    }
    if (packetLength == 32) return 'L32';
    return 'H20';
  }

  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    await startAllStreaming(
      {device.remoteId.toString(): device},
      {device.remoteId.toString(): deviceName},
    );
  }

  Future<void> sendProfileData(String name, int age, String gender, double weight) async {
    if (_tcpSender != null && _tcpSender!.isConnected) {
      final timestamp = DateTime.now().toUtc().toIso8601String();
      _tcpSender!.sendData("PROFILE_INFO", {
        "timestamp": timestamp,
        "name": name, "age": age, "gender": gender, "weight": weight,
      });
    }
  }

  Future<void> startAllStreaming(
      Map<String, BluetoothDevice> connectedDevices,
      Map<String, String> deviceNames) async {
    if (connectedDevices.isEmpty) return;

    if (!_isSocketConnected) {
      _connectWebSocket();
      await Future.delayed(const Duration(seconds: 1));
    }

    for (var entry in connectedDevices.entries) {
      final deviceId = entry.key;
      final device = entry.value;
      final deviceName = deviceNames[deviceId] ?? 'Unknown';

      if (_activeStreams.containsKey(deviceId)) continue;

      try {
        final connectionState = await device.connectionState.first;
        if (connectionState != BluetoothConnectionState.connected) continue;

        final services = await device.discoverServices();
        BluetoothCharacteristic? rxChar;
        for (var service in services) {
          for (var characteristic in service.characteristics) {
            if (characteristic.uuid.toString().toLowerCase() == '1cac0003-656e-696c-4b5f-6e6572726157' &&
                characteristic.properties.notify) {
              rxChar = characteristic;
              break;
            }
          }
          if (rxChar != null) break;
        }

        if (rxChar == null) continue;

        await _setupStreaming(
          deviceId: deviceId,
          deviceName: deviceName,
          rxChar: rxChar,
          device: device,
        );
      } catch (e) {
        debugPrint('❌ [$deviceName] Errore: $e\n');
      }
    }
    notifyListeners();
  }

  Future<void> _setupStreaming({
    required String deviceId,
    required String deviceName,
    required BluetoothCharacteristic rxChar,
    required BluetoothDevice device,
  }) async {
    await rxChar.setNotifyValue(true);

    _packetCounts[deviceId] = 0;
    _latestData[deviceId] = {
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'sensor_name': deviceName
    };
    _lastSendTime[deviceId] = DateTime.now();
    
    _deviceProtocols.remove(deviceId);

    final subscription = rxChar.lastValueStream.listen(
      (value) {
        if (value.isEmpty) return;
        
        if (!_deviceProtocols.containsKey(deviceId)) {
           _deviceProtocols[deviceId] = _getProtocolForDevice(deviceName, value.length);
        }
        final protocol = _deviceProtocols[deviceId]!;

        final parsed = parseSensoriaPacket(value, protocol: protocol);
        if (parsed.isEmpty) return;
        
        _packetCounts[deviceId] = (_packetCounts[deviceId] ?? 0) + 1;
        
        final imuArrivalTimestamp = DateTime.now();
        final timestampStr = imuArrivalTimestamp.toUtc().toIso8601String();
        
        Map<String, dynamic> dataToSend = {
          'timestamp': timestampStr,
          'sensor_name': deviceName,
          'accel_x': parsed['accel_x'], 'accel_y': parsed['accel_y'], 'accel_z': parsed['accel_z'],
          'gyro_x': parsed['gyro_x'], 'gyro_y': parsed['gyro_y'], 'gyro_z': parsed['gyro_z'],
          'mag_x': parsed['mag_x'], 'mag_y': parsed['mag_y'], 'mag_z': parsed['mag_z'],
        };
        
        parsed.forEach((k, v) {
            if (k.startsWith('pressure_')) dataToSend[k] = v;
        });

        if (_lastLat != null && _lastLon != null) {
            dataToSend['latitude'] = _lastLat;
            dataToSend['longitude'] = _lastLon;
            dataToSend['gps_accuracy'] = _lastAccuracy;
            
            if (_lastGpsNativeTimestamp != null) {
                final gpsAge = imuArrivalTimestamp.difference(_lastGpsNativeTimestamp!).inMilliseconds;
                dataToSend['gps_age_ms'] = gpsAge;
                dataToSend['gps_native_ts'] = _lastGpsNativeTimestamp!.toIso8601String();
            }
        }

        _latestData[deviceId] = dataToSend;
        
        if (_packetCounts[deviceId]! % 100 == 0) {
            final gpsStatus = _lastLat != null ? "GPS: OK (${dataToSend['gps_age_ms']}ms old)" : "GPS: NO";
            debugPrint("📡 #$deviceId | $gpsStatus");
        }

        _sendData(deviceId, deviceName, dataToSend);
        
        notifyListeners();
      },
      onError: (e) => _cleanupStreaming(deviceId),
      onDone: () => _cleanupStreaming(deviceId),
    );
    _activeStreams[deviceId] = subscription;
  }

  void _sendData(String deviceId, String deviceName, Map<String, dynamic> data) {
    if (_isTrackingActive && _tcpSender != null) {
      _tcpSender!.sendData(deviceName, data);
    }
  }

  void _cleanupStreaming(String deviceId) {
    _activeStreams.remove(deviceId);
    _packetCounts.remove(deviceId);
    _latestData.remove(deviceId);
    _deviceProtocols.remove(deviceId);
  }

  Future<void> stopStreaming(String deviceId) async {
    if (!_activeStreams.containsKey(deviceId)) return;
    try {
      await _activeStreams[deviceId]?.cancel();
      _cleanupStreaming(deviceId);
      debugPrint('🛑 STOP STREAMING: $deviceId');
      notifyListeners();
    } catch (e) {
      debugPrint('❌ Errore stoppando $deviceId: $e');
    }
  }

  Future<void> stopAll() async {
    for (var s in _activeStreams.values) await s.cancel();
    _cleanupStreaming("ALL");
    notifyListeners();
  }

  // ==================== METODO CORRETTO CON NAMED PARAMETER ====================
  // Usando { } rendiamo nativeTs opzionale ma con nome.
  // La vecchia chiamata con 3 parametri FUNZIONA ANCORA perché nativeTs è opzionale.
  void sendGpsData(double latitude, double longitude, double accuracy, [DateTime? nativeTs]) {
    if (!_isTrackingActive || _tcpSender == null || !_tcpSender!.isConnected) return;
    
    final timestamp = DateTime.now().toUtc().toIso8601String();
    
    try {
      _tcpSender!.sendData("GPS_RAW", {
        "timestamp": timestamp,
        "sensor_name": "GPS_RAW",
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": accuracy,
        "gps_native_ts": nativeTs?.toIso8601String() ?? timestamp
      });
    } catch (e) {
      debugPrint("❌ [GPS] Errore invio: $e");
    }
  }
}

// Parsing helper invariato
Map<String, double> parseSensoriaPacket(List<int> data, {String protocol = "F20"}) {
  int b(int i) => data[i] & 0xFF;
   if (protocol == "F20") {
    if (data.length != 20) return {};
    return {
      'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
      'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
      'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
      'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
      'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
      'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
      'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
      'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
      'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
      'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
    };
  } else if (protocol == "G20") {
      if (data.length != 20) return {};
      return {
        'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
        'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
        'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
        'pressure_3': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
        'pressure_4': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
        'pressure_5': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
        'pressure_6': (0x3FF & ((b(0) << 6) | ((b(1) & 0xC0) >> 2) | (b(4) & 0x0F))).toDouble(),
        'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
        'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
        'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
        'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
        'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
        'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
        'mag_x': 0.0, 'mag_y': 0.0, 'mag_z': 0.0,
      };
  } else if (protocol == "L32") {
    if (data.length != 32) return {};
    return {
      'pressure_0': (0x3FF & ((b(21) << 2) | (b(22) >> 6))).toDouble(),
      'pressure_1': (0x3FF & ((b(22) << 4) | (b(23) >> 4))).toDouble(),
      'pressure_2': (0x3FF & ((b(23) << 6) | (b(24) >> 2))).toDouble(),
      'pressure_3': (0x3FF & (((b(24) & 0x03) << 8) | b(25))).toDouble(),
      'pressure_4': (0x3FF & ((b(26) << 2) | (b(27) >> 6))).toDouble(),
      'pressure_5': (0x3FF & ((b(27) << 4) | (b(28) >> 4))).toDouble(),
      'pressure_6': (0x3FF & ((b(28) << 6) | (b(29) >> 2))).toDouble(),
      'pressure_7': (0x3FF & (((b(29) & 0x03) << 8) | b(30))).toDouble(),
      'accel_x': (b(3) | (b(4) << 8)).toDouble(),
      'accel_y': (b(5) | (b(6) << 8)).toDouble(),
      'accel_z': (b(7) | (b(8) << 8)).toDouble(),
      'gyro_x': (b(9) | (b(10) << 8)).toDouble(),
      'gyro_y': (b(11) | (b(12) << 8)).toDouble(),
      'gyro_z': (b(13) | (b(14) << 8)).toDouble(),
      'mag_x': (b(15) | (b(16) << 8)).toDouble(),
      'mag_y': (b(17) | (b(18) << 8)).toDouble(),
      'mag_z': (b(19) | (b(20) << 8)).toDouble(),
    };
  } else if (protocol == "H20" || protocol == "I20") {
      if (data.length != 20) return {};
      return {
        'pressure_0': (0x3FF & ((b(5) << 2) | (b(6) >> 6))).toDouble(),
        'pressure_1': (0x3FF & ((b(6) << 4) | (b(7) >> 4))).toDouble(),
        'pressure_2': (0x3FF & ((b(7) << 6) | (b(8) >> 2))).toDouble(),
        'pressure_3': (0x3FF & ((b(0) << 6) | (b(4) & 0x3F))).toDouble(),
        'accel_x': (0x3FF & ((b(12) << 6) | (b(13) >> 2))).toDouble(),
        'accel_y': (0x3FF & ((b(13) << 8) | b(14))).toDouble(),
        'accel_z': (0x3FF & ((b(15) << 2) | (b(16) >> 6))).toDouble(),
        'gyro_x': (0x3FF & ((b(16) << 4) | (b(17) >> 4))).toDouble(),
        'gyro_y': (0x3FF & ((b(17) << 6) | (b(18) >> 2))).toDouble(),
        'gyro_z': (0x3FF & ((b(18) << 8) | b(19))).toDouble(),
        'mag_x': (0x3FF & ((b(8) << 8) | b(9))).toDouble(),
        'mag_y': (0x3FF & ((b(10) << 2) | (b(11) >> 6))).toDouble(),
        'mag_z': (0x3FF & ((b(11) << 4) | (b(12) >> 4))).toDouble(),
      };
  }
  return {};
}
