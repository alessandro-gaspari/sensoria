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
  Widget build(BuildContext context) {
    final manager = context.watch<StreamingManager>();

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: const Color(0xFF97C93E),
        title: const Text('Tracking', style: TextStyle(color: Color(0xFF97C93E))),
      ),
      body: Center(
        child: StreamBuilder<int>(
          stream: manager.kneeAngleStream,
          initialData: 0,
          builder: (context, snapshot) {
            final angle = snapshot.data ?? 0;
            return Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text('ANGOLO GINOCCHIO',
                    style: TextStyle(color: Color(0xFF97C93E), fontSize: 14, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                Text('$angle°',
                    style: const TextStyle(
                      color: Color(0xFF97C93E),
                      fontSize: 72,
                      fontWeight: FontWeight.bold,
                      fontFamily: 'monospace',
                    )),
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    ElevatedButton.icon(
                      onPressed: manager.calibrateZero,
                      icon: const Text('📍'),
                      label: const Text('Calibra (dritto)'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF97C93E),
                        foregroundColor: Colors.black,
                      ),
                    ),
                    const SizedBox(width: 12),
                    ElevatedButton.icon(
                      onPressed: () async {
                        await manager.stopAll();
                        if (mounted) Navigator.of(context).pop();
                      },
                      icon: const Text('⏹️'),
                      label: const Text('Stop stream'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.redAccent,
                        foregroundColor: Colors.white,
                      ),
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
