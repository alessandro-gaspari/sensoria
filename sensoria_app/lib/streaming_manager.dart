import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:http/http.dart' as http;

// Fattori di conversione (aggiorna con i tuoi valori reali)
const double ACC_LSB_PER_G = 16384.0; // ±2g
const double G = 9.80665;
const double GYRO_LSB_PER_DPS = 131.0; // ±250 dps
const double MAG_UT_PER_LSB = 0.30;    // esempio, verifica

class StreamingManager extends ChangeNotifier {
  static const String serverUrl = 'https://sensoria-dashboard.onrender.com/api/data';
  static const String serverAngleUrl = 'https://sensoria-dashboard.onrender.com/api/knee_angle';

  static const int targetHz = 100;
  static const int intervalMs = 1000 ~/ targetHz;

  final Map<String, BluetoothDevice> _connected = {};
  final Map<String, String> _deviceNames = {}; // id -> nome
  final Map<String, StreamSubscription<List<int>>> _activeStreams = {};
  final Map<String, BluetoothCharacteristic> _rxChars = {};
  final Map<String, DateTime> _lastSampleTime = {};

  String? supId;
  String? infId;

  final Map<String, double> _pitchDeg = {};
  final Map<String, double> _rollDeg = {};

  static const double alpha = 0.02;

  double _calibrationOffsetDeg = 0.0;
  bool _isCalibrated = false;

  final _kneeAngleCtrl = StreamController<int>.broadcast();
  Stream<int> get kneeAngleStream => _kneeAngleCtrl.stream;

  final _streamingStatusCtrl = StreamController<Map<String, bool>>.broadcast();
  Stream<Map<String, bool>> get streamingStatusStream => _streamingStatusCtrl.stream;

  Map<String, bool> get streamingStatus =>
      Map.fromEntries(_activeStreams.keys.map((id) => MapEntry(id, true)));

  bool isStreamingDevice(String deviceId) => _activeStreams.containsKey(deviceId);
  bool isDevicestreaming(String deviceId) => isStreamingDevice(deviceId); // alias
  bool isConnected(String deviceId) => _connected.containsKey(deviceId);
  List<BluetoothDevice> getConnectedDevices() => _connected.values.toList();
  String getName(String deviceId) => _deviceNames[deviceId] ?? 'Unknown';

  Future<void> connectToDevice(BluetoothDevice device, {String? friendlyName}) async {
    final id = device.remoteId.toString();
    if (_connected.containsKey(id)) return;
    await device.connect(autoConnect: false);
    _connected[id] = device;

    final sysName = device.name; // String
    _deviceNames[id] = friendlyName ?? (sysName.isNotEmpty ? sysName : 'Unknown');

    notifyListeners();
  }

  Future<void> quickConnect(BluetoothDevice device, {String? friendlyName}) async {
    await connectToDevice(device, friendlyName: friendlyName);
    try { await device.discoverServices(); } catch (_) {}
  }

  Future<void> disconnectFromDevice(String deviceId) async {
    final dev = _connected[deviceId];
    if (dev == null) return;
    try { await dev.disconnect(); } catch (_) {}
    _connected.remove(deviceId);
    if (_activeStreams.containsKey(deviceId)) {
      await stopStreaming(deviceId);
    }
    notifyListeners();
  }

  Future<void> renameDevice(String deviceId, String newName) async {
    _deviceNames[deviceId] = newName;
    notifyListeners();
  }

  Future<void> startStreaming(BluetoothDevice device, String deviceName) async {
    await startAllStreaming({device.remoteId.toString(): device}, {device.remoteId.toString(): deviceName});
  }

  Future<void> startAllStreaming(
    Map<String, BluetoothDevice> connectedDevices,
    Map<String, String> deviceNames,
  ) async {
    if (connectedDevices.isEmpty) return;

    for (final entry in connectedDevices.entries) {
      final id = entry.key;
      final device = entry.value;
      final name = (deviceNames[id] ?? 'Unknown').toLowerCase();

      if (_activeStreams.containsKey(id)) continue;

      final state = await device.connectionState.first;
      if (state != BluetoothConnectionState.connected) continue;

      final services = await device.discoverServices();
      BluetoothCharacteristic? rx;
      for (var s in services) {
        for (var c in s.characteristics) {
          final uuid = c.uuid.toString().toLowerCase();
          if (uuid == '1cac0003-656e-696c-4b5f-6e6572726157' && c.properties.notify) {
            rx = c; break;
          }
        }
        if (rx != null) break;
      }
      if (rx == null) continue;

      if (supId == null && _isSup(name)) supId = id;
      if (infId == null && _isInf(name)) infId = id;

      _rxChars[id] = rx;
      await rx.setNotifyValue(true);
      await Future.delayed(const Duration(milliseconds: 100));

      _pitchDeg[id] = 0.0;
      _rollDeg[id] = 0.0;
      _lastSampleTime[id] = DateTime.now();

      final sub = rx.lastValueStream.listen(
        (bytes) => _onPacket(id, name, bytes),
        onError: (_) { _cleanup(id); _notifyStreamingStatus(); },
        onDone: () { _cleanup(id); _notifyStreamingStatus(); },
      );
      _activeStreams[id] = sub;
      _notifyStreamingStatus();
    }

    _startTicker();
    notifyListeners();
  }

