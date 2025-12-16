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

class TrackingScreen extends StatefulWidget {
  const TrackingScreen({Key? key}) : super(key: key);

  @override
  State<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends State<TrackingScreen> with TickerProviderStateMixin {
  Timer? _durationTimer;
  Duration _sessionDuration = Duration.zero;
  Position? _lastKnownPosition;

  AppleMapController? _mapController;
  StreamSubscription<Position>? _positionStream;
  
  // === VARIABILI PER L'INTERPOLAZIONE ===
  LatLng? _currentAnimatedPosition; // La posizione fluida che vediamo
  LatLng? _targetPosition;          // L'ultima posizione GPS reale ricevuta
  late AnimationController _cameraMoveController;
  late Animation<double> _latAnimation;
  late Animation<double> _lngAnimation;
  // ======================================
  
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
    _startTimer();
    
    // Inizializza controller per l'interpolazione (durata 1s per matchare l'update GPS)
    _cameraMoveController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000), // Fluidità tra un punto e l'altro
    );
    
    // Listener per aggiornare la mappa ad ogni frame dell'animazione
    _cameraMoveController.addListener(() {
      if (_mapController != null && _latAnimation.value != 0 && _lngAnimation.value != 0) {
        // Aggiorna la variabile che renderizza il marker fluido
        setState(() {
          _currentAnimatedPosition = LatLng(_latAnimation.value, _lngAnimation.value);
        });
        
        // Sposta la camera in modo fluido
        _mapController!.moveCamera(
          CameraUpdate.newLatLng(_currentAnimatedPosition!),
        );
      }
    });

    _initLocationTracking();

    _markerAnimController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat();
    
    _markerAnimation = Tween<double>(begin: 0.5, end: 1.0).animate(
      CurvedAnimation(parent: _markerAnimController, curve: Curves.easeOut),
    );
  }

  // Funzione per avviare l'animazione verso la nuova coordinata
  void _animateToPosition(LatLng newPos) {
    if (_currentAnimatedPosition == null) {
      // Primo punto: nessun movimento, set diretto
      _currentAnimatedPosition = newPos;
      return;
    }

    // Configura i Tween dalla posizione attuale (animata) a quella nuova (target)
    _latAnimation = Tween<double>(
      begin: _currentAnimatedPosition!.latitude,
      end: newPos.latitude,
    ).animate(CurvedAnimation(parent: _cameraMoveController, curve: Curves.linear));

    _lngAnimation = Tween<double>(
      begin: _currentAnimatedPosition!.longitude,
      end: newPos.longitude,
    ).animate(CurvedAnimation(parent: _cameraMoveController, curve: Curves.linear));

    // Resetta e avvia l'animazione verso il nuovo punto
    _cameraMoveController.reset();
    _cameraMoveController.forward();
  }

  void _startTimer() {
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      setState(() {
        _sessionDuration += const Duration(seconds: 1);
      });

      if (_lastKnownPosition != null) {
        Provider.of<StreamingManager>(context, listen: false).sendGpsData(
          _lastKnownPosition!.latitude, 
          _lastKnownPosition!.longitude, 
          _lastKnownPosition!.accuracy
        );
      }
    });
  }

  Future<void> _initLocationTracking() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) return;

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) return;
    }

    try {
      Position position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high, 
        timeLimit: const Duration(seconds: 10)
      );

      if (mounted) {
        setState(() {
          _cameraPosition = CameraPosition(
            target: LatLng(position.latitude, position.longitude),
            zoom: 19.0,
          );
          _hasRealPosition = true;
          _gpsStatus = "GPS Attivo";
          _lastKnownPosition = position; 
          
          // Setta il punto iniziale per l'interpolazione
          _currentAnimatedPosition = LatLng(position.latitude, position.longitude);
        });
        
        if (_mapController != null) {
          _mapController!.moveCamera( // Usa moveCamera invece di animateCamera per scatto istantaneo iniziale
            CameraUpdate.newLatLng(LatLng(position.latitude, position.longitude)),
          );
        }
      }
    } catch (e) {
      debugPrint("⚠️ Errore GPS iniziale: $e");
    }

    const locationSettings = LocationSettings(
      accuracy: LocationAccuracy.bestForNavigation, // Aumentata precisione per interpolazione migliore
      distanceFilter: 0, // Filtro 0 per catturare ogni micro-movimento
    );
    
    _positionStream = Geolocator.getPositionStream(locationSettings: locationSettings).listen(
      (Position position) {
        if (position.latitude == 0 && position.longitude == 0) return;

        if (mounted) {
          _lastKnownPosition = position; 
          
          // Nuova posizione target reale
          LatLng newTarget = LatLng(position.latitude, position.longitude);

          if (!_hasRealPosition) {
             setState(() {
               _hasRealPosition = true;
               _gpsStatus = "GPS Agganciato";
               _currentAnimatedPosition = newTarget; // Primo fix, niente animazione
             });
          } else {
             // AVVIA INTERPOLAZIONE VERSO IL NUOVO PUNTO
             _animateToPosition(newTarget);
          }
        }
      },
      onError: (error) => debugPrint("❌ Errore stream: $error"),
    );
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
    _durationTimer?.cancel();
    _positionStream?.cancel();
    _markerAnimController.dispose();
    _cameraMoveController.dispose(); // Importante disporre il controller interpolazione
    super.dispose();
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final hours = twoDigits(duration.inHours);
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    return "$hours:$minutes:$seconds";
  }

  @override
  Widget build(BuildContext context) {
    final streamingManager = Provider.of<StreamingManager>(context);
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context);
    final activeProfile = Provider.of<ProfileProvider>(context).activeProfile;

    final bpm = streamingManager.currentHeartRate;
    final hrmName = streamingManager.hrmDeviceName ?? "Heart Rate Monitor";
    
    final int sensoriaCount = devicesProvider.connectedDevices.length;
    final int hrmCount = (streamingManager.hrmDeviceName != null) ? 1 : 0; 
    final int totalSensors = sensoriaCount + hrmCount;
    
    final isSaving = streamingManager.isTrackingActive; 
    final isServerUp = streamingManager.isServerReachable;

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
          Padding(
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
                      Text(_formatDuration(_sessionDuration), style: GoogleFonts.barlowCondensed(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 16),
                      _buildLabel("SENSORI ATTIVI"),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text("$totalSensors", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 1), fontSize: 32, fontWeight: FontWeight.bold, height: 1.0)),
                          Padding(
                            padding: const EdgeInsets.only(bottom: 6, left: 4),
                            child: Text("DISPOSITIVI", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 0.7), fontSize: 14, fontWeight: FontWeight.w600)),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),

                // 2. BPM
                Expanded(
                  flex: 3,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text("HEART RATE", style: GoogleFonts.barlowCondensed(color: const Color.fromRGBO(151, 201, 62, 1), fontSize: 12, fontWeight: FontWeight.bold, letterSpacing: 2.0)),
                      Text(bpm != null ? "$bpm" : "--", style: GoogleFonts.barlowCondensed(color: bpm != null ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white12, fontSize: 80, fontWeight: FontWeight.bold, height: 1.0)),
                      Text("BPM", style: GoogleFonts.barlowCondensed(color: Colors.white38, fontSize: 14, fontWeight: FontWeight.bold)),
                    ],
                  ),
                ),

                // 3. MINIMAPPA (MODIFICATA PER INTERPOLAZIONE)
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
            child: totalSensors == 0
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
