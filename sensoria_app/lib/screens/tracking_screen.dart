import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../streaming_manager.dart';

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  @override
  void initState() {
    super.initState();
    debugPrint('\n🎯 TrackingScreen INIT');
  }

  @override
  void dispose() {
    debugPrint('🛑 TrackingScreen DISPOSE');
    super.dispose();
  }

  void _stopStreamingAndExit() async {
    debugPrint('🛑 STOP STREAMING');
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    await streamingManager.stopAll();
    if (mounted) Navigator.of(context).pop();
  }

  Color _getColorByIndex(int index) {
    const colors = [
      Color.fromRGBO(76, 175, 80, 1),    // Verde
      Color.fromRGBO(33, 150, 243, 1),   // Blu
      Color.fromRGBO(255, 152, 0, 1),    // Arancione
      Color.fromRGBO(156, 39, 176, 1),   // Viola
      Color.fromRGBO(244, 67, 54, 1),    // Rosso
      Color.fromRGBO(0, 188, 212, 1),    // Ciano
    ];
    return colors[index % colors.length];
  }

  String _getIconFromName(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('ginocchio') && lower.contains('sup')) return '🔝';
    if (lower.contains('ginocchio') && lower.contains('inf')) return '🔻';
    if (lower.contains('calzin') || lower.contains('sock') || lower.contains('piede')) return '🧦';
    if (lower.contains('braccio') || lower.contains('arm')) return '🦾';
    if (lower.contains('destro') || lower.contains('right') || lower.contains('dx')) return '➡️';
    if (lower.contains('sinistro') || lower.contains('left') || lower.contains('sx')) return '⬅️';
    return '📍';
  }

  bool _isSocksSensor(String name) {
    final lower = name.toLowerCase();
    return lower.contains('calzin') || lower.contains('sock') || lower.contains('piede') || lower.contains('foot');
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
          final sensorEntries = allSensorData.entries.toList();

          return Column(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    children: List.generate(
                      sensorEntries.length,
                      (index) {
                        final entry = sensorEntries[index];
                        final data = entry.value;
                        if (data == null) return const SizedBox.shrink();
                        
                        final sensorName = (data['sensor_name'] as String?) ?? 'Unknown';
                        final color = _getColorByIndex(index);
                        final icon = _getIconFromName(sensorName);
                        final isSocks = _isSocksSensor(sensorName);

                        // ⭐ Campi standard IMU
                        const standardKeys = {
                          'sensor_name',
                          'timestamp',
                          'accel_x',
                          'accel_y',
                          'accel_z',
                          'gyro_x',
                          'gyro_y',
                          'gyro_z',
                          'mag_x',
                          'mag_y',
                          'mag_z',
                        };

                        // ⭐ Estrai campi extra (pressioni)
                        final extraFields = <String, double>{};
                        if (isSocks) {
                          data.forEach((k, v) {
                            if (!standardKeys.contains(k)) {
                              if (v is num) {
                                extraFields[k] = v.toDouble();
                              }
                            }
                          });
                          
                          // ⭐ DEBUG PRINT
                          debugPrint('🧦 [$sensorName] È un calzino!');
                          debugPrint('🧦 [$sensorName] Tutte le chiavi: ${data.keys.toList()}');
                          debugPrint('🧦 [$sensorName] Campi extra trovati: ${extraFields.keys.toList()}');
                          debugPrint('🧦 [$sensorName] Valori extra: $extraFields');
                        }

                        return _buildSensorCard(
                          sensorName: sensorName,
                          icon: icon,
                          color: color,
                          data: data,
                          extraFields: extraFields,
                        );
                      },
                    ),
                  ),
                ),
              ),
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
                      side: const BorderSide(color: Color(0xFFFF4444), width: 2),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
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



  Widget _buildSensorCard({
    required String sensorName,
    required String icon,
    required Color color,
    required Map<String, dynamic> data,
    required Map<String, double> extraFields,
  }) {
    return Container(
      margin: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF1A1A1A),
        border: Border.all(
          color: color,
          width: 2,
        ),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: color.withOpacity(0.15),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Text(icon, style: const TextStyle(fontSize: 18)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      sensorName,
                      style: TextStyle(
                        color: color,
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                // Acc
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildHeader('📊 Acc (g)', color),
                      _buildValue('X', data['accel_x']),
                      _buildValue('Y', data['accel_y']),
                      _buildValue('Z', data['accel_z']),
                    ],
                  ),
                ),
                const SizedBox(width: 16),
                // Gyro
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildHeader('🌀 Gyr (°/s)', color),
                      _buildValue('X', data['gyro_x']),
                      _buildValue('Y', data['gyro_y']),
                      _buildValue('Z', data['gyro_z']),
                    ],
                  ),
                ),
                const SizedBox(width: 16),
                // Mag
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildHeader('🧲 Mag (µT)', color),
                      _buildValue('X', data['mag_x']),
                      _buildValue('Y', data['mag_y']),
                      _buildValue('Z', data['mag_z']),
                    ],
                  ),
                ),
              ],
            ),
            if (extraFields.isNotEmpty) ...[
              const SizedBox(height: 16),
              _buildHeader('🦶 Pressione', color),
              ...extraFields.entries.map((e) => _buildValue(e.key, e.value)),
            ],
          ],
        ), 
      ),     
    );   
  }

  Widget _buildHeader(String text, Color color) {
    return Text(
      text,
      style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700),
    );
  }

  Widget _buildValue(String label, dynamic value) {
    final val = (value as double?) ?? 0.0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 9, fontWeight: FontWeight.w600)),
          Text(val.toStringAsFixed(3),
            style: const TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 9,
              fontFamily: 'Courier New',
              fontWeight: FontWeight.w600,
            )
          ),
        ],
      ),
    );
  }
}