  void _startTicker() {
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(milliseconds: intervalMs), (_) {
      final sup = supId != null ? _pitchDeg[supId!] : null;
      final inf = infId != null ? _pitchDeg[infId!] : null;
      if (sup == null || inf == null) return;

      final rawDiff = sup - inf;
      final rel = rawDiff - (_isCalibrated ? _calibrationOffsetDeg : 0.0);
      final intDeg = rel.round();

      if (!_kneeAngleCtrl.isClosed) _kneeAngleCtrl.add(intDeg);
      _sendKneeAngle(intDeg);
    });
  }

  void calibrateZero() {
    final sup = supId != null ? _pitchDeg[supId!] : null;
    final inf = infId != null ? _pitchDeg[infId!] : null;
    if (sup == null || inf == null) return;
    _calibrationOffsetDeg = sup - inf;
    _isCalibrated = true;
  }

  Future<void> stopStreaming(String deviceId) async {
    if (_activeStreams.containsKey(deviceId)) {
      final sub = _activeStreams.remove(deviceId);
      await sub?.cancel();
      _cleanup(deviceId);
      _notifyStreamingStatus();
      notifyListeners();
    }
  }

  Future<void> stopAll() async {
    for (final id in _activeStreams.keys.toList()) {
      final sub = _activeStreams.remove(id);
      await sub?.cancel();
      _cleanup(id);
    }
    _ticker?.cancel();
    _notifyStreamingStatus();
    notifyListeners();
  }

  Timer? _ticker;

  @override
  void dispose() {
    stopAll();
    _kneeAngleCtrl.close();
    _streamingStatusCtrl.close();
    super.dispose();
  }

  void _onPacket(String id, String name, List<int> data) {
    if (data.length < 20) return;

    int i16(int o) {
      int v = data[o] | (data[o + 1] << 8);
      return v > 32767 ? v - 65536 : v;
    }

    final axRaw = i16(2);
    final ayRaw = i16(4);
    final azRaw = i16(6);
    final gxRaw = i16(8);
    final gyRaw = i16(10);
    final gzRaw = i16(12);
    final mxRaw = i16(14);
    final myRaw = i16(16);
    final mzRaw = i16(18);

    final ax_g = axRaw / ACC_LSB_PER_G;
    final ay_g = ayRaw / ACC_LSB_PER_G;
    final az_g = azRaw / ACC_LSB_PER_G;

    final ax_ms2 = ax_g * G;
    final ay_ms2 = ay_g * G;
    final az_ms2 = az_g * G;

    final gx_dps = gxRaw / GYRO_LSB_PER_DPS;
    final gy_dps = gyRaw / GYRO_LSB_PER_DPS;
    final gz_dps = gzRaw / GYRO_LSB_PER_DPS;

    final mx_uT = mxRaw * MAG_UT_PER_LSB;
    final my_uT = myRaw * MAG_UT_PER_LSB;
    final mz_uT = mzRaw * MAG_UT_PER_LSB;

    final now = DateTime.now();
    final dt = _lastSampleTime[id] != null
        ? now.difference(_lastSampleTime[id]!).inMicroseconds / 1e6
        : (1.0 / targetHz);
    _lastSampleTime[id] = now;

    final accelPitch = math.atan2(-ax_ms2, math.sqrt(ay_ms2 * ay_ms2 + az_ms2 * az_ms2)) * 180.0 / math.pi;
    final gyroPitch = (_pitchDeg[id] ?? 0.0) + gy_dps * dt;
    final fused = (1 - alpha) * gyroPitch + alpha * accelPitch;
    _pitchDeg[id] = fused;

    _sendRaw(
      id, name,
      ax_ms2, ay_ms2, az_ms2,
      gx_dps, gy_dps, gz_dps,
      mx_uT, my_uT, mz_uT,
    );
  }

  bool _isSup(String n) => RegExp(r'(sup|sopra|upper|quadricipite|thigh)').hasMatch(n);
  bool _isInf(String n) => RegExp(r'(inf|sotto|lower|tibia|shank)').hasMatch(n);

  void _cleanup(String id) {
    _activeStreams[id]?.cancel();
    _activeStreams.remove(id);
    _rxChars.remove(id);
    _pitchDeg.remove(id);
    _rollDeg.remove(id);
    _lastSampleTime.remove(id);
    if (supId == id) supId = null;
    if (infId == id) infId = null;
  }

  void _notifyStreamingStatus() {
    if (!_streamingStatusCtrl.isClosed) {
      _streamingStatusCtrl.add(streamingStatus);
    }
  }

  Future<void> _sendRaw(
    String id, String name,
    double ax_ms2, double ay_ms2, double az_ms2,
    double gx_dps, double gy_dps, double gz_dps,
    double mx_uT, double my_uT, double mz_uT,
  ) async {
    try {
      unawaited(http.post(
        Uri.parse(serverUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'sensor_name': name,
          'accel_x_ms2': ax_ms2, 'accel_y_ms2': ay_ms2, 'accel_z_ms2': az_ms2,
          'gyro_x_dps': gx_dps,  'gyro_y_dps': gy_dps,  'gyro_z_dps': gz_dps,
          'mag_x_uT': mx_uT,     'mag_y_uT': my_uT,     'mag_z_uT': mz_uT,
        }),
      ));
    } catch (_) {}
  }

  Future<void> _sendKneeAngle(int angleDeg) async {
    try {
      unawaited(http.post(
        Uri.parse(serverAngleUrl),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'knee_angle_deg': angleDeg,
          'calibrated': _isCalibrated,
          'timestamp': DateTime.now().toIso8601String(),
        }),
      ));
    } catch (_) {}
  }
}
