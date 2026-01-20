import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:apple_maps_flutter/apple_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import '../streaming_manager.dart';
import '../providers/connected_devices_provider.dart';
import '../providers/profile_provider.dart';

// ✅ Widget separato per la durata - si aggiorna SOLO quando cambia _sessionDuration
class _DurationDisplay extends StatelessWidget {
  final Duration duration;
  
  const _DurationDisplay({required this.duration});
  
  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final hours = twoDigits(duration.inHours);
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    return "$hours:$minutes:$seconds";
  }
  
  @override
  Widget build(BuildContext context) {
    final formatted = _formatDuration(duration);
    debugPrint('🔄 _DurationDisplay.build() chiamato: ${duration.inSeconds}s → "$formatted"');  // ✅ AGGIUNGI QUESTO
    
    return Text(
      formatted, 
      style: GoogleFonts.barlowCondensed(
        color: Colors.white, 
        fontSize: 28, 
        fontWeight: FontWeight.w600
      )
    );
  }
}


class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> with SingleTickerProviderStateMixin {
  Timer? _durationTimer;
  Duration _sessionDuration = Duration.zero;
  Position? _lastKnownPosition;

  AppleMapController? _mapController;
  StreamSubscription<Position>? _localMapStream;
  
  CameraPosition _cameraPosition = const CameraPosition(
    target: LatLng(0, 0),
    zoom: 15.0, 
  );
  
  bool _hasRealPosition = false; 
  String _gpsStatus = "In attesa GPS...";
  
  late AnimationController _markerAnimController;
  late Animation<double> _markerAnimation;

  @override
  void initState() {
    super.initState();
    
    debugPrint('🚀 TrackingScreen initState');
    
    _startTimer();
    _initHighPrecisionMap();

    _markerAnimController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
    
    _markerAnimation = Tween<double>(begin: 0.5, end: 1.0).animate(
      CurvedAnimation(parent: _markerAnimController, curve: Curves.easeOut),
    );
  }

