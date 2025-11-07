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
  double _kneeAngle = 0.0;
  bool _isCalibrated = false;
  double _calibrationOffset = 0.0;
  
  @override
  void initState() {
    super.initState();
  }

  // ⭐ FORMULA CORRETTA: Calcola pitch di un singolo sensore
  double _calculatePitch(double ax, double az) {
    double pitchRad = math.atan2(ax, az);
    double pitchDeg = pitchRad * (180.0 / math.pi);
    return pitchDeg;
  }

  // ⭐ NUOVO: Calcola angolo ginocchio dalla differenza tra i due sensori
  double _calculateKneeAngle(
    double pitchSup,
    double pitchInf,
  ) {
    double relativeDifference = pitchSup - pitchInf;
    return relativeDifference - _calibrationOffset;
  }

  void _calibrateKnee(double pitchSup, double pitchInf) {
    setState(() {
      _calibrationOffset = pitchSup - pitchInf;
      _isCalibrated = true;
    });
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '✅ Calibrato! Offset: ${_calibrationOffset.toStringAsFixed(1)}°',
          style: const TextStyle(color: Color(0xFF000000)),
        ),
        backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
      ),
    );
  }
@override
@override
Widget build(BuildContext context) {
  final streamingManager = Provider.of<StreamingManager>(context);
  
  // ⭐ Forza un rebuild ogni secondo per aggiornare
  Future.delayed(const Duration(milliseconds: 100), () {
    if (mounted) {
      setState(() {});
    }
  });
  
  final allSensorData = streamingManager.allSensorData;
  
  debugPrint('\n🎯 TrackingScreen BUILD');
  debugPrint('   Sensori: ${allSensorData.keys.toList()}');
  debugPrint('   Numero sensori: ${allSensorData.length}');
  
  double? pitchSup;
  double? pitchInf;
  String? supName;
  String? infName;
  
  for (var entry in allSensorData.entries) {
    final sensorName = entry.key;
    final data = entry.value;
    
    debugPrint('   📦 Checking: $sensorName = $data');
    
    if (data != null) {
      final ax = data['ax'];
      final az = data['az'];
      
      debugPrint('      AX=$ax, AZ=$az');
      
      if (ax != null && az != null) {
        final axDouble = (ax is int) ? ax.toDouble() : ax as double;
        final azDouble = (az is int) ? az.toDouble() : az as double;
        
        final pitch = _calculatePitch(axDouble, azDouble);
        debugPrint('      ✅ Pitch: $pitch°');
        
        final nameLower = sensorName.toLowerCase();
        
        if (nameLower.contains('sup') || nameLower.contains('sopra') || 
            nameLower.contains('upper') || nameLower.contains('top')) {
          pitchSup = pitch;
          supName = sensorName;
        } else if (nameLower.contains('inf') || nameLower.contains('sotto') || 
                   nameLower.contains('lower') || nameLower.contains('bottom')) {
          pitchInf = pitch;
          infName = sensorName;
        }
      }
    }
  }
  
  if (pitchSup != null && pitchInf != null) {
    _kneeAngle = _calculateKneeAngle(pitchSup, pitchInf);
    debugPrint('   ✅ KNEE ANGLE: $_kneeAngle°\n');
  } else {
    debugPrint('   ❌ INCOMPLETO: SUP=$pitchSup, INF=$pitchInf\n');
  }
  
  return Scaffold(
    backgroundColor: Colors.black,
    appBar: AppBar(
      title: const Text('Tracking Ginocchio'),
      centerTitle: true,
    ),
    body: SingleChildScrollView(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox(height: 40),
              
              // ⭐ DISPLAY PRINCIPALE
              Container(
                padding: const EdgeInsets.all(40),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [
                      Color.fromRGBO(151, 201, 62, 1),
                      Color.fromRGBO(111, 165, 45, 1),
                    ],
                  ),
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(
                      color: const Color.fromRGBO(151, 201, 62, 0.5),
                      blurRadius: 20,
                      spreadRadius: 5,
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    const Text(
                      'ANGOLO GINOCCHIO',
                      style: TextStyle(
                        color: Color(0xFF000000),
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 1,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      '${_kneeAngle.toStringAsFixed(1)}°',
                      style: const TextStyle(
                        color: Color(0xFF000000),
                        fontSize: 96,
                        fontWeight: FontWeight.w700,
                        fontFamily: 'Courier New',
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      _isCalibrated ? '✓ Calibrato' : '✗ Non calibrato',
                      style: TextStyle(
                        color: Color(0xFF000000).withOpacity(0.8),
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              
              const SizedBox(height: 40),
              
              // ⭐ DEBUG
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color.fromRGBO(151, 201, 62, 0.5)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('📊 DEBUG', style: TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    if (allSensorData.isEmpty)
                      const Text('❌ Nessun dato', style: TextStyle(color: Color(0xFFFF4444)))
                    else ...[
                      Text('Sensori: ${allSensorData.keys.join(", ")}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      if (pitchSup != null) Text('SUP: $pitchSup°', style: const TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 12)),
                      if (pitchInf != null) Text('INF: $pitchInf°', style: const TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 12)),
                    ],
                  ],
                ),
              ),
              
              const SizedBox(height: 40),
              
              if (pitchSup != null && pitchInf != null)
                ElevatedButton.icon(
                  onPressed: () => _calibrateKnee(pitchSup!, pitchInf!),
                  icon: const Icon(Icons.adjust),
                  label: const Text('📍 CALIBRA'),
                )
              else
                const Text('⏳ Attendi i sensori...', style: TextStyle(color: Color.fromRGBO(151, 201, 62, 1))),
            ],
          ),
        ),
      ),
    ),
  );
}


}
