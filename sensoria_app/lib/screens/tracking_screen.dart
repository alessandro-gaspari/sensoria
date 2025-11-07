import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'dart:math' as math;
import 'dart:collection';
import '../streaming_manager.dart';

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> {
  // ⭐ STATE VARIABILI
  double _kneeAngle = 0.0;
  bool _isCalibrated = false;
  double _calibrationOffset = 0.0;
  
  // ⭐ FILTERING BUFFERS (come Sensoria)
  final Queue<double> _pitchSupBuffer = Queue();
  final Queue<double> _pitchInfBuffer = Queue();
  static const int _bufferSize = 8;        // Sensoria usa 8
  static const double _filterAlpha = 0.12; // Sensoria usa 0.12
  static const double _outlierThreshold = 15.0; // Scarta outlier > 15°
  
  double _filteredPitchSup = 0.0;
  double _filteredPitchInf = 0.0;

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

  /// ⭐ Calcola il pitch di un singolo sensore: atan2(ax, az)
  double _calculatePitch(double ax, double az) {
    double pitchRad = math.atan2(ax, az);
    double pitchDeg = pitchRad * (180.0 / math.pi);
    return pitchDeg;
  }

  /// ⭐ Filtra un valore con exponential moving average + buffer + outlier removal
  double _applyFilterWithOutlierRemoval(
    double rawValue,
    Queue<double> buffer,
    double currentFiltered,
  ) {
    // Calcola la media attuale del buffer
    double bufferAverage = buffer.isEmpty 
        ? rawValue 
        : buffer.reduce((a, b) => a + b) / buffer.length;
    
    // Calcola la deviazione dal valore medio
    double deviation = (rawValue - bufferAverage).abs();
    
    // Se la deviazione è > threshold e il buffer ha abbastanza dati, scarta l'outlier
    if (buffer.length > 2 && deviation > _outlierThreshold) {
      debugPrint('   ⚠️ OUTLIER SCARTATO: ${rawValue.toStringAsFixed(1)}° (diff: ${deviation.toStringAsFixed(1)}°)');
      // Ritorna il valore filtrato precedente senza aggiungere l'outlier
      return currentFiltered;
    }
    
    // Aggiungi il nuovo valore al buffer
    buffer.add(rawValue);
    if (buffer.length > _bufferSize) {
      buffer.removeFirst();
    }
    
    // Calcola la media del buffer (con il nuovo valore)
    double avg = buffer.reduce((a, b) => a + b) / buffer.length;
    
    // Exponential moving average: α * avg + (1-α) * previous
    double filtered = _filterAlpha * avg + (1 - _filterAlpha) * currentFiltered;
    
    return filtered;
  }

  /// ⭐ Calibra il ginocchio
  void _calibrateKnee(double pitchSup, double pitchInf) {
    double offset = pitchSup - pitchInf;
    
    setState(() {
      _calibrationOffset = offset;
      _isCalibrated = true;
    });
    
    debugPrint('\n✅ CALIBRAZIONE COMPLETATA');
    debugPrint('   PitchSup: ${pitchSup.toStringAsFixed(2)}°');
    debugPrint('   PitchInf: ${pitchInf.toStringAsFixed(2)}°');
    debugPrint('   Offset: ${_calibrationOffset.toStringAsFixed(2)}°\n');
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          '✅ Calibrato! Offset: ${_calibrationOffset.toStringAsFixed(1)}°',
          style: const TextStyle(
            color: Color(0xFF000000),
            fontWeight: FontWeight.w600,
          ),
        ),
        backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 2),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
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
    final streamingManager = Provider.of<StreamingManager>(context);
    final allSensorData = streamingManager.allSensorData;
    
    // ⭐ VARIABILI TEMPORANEE PER QUESTO BUILD
    double? rawPitchSup;
    double? rawPitchInf;
    String? supName;
    String? infName;
    
    // ⭐ ESTRAI I DATI DAI SENSORI
    for (var entry in allSensorData.entries) {
      final sensorName = entry.key;
      final data = entry.value;
      
      // Salta se non ci sono dati
      if (data == null || data['ax'] == null || data['az'] == null) {
        continue;
      }
      
      // Converti a double
      final ax = (data['ax'] is int)
          ? (data['ax'] as int).toDouble()
          : (data['ax'] as double);
      final az = (data['az'] is int)
          ? (data['az'] as int).toDouble()
          : (data['az'] as double);
      
      // Calcola il pitch grezzo
      final pitch = _calculatePitch(ax, az);
      
      debugPrint('🔍 $sensorName: AX=${ax.toStringAsFixed(3)}g, AZ=${az.toStringAsFixed(3)}g → Pitch=${pitch.toStringAsFixed(2)}°');
      
      // Identifica il sensore (SUP o INF)
      final nameLower = sensorName.toLowerCase();
      
      if (nameLower.contains('sup') ||
          nameLower.contains('sopra') ||
          nameLower.contains('upper') ||
          nameLower.contains('top')) {
        rawPitchSup = pitch;
        supName = sensorName;
        debugPrint('   ✓ Identificato come SUPERIORE');
      } else if (nameLower.contains('inf') ||
                 nameLower.contains('sotto') ||
                 nameLower.contains('lower') ||
                 nameLower.contains('bottom')) {
        rawPitchInf = pitch;
        infName = sensorName;
        debugPrint('   ✓ Identificato come INFERIORE');
      }
    }
    
    // ⭐ APPLICA FILTERING CON OUTLIER REMOVAL
    if (rawPitchSup != null) {
      _filteredPitchSup = _applyFilterWithOutlierRemoval(
        rawPitchSup,
        _pitchSupBuffer,
        _filteredPitchSup,
      );
    }
    if (rawPitchInf != null) {
      _filteredPitchInf = _applyFilterWithOutlierRemoval(
        rawPitchInf,
        _pitchInfBuffer,
        _filteredPitchInf,
      );
    }
    
    // ⭐ CALCOLA ANGOLO GINOCCHIO
    if (rawPitchSup != null && rawPitchInf != null) {
      double relativeDifference = _filteredPitchSup - _filteredPitchInf;
      _kneeAngle = relativeDifference - _calibrationOffset;
      
      debugPrint('📐 RAW DIFF: ${(rawPitchSup - rawPitchInf).toStringAsFixed(2)}° → FILTERED DIFF: ${relativeDifference.toStringAsFixed(2)}°');
      debugPrint('🦵 KNEE ANGLE: ${_kneeAngle.toStringAsFixed(2)}° (offset: ${_calibrationOffset.toStringAsFixed(2)}°)\n');
    } else {
      debugPrint('⚠️ INCOMPLETO: SUP=$rawPitchSup, INF=$rawPitchInf\n');
    }
    
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: const Text('🦵 Tracking Ginocchio'),
        centerTitle: true,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.start,
            children: [
              const SizedBox(height: 20),
              
              // ⭐ DISPLAY PRINCIPALE - ANGOLO GINOCCHIO
              Container(
                width: double.infinity,
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
                      color: const Color.fromRGBO(151, 201, 62, 0.6),
                      blurRadius: 25,
                      spreadRadius: 8,
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    const Text(
                      'ANGOLO GINOCCHIO',
                      style: TextStyle(
                        color: Color(0xFF000000),
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.5,
                      ),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      '${_kneeAngle.toStringAsFixed(1)}°',
                      style: const TextStyle(
                        color: Color(0xFF000000),
                        fontSize: 96,
                        fontWeight: FontWeight.w900,
                        fontFamily: 'Courier New',
                        height: 1.0,
                      ),
                    ),
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      decoration: BoxDecoration(
                        color: Color(0xFF000000).withOpacity(0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        _isCalibrated ? '✓ Calibrato' : '✗ Non calibrato',
                        style: TextStyle(
                          color: Color(0xFF000000).withOpacity(0.9),
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              
              const SizedBox(height: 32),
              
              // ⭐ DEBUG INFO
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: const Color.fromRGBO(151, 201, 62, 0.4),
                    width: 1.5,
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '📊 DEBUG INFO',
                      style: TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                        letterSpacing: 0.5,
                      ),
                    ),
                    const SizedBox(height: 12),
                    if (allSensorData.isEmpty)
                      const Text(
                        '❌ Nessun dato disponibile',
                        style: TextStyle(
                          color: Color(0xFFFF4444),
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      )
                    else ...[
                      // SUP
                      if (rawPitchSup != null)
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '🔝 SUP ($supName)',
                              style: const TextStyle(
                                color: Color.fromRGBO(151, 201, 62, 0.8),
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.only(left: 8, top: 4, bottom: 8),
                              child: Row(
                                children: [
                                  Text(
                                    'RAW: ${rawPitchSup!.toStringAsFixed(1)}° | ',
                                    style: const TextStyle(
                                      color: Colors.white60,
                                      fontSize: 11,
                                      fontFamily: 'Courier New',
                                    ),
                                  ),
                                  Text(
                                    'FILT: ${_filteredPitchSup.toStringAsFixed(1)}°',
                                    style: const TextStyle(
                                      color: Color.fromRGBO(151, 201, 62, 1),
                                      fontSize: 11,
                                      fontFamily: 'Courier New',
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      
                      // INF
                      if (rawPitchInf != null)
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '🔻 INF ($infName)',
                              style: const TextStyle(
                                color: Color.fromRGBO(151, 201, 62, 0.8),
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.only(left: 8, top: 4, bottom: 8),
                              child: Row(
                                children: [
                                  Text(
                                    'RAW: ${rawPitchInf!.toStringAsFixed(1)}° | ',
                                    style: const TextStyle(
                                      color: Colors.white60,
                                      fontSize: 11,
                                      fontFamily: 'Courier New',
                                    ),
                                  ),
                                  Text(
                                    'FILT: ${_filteredPitchInf.toStringAsFixed(1)}°',
                                    style: const TextStyle(
                                      color: Color.fromRGBO(151, 201, 62, 1),
                                      fontSize: 11,
                                      fontFamily: 'Courier New',
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      
                      // DIFFERENZA
                      if (rawPitchSup != null && rawPitchInf != null)
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: const Color.fromRGBO(151, 201, 62, 0.1),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Text(
                                'Differenza:',
                                style: const TextStyle(
                                  color: Colors.white70,
                                  fontSize: 11,
                                ),
                              ),
                              Text(
                                '${(_filteredPitchSup - _filteredPitchInf).toStringAsFixed(1)}°',
                                style: const TextStyle(
                                  color: Color.fromRGBO(151, 201, 62, 1),
                                  fontSize: 12,
                                  fontFamily: 'Courier New',
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        ),
                      
                      // OFFSET CALIBRAZIONE
                      if (_isCalibrated)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            'Offset Calibr: ${_calibrationOffset.toStringAsFixed(2)}°',
                            style: const TextStyle(
                              color: Colors.white60,
                              fontSize: 10,
                              fontFamily: 'Courier New',
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
              
              const SizedBox(height: 32),
              
              // ⭐ PULSANTE CALIBRAZIONE
              if (rawPitchSup != null && rawPitchInf != null)
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton.icon(
                    onPressed: () => _calibrateKnee(_filteredPitchSup, _filteredPitchInf),
                    icon: const Icon(Icons.adjust, size: 22),
                    label: const Text(
                      'CALIBRA (gamba dritta)',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.5,
                      ),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
                      foregroundColor: const Color(0xFF000000),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                  ),
                )
              else
                Container(
                  padding: const EdgeInsets.symmetric(vertical: 20),
                  child: Column(
                    children: [
                      const Icon(
                        Icons.schedule,
                        color: Color.fromRGBO(151, 201, 62, 0.5),
                        size: 32,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Attendi i sensori...',
                        style: TextStyle(
                          color: const Color.fromRGBO(151, 201, 62, 1).withOpacity(0.7),
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
              
              const SizedBox(height: 16),
              
              // ⭐ PULSANTE FERMA STREAM
              SizedBox(
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
              
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }
}