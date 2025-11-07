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
    debugPrint('\n🎯 TrackingScreen INIT - Sensori Reali');
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
    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  Color _getColorByIndex(int index) {
    const colors = [
      Color.fromRGBO(76, 175, 80, 1),      // Verde
      Color.fromRGBO(33, 150, 243, 1),     // Blu
      Color.fromRGBO(255, 152, 0, 1),      // Arancione
      Color.fromRGBO(156, 39, 176, 1),     // Viola
    ];
    return colors[index % colors.length];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('DATI REAL TIME'),
        centerTitle: true,
        elevation: 0,
      ),
      body: SafeArea(
        child: Consumer<StreamingManager>(
          builder: (context, streamingManager, _) {
            final allSensorData = streamingManager.allSensorData;

            // ⭐ CONVERTI IN LISTA PER AVERE INDICE
            final sensorsEntries = allSensorData.entries.toList();

            return Column(
              children: [
                Expanded(
                  child: SingleChildScrollView(
                    child: Column(
                      children: List.generate(
                        sensorsEntries.length,
                        (index) {
                          final entry = sensorsEntries[index];
                          final data = entry.value;
                          if (data == null) return SizedBox.shrink();

                          // ⭐ ESTRAI NOME E ICONA DAL SENSORE
                          final sensorName = (data['sensor_name'] as String?) ?? 'Unknown';
                          final color = _getColorByIndex(index);

                          return _buildRow(
                            sensorName: sensorName,
                            data: data,
                            color: color,
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

  Widget _buildRow({
    required String sensorName,
    required Map<String, dynamic> data,
    required Color color,
  }) {
    String icon = _getIconFromName(sensorName);

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
          ],
        ),
      ),
    );
  }

  String _getIconFromName(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('ginoc') && lower.contains('sup')) return '🦿';
    if (lower.contains('ginoc') && lower.contains('inf')) return '🦿';
    if (lower.contains('calzin') || lower.contains('sock') || lower.contains('piede')) return '🧦';
    if (lower.contains('bracc') || lower.contains('arm')) return '🦾';
    if (lower.contains('destr') || lower.contains('right') || lower.contains('dx')) return '➡️';
    if (lower.contains('sinis') || lower.contains('left') || lower.contains('sx')) return '⬅️';
    return '📍';
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
          Text(val.toStringAsFixed(3), style: const TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 9, fontFamily: 'Courier New', fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}
