import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import 'dart:math' as math;
import 'streaming_manager.dart';

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({super.key});

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  static const double S_GYRO = 65.54;
  static const int SMOOTH_WINDOW = 15;
  static const double OUTLIER_THRESHOLD = 80.0;
  static const int CALIBRATION_SAMPLES = 100;

  double angleSup = 0, angleInf = 0, calibrationOffsetKnee = 0;
  bool isCalibrated = false, biasCalibrationDone = false, isTracking = false, serverConnected = false;

  List<double> smoothSupGX = [], smoothSupGY = [], smoothInfGX = [], smoothInfGY = [];
  List<double> calibSamplesSup = [], calibSamplesInf = [];
  double gyroBiasSup = 0, gyroBiasInf = 0, lastRawSupGX = 0, lastRawInfGX = 0;
  DateTime lastUpdateTime = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initStreaming();
    });
  }

  void _initStreaming() {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    streamingManager.setGyroDataCallback(_processSensorData);
    _checkServerConnection();
    _startTracking();
  }

  void _startTracking() async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    if (!streamingManager.isConnected) {
      await streamingManager.startScanning();
      await streamingManager.connectToAllDevices();
    }

    setState(() {
      isTracking = true;
      lastUpdateTime = DateTime.now();
    });
  }

  void _stopTracking() async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    await streamingManager.disconnectAll();
    setState(() => isTracking = false);
  }

  void _retryServer() => _checkServerConnection();

  Future<void> _checkServerConnection() async {
    try {
      final response = await http
          .get(Uri.parse('https://sensoria-dashboard.onrender.com/api/sensors'))
          .timeout(const Duration(seconds: 2));
      setState(() => serverConnected = response.statusCode == 200);
    } catch (_) {
      setState(() => serverConnected = false);
    }
  }

  void _processSensorData(String sensorName, int gyroX, int gyroY, int gyroZ) {
    if (!isTracking) return;

    DateTime now = DateTime.now();
    double deltaTime = now.difference(lastUpdateTime).inMilliseconds / 1000.0;
    lastUpdateTime = now;
    if (deltaTime > 0.5) deltaTime = 0.01;

    double gx = gyroX / S_GYRO;
    String n = sensorName.toLowerCase();

    if (!biasCalibrationDone) {
      if (n.contains('sup') || n.contains('sopra')) calibSamplesSup.add(gx);
      if (n.contains('inf') || n.contains('sotto')) calibSamplesInf.add(gx);

      if (calibSamplesSup.length >= CALIBRATION_SAMPLES && calibSamplesInf.length >= CALIBRATION_SAMPLES) {
        gyroBiasSup = calibSamplesSup.reduce((a, b) => a + b) / calibSamplesSup.length;
        gyroBiasInf = calibSamplesInf.reduce((a, b) => a + b) / calibSamplesInf.length;
        biasCalibrationDone = true;
        calibSamplesSup.clear();
        calibSamplesInf.clear();
      }
      return;
    }

    if (n.contains('sup') || n.contains('sopra')) {
      double gxSmooth = _smooth(smoothSupGX, gx);
      double corrected = gxSmooth.abs() < 50 ? gxSmooth - gyroBiasSup : gxSmooth;
      angleSup += corrected * deltaTime;
    }

    if (n.contains('inf') || n.contains('sotto')) {
      double gxSmooth = _smooth(smoothInfGX, gx);
      double corrected = gxSmooth.abs() < 50 ? gxSmooth - gyroBiasInf : gxSmooth;
      angleInf += corrected * deltaTime;
    }

    setState(() {});
  }

  double _smooth(List<double> buffer, double val) {
    if (buffer.isEmpty) {
      buffer.add(val);
      return val;
    }
    double avg = buffer.reduce((a, b) => a + b) / buffer.length;
    if ((val - avg).abs() > OUTLIER_THRESHOLD) return avg;
    buffer.add(val);
    if (buffer.length > SMOOTH_WINDOW) buffer.removeAt(0);
    return buffer.reduce((a, b) => a + b) / buffer.length;
  }

  void _calibrate() {
    if (!biasCalibrationDone) return;
    calibrationOffsetKnee = angleSup - angleInf;
    isCalibrated = true;
    setState(() {});
  }

  int _getKneeAngle() {
    if (!isCalibrated) return 0;
    return (angleSup - angleInf - calibrationOffsetKnee).round();
  }

  @override
  Widget build(BuildContext context) {
    int angle = _getKneeAngle();
    String biasStatus = biasCalibrationDone ? '✅' : '⏳';
    String calStatus = isCalibrated ? '✅' : '✗';

    return Scaffold(
      appBar: AppBar(title: const Text('📍 Tracking Ginocchio')),
      body: Center(
        child: SingleChildScrollView(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                margin: const EdgeInsets.all(20),
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                decoration: BoxDecoration(
                  color: serverConnected
                      ? const Color.fromRGBO(151, 201, 62, 0.2)
                      : const Color.fromRGBO(255, 68, 68, 0.2),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: serverConnected
                        ? const Color.fromRGBO(151, 201, 62, 1)
                        : const Color(0xFFFF4444),
                    width: 2,
                  ),
                ),
                child: Text(
                  serverConnected ? '🟢 Server Online' : '🔴 Server Offline (Local)',
                  style: TextStyle(
                    color: serverConnected
                        ? const Color.fromRGBO(151, 201, 62, 1)
                        : const Color(0xFFFF4444),
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Container(
                margin: const EdgeInsets.all(20),
                padding: const EdgeInsets.all(30),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [
                      Color.fromRGBO(151, 201, 62, 0.3),
                      Color.fromRGBO(107, 168, 47, 0.2),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: const Color.fromRGBO(151, 201, 62, 1),
                    width: 3,
                  ),
                ),
                child: Column(
                  children: [
                    const Text('KNEE ANGLE', style: TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 14, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 20),
                    Text('$angle°', style: const TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 80, fontWeight: FontWeight.w700, fontFamily: 'Courier')),
                    const SizedBox(height: 20),
                    Text('Bias: $biasStatus | Cal: $calStatus', style: const TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 12)),
                  ],
                ),
              ),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ElevatedButton.icon(
                    onPressed: _calibrate,
                    icon: const Icon(Icons.straighten),
                    label: const Text('📍 CALIBRA'),
                    style: ElevatedButton.styleFrom(backgroundColor: const Color.fromRGBO(151, 201, 62, 1)),
                  ),
                  const SizedBox(width: 10),
                  ElevatedButton.icon(
                    onPressed: _stopTracking,
                    icon: const Icon(Icons.stop),
                    label: const Text('⏹️ FERMA'),
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFFF6B6B)),
                  ),
                  const SizedBox(width: 10),
                  ElevatedButton.icon(
                    onPressed: _retryServer,
                    icon: const Icon(Icons.refresh),
                    label: const Text('🔄 RETRY'),
                    style: ElevatedButton.styleFrom(backgroundColor: const Color.fromRGBO(200, 150, 50, 1)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