  Future<void> _initHighPrecisionMap() async {
    debugPrint("🗺️ [GPS] Inizio inizializzazione...");
    
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      debugPrint("❌ [GPS] Servizi GPS disabilitati");
      return;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        debugPrint("❌ [GPS] Permessi negati");
        return;
      }
    }

    debugPrint("✅ [GPS] Permessi OK: $permission");

    try {
      Position initialPos = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.best,
        timeLimit: const Duration(seconds: 5),
      );
      
      if (mounted) {
        setState(() {
          _cameraPosition = CameraPosition(
            target: LatLng(initialPos.latitude, initialPos.longitude),
            zoom: 18.0,
          );
          _hasRealPosition = true;
          _gpsStatus = "GPS Attivo";
          _lastKnownPosition = initialPos;
        });
        
        _mapController?.animateCamera(
          CameraUpdate.newLatLng(LatLng(initialPos.latitude, initialPos.longitude)),
        );
      }
      
      debugPrint("✅ [GPS] Posizione iniziale: ${initialPos.latitude}, ${initialPos.longitude}");
    } catch (e) {
      debugPrint("⚠️ [GPS] Errore posizione iniziale: $e");
    }

    debugPrint("🛰️ [GPS] Avvio polling (ogni 2s)...");
    
    Timer.periodic(const Duration(seconds: 1), (timer) async {
      if (!mounted) {
        timer.cancel();
        debugPrint("🛰️ [GPS] Timer fermato (unmounted)");
        return;
      }

      try {
        Position position = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.bestForNavigation,
        );
        
        debugPrint("📍 [GPS] Polling: ${position.latitude}, ${position.longitude} (acc: ${position.accuracy}m)");
        
        final streamingManager = Provider.of<StreamingManager>(context, listen: false);
        //if (streamingManager.isTrackingActive) {
        //  streamingManager.sendGpsData(position.latitude, position.longitude, position.accuracy);
        //}

        if (mounted) {
          _lastKnownPosition = position;
          
          if (!_hasRealPosition) {
            setState(() {
              _hasRealPosition = true;
              _gpsStatus = "GPS Agganciato";
            });
          }
          
          _mapController?.animateCamera(
            CameraUpdate.newLatLng(LatLng(position.latitude, position.longitude)),
          );
        }
        
      } catch (e) {
        debugPrint("⚠️ [GPS] Errore polling: $e");
      }
    });
  }

  void _startTimer() {
    debugPrint('🕐 Timer avviato');
    
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      
      setState(() {
        _sessionDuration += const Duration(seconds: 1);
      });
      
      debugPrint('⏱️ Timer tick: ${_sessionDuration.inSeconds}s');
    });
  }

  Future<void> _handleStopTracking() async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    streamingManager.stopTracking();
    await streamingManager.stopAll();
    if (mounted) Navigator.pop(context);
  }

  String _getDeviceEmoji(BluetoothDevice? device, ConnectedDevicesProvider provider, {bool isHrm = false}) {
    if (isHrm) return '❤️';
    if (device == null) return '⚡';
    final customIconType = provider.getDeviceIconType(device);
    if (customIconType != null) {
      switch (customIconType) {
        case 'leg': return '🦿';
        case 'foot': return '🧦';
        case 'arm': return '🦾';
      }
    }
    return '⚡';
  }

  @override
  void dispose() {
    debugPrint('💀 TrackingScreen dispose');
    _durationTimer?.cancel();
    _localMapStream?.cancel();
    _markerAnimController.dispose();
    super.dispose();
  }
  
  Color _getQualityColor(GpsSignalQuality q) {
    switch(q) {
      case GpsSignalQuality.excellent: return const Color(0xFF00C853); 
      case GpsSignalQuality.good: return Colors.green;
      case GpsSignalQuality.moderate: return Colors.yellow;
      case GpsSignalQuality.weak: return Colors.orange;
      default: return Colors.red;
    }
  }

  Widget _buildSignalBars(GpsSignalQuality quality) {
    int barsLit = 0;
    switch (quality) {
      case GpsSignalQuality.excellent: barsLit = 4; break;
      case GpsSignalQuality.good:      barsLit = 3; break;
      case GpsSignalQuality.moderate:  barsLit = 2; break;
      case GpsSignalQuality.weak:      barsLit = 1; break;
      default:                         barsLit = 0; break;
    }
    
    Color activeColor = _getQualityColor(quality);
    Color inactiveColor = Colors.white24; 

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: List.generate(4, (index) {
        double height = 6.0 + (index * 3.0);
        bool isLit = index < barsLit;
        
        return Container(
          margin: const EdgeInsets.only(left: 2), 
          width: 4,
          height: height,
          decoration: BoxDecoration(
            color: isLit ? activeColor : inactiveColor,
            borderRadius: BorderRadius.circular(1),
          ),
        );
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
    final activeProfile = Provider.of<ProfileProvider>(context, listen: false).activeProfile;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.white),
          onPressed: () => _handleStopTracking(),
        ),
        title: Column(
          children: [
            Image.asset('assets/logo_Clean.png', height: 24),
            if (activeProfile != null)
              Padding(
                padding: const EdgeInsets.only(top: 4.0),
                child: Text(
                  "UTENTE: ${activeProfile.name.toUpperCase()}",
                  style: GoogleFonts.barlowCondensed(
                    fontSize: 12,
                    color: const Color.fromRGBO(151, 201, 62, 1),
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1.0
                  ),
                ),
              )
          ],
        ),
        centerTitle: true,
        actions: [
          Builder(
            builder: (context) {
              final streamingManager = Provider.of<StreamingManager>(context);
              final isSaving = streamingManager.isTrackingActive;
              final isServerUp = streamingManager.isServerReachable;
              
              return Padding(
                padding: const EdgeInsets.only(right: 16.0),
                child: Row(
                  children: [
                    Icon(
                      isSaving && isServerUp ? Icons.cloud_done : Icons.cloud_off,
                      color: isSaving && isServerUp ? const Color.fromRGBO(151, 201, 62, 1) : Colors.red,
                      size: 20,
                    ),
                    const SizedBox(width: 6),
                    Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text("SALVATAGGIO", style: GoogleFonts.barlowCondensed(color: Colors.white54, fontSize: 10, fontWeight: FontWeight.w600)),
                        Text(isSaving && isServerUp ? "ON" : "OFF", style: GoogleFonts.barlowCondensed(color: isSaving && isServerUp ? const Color.fromRGBO(151, 201, 62, 1) : Colors.red, fontWeight: FontWeight.bold, fontSize: 14)),
                      ],
                    ),
                  ],
                ),
              );
            },
          )
        ],
      ),
      body: Column(
        children: [
          Container(
            height: 180, 
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Colors.white10, width: 1)),
            ),
            child: Row(
              children: [
                // 1. INFO
                Expanded(
                  flex: 3,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _buildLabel("DURATA"),
                      // ✅ USA il widget separato
                      _DurationDisplay(duration: _sessionDuration),
                      const SizedBox(height: 16),
                      _buildLabel("SENSORI ATTIVI"),
                      Builder(
                        builder: (context) {
                          final streamingManager = Provider.of<StreamingManager>(context);
                          final int sensoriaCount = devicesProvider.connectedDevices.length;
                          final int hrmCount = (streamingManager.hrmDeviceName != null) ? 1 : 0;
                          final int totalSensors = sensoriaCount + hrmCount;
                          
                          return Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text("$totalSensors", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 1), fontSize: 32, fontWeight: FontWeight.bold, height: 1.0)),
                              Padding(
                                padding: const EdgeInsets.only(bottom: 6, left: 4),
                                child: Text("DISPOSITIVI", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 0.7), fontSize: 14, fontWeight: FontWeight.w600)),
                              ),
                            ],
                          );
                        },
                      ),
                    ],
                  ),
                ),
                
                // 2. BPM
                Expanded(
                  flex: 3,
                  child: Builder(
                    builder: (context) {
                      final streamingManager = Provider.of<StreamingManager>(context);
                      final bpm = streamingManager.currentHeartRate;
                      
                      return Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text("HEART RATE", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 1), fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 2.0)),
                          Text(bpm != null ? "$bpm" : "--", style: GoogleFonts.barlowCondensed(color: bpm != null ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white12, fontSize: 80, fontWeight: FontWeight.bold, height: 1.0)),
                          Text("BPM", style: GoogleFonts.barlowCondensed(color: Colors.white38, fontSize: 14, fontWeight: FontWeight.bold)),
                        ],
                      );
                    },
                  ),
                ),
                
                // 3. MINIMAPPA
                Expanded(
                  flex: 3,
                  child: Container(
                    margin: const EdgeInsets.only(left: 8),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: Colors.white24, width: 1),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.5), blurRadius: 10, offset: const Offset(0, 4))],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(15),
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          AppleMap(
                            initialCameraPosition: _cameraPosition,
                            mapType: MapType.standard,
                            onMapCreated: (AppleMapController controller) {
                              _mapController = controller;
                            },
                            myLocationEnabled: false,
                            myLocationButtonEnabled: false,
                            compassEnabled: false,
                            pitchGesturesEnabled: false,
                            scrollGesturesEnabled: false,
                            zoomGesturesEnabled: false,
                          ),
                          
                          if (_hasRealPosition) _buildAnimatedMarker(),

                          if (_hasRealPosition)
                            Builder(
                              builder: (context) {
                                final gpsQuality = Provider.of<StreamingManager>(context).currentGpsQuality;
                                
                                return Positioned(
                                  top: 8, left: 8,
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                    decoration: BoxDecoration(
                                      color: Colors.black.withOpacity(0.7),
                                      borderRadius: BorderRadius.circular(8),
                                      border: Border.all(color: Colors.white12, width: 1)
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment: CrossAxisAlignment.end,
                                      children: [
                                        const Icon(Icons.gps_fixed, color: Colors.white70, size: 10),
                                        const SizedBox(width: 6),
                                        _buildSignalBars(gpsQuality),
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),

                          if (!_hasRealPosition)
                            Container(
                              color: const Color(0xFF1A1A1A),
                              child: Center(
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const CircularProgressIndicator(
                                      color: Color.fromRGBO(151, 201, 62, 1),
                                      strokeWidth: 2,
                                    ),
                                    const SizedBox(height: 8),
                                    Text(
                                      _gpsStatus,
                                      style: GoogleFonts.barlow(color: Colors.white70, fontSize: 10),
                                      textAlign: TextAlign.center,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),

          Expanded(
            child: Builder(
              builder: (context) {
                final streamingManager = Provider.of<StreamingManager>(context);
                final hrmName = streamingManager.hrmDeviceName ?? "Heart Rate Monitor";
                final int sensoriaCount = devicesProvider.connectedDevices.length;
                final int hrmCount = (streamingManager.hrmDeviceName != null) ? 1 : 0;
                final int totalSensors = sensoriaCount + hrmCount;
                
                return totalSensors == 0
                    ? Center(child: Text("Nessun dispositivo attivo", style: GoogleFonts.barlow(color: Colors.white24)))
                    : ListView(
                        padding: const EdgeInsets.all(16),
                        children: [
                          ...devicesProvider.connectedDevices.entries.map((entry) {
                            return _buildDeviceCard(
                              devicesProvider.deviceNames[entry.key] ?? "Sensoria Device", 
                              entry.key, 
                              streamingManager.allSensorData[entry.key] != null, 
                              _getDeviceEmoji(entry.value, devicesProvider)
                            );
                          }),
                          if (streamingManager.hrmDeviceName != null)
                            _buildDeviceCard(hrmName, "HRM-SENSOR", true, _getDeviceEmoji(null, devicesProvider, isHrm: true)),
                        ],
                      );
              },
            ),
          ),

          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(24),
            decoration: const BoxDecoration(color: Colors.black, border: Border(top: BorderSide(color: Colors.white10))),
            child: SizedBox(
              height: 56,
              child: ElevatedButton.icon(
                onPressed: _handleStopTracking,
                icon: const Icon(Icons.stop_circle_outlined, size: 28),
                label: Text('STOP TRACKING', style: GoogleFonts.barlowCondensed(fontSize: 20, fontWeight: FontWeight.bold, letterSpacing: 1.5)),
                style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade900, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)), elevation: 4),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLabel(String text) {
    return Text(text, style: GoogleFonts.barlowCondensed(color: Colors.white38, fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 1.0));
  }

  Widget _buildAnimatedMarker() {
    return AnimatedBuilder(
      animation: _markerAnimation,
      builder: (context, child) {
        return Stack(
          alignment: Alignment.center,
          children: [
            Container(
              width: 40 * _markerAnimation.value,
              height: 40 * _markerAnimation.value,
              decoration: BoxDecoration(shape: BoxShape.circle, color: const Color.fromRGBO(151, 201, 62, 1).withOpacity(1.0 - _markerAnimation.value)),
            ),
            Container(
              width: 12, height: 12,
              decoration: BoxDecoration(shape: BoxShape.circle, color: const Color.fromRGBO(151, 201, 62, 1), border: Border.all(color: Colors.white, width: 2), boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 4, offset: Offset(0, 2))]),
            ),
          ],
        );
      },
    );
  }

  Widget _buildDeviceCard(String name, String id, bool isActive, String emoji) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: const Color(0xFF1A1A1A), borderRadius: BorderRadius.circular(12), border: Border.all(color: isActive ? const Color.fromRGBO(151, 201, 62, 0.3) : Colors.white10, width: 1)),
      child: Row(
        children: [
          Container(width: 44, height: 44, decoration: BoxDecoration(color: isActive ? const Color.fromRGBO(151, 201, 62, 0.25) : Colors.white10, borderRadius: BorderRadius.circular(12)), child: Center(child: Text(emoji, style: const TextStyle(fontSize: 24)))),
          const SizedBox(width: 16),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(name, style: GoogleFonts.barlowCondensed(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)), Text(id, style: GoogleFonts.barlow(color: Colors.white38, fontSize: 12))])),
          if (isActive) Container(width: 8, height: 8, decoration: const BoxDecoration(shape: BoxShape.circle, color: Color.fromRGBO(151, 201, 62, 1), boxShadow: [BoxShadow(color: Color.fromRGBO(151, 201, 62, 0.5), blurRadius: 6, spreadRadius: 2)])),
        ],
      ),
    );
  }
}
