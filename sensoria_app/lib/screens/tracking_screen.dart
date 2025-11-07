import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../streaming_manager.dart';

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  int _debugCounter = 0;

  @override
  void initState() {
    super.initState();
    debugPrint('\n🎯 TrackingScreen INIT - Dati già filtrati con EMA');
  }

  @override
  void dispose() {
    debugPrint('🛑 TrackingScreen DISPOSE');
    super.dispose();
  }

  /// ⭐ Ferma lo streaming e torna indietro
  void _stopStreamingAndExit() async {
    debugPrint('🛑 STOP STREAMING');

    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    await streamingManager.stopAll();

    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('📊 Sensori In Tempo Reale'),
        centerTitle: true,
        elevation: 0,
      ),
      body: SafeArea(
        child: Consumer<StreamingManager>(
          builder: (context, streamingManager, _) {
            final allSensorData = streamingManager.allSensorData;

            // ⭐ DEBUG - Stampa ogni 100 build (evita spam)
            _debugCounter++;
            if (_debugCounter % 100 == 0) {
              debugPrint('\n📱 BUILD #$_debugCounter @ 100Hz');
              debugPrint('   Keys: ${allSensorData.keys.toList()}');
            }

            // ⭐ ELABORAZIONE LOCALE - ESTRAI DATI GIÀ FILTRATI
            double? supAccelX, supAccelY, supAccelZ;
            double? supGyroX, supGyroY, supGyroZ;
            double? supMagX, supMagY, supMagZ;

            double? infAccelX, infAccelY, infAccelZ;
            double? infGyroX, infGyroY, infGyroZ;
            double? infMagX, infMagY, infMagZ;

            bool hasSupData = false;
            bool hasInfData = false;
            String? supName;
            String? infName;

            for (var entry in allSensorData.entries) {
              final data = entry.value;

              if (data == null) continue;

              // ⭐ ESTRAI NOME SENSORE
              final sensorName = (data['sensor_name'] as String?) ?? 'Unknown';
              final nameLower = sensorName.toLowerCase();

              if (nameLower.contains('sup') ||
                  nameLower.contains('sopra') ||
                  nameLower.contains('upper') ||
                  nameLower.contains('top')) {
                
                // ⭐ I DATI SONO GIÀ FILTRATI (in g, °/s, µT)
                supAccelX = (data['accel_x'] as double?) ?? 0.0;
                supAccelY = (data['accel_y'] as double?) ?? 0.0;
                supAccelZ = (data['accel_z'] as double?) ?? 0.0;
                supGyroX = (data['gyro_x'] as double?) ?? 0.0;
                supGyroY = (data['gyro_y'] as double?) ?? 0.0;
                supGyroZ = (data['gyro_z'] as double?) ?? 0.0;
                supMagX = (data['mag_x'] as double?) ?? 0.0;
                supMagY = (data['mag_y'] as double?) ?? 0.0;
                supMagZ = (data['mag_z'] as double?) ?? 0.0;

                hasSupData = true;
                supName = sensorName;

                debugPrint(
                  '🔝 [$sensorName] AX=${supAccelX?.toStringAsFixed(4)}, '
                  'AY=${supAccelY?.toStringAsFixed(4)}, '
                  'AZ=${supAccelZ?.toStringAsFixed(4)}'
                );
                
              } else if (nameLower.contains('inf') ||
                  nameLower.contains('sotto') ||
                  nameLower.contains('lower') ||
                  nameLower.contains('bottom')) {
                
                // ⭐ I DATI SONO GIÀ FILTRATI (in g, °/s, µT)
                infAccelX = (data['accel_x'] as double?) ?? 0.0;
                infAccelY = (data['accel_y'] as double?) ?? 0.0;
                infAccelZ = (data['accel_z'] as double?) ?? 0.0;
                infGyroX = (data['gyro_x'] as double?) ?? 0.0;
                infGyroY = (data['gyro_y'] as double?) ?? 0.0;
                infGyroZ = (data['gyro_z'] as double?) ?? 0.0;
                infMagX = (data['mag_x'] as double?) ?? 0.0;
                infMagY = (data['mag_y'] as double?) ?? 0.0;
                infMagZ = (data['mag_z'] as double?) ?? 0.0;

                hasInfData = true;
                infName = sensorName;

                debugPrint(
                  '🔻 [$sensorName] AX=${infAccelX?.toStringAsFixed(4)}, '
                  'AY=${infAccelY?.toStringAsFixed(4)}, '
                  'AZ=${infAccelZ?.toStringAsFixed(4)}'
                );
              }
            }

            return Column(
              children: [
                // ⭐ DUE COLONNE
                Expanded(
                  child: Row(
                    children: [
                      // ⭐ COLONNA SINISTRA - SENSORE SUPERIORE
                      Expanded(
                        child: _buildSensorCard(
                          title: 'SENSORE SUPERIORE',
                          icon: '🔝',
                          name: supName,
                          hasData: hasSupData,
                          accelX: supAccelX,
                          accelY: supAccelY,
                          accelZ: supAccelZ,
                          gyroX: supGyroX,
                          gyroY: supGyroY,
                          gyroZ: supGyroZ,
                          magX: supMagX,
                          magY: supMagY,
                          magZ: supMagZ,
                          waitText: 'Attendi Sensore SUP',
                        ),
                      ),

                      // ⭐ COLONNA DESTRA - SENSORE INFERIORE
                      Expanded(
                        child: _buildSensorCard(
                          title: 'SENSORE INFERIORE',
                          icon: '🔻',
                          name: infName,
                          hasData: hasInfData,
                          accelX: infAccelX,
                          accelY: infAccelY,
                          accelZ: infAccelZ,
                          gyroX: infGyroX,
                          gyroY: infGyroY,
                          gyroZ: infGyroZ,
                          magX: infMagX,
                          magY: infMagY,
                          magZ: infMagZ,
                          waitText: 'Attendi Sensore INF',
                        ),
                      ),
                    ],
                  ),
                ),

                // ⭐ PULSANTE FERMA STREAM
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: SizedBox(
                    width: double.infinity,
                    height: 56,
                    child: OutlinedButton.icon(
                      onPressed: _stopStreamingAndExit,
                      icon: const Icon(Icons.stop_circle, size: 22),
                      label: const Text(
                        'FERMA STREAM',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                        ),
                      ),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xFFFF4444),
                        side: const BorderSide(
                          color: Color(0xFFFF4444),
                          width: 2,
                        ),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  // ================== WIDGETS DI SUPPORTO ==================

  Widget _buildSensorCard({
    required String title,
    required String icon,
    required String waitText,
    required String? name,
    required bool hasData,
    double? accelX,
    double? accelY,
    double? accelZ,
    double? gyroX,
    double? gyroY,
    double? gyroZ,
    double? magX,
    double? magY,
    double? magZ,
  }) {
    return Container(
      margin: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF1A1A1A),
        border: Border.all(
          color: hasData
              ? const Color.fromRGBO(151, 201, 62, 1)
              : const Color(0xFF333333),
          width: 2,
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: !hasData
          ? Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.schedule,
                    size: 48,
                    color: Color.fromRGBO(151, 201, 62, 0.5),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    waitText,
                    style: TextStyle(
                      color: const Color.fromRGBO(151, 201, 62, 1)
                          .withOpacity(0.7),
                      fontSize: 14,
                    ),
                  ),
                ],
              ),
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // ⭐ HEADER
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color.fromRGBO(151, 201, 62, 0.2),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      children: [
                        Text(icon, style: const TextStyle(fontSize: 20)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                title,
                                style: const TextStyle(
                                  color: Color.fromRGBO(151, 201, 62, 1),
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                  letterSpacing: 1,
                                ),
                              ),
                              Text(
                                name ?? 'Unknown',
                                style: const TextStyle(
                                  color: Colors.white70,
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),

                  // ⭐ ACCELEROMETRO (FILTRATO)
                  _buildSectionTitle('📊 Accelerometro (g)'),
                  _buildDataRow('AX', accelX ?? 0.0, 'g'),
                  _buildDataRow('AY', accelY ?? 0.0, 'g'),
                  _buildDataRow('AZ', accelZ ?? 0.0, 'g'),
                  const SizedBox(height: 16),

                  // ⭐ GIROSCOPIO (FILTRATO)
                  _buildSectionTitle('🌀 Giroscopio (°/s)'),
                  _buildDataRow('GX', gyroX ?? 0.0, '°/s'),
                  _buildDataRow('GY', gyroY ?? 0.0, '°/s'),
                  _buildDataRow('GZ', gyroZ ?? 0.0, '°/s'),
                  const SizedBox(height: 16),

                  // ⭐ MAGNETOMETRO (FILTRATO)
                  _buildSectionTitle('🧲 Magnetometro (µT)'),
                  _buildDataRow('MX', magX ?? 0.0, 'µT'),
                  _buildDataRow('MY', magY ?? 0.0, 'µT'),
                  _buildDataRow('MZ', magZ ?? 0.0, 'µT'),
                ],
              ),
            ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: const TextStyle(
          color: Color.fromRGBO(151, 201, 62, 1),
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _buildDataRow(String label, double value, String unit) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            label,
            style: const TextStyle(
              color: Colors.white70,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          Text(
            '${value.toStringAsFixed(4)} $unit',
            style: const TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 12,
              fontFamily: 'Courier New',
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
