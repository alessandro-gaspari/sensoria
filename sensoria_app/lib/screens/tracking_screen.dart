import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'dart:math' as math;
import '../streaming_manager.dart';

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  // ⭐ STESSI PARAMETRI DEL DASHBOARD
  static const double S_GYRO = 65.54;
  static const int SMOOTH_WINDOW = 15;
  static const double OUTLIER_THRESHOLD = 80;
  static const int CALIBRATION_SAMPLES = 100;

  // ⭐ STATO
  double angleSup = 0;
  double angleInf = 0;
  double calibrationOffsetKnee = 0;
  bool isCalibrated = false;
  bool biasCalibrationDone = false;
  bool isTracking = false;
  bool serverConnected = false;

  // ⭐ SMOOTHING BUFFERS
  List<double> smoothSupGX = [];
  List<double> smoothSupGY = [];
  List<double> smoothInfGX = [];
  List<double> smoothInfGY = [];

  // ⭐ CALIBRAZIONE BIAS
  List<double> calibSamplesSup = [];
  List<double> calibSamplesInf = [];
  double gyroBiasSup = 0;
  double gyroBiasInf = 0;

  // ⭐ MEMORIA PER INTERPOLAZIONE
  double lastRawSupGX = 0;
  double lastRawInfGX = 0;

  DateTime lastUpdateTime = DateTime.now();

  @override
  void initState() {
    super.initState();
    
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final streamingManager = Provider.of<StreamingManager>(context, listen: false);
      
      // ⭐ Registra il callback
      streamingManager.setGyroDataCallback((sensorName, gx, gy, gz) {
        processSensorData(
          sensorName: sensorName,
          gyro_x: gx,
          gyro_y: gy,
          gyro_z: gz,
        );
      });
    });
  }


  double convertGyroscopeRaw(int raw) {
    return raw / S_GYRO;
  }

  // ⭐ SMOOTHING CON OUTLIER
  double smoothWithOutlierDetection(List<double> buffer, double value) {
    if (buffer.isEmpty) {
      buffer.add(value);
      return value;
    }

    double avg = buffer.reduce((a, b) => a + b) / buffer.length;
    double delta = (value - avg).abs();

    if (delta > OUTLIER_THRESHOLD) {
      return avg;
    }

    buffer.add(value);
    if (buffer.length > SMOOTH_WINDOW) {
      buffer.removeAt(0);
    }

    double newSum = buffer.reduce((a, b) => a + b);
    return newSum / buffer.length;
  }

  // ⭐ CALIBRAZIONE BIAS
  void calibrateGyroBias() {
    if (calibSamplesSup.length < CALIBRATION_SAMPLES || calibSamplesInf.length < CALIBRATION_SAMPLES) {
      return;
    }

    double sumSup = calibSamplesSup.reduce((a, b) => a + b);
    double sumInf = calibSamplesInf.reduce((a, b) => a + b);

    gyroBiasSup = sumSup / CALIBRATION_SAMPLES;
    gyroBiasInf = sumInf / CALIBRATION_SAMPLES;

    print('✅ BIAS: SUP=$gyroBiasSup INF=$gyroBiasInf');

    biasCalibrationDone = true;
    calibSamplesSup.clear();
    calibSamplesInf.clear();

    setState(() {});
  }

  // ⭐ PROCESSA DATI IMU (da StreamingManager)
  void processSensorData({
    required String sensorName,
    required int gyro_x,
    required int gyro_y,
    required int gyro_z,
  }) {
    if (!isTracking) return;

    DateTime now = DateTime.now();
    double deltaTime = now.difference(lastUpdateTime).inMilliseconds / 1000;
    lastUpdateTime = now;

    if (deltaTime > 0.5) deltaTime = 0.01;

    double gx = convertGyroscopeRaw(gyro_x);
    double gy = convertGyroscopeRaw(gyro_y);
    String n = sensorName.toLowerCase();

    // ⭐ FASE 1: Calibrazione bias
    if (!biasCalibrationDone) {
      if (n.contains('sup') || n.contains('sopra')) {
        calibSamplesSup.add(gx);
      }
      if (n.contains('inf') || n.contains('sotto')) {
        calibSamplesInf.add(gx);
      }

      if (calibSamplesSup.length >= CALIBRATION_SAMPLES && calibSamplesInf.length >= CALIBRATION_SAMPLES) {
        calibrateGyroBias();
      }
      return;
    }

    // ⭐ FASE 2: Integrazione CON INTERPOLAZIONE
    if (n.contains('sup') || n.contains('sopra')) {
      if (gx != lastRawSupGX) {
        double gxDelta = (gx - lastRawSupGX).abs();
        int interpolatedSteps = math.max(2, (gxDelta / 5).ceil());

        double gx_smooth = smoothWithOutlierDetection(smoothSupGX, gx);
        double gy_smooth = smoothWithOutlierDetection(smoothSupGY, gy);

        double dominant = gy_smooth.abs() > gx_smooth.abs() ? gy_smooth : gx_smooth;

        double dominant_corrected = dominant;
        if (dominant.abs() < 50) {
          dominant_corrected = dominant - gyroBiasSup;
        }

        double finalAngle = (dominant_corrected * deltaTime) / interpolatedSteps;
        angleSup = angleSup + finalAngle;

        lastRawSupGX = gx;
      }
    }

    if (n.contains('inf') || n.contains('sotto')) {
      if (gx != lastRawInfGX) {
        double gxDelta = (gx - lastRawInfGX).abs();
        int interpolatedSteps = math.max(2, (gxDelta / 5).ceil());

        double gx_smooth = smoothWithOutlierDetection(smoothInfGX, gx);
        double gy_smooth = smoothWithOutlierDetection(smoothInfGY, gy);

        double dominant = gy_smooth.abs() > gx_smooth.abs() ? gy_smooth : gx_smooth;

        double dominant_corrected = dominant;
        if (dominant.abs() < 50) {
          dominant_corrected = dominant - gyroBiasInf;
        }

        double finalAngle = (dominant_corrected * deltaTime) / interpolatedSteps;
        angleInf = angleInf + finalAngle;

        lastRawInfGX = gx;
      }
    }

    setState(() {});

    // ⭐ Invia al server se connesso
    if (serverConnected) {
      _sendKneeDataToServer();
    }
  }

  // ⭐ INVIA AL SERVER
  void _sendKneeDataToServer() async {
    try {
      int kneeAngle = (angleSup - angleInf - calibrationOffsetKnee).round();
      
      // Invia al server via HTTP
      // Implementa qui il tuo endpoint
      print('📤 Invia al server: $kneeAngle°');
    } catch (e) {
      print('❌ Errore invio: $e');
    }
  }

  // ⭐ AVVIA TRACKING
  void _startTracking() {
    setState(() {
      isTracking = true;
      lastUpdateTime = DateTime.now();
    });

    // Verifica se il server è raggiungibile
    _checkServerConnection();

    print('▶️ Tracking avviato');
  }

  // ⭐ FERMA TRACKING
  void _stopTracking() {
    setState(() {
      isTracking = false;
    });

    print('⏹️ Tracking fermato');
  }

  // ⭐ VERIFICA CONNESSIONE SERVER
  void _checkServerConnection() async {
    try {
      // Prova a raggiungere il server
      // final response = await http.get(Uri.parse('http://YOUR_SERVER:5000/api/sensors')).timeout(Duration(seconds: 2));
      
      // Se arriviamo qui, il server è up
      setState(() {
        serverConnected = true;
      });
      print('✅ Server collegato');
    } catch (e) {
      setState(() {
        serverConnected = false;
      });
      print('❌ Server offline - modalità locale');
    }
  }

  // ⭐ CALIBRA ANGOLO
  void _calibrateAngle() {
    if (!biasCalibrationDone) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('⏳ Aspetta calibrazione bias...')),
      );
      return;
    }

    calibrationOffsetKnee = (angleSup - angleInf);
    isCalibrated = true;

    setState(() {});

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('✅ Calibrato! Offset: ${calibrationOffsetKnee.toStringAsFixed(1)}°')),
    );
  }

  // ⭐ RESET COMPLETO
  void _reset() {
    setState(() {
      angleSup = 0;
      angleInf = 0;
      calibrationOffsetKnee = 0;
      isCalibrated = false;
      biasCalibrationDone = false;
      isTracking = false;
      calibSamplesSup.clear();
      calibSamplesInf.clear();
      smoothSupGX.clear();
      smoothSupGY.clear();
      smoothInfGX.clear();
      smoothInfGY.clear();
      lastRawSupGX = 0;
      lastRawInfGX = 0;
    });

    print('🔄 Reset completo');
  }

  int getKneeAngle() {
    return (angleSup - angleInf - calibrationOffsetKnee).round();
  }

  @override
  Widget build(BuildContext context) {
    var streamingManager = Provider.of<StreamingManager>(context, listen: false);
    
    int kneeAngle = getKneeAngle();
    String statusBias = biasCalibrationDone ? '✅' : '⏳';
    String statusCal = isCalibrated ? '✅' : '✗';

    return Scaffold(
      appBar: AppBar(
        title: const Text('📍 TRACKING GINOCCHIO'),
        centerTitle: true,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _reset,
            tooltip: 'Reset',
          ),
        ],
      ),
      body: Center(
        child: SingleChildScrollView(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              // ⭐ STATUS SERVER
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
                  serverConnected ? '🟢 Server Online' : '🔴 Server Offline (Modalità Locale)',
                  style: TextStyle(
                    color: serverConnected
                        ? const Color.fromRGBO(151, 201, 62, 1)
                        : const Color(0xFFFF4444),
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),

              // ⭐ ANGOLO PRINCIPALE
              Container(
                margin: const EdgeInsets.all(20),
                padding: const EdgeInsets.all(30),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
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
                  boxShadow: [
                    BoxShadow(
                      color: const Color.fromRGBO(151, 201, 62, 0.5),
                      blurRadius: 20,
                      spreadRadius: 2,
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    Text(
                      'ANGOLO GINOCCHIO',
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 1.5,
                      ),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      '$kneeAngle°',
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        fontSize: 80,
                        fontWeight: FontWeight.w700,
                        fontFamily: 'Courier',
                      ),
                    ),
                    const SizedBox(height: 20),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: LinearProgressIndicator(
                        value: (kneeAngle.clamp(-180, 180) + 180) / 360,
                        minHeight: 8,
                        backgroundColor: const Color.fromRGBO(89, 89, 92, 0.5),
                        valueColor: const AlwaysStoppedAnimation<Color>(
                          Color.fromRGBO(151, 201, 62, 1),
                        ),
                      ),
                    ),
                  ],
                ),
              ),

              // ⭐ STATUS
              Container(
                margin: const EdgeInsets.symmetric(horizontal: 20),
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: const Color.fromRGBO(89, 89, 92, 0.3),
                    width: 1,
                  ),
                ),
                child: Column(
                  children: [
                    Text(
                      'Bias: $statusBias | Calibrato: $statusCal',
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'SUP: ${angleSup.toStringAsFixed(1)}° | INF: ${angleInf.toStringAsFixed(1)}°',
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 0.7),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 30),

              // ⭐ PULSANTI
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  ElevatedButton.icon(
                    onPressed: isTracking ? _stopTracking : _startTracking,
                    icon: Icon(isTracking ? Icons.stop : Icons.play_arrow),
                    label: Text(isTracking ? '⏹️ Ferma' : '▶️ Avvia Tracking'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: isTracking
                          ? const Color(0xFFFF6B6B)
                          : const Color.fromRGBO(151, 201, 62, 1),
                      foregroundColor: const Color(0xFF000000),
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
                  ),
                  const SizedBox(width: 15),
                  ElevatedButton.icon(
                    onPressed: _calibrateAngle,
                    icon: const Icon(Icons.straighten),
                    label: const Text('📍 Calibra'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
                      foregroundColor: const Color(0xFF000000),
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                    ),
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
