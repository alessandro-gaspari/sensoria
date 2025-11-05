import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:http/http.dart' as http;
import 'package:sensoria_cs/streaming_manager.dart';

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
  bool isCalibrated = false, biasCalibrationDone = false;
  bool isTracking = false, serverConnected = false;

  List<double> smoothSupGX = [], smoothSupGY = [];
  List<double> smoothInfGX = [], smoothInfGY = [];
  List<double> calibSamplesSup = [], calibSamplesInf = [];
  double gyroBiasSup = 0, gyroBiasInf = 0;
  double lastRawSupGX = 0, lastRawInfGX = 0;
  DateTime lastUpdateTime = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _initTracking();
    });
  }

  void _initTracking() async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    streamingManager.setGyroDataCallback(_processSensorData);
    _checkServerConnection();
    
    await streamingManager.startScanning();
    
    setState(() {
      isTracking = true;
      lastUpdateTime = DateTime.now();
    });

    debugPrint('▶️ Tracking avviato - Seleziona dispositivi');
  }

  void _showDeviceSelector() {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    final scannedDevices = streamingManager.getScannedDevices();

    if (scannedDevices.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('❌ Nessun dispositivo trovato')),
      );
      return;
    }

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('📱 Seleziona Dispositivi'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: scannedDevices.map((device) {
              return ListTile(
                title: Text(device['name'] ?? 'Unknown'),
                subtitle: Text(device['id'] ?? ''),
                trailing: const Icon(Icons.arrow_forward),
                onTap: () async {
                  Navigator.pop(context);
                  await streamingManager.connectToDevice(
                    device['id']!,
                    device['name']!,
                  );
                },
              );
            }).toList(),
          ),
        ),
      ),
    );
  }

  void _stopTracking() async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    await streamingManager.disconnectAll();
    setState(() {
      isTracking = false;
    });
    debugPrint('⏹️ Tracking fermato');
  }

  void _retryServerConnection() async {
    await _checkServerConnection();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(serverConnected ? '✅ Connesso!' : '❌ Server offline'),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  Future<void> _checkServerConnection() async {
    try {
      final response = await http
          .get(Uri.parse('https://sensoria-dashboard.onrender.com/api/sensors'))
          .timeout(const Duration(seconds: 2));
      setState(() {
        serverConnected = response.statusCode == 200;
      });
      debugPrint(serverConnected ? '✅ Server online' : '❌ Server offline');
    } catch (_) {
      setState(() {
        serverConnected = false;
      });
      debugPrint('❌ Server non raggiungibile');
    }
  }

  void _processSensorData(String sensorName, int gyroX, int gyroY, int gyroZ) {
    if (!isTracking) return;

    debugPrint('📡 [$sensorName] CALLBACK - GX=$gyroX GY=$gyroY GZ=$gyroZ');

    DateTime now = DateTime.now();
    double deltaTime = now.difference(lastUpdateTime).inMilliseconds / 1000.0;
    lastUpdateTime = now;
    if (deltaTime > 0.5) deltaTime = 0.01;

    double gx = gyroX / S_GYRO;
    String n = sensorName.toLowerCase();

    if (!biasCalibrationDone) {
      if (n.contains('sup') || n.contains('sopra')) {
        calibSamplesSup.add(gx);
      }
      if (n.contains('inf') || n.contains('sotto')) {
        calibSamplesInf.add(gx);
      }

      if (calibSamplesSup.length >= CALIBRATION_SAMPLES &&
          calibSamplesInf.length >= CALIBRATION_SAMPLES) {
        _calibrateBias();
      }
      return;
    }

    if (n.contains('sup') || n.contains('sopra')) {
      if (gx != lastRawSupGX) {
        double gxSmooth = _smoothWithOutlier(smoothSupGX, gx);
        double corrected = gxSmooth.abs() < 50 ? gxSmooth - gyroBiasSup : gxSmooth;
        angleSup += corrected * deltaTime;
        lastRawSupGX = gx;
      }
    }

    if (n.contains('inf') || n.contains('sotto')) {
      if (gx != lastRawInfGX) {
        double gxSmooth = _smoothWithOutlier(smoothInfGX, gx);
        double corrected = gxSmooth.abs() < 50 ? gxSmooth - gyroBiasInf : gxSmooth;
        angleInf += corrected * deltaTime;
        lastRawInfGX = gx;
      }
    }

    setState(() {});
  }

  void _calibrateBias() {
    if (calibSamplesSup.isEmpty || calibSamplesInf.isEmpty) return;

    gyroBiasSup = calibSamplesSup.reduce((a, b) => a + b) / calibSamplesSup.length;
    gyroBiasInf = calibSamplesInf.reduce((a, b) => a + b) / calibSamplesInf.length;

    biasCalibrationDone = true;
    calibSamplesSup.clear();
    calibSamplesInf.clear();

    debugPrint('✅ BIAS: SUP=$gyroBiasSup INF=$gyroBiasInf');
    setState(() {});
  }

  double _smoothWithOutlier(List<double> buffer, double value) {
    if (buffer.isEmpty) {
      buffer.add(value);
      return value;
    }

    double avg = buffer.reduce((a, b) => a + b) / buffer.length;
    if ((value - avg).abs() > OUTLIER_THRESHOLD) return avg;

    buffer.add(value);
    if (buffer.length > SMOOTH_WINDOW) buffer.removeAt(0);
    return buffer.reduce((a, b) => a + b) / buffer.length;
  }

  void _calibrateAngle() {
    if (!biasCalibrationDone) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('⏳ Aspetta calibrazione bias...')),
      );
      return;
    }

    calibrationOffsetKnee = angleSup - angleInf;
    isCalibrated = true;
    setState(() {});

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('✅ Calibrato!')),
    );
  }

  int _getKneeAngle() {
    if (!isCalibrated) return 0;
    return (angleSup - angleInf - calibrationOffsetKnee).round();
  }

  void _reset() {
    angleSup = 0;
    angleInf = 0;
    calibrationOffsetKnee = 0;
    isCalibrated = false;
    biasCalibrationDone = false;
    calibSamplesSup.clear();
    calibSamplesInf.clear();
    smoothSupGX.clear();
    smoothSupGY.clear();
    smoothInfGX.clear();
    smoothInfGY.clear();
    lastRawSupGX = 0;
    lastRawInfGX = 0;

    setState(() {});
    debugPrint('🔄 Reset completo');
  }

  @override
  void dispose() {
    _stopTracking();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    int kneeAngle = _getKneeAngle();
    String biasStatus = biasCalibrationDone ? '✅' : '⏳';
    String calStatus = isCalibrated ? '✅' : '✗';

    return Scaffold(
      appBar: AppBar(
        title: const Text('📍 Tracking Ginocchio'),
        centerTitle: true,
        elevation: 0,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _reset),
        ],
      ),
      body: SingleChildScrollView(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                Container(
                  margin: const EdgeInsets.only(bottom: 20),
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
                    serverConnected ? '🟢 Server Online' : '🔴 Server Offline',
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
                  margin: const EdgeInsets.only(bottom: 20),
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
                      const Text('KNEE ANGLE',
                          style: TextStyle(
                              color: Color.fromRGBO(151, 201, 62, 1),
                              fontSize: 14,
                              fontWeight: FontWeight.w600)),
                      const SizedBox(height: 20),
                      Text('$kneeAngle°',
                          style: const TextStyle(
                              color: Color.fromRGBO(151, 201, 62, 1),
                              fontSize: 80,
                              fontWeight: FontWeight.w700,
                              fontFamily: 'Courier')),
                    ],
                  ),
                ),
                Container(
                  margin: const EdgeInsets.only(bottom: 30),
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: const Color(0xFF1A1A1A),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                      color: const Color.fromRGBO(89, 89, 92, 0.3),
                    ),
                  ),
                  child: Column(
                    children: [
                      Text('Bias: $biasStatus | Cal: $calStatus',
                          style: const TextStyle(
                              color: Color.fromRGBO(151, 201, 62, 1),
                              fontSize: 12)),
                      const SizedBox(height: 10),
                      Text(
                          'SUP: ${angleSup.toStringAsFixed(1)}° | INF: ${angleInf.toStringAsFixed(1)}°',
                          style: const TextStyle(
                              color: Color.fromRGBO(151, 201, 62, 0.7),
                              fontSize: 11)),
                    ],
                  ),
                ),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    ElevatedButton.icon(
                      onPressed: _showDeviceSelector,
                      icon: const Icon(Icons.devices),
                      label: const Text('📱 SELEZIONA'),
                      style: ElevatedButton.styleFrom(
                          backgroundColor: const Color.fromRGBO(151, 201, 62, 1)),
                    ),
                    ElevatedButton.icon(
                      onPressed: _calibrateAngle,
                      icon: const Icon(Icons.straighten),
                      label: const Text('📍 CALIBRA'),
                      style: ElevatedButton.styleFrom(
                          backgroundColor: const Color.fromRGBO(151, 201, 62, 1)),
                    ),
                    ElevatedButton.icon(
                      onPressed: _stopTracking,
                      icon: const Icon(Icons.stop),
                      label: const Text('⏹️ FERMA'),
                      style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFFFF6B6B)),
                    ),
                    ElevatedButton.icon(
                      onPressed: _retryServerConnection,
                      icon: const Icon(Icons.refresh),
                      label: const Text('🔄 RETRY'),
                      style: ElevatedButton.styleFrom(
                          backgroundColor: const Color.fromRGBO(200, 150, 50, 1)),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
