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
    debugPrint('🎯 TrackingScreen INIT');
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
      Color.fromRGBO(76, 175, 80, 1),
      Color.fromRGBO(33, 150, 243, 1),
      Color.fromRGBO(255, 152, 0, 1),
      Color.fromRGBO(156, 39, 176, 1),
      Color.fromRGBO(244, 67, 54, 1),
      Color.fromRGBO(0, 188, 212, 1),
    ];
    return colors[index % colors.length];
  }

  String _getIconFromName(String name) {
    final lower = name.toLowerCase();
    if (lower.contains('ginocchio') && lower.contains('sup')) return '🔝';
    if (lower.contains('ginocchio') && lower.contains('inf')) return '🔻';
    if (lower.contains('calzin') || lower.contains('sock') || lower.contains('piede')) return '🧦';
    if (lower.contains('braccio') || lower.contains('arm')) return '🦾';
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
                Container(
                  padding: const EdgeInsets.all(12),
                  color: Colors.grey[900],
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        '📡 Sensori: ${allSensorData.length}',
                        style: const TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
                      ),
                      Text(
                        streamingManager.isStreaming ? '🟢 ATTIVO' : '🔴 FERMO',
                        style: TextStyle(
                          color: streamingManager.isStreaming ? Colors.green : Colors.red,
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView.builder(
                    itemCount: sensorEntries.length,
                    itemBuilder: (context, index) {
                      final entry = sensorEntries[index];
                      final data = entry.value;
                      if (data == null || data.isEmpty) return const SizedBox.shrink();
                      
                      final sensorName = (data['sensor_name'] as String?) ?? 'Unknown';
                      final color = _getColorByIndex(index);
                      final icon = _getIconFromName(sensorName);
                      final isSocks = _isSocksSensor(sensorName);

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

                      final extraFields = <String, double>{};
                      if (isSocks) {
                        data.forEach((k, v) {
                          if (!standardKeys.contains(k) && v is num) {
                            extraFields[k] = v.toDouble();
                          }
                        });
                      }

                      return Container(
                        margin: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFF1A1A1A),
                          border: Border.all(color: color, width: 2),
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
                                        Text('📊 Acc (g)', style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
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
                                        Text('🌀 Gyr (°/s)', style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
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
                                        Text('🧲 Mag (µT)', style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
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
                                Text('🦶 Pressioni RAW (S0-S7)', style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700)),
                                const SizedBox(height: 6),
                                Wrap(
                                  spacing: 8,
                                  runSpacing: 4,
                                  children: extraFields.entries.map((e) {
                                    final val = e.value.toInt();
                                    final absVal = val.abs();
                                    Color pressureColor = Colors.grey;
                                    if (absVal > 100) pressureColor = const Color(0xFF97c93e);
                                    if (absVal > 1000) pressureColor = Colors.orange;
                                    if (absVal > 5000) pressureColor = Colors.red;
                                    
                                    return Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                                      decoration: BoxDecoration(
                                        color: pressureColor.withOpacity(0.2),
                                        border: Border.all(color: pressureColor, width: 1),
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        '${e.key.toUpperCase()}: $val',
                                        style: TextStyle(
                                          color: pressureColor,
                                          fontSize: 9,
                                          fontWeight: FontWeight.w600,
                                          fontFamily: 'Courier New',
                                        ),
                                      ),
                                    );
                                  }).toList(),
                                ),
                              ],
                            ],
                          ),
                        ),
                      );
                    },
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

  Widget _buildValue(String label, dynamic value) {
    final val = (value as double?) ?? 0.0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70, fontSize: 9, fontWeight: FontWeight.w600)),
          Text(
            val.toInt().toString(),
            style: const TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 9,
              fontFamily: 'Courier New',
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
